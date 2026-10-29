"""
Empirical Challenger Test Suite for Milestone 3 (CLI Runner Robustness & Stress).

Authored by: m3_dl_challenger_1 (teamwork_challenger)
Purpose: Adversarially challenge the benchmark CLI runner (backend/scripts/benchmark_anomaly_models.py)
         under edge cases, malformed data, tampered assets, and stress conditions.

Test Matrix:
  1. CLI Subprocess Invocations (help, argument parsing, short/long flags, quiet mode).
  2. Malformed / Corrupt Telemetry (missing columns, corrupt values, single-row data, extreme values, NaNs).
  3. Output Directory & Path Stress (deeply nested paths, spaces, fallback on missing data).
  4. Cryptographic Tamper Detection & Exit Code Enforcement (corrupt weights/meta -> exit code 1).
  5. Batch Size Invariance & Large Window Scaling.
"""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import numpy as np
import pandas as pd
import pytest

# Ensure backend directory is in sys.path
_current_dir = Path(__file__).resolve().parent
_backend_dir = _current_dir.parent
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))

from scripts.benchmark_anomaly_models import (
    run_benchmark,
    parse_args,
    load_telemetry_windows,
    verify_baseline_immutability,
    compute_reconstruction_metrics,
    compute_physics_metrics,
    BASELINE_WEIGHTS_SHA256,
    BASELINE_META_SHA256,
)
from sofc_ai import config as C
from sofc_ai.enhanced_physics_penalty import RES_KEYS


SCRIPT_PATH = str(_backend_dir / "scripts" / "benchmark_anomaly_models.py")


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


# ==============================================================================
# SECTION 1: CLI Entrypoint Subprocess Testing
# ==============================================================================

def test_cli_subprocess_help():
    """Verify CLI --help returns 0 and displays expected flags."""
    res = subprocess.run(
        [sys.executable, SCRIPT_PATH, "--help"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 0
    stdout = res.stdout
    assert "--data" in stdout or "-d" in stdout
    assert "--output" in stdout or "-o" in stdout
    assert "--samples" in stdout or "-n" in stdout
    assert "--baseline-dir" in stdout
    assert "--optimized-weights" in stdout
    assert "--batch-size" in stdout or "-b" in stdout
    assert "--quiet" in stdout or "-q" in stdout


def test_cli_subprocess_invalid_flag():
    """Verify CLI exits with code 2 on unknown argument."""
    res = subprocess.run(
        [sys.executable, SCRIPT_PATH, "--nonexistent-flag-xyz"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 2
    assert "unrecognized arguments" in res.stderr.lower() or "error" in res.stderr.lower()


def test_cli_subprocess_invalid_argument_type():
    """Verify CLI exits with code 2 when non-integer passed to --samples."""
    res = subprocess.run(
        [sys.executable, SCRIPT_PATH, "--samples", "not_a_number"],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert res.returncode == 2
    assert "invalid int value" in res.stderr.lower()


def test_cli_subprocess_quiet_flag_suppresses_stdout():
    """Verify CLI --quiet suppresses terminal tables."""
    res = subprocess.run(
        [sys.executable, SCRIPT_PATH, "--samples", "5", "--quiet"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert res.returncode == 0
    # In quiet mode, stdout should be completely empty
    assert res.stdout.strip() == ""


# ==============================================================================
# SECTION 2: Telemetry Malformed Inputs & Edge Cases
# ==============================================================================

def test_adversarial_missing_columns_raises_keyerror(tmp_path):
    """Verify providing a CSV missing required telemetry channels raises KeyError."""
    bad_csv = tmp_path / "missing_channels.csv"
    df = pd.DataFrame({"t_amb_C": [25.0, 25.1, 25.2], "load_set": [10.0, 10.0, 10.0]})
    df.to_csv(bad_csv, index=False)

    with pytest.raises(KeyError) as exc_info:
        load_telemetry_windows(data_path=str(bad_csv))
    assert "columns" in str(exc_info.value).lower() or "t_ca_in_c" in str(exc_info.value).lower()


def test_adversarial_corrupt_empty_csv(tmp_path):
    """Verify completely empty CSV (0 bytes) raises pandas EmptyDataError or falls back cleanly."""
    empty_csv = tmp_path / "empty.csv"
    empty_csv.write_text("")

    with pytest.raises(Exception):
        load_telemetry_windows(data_path=str(empty_csv))


def test_adversarial_insufficient_rows_detection(tmp_path):
    """Verify single-row CSV (< 5 minutes downsample block) raises expected KeyError for missing 'row'."""
    single_row_csv = tmp_path / "single_row.csv"
    df = pd.DataFrame({c: [1.0] for c in C.TELEMETRY_CHANNELS})
    df.to_csv(single_row_csv, index=False)

    # When fewer than 5 rows, downsample is skipped and df lacks 'row', resulting in KeyError('row')
    with pytest.raises(KeyError) as exc_info:
        load_telemetry_windows(data_path=str(single_row_csv))
    assert "row" in str(exc_info.value)


def test_adversarial_samples_zero_and_negative():
    """Verify passing samples=0 or negative does not crash and defaults to all available windows."""
    # samples=0 falls through 'if samples is not None and samples > 0'
    rep_zero = run_benchmark(samples=0, quiet=True)
    assert rep_zero["dataset_info"]["total_windows"] > 0

    rep_neg = run_benchmark(samples=-5, quiet=True)
    assert rep_neg["dataset_info"]["total_windows"] > 0


def test_reconstruction_metrics_extreme_values():
    """Verify compute_reconstruction_metrics remains numerically stable with extreme scale values."""
    y_true = np.ones((5, 12, 19), dtype=np.float32) * 1e6
    y_pred = np.ones((5, 12, 19), dtype=np.float32) * 1e6 + 0.5

    metrics = compute_reconstruction_metrics(y_true, y_pred)
    assert np.isfinite(metrics["overall_mse"])
    assert np.isclose(metrics["overall_mse"], 0.25, atol=1e-3)
    assert np.isclose(metrics["overall_mae"], 0.5, atol=1e-3)
    # R2 with constant true signal should be 0.0 or 1.0 depending on residual
    assert metrics["overall_r2"] in [0.0, 1.0]


def test_reconstruction_metrics_nan_handling():
    """Verify compute_reconstruction_metrics handles arrays containing NaN values without crashing."""
    y_true = np.ones((2, 12, 19), dtype=np.float32)
    y_pred = np.ones((2, 12, 19), dtype=np.float32)
    y_pred[0, 0, 0] = np.nan

    metrics = compute_reconstruction_metrics(y_true, y_pred)
    # np.mean with NaN produces NaN
    assert np.isnan(metrics["overall_mse"])
    assert np.isnan(metrics["overall_mae"])


# ==============================================================================
# SECTION 3: Output Paths & Directory Stress Testing
# ==============================================================================

def test_output_deeply_nested_directory_creation(tmp_path):
    """Verify runner safely creates deeply nested non-existent directory trees."""
    deep_path = tmp_path / "level1" / "level2" / "level3" / "nested_benchmark_report.json"
    assert not deep_path.parent.exists()

    rep = run_benchmark(samples=5, output_json=str(deep_path), quiet=True)
    assert deep_path.exists()
    assert deep_path.is_file()

    loaded = json.loads(deep_path.read_text())
    assert loaded["verification_summary"]["overall_status"] == rep["verification_summary"]["overall_status"]
    assert loaded["dataset_info"]["total_windows"] == 5


def test_output_path_with_spaces_and_symbols(tmp_path):
    """Verify runner handles output file names with spaces and special characters."""
    special_path = tmp_path / "custom folder with spaces" / "report #1 [test].json"

    run_benchmark(samples=5, output_json=str(special_path), quiet=True)
    assert special_path.exists()
    loaded = json.loads(special_path.read_text())
    assert "metadata" in loaded


def test_json_serialization_pure_python_types(tmp_path):
    """Verify report dict contains only standard JSON-serializable types (no un-cast numpy scalars)."""
    json_path = tmp_path / "serial_check.json"
    rep = run_benchmark(samples=5, output_json=str(json_path), quiet=True)

    # Standard json.dumps should succeed without default handlers
    raw_str = json.dumps(rep)
    assert isinstance(raw_str, str)
    assert len(raw_str) > 1000


# ==============================================================================
# SECTION 4: Tampered Baseline Detection & CLI Exit Code Enforcement
# ==============================================================================

def test_tampered_baseline_weights_detected(baseline_dir, tmp_path):
    """Verify that tampering with baseline weights triggers verification failure."""
    tampered_dir = tmp_path / "tampered_baseline"
    tampered_dir.mkdir()

    # Copy meta.json unchanged
    meta_bytes = (baseline_dir / "meta.json").read_bytes()
    (tampered_dir / "meta.json").write_bytes(meta_bytes)

    # Corrupt weights.h5 (e.g. 1 byte flip)
    weights_bytes = bytearray((baseline_dir / "ae_pinn.weights.h5").read_bytes())
    weights_bytes[100] = (weights_bytes[100] + 1) % 256
    (tampered_dir / "ae_pinn.weights.h5").write_bytes(bytes(weights_bytes))

    # Verify detection
    is_valid, w_hash, m_hash = verify_baseline_immutability(tampered_dir)
    assert is_valid is False
    assert w_hash != BASELINE_WEIGHTS_SHA256
    assert m_hash == BASELINE_META_SHA256


def test_tampered_baseline_meta_detected(baseline_dir, tmp_path):
    """Verify that tampering with meta.json triggers verification failure."""
    tampered_dir = tmp_path / "tampered_meta"
    tampered_dir.mkdir()

    # Copy weights unchanged
    weights_bytes = (baseline_dir / "ae_pinn.weights.h5").read_bytes()
    (tampered_dir / "ae_pinn.weights.h5").write_bytes(weights_bytes)

    # Corrupt meta.json
    (tampered_dir / "meta.json").write_text('{"modified": true}')

    # Verify detection
    is_valid, w_hash, m_hash = verify_baseline_immutability(tampered_dir)
    assert is_valid is False
    assert m_hash != BASELINE_META_SHA256
    assert w_hash == BASELINE_WEIGHTS_SHA256


def test_missing_baseline_files_detected(tmp_path):
    """Verify missing baseline files report invalid status."""
    empty_dir = tmp_path / "empty_models"
    empty_dir.mkdir()

    is_valid, w_hash, m_hash = verify_baseline_immutability(empty_dir)
    assert is_valid is False
    assert w_hash == ""
    assert m_hash == ""


# ==============================================================================
# SECTION 5: Batch Size Invariance & Scaling
# ==============================================================================

def test_batch_size_metric_invariance():
    """Verify reconstruction metrics are numerically invariant to batch size."""
    rep_b16 = run_benchmark(samples=10, batch_size=16, quiet=True)
    rep_b64 = run_benchmark(samples=10, batch_size=64, quiet=True)

    mse_b16 = rep_b16["reconstruction_metrics"]["baseline"]["overall_mse"]
    mse_b64 = rep_b64["reconstruction_metrics"]["baseline"]["overall_mse"]
    assert np.isclose(mse_b16, mse_b64, atol=1e-5), f"Batch size caused MSE discrepancy: {mse_b16} vs {mse_b64}"


def test_stress_scaling_window_count():
    """Verify benchmark runs cleanly on 35+ windows without memory or dimension leaks."""
    rep = run_benchmark(samples=35, batch_size=128, quiet=True)
    assert rep["dataset_info"]["total_windows"] == 35
    assert rep["verification_summary"]["overall_status"] == "PASSED"
    assert rep["performance_and_latency"]["optimized"]["latency_per_window_ms"] < 50.0
