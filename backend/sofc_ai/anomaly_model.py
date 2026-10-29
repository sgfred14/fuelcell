"""
Anomaly detection on 1-minute telemetry.

  1. LSTM autoencoder trained on NORMAL operation only. Optional physics penalty: the reconstruction itself must
     obey Faraday current, the power balance, the fuel-utilisation band, the 100 K rise limit and the dP warning band.
  2. Physics residuals computed directly on the measured signals (physics.py).
  3. Alarm = AE score over threshold OR any residual over threshold, persisted for 3 consecutive 5-minute steps.
Thresholds come from a held-out normal validation run.
"""
import json
import os
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import keras
import numpy as np
import pandas as pd
import tensorflow as tf
from keras import layers

from . import config as C
from . import physics

CH = C.TELEMETRY_CHANNELS
IDX = {c: i for i, c in enumerate(CH)}
L_WIN = 12          # 12 steps of 5 minutes = 1 hour
STRIDE = 1          # scoring stride in 5-minute steps
STEP_MIN = 5


# ------------------------------------------------------------------ windows
def downsample(df, minutes=STEP_MIN):
    """Average 1-minute telemetry into `minutes`-minute steps per run. Keeps `row` = index of the last 1-minute row
    in each block (used to look up the physics residuals computed at 1-minute resolution)."""
    parts = []
    for run_id, g in df.groupby("run_id", sort=False):
        n = (len(g) // minutes) * minutes
        g = g.iloc[:n]
        blk = np.arange(n) // minutes
        m = g[CH].groupby(blk).mean()
        m["ts"] = g["ts"].to_numpy()[::minutes]
        m["fault_code"] = g["fault_code"].groupby(blk).max().to_numpy()
        m["run_id"] = run_id
        m["row"] = g.index.to_numpy()[minutes - 1::minutes]
        if "split" in g:
            m["split"] = g["split"].iloc[0]
        parts.append(m.reset_index(drop=True))
    return pd.concat(parts, ignore_index=True)


def make_windows(df, stride=STRIDE, L=L_WIN):
    """df: 5-minute frame from downsample(). Returns X (N,L,C) raw, plus metadata
    (run_id, ts, fault code at window end, `row` = 1-minute row index of the window end)."""
    Xs, meta = [], []
    for run_id, g in df.groupby("run_id", sort=False):
        v = g[CH].to_numpy(dtype=np.float32)
        ends = np.arange(L - 1, len(v), stride)
        idx = ends[:, None] + np.arange(-L + 1, 1)[None, :]
        Xs.append(v[idx])
        m = pd.DataFrame({"run_id": run_id, "pos": ends, "ts": g["ts"].to_numpy()[ends],
                          "fault_code": g["fault_code"].to_numpy()[ends], "row": g["row"].to_numpy()[ends]})
        meta.append(m)
    return np.concatenate(Xs), pd.concat(meta, ignore_index=True)


# ------------------------------------------------------------------ model
@keras.saving.register_keras_serializable(package="sofc")
class PhysicsPenalty(layers.Layer):
    """Adds a loss that penalises reconstructions which break the Phase 1 constraints (weight 0 = plain autoencoder)."""

    def __init__(self, mean, std, weight=0.02, **kw):
        super().__init__(**kw)
        self.mean_ = [float(x) for x in mean]
        self.std_ = [float(x) for x in std]
        self.weight = float(weight)
        self._m = tf.constant(self.mean_, tf.float32)
        self._s = tf.constant(self.std_, tf.float32)

    def call(self, x):
        if self.weight > 0:
            raw = x * self._s + self._m
            g = lambda n: raw[..., IDX[n]]
            n_cons = g("i_stack_A") * C.N_SERIES * 3600.0 / (2 * C.FARADAY)
            F = g("h2_flow_kg_h") / C.MW_H2
            uf = n_cons / tf.maximum(F, 1e-3)
            p_rec = C.RES["P_recycle_kW"] * g("recycle_flow_kmol_h") / 4.093
            r_far = (g("p_dc_kW") - g("i_stack_A") * g("v_cell_V") * C.N_SERIES / 1000.0) / physics.SCALES["r_far"]
            r_net = (g("p_net_kW") - (g("p_dc_kW") * C.ETA_INV - g("p_blower_kW") - p_rec - C.P_AUX_KW)) / physics.SCALES["r_net"]
            r_uf = (tf.nn.relu(uf - C.UF_BOUNDS[1]) + tf.nn.relu(C.UF_BOUNDS[0] - uf)) / physics.SCALES["r_uf"]
            r_dT = tf.nn.relu(g("dT_cath_K") - C.DT_LIMIT) / physics.SCALES["r_dT"]
            r_dp = tf.nn.relu(g("dp_an_ca_mbar") - C.DP_WARN_MBAR) / physics.SCALES["r_dp"]
            pen = tf.reduce_mean(tf.math.log1p(r_far ** 2 + r_net ** 2 + r_uf ** 2 + r_dT ** 2 + r_dp ** 2))
            self.add_loss(self.weight * pen)
        return x

    def get_config(self):
        return {**super().get_config(), "mean": self.mean_, "std": self.std_, "weight": self.weight}


def build_ae(mean, std, physics_weight=0.0, L=L_WIN, n_ch=len(CH), units=64, latent=16):
    inp = keras.Input((L, n_ch))
    h = layers.LSTM(units)(inp)
    z = layers.Dense(latent, activation="tanh")(h)
    d = layers.RepeatVector(L)(z)
    d = layers.LSTM(units, return_sequences=True)(d)
    out = layers.TimeDistributed(layers.Dense(n_ch))(d)
    out = PhysicsPenalty(mean, std, physics_weight)(out)
    m = keras.Model(inp, out)
    m.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mse")
    return m


def train_ae(Xtr, Xva, mean, std, physics_weight, epochs=25, seed=0, verbose=0):
    keras.utils.set_random_seed(seed)
    m = build_ae(mean, std, physics_weight)
    ntr, nva = (Xtr - mean) / std, (Xva - mean) / std
    es = keras.callbacks.EarlyStopping(monitor="val_loss", patience=4, restore_best_weights=True)
    hist = m.fit(ntr, ntr, validation_data=(nva, nva), epochs=epochs, batch_size=128, callbacks=[es], verbose=verbose)
    return m, hist.history


def ae_scores(model, X, mean, std, batch=1024):
    out = []
    for i in range(0, len(X), batch):
        xb = (X[i:i + batch] - mean) / std
        rec = model.predict(xb, verbose=0)
        out.append(np.mean((rec - xb) ** 2, axis=(1, 2)))
    return np.concatenate(out)


# ------------------------------------------------------------------ scoring and evaluation
def persist(flags, k=3):
    """True where the flag has been on for k consecutive steps (per run)."""
    s = pd.Series(flags.astype(int))
    return (s.rolling(k, min_periods=k).sum() >= k).fillna(False).to_numpy()


def evaluate(meta, flag_matrix, step_min=STEP_MIN * STRIDE):
    """flag_matrix: dict name -> boolean array over windows. Returns per-config results."""
    rows = []
    for name, flags in flag_matrix.items():
        for run_id, g in meta.groupby("run_id", sort=False):
            fl = persist(flags[g.index.to_numpy()])
            fc = g["fault_code"].to_numpy()
            fault_type = run_id.replace("test-", "")
            days = len(g) * step_min / 1440.0
            if "normal" in fault_type or run_id.startswith("val"):
                rows.append(dict(config=name, run=run_id, kind="normal", detected=np.nan, delay_min=np.nan,
                                 alarms_per_day=float(((np.diff(fl.astype(int), prepend=0)) == 1).sum() / days),
                                 recall=np.nan))
            else:
                act = fc > 0
                on = np.where(act)[0][0]
                hit = np.where(fl & (np.arange(len(fl)) >= on))[0]
                before = ((np.diff(fl[:on].astype(int), prepend=0)) == 1).sum() if on > 0 else 0
                rows.append(dict(config=name, run=run_id, kind=fault_type, detected=bool(len(hit) and act[hit[0]]),
                                 delay_min=float((hit[0] - on) * step_min) if len(hit) and act[hit[0]] else np.nan,
                                 alarms_per_day=float(before / (on * step_min / 1440.0)),
                                 recall=float(fl[act].mean())))
    return pd.DataFrame(rows)


def fit_thresholds(ae_val, res_val):
    th_ae = float(np.quantile(ae_val, 0.999) * 1.1)
    th_res = {c: float(max(1.0, np.quantile(np.abs(res_val[c]), 0.999) * 1.2)) for c in physics.RESIDUALS}
    return th_ae, th_res


def save_bundle(path, ae_plain, ae_pinn, mean, std, th, history):
    p = Path(path); p.mkdir(parents=True, exist_ok=True)
    ae_plain.save_weights(p / "ae_plain.weights.h5")
    ae_pinn.save_weights(p / "ae_pinn.weights.h5")
    (p / "meta.json").write_text(json.dumps(dict(mean=[float(x) for x in mean], std=[float(x) for x in std],
                                                 thresholds=th, channels=CH, window=L_WIN, stride=STRIDE,
                                                 physics_weight=0.02, history=history), indent=2))


def load_bundle(path):
    p = Path(path)
    meta = json.loads((p / "meta.json").read_text())
    mean, std = np.array(meta["mean"], np.float32), np.array(meta["std"], np.float32)
    plain = build_ae(mean, std, 0.0); plain.load_weights(p / "ae_plain.weights.h5")
    pinn = build_ae(mean, std, meta["physics_weight"]); pinn.load_weights(p / "ae_pinn.weights.h5")
    return plain, pinn, mean, std, meta
