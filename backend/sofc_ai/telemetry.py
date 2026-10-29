"""
1-minute telemetry simulator built on the quasi-steady plant model, with controller/thermal lags,
sensor noise and six injectable faults.

Faults (ground truth is labelled in `fault_code`):
  blower_fade        blower capacity and efficiency fall -> air flow cannot follow demand at high load
  h2_restriction     part of the demanded H2 is not delivered -> fuel utilisation rises, voltage falls
  recycle_loss       anode recycle ratio falls -> less steam at the anode inlet
  dp_excursion       repeated anode-cathode differential pressure spikes
  thermal_gradient   air maldistribution: the real cathode temperature rise exceeds what the measured air flow explains
  sensor_drift       cathode-outlet thermocouple drifts upward (measurement only, the process is healthy)
"""
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from scipy.signal import lfilter, lfilter_zi

from . import config as C
from . import plant

N_AIR_DESIGN = C.RES["n_air_kmol_s"] * 3600.0


def _lag(x, tau_min):
    """First-order lag started at steady state."""
    a = np.exp(-1.0 / tau_min)
    b, den = [1 - a], [1, -a]
    return lfilter(b, den, x, zi=lfilter_zi(b, den) * x[0])[0]


def _ar1(rng, n, rho, sigma):
    e = rng.normal(0, sigma * np.sqrt(1 - rho ** 2), n)
    return lfilter([1], [1, -rho], e)


def _window(t, start, dur, ramp_up, ramp_down=60.0):
    up = np.clip((t - start) / max(ramp_up, 1.0), 0, 1)
    down = np.clip(1 - (t - (start + dur)) / ramp_down, 0, 1)
    return up * down


def simulate_run(run_id, days=10, seed=0, asr_mult=1.0, d_act=0.0, fault=None, start="2026-01-01"):
    """fault: dict(type=..., start_min=..., duration_min=..., severity=optional)"""
    rng = np.random.default_rng(seed)
    n = int(days * 1440)
    t = np.arange(n, dtype=float)
    t0 = datetime.fromisoformat(start)
    hour = ((t + t0.hour * 60 + t0.minute) / 60.0) % 24.0          # time of day follows the start timestamp
    doy0 = t0.timetuple().tm_yday

    # --- demand and weather
    steps = np.cumsum(rng.choice([0, 0, 0, 1], size=n // 60 + 1, p=None) * rng.normal(0, 0.02, n // 60 + 1))
    op_off = np.repeat(np.clip(steps - steps.mean(), -0.08, 0.08), 60)[:n]
    load_set = np.clip(0.80 + 0.20 * np.sin(2 * np.pi * (hour - 8) / 24.0) + op_off + _ar1(rng, n, 0.995, 0.015), 0.5, 1.0)
    load = _lag(load_set, 5.0)
    seas = 3.0 * np.sin(2 * np.pi * ((doy0 + t / 1440.0) - 120) / 365.0)
    t_amb = 29.0 + seas + 4.0 * np.sin(2 * np.pi * (hour - 9) / 24.0) + _ar1(rng, n, 0.999, 0.6)
    rh = np.clip(0.65 - 0.15 * np.sin(2 * np.pi * (hour - 9) / 24.0) + _ar1(rng, n, 0.999, 0.03), 0.2, 0.95)

    # --- fault parameter traces
    fault_code = np.zeros(n, dtype=int)
    fade = np.zeros(n); restr = np.zeros(n); rec_drop = np.zeros(n); dp_extra = np.zeros(n)
    maldist = np.zeros(n); drift = np.zeros(n)
    if fault:
        ft, s0, dur = fault["type"], float(fault["start_min"]), float(fault["duration_min"])
        sev = fault.get("severity")
        rs = float(fault.get("ramp_scale", 1.0))                  # <1 compresses fault development (live demos)
        active = (t >= s0) & (t < s0 + dur)
        fault_code[active] = C.FAULT_CODES[ft]
        if ft == "blower_fade":
            fade = (0.25 if sev is None else sev) * _window(t, s0, dur, 480 * rs)
        elif ft == "h2_restriction":
            restr = (0.12 if sev is None else sev) * _window(t, s0, dur, 120 * rs)
        elif ft == "recycle_loss":
            rec_drop = (0.18 if sev is None else sev) * _window(t, s0, dur, 60 * rs)
        elif ft == "dp_excursion":
            amp = 28.0 if sev is None else sev
            for k in range(int(dur // (360 * rs))):
                c = s0 + 180 * rs + 360 * rs * k
                dp_extra += amp * np.clip(1 - np.abs(t - c) / 20.0, 0, 1)
        elif ft == "thermal_gradient":
            maldist = (0.13 if sev is None else sev) * _window(t, s0, dur, 360 * rs)
        elif ft == "sensor_drift":
            drift = (0.35 if sev is None else sev) * np.clip(t - s0, 0, dur) / 60.0 * (t < s0 + dur) \
                * np.clip(1 - (t - (s0 + dur)) / 60.0, 0, 1)

    rec = C.REC_SET - rec_drop
    # --- process: demand -> air command -> capacity limit -> real thermal state
    n_air_design = float(C.RES.get("air_kmol_h", C.RES["n_air_kmol_s"] * 3600.0))
    op0 = plant.operating_point(load, t_amb, asr_mult, d_act, rec=rec, h2_restr=restr)
    n_cmd = _lag(op0["air_kmol_h"], 6.0)
    cap = 1.12 * n_air_design * (1 - fade)
    n_air = np.minimum(n_cmd, cap)
    n_eff = n_air * (1 - maldist)                                   # maldistribution: less effective cooling
    eff = 1 - 0.6 * fade * 2.0
    op = plant.operating_point(load, t_amb, asr_mult, d_act, rec=rec, h2_restr=restr, n_air=n_eff, blower_eff=eff)
    flow_ratio_meas = n_air / max(1e-6, n_air_design)
    op_blw = plant.operating_point(load, t_amb, asr_mult, d_act, rec=rec, h2_restr=restr, n_air=n_air, blower_eff=eff)

    dT_real = _lag(op["dT_cath_K"], 12.0)
    t_ca_in = op["t_ca_in_C"]
    t_ca_out = t_ca_in + dT_real
    t_ab = _lag(op["t_afterburner_C"], 8.0)
    dp = op["dp_an_ca_mbar"] + dp_extra

    nz = C.NOISE
    N = lambda s: rng.normal(0, s, n)
    ch = {
        "t_amb_C": t_amb + N(nz["t_amb"]),
        "rh_amb": np.clip(rh + N(nz["rh"]), 0, 1),
        "load_set": load_set,
        "i_stack_A": op["i_stack_A"] + N(nz["i_A"]),
        "v_cell_V": op["v_cell_V"] + N(nz["v_cell_V"]),
        "t_an_in_C": t_ca_in + N(nz["t_K"]),
        "t_ca_in_C": t_ca_in + N(nz["t_K"]),
        "t_ca_out_C": t_ca_out + N(nz["t_K"]) + drift,
        "h2_flow_kg_h": op["h2_flow_kg_h"] * (1 + N(nz["flow_rel"])),
        "air_flow_kg_h": n_air * C.MW_AIR * (1 + N(nz["flow_rel"])),
        "recycle_flow_kmol_h": op["recycle_flow_kmol_h"] * (1 + N(nz["flow_rel"])),
        "steam_flow_kg_h": op["steam_flow_kg_h"] * (1 + N(2 * nz["flow_rel"])),
        "dp_an_ca_mbar": dp + N(nz["dp_mbar"]),
        "p_blower_kW": op_blw["p_blower_kW"] + N(nz["p_kW"]),
        "t_afterburner_C": t_ab + N(nz["t_K"]),
        "t_flue_out_C": op["t_flue_out_C"] + N(nz["t_K"]),
    }
    ch["p_dc_kW"] = op["p_dc_kW"] + N(nz["p_kW"])
    ch["p_net_kW"] = ch["p_dc_kW"] * C.ETA_INV - ch["p_blower_kW"] - C.RES["P_recycle_kW"] * ch["recycle_flow_kmol_h"] / 4.093 - C.P_AUX_KW + N(nz["p_kW"])
    ch["dT_cath_K"] = ch["t_ca_out_C"] - ch["t_ca_in_C"]
    df = pd.DataFrame({k: ch[k] for k in C.TELEMETRY_CHANNELS})
    df.insert(0, "ts", [t0 + timedelta(minutes=int(m)) for m in t])
    df["fault_code"] = fault_code
    df["run_id"] = run_id
    return df


def scenarios():
    """Training / validation / test runs. Ageing states cover new to nearly worn stacks."""
    runs = []
    for i, (a, d) in enumerate([(1.00, 0.000), (1.12, 0.012), (1.22, 0.025)]):
        runs.append(dict(run_id=f"train-normal-{i}", days=30, seed=100 + i, asr_mult=a, d_act=d, fault=None,
                         split="train", start=f"2026-0{1 + 3 * i}-01"))
    runs.append(dict(run_id="val-normal", days=10, seed=200, asr_mult=1.10, d_act=0.010, fault=None, split="val", start="2026-02-01"))
    runs.append(dict(run_id="test-normal", days=10, seed=300, asr_mult=1.15, d_act=0.015, fault=None, split="test", start="2026-05-01"))
    for k, ft in enumerate([f for f in C.FAULT_CODES if f != "normal"]):
        runs.append(dict(run_id=f"test-{ft}", days=10, seed=310 + k, asr_mult=1.15, d_act=0.015,
                         fault=dict(type=ft, start_min=5 * 1440, duration_min=3 * 1440), split="test", start="2026-05-01"))
    return runs


def simulate_all():
    frames = []
    for cfg in scenarios():
        df = simulate_run(cfg["run_id"], cfg["days"], cfg["seed"], cfg["asr_mult"], cfg["d_act"], cfg["fault"], cfg["start"])
        df["split"] = cfg["split"]
        frames.append(df)
    return pd.concat(frames, ignore_index=True)


if __name__ == "__main__":
    d = simulate_all()
    print(d.shape)
    print(d.groupby("run_id").size())
    print(d[d.run_id == "test-normal"][C.TELEMETRY_CHANNELS].describe().T[["mean", "min", "max"]].round(3))
