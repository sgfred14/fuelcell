import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  EmsForecastResponse,
  EmsDailySummary,
  EmsForecastPoint,
  EmsDegradationPoint,
  EmsRecommendationItem,
} from "../types";
import {
  KpiSummary,
  OptimizationControls,
  ForecastChart,
  DegradationChart,
  DispatchTable,
  AdvisoryList,
} from "../components/ems";
import { AlertCircle, RefreshCw } from "lucide-react";

export default function EmsPage() {
  const [forecastData, setForecastData] = useState<EmsForecastResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [optimizing, setOptimizing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Optimization Parameters
  const [baseDemand, setBaseDemand] = useState<number>(85);
  const [h2Cost, setH2Cost] = useState<number>(4.50);

  // Initial parallel data loading (Rule: async-parallel - eliminate waterfalls)
  const loadInitialData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.emsForecast({ base_demand_kw: baseDemand, h2_cost_usd_kg: h2Cost });
      setForecastData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load EMS predictive forecast.");
    } finally {
      setLoading(false);
    }
  }, [baseDemand, h2Cost]);

  useEffect(() => {
    loadInitialData();
  }, [loadInitialData]);

  // Recompute Optimal Dispatch
  const handleRecompute = useCallback(async () => {
    setOptimizing(true);
    setError(null);
    try {
      const updated = await api.emsOptimize({
        base_demand_kw: baseDemand,
        h2_cost_usd_kg: h2Cost,
      });
      setForecastData(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to optimize dispatch schedule.");
    } finally {
      setOptimizing(false);
    }
  }, [baseDemand, h2Cost]);

  const handleBaseDemandChange = useCallback((val: number) => {
    setBaseDemand(val);
  }, []);

  const handleH2CostChange = useCallback((val: number) => {
    setH2Cost(val);
  }, []);

  // Memoized derived properties
  const summary: EmsDailySummary | null = useMemo(() => {
    return forecastData && typeof forecastData === "object" && forecastData.summary ? forecastData.summary : null;
  }, [forecastData]);

  const forecastPoints: EmsForecastPoint[] = useMemo(() => {
    return forecastData && Array.isArray(forecastData.forecast_24h) ? forecastData.forecast_24h : [];
  }, [forecastData]);

  const degradationPoints: EmsDegradationPoint[] = useMemo(() => {
    return forecastData && Array.isArray(forecastData.degradation_projection) ? forecastData.degradation_projection : [];
  }, [forecastData]);

  const recommendations: EmsRecommendationItem[] = useMemo(() => {
    return forecastData && Array.isArray(forecastData.recommendations) ? forecastData.recommendations : [];
  }, [forecastData]);

  return (
    <div className="page" role="main">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1>AI Energy Management System (EMS)</h1>
          <p>
            24-hour predictive dispatch, Time-of-Use tariff optimization, long-term stack degradation horizons, and operational advisories.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={loadInitialData}
          disabled={loading || optimizing}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />
          <span>Refresh</span>
        </button>
      </div>

      {error ? (
        <div className="alert alert-alarm" style={{ marginBottom: 20 }}>
          <AlertCircle size={18} aria-hidden="true" />
          <div style={{ flex: 1 }}>
            <strong>EMS Prediction Error:</strong> {error}
          </div>
          <button type="button" className="btn btn-sm" onClick={loadInitialData}>
            Retry
          </button>
        </div>
      ) : null}

      {/* Daily Summary KPI Grid */}
      <KpiSummary summary={summary} loading={loading} />

      {/* Interactive Optimization Parameters */}
      <OptimizationControls
        baseDemand={baseDemand}
        h2Cost={h2Cost}
        onBaseDemandChange={handleBaseDemandChange}
        onH2CostChange={handleH2CostChange}
        onRecompute={handleRecompute}
        loading={optimizing}
      />

      {/* 24-Hour Predictive Dispatch & Tariff Forecast Chart */}
      <ForecastChart data={forecastPoints} />

      {/* 24-Hour Economic Dispatch Table */}
      <DispatchTable schedule={forecastPoints} />

      {/* Long-Term Stack Degradation Horizon Chart */}
      <DegradationChart data={degradationPoints} />

      {/* Operational Advisory Alert Cards */}
      <AdvisoryList advisories={recommendations} />
    </div>
  );
}
