from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import checks as K
from app import main
from sofc_ai import telemetry

T0 = datetime(2026, 3, 1, 6, 0, tzinfo=timezone.utc)


@pytest.fixture()
def client():
    with TestClient(main.app) as c:
        main.detector.reset_state()
        yield c


def readings(n, fault=None, start=0):
    df = telemetry.simulate_run("api", 1, 11, 1.1, 0.01, fault, start="2026-03-01T06:00")
    return [dict(ts=(T0 + timedelta(minutes=start + i)).isoformat(), source="plc-1", values=r)
            for i, r in enumerate(df[K.CHANNELS].to_dict("records")[start:start + n])]


def test_config_lists_six_utilities_and_checks(client):
    cfg = client.get("/api/config").json()
    assert [u["id"] for u in cfg["utilities"]] == ["hydrogen", "air", "cooling", "electrical", "steam", "safety"]
    assert len(cfg["checks"]) == 16 and len(cfg["channels"]) == 19


def test_ingest_batch_updates_state(client):
    r = client.post("/api/ingest?final=true", json={"readings": readings(60)})
    assert r.status_code == 200 and r.json()["minutes_evaluated"] == 60
    st = client.get("/api/state").json()
    assert st["latest"]["minute"] == 60 and st["latest"]["overall"] == "ok"
    assert set(st["latest"]["utilities"]) == {"hydrogen", "air", "cooling", "electrical", "steam", "safety"}


def test_single_reading_and_unknown_channel(client):
    one = readings(1)[0]; one["values"]["made_up"] = 1.0
    r = client.post("/api/ingest?final=true", json=one)
    assert r.status_code == 200 and r.json()["unknown_channels"] == ["made_up"]


def test_bad_bodies_are_rejected(client):
    assert client.post("/api/ingest", json={"values": {}}).status_code == 422
    assert client.post("/api/ingest", json={"values": {"h2_flow_kg_h": "abc"}}).status_code == 422
    assert client.post("/api/ingest", json={}).status_code == 422


def test_api_key_is_enforced_when_configured(client, monkeypatch):
    monkeypatch.setattr(main, "API_KEY", "secret")
    body = {"readings": readings(2)}
    assert client.post("/api/ingest", json=body).status_code == 401
    assert client.post("/api/ingest", json=body, headers={"X-API-Key": "secret"}).status_code == 200


def test_fault_through_http_raises_alarm_ack_and_websocket_push(client):
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "snapshot"
        fault = dict(type="recycle_loss", start_min=60, duration_min=600, ramp_scale=0.25)
        client.post("/api/ingest?final=true", json={"readings": readings(150, fault)})
        msgs = []
        for _ in range(150):
            msgs.append(ws.receive_json())
            if len(msgs) > 140:
                break
        assert any(m["type"] == "tick" and m["alerts"] for m in msgs)
        assert any(e["event"] == "new" for m in msgs if m["type"] == "tick" for e in m["alert_events"])
    alerts = client.get("/api/alerts").json()
    assert alerts and alerts[0]["utility"] == "safety" and alerts[0]["severity"] == "alarm"
    aid = alerts[0]["id"]
    assert client.post(f"/api/alerts/{aid}/ack").json()["acknowledged"] is True
    assert client.post("/api/alerts/9999/ack").status_code == 404
    st = client.get("/api/state").json()
    assert st["latest"]["utilities"]["safety"]["status"] == "alarm"


def test_simulator_endpoints(client):
    assert client.post("/api/sim/fault", json={"fault": "blower_fade"}).status_code == 409      # not running yet
    assert client.post("/api/sim/start").json()["running"] is True
    assert client.post("/api/ingest", json={"readings": readings(1)}).status_code == 409        # no mixing sources
    assert client.post("/api/sim/interval", json={"interval_s": 0.05}).json()["interval_s"] == 0.05
    assert client.post("/api/sim/fault", json={"fault": "nope"}).status_code == 400
    assert client.post("/api/sim/fault", json={"fault": "blower_fade"}).json()["fault"]["type"] == "blower_fade"
    assert client.post("/api/sim/clear").json()["fault"] is None
    assert client.post("/api/sim/stop").json()["running"] is False
