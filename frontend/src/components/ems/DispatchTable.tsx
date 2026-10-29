import React, { memo } from "react";
import type { EmsForecastPoint } from "../../types";

interface DispatchTableProps {
  schedule?: EmsForecastPoint[];
}

export const DispatchTable: React.FC<DispatchTableProps> = memo(({ schedule = [] }) => {
  const items = Array.isArray(schedule) ? schedule : [];
  return (
    <section className="card" aria-label="24-Hour Economic Dispatch Schedule">
      <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--color-border)" }}>
        <h2 style={{ fontSize: 20 }}>24-Hour Economic Dispatch Schedule</h2>
        <small className="fine">
          Detailed hour-by-hour operational setpoints, fuel consumption, and tariff arbitrage savings.
        </small>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "10px 12px" }}>Time</th>
              <th style={{ textAlign: "right", padding: "10px 12px" }}>Demand</th>
              <th style={{ textAlign: "right", padding: "10px 12px" }}>SOFC Setpoint</th>
              <th style={{ textAlign: "right", padding: "10px 12px" }}>Grid Import</th>
              <th style={{ textAlign: "center", padding: "10px 12px" }}>TOU Tariff</th>
              <th style={{ textAlign: "right", padding: "10px 12px" }}>H₂ Fuel</th>
              <th style={{ textAlign: "right", padding: "10px 12px" }}>Steam HRSG</th>
              <th style={{ textAlign: "right", padding: "10px 12px" }}>EMS Cost</th>
              <th style={{ textAlign: "right", padding: "10px 12px" }}>Savings</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => {
              const isPeak = row.tariff_usd_kwh >= 0.25;
              const isOffPeak = row.tariff_usd_kwh <= 0.10;
              const tariffBadgeClass = isPeak
                ? "badge badge-warn"
                : isOffPeak
                ? "badge badge-ok"
                : "badge";

              const tariffLabel = isPeak
                ? "On-Peak"
                : isOffPeak
                ? "Off-Peak"
                : "Mid-Peak";

              return (
                <tr key={row.hour} style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                  <td style={{ padding: "8px 12px", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                    {row.time}
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "var(--font-mono)" }}>
                    {row.facility_demand_kw.toFixed(1)} kW
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "var(--font-mono)", color: "var(--ok)", fontWeight: 600 }}>
                    {row.sofc_dispatch_kw.toFixed(1)} kW
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "var(--font-mono)" }}>
                    {row.grid_import_kw.toFixed(1)} kW
                  </td>
                  <td style={{ textAlign: "center", padding: "8px 12px" }}>
                    <span className={tariffBadgeClass} style={{ fontSize: 11, padding: "2px 8px" }}>
                      ${row.tariff_usd_kwh.toFixed(2)} ({tariffLabel})
                    </span>
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "var(--font-mono)" }}>
                    {row.h2_consumed_kg.toFixed(2)} kg
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "var(--font-mono)" }}>
                    {row.steam_produced_kg.toFixed(1)} kg
                  </td>
                  <td style={{ textAlign: "right", padding: "8px 12px", fontFamily: "var(--font-mono)" }}>
                    ${row.ems_cost_usd.toFixed(2)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      padding: "8px 12px",
                      fontFamily: "var(--font-mono)",
                      color: row.savings_usd > 0 ? "var(--ok)" : "inherit",
                      fontWeight: 600,
                    }}
                  >
                    +${row.savings_usd.toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
});

DispatchTable.displayName = "DispatchTable";
