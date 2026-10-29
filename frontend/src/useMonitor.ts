import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { api } from "./api";
import { initialState, reducer } from "./store";
import type { Snapshot, SimState, Tick } from "./types";

type Msg = Snapshot | Tick | { type: "sim"; sim: SimState } | { type: "ack"; alert: import("./types").Alert };

export function useMonitor() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry = 1000;
    let timer: number | undefined;

    api.config().then((config) => !closed && dispatch({ type: "config", config })).catch((e) => setError(String(e.message ?? e)));

    const connect = () => {
      dispatch({ type: "conn", conn: "connecting" });
      const proto = window.location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => { retry = 1000; setError(null); };
      ws.onmessage = (ev) => {
        let msg: Msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const now = Date.now();
        if (msg.type === "snapshot") dispatch({ type: "snapshot", msg, now });
        else if (msg.type === "tick") dispatch({ type: "tick", msg, now });
        else if (msg.type === "sim") dispatch({ type: "sim", sim: msg.sim });
        else if (msg.type === "ack") dispatch({ type: "ack", alert: msg.alert });
      };
      ws.onclose = () => {
        if (closed) return;
        dispatch({ type: "conn", conn: "offline" });
        timer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 10000);
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => { closed = true; window.clearTimeout(timer); wsRef.current?.close(); };
  }, []);

  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    try { setError(null); return await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); return undefined; }
  }, []);

  return {
    state, error, dismissError: () => setError(null),
    select: (id: string) => dispatch({ type: "select", id }),
    dismissToast: (id: number) => dispatch({ type: "dismissToast", id }),
    ack: (id: number) => run(() => api.ack(id)),
    simStart: () => run(api.simStart),
    simStop: () => run(api.simStop),
    simInterval: (s: number) => run(() => api.simInterval(s)),
    simFault: (f: string) => run(() => api.simFault(f)),
    simClear: () => run(api.simClear),
  };
}
