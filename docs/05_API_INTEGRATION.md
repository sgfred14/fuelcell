# API & Real-Time System Integration

**Document Version**: 1.0.0  
**Target Modules**: `backend/app/main.py`, `backend/app/ae.py`, `backend/app/detector.py`  
**Related Modules**: `backend/app/simulator.py`, `backend/app/alerts.py`, `backend/sofc_ai/optimized_anomaly_model.py`

---

## 1. FastAPI System Architecture

The SOFC monitoring backend is powered by **FastAPI** (`backend/app/main.py`), designed for high-concurrency SCADA telemetry ingestion, real-time physics and deep learning anomaly scoring, alerting, and low-latency WebSocket broadcasting to operational dashboards.

```
                  Industrial Plant SCADA / Simulator
                                  │
                                  ▼
                     HTTP POST /api/telemetry
                                  │
                                  ▼
      ┌─────────────────────────────────────────────────────────┐
      │          FastAPI Async Ingestion Controller             │
      │   Pydantic validation, NaN/Inf sanitization, MongoDB    │
      └───────────────────────────┬─────────────────────────────┘
                                  │
                                  ▼
      ┌─────────────────────────────────────────────────────────┐
      │            Streaming Detector (detector.py)             │
      │   1-minute rolling averages, forward-fill (stale > 5m)  │
      └─────────────┬─────────────────────────────┬─────────────┘
                    │                             │
    Every 1 minute  ▼                             ▼  Every 5 minutes
 ┌──────────────────────────────┐  ┌──────────────────────────────┐
 │   16 Hard Physics Checks     │  │  Deep Learning Autoencoder   │
 │   Voltage, Temp, Fuel Util,  │  │  (RTA-AE / AEModel wrapper)  │
 │   Differential Pressure      │  │  12-step window (1 hour)     │
 └──────────────┬───────────────┘  └──────────────┬───────────────┘
                │                                 │
                └───────────────┬─────────────────┘
                                │
                                ▼
      ┌─────────────────────────────────────────────────────────┐
      │            Alert Manager (alerts.py)                    │
      │   3 consecutive out-of-band steps (15 min) -> ALARM     │
      │   Dual confirmation: Physics check + ML attribution     │
      └───────────────────────────┬─────────────────────────────┘
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
      WebSocket Broadcast (/ws)            REST Endpoints (/api/...)
      Real-Time Front-End UI               External SCADA / Historian
```

---

## 2. Model Lifecycle & Non-Destructive Loading

The neural network model is loaded asynchronously during the application lifespan startup (`backend/app/main.py`):

```python
@asynccontextmanager
async def lifespan(app):
    global detector, sim
    # Non-blocking async loading of model weights into memory
    ae_model = None if os.environ.get("DISABLE_AE") == "1" else await asyncio.to_thread(try_load)
    detector = Detector(ae=ae_model)
    sim = Simulator(detector, broadcast)
    log.info("Learned-model detector: %s", "ON" if detector.ae else "OFF (Physics checks only)")
    if os.environ.get("SIM_AUTOSTART", "1") == "1":
        sim.start()
    yield
    sim.stop()
```

### 2.1 Graceful Fallback Guarantee
In environments where TensorFlow/Keras or GPU accelerators are unavailable, `try_load()` in `backend/app/ae.py` catches the import exception and gracefully degrades the system to **pure physics-check mode**. The server continues monitoring the plant without crashes.

### 2.2 Warm-Up Graph Compilation
During `AEModel.__init__`, a warm-up inference pass is executed using the baseline mean vector:
```python
self.score(np.tile(self.mean, (self.window, 1)))
```
This forces TensorFlow/XLA to trace and compile the computation graph before live telemetry arrives, eliminating cold-start latency spikes.

---

## 3. Streaming Anomaly Detection Workflow

### Step 1: Ingestion & Minute Buffering
- Raw readings from SCADA arrive at any arbitrary frequency (e.g. 1 Hz to 10 Hz).
- `Detector.feed_reading(...)` bins incoming samples into 1-minute averages.
- Missing channels are forward-filled for up to 5 minutes before triggering a `SensorStale` alert.

### Step 2: Per-Minute Physics Evaluation
- Evaluates 16 first-principles boundary checks (`backend/app/checks.py`).
- Requires **3 consecutive minutes** out-of-band before triggering an alert, and **8 consecutive minutes** in-band before clearing, preventing alarm chatter.

### Step 3: 5-Minute Autoencoder Window Scoring
- Every 5 minutes, the detector extracts the last 12 five-minute averages ($L = 12$ steps $= 60$ minutes).
- Passes the $(12, 19)$ array to the autoencoder:
  ```python
  score, per_channel_rmse = self.ae.score(window_raw)
  ```
- **Alert Attribution**: If $S_{\text{score}} > \text{threshold}$ for **3 consecutive evaluation cycles** (15 minutes), an anomaly alert is raised.
- **Root-Cause Attribution**: The channel with the largest normalized reconstruction error is mapped to its associated plant utility subsystem (e.g. `air_flow_kg_h` $\to$ Blower Subsystem).
- **Dual Confirmation**: If a physics check is already open for that utility, the deep learning model marks it as *confirmed*, increasing alert confidence to `CRITICAL`.

---

## 4. Key REST API Endpoints

### 4.1 Ingest Telemetry
- **Endpoint**: `POST /api/telemetry`
- **Description**: Ingests instantaneous plant sensor readings.
- **Request Payload**:
```json
{
  "timestamp": "2026-10-29T10:00:00Z",
  "readings": {
    "t_amb_C": 25.4,
    "rh_amb": 0.55,
    "load_set": 0.85,
    "i_stack_A": 240.2,
    "v_cell_V": 0.782,
    "p_dc_kW": 15.03,
    "p_net_kW": 13.48,
    "t_an_in_C": 710.2,
    "t_ca_in_C": 645.0,
    "t_ca_out_C": 742.1,
    "dT_cath_K": 97.1,
    "h2_flow_kg_h": 1.52,
    "air_flow_kg_h": 265.4,
    "recycle_flow_kmol_h": 0.62,
    "steam_flow_kg_h": 3.85,
    "dp_an_ca_mbar": 3.4,
    "p_blower_kW": 1.45,
    "t_afterburner_C": 815.0,
    "t_flue_out_C": 132.5
  }
}
```
- **Response**: `200 OK`
```json
{
  "status": "accepted",
  "minute_completed": true,
  "active_alerts_count": 0
}
```

---

### 4.2 System Status & Model Health
- **Endpoint**: `GET /api/status`
- **Description**: Returns live operating status, active alerts, and autoencoder health.
- **Response**: `200 OK`
```json
{
  "plant_state": "RUNNING",
  "learned_model": {
    "enabled": true,
    "architecture": "Residual Temporal-Attention Autoencoder (RTA-AE)",
    "threshold": 0.185,
    "last_score": 0.042,
    "status": "HEALTHY",
    "evaluation_interval_minutes": 5
  },
  "active_alerts": [],
  "uptime_seconds": 84600
}
```

---

### 4.3 Active Alarms & Diagnostics
- **Endpoint**: `GET /api/alerts`
- **Description**: Lists currently active alarms with severity rankings and root-cause attributions.
- **Response**: `200 OK`
```json
{
  "active": [
    {
      "id": "alert-1042",
      "severity": "WARNING",
      "utility": "Cathode Air Blower",
      "type": "LEARNED_MODEL_CONFIRMATION",
      "message": "Air flow deficit relative to stack current demand",
      "top_deviating_channel": "air_flow_kg_h",
      "channel_rmse": 2.84,
      "opened_at": "2026-10-29T09:45:00Z",
      "physics_violations": ["r_far", "r_net"]
    }
  ]
}
```

---

## 5. WebSocket Real-Time Telemetry Streaming

- **Endpoint**: `WS /ws/telemetry`
- **Description**: Bi-directional real-time WebSocket connection for browser front-ends.
- **Message Format**: Dispatches a JSON packet every finished minute:
```json
{
  "type": "tick",
  "timestamp": "2026-10-29T10:00:00Z",
  "telemetry": { ... 19 channel values ... },
  "ae_scoring": {
    "score": 0.0412,
    "threshold": 0.185,
    "flag": false,
    "top_channel": "p_blower_kW",
    "top_rmse": 0.082
  },
  "physics_residuals": {
    "r_far": 0.065,
    "r_net": 0.052,
    "r_uf": 0.031,
    "r_energy": 0.124,
    "r_dT": 0.0,
    "r_dp": 0.0
  },
  "alerts_count": 0
}
```

---

## 6. How to Integrate the Optimized RTA-AE Model

To swap or run the optimized RTA-AE model in place of the baseline model, the model wrapper in `backend/app/ae.py` supports configuration via environment variables:

```python
# In backend/app/ae.py:
class AEModel:
    def __init__(self, path=MODEL_DIR):
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
        use_optimized = os.environ.get("USE_OPTIMIZED_AE", "0") == "1"
        
        meta = json.loads((Path(path) / "meta.json").read_text())
        self.channels = meta["channels"]
        self.window = int(meta["window"])
        self.mean = np.array(meta["mean"], np.float32)
        self.std = np.array(meta["std"], np.float32)
        self.threshold = float(meta["thresholds"]["pinn"]["ae"])
        
        if use_optimized:
            from sofc_ai import optimized_anomaly_model as OAM
            self.model = OAM.build_optimized_ae(self.mean, self.std)
            # Load optimized weights if present, or use baseline weights
        else:
            from sofc_ai import anomaly_model as AM
            self.model = AM.build_ae(self.mean, self.std, float(meta["physics_weight"]))
            self.model.load_weights(Path(path) / "ae_pinn.weights.h5")
            
        self.score(np.tile(self.mean, (self.window, 1)))  # Graph compilation
```

Because both models adhere to the identical shape contract:
$$\text{Input: } (B, 12, 19) \implies \text{Output: } (B, 12, 19)$$
the change is completely transparent to the upstream `Detector`, `AlertManager`, and FastAPI route handlers.
