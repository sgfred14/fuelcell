"""
Unit & Integration tests for Aspen Integration, AI Energy Management System, and Database tracking.
"""
import json
import pytest
from fastapi.testclient import TestClient

from app.aspen_service import aspen_service, optimize_model_parameters, PATHS
from app.ems import ems_engine
from app.main import app
from app.db import mongo_manager


client = TestClient(app)


def test_aspen_service_baseline_and_pull():
    baseline = aspen_service.get_baseline()
    assert "air_kmol_h" in baseline
    assert baseline["air_kmol_h"] > 0

    pulled, mode = aspen_service.pull_values_from_aspen()
    assert mode in ("com", "simulated")
    for label in PATHS.keys():
        assert label in pulled
        assert pulled[label] is not None


def test_aspen_service_verify_and_run():
    res = aspen_service.verify_and_run()
    assert res["verdict"] in ("PASS", "CHECK_REQUIRED", "FAIL")
    assert res["total_checks"] == len(PATHS)
    assert len(res["verification_table"]) == len(PATHS)
    assert "model_result" in res
    assert "pac" in res["model_result"]
    assert res["model_result"]["pac"] > 0
    assert "comparison" in res
    assert "net_power_ac_kw" in res["comparison"]
    assert "suggestions" in res
    assert len(res["optimal_candidates"]) > 0


def test_aspen_optimizer():
    candidates = optimize_model_parameters({}, objective="eta_el")
    assert len(candidates) > 0
    top = candidates[0]
    assert "score" in top
    assert "params" in top
    assert "vcell" in top["params"]
    assert top["eta_el"] >= 30.0


def test_ems_forecast_and_optimization():
    forecast_data = ems_engine.generate_24h_forecast(base_demand_kw=85.0)
    assert len(forecast_data["forecast_24h"]) == 24
    summary = forecast_data["summary"]
    assert summary["total_demand_kwh"] > 0
    assert summary["total_sofc_generation_kwh"] > 0
    assert summary["total_savings_usd"] >= 0
    assert len(forecast_data["degradation_projection"]) > 0
    assert len(forecast_data["recommendations"]) > 0


def test_api_aspen_endpoints():
    status_resp = client.get("/api/aspen/status")
    assert status_resp.status_code == 200
    status_data = status_resp.json()
    assert "mode" in status_data
    assert "monitored_nodes_count" in status_data

    verify_resp = client.post("/api/aspen/pull-and-verify", json={})
    assert verify_resp.status_code == 200
    verify_data = verify_resp.json()
    assert verify_data["verdict"] in ("PASS", "CHECK_REQUIRED", "FAIL")
    assert len(verify_data["verification_table"]) == len(PATHS)

    optimize_resp = client.post("/api/aspen/optimize", json={"objective": "eta_el"})
    assert optimize_resp.status_code == 200
    opt_data = optimize_resp.json()
    assert "candidates" in opt_data
    assert len(opt_data["candidates"]) > 0

    hist_resp = client.get("/api/aspen/history")
    assert hist_resp.status_code == 200
    hist_data = hist_resp.json()
    assert isinstance(hist_data, list)

    # Test baseline retrieval endpoint
    base_resp = client.get("/api/aspen/baseline")
    assert base_resp.status_code == 200
    base_data = base_resp.json()
    assert "baseline" in base_data
    assert "paths" in base_data


def test_verify_actual_values_mapping():
    """Verifies that actual values in various formats (ref_key, telemetry channel, node path) are correctly mapped."""
    # 1. Using baseline reference keys
    ref_key_values = {
        "air_kmol_h": 89.1,
        "P_blower_kW": 23.4,
        "steam_kg_h": 114.5,
        "T_flue_after_fuel_pre_C": 796.0,
        "T_stack_exit_C": 133.0,
    }
    res1 = aspen_service.verify_and_run(actual_values=ref_key_values)
    assert res1["verdict"] in ("PASS", "CHECK_REQUIRED")
    table1 = {r["item"]: r for r in res1["verification_table"]}
    assert table1["Air to blower (kmol/h)"]["aspen_value"] == 89.1
    assert table1["Air to blower (kmol/h)"]["status"] == "OK"
    assert table1["Air blower brake power (kW)"]["aspen_value"] == 23.4
    assert table1["HRSG steam (kg/h)"]["aspen_value"] == 114.5

    # 2. Using plant telemetry channel names with units (air_flow_kg_h, p_blower_kW, recycle_flow_kmol_h, etc.)
    telemetry_values = {
        "air_flow_kg_h": 2554.4,  # ~89.05 kmol/h
        "recycle_flow_kmol_h": 4.093,  # derives ~1.66 kW
        "p_blower_kW": 23.37,
        "t_an_in_C": 650.0,
        "steam_flow_kg_h": 114.51,
        "t_flue_out_C": 132.69,
    }
    res2 = aspen_service.verify_and_run(actual_values=telemetry_values)
    assert res2["verdict"] in ("PASS", "CHECK_REQUIRED")
    table2 = {r["item"]: r for r in res2["verification_table"]}
    assert abs(table2["Air to blower (kmol/h)"]["aspen_value"] - 89.05) < 0.1
    assert table2["Air to blower (kmol/h)"]["status"] == "OK"
    assert table2["Anode inlet T (C)"]["aspen_value"] == 650.0
    assert abs(table2["Recycle blower power (kW)"]["aspen_value"] - 1.66) < 0.15
    assert table2["Recycle blower power (kW)"]["status"] == "OK"

    # 3. Unit conversions: Kelvin -> °C and Watts -> kW
    si_unit_values = {
        "Flue after air HX (C)": 516.15,  # 243.0 °C in Kelvin
        "Air blower brake power (kW)": 23370.0,  # 23.37 kW in Watts
        "Recycle blower power (kW)": 1662.0,  # 1.66 kW in Watts
        r"\Data\Streams\FLUE-2\Output\TEMP_OUT\MIXED": 516.15,
    }
    res3 = aspen_service.verify_and_run(actual_values=si_unit_values)
    table3 = {r["item"]: r for r in res3["verification_table"]}
    assert abs(table3["Flue after air HX (C)"]["aspen_value"] - 243.0) < 0.5
    assert table3["Flue after air HX (C)"]["status"] == "OK"
    assert abs(table3["Air blower brake power (kW)"]["aspen_value"] - 23.37) < 0.1
    assert table3["Air blower brake power (kW)"]["status"] == "OK"
    assert abs(table3["Recycle blower power (kW)"]["aspen_value"] - 1.66) < 0.1
    assert table3["Recycle blower power (kW)"]["status"] == "OK"

    # 4. Via API endpoint with actual_values
    api_resp = client.post("/api/aspen/pull-and-verify", json={"actual_values": telemetry_values})
    assert api_resp.status_code == 200
    api_data = api_resp.json()
    assert api_data["source_mode"] == "actual_input"
    assert api_data["verdict"] in ("PASS", "CHECK_REQUIRED")


def test_verify_actual_plant_values():
    """Verifies that actual plant telemetry/operating point can be pulled and verified."""
    res = aspen_service.verify_and_run(use_actual_plant_values=True)
    assert res["source_mode"] == "plant_actual"
    assert res["total_checks"] == len(PATHS)
    for row in res["verification_table"]:
        assert row["aspen_value"] is not None
        assert not (row["aspen_value"] != row["aspen_value"])  # not NaN

    # API call with use_actual_plant_values
    api_resp = client.post("/api/aspen/pull-and-verify", json={"use_actual_plant_values": True})
    assert api_resp.status_code == 200
    api_data = api_resp.json()
    assert api_data["source_mode"] == "plant_actual"
    assert api_data["verdict"] in ("PASS", "CHECK_REQUIRED")


def test_aspen_set_baseline_to_plant():
    """Tests setting Aspen values as the baseline results for the SOFC plant model."""
    from sofc_ai import config as C, plant

    orig_res = dict(C.RES)
    orig_streams = json.loads(json.dumps(C.STREAMS))

    try:
        # 1. Custom Aspen baseline values to apply
        custom_aspen_results = {
            "Air to blower (kmol/h)": 92.5,
            "Air blower brake power (kW)": 24.5,
            "HRSG steam (kg/h)": 118.0,
            "Flue to stack (C)": 135.0,
            "P_net_kW": 102.5,
        }

        # Set as baseline through service
        set_res = aspen_service.set_aspen_as_baseline(custom_aspen_results)
        assert set_res["success"] is True
        assert "air_kmol_h" in set_res["baseline"]
        assert set_res["baseline"]["air_kmol_h"] == 92.5
        assert set_res["baseline"]["P_blower_kW"] == 24.5

        # Check plant constants updated
        assert C.RES["air_kmol_h"] == 92.5
        assert abs(C.RES["n_air_kmol_s"] - (92.5 / 3600.0)) < 1e-6
        assert C.RES["P_blower_kW"] == 24.5
        assert C.RES["P_net_kW"] == 102.5
        assert 25.0 <= C.CP_EFF <= 35.0
        assert 0.70 <= C.F_AIR_SHARE <= 0.95

        # Check plant operating point uses new baseline
        op = plant.operating_point(1.0, 30.0)
        assert op["v_cell_V"] > 0.70

        # 2. Test through API endpoint with flat body payload
        api_flat_resp = client.post("/api/aspen/set-baseline", json={
            "air_kmol_h": 91.0,
            "P_blower_kW": 23.8,
        })
        assert api_flat_resp.status_code == 200
        api_flat_data = api_flat_resp.json()
        assert api_flat_data["success"] is True
        assert api_flat_data["baseline"]["air_kmol_h"] == 91.0

        # 3. Test through API endpoint with nested values payload
        api_set_resp = client.post("/api/aspen/set-baseline", json={
            "values": {
                "air_kmol_h": 90.0,
                "P_blower_kW": 23.5,
            }
        })
        assert api_set_resp.status_code == 200
        api_set_data = api_set_resp.json()
        assert api_set_data["success"] is True
        assert api_set_data["baseline"]["air_kmol_h"] == 90.0
    finally:
        # Clean up: restore original baseline
        C.set_baseline({"results": orig_res, "streams_kmol_h": orig_streams}, persist=True)
        aspen_service._baseline_cache = None


def test_plant_model_numerical_stability():
    """Tests plant model robustness under extreme disturbances (low air, high utilization)."""
    from sofc_ai import plant

    # Low air flow should not produce NaNs
    op_low_air = plant.operating_point(1.0, 30.0, n_air=5.0)
    assert not (op_low_air["v_cell_V"] != op_low_air["v_cell_V"])
    assert op_low_air["v_cell_V"] > 0.0

    # High utilization should not produce -inf
    op_high_uf = plant.operating_point(1.0, 30.0, uf_set=0.99)
    assert not (op_high_uf["v_cell_V"] != op_high_uf["v_cell_V"])
    assert op_high_uf["v_cell_V"] > 0.0

    # Nernst inlet temperature check
    from app import thermo
    state = thermo.compute_thermodynamic_state({
        "i_stack_A": 240.0, "v_cell_V": 0.75, "p_dc_kW": 131.6, "p_net_kW": 100.0,
        "h2_flow_kg_h": 8.25, "air_flow_kg_h": 2554.0, "t_ca_in_C": 650.0, "t_ca_out_C": 747.0,
    })
    assert state["available"] is True
    assert 0.90 <= state["nernst_V"] <= 1.05



def test_api_ems_endpoints():
    status_resp = client.get("/api/ems/status")
    assert status_resp.status_code == 200
    status_data = status_resp.json()
    assert status_data["status"] == "active"
    assert "summary" in status_data

    forecast_resp = client.get("/api/ems/forecast?base_demand_kw=90.0")
    assert forecast_resp.status_code == 200
    forecast_data = forecast_resp.json()
    assert len(forecast_data["forecast_24h"]) == 24

    optimize_resp = client.post("/api/ems/optimize", json={"base_demand_kw": 95.0, "h2_cost_usd_kg": 4.20})
    assert optimize_resp.status_code == 200
    opt_data = optimize_resp.json()
    assert "summary" in opt_data
    assert opt_data["summary"]["h2_cost_usd_kg"] == 4.20

    recs_resp = client.get("/api/ems/recommendations")
    assert recs_resp.status_code == 200
    recs = recs_resp.json()
    assert isinstance(recs, list)
    assert len(recs) > 0
