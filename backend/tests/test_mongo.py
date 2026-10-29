from datetime import datetime, timezone
import math
import numpy as np
import pytest

from app.db import (
    COLL_ALERTS,
    COLL_CALCS,
    COLL_SIMS,
    COLL_TICKS,
    MongoManager,
    OfflineMongoBuffer,
    sanitize_for_mongo,
)
from app import main
from app.main import (
    Batch,
    FaultBody,
    IntervalBody,
    PolarizationParams,
    Reading,
    SimParams,
    SweepParams,
)


def run_coro(coro):
    """Executes a coroutine cleanly to completion."""
    stack = [coro]
    val = None
    while stack:
        try:
            curr = stack[-1]
            if hasattr(curr, "send"):
                sub = curr.send(val)
                val = None
                stack.append(sub)
            else:
                stack.pop()
        except StopIteration as e:
            val = e.value
            stack.pop()
    return val


def test_sanitize_for_mongo():
    raw = {
        "valid": 42.0,
        "nan_val": float("nan"),
        "inf_val": float("inf"),
        "neg_inf": float("-inf"),
        "np_float": np.float64(3.1415),
        "np_int": np.int32(100),
        "nested": {
            "key.with.dots": float("nan"),
            "$dollar_key": 99,
        },
        "ts": datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc),
    }
    clean = sanitize_for_mongo(raw)
    assert clean["valid"] == 42.0
    assert clean["nan_val"] is None
    assert clean["inf_val"] is None
    assert clean["neg_inf"] is None
    assert isinstance(clean["np_float"], float)
    assert clean["np_float"] == pytest.approx(3.1415, rel=1e-3)
    assert isinstance(clean["np_int"], int)
    assert clean["nested"]["key_with_dots"] is None
    assert clean["nested"]["_dollar_key"] == 99
    assert clean["ts"] == "2026-03-01T12:00:00Z"


def test_offline_mongo_buffer_ticks():
    buf = OfflineMongoBuffer(max_records=10)
    for i in range(15):
        buf.insert_tick({
            "minute": i,
            "ts": f"2026-03-01T06:{i:02d}:00Z",
            "overall": "alarm" if i % 5 == 0 else "ok",
        })

    counts = buf.counts()
    assert counts[COLL_TICKS] == 10

    all_ticks = buf.query_ticks(limit=10)
    assert len(all_ticks) == 10
    assert all_ticks[0]["minute"] == 14

    alarms = buf.query_ticks(overall="alarm")
    assert all(t["overall"] == "alarm" for t in alarms)

    ranged = buf.query_ticks(start_ts="2026-03-01T06:10:00Z", end_ts="2026-03-01T06:13:00Z")
    assert all("2026-03-01T06:10:00Z" <= t["ts"] <= "2026-03-01T06:13:00Z" for t in ranged)


def test_offline_mongo_buffer_alerts():
    buf = OfflineMongoBuffer()
    buf.upsert_alert({
        "id": 1,
        "key": "air_ratio_alarm",
        "utility": "air",
        "severity": "warning",
        "title": "Air ratio low",
        "status": "active",
        "first_ts": "2026-03-01T06:00:00Z",
    })

    buf.upsert_alert({
        "id": 1,
        "severity": "alarm",
        "last_ts": "2026-03-01T06:05:00Z",
    })

    res = buf.query_alerts(status="active")
    assert len(res) == 1
    assert res[0]["id"] == 1
    assert res[0]["severity"] == "alarm"
    assert res[0]["title"] == "Air ratio low"

    # Test filtering unacknowledged vs acknowledged
    unacked = buf.query_alerts(status="unacknowledged")
    assert len(unacked) == 1
    acked = buf.query_alerts(status="acknowledged")
    assert len(acked) == 0

    # Mark acknowledged
    buf.upsert_alert({"id": 1, "acknowledged": True, "ack_ts": "2026-03-01T06:10:00Z"},
                     event_entry={"event": "acknowledged", "ts": "2026-03-01T06:10:00Z"})
    acked_now = buf.query_alerts(status="acknowledged")
    assert len(acked_now) == 1
    assert acked_now[0]["acknowledged"] is True
    assert len(acked_now[0].get("history", [])) == 1
    assert acked_now[0]["history"][0]["event"] == "acknowledged"

    buf.upsert_alert({"id": 1, "status": "cleared", "cleared_ts": "2026-03-01T06:15:00Z"})
    cleared = buf.query_alerts(status="cleared")
    assert len(cleared) == 1
    assert cleared[0]["status"] == "cleared"


def test_offline_mongo_buffer_sim_and_calcs():
    buf = OfflineMongoBuffer()
    buf.insert_sim({"action": "fault_injected", "fault": "blower_fade", "timestamp": "2026-03-01T06:00:00Z"})
    buf.insert_calc({"calc_type": "polarization", "created_at": "2026-03-01T06:01:00Z", "params": {"temp": 700}})

    sims = buf.query_simulations()
    assert len(sims) == 1
    assert sims[0]["fault"] == "blower_fade"

    calcs = buf.query_calculations(calc_type="polarization")
    assert len(calcs) == 1
    assert calcs[0]["params"]["temp"] == 700


def test_mongo_manager_tick_ingestion():
    mgr = MongoManager(enabled=True)
    run_coro(mgr.start(start_worker=False))
    try:
        tick = {
            "type": "tick",
            "ts": "2026-03-01T06:00:00Z",
            "minute": 1,
            "values": {"p_net_kw": 85.5, "v_cell_avg_V": 0.78},
            "checks": {"stack_eff": {"value": 0.82, "status": "ok"}},
            "utilities": {"electrical": {"status": "ok"}},
            "overall": "ok",
            "alerts": [],
            "alert_events": [],
        }
        run_coro(mgr.record_tick(tick))

        status = run_coro(mgr.get_status())
        assert status["enabled"] is True
        assert status["stats"]["ticks_queued"] == 1

        ticks = run_coro(mgr.query_ticks(limit=10))
        assert len(ticks) == 1
        assert ticks[0]["minute"] == 1
        assert ticks[0]["values"]["p_net_kw"] == 85.5

        run_coro(mgr.record_sim_event("start", {"running": True}))
        sims = run_coro(mgr.query_simulations())
        assert len(sims) == 1
        assert sims[0]["action"] == "start"

        run_coro(mgr.record_calculation("polarization", {"temp": 700}, {"p_max": 95.0}))
        calcs = run_coro(mgr.query_calculations(calc_type="polarization"))
        assert len(calcs) == 1
        assert calcs[0]["result"]["p_max"] == 95.0

        run_coro(mgr.flush())
        assert mgr.stats["flushes_total"] >= 1
    finally:
        run_coro(mgr.stop())


def test_api_mongo_routes():
    st = run_coro(main.db_status())
    assert "enabled" in st
    assert "mode" in st
    assert "database" in st
    assert "stats" in st

    run_coro(main.mongo_manager.record_tick({
        "type": "tick",
        "ts": "2026-03-01T07:00:00Z",
        "minute": 42,
        "values": {"h2_flow_kg_h": 8.0},
        "checks": {},
        "utilities": {},
        "overall": "ok",
        "alerts": [],
        "alert_events": [],
    }))

    ticks = run_coro(main.db_ticks(limit=10, skip=0))
    assert len(ticks) >= 1

    alerts = run_coro(main.db_alerts(status="all", limit=10, skip=0))
    assert isinstance(alerts, list)

    sims = run_coro(main.db_simulations(limit=10, skip=0))
    assert isinstance(sims, list)

    calcs = run_coro(main.db_calculations(limit=10, skip=0))
    assert isinstance(calcs, list)

    flush_res = run_coro(main.db_flush())
    assert flush_res["flushed"] is True


def test_thermo_routes_record_to_mongo():
    pol_params = PolarizationParams(
        temperature_C=710.0,
        asr_multiplier=1.1,
        degradation_V=0.01,
        fuel_utilization=0.8,
        recycle_ratio=0.5,
        j_min=0.1,
        j_max=1.2,
        n_points=20,
    )
    pol_res = run_coro(main.polarization(pol_params))
    assert "mpp" in pol_res

    # Check that calculation was stored in MongoDB
    calcs = run_coro(main.db_calculations(calc_type="polarization", limit=10))
    assert len(calcs) >= 1
    assert calcs[0]["params"]["temperature_C"] == 710.0

    # Sweep calculation
    sweep_params = SweepParams(
        parameter="temperature",
        min_val=650.0,
        max_val=750.0,
        steps=5,
    )
    sweep_res = run_coro(main.sweep(sweep_params))
    assert len(sweep_res) == 5

    # Check sweep stored in MongoDB
    sweep_calcs = run_coro(main.db_calculations(calc_type="sweep", limit=10))
    assert len(sweep_calcs) >= 1
    assert sweep_calcs[0]["params"]["parameter"] == "temperature"


def test_simulator_events_record_to_mongo():
    # Make sure detector is instantiated
    if main.detector is None:
        main.detector = main.Detector()
    if main.sim is None:
        main.sim = main.Simulator(main.detector, main.broadcast)

    # Test sim interval
    res = run_coro(main.sim_interval(IntervalBody(interval_s=0.2)))
    assert res["interval_s"] == 0.2

    # Check sim event recorded
    sim_events = run_coro(main.db_simulations(limit=10))
    assert any(e["action"] == "interval" for e in sim_events)

    # Test sim params
    res = run_coro(main.sim_params(SimParams(temperature_C=725.0)))
    sim_events = run_coro(main.db_simulations(limit=10))
    assert any(e["action"] == "params_updated" for e in sim_events)


def test_print_connection_status_and_health(capsys):
    from app.db import mask_uri

    # Test URI credential masking
    masked = mask_uri("mongodb+srv://admin:mySecretPass123@cluster0.abcde.mongodb.net/?retryWrites=true")
    assert "mySecretPass123" not in masked
    assert "admin:***@" in masked

    mgr = MongoManager(uri="mongodb+srv://admin:mySecretPass123@cluster0.abcde.mongodb.net/", db_name="sofc_monitor")

    # 1. Test disconnected state print output
    mgr.is_connected = False
    mgr.mode = "offline_buffer"
    mgr.last_error = "Cluster unreachable"
    mgr.print_connection_status()
    out = capsys.readouterr().out
    assert "STATUS: NOT CONNECTED" in out
    assert "Cluster unreachable" in out
    assert "mySecretPass123" not in out

    # 2. Test connected state print output
    mgr.is_connected = True
    mgr.mode = "motor"
    mgr.print_connection_status()
    out = capsys.readouterr().out
    assert "STATUS: CONNECTED" in out
    assert "MOTOR" in out
    assert "sofc_monitor" in out
    assert "mySecretPass123" not in out

    # 3. Test health check reports mongodb connection
    h = main.health()
    assert "mongodb_connected" in h
    assert "mongodb_status" in h
    assert h["mongodb_status"] in ("connected", "disconnected")

    # 4. Test config route includes mongodb status
    cfg = main.config()
    assert "mongodb" in cfg
    assert "connected" in cfg["mongodb"]
    assert "status" in cfg["mongodb"]


def test_alert_logging_and_history_lifecycle(capsys):
    mgr = MongoManager(enabled=True)
    run_coro(mgr.start(start_worker=False))
    try:
        # 1. New alert event
        alert_doc = {
            "id": 101,
            "key": "chk:stack_delta_T",
            "utility": "cooling",
            "severity": "warning",
            "title": "Stack ΔT high",
            "detail": "Stack temperature difference is 115 C (warn > 110 C).",
            "status": "active",
            "acknowledged": False,
        }
        run_coro(mgr.record_alert_event({"event": "new", "alert": alert_doc}))

        out = capsys.readouterr().out
        assert "[MongoDB] Alert #101 [NEW] cooling - WARNING: Stack ΔT high" in out

        # Verify alert stored with history
        alerts = run_coro(mgr.query_alerts(status="active"))
        a101 = next(a for a in alerts if a["id"] == 101)
        assert a101["status"] == "active"
        assert a101["acknowledged"] is False
        assert len(a101.get("history", [])) == 1
        assert a101["history"][0]["event"] == "new"

        # 2. Escalation event
        alert_doc["severity"] = "alarm"
        alert_doc["title"] = "Stack ΔT critical"
        run_coro(mgr.record_alert_event({"event": "escalated", "alert": alert_doc}))

        out = capsys.readouterr().out
        assert "[MongoDB] Alert #101 [ESCALATED] cooling - ALARM: Stack ΔT critical" in out

        alerts = run_coro(mgr.query_alerts(status="active"))
        a101 = next(a for a in alerts if a["id"] == 101)
        assert a101["severity"] == "alarm"
        assert len(a101["history"]) == 2
        assert a101["history"][1]["event"] == "escalated"

        # 3. Acknowledgment
        run_coro(mgr.record_alert_ack(101, alert_doc))

        out = capsys.readouterr().out
        assert "[MongoDB] Alert #101 [ACKNOWLEDGED] by operator" in out

        # Query acknowledged
        acked = run_coro(mgr.query_alerts(status="acknowledged"))
        assert any(a["id"] == 101 for a in acked)
        a101 = next(a for a in acked if a["id"] == 101)
        assert a101["acknowledged"] is True
        assert len(a101["history"]) == 3
        assert a101["history"][2]["event"] == "acknowledged"

        # 4. Cleared event
        alert_doc["status"] = "cleared"
        alert_doc["cleared_ts"] = "2026-03-01T06:30:00Z"
        run_coro(mgr.record_alert_event({"event": "cleared", "alert": alert_doc}))

        out = capsys.readouterr().out
        assert "[MongoDB] Alert #101 [CLEARED] cooling - ALARM: Stack ΔT critical" in out

        cleared = run_coro(mgr.query_alerts(status="cleared"))
        assert any(a["id"] == 101 for a in cleared)

        # 5. Test batch flush logging
        tick = {
            "type": "tick",
            "ts": "2026-03-01T06:30:00Z",
            "minute": 10,
            "values": {"p_net_kw": 80.0},
            "overall": "ok",
        }
        run_coro(mgr.record_tick(tick))
        run_coro(mgr.flush())

        # Test simulation and calculation log outputs
        run_coro(mgr.record_sim_event("fault_injected", {"fault": "blower_fade"}))
        out = capsys.readouterr().out
        assert "[MongoDB] Recorded simulation event: 'fault_injected' to 'simulations'" in out

        run_coro(mgr.record_calculation("polarization", {"temp": 700}, {"p_max": 90.0}))
        out = capsys.readouterr().out
        assert "[MongoDB] Saved calculation 'polarization' to 'thermo_calculations'" in out

    finally:
        run_coro(mgr.stop())


def test_alert_ack_api_flow():
    # Setup detector
    if main.detector is None:
        main.detector = main.Detector()
    main.detector.alerts.active.clear()

    # Raise alert in detector
    ev, alert = main.detector.alerts.raise_or_update(
        key="chk:v_cell_spread",
        ts="2026-03-01T08:00:00Z",
        utility="electrical",
        severity="alarm",
        title="Cell voltage spread high",
        detail="Spread is 0.095 V",
        source="physics",
        value=0.095,
        hint="Check stack health",
    )
    alert_id = alert["id"]

    # Record event in mongo
    run_coro(main.mongo_manager.record_alert_event(dict(event=ev, alert=dict(alert))))

    # Call REST ack endpoint
    ack_res = run_coro(main.ack(alert_id))
    assert ack_res["acknowledged"] is True

    # Query /api/db/alerts for acknowledged
    db_acked = run_coro(main.db_alerts(status="acknowledged"))
    assert any(a["id"] == alert_id for a in db_acked)
    target = next(a for a in db_acked if a["id"] == alert_id)
    assert target["acknowledged"] is True
    assert any(h["event"] == "acknowledged" for h in target.get("history", []))



