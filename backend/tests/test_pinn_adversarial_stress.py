"""
Adversarial Empirical Stress-Testing Suite for Enhanced PINN Physics Penalty.

Evaluates backend/sofc_ai/enhanced_physics_penalty.py against:
  1. Division by zero and small epsilons (zero fuel flow, negative flows, Q_exp = 0)
  2. Extreme out-of-distribution physical telemetry (zero current, 1000A surges, extreme temperatures)
  3. Huber loss vs Quadratic (L2) vs log1p gradient boundedness under 1000x - 10000x anomaly spikes
  4. Asymmetric softplus barrier continuity and restoring gradient behavior across boundary inflection points
  5. Bidirectional differential pressure seal lift-off (< -5 mbar) and overpressure (> 15 mbar)
  6. End-to-end model gradient stability under adversarial batches
  7. Non-destruction of baseline production model weights
"""

import hashlib
import os
from pathlib import Path

import keras
import numpy as np
import pytest
import tensorflow as tf

from sofc_ai.enhanced_physics_penalty import (
    EnhancedPhysicsPenalty,
    WangAdaptiveBalancingCallback,
    DynamicWeightAveragingCallback,
    compute_physics_residuals,
    huber_loss,
    softplus_barrier,
    RES_KEYS,
)
from sofc_ai.optimized_anomaly_model import (
    build_optimized_ae,
    CH,
    L_WIN,
)
from sofc_ai import plant, physics
from sofc_ai import config as C


def _create_nominal_batch(batch_size: int = 1) -> np.ndarray:
    """Creates a nominal telemetry batch of shape (batch_size, 12, 19)."""
    op = plant.operating_point(1.0, 30.0)
    raw = np.zeros((batch_size, 12, 19), dtype=np.float32)
    raw[..., 0] = float(op["t_amb_C"])
    raw[..., 1] = 0.60
    raw[..., 2] = float(op["load"])
    raw[..., 3] = float(op["i_stack_A"])
    raw[..., 4] = float(op["v_cell_V"])
    raw[..., 5] = float(op["p_dc_kW"])
    raw[..., 6] = float(op["p_net_kW"])
    raw[..., 7] = float(op["t_an_in_C"])
    raw[..., 8] = float(op["t_ca_in_C"])
    raw[..., 9] = float(op["t_ca_out_C"])
    raw[..., 10] = float(op["dT_cath_K"])
    raw[..., 11] = float(op["h2_flow_kg_h"])
    raw[..., 12] = float(op["air_flow_kg_h"])
    raw[..., 13] = float(op["recycle_flow_kmol_h"])
    raw[..., 14] = float(op["steam_flow_kg_h"])
    raw[..., 15] = float(op["dp_an_ca_mbar"])
    raw[..., 16] = float(op["p_blower_kW"])
    raw[..., 17] = float(op["t_afterburner_C"])
    raw[..., 18] = float(op["t_flue_out_C"])
    return raw


# ------------------------------------------------------------------ 1. Division by Zero & Small Epsilons
def test_zero_and_negative_fuel_flow_stability():
    """Stress-test division by zero when fuel flow is exactly 0, negative, or epsilon."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std)

    adversarial_h2_flows = [0.0, -1e-6, -1.0, -50.0, 1e-12, 1e-4]

    for h2_val in adversarial_h2_flows:
        batch = _create_nominal_batch(1)
        batch[..., 11] = h2_val  # h2_flow_kg_h

        # 1. Residual calculation check
        residuals = compute_physics_residuals(tf.constant(batch), mean, std)
        for k, res in residuals.items():
            assert tf.reduce_all(tf.math.is_finite(res)), (
                f"Non-finite residual {k} at h2_flow={h2_val}: {res.numpy()}"
            )

        # 2. Layer loss check
        x_tensor = tf.constant(batch, dtype=tf.float32)
        with tf.GradientTape() as tape:
            tape.watch(x_tensor)
            losses = layer.compute_individual_losses(x_tensor)
            total_loss = tf.add_n(list(losses.values()))

        assert tf.math.is_finite(total_loss), f"Non-finite loss at h2_flow={h2_val}"
        grad = tape.gradient(total_loss, x_tensor)
        assert grad is not None
        assert tf.reduce_all(tf.math.is_finite(grad)), (
            f"NaN or Inf gradient at h2_flow={h2_val}"
        )


def test_zero_and_negative_air_cooling_flow_stability():
    """Stress-test cathode air flow at 0, negative, and epsilon (energy balance divisor)."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std)

    adversarial_air_flows = [0.0, -1e-5, -100.0, 1e-10, 0.001]

    for air_val in adversarial_air_flows:
        batch = _create_nominal_batch(1)
        batch[..., 12] = air_val  # air_flow_kg_h

        residuals = compute_physics_residuals(tf.constant(batch), mean, std)
        r_energy = residuals["r_energy"]
        assert tf.reduce_all(tf.math.is_finite(r_energy)), (
            f"Non-finite r_energy at air_flow={air_val}: {r_energy.numpy()}"
        )

        x_tensor = tf.constant(batch, dtype=tf.float32)
        with tf.GradientTape() as tape:
            tape.watch(x_tensor)
            loss_dict = layer.compute_individual_losses(x_tensor)
            l_energy = loss_dict["r_energy"]

        assert tf.math.is_finite(l_energy), f"Non-finite l_energy at air_flow={air_val}"
        grad = tape.gradient(l_energy, x_tensor)
        assert grad is not None
        assert tf.reduce_all(tf.math.is_finite(grad)), (
            f"Non-finite gradient in energy loss at air_flow={air_val}"
        )


def test_q_expected_zero_and_negative_stability():
    """Stress-test energy balance when expected heat generation Q_exp <= 0."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std)

    # When current is zero but DC power is reported as high, Q_gen becomes strongly negative
    batch = _create_nominal_batch(1)
    batch[..., 3] = 0.0      # i_stack = 0 -> n_cons = 0 -> Q_gen = -p_dc
    batch[..., 5] = 200.0    # p_dc = 200 kW -> Q_gen = -200 kW -> Q_exp < 0

    residuals = compute_physics_residuals(tf.constant(batch), mean, std)
    assert tf.reduce_all(tf.math.is_finite(residuals["r_energy"]))

    x_tensor = tf.constant(batch, dtype=tf.float32)
    with tf.GradientTape() as tape:
        tape.watch(x_tensor)
        loss_dict = layer.compute_individual_losses(x_tensor)
        l_energy = loss_dict["r_energy"]

    assert tf.math.is_finite(l_energy)
    grad = tape.gradient(l_energy, x_tensor)
    assert tf.reduce_all(tf.math.is_finite(grad))


# ------------------------------------------------------------------ 2. Extreme Out-of-Distribution Inputs
def test_extreme_current_surges_and_negative_current():
    """Stress-test stack current at extreme bounds (-100 A, 0 A, 1000 A, 10000 A)."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std)

    currents = [-100.0, 0.0, 1000.0, 10000.0]

    for curr in currents:
        batch = _create_nominal_batch(1)
        batch[..., 3] = curr

        residuals = compute_physics_residuals(tf.constant(batch), mean, std)
        for k, res in residuals.items():
            assert tf.reduce_all(tf.math.is_finite(res)), (
                f"Residual {k} failed at current={curr}"
            )

        x_tensor = tf.constant(batch, dtype=tf.float32)
        with tf.GradientTape() as tape:
            tape.watch(x_tensor)
            losses = layer.compute_individual_losses(x_tensor)
            total = tf.add_n(list(losses.values()))

        assert tf.math.is_finite(total)
        grad = tape.gradient(total, x_tensor)
        assert tf.reduce_all(tf.math.is_finite(grad))


def test_extreme_thermal_excursions():
    """Stress-test cathode dT and temperatures under extreme thermal conditions."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std)

    # Negative dT (inlet hotter than outlet), 0 K, and severe 500 K thermal shock
    test_dTs = [-200.0, 0.0, 50.0, 100.0, 100.1, 500.0, 2000.0]

    for dt_val in test_dTs:
        batch = _create_nominal_batch(1)
        batch[..., 10] = dt_val

        residuals = compute_physics_residuals(tf.constant(batch), mean, std)
        assert tf.reduce_all(tf.math.is_finite(residuals["r_dT"]))

        x_tensor = tf.constant(batch, dtype=tf.float32)
        with tf.GradientTape() as tape:
            tape.watch(x_tensor)
            losses = layer.compute_individual_losses(x_tensor)
            l_dt = losses["r_dT"]

        assert tf.math.is_finite(l_dt)
        grad = tape.gradient(l_dt, x_tensor)
        assert tf.reduce_all(tf.math.is_finite(grad))


# ------------------------------------------------------------------ 3. Huber vs Quadratic vs Log1p Gradient Dynamics
def test_huber_gradient_strictly_bounded_under_massive_spikes():
    """Empirically compare Huber vs L2 vs log1p gradients across residual magnitude spikes [0.001 to 10000]."""
    test_residuals = [0.001, 0.1, 0.5, 1.0, 2.0, 10.0, 100.0, 1000.0, 10000.0]

    for r_val in test_residuals:
        r_tensor = tf.constant(r_val, dtype=tf.float32)

        # 1. Huber loss gradient: d/dr(Huber)
        with tf.GradientTape() as tape:
            tape.watch(r_tensor)
            l_huber = huber_loss(r_tensor, delta=1.0)
        grad_huber = float(tape.gradient(l_huber, r_tensor).numpy())

        # 2. Quadratic L2 loss gradient: d/dr(0.5 * r^2) = r
        with tf.GradientTape() as tape:
            tape.watch(r_tensor)
            l_l2 = 0.5 * tf.square(r_tensor)
        grad_l2 = float(tape.gradient(l_l2, r_tensor).numpy())

        # 3. Baseline log1p loss gradient: d/dr(log(1 + r^2)) = 2r / (1 + r^2)
        with tf.GradientTape() as tape:
            tape.watch(r_tensor)
            l_log = tf.math.log1p(tf.square(r_tensor))
        grad_log = float(tape.gradient(l_log, r_tensor).numpy())

        # Huber gradient contract: |grad| <= delta=1.0 everywhere
        assert abs(grad_huber) <= 1.0 + 1e-6, f"Huber gradient exceeded delta: {grad_huber}"

        if r_val <= 1.0:
            # Quadratic convergence regime: Huber grad == r
            assert np.isclose(grad_huber, r_val, atol=1e-5)
        else:
            # Linear robust regime: Huber grad strictly saturated at 1.0
            assert np.isclose(grad_huber, 1.0, atol=1e-5)

        # At massive spikes (r=1000, 10000), demonstrate L2 explosion and log1p vanishing
        if r_val >= 1000.0:
            assert grad_l2 >= 1000.0, f"L2 did not explode: {grad_l2}"
            assert grad_log < 0.003, f"Baseline log1p did not suffer vanishing gradient: {grad_log}"
            assert np.isclose(grad_huber, 1.0), "Huber failed to maintain bounded O(1) gradient"


# ------------------------------------------------------------------ 4. Asymmetric Softplus Inflection Boundaries
def test_softplus_barrier_inflection_continuity_and_direction():
    """Verify softplus barrier potential around exact inflection boundaries for Uf and dP."""
    # Fuel utilization boundary sweep across [0.70, 0.88] box and setpoint 0.80
    uf_values = [0.68, 0.69, 0.70, 0.71, 0.75, 0.79, 0.80, 0.81, 0.85, 0.87, 0.88, 0.89, 0.90]

    grads_uf = []
    losses_uf = []

    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std)

    for uf in uf_values:
        # Construct synthetic telemetry with current and H2 giving exact Uf
        # n_cons = i * 732 * 3600 / (2 * 96485)
        # f_h2 = h2 / 2.016
        # uf = n_cons / f_h2 -> h2 = n_cons * 2.016 / uf
        batch = _create_nominal_batch(1)
        i_stack = float(batch[0, 0, 3])
        n_cons = i_stack * C.N_SERIES * 3600.0 / (2.0 * C.FARADAY)
        h2_target = (n_cons * C.MW_H2) / uf
        batch[..., 11] = h2_target

        x_tensor = tf.constant(batch, dtype=tf.float32)
        with tf.GradientTape() as tape:
            tape.watch(x_tensor)
            losses = layer.compute_individual_losses(x_tensor)
            l_uf = losses["r_uf"]

        losses_uf.append(float(l_uf.numpy()))
        grad = tape.gradient(l_uf, x_tensor).numpy()
        # Gradient w.r.t H2 flow
        d_h2 = float(grad[0, 0, 11])
        grads_uf.append(d_h2)

    # 1. Loss at setpoint (0.80) should be near minimum
    idx_80 = uf_values.index(0.80)
    assert losses_uf[idx_80] < losses_uf[0]   # lower than Uf=0.68
    assert losses_uf[idx_80] < losses_uf[-1]  # lower than Uf=0.90

    # 2. Continuous progression (no discontinuous jumps in loss)
    diffs = np.diff(losses_uf)
    assert np.all(np.isfinite(diffs))
    assert np.max(np.abs(diffs)) < 10.0


def test_bidirectional_differential_pressure_boundaries():
    """Verify bidirectional differential pressure response across [-6 to +20 mbar]."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std)

    dp_grid = [-20.0, -10.0, -5.1, -5.0, -4.9, 0.0, 5.0, 10.0, 14.9, 15.0, 15.1, 20.0, 30.0]
    dp_losses = []
    dp_grads = []

    for dp in dp_grid:
        batch = _create_nominal_batch(1)
        batch[..., 15] = dp  # dp_an_ca_mbar

        x_tensor = tf.constant(batch, dtype=tf.float32)
        with tf.GradientTape() as tape:
            tape.watch(x_tensor)
            losses = layer.compute_individual_losses(x_tensor)
            l_dp = losses["r_dp"]

        dp_losses.append(float(l_dp.numpy()))
        grad = tape.gradient(l_dp, x_tensor).numpy()
        # Gradient w.r.t dp_an_ca_mbar (ch 15)
        g_dp_step = float(grad[0, 0, 15])
        g_dp_sum = float(np.sum(grad[0, :, 15]))
        dp_grads.append((g_dp_step, g_dp_sum))

    # At safe middle (5 mbar, midpoint of [-5, 15]), loss is at global minimum
    idx_5 = dp_grid.index(5.0)
    assert dp_losses[idx_5] < dp_losses[0]
    assert dp_losses[idx_5] < dp_losses[-1]
    assert np.isclose(dp_grads[idx_5][1], 0.0, atol=1e-5)

    # For severe seal lift-off (dp = -20 mbar), gradient w.r.t dp must be negative
    # (i.e. increasing dp decreases loss, restoring positive pressure)
    idx_lift = dp_grid.index(-20.0)
    assert dp_grads[idx_lift][0] < -0.01, (
        f"Expected negative restoring gradient step for seal lift-off, got {dp_grads[idx_lift][0]}"
    )
    assert dp_grads[idx_lift][1] < -0.1, (
        f"Expected negative restoring gradient sum for seal lift-off, got {dp_grads[idx_lift][1]}"
    )

    # For severe overpressure (dp = +30 mbar), gradient w.r.t dp must be positive
    # (i.e. decreasing dp decreases loss, relieving overpressure)
    idx_over = dp_grid.index(30.0)
    assert dp_grads[idx_over][0] > 0.01, (
        f"Expected positive restoring gradient step for overpressure, got {dp_grads[idx_over][0]}"
    )
    assert dp_grads[idx_over][1] > 0.1, (
        f"Expected positive restoring gradient sum for overpressure, got {dp_grads[idx_over][1]}"
    )



# ------------------------------------------------------------------ 5. End-to-End Model Backpropagation Under Adversarial Data
def test_end_to_end_model_backprop_under_adversarial_batch():
    """Verify optimized RTA-AE with EnhancedPhysicsPenalty updates cleanly on an adversarial batch."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)

    pinn_layer = EnhancedPhysicsPenalty(
        mean=mean,
        std=std,
        physics_weight=0.05,
        delta=1.0,
        beta=2.0,
    )
    model = build_optimized_ae(mean=mean, std=std, physics_layer=pinn_layer)
    optimizer = keras.optimizers.Adam(learning_rate=1e-3)

    # Create adversarial batch of 4 windows:
    # 0: nominal
    # 1: zero fuel flow
    # 2: 1000A current surge
    # 3: severe negative dp (-20 mbar)
    batch = np.repeat(_create_nominal_batch(1), 4, axis=0)
    batch[1, :, 11] = 0.0      # zero fuel
    batch[2, :, 3] = 1000.0    # 1000A surge
    batch[3, :, 15] = -20.0    # seal lift-off

    x_tf = tf.constant(batch, dtype=tf.float32)

    with tf.GradientTape() as tape:
        pred = model(x_tf, training=True)
        rec_loss = tf.reduce_mean(tf.square(pred - x_tf))
        # Total loss includes add_loss from pinn_layer
        total_loss = rec_loss + tf.add_n(model.losses)

    assert tf.math.is_finite(total_loss), f"Total loss is non-finite: {total_loss}"

    grads = tape.gradient(total_loss, model.trainable_weights)
    assert len(grads) == len(model.trainable_weights)

    for w, g in zip(model.trainable_weights, grads):
        assert g is not None, f"Gradient is None for {w.name}"
        assert tf.reduce_all(tf.math.is_finite(g)), f"NaN or Inf gradient in {w.name}"

    # Apply gradients and verify weights update without NaN
    optimizer.apply_gradients(zip(grads, model.trainable_weights))
    for w in model.trainable_weights:
        assert tf.reduce_all(tf.math.is_finite(w)), f"Weight {w.name} became NaN/Inf after step"


# ------------------------------------------------------------------ 6. Production Model Weights Immutability
def test_production_baseline_weights_immutability():
    """Assert production baseline files have identical SHA-256 hashes and byte lengths."""
    prod_dir = Path(__file__).resolve().parents[1] / "models" / "anomaly"
    w_bytes = (prod_dir / "ae_pinn.weights.h5").read_bytes()
    m_bytes = (prod_dir / "meta.json").read_bytes()

    assert len(w_bytes) == 573992
    assert len(m_bytes) == 3702

    assert hashlib.sha256(w_bytes).hexdigest() == "184e1862d3b3c6127b2479f16006bb39b0933da99c09d05ef908c8ebe1785f64"
    assert hashlib.sha256(m_bytes).hexdigest() == "dff786bc0ec1f39a678996cc35921924a0082fac78613584a8f9cdd63a60bec7"


# ------------------------------------------------------------------ 7. DWA Softmax Stability Under Severe Transients
def test_dwa_loss_trajectory_overflow_under_severe_spikes():
    """Stress-test DWA softmax numerical stability under severe 3000x transient spike."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)
    lp = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    lc_spike = [3000.0, 1.0, 1.0, 1.0, 1.0, 1.0]

    weights = cb.compute_weights(lp, lc_spike)
    assert np.all(np.isfinite(weights)), f"DWA produced non-finite weights under 3000x spike: {weights}"
    assert not np.any(np.isnan(weights)), f"DWA produced NaN weights: {weights}"

