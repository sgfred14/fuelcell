import React, { useState, useMemo } from "react";
import { Zap, Flame, Award, ArrowRight, RefreshCw } from "lucide-react";
import type { AspenOptimalCandidate, AspenOptimalCandidateParams } from "../../types";

export interface OptimizerPanelProps {
  candidates?: AspenOptimalCandidate[] | null;
  currentObjective: "eta_el" | "eta_chp";
  onSelectObjective: (obj: "eta_el" | "eta_chp") => void;
  onRunOptimization: (params?: { objective: "eta_el" | "eta_chp"; plant_params?: Record<string, number> }) => Promise<void> | void;
  loading?: boolean;
  onApplyCandidate?: (candidate: AspenOptimalCandidate) => void;
}

interface NormalizedCandidate {
  rank: number;
  score: number;
  vCell: number;
  uf: number;
  pBlower: number;
  j: number;
  etaEl: number;
  etaChp: number;
  h2Flow: number;
  steamFlow: number;
  parasiticPct: number;
  cellCount: number;
  original: AspenOptimalCandidate;
}

export const OptimizerPanel: React.FC<OptimizerPanelProps> = React.memo(
  ({
    candidates = [],
    currentObjective,
    onSelectObjective,
    onRunOptimization,
    loading = false,
    onApplyCandidate,
  }) => {
    // Optional tuning for plant parameters
    const [pNetTarget, setPNetTarget] = useState<number>(100);
    const [tInletTarget, setTInletTarget] = useState<number>(650);

    // Normalize and rank candidates based on objective
    const rankedCandidates: NormalizedCandidate[] = useMemo(() => {
      const rawList = candidates && candidates.length > 0 ? candidates : [];

      const normalized: NormalizedCandidate[] = rawList.map((c, idx) => {
        const params = c.params as (AspenOptimalCandidateParams | undefined);
        const cAny = c as unknown as {
          v_cell?: number;
          uf?: number;
          p_blower?: number;
          j?: number;
          h2_flow?: number;
          steam_flow?: number;
          cell_count?: number;
          rank?: number;
        };

        const vCell = cAny.v_cell ?? params?.vcell ?? 0.78;
        const uf = cAny.uf ?? params?.uf ?? 0.82;
        const pBlower = cAny.p_blower ?? params?.pbl ?? 11.8;
        const j = cAny.j ?? params?.j ?? 0.38;
        const etaEl = c.eta_el ?? 54.8;
        const etaChp = c.eta_chp ?? 85.2;
        const h2Flow = cAny.h2_flow ?? c.h2_kgh ?? 5.8;
        const steamFlow = cAny.steam_flow ?? c.steam_kgh ?? 118.0;
        const parasiticPct = c.parasitic_pct ?? 11.2;
        const cellCount = cAny.cell_count ?? c.cells ?? 730;
        const score = c.score ?? (currentObjective === "eta_chp" ? etaChp : etaEl);

        return {
          rank: (c as unknown as { rank?: number }).rank ?? idx + 1,
          score,
          vCell,
          uf,
          pBlower,
          j,
          etaEl,
          etaChp,
          h2Flow,
          steamFlow,
          parasiticPct,
          cellCount,
          original: c,
        };
      });

      // Sort descending by selected objective score (satisfies TC-T2.02.03)
      normalized.sort((a, b) => {
        const scoreA = currentObjective === "eta_chp" ? a.etaChp : a.etaEl;
        const scoreB = currentObjective === "eta_chp" ? b.etaChp : b.etaEl;
        return scoreB - scoreA;
      });

      // Re-assign ranks 1..N
      return normalized.map((item, idx) => ({
        ...item,
        rank: idx + 1,
      }));
    }, [candidates, currentObjective]);

    const handleObjectiveToggle = (obj: "eta_el" | "eta_chp") => {
      onSelectObjective(obj);
      void onRunOptimization({
        objective: obj,
        plant_params: { pnet: pNetTarget, tin: tInletTarget },
      });
    };

    const handleRunClick = () => {
      void onRunOptimization({
        objective: currentObjective,
        plant_params: { pnet: pNetTarget, tin: tInletTarget },
      });
    };

    return (
      <section className="chart-card" id="optimizer-panel" aria-label="Multi-Parameter Grid Optimizer">
        {/* Header */}
        <div className="chart-card-header" style={{ marginBottom: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <h2 style={{ fontSize: 20 }}>Multi-Parameter Grid Optimizer</h2>
              <span className="badge badge-ok">Physics-Constrained</span>
            </div>
            <small className="fine">
              Automated multi-variable grid search across cell voltage (V_cell), fuel utilization (U_f), blower backpressure, and current density (j) subject to thermal gradient (&le; 100 K) and voltage margin constraints.
            </small>
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={handleRunClick}
            disabled={loading}
            title="Execute grid search optimization"
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />
            <span>{loading ? "Optimizing Grid..." : "Re-Run Optimization"}</span>
          </button>
        </div>

        {/* Objective Selector & Tuning Controls */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 16,
            padding: "16px 20px",
            background: "var(--color-surface-alt)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            marginBottom: 20,
          }}
        >
          {/* Objective Mode Selector */}
          <div>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-muted)", display: "block", marginBottom: 6 }}>
              OPTIMIZATION OBJECTIVE
            </span>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                type="button"
                className={`btn ${currentObjective === "eta_el" ? "btn-primary" : ""}`}
                onClick={() => handleObjectiveToggle("eta_el")}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
                aria-pressed={currentObjective === "eta_el"}
              >
                <Zap size={14} aria-hidden="true" />
                <span>Electrical Efficiency (&eta;<sub>el</sub>)</span>
              </button>

              <button
                type="button"
                className={`btn ${currentObjective === "eta_chp" ? "btn-primary" : ""}`}
                onClick={() => handleObjectiveToggle("eta_chp")}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
                aria-pressed={currentObjective === "eta_chp"}
              >
                <Flame size={14} aria-hidden="true" />
                <span>CHP Total Efficiency (&eta;<sub>chp</sub>)</span>
              </button>
            </div>
          </div>

          {/* Plant constraints tuning */}
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <label htmlFor="opt-pnet" style={{ fontSize: 12, color: "var(--color-text-muted)", display: "block" }}>
                Target AC Power (kW)
              </label>
              <input
                id="opt-pnet"
                type="number"
                min="50"
                max="250"
                step="5"
                value={pNetTarget}
                onChange={(e) => setPNetTarget(Number(e.target.value))}
                style={{ width: 110, padding: "6px 8px" }}
              />
            </div>
            <div>
              <label htmlFor="opt-tin" style={{ fontSize: 12, color: "var(--color-text-muted)", display: "block" }}>
                Anode Inlet T (°C)
              </label>
              <input
                id="opt-tin"
                type="number"
                min="550"
                max="750"
                step="10"
                value={tInletTarget}
                onChange={(e) => setTInletTarget(Number(e.target.value))}
                style={{ width: 110, padding: "6px 8px" }}
              />
            </div>
          </div>
        </div>

        {/* Candidate Rankings Table */}
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" aria-label="Top 5 Optimal Candidates Table">
            <thead>
              <tr>
                <th scope="col" style={{ width: 60, textAlign: "center" }}>Rank</th>
                <th scope="col" style={{ textAlign: "right" }}>V<sub>cell</sub> (V)</th>
                <th scope="col" style={{ textAlign: "right" }}>U<sub>f</sub> (%)</th>
                <th scope="col" style={{ textAlign: "right" }}>P<sub>blower</sub></th>
                <th scope="col" style={{ textAlign: "right" }}>j (A/cm²)</th>
                <th scope="col" style={{ textAlign: "right" }}>&eta;<sub>el</sub> (%)</th>
                <th scope="col" style={{ textAlign: "right" }}>&eta;<sub>chp</sub> (%)</th>
                <th scope="col" style={{ textAlign: "right" }}>H₂ Flow (kg/h)</th>
                <th scope="col" style={{ textAlign: "right" }}>Steam (kg/h)</th>
                <th scope="col" style={{ textAlign: "right" }}>Parasitic %</th>
                <th scope="col" style={{ textAlign: "right" }}>Cells (N)</th>
                {onApplyCandidate && <th scope="col" style={{ textAlign: "center" }}>Action</th>}
              </tr>
            </thead>
            <tbody>
              {rankedCandidates.length === 0 ? (
                <tr>
                  <td colSpan={12} style={{ textAlign: "center", padding: "24px 16px", color: "var(--color-text-muted)" }}>
                    No optimization candidates calculated. Click "Re-Run Optimization" to search operating parameter grid.
                  </td>
                </tr>
              ) : (
                rankedCandidates.slice(0, 5).map((cand) => {
                  const isTop = cand.rank === 1;

                  return (
                    <tr
                      key={cand.rank}
                      style={{
                        background: isTop ? "rgba(184, 74, 47, 0.05)" : undefined,
                        fontWeight: isTop ? 600 : 400,
                      }}
                    >
                      <td style={{ textAlign: "center" }}>
                        {isTop ? (
                          <span
                            className="badge badge-ok"
                            style={{ padding: "2px 6px", fontSize: 12, fontWeight: 700 }}
                            title="Optimal Recommended Setpoint"
                          >
                            <Award size={12} aria-hidden="true" />
                            <span>#1</span>
                          </span>
                        ) : (
                          <span className="fine" style={{ fontFamily: "var(--font-mono)" }}>
                            #{cand.rank}
                          </span>
                        )}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {cand.vCell.toFixed(2)} V
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {(cand.uf <= 1 ? cand.uf * 100 : cand.uf).toFixed(1)}%
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {cand.pBlower.toFixed(2)}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {cand.j.toFixed(2)}
                      </td>
                      <td
                        className="num"
                        style={{
                          textAlign: "right",
                          color: currentObjective === "eta_el" ? "var(--color-primary)" : undefined,
                          fontWeight: currentObjective === "eta_el" ? 600 : undefined,
                        }}
                      >
                        {cand.etaEl.toFixed(1)}%
                      </td>
                      <td
                        className="num"
                        style={{
                          textAlign: "right",
                          color: currentObjective === "eta_chp" ? "var(--color-primary)" : undefined,
                          fontWeight: currentObjective === "eta_chp" ? 600 : undefined,
                        }}
                      >
                        {cand.etaChp.toFixed(1)}%
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {cand.h2Flow.toFixed(2)}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {cand.steamFlow.toFixed(1)}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {cand.parasiticPct.toFixed(1)}%
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {cand.cellCount}
                      </td>
                      {onApplyCandidate && (
                        <td style={{ textAlign: "center" }}>
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={() => onApplyCandidate(cand.original)}
                            title="Load this optimal setpoint into Aspen model verification"
                          >
                            <span>Apply</span>
                            <ArrowRight size={11} aria-hidden="true" />
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    );
  }
);

OptimizerPanel.displayName = "OptimizerPanel";
export default OptimizerPanel;
