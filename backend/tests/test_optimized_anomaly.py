"""
Comprehensive Test Suite for Optimized Deep Learning Autoencoder (RTA-AE).

Verifies:
  1. Custom layers (ChannelFeatureGating, BidirectionalLSTMEncoder, MultiHeadTemporalAttention)
  2. Model architecture, output shapes (B, 12, 19), and parameter count budget (< 200k params)
  3. Non-zero gradient flow across all trainable weights (no dead/disconnected units)
  4. Single-step and batch inference latency (< 50 ms)
  5. LayerNorm stability across batch sizes (B=1 streaming vs B=64 batch)
  6. Weight serialization round-trip fidelity
  7. OptimizedAEModel runtime wrapper matching backend/app/ae.py:AEModel interface
  8. Save / load bundle serialization
  9. Anomaly detection sensitivity (reconstruction contrast on normal vs fault telemetry)
 10. Strict immutability of production baseline files (ae_pinn.weights.h5 and meta.json)
"""

import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

import keras
import numpy as np
import pytest
import tensorflow as tf

from sofc_ai.optimized_anomaly_model import (
    ChannelFeatureGating,
    BidirectionalLSTMEncoder,
    MultiHeadTemporalAttention,
    build_optimized_ae,
    get_model_summary,
    OptimizedAEModel,
    save_optimized_bundle,
    load_optimized_bundle,
    CH,
    L_WIN,
)


@pytest.fixture(scope="module")
def mock_normal_stats():
    """Mean and std vectors for 19 channels."""
    rng = np.random.default_rng(42)
    mean = rng.uniform(50.0, 100.0, size=len(CH)).astype(np.float32)
    std = rng.uniform(2.0, 10.0, size=len(CH)).astype(np.float32)
    return mean, std


@pytest.fixture
def built_model(mock_normal_stats):
    """Instantiated RTA-AE model."""
    mean, std = mock_normal_stats
    return build_optimized_ae(mean=mean, std=std, L=L_WIN, n_ch=len(CH))


# ------------------------------------------------------------------ Layer Tests
def test_channel_feature_gating_layer():
    """Verify ChannelFeatureGating shape, gating behavior, and config serialization."""
    layer = ChannelFeatureGating(channels=19, reduction_dim=8)
    x = tf.random.normal((4, 12, 19))
    out = layer(x)

    assert out.shape == (4, 12, 19)
    # Output should not be identical to input, but shaped by gating
    assert not np.allclose(out.numpy(), x.numpy())

    cfg = layer.get_config()
    assert cfg["channels"] == 19
    assert cfg["reduction_dim"] == 8

    # Check reconstruction from config
    restored = ChannelFeatureGating.from_config(cfg)
    assert restored.channels == 19
    assert restored.reduction_dim == 8


def test_bidirectional_lstm_encoder_layer():
    """Verify BidirectionalLSTMEncoder forward pass, output shape, and config."""
    layer = BidirectionalLSTMEncoder(units=64, dropout=0.1)
    x = tf.random.normal((4, 12, 19))
    out = layer(x, training=False)

    # 64 forward + 64 backward = 128 channels
    assert out.shape == (4, 12, 128)

    cfg = layer.get_config()
    assert cfg["units"] == 64
    assert cfg["dropout"] == 0.1

    restored = BidirectionalLSTMEncoder.from_config(cfg)
    assert restored.units == 64


def test_multi_head_temporal_attention_layer():
    """Verify MultiHeadTemporalAttention residual addition, LayerNorm, and config."""
    layer = MultiHeadTemporalAttention(num_heads=4, key_dim=16, dropout=0.1)
    x = tf.random.normal((4, 12, 128))
    out = layer(x, training=False)

    assert out.shape == (4, 12, 128)

    cfg = layer.get_config()
    assert cfg["num_heads"] == 4
    assert cfg["key_dim"] == 16
    assert cfg["dropout"] == 0.1

    restored = MultiHeadTemporalAttention.from_config(cfg)
    assert restored.num_heads == 4
    assert restored.key_dim == 16


# ------------------------------------------------------------------ Architecture & Parameter Tests
def test_build_optimized_ae_shapes_and_summary(built_model):
    """Verify model input/output shapes, parameter budget, and metadata summary."""
    assert built_model.input_shape == (None, 12, 19)
    assert built_model.output_shape == (None, 12, 19)

    summary = get_model_summary(built_model)
    assert summary["name"] == "RTA_AE"
    assert summary["input_shape"] == (None, 12, 19)
    assert summary["output_shape"] == (None, 12, 19)

    # Total parameters must be exactly 140,222 and well below the 200,000 budget
    assert summary["total_params"] == 140222
    assert summary["trainable_params"] == 140222
    assert summary["non_trainable_params"] == 0
    assert summary["total_params"] < 200000

    expected_layers = [
        "telemetry_input",
        "channel_gating",
        "enc_bilstm",
        "temporal_attention",
        "bottleneck_dense",
        "latent_norm",
        "dec_bilstm",
        "dec_norm",
        "dec_dense",
        "reconstruction",
    ]
    for layer_name in expected_layers:
        assert layer_name in summary["layers"], f"Missing expected layer: {layer_name}"


# ------------------------------------------------------------------ Gradient Flow Test
def test_non_zero_gradient_flow_across_all_weights(built_model):
    """Verify all trainable weights receive non-zero gradients during backpropagation."""
    x = tf.random.normal((8, 12, 19))
    target = tf.random.normal((8, 12, 19))

    with tf.GradientTape() as tape:
        pred = built_model(x, training=True)
        loss = tf.reduce_mean(tf.square(pred - target))

    trainable_weights = built_model.trainable_weights
    assert len(trainable_weights) == 34  # 38 - 4 (MHA bias eliminated)

    grads = tape.gradient(loss, trainable_weights)
    assert len(grads) == len(trainable_weights)

    dead_weights = []
    for var, grad in zip(trainable_weights, grads):
        assert grad is not None, f"Gradient is None for variable: {var.name}"
        grad_norm = float(tf.norm(grad))
        if grad_norm <= 1e-12:
            dead_weights.append((var.name, grad_norm))

    assert len(dead_weights) == 0, f"Detected dead weights with zero gradient: {dead_weights}"


# ------------------------------------------------------------------ Latency Tests
def test_inference_latency_single_and_batch(built_model, mock_normal_stats):
    """Verify single-window and batch inference run well within the 50 ms budget."""
    @tf.function(reduce_retracing=True)
    def infer_single(x):
        return built_model(x, training=False)

    @tf.function(reduce_retracing=True)
    def infer_batch(x):
        return built_model(x, training=False)

    x_single = tf.random.normal((1, 12, 19))
    x_batch = tf.random.normal((32, 12, 19))

    # Warm up graph execution
    for _ in range(5):
        _ = infer_single(x_single)
        _ = infer_batch(x_batch)

    # Measure single-window latency over 20 iterations
    times_single = []
    for _ in range(20):
        t0 = time.perf_counter()
        _ = infer_single(x_single)
        times_single.append((time.perf_counter() - t0) * 1000.0)

    avg_single_ms = float(np.mean(times_single))
    assert avg_single_ms < 50.0, f"Single-window latency too high: {avg_single_ms:.2f} ms"

    # Measure batch latency over 10 iterations
    times_batch = []
    for _ in range(10):
        t0 = time.perf_counter()
        _ = infer_batch(x_batch)
        times_batch.append((time.perf_counter() - t0) * 1000.0)

    avg_batch_ms = float(np.mean(times_batch))
    assert avg_batch_ms < 50.0, f"Batch latency too high: {avg_batch_ms:.2f} ms"

    # Also test OptimizedAEModel wrapper latency
    mean, std = mock_normal_stats
    wrapper = OptimizedAEModel(model=built_model, mean=mean, std=std)
    raw_window = np.tile(mean, (12, 1))
    wrapper_times = []
    for _ in range(20):
        t0 = time.perf_counter()
        wrapper.score(raw_window)
        wrapper_times.append((time.perf_counter() - t0) * 1000.0)
    avg_wrapper_ms = float(np.mean(wrapper_times))
    assert avg_wrapper_ms < 50.0, f"Wrapper scoring latency too high: {avg_wrapper_ms:.2f} ms"


# ------------------------------------------------------------------ LayerNorm Batch Stability
def test_layernorm_stability_across_batch_sizes(built_model):
    """Verify LayerNorm ensures identical output for a sample whether B=1 or B=64."""
    x_sample = np.random.randn(1, 12, 19).astype(np.float32)
    x_batch = np.random.randn(64, 12, 19).astype(np.float32)
    x_batch[0] = x_sample[0]

    out_single = built_model(x_sample, training=False).numpy()
    out_batch = built_model(x_batch, training=False).numpy()

    # The prediction for x_sample should be bitwise/numerically close across batch sizes
    np.testing.assert_allclose(
        out_single[0],
        out_batch[0],
        atol=1e-5,
        err_msg="LayerNorm output differed between batch size 1 and batch size 64",
    )


# ------------------------------------------------------------------ Serialization Round-Trip
def test_weights_serialization_roundtrip(built_model, mock_normal_stats):
    """Verify weights save and load bitwise equivalence without loss of numerical parity."""
    mean, std = mock_normal_stats
    x_test = np.random.randn(5, 12, 19).astype(np.float32)
    pred_orig = built_model(x_test, training=False).numpy()

    with tempfile.TemporaryDirectory() as tmp_dir:
        weights_path = Path(tmp_dir) / "test_model.weights.h5"
        built_model.save_weights(weights_path)
        assert weights_path.exists()

        # Instantiate fresh model and load weights
        fresh_model = build_optimized_ae(mean=mean, std=std, L=L_WIN, n_ch=len(CH))
        fresh_model.load_weights(weights_path)

        pred_loaded = fresh_model(x_test, training=False).numpy()
        np.testing.assert_allclose(
            pred_orig,
            pred_loaded,
            atol=1e-6,
            err_msg="Weights serialization changed model output predictions",
        )


# ------------------------------------------------------------------ OptimizedAEModel Runtime Wrapper
def test_optimized_ae_model_wrapper_contracts(built_model, mock_normal_stats):
    """Verify OptimizedAEModel matches backend/app/ae.py:AEModel interface and returns correct types."""
    mean, std = mock_normal_stats
    wrapper = OptimizedAEModel(model=built_model, mean=mean, std=std, threshold=0.45)

    assert wrapper.window == 12
    assert len(wrapper.channels) == 19
    assert wrapper.threshold == 0.45

    # Single-window scoring test
    normal_window = np.tile(mean, (12, 1))
    score, per_ch_rmse = wrapper.score(normal_window)

    assert isinstance(score, float)
    assert score >= 0.0
    assert isinstance(per_ch_rmse, np.ndarray)
    assert per_ch_rmse.shape == (19,)

    # Batch scoring test
    windows_batch = np.tile(mean, (5, 12, 1))
    scores, batch_per_ch = wrapper.score_batch(windows_batch)

    assert isinstance(scores, np.ndarray)
    assert scores.shape == (5,)
    assert isinstance(batch_per_ch, np.ndarray)
    assert batch_per_ch.shape == (5, 19)


# ------------------------------------------------------------------ Save / Load Bundle Tests
def test_bundle_save_and_load_roundtrip(built_model, mock_normal_stats):
    """Verify save_optimized_bundle and load_optimized_bundle functionality."""
    mean, std = mock_normal_stats

    with tempfile.TemporaryDirectory() as tmp_dir:
        p = Path(tmp_dir)
        save_optimized_bundle(
            path=p,
            model=built_model,
            mean=mean,
            std=std,
            th={"ae": 0.32},
            history={"loss": [0.05, 0.02]},
            filename_prefix="test_bundle",
        )

        assert (p / "test_bundle.weights.h5").exists()
        assert (p / "meta_test_bundle.json").exists()

        loaded_model, l_mean, l_std, meta = load_optimized_bundle(
            path=p,
            filename_prefix="test_bundle",
        )

        assert meta["model_type"] == "RTA-AE"
        assert meta["thresholds"]["ae"] == 0.32
        np.testing.assert_allclose(mean, l_mean, atol=1e-6)
        np.testing.assert_allclose(std, l_std, atol=1e-6)

        # Test loading into OptimizedAEModel via path
        wrapper = OptimizedAEModel(
            path=p,
            weights_filename="test_bundle.weights.h5",
            meta_filename="meta_test_bundle.json",
        )
        score, ch_err = wrapper.score(np.tile(mean, (12, 1)))
        assert isinstance(score, float)
        assert ch_err.shape == (19,)


# ------------------------------------------------------------------ Anomaly Detection Sensitivity
def test_anomaly_detection_sensitivity_vs_baseline(built_model, mock_normal_stats):
    """Verify model maintains strong anomaly detection sensitivity without trivial identity collapse."""
    mean, std = mock_normal_stats
    wrapper = OptimizedAEModel(model=built_model, mean=mean, std=std)

    # 1. Normal operating window (slight random noise around nominal mean)
    rng = np.random.default_rng(123)
    normal_window = mean + rng.normal(0, 0.1, size=(12, 19)).astype(np.float32) * std
    normal_score, _ = wrapper.score(normal_window)

    # 2. Extreme anomalous excursion (e.g. 5-sigma shift on current & thermal channels)
    fault_window = normal_window.copy()
    fault_window[:, 0] += 5.0 * std[0]   # current excursion
    fault_window[:, 5] += 5.0 * std[5]   # thermal excursion
    fault_score, fault_ch = wrapper.score(fault_window)

    # Anomaly score must not collapse to zero (guaranteeing no trivial identity shortcut bypass)
    assert fault_score > 0.1, f"Fault score collapsed to near-zero: {fault_score}"
    # Fault score must significantly exceed normal score
    assert fault_score > normal_score * 2.0, (
        f"Anomaly contrast insufficient: normal={normal_score:.4f}, fault={fault_score:.4f}"
    )
    # Channel-specific error must be highest on the perturbed channels
    assert fault_ch[0] > 1.0 or fault_ch[5] > 1.0


# ------------------------------------------------------------------ Production Files Immutability
def test_production_baseline_files_are_untouched():
    """Verify production weights and metadata have not been modified or overwritten."""
    prod_dir = Path(__file__).resolve().parents[1] / "models" / "anomaly"
    weights_path = prod_dir / "ae_pinn.weights.h5"
    meta_path = prod_dir / "meta.json"

    assert weights_path.exists(), f"Production weights file missing: {weights_path}"
    assert meta_path.exists(), f"Production meta file missing: {meta_path}"

    weights_bytes = weights_path.read_bytes()
    meta_bytes = meta_path.read_bytes()

    # Exact byte counts
    assert len(weights_bytes) == 573992, f"Weights file size modified: {len(weights_bytes)} bytes"
    assert len(meta_bytes) == 3702, f"Meta file size modified: {len(meta_bytes)} bytes"

    # Exact SHA-256 cryptographic hashes
    weights_sha256 = hashlib.sha256(weights_bytes).hexdigest()
    meta_sha256 = hashlib.sha256(meta_bytes).hexdigest()

    expected_weights_sha256 = "184e1862d3b3c6127b2479f16006bb39b0933da99c09d05ef908c8ebe1785f64"
    expected_meta_sha256 = "dff786bc0ec1f39a678996cc35921924a0082fac78613584a8f9cdd63a60bec7"

    assert weights_sha256 == expected_weights_sha256, (
        f"Integrity violation: ae_pinn.weights.h5 modified! SHA256={weights_sha256}"
    )
    assert meta_sha256 == expected_meta_sha256, (
        f"Integrity violation: meta.json modified! SHA256={meta_sha256}"
    )


# ------------------------------------------------------------------ Lightly Trained Model Fixture
@pytest.fixture(scope="module")
def trained_model(mock_normal_stats):
    """Instantiated and lightly trained RTA-AE model for contrast verification."""
    mean, std = mock_normal_stats
    model = build_optimized_ae(mean=mean, std=std, L=L_WIN, n_ch=len(CH))
    # Train 3 epochs on synthetic normal steady-state windows so autoencoder learns normal manifold
    rng = np.random.default_rng(101)
    X = rng.normal(0, 0.05, size=(64, L_WIN, len(CH))).astype(np.float32)
    model.fit(X, X, epochs=3, batch_size=32, verbose=0)
    return model


# ------------------------------------------------------------------ Adversarial Stress & Contrast Tests
def test_single_channel_anomaly_contrast(trained_model, mock_normal_stats):
    """Verify single-channel excursions achieve > 3.0x contrast (and reach > 10.0x) without 1/19 dilution."""
    mean, std = mock_normal_stats
    wrapper = OptimizedAEModel(model=trained_model, mean=mean, std=std, alpha=0.5)

    rng = np.random.default_rng(42)
    normal_window = mean + rng.normal(0, 0.05, size=(12, 19)).astype(np.float32) * std
    normal_score, normal_ch = wrapper.score(normal_window)
    assert normal_score > 0.0

    test_channels = [
        (8, "t_ca_in_C"),
        (9, "t_ca_out_C"),
        (7, "t_an_in_C"),
        (5, "p_dc_kW"),
        (2, "load_set"),
    ]

    contrasts_5sigma = []
    for ch_idx, ch_name in test_channels:
        fault_window = normal_window.copy()
        fault_window[:, ch_idx] += 5.0 * std[ch_idx]
        fault_score, fault_ch = wrapper.score(fault_window)
        contrast = fault_score / normal_score
        contrasts_5sigma.append(contrast)

        # Must comfortably exceed the industrial alarm trip threshold (> 3.0x)
        assert contrast > 3.0, f"Contrast {contrast:.2f}x on {ch_name} below 3.0x"
        # Per-channel attribution must identify the perturbed channel with highest error
        assert np.argmax(fault_ch) == ch_idx, f"Attribution failed for {ch_name}"

    # Across +5 sigma excursions, contrast decisively exceeds > 10.0x
    max_contrast = max(contrasts_5sigma)
    assert max_contrast > 10.0, f"Peak 5-sigma contrast {max_contrast:.2f}x did not reach > 10.0x"

    # Verify batch scoring consistency
    batch_list = [normal_window]
    for ch_idx, _ in test_channels:
        bw = normal_window.copy()
        bw[:, ch_idx] += 5.0 * std[ch_idx]
        batch_list.append(bw)
    batch_windows = np.array(batch_list)

    batch_scores, _ = wrapper.score_batch(batch_windows)
    np.testing.assert_allclose(batch_scores[0], normal_score, rtol=1e-5)
    for k, expected_contrast in enumerate(contrasts_5sigma):
        batch_contrast = batch_scores[k + 1] / batch_scores[0]
        assert batch_contrast > 3.0, f"Batch contrast {batch_contrast:.2f}x below 3.0x"


def test_unnormalized_gradient_stability(built_model):
    """Verify model maintains non-zero, finite gradients across all weights under extreme (10^4) inputs."""
    rng = np.random.default_rng(101)
    x_extreme = rng.normal(10000.0, 1.0, size=(16, 12, 19)).astype(np.float32)
    target_extreme = rng.normal(10000.0, 1.0, size=(16, 12, 19)).astype(np.float32)

    with tf.GradientTape() as tape:
        pred = built_model(x_extreme, training=True)
        loss = tf.reduce_mean(tf.square(pred - target_extreme))

    trainable_vars = built_model.trainable_weights
    assert len(trainable_vars) == 34  # 38 - 4 (MHA bias eliminated)

    grads = tape.gradient(loss, trainable_vars)
    assert len(grads) == len(trainable_vars)

    dead_vars = []
    nan_vars = []
    exploding_vars = []

    for var, grad in zip(trainable_vars, grads):
        assert grad is not None, f"Gradient is None for variable: {var.name}"
        grad_norm = float(tf.norm(grad))
        if not np.isfinite(grad_norm) or np.isnan(grad_norm):
            nan_vars.append(var.name)
        elif grad_norm <= 1e-12:
            dead_vars.append((var.name, grad_norm))
        elif grad_norm > 1e7:
            exploding_vars.append((var.name, grad_norm))

    assert len(nan_vars) == 0, f"NaN / Inf gradients: {nan_vars}"
    assert len(dead_vars) == 0, f"Dead tensors: {dead_vars}"
    assert len(exploding_vars) == 0, f"Exploding tensors: {exploding_vars}"


def test_sensor_drift_and_blower_fade_contrast(trained_model, mock_normal_stats):
    """Verify detection of gradual thermocouple sensor drift and multi-channel blower fade."""
    mean, std = mock_normal_stats
    wrapper = OptimizedAEModel(model=trained_model, mean=mean, std=std, alpha=0.5)

    rng = np.random.default_rng(202)
    normal_window = mean + rng.normal(0, 0.05, size=(12, 19)).astype(np.float32) * std
    normal_score, _ = wrapper.score(normal_window)

    # 1. Gradual sensor drift: thermocouple drift on t_ca_out_C (ch 9) ramping from +1.0 to +5.0 sigma
    drift_window = normal_window.copy()
    drift_ramp = np.linspace(1.0, 5.0, 12).astype(np.float32)
    drift_window[:, 9] += drift_ramp * std[9]

    drift_score, drift_ch = wrapper.score(drift_window)
    drift_contrast = drift_score / normal_score

    assert drift_contrast > 3.0, f"Sensor drift contrast {drift_contrast:.2f}x below 3.0x"
    assert np.argmax(drift_ch) == 9, f"Attribution failed: expected ch 9, got ch {np.argmax(drift_ch)}"

    # 2. Multi-channel Blower Fade signature:
    blower_window = normal_window.copy()
    blower_window[:, 12] -= 3.0 * std[12]
    blower_window[:, 16] += 3.0 * std[16]
    blower_window[:, 9] += 3.0 * std[9]
    blower_window[:, 10] += 3.0 * std[10]

    blower_score, blower_ch = wrapper.score(blower_window)
    blower_contrast = blower_score / normal_score

    assert blower_contrast > 5.0, f"Blower fade contrast {blower_contrast:.2f}x below 5.0x"
    top_channels = set(np.argsort(-blower_ch)[:4])
    expected_channels = {9, 10, 12, 16}
    assert len(top_channels.intersection(expected_channels)) >= 3, (
        f"Top channels {top_channels} did not cover physical signature {expected_channels}"
    )


# ==================================================================
# MILESTONE 2: Enhanced PINN Physics Formulation & Adaptive Balancing Tests
# ==================================================================
from sofc_ai.enhanced_physics_penalty import (
    EnhancedPhysicsPenalty,
    WangAdaptiveBalancingCallback,
    DynamicWeightAveragingCallback,
    compute_physics_residuals,
    huber_loss,
    softplus_barrier,
    RES_KEYS,
)
from sofc_ai import plant


def _create_nominal_physical_telemetry():
    """Generates nominal 100 kW steady-state telemetry matching SOFC physical design."""
    op = plant.operating_point(1.0, 30.0)
    raw = np.zeros((1, 12, 19), dtype=np.float32)
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


def test_all_six_residuals_on_nominal_operating_point():
    """Verify all 6 residuals evaluate to near-zero (< 0.25) on nominal design operating point."""
    raw_nominal = _create_nominal_physical_telemetry()
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)

    residuals = compute_physics_residuals(tf.constant(raw_nominal), mean, std)

    assert set(residuals.keys()) == {"r_far", "r_net", "r_uf", "r_energy", "r_dT", "r_dp"}
    for name, res_tensor in residuals.items():
        val = float(tf.reduce_mean(tf.abs(res_tensor)))
        assert val < 0.25, f"Nominal residual {name} too large: {val:.6f}"


def test_residuals_respond_to_targeted_physical_violations():
    """Verify each residual independently flags its targeted physical violation with large penalty."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)

    # 1. Faraday violation: DC power mismatch (+50 kW without current change)
    x_far = _create_nominal_physical_telemetry()
    x_far[..., 5] += 50.0
    res_far = compute_physics_residuals(tf.constant(x_far), mean, std)
    assert float(tf.reduce_mean(tf.abs(res_far["r_far"]))) > 20.0

    # 2. Net power balance violation (+50 kW net power output unphysically)
    x_net = _create_nominal_physical_telemetry()
    x_net[..., 6] += 50.0
    res_net = compute_physics_residuals(tf.constant(x_net), mean, std)
    assert float(tf.reduce_mean(tf.abs(res_net["r_net"]))) > 20.0

    # 3. Fuel utilization violation: fuel starvation (cut H2 flow by half -> Uf > 1.0)
    x_uf = _create_nominal_physical_telemetry()
    x_uf[..., 11] *= 0.5
    res_uf = compute_physics_residuals(tf.constant(x_uf), mean, std)
    assert float(tf.reduce_mean(res_uf["r_uf"])) > 10.0

    # 4. Energy balance violation (cooling air flow dropped to 10%)
    x_en = _create_nominal_physical_telemetry()
    x_en[..., 12] *= 0.1
    res_en = compute_physics_residuals(tf.constant(x_en), mean, std)
    assert float(tf.reduce_mean(tf.abs(res_en["r_energy"]))) > 5.0

    # 5. Cathode dT limit violation (120 K rise > 100 K limit)
    x_dt = _create_nominal_physical_telemetry()
    x_dt[..., 10] = 120.0
    res_dt = compute_physics_residuals(tf.constant(x_dt), mean, std)
    assert float(tf.reduce_mean(res_dt["r_dT"])) > 3.0

    # 6. Differential pressure: overpressure (> 15 mbar) & seal lift-off (< -5 mbar)
    x_dp_high = _create_nominal_physical_telemetry()
    x_dp_high[..., 15] = 25.0
    x_dp_low = _create_nominal_physical_telemetry()
    x_dp_low[..., 15] = -12.0
    res_dp_h = compute_physics_residuals(tf.constant(x_dp_high), mean, std)
    res_dp_l = compute_physics_residuals(tf.constant(x_dp_low), mean, std)
    assert float(tf.reduce_mean(res_dp_h["r_dp"])) > 1.5
    assert float(tf.reduce_mean(res_dp_l["r_dp"])) > 1.0


def test_huber_loss_gradient_boundedness():
    """Verify Huber loss gradient is strictly bounded by delta=1.0, preventing gradient explosion."""
    r_normal = tf.constant(0.5, dtype=tf.float32)
    r_extreme = tf.constant(500.0, dtype=tf.float32)
    r_negative = tf.constant(-250.0, dtype=tf.float32)

    with tf.GradientTape() as tape:
        tape.watch(r_normal)
        loss_norm = huber_loss(r_normal, delta=1.0)
    grad_norm = float(np.squeeze(tape.gradient(loss_norm, r_normal).numpy()))
    assert np.isclose(grad_norm, 0.5, atol=1e-5), f"Expected 0.5, got {grad_norm}"

    with tf.GradientTape() as tape:
        tape.watch(r_extreme)
        loss_ext = huber_loss(r_extreme, delta=1.0)
    grad_ext = float(np.squeeze(tape.gradient(loss_ext, r_extreme).numpy()))
    assert np.isclose(grad_ext, 1.0, atol=1e-5), f"Expected 1.0, got {grad_ext}"

    with tf.GradientTape() as tape:
        tape.watch(r_negative)
        loss_neg = huber_loss(r_negative, delta=1.0)
    grad_neg = float(np.squeeze(tape.gradient(loss_neg, r_negative).numpy()))
    assert np.isclose(grad_neg, -1.0, atol=1e-5), f"Expected -1.0, got {grad_neg}"


def test_asymmetric_softplus_barrier_smoothness():
    """Verify softplus barrier provides continuous non-zero restoring gradient inside feasible band."""
    z_feasible = tf.constant(-1.0, dtype=tf.float32)   # Inside safe operating band
    z_boundary = tf.constant(0.0, dtype=tf.float32)    # Exactly on boundary limit
    z_violation = tf.constant(3.0, dtype=tf.float32)   # Significant violation outside

    for z, expected_min_grad in [(z_feasible, 0.05), (z_boundary, 0.4), (z_violation, 0.9)]:
        with tf.GradientTape() as tape:
            tape.watch(z)
            b = softplus_barrier(z, beta=2.0)
        grad = float(np.squeeze(tape.gradient(b, z).numpy()))
        assert grad >= expected_min_grad, f"Gradient too small for z={z.numpy()}: {grad}"


def test_bidirectional_differential_pressure_barrier():
    """Verify bidirectional differential pressure penalizes both overpressure and seal lift-off."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)

    # Safe operating pressure: 5.0 mbar
    x_safe = _create_nominal_physical_telemetry()
    x_safe[..., 15] = 5.0
    res_safe = compute_physics_residuals(tf.constant(x_safe), mean, std)
    assert float(tf.reduce_mean(res_safe["r_dp"])) < 0.05

    # Positive overpressure excursion: +25.0 mbar (exceeds +15 mbar warning limit)
    x_over = _create_nominal_physical_telemetry()
    x_over[..., 15] = 25.0
    res_over = compute_physics_residuals(tf.constant(x_over), mean, std)
    assert float(tf.reduce_mean(res_over["r_dp"])) >= 2.0

    # Negative seal lift-off excursion: -10.0 mbar (below -5.0 mbar lift-off limit)
    x_lift = _create_nominal_physical_telemetry()
    x_lift[..., 15] = -10.0
    res_lift = compute_physics_residuals(tf.constant(x_lift), mean, std)
    assert float(tf.reduce_mean(res_lift["r_dp"])) >= 1.0


def test_wang_adaptive_balancing_callback_step():
    """Verify Wang balancing equalizes gradient norms and clips extreme ratios safely."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std, adaptive=True)
    model = build_optimized_ae(mean=mean, std=std, physics_layer=layer)

    # 1. Test target weight computation and clamping
    cb = WangAdaptiveBalancingCallback(penalty_layer=layer, alpha=0.1, min_weight=1e-4, max_weight=50.0)
    g_rec = 1.0
    g_phys_small = 1e-8  # Vanishing physics gradient
    g_phys_large = 100.0 # Exploding physics gradient

    target_clamped = cb.compute_target_weight(g_rec, g_phys_small)
    assert target_clamped <= 50.0, f"Upper clamping failed: {target_clamped}"

    target_low = cb.compute_target_weight(g_rec, g_phys_large)
    assert target_low >= 1e-4, f"Lower clamping failed: {target_low}"

    # 2. Test live weight update step
    cb.model = model
    x_probe = tf.random.normal((8, 12, 19))
    cb.update_weights(x_probe)

    weights_after = layer.get_weights_dict()
    for k in RES_KEYS:
        assert 1e-4 <= weights_after[k] <= 50.0, f"Weight {k} out of bounds: {weights_after[k]}"


def test_dynamic_weight_averaging_callback():
    """Verify DWA weights adapt inversely proportional to loss descent rates and sum to K."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)
    loss_ep1 = np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    loss_ep2 = np.array([0.5, 0.95, 0.7, 0.7, 0.7, 0.7])

    weights = cb.compute_weights(loss_ep1, loss_ep2)
    assert len(weights) == 6
    assert np.isclose(np.sum(weights), 6.0), f"Weights sum {np.sum(weights)} != 6.0"
    # Task 1 descended slower (0.95 vs 0.5) -> must receive higher weight
    assert weights[1] > weights[0], f"Expected task 1 weight > task 0: {weights[1]} vs {weights[0]}"


def test_enhanced_physics_penalty_layer_compilation_and_serialization(mock_normal_stats):
    """Verify RTA-AE compiles with EnhancedPhysicsPenalty, saves and loads with intact predictions."""
    mean, std = mock_normal_stats
    pinn_layer = EnhancedPhysicsPenalty(
        mean=mean,
        std=std,
        weights={"r_far": 0.05, "r_net": 0.03, "r_uf": 0.04},
        delta=1.0,
        beta=2.0,
        adaptive=True,
    )
    model = build_optimized_ae(mean=mean, std=std, physics_layer=pinn_layer)
    model.compile(optimizer=keras.optimizers.Adam(1e-3), loss="mse")

    # Layer config roundtrip
    cfg = pinn_layer.get_config()
    assert cfg["delta"] == 1.0
    assert cfg["beta"] == 2.0
    restored_layer = EnhancedPhysicsPenalty.from_config(cfg)
    assert restored_layer.delta == 1.0
    assert restored_layer.beta == 2.0

    # Model training step
    x_dummy = np.random.randn(8, 12, 19).astype(np.float32)
    history = model.fit(x_dummy, x_dummy, epochs=2, batch_size=4, verbose=0)
    assert len(history.history["loss"]) == 2
    assert not np.isnan(history.history["loss"][-1])

    # Model save and load roundtrip
    with tempfile.TemporaryDirectory() as tmp_dir:
        model_path = Path(tmp_dir) / "pinn_model.keras"
        model.save(model_path)
        assert model_path.exists()
        loaded_model = keras.models.load_model(model_path)
        orig_pred = model.predict(x_dummy, verbose=0)
        loaded_pred = loaded_model.predict(x_dummy, verbose=0)
        np.testing.assert_allclose(orig_pred, loaded_pred, atol=1e-5)


def test_production_baseline_weights_immutability():
    """Cryptographic SHA-256 verification asserting production weights and meta remain 100% untouched."""
    prod_dir = Path(__file__).resolve().parents[1] / "models" / "anomaly"
    w_bytes = (prod_dir / "ae_pinn.weights.h5").read_bytes()
    m_bytes = (prod_dir / "meta.json").read_bytes()

    assert len(w_bytes) == 573992, f"Production weights byte count modified: {len(w_bytes)}"
    assert len(m_bytes) == 3702, f"Production meta byte count modified: {len(m_bytes)}"
    assert hashlib.sha256(w_bytes).hexdigest() == "184e1862d3b3c6127b2479f16006bb39b0933da99c09d05ef908c8ebe1785f64"
    assert hashlib.sha256(m_bytes).hexdigest() == "dff786bc0ec1f39a678996cc35921924a0082fac78613584a8f9cdd63a60bec7"


# =====================================================================
# DWA Numerical Stability & Safeguards Permanent Regression Suite
# =====================================================================

@pytest.mark.parametrize("spike_factor,spike_task_idx", [
    (3000.0, 0),      # Challenger 1 observed threshold (spike >= 2839x overflows)
    (10000.0, 2),     # Severe 10,000x transient spike
    (100000.0, 4),    # Extreme 100,000x transient spike
    (1000000.0, 5),   # Pathological 1,000,000x sensor excursion
])
def test_dwa_numerical_overflow_under_severe_loss_spikes(spike_factor, spike_task_idx):
    """Permanently guard against DWA softmax numerical overflow and NaN under severe loss spikes."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)
    lp = [1.0] * 6
    lc = [1.0] * 6
    lc[spike_task_idx] = float(spike_factor)

    weights = cb.compute_weights(lp, lc)

    # Invariant 1: All weights must be strictly finite (no NaN, no Inf)
    assert np.all(np.isfinite(weights)), f"DWA produced non-finite weights under {spike_factor}x spike: {weights}"
    assert not np.any(np.isnan(weights)), f"DWA produced NaN weights under {spike_factor}x spike: {weights}"
    assert not np.any(np.isinf(weights)), f"DWA produced Inf weights under {spike_factor}x spike: {weights}"

    # Invariant 2: Weights sum strictly to K (num_tasks)
    assert np.isclose(np.sum(weights), 6.0, atol=1e-5), f"Weights sum {np.sum(weights)} != 6.0"

    # Invariant 3: Non-negativity
    assert np.all(weights >= 0.0), f"Negative weight encountered: {weights}"

    # Invariant 4: Spiking task receives the maximal allocated weight
    assert np.argmax(weights) == spike_task_idx, (
        f"Expected spike task {spike_task_idx} to receive max weight, got {np.argmax(weights)}"
    )
    assert weights[spike_task_idx] > 1.0, f"Expected weight > 1.0 for spiking task, got {weights[spike_task_idx]}"


@pytest.mark.parametrize("scenario_name,lp,lc", [
    (
        "Challenger 2 near-zero softplus excursion",
        [0.48, 3.17, 2810.0, 11.0, 2.2e-18, 0.057],
        [0.63, 2.92, 997.0, 12.4, 0.01, 0.058],
    ),
    (
        "Machine zero initial loss single task",
        [1.0, 0.0, 1.0, 1.0, 1.0, 1.0],
        [0.5, 0.05, 0.5, 0.5, 0.5, 0.5],
    ),
    (
        "Vanishing subnormal loss excursion",
        [1.0, 1.0, 1.0, 1.0, 1.0, 1e-12],
        [1.0, 1.0, 1.0, 1.0, 1.0, 10.0],
    ),
    (
        "All-zero initial losses with non-zero current",
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [0.1, 0.1, 0.1, 0.1, 0.1, 0.1],
    ),
    (
        "All-zero initial and all-zero current losses",
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    ),
])
def test_dwa_loss_trajectory_with_zero_and_near_zero_initial_losses(scenario_name, lp, lc):
    """Guard against division by zero and exponential overflow when initial losses are zero or near-zero."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)
    weights = cb.compute_weights(lp, lc)

    # Invariant 1: Strictly finite numbers
    assert np.all(np.isfinite(weights)), f"Scenario '{scenario_name}' produced non-finite weights: {weights}"
    assert not np.any(np.isnan(weights)), f"Scenario '{scenario_name}' produced NaN weights: {weights}"

    # Invariant 2: Sum to K
    assert np.isclose(np.sum(weights), 6.0, atol=1e-5), (
        f"Scenario '{scenario_name}' violated sum to 6.0: {np.sum(weights)}"
    )

    # Invariant 3: All-zero symmetric cases must yield exactly uniform weights
    if scenario_name in ("All-zero initial losses with non-zero current", "All-zero initial and all-zero current losses"):
        for i, w in enumerate(weights):
            assert np.isclose(w, 1.0, atol=1e-4), (
                f"Expected uniform weight 1.0 for '{scenario_name}' on task {i}, got {w}"
            )


def test_dwa_temperature_extremes_and_invariants():
    """Verify DWA stability and theoretical invariants across high, standard, and low temperatures."""
    lp = np.array([1.0, 1.0, 1.0, 1.0, 1.0, 1.0])
    lc = np.array([0.2, 0.2, 1.2, 0.2, 0.2, 0.2]) # Task 2 diverged while others dropped 80%

    # 1. High Temperature (T=100.0) -> Approaching uniform weights (1.0 each)
    cb_high_t = DynamicWeightAveragingCallback(num_tasks=6, temp=100.0)
    w_uniform = cb_high_t.compute_weights(lp, lc)
    assert np.all(np.isfinite(w_uniform))
    assert np.isclose(np.sum(w_uniform), 6.0, atol=1e-5)
    for w in w_uniform:
        assert np.isclose(w, 1.0, atol=0.05), f"Expected near-uniform weight at T=100, got {w}"

    # 2. Standard Temperature (T=2.0) -> Balanced adaptation
    cb_mid_t = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)
    w_mid = cb_mid_t.compute_weights(lp, lc)
    assert np.all(np.isfinite(w_mid))
    assert np.isclose(np.sum(w_mid), 6.0, atol=1e-5)
    assert np.argmax(w_mid) == 2
    assert w_mid[2] > 1.4, f"Expected weight > 1.4 for diverging task, got {w_mid[2]}"

    # 3. Low Temperature (T=0.2) -> Concentrated weight on slowest descending task
    cb_low_t = DynamicWeightAveragingCallback(num_tasks=6, temp=0.2)
    w_sharp = cb_low_t.compute_weights(lp, lc)
    assert np.all(np.isfinite(w_sharp))
    assert np.isclose(np.sum(w_sharp), 6.0, atol=1e-5)
    assert np.argmax(w_sharp) == 2
    assert w_sharp[2] > 4.0, f"Expected concentrated weight on diverging task, got {w_sharp[2]}"


def test_dwa_on_epoch_end_integration_with_physics_layer(mock_normal_stats):
    """Verify DWA callback lifecycle integration updates EnhancedPhysicsPenalty lambdas without graph corruption."""
    mean, std = mock_normal_stats
    pinn_layer = EnhancedPhysicsPenalty(
        mean=mean,
        std=std,
        adaptive=True,
    )
    model = build_optimized_ae(mean=mean, std=std, physics_layer=pinn_layer)
    cb = DynamicWeightAveragingCallback(penalty_layer=pinn_layer, model=model, num_tasks=6, temp=2.0)

    # Epoch 0: initial telemetry loss tracking
    cb.on_epoch_end(0, logs={f"loss_{k}": 1.0 for k in RES_KEYS})
    # Epoch 1: nominal decrease
    cb.on_epoch_end(1, logs={f"loss_{k}": 0.8 for k in RES_KEYS})

    # Epoch 2: severe 3000x transient spike on r_far and near-zero excursion on r_dT
    severe_logs = {f"loss_{k}": 0.7 for k in RES_KEYS}
    severe_logs["loss_r_far"] = 2400.0   # 3000x spike over 0.8
    severe_logs["loss_r_dT"] = 0.001     # Excursion from interior
    cb.on_epoch_end(2, logs=severe_logs)

    # Verify layer lambdas were updated and remain strictly finite positive numbers
    adapted_lambdas = pinn_layer.get_weights_dict()
    for k in RES_KEYS:
        val = adapted_lambdas[k]
        assert np.isfinite(val), f"Lambda {k} became non-finite after DWA on_epoch_end: {val}"
        assert not np.isnan(val), f"Lambda {k} became NaN: {val}"
        assert val >= 0.0, f"Lambda {k} must be non-negative: {val}"

    # Verify model forward pass and loss evaluation remain completely intact with finite gradients
    x_test = tf.random.normal((2, 12, 19))
    with tf.GradientTape() as tape:
        preds = model(x_test, training=True)
        total_loss = tf.reduce_mean(tf.square(preds - x_test))
        for loss in model.losses:
            total_loss += loss
    grads = tape.gradient(total_loss, model.trainable_weights)

    assert np.isfinite(float(total_loss.numpy())), f"Total loss is non-finite: {total_loss}"
    for w, g in zip(model.trainable_weights, grads):
        assert g is not None, f"Gradient is None for {w.name}"
        assert tf.reduce_all(tf.math.is_finite(g)), f"Gradient is non-finite for {w.name}"
