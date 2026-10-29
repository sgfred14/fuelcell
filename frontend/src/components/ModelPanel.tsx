import { Brain } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { DetectorInfo, HistoryPoint, Tick } from "../types";
import { fmt, fmtClock } from "../lib/format";

interface Props { tick: Tick | null; history: HistoryPoint[]; info: DetectorInfo | null }

/** Score of the trained autoencoder against its alarm threshold, with the signals it currently finds least normal. */
export function ModelPanel({ tick, history, info }: Props) {
  const ae = tick?.ae;
  const thr = ae?.threshold ?? info?.ae_threshold ?? null;
  const data = history.filter((h) => h.ae !== null).slice(-144).map((h) => ({ t: h.ts, score: h.ae }));
  return (
    <section className="panel" aria-labelledby="model-h">
      <h2 id="model-h" className="panel-title"><Brain size={16} aria-hidden="true" /> Learned model</h2>
      {!info?.learned_model && (
        <p className="empty">The trained model is not loaded (TensorFlow or weights missing). Limit checks and sensor checks are still running.</p>
      )}
      {info?.learned_model && (
        <>
          <p className="model-line">
            Normality score <strong className="num">{fmt(ae?.score ?? null, 2)}</strong>
            <span className="muted"> · alarm above {fmt(thr, 2)}</span>
            <span className={`pill ${ae?.flag ? "pill-warn" : "pill-ok"}`}>{ae?.score == null ? "Warming up (needs 1 h of data)" : ae.flag ? "Unusual" : "Normal pattern"}</span>
          </p>
          <div style={{ width: "100%", height: 120 }}>
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="t" tickFormatter={fmtClock} minTickGap={50} stroke="var(--axis)" tick={{ fontSize: 10 }} />
                <YAxis stroke="var(--axis)" tick={{ fontSize: 10 }} width={34} scale="sqrt" domain={[0, "auto"]} tickFormatter={(v: number) => fmt(v, 1)} />
                {thr !== null && <ReferenceLine y={thr} stroke="var(--warn)" strokeDasharray="5 4" />}
                <Line dataKey="score" stroke="#b79cff" strokeWidth={1.8} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {ae && ae.top.length > 0 && (
            <p className="model-top">
              Least normal now: {ae.top.map((t) => `${t.label} (${fmt(t.sigma, 1)}σ)`).join(", ")}
            </p>
          )}
          <p className="fine">The model scores the last hour of operation using 5-minute averages. A score above the line for 15 minutes opens an alert, unless a limit alert is already open.</p>
        </>
      )}
    </section>
  );
}
