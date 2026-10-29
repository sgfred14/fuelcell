import { FlaskConical, Play, Square } from "lucide-react";
import type { SimState } from "../types";
import { fmtClock, fmtDuration } from "../lib/format";

const SPEEDS = [{ s: 1.0, l: "Slow" }, { s: 0.5, l: "Normal" }, { s: 0.25, l: "Fast" }, { s: 0.1, l: "Very fast" }];

interface Props {
  sim: SimState | null;
  names: Record<string, string>;
  onStart: () => void;
  onStop: () => void;
  onSpeed: (s: number) => void;
  onFault: (f: string) => void;
  onClear: () => void;
}

export function DemoPanel({ sim, names, onStart, onStop, onSpeed, onFault, onClear }: Props) {
  if (!sim) return null;
  const f = sim.fault;
  return (
    <section className="panel" aria-labelledby="demo-h">
      <h2 id="demo-h" className="panel-title"><FlaskConical size={16} aria-hidden="true" /> Demo simulator</h2>
      <p className="fine">Plays a simulated plant through the same code path as the HTTP endpoint. Stop it before sending real readings.</p>
      <div className="row">
        {sim.running ? (
          <button type="button" className="btn" onClick={onStop}><Square size={14} aria-hidden="true" /> Stop</button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onStart}><Play size={14} aria-hidden="true" /> Start demo</button>
        )}
        <label className="select">
          <span>Speed</span>
          <select value={sim.interval_s} onChange={(e) => onSpeed(Number(e.target.value))}>
            {SPEEDS.map((x) => <option key={x.s} value={x.s}>{x.l}</option>)}
            {!SPEEDS.some((x) => x.s === sim.interval_s) && <option value={sim.interval_s}>{sim.interval_s}s / plant min</option>}
          </select>
        </label>
      </div>

      <h3 className="sub">Inject a fault</h3>
      <div className="faults">
        {Object.entries(sim.faults).map(([id, x]) => (
          <button key={id} type="button" className={`btn btn-fault${f?.type === id ? " on" : ""}`} disabled={!sim.running} onClick={() => onFault(id)} title={x.text}>
            {x.label}
          </button>
        ))}
        <button type="button" className="btn" disabled={!sim.running || !f} onClick={onClear}>Clear fault</button>
      </div>

      {f && (
        <div className="faultbox" aria-live="polite">
          <p><strong>Injected:</strong> {f.label} at {fmtClock(f.injected_ts)}</p>
          <p>
            {f.first_alert_ts
              ? <>First alert after <strong>{fmtDuration(f.delay_min ?? 0)}</strong> of plant time: {f.first_alert}</>
              : "Waiting for the first alert…"}
          </p>
          <p className="fine">Expected utility: {names[sim.faults[f.type]?.utility] ?? "-"}. The detector is never told which fault is running.</p>
        </div>
      )}
    </section>
  );
}
