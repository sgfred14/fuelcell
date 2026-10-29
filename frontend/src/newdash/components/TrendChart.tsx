import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CheckDef, HistoryPoint } from "../types";
import type { ChartDef, SeriesDef } from "../lib/charts";
import { fmtClock, fmtSci } from "../lib/format";

interface Props {
  def: ChartDef;
  history: HistoryPoint[];
  checks: CheckDef[];
  height?: number;
}

function seriesFor(def: ChartDef, check?: CheckDef): SeriesDef[] {
  if (check) return [{ source: "c", key: check.id, label: check.label, unit: check.unit, color: "#0284C7", decimals: check.decimals }];
  return def.series ?? [];
}

export function TrendChart({ def, history, checks, height = 190 }: Props) {
  const check = def.check ? checks.find((c) => c.id === def.check) : undefined;
  const series = seriesFor(def, check);
  const data = history.map((h) => {
    const row: Record<string, string | number | null> = { t: h.ts };
    for (const s of series) row[s.key] = (s.source === "c" ? h.c[s.key] : h.v[s.key]) ?? null;
    return row;
  });
  const refs: { y: number; kind: "warn" | "alarm"; label: string }[] = [];
  if (check) {
    const add = (y: number | null, kind: "warn" | "alarm") => y !== null && refs.push({ y, kind, label: `${kind === "alarm" ? "ALARM" : "WARN"} ${fmtSci(y, check.decimals)}` });
    add(check.warn_lo, "warn"); add(check.warn_hi, "warn"); add(check.alarm_lo, "alarm"); add(check.alarm_hi, "alarm");
  }
  const faultTs = history.filter((h) => h.meta?.injected_fault).map((h) => h.ts);
  const unit = series[0]?.unit ?? "";
  const dec = series[0]?.decimals ?? 1;
  // y-axis: fit the data, and stretch to a limit line only when that limit is near the data (so limits stay visible without squashing the trace)
  const vals = data.flatMap((r) => series.map((x) => r[x.key])).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const lo = vals.length ? Math.min(...vals) : 0;
  const hi = vals.length ? Math.max(...vals) : 1;
  const reach = Math.max((hi - lo) * 8, Math.abs(hi) * 0.12, 2);
  const yMin = Math.min(lo, ...refs.filter((r) => r.y >= lo - reach).map((r) => r.y));
  const yMax = Math.max(hi, ...refs.filter((r) => r.y <= hi + reach).map((r) => r.y));
  const pad = (yMax - yMin || 1) * 0.06;
  const domain: [number, number] = [yMin - pad, yMax + pad];

  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{def.title}</span>
        <span className="chart-legend">
          {series.map((s) => (
            <span key={s.key} className="chart-legend-item">
              <i style={{ background: s.color }} />
              <span>{s.label}</span>
              {unit && series.length === 1 ? <span className="chart-legend-unit">[{unit}]</span> : ""}
            </span>
          ))}
        </span>
      </figcaption>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 2, left: 0 }}>
            <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 3" strokeOpacity={0.5} vertical={false} />
            <XAxis
              dataKey="t"
              tickFormatter={fmtClock}
              minTickGap={48}
              stroke="var(--color-border)"
              tickLine={{ stroke: "var(--color-border)" }}
              tick={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: "var(--color-text-muted)" }}
            />
            <YAxis
              stroke="var(--color-border)"
              tickLine={{ stroke: "var(--color-border)" }}
              tick={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: "var(--color-text-muted)" }}
              width={48}
              domain={domain}
              tickFormatter={(v: number) => fmtSci(v, Math.abs(v) >= 100 ? 0 : dec)}
              allowDataOverflow={false}
            />
            <Tooltip
              contentStyle={{
                background: "#FFFDF8",
                border: "1px solid var(--color-border)",
                borderRadius: 4,
                padding: "6px 10px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
                fontSize: 11,
                fontFamily: "var(--font-mono)",
              }}
              labelStyle={{ color: "var(--color-text-muted)", fontSize: 10, marginBottom: 4 }}
              labelFormatter={(l) => `t = ${fmtClock(String(l))}`}
              formatter={(v: number, name: string) => [`${fmtSci(v, dec)} ${unit}`.trim(), name]}
            />
            {faultTs.length > 1 && <ReferenceArea x1={faultTs[0]} x2={faultTs[faultTs.length - 1]} fill="var(--alarm)" fillOpacity={0.06} />}
            {refs.map((r, i) => (
              <ReferenceLine
                key={i}
                y={r.y}
                stroke={r.kind === "alarm" ? "var(--alarm)" : "var(--warn)"}
                strokeDasharray="2 3"
                strokeWidth={1}
                strokeOpacity={0.75}
                label={{
                  value: r.label,
                  fill: r.kind === "alarm" ? "var(--alarm)" : "var(--warn)",
                  fontSize: 9.5,
                  fontFamily: "var(--font-mono)",
                  position: "insideTopRight",
                }}
              />
            ))}
            {series.map((s) => (
              <Line
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={1.4}
                dot={false}
                activeDot={{ r: 3, strokeWidth: 1.2, stroke: "#FFFDF8" }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
