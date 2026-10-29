# Physical Rules & Physics-Informed Neural Network (PINN) Formulation

**Document Version**: 1.0.0  
**Target Module**: `backend/sofc_ai/enhanced_physics_penalty.py`  
**Related Modules**: `backend/sofc_ai/physics.py`, `backend/sofc_ai/config.py`, `backend/sofc_ai/plant.py`

---

## 1. The Role of Physics in SOFC Anomaly Detection

In pure data-driven deep learning models, an autoencoder learns representations solely by minimizing reconstruction error over observed data. While effective for common patterns, pure machine learning suffers from three severe flaws in industrial energy systems:
1. **Unphysical Predictions**: Under unseen operating regimes or sensor noise, pure ML can output physically impossible predictions (e.g. electrical power generated without fuel consumption, or negative thermodynamic temperatures).
2. **Poor Generalization**: Pure ML struggles to differentiate between normal operating transients (e.g. load dispatch changes) and genuine equipment degradation (e.g. blower blade fouling).
3. **Black-Box Diagnostics**: A simple reconstruction error indicates *that* an anomaly occurred, but cannot identify *which physical governing law* was violated.

**Physics-Informed Neural Networks (PINNs)** resolve this by embedding first-principles conservation laws directly into the neural network's loss function. The network is constrained to obey electrochemistry, thermodynamics, and fluid dynamics during both training and real-time inference.

```
       Reconstructed Telemetry Tensor (Batch, Sequence=12, Channels=19)
                                       │
                                       ▼
       ┌──────────────────────────────────────────────────────────────┐
       │              EnhancedPhysicsPenalty (Keras 3 Layer)           │
       │  Denormalize to physical units: x_phys = x_norm * std + mean │
       └───────────────────────────────┬──────────────────────────────┘
                                       │
            ┌──────────────────────────┼──────────────────────────┐
            ▼                          ▼                          ▼
     [Electrochemistry]         [Thermodynamics]           [Fluid Mechanics]
     1. Faraday Current         4. Stack Energy Balance    6. Anode-Cathode dP
        r_far = (I - I_calc)/s     r_energy = (Q_in - Q)/s    Overpressure > 15 mbar
     2. Net Power Balance       5. Cathode Temp Rise          Seal Lift-off < -5 mbar
        r_net = (P_net - P_calc)   dT_cath <= 100 K
     3. Fuel Utilization
        0.70 <= U_f <= 0.88
            │                          │                          │
            └──────────────────────────┼──────────────────────────┘
                                       ▼
       ┌──────────────────────────────────────────────────────────────┐
       │          Mathematical Loss Formulations (Differentiable)      │
       │   Equality Laws (1, 2, 4)  --> Decoupled Huber Loss (delta=1)│
       │   Inequality Bounds (3, 5, 6) --> Softplus Barrier (beta=2)  │
       └───────────────────────────────┬──────────────────────────────┘
                                       │
                                       ▼
             Penalized Output / Dynamic Gradient Balancing Update
```

---

## 2. The Six SOFC Physical Governing Laws

All six physical constraints are implemented as fully vectorized, differentiable operations in `backend/sofc_ai/enhanced_physics_penalty.py`:

### Constraint 1: Faraday Current & DC Power Consistency ($r_{\text{far}}$)
- **Physical Law**: Faraday's Law of Electrolysis dictates that the electrical current produced by a fuel cell stack is stoichiometrically proportional to the rate of hydrogen oxidized at the anode:

$$I_{\text{calc}} = \frac{2 \cdot F \cdot \dot{n}_{\text{H}_2} \cdot U_f}{N_{\text{cells}}}$$

Where:
- $F = 96,485.332 \, \text{C/mol}$ (Faraday constant).
- $\dot{n}_{\text{H}_2}$ is the fuel mass flow converted to molar rate ($\text{kmol/s}$): $\dot{n}_{\text{H}_2} = \frac{\dot{m}_{\text{H}_2}}{2.016 \times 3600}$.
- $N_{\text{cells}} = 80$ (number of series cells in stack).
- $U_f$ is target fuel utilization ($0.80$).

- **Residual Formulation**:
$$r_{\text{far}} = \frac{I_{\text{stack}} - I_{\text{calc}}}{\sigma_{I_{\text{stack}}}}$$

- **Penalty Type**: Decoupled Huber loss ($\delta = 1.0$).
- **Physical Significance**: Detects hydrogen fuel leaks, metering inaccuracies, or severe internal electrical shorts.

---

### Constraint 2: Plant Net Electrical Power Balance ($r_{\text{net}}$)
- **Physical Law**: Conservation of electrical energy across the Balance-of-Plant (BoP). The net AC power exported to the facility equals stack gross DC power adjusted for inverter efficiency minus internal auxiliary loads (principally the cathode air blower):

$$P_{\text{net,calc}} = \eta_{\text{inv}} \cdot P_{\text{dc}} - P_{\text{blower}} - P_{\text{parasitic}}$$

Where:
- $\eta_{\text{inv}} = 0.94$ (DC-to-AC inverter conversion efficiency).
- $P_{\text{parasitic}} = 0.65 \, \text{kW}$ (pumps, instrumentation, and control electronics).

- **Residual Formulation**:
$$r_{\text{net}} = \frac{P_{\text{net}} - P_{\text{net,calc}}}{\sigma_{P_{\text{net}}}}$$

- **Penalty Type**: Decoupled Huber loss ($\delta = 1.0$).
- **Physical Significance**: Detects inverter degradation, auxiliary motor friction, or balance-of-plant electrical parasitics.

---

### Constraint 3: Fuel Utilization Box & Setpoint Centering ($r_{u_f}$)
- **Physical Law**: Fuel utilization represents the fraction of incoming hydrogen consumed electrochemically:

$$U_{f,\text{calc}} = \frac{N_{\text{cells}} \cdot I_{\text{stack}}}{2 \cdot F \cdot \dot{n}_{\text{H}_2}}$$

In an operational SOFC:
- If $U_f > 0.88$: Severe fuel starvation occurs, driving local cell voltages negative and causing irreversible oxidation of the nickel-YSZ anode cermet ($\text{Ni} \to \text{NiO}$), destroying the cell.
- If $U_f < 0.70$: Electrical efficiency drops severely, and excess unburned hydrogen overheats downstream afterburners.

- **Residual Formulation**:
$$z_{\text{high}} = \frac{U_{f,\text{calc}} - 0.88}{\sigma_{U_f}}, \quad z_{\text{low}} = \frac{0.70 - U_{f,\text{calc}}}{\sigma_{U_f}}, \quad z_{\text{center}} = \frac{U_{f,\text{calc}} - 0.80}{\sigma_{U_f}}$$

$$r_{u_f} = \mathcal{B}_{\beta}(z_{\text{high}}) + \mathcal{B}_{\beta}(z_{\text{low}}) + 0.1 \cdot \mathcal{L}_{\text{Huber}}(z_{\text{center}})$$

- **Penalty Type**: Asymmetric Softplus barrier ($\beta = 2.0$) on bounds + gentle Huber centering.
- **Physical Significance**: Protects ceramic anodes against catastrophic starvation oxidation.

---

### Constraint 4: Stack Thermal Energy Balance ($r_{\text{energy}}$)
- **Physical Law**: First Law of Thermodynamics (Energy Conservation). Total chemical energy entering via fuel Lower Heating Value (LHV) equals the sum of gross DC electrical power generated, sensible heat enthalpy carried away in the exhaust flue gas, and stack ambient radiation losses:

$$\dot{Q}_{\text{in}} = \dot{n}_{\text{H}_2} \cdot \text{LHV}_{\text{H}_2} \quad (\text{LHV}_{\text{H}_2} = 241.82 \, \text{MJ/kmol})$$

$$\dot{Q}_{\text{flue}} = \dot{m}_{\text{flue}} \cdot \bar{c}_{p,\text{flue}} \cdot (T_{\text{flue,out}} - T_{\text{amb}})$$

$$\dot{Q}_{\text{loss}} = 0.05 \cdot P_{\text{dc}} \quad (\text{natural convective/radiative skin loss})$$

- **Residual Formulation**:
$$r_{\text{energy}} = \frac{\dot{Q}_{\text{in}} - (P_{\text{dc}} + \dot{Q}_{\text{flue}} + \dot{Q}_{\text{loss}})}{\sigma_Q}$$

- **Penalty Type**: Decoupled Huber loss ($\delta = 1.0$).
- **Physical Significance**: Flags thermal insulation loss, unaccounted unburned gas bypass, or catalytic combustion anomalies.

---

### Constraint 5: Cathode Temperature Rise Limit ($r_{\Delta T}$)
- **Physical Law**: Ceramic electrolytes (such as 8YSZ) have low thermal conductivity and are susceptible to brittle fracture under thermal gradients. The air stream cools the stack, but the temperature differential between air inlet and outlet must not exceed $100 \, \text{K}$:

$$\Delta T_{\text{cath}} = T_{\text{ca,out}} - T_{\text{ca,in}}$$

- **Residual Formulation**:
$$z_{\Delta T} = \frac{\Delta T_{\text{cath}} - 100.0}{\sigma_{\Delta T}}$$

$$r_{\Delta T} = \mathcal{B}_{\beta}(z_{\Delta T})$$

- **Penalty Type**: Asymmetric Softplus barrier ($\beta = 2.0$).
- **Physical Significance**: Prevents ceramic membrane microcracking caused by excessive planar thermal stresses.

---

### Constraint 6: Bidirectional Differential Pressure Protection ($r_{\Delta p}$)
- **Physical Law**: Fluid dynamic pressure differential across the ultra-thin ($10 - 20 \, \mu\text{m}$) electrolyte membrane:

$$\Delta p_{\text{an-ca}} = P_{\text{anode}} - P_{\text{cathode}}$$

Two critical failure modes exist:
1. **Positive Overpressure ($\Delta p > 15.0 \, \text{mbar}$)**: High anode pressure risks membrane rupture and catastrophic gas mixing.
2. **Negative Reverse Pressure ($\Delta p < -5.0 \, \text{mbar}$)**: Higher cathode pressure causes compressive glass-ceramic seal lift-off and fuel gas leakage.

- **Residual Formulation**:
$$z_{\text{pos}} = \frac{\Delta p_{\text{an-ca}} - 15.0}{\sigma_{dp}}, \quad z_{\text{neg}} = \frac{-5.0 - \Delta p_{\text{an-ca}}}{\sigma_{dp}}$$

$$r_{\Delta p} = \mathcal{B}_{\beta}(z_{\text{pos}}) + \mathcal{B}_{\beta}(z_{\text{neg}})$$

- **Penalty Type**: Bidirectional asymmetric Softplus barrier ($\beta = 2.0$).
- **Physical Significance**: Guarantees mechanical membrane integrity and structural seal retention.

---

## 3. Dimensional Scaling: Normalizing Physical Units

Physical equations operate in vastly different units:
- Current: $\sim 250 \, \text{A}$
- Power: $\sim 20 \, \text{kW}$
- Fuel Utilization: $\sim 0.80$ (dimensionless fraction)
- Temperature: $\sim 750 \, ^\circ\text{C}$
- Differential Pressure: $\sim 5 \, \text{mbar}$

If unscaled residuals were added directly to the loss function, temperature residuals ($\sim 750$) would dominate fuel utilization residuals ($\sim 0.8$) by a factor of nearly 1,000.

**The Solution**: In `compute_physics_residuals(...)`, every physical residual is scaled by the empirical standard deviation $\sigma_k$ of healthy baseline operations. This transforms every physical constraint into a **dimensionless z-score residual**:

$$r_k = \frac{\Delta \text{Physical Residual}}{\sigma_{\text{baseline}, k}}$$

Under healthy conditions, all scaled residuals satisfy:
$$|r_k| < 0.25$$
During genuine physical faults, the violated residual jumps to:
$$|r_k| > 20.0$$
Providing sharp, calibrated threshold boundaries for automated anomaly detection.

---

## 4. Differentiable Implementation in Keras 3

The `EnhancedPhysicsPenalty` layer is implemented as a native, differentiable Keras 3 layer:

```python
@keras.saving.register_keras_serializable(package="sofc")
class EnhancedPhysicsPenalty(layers.Layer):
    """Custom Keras 3 layer evaluating 6 SOFC physical conservation laws."""
    
    def __init__(self, mean=None, std=None, weights=None, delta=1.0, beta=2.0, **kwargs):
        super().__init__(**kwargs)
        self.mean = mean
        self.std = std
        self.delta = float(delta)
        self.beta = float(beta)
        # 6 adaptive loss multipliers
        self.weights = weights or {"r_far": 1.0, "r_net": 1.0, "r_uf": 1.0, 
                                   "r_energy": 1.0, "r_dT": 1.0, "r_dp": 1.0}

    def call(self, inputs):
        # inputs: (Batch, Sequence, Channels=19)
        residuals = compute_physics_residuals(inputs, mean=self.mean, std=self.std)

        # 1. Decoupled Huber loss on equalities
        loss_far = self.weights["r_far"] * tf.reduce_mean(huber_loss(residuals["r_far"], self.delta))
        loss_net = self.weights["r_net"] * tf.reduce_mean(huber_loss(residuals["r_net"], self.delta))
        loss_energy = self.weights["r_energy"] * tf.reduce_mean(huber_loss(residuals["r_energy"], self.delta))

        # 2. Smooth Softplus barrier potentials on bounds
        loss_uf = self.weights["r_uf"] * tf.reduce_mean(residuals["r_uf"])
        loss_dT = self.weights["r_dT"] * tf.reduce_mean(residuals["r_dT"])
        loss_dp = self.weights["r_dp"] * tf.reduce_mean(residuals["r_dp"])

        total_physics_loss = loss_far + loss_net + loss_energy + loss_uf + loss_dT + loss_dp
        self.add_loss(total_physics_loss)
        return inputs  # Transparent forward pass
```

By adding `self.add_loss(...)`, TensorFlow automatically computes analytical backpropagation gradients through all electrochemical, thermodynamic, and fluid mechanical equations during network optimization.
