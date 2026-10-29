# SOFC Utility Monitor - Backend Service

High-performance Python service for Solid Oxide Fuel Cell (SOFC) utility monitoring, real-time physics limit checks, Physics-Informed Neural Network (PINN) autoencoders, Aspen Plus digital twin reconciliation, and persistent telemetry retention with MongoDB Atlas.

---

## Architecture Overview

- **FastAPI / Uvicorn**: Asynchronous REST API and WebSocket broadcast server.
- **Physics Engine (`app/checks.py`, `app/thermo.py`)**: 16 real-time mass/energy/electrochemical balance checks (Faraday current, blower laws, cathode heat rise, HRSG flue heat, differential pressure).
- **Learned PINN Detector (`sofc_ai/`)**: Trained Keras autoencoder capturing multivariate drift across all 19 plant telemetry channels with physics loss penalties.
- **Digital Twin & Aspen Reconciliation (`app/aspen_service.py`, `aspen/`)**: Automated reconciliation against Peng-Robinson equation of state and Aspen Plus baseline models.
- **Storage Layer (`app/db.py`)**: Non-blocking asynchronous MongoDB Atlas client with resilient in-memory local fallback buffering.

---

## Setup & Running

### 1. Create Virtual Environment
```bash
python -m venv .venv

# On Linux/macOS:
source .venv/bin/activate

# On Windows (PowerShell):
.\.venv\Scripts\Activate.ps1
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Environment Variables
Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

Key environment options:
- `MONGODB_URI`: MongoDB connection string (leave blank or use local buffer if running offline).
- `SIM_AUTOSTART`: `1` to run the built-in 100 kW plant simulator; `0` when ingesting real PLC data.
- `DISABLE_AE`: `0` to run PINN autoencoder; `1` for physics checks only (if TensorFlow is omitted).
- `CORS_ORIGINS`: Allowed browser origins (e.g. `http://localhost:5173`).

### 4. Start Server
```bash
uvicorn app.main:app --reload --port 8000
```
- API Documentation (Swagger): [http://localhost:8000/docs](http://localhost:8000/docs)
- WebSocket Endpoint: `ws://localhost:8000/ws`

---

## Running Tests

Run the test suite with pytest:
```bash
pytest -v
```
