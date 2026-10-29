# Data Generation, Synthetic Fault Injection & Telemetry Pipeline

**Document Version**: 1.0.0  
**Target Modules**: `backend/sofc_ai/telemetry.py`, `backend/sofc_ai/plant.py`, `backend/sofc_ai/config.py`  
**Related Modules**: `backend/app/simulator.py`, `backend/app/detector.py`

---

## 1. Overview of Telemetry Pipeline

In industrial Solid Oxide Fuel Cell systems, catastrophic failures are rare, and physical destructive testing on live commercial fuel cells is prohibitively expensive. Consequently, training and benchmarking anomaly detection algorithms requires a high-fidelity telemetry simulator built upon first-principles electrochemical and thermodynamic models.

The telemetry generation engine in `backend/sofc_ai/telemetry.py` models real-world plant operations:
1. **Quasi-Steady Physical Plant Model**: First-principles electrochemical calculations of cell voltage, Nernst potentials, ohmic/activation polarizations, mass and energy balances.
2. **Controller and Thermal Dynamics**: First-order differential response lags for air delivery, reformer chemistry, and ceramic stack thermal mass.
3. **Environmental and Diurnal Cycles**: Real-world ambient temperature and humidity variations coupled with daily grid electrical demand curves.
4. **Sensor Measurement Noise**: Autoregressive AR(1) temporal noise and random walks simulating sensor drift and quantization.
5. **Injectable Fault Mechanisms**: 6 calibrated industrial fault signatures.

```
       Diurnal Load Demand        Ambient Weather (T, RH)
               │                             │
               ▼                             ▼
       ┌──────────────────────────────────────────────┐
       │     1. Controller & Thermal Response Lags     │
       │        First-order lag filters (tau=5-6 min) │
       └───────────────────────┬──────────────────────┘
                               │
                               ▼
       ┌──────────────────────────────────────────────┐
       │     2. Quasi-Steady Plant Model (plant.py)   │
       │        Faraday stoichiometry, Nernst voltage,│
       │        blower power, heat exchanger balances │
       └───────────────────────┬──────────────────────┘
                               │
        Injectable Faults ────►│ (e.g. blower fade, H2 restriction, etc.)
                               ▼
       ┌──────────────────────────────────────────────┐
       │     3. AR(1) Sensor Noise & Measurement      │
       │        Continuous 1-minute telemetry traces  │
       └───────────────────────┬──────────────────────┘
                               │
                               ▼
       ┌──────────────────────────────────────────────┐
       │     4. Conditioning & Window Buffer          │
       │        5-minute block averaging, Z-score     │
       │        standardization, Sliding Window (L=12)│
       └───────────────────────┬──────────────────────┘
                               │
                               ▼
            Model-Ready Tensor: (Batch, 12, 19)
```

---

## 2. 19-Channel Telemetry Sensor Inventory

The SOFC telemetry stream comprises 19 continuous measurement channels covering electrical, thermal, chemical, and fluid dynamic states:

| Index | Channel Identifier | Physical Description | Engineering Unit | Nominal Steady-State Range |
|:---:|---|---|:---:|:---:|
| 0 | `t_amb_C` | Ambient Air Temperature | $^\circ\text{C}$ | $15.0 - 38.0$ |
| 1 | `rh_amb` | Ambient Relative Humidity | Fraction / % | $0.20 - 0.95$ |
| 2 | `load_set` | Dispatch Electrical Setpoint | kW / Normalized | $0.50 - 1.00$ |
| 3 | `i_stack_A` | Stack DC Current | Amperes (A) | $180.0 - 320.0$ |
| 4 | `v_cell_V` | Average Single-Cell Voltage | Volts (V) | $0.72 - 0.88$ |
| 5 | `p_dc_kW` | Stack Gross DC Power | Kilowatts (kW) | $12.0 - 24.0$ |
| 6 | `p_net_kW` | Plant Net Exported AC Power | Kilowatts (kW) | $10.0 - 21.0$ |
| 7 | `t_an_in_C` | Anode Gas Inlet Temperature | $^\circ\text{C}$ | $680.0 - 750.0$ |
| 8 | `t_ca_in_C` | Cathode Air Inlet Temperature | $^\circ\text{C}$ | $620.0 - 680.0$ |
| 9 | `t_ca_out_C` | Cathode Air Exhaust Temperature | $^\circ\text{C}$ | $720.0 - 780.0$ |
| 10 | `dT_cath_K` | Cathode Temperature Gradient ($\Delta T$) | Kelvin (K) | $60.0 - 100.0$ |
| 11 | `h2_flow_kg_h` | Fuel Stream $\text{H}_2$ Mass Flow | kg/h | $1.10 - 2.10$ |
| 12 | `air_flow_kg_h` | Cathode Air Mass Flow Rate | kg/h | $180.0 - 340.0$ |
| 13 | `recycle_flow_kmol_h` | Anode Off-Gas Recycle Flow | kmol/h | $0.40 - 0.90$ |
| 14 | `steam_flow_kg_h` | Reformer Steam Injection Rate | kg/h | $2.50 - 5.50$ |
| 15 | `dp_an_ca_mbar` | Anode-to-Cathode Differential Pressure | mbar | $0.0 - 8.0$ |
| 16 | `p_blower_kW` | Cathode Air Blower Electric Load | Kilowatts (kW) | $0.80 - 2.50$ |
| 17 | `t_afterburner_C` | Catalytic Combustor Temperature | $^\circ\text{C}$ | $780.0 - 860.0$ |
| 18 | `t_flue_out_C` | Flue Gas Heat Exchanger Outlet | $^\circ\text{C}$ | $110.0 - 160.0$ |

---

## 3. Quasi-Steady Physical Plant Model (`plant.py`)

The telemetry engine models physical operations through quasi-steady state equations:

### 3.1 Electrochemical Cell Voltage Model
The average single-cell voltage $V_{\text{cell}}$ is governed by Nernst equilibrium potential minus kinetic and internal transport losses:

$$V_{\text{cell}} = E_{\text{Nernst}} - \eta_{\text{act}} - \eta_{\text{ohmic}} - \eta_{\text{conc}}$$

Where:
- $E_{\text{Nernst}} = E^\circ + \frac{R T}{2 F} \ln \left(\frac{p_{\text{H}_2} \cdot p_{\text{O}_2}^{0.5}}{p_{\text{H}_2\text{O}}}\right)$
- $\eta_{\text{ohmic}} = j \cdot \text{ASR}(T)$, where $\text{ASR}$ is Area Specific Resistance ($0.25 \, \Omega\cdot\text{cm}^2$).
- Current density $j = \frac{I_{\text{stack}}}{A_{\text{cell}}}$, with active cell area $A_{\text{cell}} = 550 \, \text{cm}^2$.

### 3.2 Mass Flow and Air Delivery
Stoichiometric oxygen demand is multiplied by the excess air ratio $\lambda_{\text{air}} \approx 4.0 - 6.0$ required for convective stack cooling:

$$\dot{m}_{\text{air}} = \lambda_{\text{air}} \cdot \frac{I_{\text{stack}} \cdot N_{\text{cells}}}{4 \cdot F} \cdot \frac{M_{\text{air}}}{0.21}$$

### 3.3 Dynamic Controller Lags
Physical plant actuators cannot respond instantaneously. In `telemetry.py`, commands pass through first-order discrete lag filters:

$$y_t = e^{-1/\tau} \cdot y_{t-1} + (1 - e^{-1/\tau}) \cdot u_t$$

- Load controller response lag: $\tau_{\text{load}} = 5.0 \, \text{minutes}$.
- Air blower delivery lag: $\tau_{\text{blower}} = 6.0 \, \text{minutes}$.

### 3.4 Colored Noise Simulation
Sensors exhibit temporal persistence. Autoregressive AR(1) processes inject realistic colored noise:

$$e_t = \rho \cdot e_{t-1} + \sigma \sqrt{1 - \rho^2} \cdot \mathcal{N}(0, 1)$$

Where $\rho = 0.995$ to $0.999$, ensuring smooth, non-white-noise fluctuations across telemetry traces.

---

## 4. Injectable Fault Mechanisms

The simulator implements 6 realistic industrial fault modes calibrated against known fuel cell failure mechanisms:

```
Fault Magnitude / Severity
       ▲
       │          ┌───────────────────────┐
       │         /                         \
       │        /                           \
       │       /                             \
       │      /                               \
       └─────┴─────────────────────────────────┴────────► Time (minutes)
           start_min   ramp_up              dur   ramp_down
```

### 4.1 Blower Fade (`fault_code = 1`)
- **Mechanism**: Mechanical bearing wear, impeller fouling, or inverter frequency attenuation on the cathode air blower.
- **Physical Signature**:
  - Blower electric power $P_{\text{blower}}$ increases or saturates.
  - Delivered air flow $\dot{m}_{\text{air}}$ fails to reach setpoint during peak load demands.
  - Convective cooling degrades, driving cathode temperature rise $\Delta T_{\text{cath}}$ past $100 \, \text{K}$.
- **Ramp Duration**: 480 minutes (slow progressive degradation).

### 4.2 Hydrogen Fuel Restriction (`fault_code = 2`)
- **Mechanism**: Partial valve blockage, regulator freeze, or upstream reformer pressure loss.
- **Physical Signature**:
  - Hydrogen flow $\dot{m}_{\text{H}_2}$ drops below stoichiometric requirements.
  - Fuel utilization $U_f$ climbs toward critical limits ($> 88\%$).
  - Cell voltage drops sharply due to concentration polarization (anode starvation).
- **Ramp Duration**: 120 minutes.

### 4.3 Anode Recycle Loss (`fault_code = 3`)
- **Mechanism**: Recycle blower trip or check valve failure in the anode off-gas loop.
- **Physical Signature**:
  - Recycle molar flow drops ($0.7 \to 0.2 \, \text{kmol/h}$).
  - Water/steam return to the reformer drops, shifting Steam-to-Carbon (S/C) ratio into coking risk regimes.
  - Thermal energy distribution between stack and afterburner shifts.
- **Ramp Duration**: 60 minutes.

### 4.4 Differential Pressure Excursion (`fault_code = 4`)
- **Mechanism**: Pulsing in anode exhaust backpressure control valve or intermittent condensate trap blockage.
- **Physical Signature**:
  - Periodic spike oscillations in $\Delta p_{\text{an-ca}}$ ($> 25 \, \text{mbar}$).
  - High risk of ceramic electrolyte mechanical fracture or glass-ceramic seal blowout.
- **Duration**: Intermittent spikes spaced every 360 minutes.

### 4.5 Thermal Maldistribution / Flow Gradient (`fault_code = 5`)
- **Mechanism**: Channel clogging or manifold flow maldistribution across the 80 stack cells.
- **Physical Signature**:
  - Air flow appears normal at the boundary, but effective stack cooling is impaired.
  - Measured cathode outlet temperature $T_{\text{ca,out}}$ exceeds thermodynamic energy balance predictions.
- **Ramp Duration**: 360 minutes.

### 4.6 Thermocouple Sensor Drift (`fault_code = 6`)
- **Mechanism**: Calibration drift in the cathode outlet thermocouple (electrical fault only; plant remains physically healthy).
- **Physical Signature**:
  - $T_{\text{ca,out}}$ drifts upward by $+25 \, ^\circ\text{C}$ over hours.
  - Physical energy conservation residuals flag a violation while electrochemical power and current remain unchanged.
- **Ramp Duration**: Continuous linear ramp.

---

## 5. Telemetry Conditioning & Window Buffer Pipeline

Before telemetry enters the neural network, it passes through conditioning:

```python
# 1. Block Downsampling & Aggregation
# Raw 1-minute telemetry is aggregated into 5-minute averages:
df_5min = df_raw.resample("5min", on="timestamp").mean().dropna()

# 2. Z-Score Standardization
# Baseline statistics derived from healthy nominal operation (meta.json):
mean_vec = np.array(meta["mean"], dtype=np.float32)  # (19,)
std_vec = np.array(meta["std"], dtype=np.float32)    # (19,)

X_norm = (df_5min[CHANNELS].values - mean_vec) / std_vec

# 3. Sliding Window Formation
# Window length L = 12 steps (60 minutes), stride S = 1 step (5 minutes)
windows = []
for i in range(len(X_norm) - 12 + 1):
    windows.append(X_norm[i : i + 12])
X_windows = np.array(windows, dtype=np.float32)  # Shape: (N, 12, 19)
```

### Data Pipeline Quality Guarantees:
- **Missing Value Handling**: Forward-filled up to 5 minutes; if a channel remains missing for $>5$ minutes, an upstream stale-sensor alarm is triggered and autoencoder evaluation is safely bypassed.
- **Clipping Protection**: Normalized values are bounded within $[-10.0, 10.0]$ during feature gating to prevent numerical overflow from transient sensor spikes.
