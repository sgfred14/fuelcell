import type { Alert, AlertEvent, Config, HistoryPoint, SimState, Snapshot, Tick, DetectorInfo } from "./types";

export const MAX_HISTORY = 720;
export const MAX_RECENT = 50;

export type Conn = "connecting" | "live" | "offline";

export interface Toast {
  id: number;
  kind: "alarm" | "warning" | "cleared";
  text: string;
}

export interface State {
  config: Config | null;
  conn: Conn;
  latest: Tick | null;
  history: HistoryPoint[];
  alerts: Alert[];
  recent: Alert[];
  sim: SimState | null;
  info: DetectorInfo | null;
  toasts: Toast[];
  toastSeq: number;
  selected: string;
  tickTimes: number[];
  lastMessageAt: number | null;
}

export const initialState: State = {
  config: null, conn: "connecting", latest: null, history: [], alerts: [], recent: [], sim: null, info: null,
  toasts: [], toastSeq: 0, selected: "hydrogen", tickTimes: [], lastMessageAt: null,
};

export type Action =
  | { type: "config"; config: Config }
  | { type: "conn"; conn: Conn }
  | { type: "snapshot"; msg: Snapshot; now: number }
  | { type: "tick"; msg: Tick; now: number }
  | { type: "sim"; sim: SimState }
  | { type: "ack"; alert: Alert }
  | { type: "select"; id: string }
  | { type: "dismissToast"; id: number };

function toastsFor(events: AlertEvent[], names: Record<string, string>, seq: number): { toasts: Toast[]; seq: number } {
  const out: Toast[] = [];
  for (const e of events) {
    if (e.event === "new" || e.event === "escalated") {
      out.push({ id: ++seq, kind: e.alert.severity, text: `${e.alert.severity === "alarm" ? "Alarm" : "Warning"}: ${names[e.alert.utility] ?? "Plant"}, ${e.alert.title}` });
    } else if (e.event === "cleared") {
      out.push({ id: ++seq, kind: "cleared", text: `Cleared: ${e.alert.title}` });
    }
  }
  return { toasts: out, seq };
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "config":
      return { ...s, config: a.config, info: s.info ?? a.config.info };
    case "conn":
      return { ...s, conn: a.conn };
    case "snapshot":
      return {
        ...s, conn: "live", latest: a.msg.latest, history: a.msg.history.slice(-MAX_HISTORY), alerts: a.msg.alerts,
        recent: a.msg.recent_alerts, info: a.msg.info, sim: a.msg.sim ?? s.sim, toasts: [], tickTimes: [], lastMessageAt: a.now,
      };
    case "tick": {
      const m = a.msg;
      const names = Object.fromEntries((s.config?.utilities ?? []).map((u) => [u.id, u.name]));
      const t = toastsFor(m.alert_events, names, s.toastSeq);
      const cleared = m.alert_events.filter((e) => e.event === "cleared").map((e) => e.alert);
      const point: HistoryPoint = { ts: m.ts, v: m.values, c: Object.fromEntries(Object.entries(m.checks).map(([k, x]) => [k, x.value])), ae: m.ae.score, meta: m.meta };
      return {
        ...s, conn: "live", latest: m, alerts: m.alerts, history: [...s.history, point].slice(-MAX_HISTORY),
        recent: [...cleared, ...s.recent].slice(0, MAX_RECENT), toasts: [...s.toasts, ...t.toasts].slice(-4), toastSeq: t.seq,
        tickTimes: [...s.tickTimes, a.now].slice(-12), lastMessageAt: a.now,
      };
    }
    case "sim":
      return { ...s, sim: a.sim };
    case "ack":
      return { ...s, alerts: s.alerts.map((x) => (x.id === a.alert.id ? { ...x, acknowledged: true } : x)) };
    case "select":
      return { ...s, selected: a.id };
    case "dismissToast":
      return { ...s, toasts: s.toasts.filter((t) => t.id !== a.id) };
    default:
      return s;
  }
}
