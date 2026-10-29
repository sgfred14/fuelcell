"""
Automated Test Suite for Comparative Benchmark Runner (Milestone 3).

Verifies:
  1. CLI argument parsing, flags, and help messaging.
  2. run_benchmark() programmatic invocation with default and custom options.
  3. Output JSON schema conformance, field completeness, and mathematical consistency.
  4. Reconstruction metrics (MSE, MAE, RMSE, Max Error, R2) calculation integrity.
  5. 6-constraint physics residual metrics evaluation.
  6. Strict immutability of baseline production weights and metadata.
  7. Performance and latency budget compliance (< 50 ms).
  8. Model parameter budget compliance (< 200k params).
  9. Edge-case handling (single window batch, quiet mode, invalid data paths).
"""

import hashlib
import json
from pathlib import Path
import sys

import numpy as np
import pytest

# Ensure backend directory is in sys.path
_current_dir = Path(__file__).resolve().parent
_backend_dir = _current_dir.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

from scripts.benchmark_anomaly_models import (
    run_benchmark,
    parse_args,
    verify_baseline_immutability,
    compute_reconstruction_metrics,
    compute_physics_metrics,
    BASELINE_WEIGHTS_SHA256,
    BASELINE_META_SHA256,
)
from sofc_ai import config as C
from sofc_ai.enhanced_physics_penalty import RES_KEYS


@pytest.fixture(scope="module")
def baseline_dir():
    candidate_dirs = [
        Path("backend/models/anomaly"),
        _backend_dir / "models" / "anomaly",
        Path("models/anomaly"),
    ]
    for cd in candidate_dirs:
        if cd.exists():
            return cd
    return Path("backend/models/anomaly")


@pytest.fixture(scope="module")
def quick_benchmark_report(baseline_dir):
    """Executes a lightweight benchmark with 20 samples for test speed."""
    return run_benchmark(samples=20, baseline_dir=str(baseline_dir), quiet=True)


# ------------------------------------------------------------------ CLI & Argument Parsing
def test_cli_help_flag():
    """Verify that --help exits with code 0."""
    with pytest.raises(SystemExit) as exc_info:
        parse_args(["--help"])
    assert exc_info.value.code == 0


def test_cli_argument_parsing():
    """Verify CLI argument parsing values and defaults."""
    args = parse_args([
        "--data", "examples/sample_normal_then_blower_fade.csv",
        "--output", "reports/custom_report.json",
        "--samples", "50",
        "--baseline-dir", "backend/models/anomaly",
        "--batch-size", "64",
        "--quiet",
    ])
    assert args.data == "examples/sample_normal_then_blower_fade.csv"
    assert args.output == "reports/custom_report.json"
    assert args.samples == 50
    assert args.baseline_dir == "backend/models/anomaly"
    assert args.batch_size == 64
    assert args.quiet is True


def test_cli_argument_short_flags():
    """Verify short argument flags (-d, -o, -n, -b, -q)."""
    args = parse_args([
        "-d", "test.csv",
        "-o", "out.json",
        "-n", "15",
        "-b", "32",
        "-q",
    ])
    assert args.data == "test.csv"
    assert args.output == "out.json"
    assert args.samples == 15
    assert args.batch_size == 32
    assert args.quiet is True


# ------------------------------------------------------------------ Programmatic API Contracts
def test_benchmark_runner_default_invocation(quick_benchmark_report):
    """Verify run_benchmark returns a complete dictionary structure."""
    rep = quick_benchmark_report
    assert isinstance(rep, dict)
    required_keys = {
        "metadata",
        "dataset_info",
        "reconstruction_metrics",
        "physics_residual_metrics",
        "performance_and_latency",
        "verification_summary",
    }
    assert required_keys.issubset(rep.keys())


def test_benchmark_runner_custom_samples_limit(baseline_dir):
    """Verify --samples parameter caps the window count accurately."""
    rep = run_benchmark(samples=10, baseline_dir=str(baseline_dir), quiet=True)
    assert rep["dataset_info"]["total_windows"] == 10


def test_benchmark_runner_json_output_file(baseline_dir, tmp_path):
    """Verify output JSON file generation and content fidelity."""
    json_path = tmp_path / "benchmark_test_report.json"
    rep = run_benchmark(samples=10, output_json=str(json_path), baseline_dir=str(baseline_dir), quiet=True)
    assert json_path.exists()
    disk_data = json.loads(json_path.read_text())
    assert disk_data["verification_summary"]["overall_status"] == rep["verification_summary"]["overall_status"]
    assert disk_data["dataset_info"]["total_windows"] == 10


# ------------------------------------------------------------------ Schema & Metric Consistency
def test_benchmark_json_schema_validity(quick_benchmark_report):
    """Validate report structure against specification schema."""
    rep = quick_benchmark_report
    meta = rep["metadata"]
    assert "timestamp" in meta
    assert "runner_version" in meta
    assert meta["baseline_model"]["weights_sha256"] == BASELINE_WEIGHTS_SHA256
    assert meta["optimized_model"]["total_parameters"] < 200_000

    dataset = rep["dataset_info"]
    assert dataset["window_length_L"] == 12
    assert dataset["channels_count"] == 19
    assert len(dataset["channel_names"]) == 19

    rec = rep["reconstruction_metrics"]
    assert "comparison" in rec
    for model_key in ["baseline", "optimized"]:
        m = rec[model_key]
        assert m["overall_mse"] >= 0.0
        assert m["overall_mae"] >= 0.0
        assert np.isclose(m["overall_rmse"], np.sqrt(m["overall_mse"]), atol=1e-5)
        assert len(m["per_channel"]) == len(C.TELEMETRY_CHANNELS)
        for ch in C.TELEMETRY_CHANNELS:
            assert ch in m["per_channel"]
            ch_data = m["per_channel"][ch]
            assert "mse" in ch_data
            assert "mae" in ch_data
            assert "rmse" in ch_data
            assert "r2" in ch_data


def test_reconstruction_metrics_calculation():
    """Unit test compute_reconstruction_metrics with synthetic arrays."""
    rng = np.random.default_rng(42)
    y_true = rng.normal(0, 1, size=(10, 12, 19)).astype(np.float32)
    y_pred = y_true + 0.1  # constant error of 0.1
    metrics = compute_reconstruction_metrics(y_true, y_pred)
    assert np.isclose(metrics["overall_mse"], 0.01, atol=1e-4)
    assert np.isclose(metrics["overall_mae"], 0.10, atol=1e-4)
    assert np.isclose(metrics["overall_rmse"], 0.10, atol=1e-4)
    assert np.isclose(metrics["overall_max_err"], 0.10, atol=1e-4)


def test_all_six_physics_constraints_reported(quick_benchmark_report):
    """Verify presence and validity of all 6 physical constraints in report."""
    phys = quick_benchmark_report["physics_residual_metrics"]
    for category in ["baseline", "optimized", "ground_truth"]:
        assert category in phys
        constraints = phys[category]["constraints"]
        assert len(constraints) == 6
        for k in RES_KEYS:
            assert k in constraints
            assert "mean_abs" in constraints[k]
            assert "max_abs" in constraints[k]
            assert "violation_rate_pct" in constraints[k]
            assert constraints[k]["mean_abs"] >= 0.0
            assert constraints[k]["max_abs"] >= constraints[k]["mean_abs"]
            assert 0.0 <= constraints[k]["violation_rate_pct"] <= 100.0


# ------------------------------------------------------------------ Production Immutability
def test_baseline_weights_and_meta_immutability(baseline_dir):
    """Verify production baseline files are strictly untouched."""
    is_valid, w_hash, m_hash = verify_baseline_immutability(baseline_dir)
    assert is_valid is True, "Baseline production weights or meta.json have been corrupted!"
    assert w_hash == BASELINE_WEIGHTS_SHA256
    assert m_hash == BASELINE_META_SHA256

    weights_bytes = (baseline_dir / "ae_pinn.weights.h5").read_bytes()
    meta_bytes = (baseline_dir / "meta.json").read_bytes()
    assert len(weights_bytes) == 573992, f"Weights file size modified: {len(weights_bytes)} bytes"
    assert len(meta_bytes) == 3702, f"Meta file size modified: {len(meta_bytes)} bytes"


# ------------------------------------------------------------------ SLA Budgets & Performance
def test_latency_budget_compliance_under_50ms(quick_benchmark_report):
    """Verify inference latency is strictly < 50.0 ms per window."""
    perf = quick_benchmark_report["performance_and_latency"]
    assert perf["optimized"]["latency_per_window_ms"] < 50.0
    assert perf["meets_realtime_budget"] is True
    assert perf["baseline"]["latency_per_window_ms"] < 50.0


def test_parameter_count_budget_under_200k(quick_benchmark_report):
    """Verify model parameter count is < 200,000."""
    p_opt = quick_benchmark_report["metadata"]["optimized_model"]["total_parameters"]
    assert p_opt < 200_000
    assert p_opt == 140_222


# ------------------------------------------------------------------ Robustness & Edge Cases
def test_robustness_single_window_batch(baseline_dir):
    """Verify single-window batch (N=1) processes cleanly without dimensional errors."""
    rep = run_benchmark(samples=1, baseline_dir=str(baseline_dir), quiet=True)
    assert rep["dataset_info"]["total_windows"] == 1
    assert rep["reconstruction_metrics"]["optimized"]["overall_mse"] >= 0.0
    assert rep["reconstruction_metrics"]["baseline"]["overall_mse"] >= 0.0


def test_robustness_invalid_data_path_handling(baseline_dir):
    """Verify non-existent data file falls back cleanly without unhandled crash."""
    rep = run_benchmark(
        telemetry_path="non_existent_file_12345.csv",
        samples=5,
        baseline_dir=str(baseline_dir),
        quiet=True,
    )
    assert rep["dataset_info"]["total_windows"] == 5


def test_cli_quiet_mode_suppresses_stdout(capsys, baseline_dir):
    """Verify that quiet=True suppresses terminal output."""
    run_benchmark(samples=5, baseline_dir=str(baseline_dir), quiet=True)
    captured = capsys.readouterr()
    assert captured.out == ""


def test_verification_summary_integrity(quick_benchmark_report):
    """Verify verification_summary contains all expected boolean flags and valid status."""
    summary = quick_benchmark_report["verification_summary"]
    assert summary["baseline_weights_immutable"] is True
    assert summary["latency_budget_compliant"] is True
    assert isinstance(summary["optimized_reconstruction_superior"], bool)
    assert isinstance(summary["optimized_physics_superior"], bool)
    assert summary["overall_status"] in ["PASSED", "FAILED"]
