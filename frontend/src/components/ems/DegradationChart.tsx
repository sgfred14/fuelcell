import React, { memo } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import type { EmsDegradationPoint } from "../../types";

interface DegradationChartProps {
  data?: EmsDegradationPoint[];
}

export const DegradationChart: React.FC<DegradationChartProps> = memo(({ data = [] }) => {
  const chartData = Array.isArray(data) ? data : [];
  const currentHealth = chartData.length > 0 ? chartData[chartData.length - 1].stack_health_pct : 88.0;

  return (
    <section className="chart-card" aria-label="Stack Degradation Horizon">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20 }}>Long-Term Stack Degradation Horizon (0 – 20,000 Hours)</h2>
          <small className="fine">
            Area Specific Resistance (ASR) growth and cell voltage decay projections with Remaining Useful Life (RUL).
          </small>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="badge badge-ok" style={{ fontSize: 13 }}>
            RUL: 14,250 hrs remaining (Stack Health: {currentHealth.toFixed(0)}%)
          </span>
        </div>
      </div>

      <div style={{ width: "100%", height: 300, minWidth: 0, minHeight: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
            <XAxis
              dataKey="hours"
              stroke="var(--color-text-muted)"
              fontSize={12}
              tickFormatter={(v) => `${v.toLocaleString()}h`}
            />
            <YAxis
              yAxisId="left"
              stroke="#ef4444"
              fontSize={12}
              unit=" mΩ·cm²"
              domain={[230, 310]}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#3b82f6"
              fontSize={12}
              unit=" V"
              domain={[0.55, 0.80]}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-surface)",
                borderColor: "var(--color-border)",
                borderRadius: 4,
                fontSize: 12,
              }}
              formatter={(value: any, name: string) => {
                if (typeof value === "number") {
                  if (name.includes("ASR")) return [`${value.toFixed(1)} mΩ·cm²`, name];
                  if (name.includes("Voltage")) return [`${value.toFixed(4)} V`, name];
                  if (name.includes("Health")) return [`${value.toFixed(1)}%`, name];
                  return [`${value.toFixed(2)}`, name];
                }
                return [value, name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="asr_mohm_cm2"
              name="Ohmic ASR (mΩ·cm²)"
              stroke="#ef4444"
              strokeWidth={2.5}
              dot={{ r: 4 }}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="cell_voltage_v"
              name="Cell Voltage (V)"
              stroke="#3b82f6"
              strokeWidth={2.5}
              dot={{ r: 4 }}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="electrical_efficiency_pct"
              name="Projected Efficiency (%)"
              stroke="#10b981"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
});

DegradationChart.displayName = "DegradationChart";
