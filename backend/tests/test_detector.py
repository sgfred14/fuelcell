from datetime import datetime, timedelta, timezone

import numpy as np
import pytest

from app import checks as K
from app.detector import Detector
from sofc_ai import telemetry

START = "2026-03-01T06:00"
T0 = datetime(2026, 3, 1, 6, 0, tzinfo=timezone.utc)


def feed(det, df, t0=T0):
    events = []
    for i, row in enumerate(df[K.CHANNELS].to_dict("records")):
        for t in det.ingest(t0 + timedelta(minutes=i), row, "test", final=True):
            events += t["alert_events"]
    return events


def test_normal_operation_raises_no_process_alert():
    det = Detector(ae=None)
    for a, d in [(1.0, 0.0), (1.2, 0.02)]:
        det.reset_state()
        ev = feed(det, telemetry.simulate_run("n", 2, 5, a, d, start=START))
        assert [e for e in ev if e["event"] == "new"] == [], [e["alert"]["title"] for e in ev]


@pytest.mark.parametrize("fault,limit_min", [("recycle_loss", 40), ("h2_restriction", 60), ("dp_excursion", 90),
                                             ("blower_fade", 150), ("thermal_gradient", 150), ("sensor_drift", 600)])
def test_fault_is_detected_within_bound(fault, limit_min):
    det = Detector(ae=None)
    f = dict(type=fault, start_min=240, duration_min=1100, ramp_scale=0.25)
    if fault == "sensor_drift":
        f["severity"] = 1.5
    df = telemetry.simulate_run("f", 1, 21, 1.15, 0.015, f, start=START)
    onset = T0 + timedelta(minutes=240)
    first = None
    for i, row in enumerate(df[K.CHANNELS].to_dict("records")):
        ts = T0 + timedelta(minutes=i)
        for t in det.ingest(ts, row, "t", final=True):
            for e in t["alert_events"]:
                if e["event"] == "new" and first is None and ts >= onset:
                    first = (ts - onset).total_seconds() / 60
    assert first is not None and first <= limit_min, f"{fault}: first alert after {first} min"


def test_alert_clears_after_recovery_and_ack():
    det = Detector(ae=None)
    bad = telemetry.simulate_run("b", 1, 3, 1.1, 0.01, dict(type="h2_restriction", start_min=60, duration_min=300, ramp_scale=0.25), start=START)
    good = telemetry.simulate_run("g", 1, 4, 1.1, 0.01, start=START)
    feed(det, bad.iloc[:300])
    act = det.alerts.active_list()
    assert act and any(a["severity"] == "alarm" for a in act)
    assert det.alerts.ack(act[0]["id"])["acknowledged"] is True
    ev = feed(det, good.iloc[300:420], T0 + timedelta(minutes=300))
    assert any(e["event"] == "cleared" for e in ev) and not det.alerts.active_list()


def test_missing_channel_gives_sensor_alert_and_keeps_running():
    det = Detector(ae=None)
    df = telemetry.simulate_run("m", 1, 6, 1.1, 0.01, start=START)
    events = []
    for i, row in enumerate(df[K.CHANNELS].to_dict("records")[:120]):
        if i >= 40:
            row.pop("air_flow_kg_h")
        for t in det.ingest(T0 + timedelta(minutes=i), row, "t", final=True):
            events += t["alert_events"]
    titles = [e["alert"]["title"] for e in events if e["event"] == "new"]
    assert any("Cathode air flow has sent no data" in t for t in titles), titles


def test_out_of_range_and_flatline():
    det = Detector(ae=None)
    df = telemetry.simulate_run("r", 1, 7, 1.1, 0.01, start=START)
    events = []
    for i, row in enumerate(df[K.CHANNELS].to_dict("records")[:90]):
        row["t_flue_out_C"] = 900.0 if i >= 30 else row["t_flue_out_C"]
        row["rh_amb"] = 0.5 if i >= 20 else row["rh_amb"]
        for t in det.ingest(T0 + timedelta(minutes=i), row, "t", final=True):
            events += t["alert_events"]
    titles = [e["alert"]["title"] for e in events if e["event"] == "new"]
    assert any("outside its plausible range" in t for t in titles)
    assert any("has not changed at all" in t for t in titles)


def test_readings_are_averaged_into_minutes_and_late_ones_dropped():
    det = Detector(ae=None)
    ticks = []
    for s in range(0, 120, 10):                                  # a reading every 10 s for 2 minutes, not final
        ticks += det.ingest(T0 + timedelta(seconds=s), {"h2_flow_kg_h": 8.0 + (s % 20) / 100}, "t")
    assert len(ticks) == 1 and abs(ticks[0]["values"]["h2_flow_kg_h"] - 8.05) < 0.02
    assert det.ingest(T0 - timedelta(minutes=5), {"h2_flow_kg_h": 1.0}, "t") == [] and det.stats["late"] == 1


def test_learned_model_loads_and_scores():
    from app.ae import try_load
    ae = try_load()
    if ae is None:
        pytest.skip("TensorFlow not installed")
    df = telemetry.simulate_run("a", 1, 8, 1.1, 0.01, start=START)
    arr = df[ae.channels].to_numpy()[:ae.window * 5].reshape(ae.window, 5, -1).mean(1)
    s, per = ae.score(arr)
    assert np.isfinite(s) and s < ae.threshold and per.shape == (len(ae.channels),)
    bad = arr.copy(); bad[:, ae.channels.index("air_flow_kg_h")] *= 0.6
    assert ae.score(bad)[0] > s


def test_learned_model_does_not_open_second_alert_while_a_limit_alert_is_open():
    from app.ae import try_load
    ae = try_load()
    if ae is None:
        pytest.skip("TensorFlow not installed")
    det = Detector(ae=ae)
    df = telemetry.simulate_run("h", 1, 21, 1.15, 0.015, dict(type="h2_restriction", start_min=120, duration_min=1000, ramp_scale=0.25), start=START)
    events = feed(det, df.iloc[:600])
    new = [e["alert"] for e in events if e["event"] == "new"]
    assert any(a["source"] == "physics" and a["utility"] == "hydrogen" for a in new)
    assert not [a for a in new if a["source"] == "learned" and a["utility"] != "hydrogen"], [a["title"] for a in new]
