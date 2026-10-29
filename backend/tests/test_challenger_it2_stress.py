"""
Empirical Adversarial Stress Suite for Milestone 2 Iteration 2 DWA & Adaptive Balancing.

Adversarially challenges and verifies:
1. DWA numerical stability under astronomical loss spikes (3000x to 1e300x, and +inf).
2. Boundary inputs: exact zeros, near-zero (1e-18), IEEE 754 subnormals (5e-324), negative losses.
3. Temperature spectrum limits (T=0.01 to T=100000.0) and mathematical invariants.
4. Arbitrary task counts K in [1, 2, 6, 19, 100].
5. Wang balancing callback behavior under non-finite (NaN, Inf) and zero gradient norms.
6. Multi-epoch simulated training trajectory under chaotic spike sequences.
"""

import math
import numpy as np
import pytest

from sofc_ai.enhanced_physics_penalty import (
    DynamicWeightAveragingCallback,
    WangAdaptiveBalancingCallback,
    EnhancedPhysicsPenalty,
    RES_KEYS,
)


# =====================================================================
# 1. Extreme Loss Spike Sweeps
# =====================================================================
@pytest.mark.parametrize(
    "spike_factor",
    [
        3000.0,
        10000.0,
        100000.0,
        1e6,
        1e8,
        1e15,
        1e50,
        1e100,
        1e300,
        float("inf"),
    ],
)
@pytest.mark.parametrize("spike_task_idx", [0, 2, 5])
def test_dwa_astronomical_loss_spikes(spike_factor, spike_task_idx):
    """Stress test DWA across astronomical loss spikes up to 1e300 and +infinity."""
    K = 6
    cb = DynamicWeightAveragingCallback(num_tasks=K, temp=2.0)
    lp = [1.0] * K
    lc = [1.0] * K
    lc[spike_task_idx] = float(spike_factor)

    weights = cb.compute_weights(lp, lc)

    # Invariant 1: Strictly finite numbers (no NaN, no Inf)
    assert np.all(np.isfinite(weights)), f"Failed on spike {spike_factor}: {weights}"
    assert not np.any(np.isnan(weights)), f"NaN encountered on spike {spike_factor}: {weights}"

    # Invariant 2: Sum preservation == K
    assert np.isclose(np.sum(weights), float(K), atol=1e-5), f"Sum violated: {np.sum(weights)}"

    # Invariant 3: Non-negativity
    assert np.all(weights >= 0.0), f"Negative weights encountered: {weights}"

    # Invariant 4: Spiking task receives the maximal allocated weight
    assert np.argmax(weights) == spike_task_idx, f"Wrong argmax: {np.argmax(weights)}"
    assert weights[spike_task_idx] > 1.0, f"Spiking task did not receive amplified weight: {weights}"


def test_dwa_simultaneous_multi_task_spikes():
    """Verify stability when multiple tasks spike simultaneously with different magnitudes."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)
    lp = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    # Tasks 0, 2, 4 spike with 2e4, 1e8, 1e12 respectively (all > clip threshold 1e4)
    lc = [2e4, 1.0, 1e8, 1.0, 1e12, 1.0]

    weights = cb.compute_weights(lp, lc)

    assert np.all(np.isfinite(weights))
    assert np.isclose(np.sum(weights), 6.0, atol=1e-5)
    # The clipping bounds rates to 1e4, so rates for 0, 2, 4 should all saturate at 1e4
    # which distributes weight equally among the spiking tasks
    assert np.isclose(weights[0], weights[2], atol=1e-5)
    assert np.isclose(weights[2], weights[4], atol=1e-5)
    assert weights[0] > 1.9  # 6 / 3 = 2.0 each
    assert np.isclose(weights[1], 0.0, atol=1e-5)
    assert np.isclose(weights[3], 0.0, atol=1e-5)
    assert np.isclose(weights[5], 0.0, atol=1e-5)


# =====================================================================
# 2. Boundary Inputs: Zeros, Subnormals, Negatives, Epsilons
# =====================================================================
@pytest.mark.parametrize(
    "lp,lc,desc",
    [
        ([0.0]*6, [0.0]*6, "exact zero both epochs"),
        ([0.0]*6, [1.0]*6, "zero previous, nominal current"),
        ([1.0]*6, [0.0]*6, "nominal previous, zero current"),
        ([1e-18]*6, [1e-18]*6, "near-zero 1e-18 symmetric"),
        ([1e-18]*6, [1.0]*6, "near-zero previous 1e-18 with 1.0 current (1e18 ratio)"),
        ([5e-324]*6, [1.0]*6, "IEEE 754 subnormal previous"),
        ([1.0]*6, [5e-324]*6, "IEEE 754 subnormal current"),
        ([5e-324]*6, [5e-324]*6, "IEEE 754 subnormal both epochs"),
        ([-1.0, 1.0, 1.0, 1.0, 1.0, 1.0], [1.0]*6, "negative previous loss artifact"),
        ([1.0]*6, [-1.0, 1.0, 1.0, 1.0, 1.0, 1.0], "negative current loss artifact"),
        ([-1e-8, 1.0, 1.0, 1.0, 1.0, 1.0], [1.0]*6, "exact negative epsilon previous"),
        ([1e308]*6, [1e308]*6, "near-max float64 symmetric"),
        ([1e308, 1.0, 1.0, 1.0, 1.0, 1.0], [1.0]*6, "near-max float64 single task"),
    ],
)
def test_dwa_extreme_boundary_numerics(lp, lc, desc):
    """Stress test boundary condition handling for exact zeros, subnormals, and negatives."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=2.0)
    weights = cb.compute_weights(lp, lc)

    assert np.all(np.isfinite(weights)), f"Non-finite weights for {desc}: {weights}"
    assert not np.any(np.isnan(weights)), f"NaN encountered for {desc}: {weights}"
    assert np.isclose(np.sum(weights), 6.0, atol=1e-5), f"Sum violated for {desc}: {np.sum(weights)}"
    assert np.all(weights >= 0.0), f"Negative weight for {desc}: {weights}"


# =====================================================================
# 3. Temperature Spectrum and Mathematical Invariants
# =====================================================================
@pytest.mark.parametrize("temp", [0.01, 0.05, 0.1, 0.5, 1.0, 2.0, 5.0, 20.0, 100.0, 1000.0, 100000.0])
def test_dwa_temperature_spectrum_and_monotonicity(temp):
    """Verify DWA stability across temperature range from 0.01 (near-argmax) to 100000 (uniform)."""
    cb = DynamicWeightAveragingCallback(num_tasks=6, temp=temp)
    # Task 3 is slow to converge (rate = 2.0), while others converged faster (rate = 0.5)
    lp = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    lc = [0.5, 0.5, 0.5, 2.0, 0.5, 0.5]

    weights = cb.compute_weights(lp, lc)

    assert np.all(np.isfinite(weights))
    assert np.isclose(np.sum(weights), 6.0, atol=1e-5)
    assert np.argmax(weights) == 3

    if temp >= 1000.0:
        # High temperature -> uniform weights (1.0 each)
        for w in weights:
            assert np.isclose(w, 1.0, atol=0.01)
    elif temp <= 0.05:
        # Very low temperature -> argmax concentrates almost all weight (6.0) on task 3
        assert weights[3] > 5.95
        for i in [0, 1, 2, 4, 5]:
            assert np.isclose(weights[i], 0.0, atol=0.05)


def test_dwa_temperature_entropy_monotonicity():
    """Verify that Shannon entropy of normalized weights strictly increases monotonically with temperature."""
    temps = [0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 50.0, 100.0]
    lp = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0]
    lc = [0.2, 0.4, 0.6, 0.8, 1.5, 3.0]

    entropies = []
    for t in temps:
        cb = DynamicWeightAveragingCallback(num_tasks=6, temp=t)
        w = cb.compute_weights(lp, lc)
        p = w / np.sum(w)
        # Shannon entropy H = -sum(p * log(p + eps))
        entropy = -float(np.sum(p * np.log(p + 1e-15)))
        entropies.append(entropy)

    # Entropies must be strictly non-decreasing with temperature
    for i in range(len(entropies) - 1):
        assert entropies[i] <= entropies[i + 1] + 1e-6, (
            f"Entropy decreased with temperature at T={temps[i]} -> T={temps[i+1]}: {entropies[i]} > {entropies[i+1]}"
        )


# =====================================================================
# 4. Arbitrary Task Counts K
# =====================================================================
@pytest.mark.parametrize("K", [1, 2, 3, 6, 12, 19, 50, 100])
def test_dwa_arbitrary_task_counts(K):
    """Verify DWA formulation holds for any number of tasks K."""
    cb = DynamicWeightAveragingCallback(num_tasks=K, temp=2.0)
    rng = np.random.default_rng(42)
    lp = rng.uniform(0.1, 10.0, size=K)
    lc = rng.uniform(0.1, 10.0, size=K)

    weights = cb.compute_weights(lp, lc)

    assert len(weights) == K
    assert np.all(np.isfinite(weights))
    assert np.isclose(np.sum(weights), float(K), atol=1e-4)
    assert np.all(weights >= 0.0)


def test_dwa_single_task_degenerate_case():
    """Degenerate K=1 case: single task must unconditionally receive weight == 1.0."""
    cb = DynamicWeightAveragingCallback(num_tasks=1, temp=2.0)
    w = cb.compute_weights([5.0], [50000.0])
    assert len(w) == 1
    assert np.isclose(w[0], 1.0)


# =====================================================================
# 5. Wang Adaptive Balancing Callback Safeguards
# =====================================================================
@pytest.mark.parametrize(
    "g_rec,g_k,expected_min",
    [
        (0.0, 0.0, True),
        (1.0, 0.0, False),  # g_k clipped to eps=1e-8, so raw_ratio > max_weight -> clips to max_weight
        (float("inf"), 1.0, True),  # inf / 1.0 = inf -> not finite -> min_weight
        (1.0, float("inf"), True),  # 1.0 / inf = 0.0 -> clips to min_weight
        (float("nan"), 1.0, True),  # nan -> min_weight
        (1.0, float("nan"), True),  # 1.0 / safe(nan) -> safe(nan) = nan -> raw_ratio = nan -> min_weight
        (-10.0, 1.0, True),         # negative raw ratio -> clips to min_weight
    ],
)
def test_wang_balancing_safeguard_under_pathological_gradients(g_rec, g_k, expected_min):
    """Verify WangAdaptiveBalancingCallback safeguard handles non-finite and zero gradient norms safely."""
    cb = WangAdaptiveBalancingCallback(
        min_weight=0.01,
        max_weight=10.0,
        target_ratio=1.0,
        epsilon=1e-8,
    )
    target = cb.compute_target_weight(g_rec, g_k)

    assert np.isfinite(target)
    assert not np.isnan(target)
    assert target >= 0.01
    assert target <= 10.0
    if expected_min:
        assert target == 0.01


# =====================================================================
# 6. Simulated Chaotic Training Trajectory
# =====================================================================
def test_dwa_chaotic_training_trajectory_simulation():
    """Simulate a 20-epoch training trajectory with chaotic alternating loss spikes, drops, and zero-losses."""
    mean = np.zeros(19, dtype=np.float32)
    std = np.ones(19, dtype=np.float32)
    layer = EnhancedPhysicsPenalty(mean=mean, std=std, adaptive=True)
    cb = DynamicWeightAveragingCallback(penalty_layer=layer, num_tasks=6, temp=2.0)

    rng = np.random.default_rng(999)

    for ep in range(20):
        logs = {}
        for k in RES_KEYS:
            scenario = rng.integers(0, 5)
            if scenario == 0:
                # Nominal descent
                val = 1.0 / (ep + 1.0)
            elif scenario == 1:
                # Severe spike
                val = 10000.0 * rng.uniform(1.0, 5.0)
            elif scenario == 2:
                # Machine zero
                val = 0.0
            elif scenario == 3:
                # Tiny subnormal-like
                val = 1e-16
            else:
                # Modest noise
                val = rng.uniform(0.1, 5.0)
            logs[f"loss_{k}"] = float(val)

        cb.on_epoch_end(ep, logs=logs)

        # Lambdas must remain strictly finite and positive
        lambdas = layer.get_weights_dict()
        for k, l_val in lambdas.items():
            assert np.isfinite(l_val), f"Lambda {k} became non-finite at epoch {ep}: {l_val}"
            assert not np.isnan(l_val), f"Lambda {k} became NaN at epoch {ep}: {l_val}"
            assert l_val >= 0.0, f"Lambda {k} became negative at epoch {ep}: {l_val}"
