import { useState } from "react";
import type { Config, HistoryPoint, Tick, UtilityDef } from "../types";
import { CHARTS } from "../lib/charts";
import { bandText, fmtUnit } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { TrendChart } from "./TrendChart";

const WINDOWS = [{ label: "1 h", n: 60 }, { label: "4 h", n: 240 }, { label: "12 h", n: 720 }];

interface Props { def: UtilityDef; config: Config; tick: Tick | null; history: HistoryPoint[] }

export function DetailPanel({ def, config, tick, history }: Props) {
  const [win, setWin] = useState(240);
  const checks = config.checks.filter((c) => def.checks.includes(c.id));
  const data = history.slice(-win);
  return (
    <section className="panel detail" aria-labelledby="detail-h">
      <div className="detail-head">
        <h2 id="detail-h" className="panel-title">{def.name}: checks and trends</h2>
        <div className="seg" role="group" aria-label="Trend window">
          {WINDOWS.map((w) => (
            <button key={w.n} type="button" aria-pressed={win === w.n} className={win === w.n ? "on" : ""} onClick={() => setWin(w.n)}>{w.label}</button>
          ))}
        </div>
      </div>

      <div className="scroll-x">
        <table className="checks-table">
          <thead>
            <tr><th>Check</th><th>Now</th><th>Warning when</th><th>Alarm when</th><th>Status</th></tr>
          </thead>
          <tbody>
            {checks.map((c) => {
              const st = tick?.checks[c.id];
              return (
                <tr key={c.id} className={`row-${st?.status ?? "unknown"}`}>
                  <td>
                    <strong>{c.label}</strong>
                    <span className="what">{c.what}</span>
                    {st && st.status !== "ok" && st.status !== "unknown" && <span className="whatnow">What to check: {c.hint}</span>}
                  </td>
                  <td className="num">{fmtUnit(st?.value ?? null, c.unit, c.decimals)}</td>
                  <td className="num muted">{bandText(c.warn_lo, c.warn_hi, c.unit, c.decimals)}</td>
                  <td className="num muted">{bandText(c.alarm_lo, c.alarm_hi, c.unit, c.decimals)}</td>
                  <td><StatusBadge status={st?.status ?? "unknown"} size={14} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="charts">
        {(CHARTS[def.id] ?? []).map((c) => (
          <TrendChart key={c.id} def={c} history={data} checks={config.checks} />
        ))}
      </div>
    </section>
  );
}
