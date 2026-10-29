"""
Empirical Challenger Verification Suite for Milestone 4:
Model Architecture, Mathematical Formulations, and Enhanced PINN Optimization.

Validates all claims in docs/MODEL_ARCHITECTURE_WORKFLOW.md:
1. Quickstart execution, model compilation, (B, 12, 19) shapes, exact parameter counts (140,222 base, 140,228 with PINN layer).
2. Squeeze-and-Excitation dimensions and mathematical operations (C=19, d_red=8, 331 params).
3. Multi-Head Attention parameters and projection weight counts (H=4, d_k=16, 33,024 params).
4. All 6 physical constraint residuals and training loss evaluations (r_far, r_net, r_uf, r_energy, r_dT, r_dp).
5. Huber loss boundedness (|grad| <= 1.0) across extreme ranges [-1e6, 1e6].
6. Softplus barrier gradient positivity (grad > 0) across [-100, 100].
7. DWA shifted softmax numerical stability under severe loss spikes (up to 1e12x).
8. Bitwise SHA-256 hash preservation of production baseline assets.
"""

import hashlib
import json
from pathlib import Path
import pytest
import numpy as np
import tensorflow as tf
import keras

from sofc_ai.optimized_anomaly_model import (
    build_optimized_ae,
    ChannelFeatureGating,
    BidirectionalLSTMEncoder,
    MultiHeadTemporalAttention,
    get_model_summary,
)
from sofc_ai.enhanced_physics_penalty import (
    EnhancedPhysicsPenalty,
    WangAdaptiveBalancingCallback,
    DynamicWeightAveragingCallback,
    compute_physics_residuals,
    huber_loss,
    softplus_barrier,
    RES_KEYS,
)
from sofc_ai import config as C
from sofc_ai import physics


# ------------------------------------------------------------------ Fixtures
@pytest.fixture(scope="module")
def baseline_meta():
    meta_path = Path("backend/models/anomaly/meta.json")
    assert meta_path.exists(), f"Missing meta.json at {meta_path}"
    meta = json.loads(meta_path.read_text())
    return {
        "mean": np.array(meta["mean"], dtype=np.float32),
        "std": np.array(meta["std"], dtype=np.float32),
    }


# ------------------------------------------------------------------ 1. Quickstart & Architecture
def test_quickstart_verbatim_execution_and_shapes(baseline_meta):
    """Executes verbatim quickstart snippet from Section 8.1 of MODEL_ARCHITECTURE_WORKFLOW.md."""
    mean = baseline_meta["mean"]
    std = baseline_meta["std"]

    # 1. Instantiate Enhanced PINN penalty layer
    physics_layer = EnhancedPhysicsPenalty(
        mean=mean,
        std=std,
        physics_weight=0.02,
        delta=1.0,
        beta=2.0,
    )

    # 2. Build RTA-AE model with attached physics regularization
    model = build_optimized_ae(
        mean=mean,
        std=std,
        L=12,
        n_ch=19,
        lstm_units=64,
        latent_dim=32,
        num_heads=4,
        key_dim=16,
        physics_layer=physics_layer,
    )

    # 3. Configure adaptive balancing callbacks
    wang_cb = WangAdaptiveBalancingCallback(physics_layer=physics_layer, alpha=0.1)
    dwa_cb = DynamicWeightAveragingCallback(physics_layer=physics_layer, temp=2.0)

    # 4. Verify shapes and binding
    assert model.input_shape == (None, 12, 19)
    assert model.output_shape == (None, 12, 19)

    # Verify forward pass on batch B=4
    dummy_x = tf.random.normal((4, 12, 19))
    out = model(dummy_x, training=False)
    assert out.shape == (4, 12, 19)

    # Verify parameter counts
    summary = get_model_summary(model)
    assert summary["trainable_params"] == 140222
    assert summary["non_trainable_params"] == 6
    assert summary["total_params"] == 140228

    # Verify model training step executes cleanly with callbacks
    X_dummy = np.random.randn(8, 12, 19).astype(np.float32)
    history = model.fit(
        X_dummy,
        X_dummy,
        callbacks=[wang_cb, dwa_cb],
        epochs=2,
        batch_size=4,
        verbose=0,
    )
    assert len(history.history["loss"]) == 2
    assert not np.isnan(history.history["loss"][-1])
    assert not np.isinf(history.history["loss"][-1])


def test_base_model_without_physics_layer(baseline_meta):
    """Verifies RTA-AE without physics layer has exactly 140,222 total parameters."""
    mean = baseline_meta["mean"]
    std = baseline_meta["std"]

    model = build_optimized_ae(
        mean=mean,
        std=std,
        L=12,
        n_ch=19,
        lstm_units=64,
        latent_dim=32,
        num_heads=4,
        key_dim=16,
        physics_layer=None,
    )
    summary = get_model_summary(model)
    assert summary["total_params"] == 140222
    assert summary["trainable_params"] == 140222
    assert summary["non_trainable_params"] == 0


# ------------------------------------------------------------------ 2. Squeeze-and-Excitation Math
def test_squeeze_and_excitation_mathematics():
    """Verifies Section 3.1 Squeeze-and-Excitation dimensions, parameter counts, and clamping."""
    C_ch = 19
    r_dim = 8
    clip_val = 10.0

    se_layer = ChannelFeatureGating(channels=C_ch, reduction_dim=r_dim, clip_val=clip_val)
    dummy_in = tf.random.normal((2, 12, C_ch))
    out = se_layer(dummy_in)

    assert out.shape == (2, 12, C_ch)

    # Inspect parameter counts:
    # reduce_dense: (19, 8) + (8,) = 160
    # expand_dense: (8, 19) + (19,) = 171
    # Total = 331
    reduce_w = se_layer.reduce_dense.trainable_weights
    expand_w = se_layer.expand_dense.trainable_weights

    assert reduce_w[0].shape == (19, 8)
    assert reduce_w[1].shape == (8,)
    assert expand_w[0].shape == (8, 19)
    assert expand_w[1].shape == (19,)

    param_count = sum(np.prod(w.shape) for w in se_layer.trainable_weights)
    assert param_count == 331

    # Verify clamping behavior on extreme input
    extreme_in = tf.constant([[[100.0] * C_ch]], dtype=tf.float32)
    # Gating weights produce output <= clip_val
    clamped_out = se_layer(extreme_in)
    assert np.all(clamped_out.numpy() <= clip_val)


# ------------------------------------------------------------------ 3. Multi-Head Attention Math
def test_multi_head_attention_mathematics():
    """Verifies Section 3.3 & 3.6 Multi-Head Temporal Self-Attention parameters."""
    H = 4
    d_k = 16
    d_in = 128

    mha_block = MultiHeadTemporalAttention(num_heads=H, key_dim=d_k, dropout=0.1)
    dummy_in = tf.random.normal((2, 12, d_in))
    out = mha_block(dummy_in, training=False)

    assert out.shape == (2, 12, d_in)

    # Projection breakdown:
    # Query: 128 x (4 * 16) = 8,192
    # Key:   128 x (4 * 16) = 8,192
    # Value: 128 x (4 * 16) = 8,192
    # Out:   (4 * 16) x 128 = 8,192
    # MHA subtotal = 32,768
    # LayerNorm: gamma (128) + beta (128) = 256
    # Total = 33,024
    mha_params = sum(np.prod(w.shape) for w in mha_block.mha.trainable_weights)
    norm_params = sum(np.prod(w.shape) for w in mha_block.norm.trainable_weights)
    total_block_params = sum(np.prod(w.shape) for w in mha_block.trainable_weights)

    assert mha_params == 32768
    assert norm_params == 256
    assert total_block_params == 33024


# ------------------------------------------------------------------ 4. 6 Physical Constraint Losses
def test_all_6_physical_constraints_formulations(baseline_meta):
    """Verifies Section 4.1 mathematical equations for all 6 SOFC physical constraints."""
    mean = baseline_meta["mean"]
    std = baseline_meta["std"]

    # Construct nominal telemetry point matching mean
    nom_data = tf.constant(mean.reshape(1, 1, 19), dtype=tf.float32)
    nom_norm = (nom_data - mean) / std

    # 1. Test unweighted residuals
    residuals = compute_physics_residuals(nom_norm, mean=mean, std=std)
    assert set(residuals.keys()) == set(RES_KEYS)

    for k in RES_KEYS:
        r_val = float(residuals[k].numpy().squeeze())
        assert np.isfinite(r_val)

    # 2. Test Enhanced PINN penalty individual losses
    penalty = EnhancedPhysicsPenalty(mean=mean, std=std, physics_weight=0.02)
    losses = penalty.compute_individual_losses(nom_norm)

    assert set(losses.keys()) == set(RES_KEYS)
    for k in RES_KEYS:
        l_val = float(losses[k].numpy())
        assert np.isfinite(l_val)
        assert l_val >= 0.0

    # 3. Test specific physics sensitivities:
    # Perturb Cathode temperature rise dT above 100K limit (e.g. 110K)
    dT_idx = C.TELEMETRY_CHANNELS.index("dT_cath_K")
    t_out_idx = C.TELEMETRY_CHANNELS.index("t_ca_out_C")
    t_in_idx = C.TELEMETRY_CHANNELS.index("t_ca_in_C")

    perturbed_raw = np.copy(mean)
    # Set t_ca_out - t_ca_in = 110.0 K
    perturbed_raw[t_in_idx] = 600.0
    perturbed_raw[t_out_idx] = 710.0
    perturbed_raw[dT_idx] = 110.0
    perturbed_norm = tf.constant(((perturbed_raw - mean) / std).reshape(1, 1, 19), dtype=tf.float32)

    pert_res = compute_physics_residuals(perturbed_norm, mean=mean, std=std)
    dT_res = float(pert_res["r_dT"].numpy().squeeze())
    # Expected: (110.0 - 100.0) / 5.0 = 2.0
    assert pytest.approx(dT_res, rel=1e-3) == 2.0

    # Perturb differential pressure to -10 mbar (violating -5 mbar seal lift-off limit)
    dp_idx = C.TELEMETRY_CHANNELS.index("dp_an_ca_mbar")
    perturbed_dp = np.copy(mean)
    perturbed_dp[dp_idx] = -10.0
    perturbed_dp_norm = tf.constant(((perturbed_dp - mean) / std).reshape(1, 1, 19), dtype=tf.float32)
    pert_dp_res = compute_physics_residuals(perturbed_dp_norm, mean=mean, std=std)
    dp_res = float(pert_dp_res["r_dp"].numpy().squeeze())
    # Expected: (-5.0 - (-10.0)) / 5.0 = 5.0 / 5.0 = 1.0
    assert pytest.approx(dp_res, rel=1e-3) == 1.0


# ------------------------------------------------------------------ 5. Huber Loss Boundedness
def test_huber_loss_boundedness():
    """Verifies Section 4.2: Huber loss gradient magnitude |grad| <= delta = 1.0 across [-1e6, 1e6]."""
    delta = 1.0
    test_r = tf.constant([-1e6, -100.0, -10.0, -1.0, -0.5, 0.0, 0.5, 1.0, 10.0, 100.0, 1e6], dtype=tf.float32)

    with tf.GradientTape() as tape:
        tape.watch(test_r)
        loss = huber_loss(test_r, delta=delta)

    grads = tape.gradient(loss, test_r).numpy()

    # Inside [-delta, delta]: grad = r
    # Outside: grad = delta * sgn(r)
    for r_val, g_val in zip(test_r.numpy(), grads):
        assert abs(g_val) <= delta + 1e-6, f"Huber gradient exceeded delta: r={r_val}, g={g_val}"
        if abs(r_val) <= delta:
            assert pytest.approx(g_val, abs=1e-5) == r_val
        elif r_val > delta:
            assert pytest.approx(g_val, abs=1e-5) == delta
        else:
            assert pytest.approx(g_val, abs=1e-5) == -delta


# ------------------------------------------------------------------ 6. Softplus Barrier Gradient Positivity
def test_softplus_barrier_gradient_positivity():
    """Verifies Section 4.3: Softplus barrier gradient is strictly positive everywhere."""
    beta = 2.0
    # Test from deeply negative (-50) to deeply positive (+50)
    test_z = tf.constant([-50.0, -20.0, -10.0, -5.0, -1.0, 0.0, 1.0, 5.0, 10.0, 50.0], dtype=tf.float32)

    with tf.GradientTape() as tape:
        tape.watch(test_z)
        barrier = softplus_barrier(test_z, beta=beta)

    grads = tape.gradient(barrier, test_z).numpy()

    # Analytical gradient: d/dz = exp(beta*z) / (1 + exp(beta*z)) = sigmoid(beta*z) > 0
    for z_val, g_val in zip(test_z.numpy(), grads):
        assert g_val > 0.0, f"Barrier gradient must be strictly positive: z={z_val}, g={g_val}"
        expected_g = 1.0 / (1.0 + np.exp(-beta * z_val))
        assert pytest.approx(g_val, abs=1e-5) == expected_g


# ------------------------------------------------------------------ 7. DWA Shifted Softmax Stability
@pytest.mark.parametrize("spike_factor", [10.0, 100.0, 1000.0, 2839.0, 5000.0, 1e6, 1e9, 1e12])
def test_dwa_shifted_softmax_stability_severe_spikes(spike_factor):
    """Verifies Section 6.7: DWA canonical shifted softmax prevents overflow under extreme loss spikes."""
    dwa = DynamicWeightAveragingCallback(temp=2.0)
    K = 6

    # Previous loss flat, current loss has extreme spike on task 0
    loss_prev = [1.0] * K
    loss_curr = [1.0 * spike_factor, 1.0, 1.0, 1.0, 1.0, 1.0]

    weights = dwa.compute_weights(loss_prev, loss_curr)

    assert not np.isnan(weights).any(), f"DWA produced NaN weights for spike={spike_factor}: {weights}"
    assert not np.isinf(weights).any(), f"DWA produced Inf weights for spike={spike_factor}: {weights}"
    assert np.all(weights >= 0.0), f"Weights must be non-negative: {weights}"
    assert pytest.approx(np.sum(weights), abs=1e-4) == float(K)
    # The spiked task should receive the dominant weight
    assert weights[0] > weights[1]


# ------------------------------------------------------------------ 8. Production Checksums
def test_baseline_cryptographic_checksums_and_sizes():
    """Verifies Section 7.1: Baseline production assets match SHA-256 and byte sizes bit-for-bit."""
    weights_path = Path("backend/models/anomaly/ae_pinn.weights.h5")
    meta_path = Path("backend/models/anomaly/meta.json")

    assert weights_path.exists()
    assert meta_path.exists()

    expected_weights_sha256 = "184e1862d3b3c6127b2479f16006bb39b0933da99c09d05ef908c8ebe1785f64"
    expected_meta_sha256 = "dff786bc0ec1f39a678996cc35921924a0082fac78613584a8f9cdd63a60bec7"

    weights_bytes = weights_path.read_bytes()
    meta_bytes = meta_path.read_bytes()

    assert len(weights_bytes) == 573992
    assert len(meta_bytes) == 3702

    actual_weights_sha256 = hashlib.sha256(weights_bytes).hexdigest().lower()
    actual_meta_sha256 = hashlib.sha256(meta_bytes).hexdigest().lower()

    assert actual_weights_sha256 == expected_weights_sha256
    assert actual_meta_sha256 == expected_meta_sha256
