import snapshot from "./fixtures/snapshot.json";
import config from "./fixtures/config.json";
import { MAX_HISTORY, initialState, reducer } from "./store";
import type { Alert, Config, Snapshot, Tick } from "./types";

const snap = snapshot as unknown as Snapshot;
const cfg = config as unknown as Config;

function withSnapshot() {
  let s = reducer(initialState, { type: "config", config: cfg });
  s = reducer(s, { type: "snapshot", msg: snap, now: 1000 });
  return s;
}

describe("store", () => {
  it("loads a real server snapshot", () => {
    const s = withSnapshot();
    expect(s.conn).toBe("live");
    expect(s.history.length).toBeGreaterThan(100);
    expect(s.alerts[0].utility).toBe("safety");
    expect(s.alerts[0].severity).toBe("alarm");
    expect(s.latest?.utilities.safety.status).toBe("alarm");
  });

  it("appends ticks, caps history, and raises a toast for a new alarm", () => {
    let s = withSnapshot();
    const base = snap.latest as Tick;
    const alert = { ...(snap.alerts[0] as Alert), id: 99, utility: "air", title: "Blower power vs flow above the 25% alarm limit" };
    const tick: Tick = { ...base, minute: base.minute + 1, alert_events: [{ event: "new", alert }], alerts: [...snap.alerts, alert] };
    s = reducer(s, { type: "tick", msg: tick, now: 2000 });
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0].kind).toBe("alarm");
    expect(s.toasts[0].text).toContain("Cathode air and blower");
    for (let i = 0; i < MAX_HISTORY + 20; i++) s = reducer(s, { type: "tick", msg: { ...tick, alert_events: [] }, now: 3000 + i });
    expect(s.history.length).toBe(MAX_HISTORY);
    expect(s.toasts.length).toBeLessThanOrEqual(4);
  });

  it("moves cleared alerts to the recent list", () => {
    let s = withSnapshot();
    const base = snap.latest as Tick;
    const cleared = { ...(snap.alerts[0] as Alert), status: "cleared" as const, cleared_ts: base.ts };
    s = reducer(s, { type: "tick", msg: { ...base, alerts: [], alert_events: [{ event: "cleared", alert: cleared }] }, now: 5000 });
    expect(s.alerts).toHaveLength(0);
    expect(s.recent[0].id).toBe(cleared.id);
    expect(s.toasts.at(-1)?.kind).toBe("cleared");
  });

  it("acknowledges and dismisses", () => {
    let s = withSnapshot();
    s = reducer(s, { type: "ack", alert: s.alerts[0] });
    expect(s.alerts[0].acknowledged).toBe(true);
    s = reducer(s, { type: "select", id: "air" });
    expect(s.selected).toBe("air");
  });
});
