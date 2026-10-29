# Project: SOFC Anomaly Detection Deep Learning & Enhanced PINN Optimization

## Architecture
- **Frameworks**: Python 3.11, TensorFlow 2.x / Keras 3.x, NumPy, SciPy, Pandas, FastAPI, Pytest.
- **Base Baseline Preservation**: Production model `backend/models/anomaly/ae_pinn.weights.h5` and `backend/models/anomaly/meta.json` remain 100% immutable and read-only.
- **Optimized Model Design**:
  - `backend/sofc_ai/optimized_anomaly_model.py`: Residual Temporal-Attention Autoencoder (RTA-AE) operating alongside baseline.
  - Encoder: Bidirectional LSTM temporal feature extraction + Multi-Head Temporal Self-Attention ($H=4$, $d_k=32$) + Channel Feature Gating (Squeeze-and-Excitation).
  - Latent Representation: Layer-normalized bottleneck with residual projection.
  - Decoder: Temporal LSTM decoder + Channel expansion with residual skip connection ($\hat{x} = x + \mathcal{F}(x)$).
- **Enhanced Physics-Informed Neural Network (PINN)**:
  - `backend/sofc_ai/enhanced_physics_penalty.py`: Decoupled Huber loss ($\delta = 1.0$) for bilateral conservation residuals ($r_{far}, r_{net}, r_{energy}, r_{sensor,\Delta T}$).
  - Smooth asymmetric softplus barrier potentials with setpoint centering for inequality constraints ($U_f \in [0.70, 0.88]$, $\Delta T \le 100$ K, $\Delta P \in [-5, 15]$ mbar bidirectional).
  - Complete coupling of all 6 physical constraints including previously omitted stack energy balance ($r_{energy}$).
  - Adaptive Loss Balancing: Wang et al. Gradient-Norm Annealing ($\lambda_k^{(t)} = (1-\alpha)\lambda_k^{(t-1)} + \alpha \frac{\|\nabla L_{rec}\|}{\|\nabla L_k\|}$) with EMA momentum ($\alpha = 0.9$) and Dynamic Weight Averaging (DWA).
- **Comparative Benchmarking**:
  - `backend/scripts/benchmark_anomaly_models.py`: Side-by-side telemetry benchmark suite comparing baseline vs optimized models across reconstruction metrics (MSE, MAE, R²) and physics residual metrics ($r_{far}, r_{net}, r_{uf}, r_{energy}, r_{dT}, r_{dp}$).
- **Documentation**:
  - `docs/MODEL_ARCHITECTURE_WORKFLOW.md`: Comprehensive explanation of workflow, mathematical derivations, architecture specifications, benchmark results, and Gravitas reasoning.

## Code Layout
- `backend/sofc_ai/optimized_anomaly_model.py`: Optimized RTA-AE architecture definitions, layer blocks, and model builders.
- `backend/sofc_ai/enhanced_physics_penalty.py`: Enhanced PINN penalty layer, 6 physical constraints, Huber residuals, asymmetric softplus barriers, and adaptive balancing callbacks.
- `backend/scripts/benchmark_anomaly_models.py`: Dedicated benchmarking and evaluation script generating side-by-side comparison tables.
- `backend/tests/test_optimized_anomaly.py`: Comprehensive test suite for optimized model, PINN loss, and adaptive balancing.
- `docs/MODEL_ARCHITECTURE_WORKFLOW.md`: End-to-end technical documentation and Gravitas reasoning.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Non-destructive Model Coexistence | Optimized architecture and weights reside alongside baseline without modifying `backend/models/anomaly/ae_pinn.weights.h5` or `meta.json` | M1 | ORIGINAL_REQUEST R1 |
| 2 | Bidirectional Temporal Encoder | BiLSTM layer capturing forward and backward temporal telemetry trends | M1 | Survey 1 (R1) |
| 3 | Multi-Head Temporal Self-Attention | Multi-head attention layer ($H=4$) focusing on critical transient steps and drift | M1 | Survey 1 (R1) |
| 4 | Channel Squeeze-and-Excitation Gating | Channel-wise attention gating to isolate single-channel sensor excursions | M1 | Survey 1 (R1) |
| 5 | Residual Skip Connections | Encoder-decoder residual skip connections ($\hat{x} = x + \mathcal{F}(x)$) preventing steady-state memorization | M1 | Survey 1 (R1) |
| 6 | Layer Normalization & GELU Activations | Internal covariate stabilization and non-saturating smooth activations | M1 | Survey 1 (R1) |
| 7 | Full 6-Constraint Physics Formulation | Incorporate all 6 SOFC physical constraints including the previously omitted stack energy balance ($r_{energy}$) | M2 | ORIGINAL_REQUEST R2 |
| 8 | Decoupled Huber Loss Formulation | Huber loss ($\delta = 1.0$) preventing vanishing gradients from $\log(1 + \sum r_i^2)$ trap | M2 | Survey 2 (R2) |
| 9 | Smooth Asymmetric Softplus Barriers | Asymmetric barrier potentials for inequality constraints ($U_f, \Delta T, \Delta P$) providing non-zero training gradients | M2 | Survey 2 (R2) |
| 10 | Bidirectional Differential Pressure Constraint | Membrane $\Delta P$ penalty covering both positive overpressure and negative seal lift-off | M2 | Survey 2 (R2) |
| 11 | Wang et al. Gradient-Norm Adaptive Balancing | Dynamic gradient-norm balancing equalizing backpropagation forces between reconstruction and physics terms | M2 | ORIGINAL_REQUEST R2 |
| 12 | Dynamic Weight Averaging (DWA) | Lightweight rate-of-change loss balancing as a fast alternative | M2 | Survey 2 (R2) |
| 13 | Telemetry Loading & Standardization Harness | Robust loader for repository telemetry and synthetic SOFC operational profiles | M3 | Survey 3 (R3) |
| 14 | Side-by-Side Reconstruction Benchmarking | Metric computation (MSE, MAE, Max Error, R²) comparing baseline vs optimized models | M3 | ORIGINAL_REQUEST R3 |
| 15 | Side-by-Side Physics Residual Benchmarking | Physics constraint violation metrics ($r_{far}, r_{net}, r_{uf}, r_{energy}, r_{dT}, r_{dp}$) reporting | M3 | ORIGINAL_REQUEST R3 |
| 16 | Dedicated CLI Benchmark Runner | Executable benchmark script in `backend/scripts/benchmark_anomaly_models.py` | M3 | ORIGINAL_REQUEST R3 |
| 17 | Comprehensive Workflow Documentation | Detailed markdown documentation in `docs/MODEL_ARCHITECTURE_WORKFLOW.md` | M4 | ORIGINAL_REQUEST R4 |
| 18 | Mathematical Formulations & Derivations | Rigorous equations for Faraday, Power, $U_f$, Energy, $\Delta T$, $\Delta P$, Huber, and Wang balancing | M4 | ORIGINAL_REQUEST R4 |
| 19 | Gravitas Reasoning Documentation | Evidence-backed architectural decisions, trade-offs, and empirical validation | M4 | ORIGINAL_REQUEST R4 |
| 20 | Regression Test Verification | Verify all 45 existing backend automated tests pass without regression | M5 | ORIGINAL_REQUEST R3 |
| 21 | Optimized Model & PINN Unit Tests | Automated test suite in `backend/tests/test_optimized_anomaly.py` | M5 | ORIGINAL_REQUEST R3 |
| 22 | Forensic Integrity Audit Verification | Independent verification of genuine implementations and zero-cheating | M5 | Orchestrator Gate |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Base DL Architecture Optimization | `backend/sofc_ai/optimized_anomaly_model.py`: RTA-AE model, BiLSTM, Multi-Head Attention, Channel Gating, Residual Skips, LayerNorm | none | READY |
| M2 | Enhanced PINN & Adaptive Loss Balancing | `backend/sofc_ai/enhanced_physics_penalty.py`: 6 constraints, Huber residuals, Softplus barriers, Wang et al. Gradient Norm Balancing, DWA | M1 | PLANNED |
| M3 | Comparative Benchmarking & Verification | `backend/scripts/benchmark_anomaly_models.py`: Side-by-side telemetry benchmark suite, reconstruction & physics residual metrics | M1, M2 | PLANNED |
| M4 | Workflow Explanation & Gravitas Reasoning | `docs/MODEL_ARCHITECTURE_WORKFLOW.md`: Complete architectural documentation, mathematical PINN equations, benchmark tables, Gravitas log | M1, M2, M3 | PLANNED |
| M5 | Final Milestone: Full Regression & Verification | Run existing 45 tests (`backend/tests/`) + new tests (`backend/tests/test_optimized_anomaly.py`), run adversarial stress test, and forensic integrity audit | M1, M2, M3, M4 | PLANNED |

## Interface Contracts

### Model Builder (`backend/sofc_ai/optimized_anomaly_model.py`)
- `build_optimized_ae(mean: np.ndarray, std: np.ndarray, L: int = 12, n_ch: int = 19, lstm_units: int = 64, latent_dim: int = 32, num_heads: int = 4, key_dim: int = 16, dropout: float = 0.1, physics_layer: Optional[keras.layers.Layer] = None) -> keras.Model`
- `get_model_summary(model: keras.Model) -> dict`

### Enhanced PINN Penalty (`backend/sofc_ai/enhanced_physics_penalty.py`)
- `EnhancedPhysicsPenalty(mean: np.ndarray, std: np.ndarray, weights: Optional[dict] = None, delta: float = 1.0, adaptive: bool = True) -> keras.layers.Layer`
- `WangAdaptiveBalancingCallback(alpha: float = 0.9, target_ratio: float = 1.0) -> keras.callbacks.Callback`
- `DynamicWeightAveragingCallback(temp: float = 2.0) -> keras.callbacks.Callback`
- `compute_physics_residuals(data_tensor: tf.Tensor, mean: tf.Tensor, std: tf.Tensor) -> dict[str, tf.Tensor]`

### Benchmark Runner (`backend/scripts/benchmark_anomaly_models.py`)
- `run_benchmark(telemetry_path: Optional[str] = None, output_json: Optional[str] = None) -> dict`
- CLI invocation: `python backend/scripts/benchmark_anomaly_models.py [--data PATH] [--output PATH]`
