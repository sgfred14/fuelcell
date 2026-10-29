"""
Enhanced Physics-Informed Neural Network (PINN) Penalty Layer & Adaptive Loss Balancing.

Implements the full 6-constraint SOFC physical formulation with:
  1. Complete 6 SOFC physical constraints:
     - Faraday current & DC power consistency (r_far)
     - Plant net electrical power balance (r_net)
     - Fuel utilization box & setpoint centering (r_uf)
     - Stack thermal energy balance (r_energy)
     - Cathode temperature rise limit (r_dT)
     - Bidirectional differential pressure overpressure and seal lift-off (r_dp)
  2. Decoupled Huber loss (delta=1.0) for bilateral conservation residuals (r_far, r_net, r_energy).
  3. Smooth asymmetric Softplus barrier potentials (beta=2.0) with setpoint centering.
  4. Bidirectional differential pressure protection against overpressure (> 15 mbar)
     and negative seal lift-off (< -5 mbar).
  5. Wang et al. (2021) Gradient-Norm Annealing dynamic balancing callback.
  6. Dynamic Weight Averaging (DWA) (Liu et al. CVPR 2019) loss-trajectory balancing callback.
  7. Standalone functional residual calculator: compute_physics_residuals(...)
"""

import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import keras
from keras import layers, ops
import numpy as np
import tensorflow as tf

from . import config as C
from . import physics

log = logging.getLogger("sofc_ai.enhanced_physics_penalty")

CH = C.TELEMETRY_CHANNELS
IDX = {c: i for i, c in enumerate(CH)}
RES_KEYS = ["r_far", "r_net", "r_uf", "r_energy", "r_dT", "r_dp"]

KEY_MAP = {
    "r_far": "r_far",
    "faraday": "r_far",
    "r_net": "r_net",
    "net_power": "r_net",
    "r_uf": "r_uf",
    "fuel_util": "r_uf",
    "r_energy": "r_energy",
    "energy": "r_energy",
    "r_dT": "r_dT",
    "temp_rise": "r_dT",
    "r_dp": "r_dp",
    "diff_press": "r_dp",
}

DEFAULT_WEIGHTS = {k: 1.0 for k in RES_KEYS}


# ------------------------------------------------------------------ Mathematical Utilities
def huber_loss(r: tf.Tensor, delta: float = 1.0) -> tf.Tensor:
    """Vectorized element-wise Huber loss function with threshold delta.

    Provides quadratic convergence (0.5 * r^2) inside [-delta, delta]
    and linear growth (delta * (|r| - 0.5 * delta)) outside with bounded gradient magnitude <= delta.
    """
    abs_r = tf.abs(r)
    return tf.where(
        abs_r <= delta,
        0.5 * tf.square(abs_r),
        delta * (abs_r - 0.5 * delta),
    )


def softplus_barrier(z: tf.Tensor, beta: float = 2.0) -> tf.Tensor:
    """Smooth C-infinity asymmetric barrier potential with sharpness parameter beta.

    Satisfies:
      - Limiting value as z -> -inf is 0.
      - Limiting slope as z -> +inf is 1.0.
      - Smooth gradient sigma(beta * z) > 0 everywhere, avoiding zero-gradient dead zones.
    """
    return (1.0 / beta) * tf.math.softplus(beta * z)


# ------------------------------------------------------------------ Standalone Residuals
def compute_physics_residuals(
    data_tensor: tf.Tensor,
    mean: Optional[Union[tf.Tensor, np.ndarray, List[float]]] = None,
    std: Optional[Union[tf.Tensor, np.ndarray, List[float]]] = None,
) -> Dict[str, tf.Tensor]:
    """Computes unweighted, dimensionless scaled residuals for all 6 SOFC physical constraints.

    Args:
        data_tensor: Shape (..., 19) tensor of telemetry signals.
        mean: Optional 19-element mean vector. If provided, data_tensor is treated as normalized.
        std: Optional 19-element standard deviation vector.

    Returns:
        Dictionary mapping the 6 constraint keys to unweighted scaled residual tensors:
        {'r_far', 'r_net', 'r_uf', 'r_energy', 'r_dT', 'r_dp'}.
    """
    if mean is not None and std is not None:
        m = tf.cast(mean, tf.float32)
        s = tf.cast(std, tf.float32)
        raw = data_tensor * s + m
    else:
        raw = tf.cast(data_tensor, tf.float32)

    g = lambda name: raw[..., IDX[name]]

    # 1. Faraday DC Power Consistency (r_far)
    i_stack = g("i_stack_A")
    v_cell = g("v_cell_V")
    p_dc = g("p_dc_kW")
    p_dc_calc = i_stack * v_cell * C.N_SERIES / 1000.0
    r_far = (p_dc - p_dc_calc) / physics.SCALES["r_far"]

    # 2. Net Electrical Power Balance (r_net)
    p_net = g("p_net_kW")
    p_blw = g("p_blower_kW")
    rec = g("recycle_flow_kmol_h")
    rec_d = float(sum(C.STREAMS.get("recycle", {}).values())) if "recycle" in C.STREAMS else 4.093
    p_rec = C.RES["P_recycle_kW"] * rec / max(1e-6, rec_d)
    p_net_calc = p_dc * C.ETA_INV - p_blw - p_rec - C.P_AUX_KW
    r_net = (p_net - p_net_calc) / physics.SCALES["r_net"]

    # 3. Fuel Utilization with Setpoint Centering (r_uf)
    h2 = g("h2_flow_kg_h")
    n_cons = i_stack * C.N_SERIES * 3600.0 / (2.0 * C.FARADAY)
    f_h2 = h2 / C.MW_H2
    uf = n_cons / tf.maximum(f_h2, 1e-4)
    r_uf = (
        tf.nn.relu(uf - C.UF_BOUNDS[1])
        + tf.nn.relu(C.UF_BOUNDS[0] - uf)
        + 0.25 * tf.abs(uf - C.UF_SET)
    ) / physics.SCALES["r_uf"]

    # 4. Stack Thermal Energy Balance (r_energy)
    air = g("air_flow_kg_h")
    dT = g("dT_cath_K")
    q_gen = n_cons * C.LHV_H2 / 3600.0 - p_dc
    q_loss = C.LOSS_FRAC * f_h2 * C.LHV_H2 / 3600.0
    q_exp = C.F_AIR_SHARE * (q_gen - q_loss)
    q_meas = (air / C.MW_AIR) * C.CP_EFF * dT / 3600.0
    r_energy = (q_meas - q_exp) / (tf.maximum(q_exp, 1.0) * physics.SCALES["r_energy"])

    # 5. Cathode Temperature Rise Limit (r_dT)
    r_dT = tf.nn.relu(dT - C.DT_LIMIT) / physics.SCALES["r_dT"]

    # 6. Bidirectional Differential Pressure (r_dp)
    dp = g("dp_an_ca_mbar")
    r_dp = (
        tf.nn.relu(dp - C.DP_WARN_MBAR)
        + tf.nn.relu(-5.0 - dp)
    ) / physics.SCALES["r_dp"]

    return {
        "r_far": r_far,
        "r_net": r_net,
        "r_uf": r_uf,
        "r_energy": r_energy,
        "r_dT": r_dT,
        "r_dp": r_dp,
    }


# ------------------------------------------------------------------ Enhanced PINN Layer
@keras.saving.register_keras_serializable(package="sofc")
class EnhancedPhysicsPenalty(layers.Layer):
    """Enhanced Physics-Informed Neural Network (PINN) Penalty Regularization Layer.

    Applies decoupled Huber loss (delta=1.0) to bilateral conservation laws
    (Faraday, Net Power, Energy Balance) and smooth asymmetric Softplus barrier potentials
    (beta=2.0) with setpoint centering to inequality constraints (Fuel Utilization,
    Cathode Temperature Rise, and Bidirectional Differential Pressure).
    """

    def __init__(
        self,
        mean: Union[np.ndarray, List[float], tf.Tensor],
        std: Union[np.ndarray, List[float], tf.Tensor],
        weights: Optional[Dict[str, float]] = None,
        physics_weight: float = 0.02,
        delta: float = 1.0,
        beta: float = 2.0,
        barrier_scale: Optional[float] = None,
        adaptive: bool = True,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.mean_ = [float(x) for x in mean]
        self.std_ = [float(x) for x in std]
        self.physics_weight = float(physics_weight)
        self.delta = float(delta)
        self.beta = float(barrier_scale if barrier_scale is not None else beta)
        self.adaptive = bool(adaptive)

        # Parse and normalize initial weights dictionary
        init_weights = {k: 1.0 for k in RES_KEYS}
        if weights is not None:
            for k, v in weights.items():
                mapped_k = KEY_MAP.get(k, k)
                if mapped_k in init_weights:
                    init_weights[mapped_k] = float(v)
        self.base_weights = init_weights

        self._m = tf.constant(self.mean_, dtype=tf.float32)
        self._s = tf.constant(self.std_, dtype=tf.float32)

        # Non-trainable weights for each lambda_k (can be dynamically updated via .assign())
        self.lambdas = {}
        for k in RES_KEYS:
            w_val = self.base_weights[k]
            self.lambdas[k] = self.add_weight(
                name=f"lambda_{k}",
                shape=(),
                initializer=keras.initializers.Constant(w_val),
                trainable=False,
                dtype="float32",
            )

        # Keras 3 metric trackers for loss monitoring
        self.trackers = {
            k: keras.metrics.Mean(name=f"loss_{k}") for k in RES_KEYS
        }
        self.total_physics_tracker = keras.metrics.Mean(name="physics_loss")

    def _huber(self, r: tf.Tensor) -> tf.Tensor:
        return huber_loss(r, delta=self.delta)

    def _softplus_barrier(self, z: tf.Tensor) -> tf.Tensor:
        return softplus_barrier(z, beta=self.beta)

    def compute_individual_losses(self, x: tf.Tensor) -> Dict[str, tf.Tensor]:
        """Calculates individual scalar losses for each of the 6 physical constraints."""
        raw = x * self._s + self._m
        g = lambda name: raw[..., IDX[name]]

        # 1. Faraday Huber loss
        i_stack = g("i_stack_A")
        v_cell = g("v_cell_V")
        p_dc = g("p_dc_kW")
        p_dc_calc = i_stack * v_cell * C.N_SERIES / 1000.0
        r_far = (p_dc - p_dc_calc) / physics.SCALES["r_far"]
        l_far = tf.reduce_mean(self._huber(r_far))

        # 2. Net Electrical Power Huber loss
        p_net = g("p_net_kW")
        p_blw = g("p_blower_kW")
        rec = g("recycle_flow_kmol_h")
        rec_d = float(sum(C.STREAMS.get("recycle", {}).values())) if "recycle" in C.STREAMS else 4.093
        p_rec = C.RES["P_recycle_kW"] * rec / max(1e-6, rec_d)
        p_net_calc = p_dc * C.ETA_INV - p_blw - p_rec - C.P_AUX_KW
        r_net = (p_net - p_net_calc) / physics.SCALES["r_net"]
        l_net = tf.reduce_mean(self._huber(r_net))

        # 3. Fuel Utilization Smooth Softplus Barrier with Setpoint Centering
        h2 = g("h2_flow_kg_h")
        n_cons = i_stack * C.N_SERIES * 3600.0 / (2.0 * C.FARADAY)
        f_h2 = h2 / C.MW_H2
        uf = n_cons / tf.maximum(f_h2, 1e-4)
        z_uf_hi = (uf - C.UF_BOUNDS[1]) / physics.SCALES["r_uf"]
        z_uf_lo = (C.UF_BOUNDS[0] - uf) / physics.SCALES["r_uf"]
        z_uf_set = (uf - C.UF_SET) / physics.SCALES["r_uf"]
        barrier_uf = (
            self._softplus_barrier(z_uf_hi)
            + self._softplus_barrier(z_uf_lo)
            + 0.25 * self._huber(z_uf_set)
        )
        l_uf = tf.reduce_mean(barrier_uf)

        # 4. Stack Thermal Energy Balance Huber loss
        air = g("air_flow_kg_h")
        dT = g("dT_cath_K")
        q_gen = n_cons * C.LHV_H2 / 3600.0 - p_dc
        q_loss = C.LOSS_FRAC * f_h2 * C.LHV_H2 / 3600.0
        q_exp = C.F_AIR_SHARE * (q_gen - q_loss)
        q_meas = (air / C.MW_AIR) * C.CP_EFF * dT / 3600.0
        r_energy = (q_meas - q_exp) / (tf.maximum(q_exp, 1.0) * physics.SCALES["r_energy"])
        l_energy = tf.reduce_mean(self._huber(r_energy))

        # 5. Cathode Temperature Rise Smooth Softplus Barrier
        z_dT_hi = (dT - C.DT_LIMIT) / physics.SCALES["r_dT"]
        l_dT = tf.reduce_mean(self._softplus_barrier(z_dT_hi))

        # 6. Bidirectional Differential Pressure Smooth Softplus Barrier
        dp = g("dp_an_ca_mbar")
        z_dp_hi = (dp - C.DP_WARN_MBAR) / physics.SCALES["r_dp"]
        z_dp_lo = (-5.0 - dp) / physics.SCALES["r_dp"]
        barrier_dp = self._softplus_barrier(z_dp_hi) + self._softplus_barrier(z_dp_lo)
        l_dp = tf.reduce_mean(barrier_dp)

        return {
            "r_far": l_far,
            "r_net": l_net,
            "r_uf": l_uf,
            "r_energy": l_energy,
            "r_dT": l_dT,
            "r_dp": l_dp,
        }

    def call(self, x: tf.Tensor, training: Optional[bool] = None) -> tf.Tensor:
        if self.physics_weight > 0.0:
            loss_dict = self.compute_individual_losses(x)
            total_phys_loss = tf.add_n([
                self.lambdas[k] * loss_dict[k] for k in RES_KEYS
            ])
            self.add_loss(self.physics_weight * total_phys_loss)

            # Update metric trackers
            for k in RES_KEYS:
                self.trackers[k].update_state(loss_dict[k])
            self.total_physics_tracker.update_state(self.physics_weight * total_phys_loss)

        return x

    def get_weights_dict(self) -> Dict[str, float]:
        """Returns dictionary of current lambda penalty weights."""
        return {k: float(self.lambdas[k].numpy()) for k in RES_KEYS}

    def set_weights_dict(self, weights_dict: Dict[str, float]) -> None:
        """Assigns new lambda penalty weights."""
        for k, v in weights_dict.items():
            mapped_k = KEY_MAP.get(k, k)
            if mapped_k in self.lambdas:
                self.lambdas[mapped_k].assign(float(v))

    def set_lambda(self, key: str, value: float) -> None:
        """Sets an individual lambda penalty weight."""
        mapped_k = KEY_MAP.get(key, key)
        if mapped_k in self.lambdas:
            self.lambdas[mapped_k].assign(float(value))

    def get_lambda(self, key: str) -> float:
        """Retrieves an individual lambda penalty weight."""
        mapped_k = KEY_MAP.get(key, key)
        if mapped_k in self.lambdas:
            return float(self.lambdas[mapped_k].numpy())
        raise KeyError(f"Unknown penalty key: {key}")

    def get_config(self) -> dict:
        config = super().get_config()
        config.update({
            "mean": self.mean_,
            "std": self.std_,
            "weights": self.get_weights_dict(),
            "physics_weight": self.physics_weight,
            "delta": self.delta,
            "beta": self.beta,
            "adaptive": self.adaptive,
        })
        return config

    @classmethod
    def from_config(cls, config):
        return cls(**config)


# ------------------------------------------------------------------ Wang Adaptive Balancing
class WangAdaptiveBalancingCallback(keras.callbacks.Callback):
    """Wang et al. (2021) Gradient-Norm Annealing Callback.

    Balances backpropagated gradient norms between primary reconstruction error and
    individual physics losses:
      lambda_k_hat = target_ratio * (||grad_rec|| / max(||grad_k||, epsilon))
      lambda_k = (1 - alpha) * lambda_k_prev + alpha * lambda_k_hat
      lambda_k = clip(lambda_k, min_weight, max_weight)
    """

    def __init__(
        self,
        physics_layer: Optional[EnhancedPhysicsPenalty] = None,
        penalty_layer: Optional[EnhancedPhysicsPenalty] = None,
        model: Optional[keras.Model] = None,
        alpha: float = 0.1,
        target_ratio: float = 1.0,
        min_weight: float = 1e-4,
        max_weight: float = 50.0,
        clip_range: Optional[Tuple[float, float]] = None,
        epsilon: float = 1e-6,
        probe: str = "output",
        update_freq: Union[str, int] = "epoch",
        calibration_data: Optional[tf.Tensor] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.physics_layer = penalty_layer if penalty_layer is not None else physics_layer
        self._model_ref = model
        self.alpha = float(alpha)
        self.target_ratio = float(target_ratio)
        if clip_range is not None:
            self.min_weight, self.max_weight = float(clip_range[0]), float(clip_range[1])
        else:
            self.min_weight = float(min_weight)
            self.max_weight = float(max_weight)
        self.epsilon = float(epsilon)
        self.probe = probe
        self.update_freq = update_freq
        self.calibration_data = calibration_data
        self.step_counter = 0

    @property
    def model(self) -> Optional[keras.Model]:
        return getattr(self, "_model_ref", None) or getattr(self, "_model", None)

    @model.setter
    def model(self, value: Optional[keras.Model]) -> None:
        self.set_model(value)

    def set_model(self, model: Optional[keras.Model]) -> None:
        self._model_ref = model
        try:
            super().set_model(model)
        except Exception:
            pass

    def _get_physics_layer(self) -> EnhancedPhysicsPenalty:
        if self.physics_layer is not None:
            return self.physics_layer
        curr_model = self.model
        if curr_model is not None:
            for layer in curr_model.layers:
                if isinstance(layer, EnhancedPhysicsPenalty):
                    return layer
        raise ValueError("EnhancedPhysicsPenalty layer not found in model or callback.")

    def _get_target_weights(self) -> List[tf.Variable]:
        curr_model = self.model
        if curr_model is None:
            raise ValueError("Model has not been set on callback.")
        if self.probe == "output":
            try:
                rec_layer = curr_model.get_layer("reconstruction")
                return rec_layer.trainable_weights
            except ValueError:
                pass
        return curr_model.trainable_weights

    def compute_target_weight(self, g_rec: float, g_k: float) -> float:
        """Calculates instantaneous target weight ratio with numerical safeguard clamping."""
        g_k_safe = max(float(g_k), self.epsilon)
        raw_ratio = self.target_ratio * (float(g_rec) / g_k_safe)
        if not np.isfinite(raw_ratio) or np.isnan(raw_ratio):
            return self.min_weight
        return float(np.clip(raw_ratio, self.min_weight, self.max_weight))

    def update_weights(self, x_batch: tf.Tensor, model: Optional[keras.Model] = None) -> None:
        """Executes one adaptive balancing step on the provided batch tensor."""
        if model is not None:
            self.set_model(model)
        curr_model = self.model
        if curr_model is None:
            raise ValueError("Model must be set before update_weights can be called.")

        layer = self._get_physics_layer()
        target_weights = self._get_target_weights()

        with tf.GradientTape(persistent=True) as tape:
            pred = curr_model(x_batch, training=True)
            loss_rec = tf.reduce_mean(tf.square(pred - x_batch))
            phys_losses = layer.compute_individual_losses(pred)

        g_rec = tape.gradient(loss_rec, target_weights)
        rec_grads = [g for g in g_rec if g is not None]
        if len(rec_grads) > 0:
            norm_rec = float(tf.sqrt(sum(tf.reduce_sum(tf.square(g)) for g in rec_grads)))
        else:
            norm_rec = 1.0

        for k in RES_KEYS:
            g_k = tape.gradient(phys_losses[k], target_weights)
            k_grads = [g for g in g_k if g is not None]
            if len(k_grads) > 0:
                norm_k = float(tf.sqrt(sum(tf.reduce_sum(tf.square(g)) for g in k_grads)))
            else:
                norm_k = 0.0

            target_lambda = self.compute_target_weight(norm_rec, norm_k)
            current_lambda = layer.get_lambda(k)

            # Exponential Moving Average update
            updated_lambda = (1.0 - self.alpha) * current_lambda + self.alpha * target_lambda
            clipped_lambda = float(np.clip(updated_lambda, self.min_weight, self.max_weight))
            layer.set_lambda(k, clipped_lambda)

        del tape

    def on_epoch_end(self, epoch: int, logs: Optional[dict] = None) -> None:
        if self.update_freq == "epoch":
            if self.calibration_data is not None:
                self.update_weights(self.calibration_data)
            else:
                curr_model = self.model
                if curr_model is not None:
                    L = curr_model.input_shape[1] if curr_model.input_shape[1] is not None else 12
                    n_ch = curr_model.input_shape[2] if curr_model.input_shape[2] is not None else 19
                    x_probe = tf.random.normal((32, L, n_ch))
                    self.update_weights(x_probe)

    def on_train_batch_end(self, batch: int, logs: Optional[dict] = None) -> None:
        if isinstance(self.update_freq, int) and self.update_freq > 0:
            self.step_counter += 1
            if self.step_counter % self.update_freq == 0:
                if self.calibration_data is not None:
                    self.update_weights(self.calibration_data)
                else:
                    curr_model = self.model
                    if curr_model is not None:
                        L = curr_model.input_shape[1] if curr_model.input_shape[1] is not None else 12
                        n_ch = curr_model.input_shape[2] if curr_model.input_shape[2] is not None else 19
                        x_probe = tf.random.normal((32, L, n_ch))
                        self.update_weights(x_probe)


# ------------------------------------------------------------------ Dynamic Weight Averaging
class DynamicWeightAveragingCallback(keras.callbacks.Callback):
    """Dynamic Weight Averaging (DWA) Callback (Liu et al. CVPR 2019).

    Tracks epoch loss trajectory descent rates:
      r_k(t-1) = L_k(t-1) / (L_k(t-2) + epsilon)
      w_k(t) = K * exp(r_k(t-1) / T) / sum_j exp(r_j(t-1) / T)
    """

    def __init__(
        self,
        physics_layer: Optional[EnhancedPhysicsPenalty] = None,
        penalty_layer: Optional[EnhancedPhysicsPenalty] = None,
        model: Optional[keras.Model] = None,
        num_tasks: int = 6,
        temp: float = 2.0,
        epsilon: float = 1e-8,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.physics_layer = penalty_layer if penalty_layer is not None else physics_layer
        self._model_ref = model
        self.num_tasks = int(num_tasks)
        self.temp = float(temp)
        self.epsilon = float(epsilon)
        self.loss_history = {k: [] for k in RES_KEYS}

    @property
    def model(self) -> Optional[keras.Model]:
        return getattr(self, "_model_ref", None) or getattr(self, "_model", None)

    @model.setter
    def model(self, value: Optional[keras.Model]) -> None:
        self.set_model(value)

    def set_model(self, model: Optional[keras.Model]) -> None:
        self._model_ref = model
        try:
            super().set_model(model)
        except Exception:
            pass

    def _get_physics_layer(self) -> EnhancedPhysicsPenalty:
        if self.physics_layer is not None:
            return self.physics_layer
        curr_model = self.model
        if curr_model is not None:
            for layer in curr_model.layers:
                if isinstance(layer, EnhancedPhysicsPenalty):
                    return layer
        raise ValueError("EnhancedPhysicsPenalty layer not found in model or callback.")

    def compute_weights(
        self,
        loss_prev: Union[np.ndarray, List[float]],
        loss_curr: Union[np.ndarray, List[float]],
    ) -> np.ndarray:
        """Calculates temperature-scaled softmax weights based on task convergence speed."""
        lp = np.array(loss_prev, dtype=np.float64)
        lc = np.array(loss_curr, dtype=np.float64)
        K = len(lp)
        rates = np.clip(lc / (lp + self.epsilon), 1e-4, 1e4)
        rates_scaled = rates / self.temp
        # Canonical numerically stable softmax shift: max(rates_scaled - np.max(rates_scaled)) == 0.0
        exp_rates = np.exp(rates_scaled - np.max(rates_scaled))
        weights = K * exp_rates / np.sum(exp_rates)
        return weights

    def on_epoch_end(self, epoch: int, logs: Optional[dict] = None) -> None:
        logs = logs or {}
        try:
            layer = self._get_physics_layer()
        except ValueError:
            return

        for k in RES_KEYS:
            val = logs.get(f"loss_{k}", None)
            if val is None and k in layer.trackers:
                val = float(layer.trackers[k].result().numpy())
            if val is None:
                val = 1.0
            self.loss_history[k].append(float(val))

        if epoch >= 2 and len(self.loss_history[RES_KEYS[0]]) >= 2:
            loss_prev = [self.loss_history[k][-2] for k in RES_KEYS]
            loss_curr = [self.loss_history[k][-1] for k in RES_KEYS]
            dwa_weights = self.compute_weights(loss_prev, loss_curr)
            for k, w in zip(RES_KEYS, dwa_weights):
                base_w = layer.base_weights[k]
                layer.set_lambda(k, float(w * base_w))
