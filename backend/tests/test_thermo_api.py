import pytest
from fastapi.testclient import TestClient
from app import main


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        if main.detector:
            main.detector.reset_state()
        yield c


def test_polarization_endpoint(client):
    r = client.post("/api/polarization", json={
        "temperature_C": 700.0,
        "asr_multiplier": 1.12,
        "degradation_V": 0.012,
        "fuel_utilization": 0.80,
        "recycle_ratio": 0.50,
        "j_min": 0.05,
        "j_max": 1.40,
        "n_points": 50,
    })
    assert r.status_code == 200
    data = r.json()
    assert len(data["j_range"]) == 50
    assert len(data["v_cell"]) == 50
    assert len(data["i_stack"]) == 50
    assert len(data["v_nernst"]) == 50
    assert len(data["eta_ohmic"]) == 50
    assert len(data["eta_act"]) == 50
    assert len(data["eta_conc"]) == 50
    assert len(data["p_dc"]) == 50
    assert "mpp" in data
    assert data["mpp"]["p_dc"] > 50.0
    # OCV should be higher than loaded cell voltage
    assert data["v_nernst"][0] > data["v_cell"][0]
    # Ohmic loss increases with current
    assert data["eta_ohmic"][-1] > data["eta_ohmic"][0]


def test_thermodynamic_endpoint(client):
    r = client.get("/api/thermodynamic")
    assert r.status_code == 200
    data = r.json()
    assert data["available"] is True
    assert data["nernst_V"] is not None and data["nernst_V"] > 0.8
    assert data["efficiency_rev_pct"] is not None
    assert data["efficiency_electrical_pct"] is not None


def test_thermodynamic_calculate_endpoint(client):
    r = client.post("/api/thermodynamic/calculate", json={
        "temperature_C": 750.0,
        "asr_multiplier": 1.0,
        "degradation_V": 0.0,
        "fuel_utilization": 0.75,
        "recycle_ratio": 0.50,
    })
    assert r.status_code == 200
    data = r.json()
    assert data["available"] is True
    assert data["v_cell_V"] is not None and data["v_cell_V"] > 0.70


def test_sweep_endpoint(client):
    r = client.post("/api/sweep", json={
        "parameter": "temperature",
        "min_val": 650.0,
        "max_val": 750.0,
        "steps": 5,
        "load_set": 0.8,
    })
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 5
    assert all("v_cell_V" in p and "efficiency_pct" in p for p in data)


def test_sim_params_endpoint(client):
    r = client.post("/api/sim/params", json={
        "load": 0.90,
        "temperature_C": 720.0,
        "asr_multiplier": 1.25,
    })
    assert r.status_code == 200
    st = r.json()
    assert st["slider_params"]["load"] == 0.90
    assert st["slider_params"]["temperature_C"] == 720.0

    # Reset
    r_reset = client.post("/api/sim/params", json={"reset": True})
    assert r_reset.status_code == 200
    assert r_reset.json()["slider_params"] == {}
