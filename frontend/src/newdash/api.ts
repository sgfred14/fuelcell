import type { Config, SimState, Alert } from "./types";

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body?.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* keep default message */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown) =>
  j<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const api = {
  config: () => j<Config>("/api/config"),
  ack: (id: number) => post<Alert>(`/api/alerts/${id}/ack`),
  simStart: () => post<SimState>("/api/sim/start"),
  simStop: () => post<SimState>("/api/sim/stop"),
  simInterval: (s: number) => post<SimState>("/api/sim/interval", { interval_s: s }),
  simFault: (fault: string) => post<SimState>("/api/sim/fault", { fault }),
  simClear: () => post<SimState>("/api/sim/clear"),
};
