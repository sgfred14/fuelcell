import React, { memo } from "react";
import type { EmsDailySummary } from "../../types";

interface KpiSummaryProps {
  summary: EmsDailySummary | null;
  loading?: boolean;
}

export const KpiSummary: React.FC<KpiSummaryProps> = memo(({ summary, loading = false }) => {
  if (!summary || loading) {
    return (
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Status</span>
          <span className="kpi-value">{loading ? "Refreshing..." : "Loading..."}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="kpi-grid" aria-label="EMS Daily Performance Summary">
      <div className="kpi-card">
        <span className="kpi-label">Total Facility Demand</span>
        <span className="kpi-value num">
          {summary.total_demand_kwh.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}{" "}
          <small className="kpi-unit">kWh</small>
        </span>
        <span className="kpi-sub">24-hour predictive baseline</span>
      </div>

      <div className="kpi-card">
        <span className="kpi-label">SOFC Clean Generation</span>
        <span className="kpi-value num" style={{ color: "var(--ok)" }}>
          {summary.total_sofc_generation_kwh.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}{" "}
          <small className="kpi-unit">kWh</small>
        </span>
        <span className="kpi-sub">Self-Sufficiency: {summary.self_sufficiency_pct.toFixed(1)}%</span>
      </div>

      <div className="kpi-card">
        <span className="kpi-label">Grid Import</span>
        <span className="kpi-value num">
          {summary.total_grid_import_kwh.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}{" "}
          <small className="kpi-unit">kWh</small>
        </span>
        <span className="kpi-sub">Peak Shaved: {summary.peak_shaved_kw.toFixed(1)} kW</span>
      </div>

      <div className="kpi-card">
        <span className="kpi-label">Projected Daily Cost Savings</span>
        <span className="kpi-value num" style={{ color: "var(--ok)" }}>
          ${summary.total_savings_usd.toFixed(2)}
        </span>
        <span className="kpi-sub">{summary.savings_pct.toFixed(1)}% net bill reduction</span>
      </div>

      <div className="kpi-card">
        <span className="kpi-label">CO₂ Emissions Avoided</span>
        <span className="kpi-value num">
          {summary.co2_avoided_kg.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}{" "}
          <small className="kpi-unit">kg</small>
        </span>
        <span className="kpi-sub">0.42 kg CO₂/kWh grid intensity</span>
      </div>

      <div className="kpi-card">
        <span className="kpi-label">HRSG Thermal Recovery</span>
        <span className="kpi-value num">
          {summary.total_steam_produced_kg.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}{" "}
          <small className="kpi-unit">kg</small>
        </span>
        <span className="kpi-sub">High-value industrial steam</span>
      </div>
    </div>
  );
});

KpiSummary.displayName = "KpiSummary";
