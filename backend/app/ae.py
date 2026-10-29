"""Wrapper around the trained Keras autoencoder. If TensorFlow or the weights are missing, the server runs on the physics checks alone."""
import json
import logging
import os
from pathlib import Path

import numpy as np

log = logging.getLogger("monitor.ae")
MODEL_DIR = Path(os.environ.get("AE_MODEL_DIR", Path(__file__).resolve().parents[1] / "models" / "anomaly"))


class AEModel:
    def __init__(self, path=MODEL_DIR):
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
        from sofc_ai import anomaly_model as AM                 # imports TensorFlow / Keras
        meta = json.loads((Path(path) / "meta.json").read_text())
        self.channels = meta["channels"]
        self.window = int(meta["window"])
        self.mean = np.array(meta["mean"], np.float32)
        self.std = np.array(meta["std"], np.float32)
        self.threshold = float(meta["thresholds"]["pinn"]["ae"])
        self.model = AM.build_ae(self.mean, self.std, float(meta["physics_weight"]))
        self.model.load_weights(Path(path) / "ae_pinn.weights.h5")
        self.score(np.tile(self.mean, (self.window, 1)))        # warm-up call (graph compilation)

    def score(self, window_raw: np.ndarray):
        """window_raw: (window, channels) 5-minute averages. Returns (score, per-channel rmse in standard deviations)."""
        x = ((window_raw.astype(np.float32) - self.mean) / self.std)[None]
        rec = np.asarray(self.model(x, training=False))
        err = (rec - x) ** 2
        return float(err.mean()), np.sqrt(err.mean(axis=(0, 1)))


def try_load():
    try:
        return AEModel()
    except Exception as exc:                                     # missing TensorFlow, missing weights ...
        log.warning("Learned-model detector unavailable, using physics checks only: %s: %s", type(exc).__name__, exc)
        return None
