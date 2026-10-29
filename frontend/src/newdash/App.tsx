import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { AlertsPanel } from "./components/AlertsPanel";
import { DemoPanel } from "./components/DemoPanel";
import { DetailPanel } from "./components/DetailPanel";
import { IngestPanel } from "./components/IngestPanel";
import { ModelPanel } from "./components/ModelPanel";
import { TopBar } from "./components/TopBar";
import { UtilityCard } from "./components/UtilityCard";
import { median } from "./lib/format";
import { useMonitor } from "./useMonitor";

export default function App() {
  const m = useMonitor();
  const { state } = m;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNowMs(Date.now()), 1000); return () => window.clearInterval(t); }, []);

  const cfg = state.config;
  const names = useMemo(() => Object.fromEntries((cfg?.utilities ?? []).map((u) => [u.id, u.name])), [cfg]);
  const alarms = state.alerts.filter((a) => a.severity === "alarm").length;
  const warnings = state.alerts.length - alarms;
  const overall = alarms ? "alarm" : warnings ? "warning" : state.latest ? "ok" : "unknown";

  useEffect(() => { document.title = `${state.alerts.length ? `(${state.alerts.length}) ` : ""}SOFC utility monitor`; }, [state.alerts.length]);

  // data freshness: stale when nothing arrived for 3x the usual gap between evaluated minutes (at least 15 s)
  const gaps = state.tickTimes.slice(1).map((t, i) => (t - state.tickTimes[i]) / 1000);
  const expected = gaps.length ? median(gaps) : 0;
  const age = state.lastMessageAt ? Math.round((nowMs - state.lastMessageAt) / 1000) : null;
  const stale = age !== null && !!state.latest && age > Math.max(15, expected * 3);

  const selected = cfg?.utilities.find((u) => u.id === state.selected) ?? cfg?.utilities[0];

  return (
    <div className="shell">
      <TopBar conn={state.conn} overall={overall} warnings={warnings} alarms={alarms} plantTime={state.latest?.ts ?? null}
        feedStale={stale} feedAgeS={age} simRunning={!!state.sim?.running} />

      {m.error && (
        <div className="banner" role="alert">
          <span>{m.error}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss message" onClick={m.dismissError}><X size={14} /></button>
        </div>
      )}

      <div className="toasts" aria-live="polite">
        {state.toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <span>{t.text}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => m.dismissToast(t.id)}><X size={14} /></button>
          </div>
        ))}
      </div>

      {!cfg || !state.latest ? (
        <main className="waiting">
          <p>{state.conn === "offline" ? "Cannot reach the monitoring server. Start it with the command in the README; this page reconnects by itself." : "Waiting for the first evaluated minute of data…"}</p>
          {cfg && state.sim && !state.sim.running && <button type="button" className="btn btn-primary" onClick={m.simStart}>Start the demo simulator</button>}
        </main>
      ) : (
        <div className="layout">
          <main>
            <h2 className="sr-only">Utilities</h2>
            <div className="grid">
              {cfg.utilities.map((u) => (
                <UtilityCard key={u.id} def={u} tick={state.latest} history={state.history} checks={cfg.checks} channels={cfg.channels}
                  selected={selected?.id === u.id} onSelect={() => m.select(u.id)} />
              ))}
            </div>
            {selected && <DetailPanel key={selected.id} def={selected} config={cfg} tick={state.latest} history={state.history} />}
          </main>
          <aside>
            <AlertsPanel alerts={state.alerts} recent={state.recent} now={state.latest.ts} names={names} onAck={m.ack} onSelect={m.select} />
            <ModelPanel tick={state.latest} history={state.history} info={state.info} />
            <DemoPanel sim={state.sim} names={names} onStart={m.simStart} onStop={m.simStop} onSpeed={m.simInterval} onFault={m.simFault} onClear={m.simClear} />
            <IngestPanel channels={cfg.channels} keyRequired={cfg.api_key_required} />
          </aside>
        </div>
      )}
    </div>
  );
}
