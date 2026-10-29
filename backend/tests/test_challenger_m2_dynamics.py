"""
Empirical Challenger Test Suite for Milestone 2:
Adaptive Loss Dynamics, Wang Gradient Norms, DWA Trajectories, and Convergence.

Authored by: m2_dl_challenger_2 (teamwork_challenger)
Purpose: Adversarially stress-test assumptions, verify gradient stability,
         boundary condition resilience, convergence, and serialization fidelity.
"""

import hashlib
from pathlib import Path
import tempfile

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
from sofc_ai import plant


@pytest.fixture(scope="module")
def nominal_stats():
    """Nominal SOFC mean and standard deviation vectors across 19 channels."""
    op = plant.operating_point(1.0, 30.0)
    mean = np.array([
        float(op["t_amb_C"]), 0.60, float(op["load"]), float(op["i_stack_A"]),
        float(op["v_cell_V"]), float(op["p_dc_kW"]), float(op["p_net_kW"]),
        float(op["t_an_in_C"]), float(op["t_ca_in_C"]), float(op["t_ca_out_C"]),
        float(op["dT_cath_K"]), float(op["h2_flow_kg_h"]), float(op["air_flow_kg_h"]),
        float(op["recycle_flow_kmol_h"]), float(op["steam_flow_kg_h"]),
        float(op["dp_an_ca_mbar"]), float(op["p_blower_kW"]),
        float(op["t_afterburner_C"]), float(op["t_flue_out_C"]),
    ], dtype=np.float32)
    std = np.array([
        5.0, 0.1, 0.2, 20.0, 0.05, 10.0, 10.0,
        15.0, 15.0, 15.0, 10.0, 0.5, 50.0,
        0.5, 2.0, 3.0, 1.0, 20.0, 20.0,
    ], dtype=np.float32)
    return mean, std


def _create_synthetic_batch(mean, std, batch_size=16, noise_scale=0.05, rng=None):
    """Creates a synthetic normalized telemetry batch with realistic physics."""
    if rng is None:
        rng = np.random.default_rng(42)
    raw = np.tile(mean, (batch_size, L_WIN, 1))
    noise = rng.normal(0, noise_scale, size=raw.shape).astype(np.float32)
    raw += noise * std
    norm = (raw - mean) / std
    return tf.constant(norm, dtype=tf.float32)


# =====================================================================
# CHALLENGE 1: Wang et al. Gradient Norms Under Pathological Inputs
# =====================================================================
def test_challenge_wang_gradient_norms_under_pathological_inputs(nominal_stats):
    """Stress test Wang balancing gradient computation under pathological data conditions."""
    mean, std = nominal_stats
    layer = EnhancedPhysicsPenalty(mean=mean, std=std, adaptive=True)
    model = build_optimized_ae(mean=mean, std=std, physics_layer=layer)

    cb = WangAdaptiveBalancingCallback(penalty_layer=layer, model=model, alpha=0.2)

    # Scenario A: Streaming batch (B=1)
    x_single = _create_synthetic_batch(mean, std, batch_size=1)
    cb.update_weights(x_single)
    for k in RES_KEYS:
        val = layer.get_lambda(k)
        assert np.isfinite(val), f"B=1 produced non-finite lambda {k}: {val}"
        assert 1e-4 <= val <= 50.0, f"B=1 lambda {k} out of range: {val}"

    # Scenario B: Large batch (B=64)
    x_large = _create_synthetic_batch(mean, std, batch_size=64)
    cb.update_weights(x_large)
    for k in RES_KEYS:
        val = layer.get_lambda(k)
        assert np.isfinite(val), f"B=64 produced non-finite lambda {k}: {val}"
        assert 1e-4 <= val <= 50.0

    # Scenario C: Severe zero-residual input (perfect match: g_k -> 0)
    # Target weight should safely clamp to max_weight without dividing by zero
    g_rec = 0.5
    g_k_zero = 0.0
    w_target = cb.compute_target_weight(g_rec, g_k_zero)
    assert np.isclose(w_target, 50.0), f"Expected max_weight 50.0 on zero gradient, got {w_target}"

    # Scenario D: Huge dominating physics gradient (g_k -> 10^5)
    # Target weight should safely clamp to min_weight without underflowing
    g_k_huge = 1e5
    w_target_low = cb.compute_target_weight(g_rec, g_k_huge)
    assert np.isclose(w_target_low, 1e-4), f"Expected min_weight 1e-4 on huge gradient, got {w_target_low}"


# =====================================================================
# CHALLENGE 2: Wang Dynamic Balancing Directional Adaptation
# =====================================================================
def test_challenge_wang_directional_adaptation_dynamics(nominal_stats):
    """Empirically verify that lambda weights adapt in the physically and mathematically correct direction."""
    mean, std = nominal_stats
    layer = EnhancedPhysicsPenalty(mean=mean, std=std, adaptive=True)
    model = build_optimized_ae(mean=mean, std=std, physics_layer=layer)

    cb = WangAdaptiveBalancingCallback(
        penalty_layer=layer,
        model=model,
        alpha=0.5, # Aggressive EMA to observe adaptation quickly
        min_weight=1e-4,
        max_weight=50.0,
    )

    rng = np.random.default_rng(42)
    raw_noisy = np.tile(mean, (8, L_WIN, 1)) + rng.normal(0, 0.03, size=(8, L_WIN, 19)) * std
    x_norm = tf.constant((raw_noisy - mean) / std, dtype=tf.float32)

    init_lambdas = layer.get_weights_dict()
    assert all(np.isclose(v, 1.0) for v in init_lambdas.values())

    # Run 5 consecutive Wang update steps on realistic noisy telemetry
    for _ in range(5):
        cb.update_weights(x_norm)

    adapted_lambdas = layer.get_weights_dict()

    # 1. Faraday constraint has large coupling (i_stack * v_cell * 732) and dominates
    # Wang must throttle lambda_far downward from 1.0
    assert adapted_lambdas["r_far"] < 0.2, (
        f"Wang failed to downweight dominating Faraday penalty: {adapted_lambdas['r_far']}"
    )

    # 2. Differential pressure constraint is well inside safe operating margin (-5 to 15 mbar)
    # Its gradient is vanishing, so Wang must boost lambda_dp upward from initial 1.0 (towards clamping ceiling)
    assert adapted_lambdas["r_dp"] > 5.0, (
        f"Wang failed to boost vanishing differential pressure penalty: {adapted_lambdas['r_dp']}"
    )

    # 3. All lambdas remain within theoretical clamping bounds
    for k, v in adapted_lambdas.items():
        assert 1e-4 <= v <= 50.0, f"Lambda {k} violated bounds: {v}"


# =====================================================================
# CHALLENGE 3: Probe Modes (Output vs All Trainable Weights)
# =====================================================================
def test_challenge_wang_probe_modes(nominal_stats):
    """Verify Wang balancing operates reliably with both probe='output' and probe='all'."""
    mean, std = nominal_stats
    layer = EnhancedPhysicsPenalty(mean=mean, std=std, adaptive=True)
    model = build_optimized_ae(mean=mean, std=std, physics_layer=layer)

    x_batch = _create_synthetic_batch(mean, std, batch_size=8)

    # Mode 1: Probe = "output" (last reconstruction Dense layer)
    cb_output = WangAdaptiveBalancingCallback(penalty_layer=layer, model=model, probe="output")
    target_vars_out = cb_output._get_target_weights()
    assert len(target_vars_out) == 2 # Kernel and bias of 'reconstruction'
    cb_output.update_weights(x_batch)
    weights_out = layer.get_weights_dict()
    assert all(np.isfinite(v) for v in weights_out.values())

    # Mode 2: Probe = "all" (all 34 trainable variables of RTA-AE)
    cb_all = WangAdaptiveBalancingCallback(penalty_layer=layer, model=model, probe="all")
    target_vars_all = cb_all._get_target_weights()
    assert len(target_vars_all) == 34 # All trainable weights
    cb_all.update_weights(x_batch)
    weights_all = layer.get_weights_dict()
    assert all(np.isfinite(v) for v in weights_all.values())


# =====================================================================
# CHALLENGE 4: DWA Mathematical Invariants and Overflow Detection
# =====================================================================
def test_challenge_dwa_mathematical_invariants():
    """Verify DWA normalization invariant and temperature scaling on regular inputs."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)

    # Invariant 1: Sum of weights equals K across arbitrary positive loss pairs
    l_prev = np.array([1.0, 2.0, 1.5, 0.8, 1.2, 3.0])
    l_curr = np.array([0.9, 1.5, 1.4, 0.7, 1.0, 2.2])
    weights = cb.compute_weights(l_prev, l_curr)
    assert len(weights) == 6
    assert np.isclose(np.sum(weights), 6.0, atol=1e-5), f"Sum violated: {np.sum(weights)}"
    assert all(w > 0 for w in weights), f"Non-positive DWA weight: {weights}"

    # Invariant 2: High Temperature (T -> 100) approaches uniform weights (1.0 each)
    cb_high_t = DynamicWeightAveragingCallback(num_tasks=6, temp=100.0)
    w_uniform = cb_high_t.compute_weights(l_prev, l_curr)
    for w in w_uniform:
        assert np.isclose(w, 1.0, atol=0.05), f"Expected near-uniform 1.0 at T=100, got {w}"

    # Invariant 3: Low Temperature (T -> 0.2) concentrates weight on slowest descending task
    cb_low_t = DynamicWeightAveragingCallback(num_tasks=6, temp=0.2)
    # Task 2 (1.4 / 1.5 = 0.933) descended slowest among tasks with similar scale
    l_slow = np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    l_fast = np.array([0.2, 0.2, 1.2, 0.2, 0.2, 0.2]) # Task 2 diverged (+20%) while others dropped 80%
    w_sharp = cb_low_t.compute_weights(l_slow, l_fast)
    assert np.argmax(w_sharp) == 2, f"Expected task 2 to receive max weight, got {np.argmax(w_sharp)}"
    assert w_sharp[2] > 4.0, f"Expected concentrated weight on diverging task, got {w_sharp[2]}"


def test_challenge_dwa_overflow_vulnerability_reproduction():
    """Empirically reproduce the DWA softmax overflow vulnerability when an inequality constraint has near-zero initial loss."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)

    # When constraint begins near zero (e.g. 2.2e-18 for safe cathode dT or differential pressure)
    # and has a mild excursion (0.01) in the subsequent epoch:
    loss_ep1 = np.array([0.48, 3.17, 2810.0, 11.0, 2.2e-18, 0.057])
    loss_ep2 = np.array([0.63, 2.92,  997.0, 12.4, 0.01,   0.058])

    weights = cb.compute_weights(loss_ep1, loss_ep2)
    
    # Check whether the implementation produces NaN due to overflow
    has_nan = any(np.isnan(w) for w in weights)
    assert not has_nan, f"Expected finite DWA weights, got NaN: {weights}"
    assert np.all(np.isfinite(weights)), f"Non-finite weights produced: {weights}"


# =====================================================================
# CHALLENGE 5: Training Step Convergence and Multi-Epoch Loss Decline
# =====================================================================
def test_challenge_training_convergence_over_multiple_epochs(nominal_stats):
    """Empirically test that model with EnhancedPhysicsPenalty converges and loss decreases over 6 epochs."""
    mean, std = nominal_stats
    layer = EnhancedPhysicsPenalty(mean=mean, std=std, adaptive=True, physics_weight=0.05)
    model = build_optimized_ae(mean=mean, std=std, physics_layer=layer)
    model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mse")

    # Generate synthetic training set: 64 windows of 12 steps x 19 channels
    rng = np.random.default_rng(123)
    x_train = _create_synthetic_batch(mean, std, batch_size=64, noise_scale=0.03, rng=rng).numpy()

    wang_cb = WangAdaptiveBalancingCallback(penalty_layer=layer, model=model, alpha=0.1, update_freq="epoch")

    history = model.fit(
        x_train,
        x_train,
        epochs=6,
        batch_size=16,
        callbacks=[wang_cb],
        verbose=0,
    )

    losses = history.history["loss"]
    assert len(losses) == 6
    # Assert all losses are finite
    assert all(np.isfinite(loss) for loss in losses), f"Non-finite loss found: {losses}"

    # Assert loss at epoch 6 is significantly lower than epoch 1 (convergence)
    assert losses[-1] < losses[0], f"Loss failed to decline: start={losses[0]:.6f}, end={losses[-1]:.6f}"
    pct_reduction = (losses[0] - losses[-1]) / losses[0] * 100.0
    assert pct_reduction > 15.0, f"Loss reduction {pct_reduction:.1f}% below 15% threshold"

    # Verify all metric trackers produced valid non-negative numbers
    for k in RES_KEYS:
        assert f"loss_{k}" in history.history, f"Tracker loss_{k} missing from training history"
        track_vals = history.history[f"loss_{k}"]
        assert all(np.isfinite(v) and v >= 0.0 for v in track_vals)

    # Verify lambda weights remained bounded and finite
    weights_end = layer.get_weights_dict()
    for k in RES_KEYS:
        assert 1e-4 <= weights_end[k] <= 50.0, f"Final weight {k} out of bounds: {weights_end[k]}"


# =====================================================================
# CHALLENGE 6: Keras Serialization Round-Trip Preservation of Adapted Lambdas
# =====================================================================
def test_challenge_serialization_preserves_adapted_lambdas(nominal_stats):
    """Verify saving and reloading preserves non-default adapted lambda weights exactly."""
    mean, std = nominal_stats
    layer = EnhancedPhysicsPenalty(mean=mean, std=std, adaptive=True)
    model = build_optimized_ae(mean=mean, std=std, physics_layer=layer)

    # Set non-trivial, non-default lambda weights
    custom_lambdas = {
        "r_far": 3.75,
        "r_net": 0.42,
        "r_uf": 0.08,
        "r_energy": 12.5,
        "r_dT": 7.3,
        "r_dp": 1.95,
    }
    layer.set_weights_dict(custom_lambdas)

    # Verify weights were assigned
    for k, v in custom_lambdas.items():
        assert np.isclose(layer.get_lambda(k), v, atol=1e-5)

    x_dummy = _create_synthetic_batch(mean, std, batch_size=4).numpy()
    pred_orig = model.predict(x_dummy, verbose=0)

    with tempfile.TemporaryDirectory() as tmp_dir:
        save_path = Path(tmp_dir) / "adapted_pinn_model.keras"
        model.save(save_path)
        assert save_path.exists()

        loaded_model = keras.models.load_model(save_path)

        # 1. Prediction fidelity
        pred_loaded = loaded_model.predict(x_dummy, verbose=0)
        np.testing.assert_allclose(pred_orig, pred_loaded, atol=1e-5)

        # 2. Extract physics layer from loaded model and verify lambda preservation
        loaded_pinn = None
        for l in loaded_model.layers:
            if isinstance(l, EnhancedPhysicsPenalty):
                loaded_pinn = l
                break

        assert loaded_pinn is not None, "EnhancedPhysicsPenalty layer missing in loaded model"
        loaded_weights = loaded_pinn.get_weights_dict()
        for k, v in custom_lambdas.items():
            assert np.isclose(loaded_weights[k], v, atol=1e-4), (
                f"Lambda {k} not preserved across serialization: saved {v}, loaded {loaded_weights[k]}"
            )

        # 3. Train one step on loaded model to verify graph continuity
        loaded_model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mse")
        hist = loaded_model.fit(x_dummy, x_dummy, epochs=1, verbose=0)
        assert np.isfinite(hist.history["loss"][0])


# =====================================================================
# CHALLENGE 7: Physics Residuals Extreme Boundary Condition Stress
# =====================================================================
def test_challenge_physics_residuals_extreme_boundaries(nominal_stats):
    """Stress test compute_physics_residuals across 12 extreme pathological boundary states."""
    mean, std = nominal_stats

    # Baseline operating point
    op = plant.operating_point(1.0, 30.0)
    base_raw = np.zeros((1, 12, 19), dtype=np.float32)
    for c_i, ch_name in enumerate(CH):
        if ch_name in op:
            base_raw[..., c_i] = float(op[ch_name])
    base_raw[..., 1] = 0.60
    base_raw[..., 14] = float(op["steam_flow_kg_h"])

    scenarios = [
        ("Zero H2 flow", 11, 0.0),
        ("Negative H2 flow", 11, -5.0),
        ("Zero air flow", 12, 0.0),
        ("Negative air flow", 12, -100.0),
        ("Zero stack current", 3, 0.0),
        ("Zero cell voltage", 4, 0.0),
        ("Zero recycle flow", 13, 0.0),
        ("Negative blower power", 16, -50.0),
        ("Extreme overpressure +100 mbar", 15, 100.0),
        ("Extreme negative pressure -100 mbar", 15, -100.0),
        ("Extreme cathode dT 500 K", 10, 500.0),
        ("Negative cathode dT -50 K", 10, -50.0),
    ]

    for name, ch_idx, value in scenarios:
        test_raw = base_raw.copy()
        test_raw[..., ch_idx] = value
        norm_tensor = tf.constant((test_raw - mean) / std, dtype=tf.float32)

        residuals = compute_physics_residuals(norm_tensor, mean, std)
        assert set(residuals.keys()) == set(RES_KEYS)

        for k, res in residuals.items():
            res_val = res.numpy()
            assert not np.any(np.isnan(res_val)), f"Scenario '{name}' produced NaN in {k}"
            assert not np.any(np.isinf(res_val)), f"Scenario '{name}' produced Inf in {k}"


# =====================================================================
# CHALLENGE 8: Cryptographic Production Baseline File Immutability
# =====================================================================
def test_challenge_cryptographic_baseline_immutability():
    """Independent verification that production baseline model weights and meta are 100% untouched."""
    prod_dir = Path(__file__).resolve().parents[1] / "models" / "anomaly"
    w_path = prod_dir / "ae_pinn.weights.h5"
    m_path = prod_dir / "meta.json"

    assert w_path.exists(), f"Production file missing: {w_path}"
    assert m_path.exists(), f"Production file missing: {m_path}"

    w_bytes = w_path.read_bytes()
    m_bytes = m_path.read_bytes()

    assert len(w_bytes) == 573992, f"Production weights byte size altered: {len(w_bytes)}"
    assert len(m_bytes) == 3702, f"Production meta byte size altered: {len(m_bytes)}"

    w_hash = hashlib.sha256(w_bytes).hexdigest()
    m_hash = hashlib.sha256(m_bytes).hexdigest()

    assert w_hash == "184e1862d3b3c6127b2479f16006bb39b0933da99c09d05ef908c8ebe1785f64", (
        f"Production weights SHA-256 corrupted: {w_hash}"
    )
    assert m_hash == "dff786bc0ec1f39a678996cc35921924a0082fac78613584a8f9cdd63a60bec7", (
        f"Production meta SHA-256 corrupted: {m_hash}"
    )
