import React, { memo } from "react";
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import type { EmsForecastPoint } from "../../types";

interface ForecastChartProps {
  data?: EmsForecastPoint[];
}

export const ForecastChart: React.FC<ForecastChartProps> = memo(({ data = [] }) => {
  const chartData = Array.isArray(data) ? data : [];
  return (
    <section className="chart-card" aria-label="24-Hour Predictive Forecast">
      <div className="chart-card-header" style={{ marginBottom: 16 }}>
        <div>
          <h2 style={{ fontSize: 20 }}>24-Hour Predictive Dispatch &amp; TOU Electricity Tariffs</h2>
          <small className="fine">
            Hourly electrical demand, optimal SOFC modulation, and grid import mapped against TOU tariff tiers ($0.08 / $0.15 / $0.28).
          </small>
        </div>
      </div>

      <div style={{ width: "100%", height: 360, minWidth: 0, minHeight: 300 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
            <XAxis dataKey="time" stroke="var(--color-text-muted)" fontSize={12} />
            <YAxis
              yAxisId="left"
              stroke="var(--color-text-muted)"
              fontSize={12}
              unit=" kW"
              domain={[0, "auto"]}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="#eab308"
              fontSize={12}
              unit=" $/kWh"
              domain={[0, 0.35]}
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
                  if (name.includes("Tariff")) return [`$${value.toFixed(2)}/kWh`, name];
                  return [`${value.toFixed(1)} kW`, name];
                }
                return [value, name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
            <Bar
              yAxisId="left"
              dataKey="facility_demand_kw"
              name="Facility Demand (kW)"
              fill="#64748b"
              opacity={0.35}
              barSize={16}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="sofc_dispatch_kw"
              name="SOFC Optimal Dispatch (kW)"
              stroke="#10b981"
              strokeWidth={2.5}
              dot={{ r: 3 }}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="grid_import_kw"
              name="Grid Import (kW)"
              stroke="#3b82f6"
              strokeWidth={2}
              strokeDasharray="4 4"
              dot={{ r: 2 }}
            />
            <Line
              yAxisId="right"
              type="stepAfter"
              dataKey="tariff_usd_kwh"
              name="TOU Grid Tariff ($/kWh)"
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
});

ForecastChart.displayName = "ForecastChart";
