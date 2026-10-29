"""
Optimized Deep Learning Architecture for SOFC Telemetry Anomaly Detection:
Residual Temporal-Attention Autoencoder (RTA-AE).

Operates alongside the baseline model (backend/sofc_ai/anomaly_model.py) without
modifying or overwriting production model weights in backend/models/anomaly/ae_pinn.weights.h5.

Architectural Improvements:
  1. Multi-Head Temporal Self-Attention (H=4, key_dim=16): captures pairwise temporal cross-step
     dependencies across the 12-step (60-minute) window without temporal amnesia.
  2. Channel Feature Gating (Squeeze-and-Excitation): dynamic channel recalibration isolating
     single-channel excursions (e.g. recycle compressor failure) diluted in baseline MSE.
  3. Bidirectional LSTM Encoding: bidirectional unrolling capturing both historical trends
     and leading state indicators.
  4. Sequence Bottleneck (latent_dim=32): preserves temporal progression through the latent
     manifold with LayerNormalization and non-saturating GELU activations.
  5. Residual Sub-layer Connections: intra-block residual additions avoiding degenerate
     global input-to-output identity bypass (preventing anomaly score collapse).
"""

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import keras
from keras import layers, ops
import numpy as np
import tensorflow as tf

from . import config as C
from . import physics

try:
    from .enhanced_physics_penalty import (
        EnhancedPhysicsPenalty,
        WangAdaptiveBalancingCallback,
        DynamicWeightAveragingCallback,
        compute_physics_residuals,
    )
except ImportError:
    pass

log = logging.getLogger("sofc_ai.optimized_anomaly_model")

CH = C.TELEMETRY_CHANNELS
IDX = {c: i for i, c in enumerate(CH)}
L_WIN = 12          # 12 steps of 5 minutes = 1 hour
STRIDE = 1          # scoring stride in 5-minute steps
STEP_MIN = 5


# ------------------------------------------------------------------ custom layers
@keras.saving.register_keras_serializable(package="sofc")
class ChannelFeatureGating(layers.Layer):
    """Channel-wise Feature Squeeze-and-Excitation Gating.
    
    Extracts global temporal summary via average pooling, projects through
    a GELU bottleneck, expands to channel dimension via sigmoid, and recalibrates
    the input sequence tensor channel-wise.
    """

    def __init__(self, channels: int = 19, reduction_dim: int = 8, clip_val: float = 10.0, **kwargs):
        super().__init__(**kwargs)
        self.channels = int(channels)
        self.reduction_dim = int(reduction_dim)
        self.clip_val = float(clip_val)
        self.reduce_dense = layers.Dense(
            self.reduction_dim,
            activation="gelu",
            name="se_reduce",
        )
        self.expand_dense = layers.Dense(
            self.channels,
            activation="sigmoid",
            name="se_expand",
        )

    def call(self, inputs):
        # inputs shape: (B, L, C)
        inputs_clamped = ops.clip(inputs, -self.clip_val, self.clip_val)
        gap = ops.mean(inputs_clamped, axis=1, keepdims=True)  # (B, 1, C)
        reduced = self.reduce_dense(gap)                       # (B, 1, reduction_dim)
        gates = self.expand_dense(reduced)                     # (B, 1, C)
        return inputs_clamped * gates                          # (B, L, C)

    def get_config(self):
        config = super().get_config()
        config.update({
            "channels": self.channels,
            "reduction_dim": self.reduction_dim,
            "clip_val": self.clip_val,
        })
        return config


@keras.saving.register_keras_serializable(package="sofc")
class BidirectionalLSTMEncoder(layers.Layer):
    """Bidirectional LSTM temporal encoder with LayerNormalization and Dropout."""

    def __init__(self, units: int = 64, dropout: float = 0.1, **kwargs):
        super().__init__(**kwargs)
        self.units = int(units)
        self.dropout_rate = float(dropout)
        self.bilstm = layers.Bidirectional(
            layers.LSTM(self.units, return_sequences=True),
            name="bilstm",
        )
        self.norm = layers.LayerNormalization(epsilon=1e-5, name="norm")
        self.dropout = layers.Dropout(self.dropout_rate, name="dropout")

    def call(self, inputs, training=None):
        # inputs: (B, L, C) -> outputs: (B, L, 2 * units)
        x = self.bilstm(inputs)
        x = self.norm(x)
        return self.dropout(x, training=training)

    def get_config(self):
        config = super().get_config()
        config.update({
            "units": self.units,
            "dropout": self.dropout_rate,
        })
        return config


@keras.saving.register_keras_serializable(package="sofc")
class MultiHeadTemporalAttention(layers.Layer):
    """Multi-Head Self-Attention along the temporal sequence dimension.
    
    Computes scaled dot-product self-attention on (B, L, C), applies internal
    residual addition (x + Attention(x)), and normalizes via LayerNormalization.
    """

    def __init__(self, num_heads: int = 4, key_dim: int = 16, dropout: float = 0.1, **kwargs):
        super().__init__(**kwargs)
        self.num_heads = int(num_heads)
        self.key_dim = int(key_dim)
        self.dropout_rate = float(dropout)
        self.mha = layers.MultiHeadAttention(
            num_heads=self.num_heads,
            key_dim=self.key_dim,
            dropout=self.dropout_rate,
            use_bias=False,
            name="mha",
        )
        self.dropout = layers.Dropout(self.dropout_rate, name="mha_dropout")
        self.norm = layers.LayerNormalization(epsilon=1e-5, name="mha_norm")
        self.add = layers.Add(name="mha_add")

    def call(self, inputs, training=None):
        # inputs shape: (B, L, C)
        attn_out = self.mha(query=inputs, value=inputs, key=inputs, training=training)
        attn_out = self.dropout(attn_out, training=training)
        return self.norm(self.add([inputs, attn_out]))

    def get_config(self):
        config = super().get_config()
        config.update({
            "num_heads": self.num_heads,
            "key_dim": self.key_dim,
            "dropout": self.dropout_rate,
        })
        return config


# ------------------------------------------------------------------ model builder
def build_optimized_ae(
    mean: np.ndarray,
    std: np.ndarray,
    L: int = L_WIN,
    n_ch: int = len(CH),
    lstm_units: int = 64,
    latent_dim: int = 32,
    num_heads: int = 4,
    key_dim: int = 16,
    dropout: float = 0.1,
    physics_layer: Optional[keras.layers.Layer] = None,
) -> keras.Model:
    """Builds the Residual Temporal-Attention Autoencoder (RTA-AE).
    
    Args:
        mean: Channel means of length n_ch (used for denormalization if physics_layer attached).
        std: Channel standard deviations of length n_ch.
        L: Sequence length (window time steps, default 12).
        n_ch: Number of telemetry channels (default 19).
        lstm_units: Hidden units for BiLSTM encoder and decoder (default 64 -> 128 concatenated).
        latent_dim: Bottleneck dimension preserving temporal sequence (default 32).
        num_heads: Number of temporal attention heads (default 4).
        key_dim: Key/query dimension per head (default 16).
        dropout: Regularization dropout rate (default 0.1).
        physics_layer: Optional PhysicsPenalty / EnhancedPhysicsPenalty layer.
        
    Returns:
        Compiled keras.Model configured with Adam(1e-3) and MSE loss.
    """
    inp = keras.Input(shape=(L, n_ch), name="telemetry_input")

    # 1. Squeeze-and-Excitation Channel Gating
    gated = ChannelFeatureGating(channels=n_ch, reduction_dim=8, name="channel_gating")(inp)

    # 2. Bidirectional LSTM Temporal Encoder with LayerNorm & Dropout
    enc = BidirectionalLSTMEncoder(units=lstm_units, dropout=dropout, name="enc_bilstm")(gated)

    # 3. Multi-Head Temporal Self-Attention with Residual Addition & LayerNorm
    attn = MultiHeadTemporalAttention(
        num_heads=num_heads,
        key_dim=key_dim,
        dropout=dropout,
        name="temporal_attention",
    )(enc)

    # 4. Latent Sequence Bottleneck (preserves 12 steps with temporal differentiation)
    bottleneck = layers.Dense(latent_dim, activation="gelu", name="bottleneck_dense")(attn)
    latent = layers.LayerNormalization(epsilon=1e-5, name="latent_norm")(bottleneck)

    # 5. Bidirectional LSTM Temporal Decoder
    dec = layers.Bidirectional(
        layers.LSTM(lstm_units, return_sequences=True),
        name="dec_bilstm",
    )(latent)
    dec = layers.LayerNormalization(epsilon=1e-5, name="dec_norm")(dec)
    dec = layers.Dense(lstm_units, activation="gelu", name="dec_dense")(dec)

    # 6. Channel Reconstruction Projection
    out = layers.Dense(n_ch, name="reconstruction")(dec)

    # 7. Optional Physics Penalty Regularization Layer
    if physics_layer is not None:
        out = physics_layer(out)

    model = keras.Model(inputs=inp, outputs=out, name="RTA_AE")
    model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mse")
    return model


def get_model_summary(model: keras.Model) -> dict:
    """Extracts structural metadata and parameter counts from the compiled model."""
    return {
        "name": model.name,
        "total_params": int(model.count_params()),
        "trainable_params": int(sum(ops.size(w) for w in model.trainable_weights)),
        "non_trainable_params": int(sum(ops.size(w) for w in model.non_trainable_weights)),
        "layers": [layer.name for layer in model.layers],
        "input_shape": model.input_shape,
        "output_shape": model.output_shape,
    }


# ------------------------------------------------------------------ training & scoring helpers
def train_optimized_ae(
    Xtr: np.ndarray,
    Xva: np.ndarray,
    mean: np.ndarray,
    std: np.ndarray,
    epochs: int = 25,
    batch_size: int = 128,
    lstm_units: int = 64,
    latent_dim: int = 32,
    num_heads: int = 4,
    key_dim: int = 16,
    dropout: float = 0.1,
    physics_layer: Optional[keras.layers.Layer] = None,
    lr: float = 1e-3,
    seed: int = 0,
    verbose: int = 0,
) -> Tuple[keras.Model, dict]:
    """Trains the optimized RTA-AE on normal telemetry windows."""
    keras.utils.set_random_seed(seed)
    model = build_optimized_ae(
        mean=mean,
        std=std,
        L=Xtr.shape[1],
        n_ch=Xtr.shape[2],
        lstm_units=lstm_units,
        latent_dim=latent_dim,
        num_heads=num_heads,
        key_dim=key_dim,
        dropout=dropout,
        physics_layer=physics_layer,
    )
    if lr != 1e-3:
        model.compile(optimizer=keras.optimizers.Adam(lr), loss="mse")

    ntr = (Xtr - mean) / std
    nva = (Xva - mean) / std
    es = keras.callbacks.EarlyStopping(monitor="val_loss", patience=4, restore_best_weights=True)
    hist = model.fit(
        ntr,
        ntr,
        validation_data=(nva, nva),
        epochs=epochs,
        batch_size=batch_size,
        callbacks=[es],
        verbose=verbose,
    )
    return model, hist.history


def optimized_ae_scores(
    model: keras.Model,
    X: np.ndarray,
    mean: np.ndarray,
    std: np.ndarray,
    batch: int = 1024,
) -> np.ndarray:
    """Computes mean-squared error anomaly scores across telemetry windows."""
    out = []
    for i in range(0, len(X), batch):
        xb = (X[i:i + batch] - mean) / std
        rec = model.predict(xb, verbose=0)
        out.append(np.mean((rec - xb) ** 2, axis=(1, 2)))
    return np.concatenate(out)


# ------------------------------------------------------------------ bundle serialization
def save_optimized_bundle(
    path: Union[str, Path],
    model: keras.Model,
    mean: np.ndarray,
    std: np.ndarray,
    th: Optional[Any] = None,
    history: Optional[dict] = None,
    filename_prefix: str = "ae_optimized",
) -> None:
    """Saves model weights and metadata into a non-destructive bundle."""
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    weights_path = p / f"{filename_prefix}.weights.h5"
    meta_path = p / f"meta_{filename_prefix}.json"

    model.save_weights(weights_path)
    meta_payload = {
        "model_type": "RTA-AE",
        "channels": list(CH),
        "window": int(L_WIN),
        "stride": int(STRIDE),
        "mean": [float(x) for x in mean],
        "std": [float(x) for x in std],
        "thresholds": th if th is not None else {"ae": 0.5},
        "history": history or {},
        "summary": get_model_summary(model),
    }
    meta_path.write_text(json.dumps(meta_payload, indent=2))


def load_optimized_bundle(
    path: Union[str, Path],
    filename_prefix: str = "ae_optimized",
    physics_layer: Optional[keras.layers.Layer] = None,
) -> Tuple[keras.Model, np.ndarray, np.ndarray, dict]:
    """Loads non-destructive optimized model bundle."""
    p = Path(path)
    meta_path = p / f"meta_{filename_prefix}.json"
    if not meta_path.exists():
        # Fallback check
        alt_meta = p / "meta_optimized.json"
        if alt_meta.exists():
            meta_path = alt_meta
        else:
            raise FileNotFoundError(f"Optimized metadata not found at {meta_path}")

    meta = json.loads(meta_path.read_text())
    mean = np.array(meta["mean"], dtype=np.float32)
    std = np.array(meta["std"], dtype=np.float32)
    window = int(meta.get("window", L_WIN))
    n_ch = len(meta.get("channels", CH))

    model = build_optimized_ae(
        mean=mean,
        std=std,
        L=window,
        n_ch=n_ch,
        physics_layer=physics_layer,
    )
    weights_path = p / f"{filename_prefix}.weights.h5"
    if not weights_path.exists():
        alt_weights = p / "ae_optimized.weights.h5"
        if alt_weights.exists():
            weights_path = alt_weights
        else:
            raise FileNotFoundError(f"Optimized weights not found at {weights_path}")

    model.load_weights(weights_path)
    return model, mean, std, meta


# ------------------------------------------------------------------ runtime scoring wrapper
class OptimizedAEModel:
    """Runtime wrapper matching backend/app/ae.py:AEModel interface."""

    def __init__(
        self,
        path: Optional[Union[str, Path]] = None,
        weights_filename: str = "ae_optimized.weights.h5",
        meta_filename: str = "meta_ae_optimized.json",
        model: Optional[keras.Model] = None,
        mean: Optional[np.ndarray] = None,
        std: Optional[np.ndarray] = None,
        threshold: float = 0.5,
        alpha: float = 0.5,
    ):
        self.alpha = float(alpha)
        if model is not None and mean is not None and std is not None:
            self.model = model
            self.mean = np.array(mean, dtype=np.float32)
            self.std = np.array(std, dtype=np.float32)
            self.channels = list(CH[: len(self.mean)])
            self.window = L_WIN
            self.threshold = float(threshold)
        elif path is not None:
            p = Path(path)
            meta_path = p / meta_filename
            if not meta_path.exists():
                alt_meta = p / "meta_optimized.json"
                if alt_meta.exists():
                    meta_path = alt_meta
                else:
                    raise FileNotFoundError(f"Metadata file not found at {meta_path}")
            meta = json.loads(meta_path.read_text())
            self.channels = meta.get("channels", list(CH))
            self.window = int(meta.get("window", L_WIN))
            self.mean = np.array(meta["mean"], dtype=np.float32)
            self.std = np.array(meta["std"], dtype=np.float32)
            th_data = meta.get("thresholds", {})
            if isinstance(th_data, dict):
                self.threshold = float(th_data.get("ae", th_data.get("pinn", {}).get("ae", 0.5)))
            else:
                self.threshold = float(th_data)

            self.model = build_optimized_ae(
                mean=self.mean,
                std=self.std,
                L=self.window,
                n_ch=len(self.channels),
            )
            w_path = p / weights_filename
            if not w_path.exists():
                alt_w = p / "ae_optimized.weights.h5"
                if alt_w.exists():
                    w_path = alt_w
                else:
                    raise FileNotFoundError(f"Weights file not found at {w_path}")
            self.model.load_weights(w_path)
        else:
            raise ValueError("Either model+mean+std or path must be provided.")

        @tf.function(reduce_retracing=True)
        def _infer_fn(tensor_in):
            return self.model(tensor_in, training=False)

        self._infer = _infer_fn

        # Warm-up graph tracing call
        self.score(np.tile(self.mean, (self.window, 1)))

    def score(self, window_raw: np.ndarray, alpha: Optional[float] = None) -> Tuple[float, np.ndarray]:
        """window_raw: (window, channels) 5-minute averages. Returns (composite_score, per-channel rmse in std)."""
        a = self.alpha if alpha is None else float(alpha)
        x = ((window_raw.astype(np.float32) - self.mean) / self.std)[None]
        rec = np.asarray(self._infer(tf.constant(x)))
        err = (rec - x) ** 2
        global_mse = float(np.mean(err))
        per_channel_mse = err.mean(axis=(0, 1))  # shape: (19,)
        max_channel_mse = float(np.max(per_channel_mse))
        composite_score = float(a * global_mse + (1.0 - a) * max_channel_mse)
        per_channel_rmse = np.sqrt(per_channel_mse)
        return composite_score, per_channel_rmse

    def score_batch(self, windows_raw: np.ndarray, alpha: Optional[float] = None) -> Tuple[np.ndarray, np.ndarray]:
        """windows_raw: (batch, window, channels). Returns (composite_scores, per-channel rmse)."""
        a = self.alpha if alpha is None else float(alpha)
        x = (windows_raw.astype(np.float32) - self.mean) / self.std
        rec = np.asarray(self._infer(tf.constant(x)))
        err = (rec - x) ** 2
        global_mse = np.mean(err, axis=(1, 2))
        per_channel_mse = np.mean(err, axis=1)  # shape: (batch, channels)
        max_channel_mse = np.max(per_channel_mse, axis=1)  # shape: (batch,)
        composite_scores = a * global_mse + (1.0 - a) * max_channel_mse
        per_channel_rmse = np.sqrt(per_channel_mse)
        return composite_scores, per_channel_rmse
