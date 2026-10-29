# Deep Learning Architecture: Residual Temporal-Attention Autoencoder (RTA-AE)

**Document Version**: 1.0.0  
**Target Module**: `backend/sofc_ai/optimized_anomaly_model.py`  
**Related Modules**: `backend/sofc_ai/anomaly_model.py`, `backend/app/ae.py`, `backend/scripts/benchmark_anomaly_models.py`

---

## 1. Executive Architecture Overview

The Solid Oxide Fuel Cell (SOFC) anomaly detection subsystem operates on multivariate streaming time-series data from 19 process sensors. In industrial fuel cell operations, failure modes such as auxiliary blower degradation, fuel gas restriction, steam reformer starvation, and ceramic seal lift-off evolve over minutes to hours. Early detection requires modeling both inter-sensor dependencies (cross-channel interactions) and long-range temporal trends (lagged cross-step dynamics).

The optimized architecture is a **Residual Temporal-Attention Autoencoder (RTA-AE)** designed to operate alongside the baseline model without modifying or overwriting frozen production weights in `backend/models/anomaly/ae_pinn.weights.h5`.

```
                    Multivariate Input Sequence (B, 12, 19)
                                       │
                                       ▼
             ┌──────────────────────────────────────────────────┐
             │  1. Channel Feature Squeeze-and-Excitation (SE)  │
             │     Global temporal pool -> GELU -> Sigmoid      │
             └─────────────────────────┬────────────────────────┘
                                       │ Recalibrated Tensor (B, 12, 19)
                                       ▼
             ┌──────────────────────────────────────────────────┐
             │  2. Bidirectional LSTM Temporal Encoder (64 units)│
             │     Forward + Backward = 128 hidden channels     │
             │     + LayerNormalization + Dropout(0.1)          │
             └─────────────────────────┬────────────────────────┘
                                       │ Hidden Sequences (B, 12, 128)
                                       ▼
             ┌──────────────────────────────────────────────────┐
             │  3. Multi-Head Temporal Self-Attention           │
             │     Heads=4, key_dim=16, Scaled Dot-Product      │
             │     + Intra-Block Residual Addition + LayerNorm   │
             └─────────────────────────┬────────────────────────┘
                                       │ Contextual Sequence (B, 12, 128)
                                       ▼
             ┌──────────────────────────────────────────────────┐
             │  4. Latent Sequence Bottleneck                   │
             │     Dense(32, GELU) + LayerNormalization(eps=1e-5)│
             └─────────────────────────┬────────────────────────┘
                                       │ Latent Representation (B, 12, 32)
                                       ▼
             ┌──────────────────────────────────────────────────┐
             │  5. Bidirectional LSTM Temporal Decoder (64 units)│
             │     Forward + Backward = 128 channels            │
             │     + Dense(64, GELU) + LayerNormalization       │
             └─────────────────────────┬────────────────────────┘
                                       │ Reconstructed Features (B, 12, 64)
                                       ▼
             ┌──────────────────────────────────────────────────┐
             │  6. Reconstruction Projection Dense Layer        │
             │     Dense(19, linear) -> Predicted Window        │
             └─────────────────────────┬────────────────────────┘
                                       │
                                       ▼
                     Reconstructed Telemetry (B, 12, 19)
```

---

## 2. Structural Deficiencies of Baseline Architecture

The baseline model (`backend/sofc_ai/anomaly_model.py`) employed a simple 2-layer unidirectional LSTM encoder-decoder:
- **Encoder**: `LSTM(64, return_sequences=True)` $\to$ `LSTM(32, return_sequences=False)` $\to$ Latent vector $\mathbf{z} \in \mathbb{R}^{32}$.
- **Decoder**: `RepeatVector(12)` $\to$ `LSTM(32, return_sequences=True)` $\to$ `LSTM(64, return_sequences=True)` $\to$ `Dense(19)`.

### Diagnosed Failure Modes:
1. **Temporal Amnesia**: Unidirectional collapsing of sequence steps into a single 1D vector $\mathbf{z}$ destroyed transient trajectory information. Early-window anomalies were forgotten by step 12.
2. **Single-Channel Anomaly Dilution**: When a localized sensor fault occurred (such as a 30% drop in blower power), averaging Mean Squared Error across all 19 channels diluted the anomaly score by a factor of 19. The anomaly remained below alerting thresholds until catastrophic plant failure occurred.
3. **Vanishing Gradient Bottleneck**: Dense unrolling via `RepeatVector` created an information bottleneck that degraded reconstruction accuracy on normal dynamic operational steps.

---

## 3. Layer-by-Layer Architectural Specifications

### 3.1 Channel Feature Gating (Squeeze-and-Excitation)
The `ChannelFeatureGating` layer dynamically models inter-sensor correlations and recalibrates channel weights:

```python
@keras.saving.register_keras_serializable(package="sofc")
class ChannelFeatureGating(layers.Layer):
    def __init__(self, channels: int = 19, reduction_dim: int = 8, clip_val: float = 10.0, **kwargs):
        super().__init__(**kwargs)
        self.channels = channels
        self.reduction_dim = reduction_dim
        self.clip_val = clip_val
        self.reduce_dense = layers.Dense(reduction_dim, activation="gelu", name="se_reduce")
        self.expand_dense = layers.Dense(channels, activation="sigmoid", name="se_expand")

    def call(self, inputs):
        # inputs shape: (Batch, Sequence=12, Channels=19)
        inputs_clamped = ops.clip(inputs, -self.clip_val, self.clip_val)
        gap = ops.mean(inputs_clamped, axis=1, keepdims=True)  # (Batch, 1, Channels)
        reduced = self.reduce_dense(gap)                       # (Batch, 1, reduction_dim)
        gates = self.expand_dense(reduced)                     # (Batch, 1, Channels)
        return inputs_clamped * gates                          # (Batch, 12, Channels)
```

- **Squeeze**: Global average pooling across time steps compresses temporal length into a 19-dimensional summary vector.
- **Excitation**: Two-stage MLP with GELU bottleneck ($19 \to 8 \to 19$) outputs channel attention weights $g_c \in (0, 1)$.
- **Recalibration**: Input features are scaled channel-wise by $g_c$, boosting fault-sensitive channels while suppressing uninformative noise.

### 3.2 Bidirectional LSTM Temporal Encoder
Industrial time-series signals exhibit backward predictive dependencies (e.g. temperature rise following an earlier air flow drop). Unidirectional LSTMs only observe the past; Bidirectional LSTMs unroll sequences both forward and backward:

$$\overrightarrow{\mathbf{h}}_t = \text{LSTM}_{\text{fwd}}(\widetilde{\mathbf{x}}_t, \overrightarrow{\mathbf{h}}_{t-1}), \quad \overleftarrow{\mathbf{h}}_t = \text{LSTM}_{\text{bwd}}(\widetilde{\mathbf{x}}_t, \overleftarrow{\mathbf{h}}_{t+1})$$

$$\mathbf{H}_t = \text{LayerNorm}\left([\overrightarrow{\mathbf{h}}_t \,\|\, \overleftarrow{\mathbf{h}}_t]\right) \in \mathbb{R}^{128}$$

Using 64 units per direction yields 128 concatenated features per time step. `LayerNormalization` stabilizes recurrent activations across time steps.

### 3.3 Multi-Head Temporal Self-Attention
To capture non-local temporal relationships (e.g. cyclic oscillations and thermal lag delays of 5 to 15 minutes), the encoded sequence is processed by Multi-Head Self-Attention ($H = 4$ heads, key dimension $d_k = 16$):

$$\mathbf{Q} = \mathbf{H}\mathbf{W}_Q, \quad \mathbf{K} = \mathbf{H}\mathbf{W}_K, \quad \mathbf{V} = \mathbf{H}\mathbf{W}_V$$

$$\text{Attention}(\mathbf{Q}, \mathbf{K}, \mathbf{V}) = \text{softmax}\left(\frac{\mathbf{Q}\mathbf{K}^T}{\sqrt{d_k}}\right) \mathbf{V}$$

An intra-block residual skip connection ensures direct gradient flow:

$$\mathbf{H}_{\text{attn}} = \text{LayerNorm}(\mathbf{H} + \text{Dropout}(\text{MultiHead}(\mathbf{Q}, \mathbf{K}, \mathbf{V}), p=0.1))$$

### 3.4 Sequence Latent Bottleneck
Unlike the baseline which collapsed time into a 1D vector, RTA-AE preserves the temporal dimension throughout the bottleneck:

$$\mathbf{Z} = \text{LayerNorm}(\text{GELU}(\mathbf{H}_{\text{attn}} \mathbf{W}_{\text{bot}} + \mathbf{b}_{\text{bot}})) \in \mathbb{R}^{B \times 12 \times 32}$$

This preserves step-by-step trajectory information while forcing the network to compress feature redundancy across channels ($128 \to 32$).

### 3.5 Bidirectional LSTM Decoder & Reconstruction
The decoder reconstructs the 19 telemetry channels from the latent representation:
1. `Bidirectional(LSTM(64, return_sequences=True))` transforms $(B, 12, 32) \to (B, 12, 128)$.
2. `LayerNormalization(eps=1e-5)` stabilizes activations.
3. `Dense(64, activation="gelu")` provides non-linear feature adaptation.
4. `Dense(19)` projects features back to normalized telemetry space $\widehat{\mathbf{X}} \in \mathbb{R}^{B \times 12 \times 19}$.

---

## 4. Parameter Count and Memory Budget

| Layer / Component | Layer Type | Output Tensor Shape | Parameter Count |
|---|---|---|---|
| `telemetry_input` | InputLayer | $(B, 12, 19)$ | 0 |
| `channel_gating` | ChannelFeatureGating | $(B, 12, 19)$ | $19 \times 8 + 8 + 8 \times 19 + 19 = 331$ |
| `enc_bilstm` | Bidirectional(LSTM) | $(B, 12, 128)$ | $2 \times [4 \times (19 + 64 + 1) \times 64] = 43,008$ |
| `enc_norm` | LayerNormalization | $(B, 12, 128)$ | $2 \times 128 = 256$ |
| `temporal_attention` | MultiHeadAttention | $(B, 12, 128)$ | $3 \times (128 \times 64) + (64 \times 128) = 33,024$ |
| `mha_norm` | LayerNormalization | $(B, 12, 128)$ | 256 |
| `bottleneck_dense` | Dense(32, GELU) | $(B, 12, 32)$ | $128 \times 32 + 32 = 4,128$ |
| `latent_norm` | LayerNormalization | $(B, 12, 32)$ | 64 |
| `dec_bilstm` | Bidirectional(LSTM) | $(B, 12, 128)$ | $2 \times [4 \times (32 + 64 + 1) \times 64] = 49,664$ |
| `dec_norm` | LayerNormalization | $(B, 12, 128)$ | 256 |
| `dec_dense` | Dense(64, GELU) | $(B, 12, 64)$ | $128 \times 64 + 64 = 8,256$ |
| `reconstruction` | Dense(19, linear) | $(B, 12, 19)$ | $64 \times 19 + 19 = 1,235$ |
| **Total Model Parameters** | — | — | **140,222** |
| **Trainable Weights** | — | — | **140,222** |
| **Non-Trainable Weights**| — | — | **0** |

**Budget Compliance**: 140,222 parameters is 30% below the system budget limit of 200,000 parameters, ensuring fast CPU inference on edge plant controllers.

---

## 5. Dual-Mode Anomaly Scoring

In real-time inference, the model evaluates both window-wide reconstruction fidelity and peak channel deviations:

$$S_{\text{mean}}(t) = \frac{1}{19 \cdot 12} \sum_{c=1}^{19} \sum_{l=1}^{12} (x_{l, c} - \hat{x}_{l, c})^2$$

$$S_{\text{peak}}(t) = \max_{c \in [1, 19]} \left( \frac{1}{12} \sum_{l=1}^{12} (x_{l, c} - \hat{x}_{l, c})^2 \right)$$

$$S_{\text{composite}}(t) = 0.5 \cdot S_{\text{mean}}(t) + 0.5 \cdot S_{\text{peak}}(t)$$

- **$S_{\text{mean}}$**: Detects global operational drift (e.g. system-wide thermal degradation, gas composition changes).
- **$S_{\text{peak}}$**: Isolates localized single-channel subsystem failures (e.g. blower fade, sensor drift).
- **Attribution**: The channel with $\operatorname{argmax}_c S_{\text{peak}, c}$ determines which subsystem is alerted.
