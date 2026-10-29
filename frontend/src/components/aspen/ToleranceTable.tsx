import React, { useState, useMemo } from "react";
import { CheckCircle2, AlertTriangle, OctagonAlert, Search, RefreshCw } from "lucide-react";
import type { AspenVerificationRow } from "../../types";

export function formatNodeValue(val: number | null | undefined): string {
  if (val === null || val === undefined || Number.isNaN(val) || !Number.isFinite(val)) {
    return "--";
  }
  return val.toFixed(2);
}

export interface ToleranceTableProps {
  rows: AspenVerificationRow[];
  loading?: boolean;
  verdict?: "PASS" | "CHECK_REQUIRED" | "FAIL" | string | null;
  checksPassed?: number;
  checksWarning?: number;
  checksError?: number;
  verifiedAt?: string | null;
  sourceMode?: string;
  onRefresh?: () => Promise<void> | void;
}

export const ToleranceTable: React.FC<ToleranceTableProps> = React.memo(
  ({
    rows,
    loading = false,
    verdict = "PASS",
    checksPassed = 10,
    checksWarning = 0,
    checksError = 0,
    verifiedAt,
    sourceMode = "simulated",
    onRefresh,
  }) => {
    const [searchQuery, setSearchQuery] = useState<string>("");
    const [statusFilter, setStatusFilter] = useState<"ALL" | "PASS" | "CHECK" | "ERR">("ALL");

    // Filter rows
    const filteredRows = useMemo(() => {
      const q = searchQuery.trim().toLowerCase();
      return rows.filter((row) => {
        // Status filter matching: "OK" in backend maps to "PASS" in UI
        const rowStatus = row.status === "OK" ? "PASS" : row.status;
        if (statusFilter !== "ALL" && rowStatus !== statusFilter) {
          return false;
        }
        if (!q) return true;
        return (
          row.item.toLowerCase().includes(q) ||
          row.node_path.toLowerCase().includes(q)
        );
      });
    }, [rows, searchQuery, statusFilter]);

    return (
      <section className="chart-card" aria-label="Baseline Tolerance Verification Table">
        {/* Header & Verdict Banner */}
        <div className="chart-card-header" style={{ marginBottom: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
              <h2 style={{ fontSize: 20 }}>Baseline Tolerance Verification (10 Key Variables)</h2>
              {verdict === "PASS" ? (
                <span className="badge badge-ok" style={{ fontWeight: 600 }}>
                  <CheckCircle2 size={13} aria-hidden="true" />
                  <span>OVERALL: PASS</span>
                </span>
              ) : verdict === "CHECK_REQUIRED" ? (
                <span className="badge badge-warning" style={{ fontWeight: 600 }}>
                  <AlertTriangle size={13} aria-hidden="true" />
                  <span>OVERALL: CHECK REQUIRED</span>
                </span>
              ) : (
                <span className="badge badge-alarm" style={{ fontWeight: 600 }}>
                  <OctagonAlert size={13} aria-hidden="true" />
                  <span>OVERALL: FAIL</span>
                </span>
              )}
            </div>
            <small className="fine">
              Monitored process values verified against calibrated Phase 1 plant design specifications.
              {verifiedAt ? ` Last verified at: ${new Date(verifiedAt).toLocaleTimeString()}` : ""}
              {sourceMode ? ` (${sourceMode.toUpperCase()} mode)` : ""}
            </small>
          </div>

          {/* Quick Counter Pills */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="pill pill-ok" title="Process nodes strictly within tolerance limits">
              {checksPassed} PASS
            </span>
            {checksWarning > 0 && (
              <span className="pill pill-warn" title="Process nodes requiring engineering check">
                {checksWarning} CHECK
              </span>
            )}
            {checksError > 0 && (
              <span className="pill pill-alarm" title="Process nodes with measurement or communication errors">
                {checksError} ERR
              </span>
            )}
            {onRefresh && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => void onRefresh()}
                disabled={loading}
                title="Refresh baseline tolerance evaluation"
                aria-label="Refresh tolerance table"
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
            marginBottom: 16,
          }}
        >
          {/* Text Search */}
          <div style={{ position: "relative", minWidth: 260, flex: 1, maxWidth: 360 }}>
            <Search
              size={14}
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--color-text-muted)",
              }}
              aria-hidden="true"
            />
            <input
              type="text"
              placeholder="Search parameter or node path..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: "100%", paddingLeft: 32 }}
              aria-label="Filter tolerance table parameters"
            />
          </div>

          {/* Status Filter Buttons */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["ALL", "PASS", "CHECK", "ERR"] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                className={`btn btn-small ${statusFilter === filter ? "btn-primary" : ""}`}
                onClick={() => setStatusFilter(filter)}
                aria-pressed={statusFilter === filter}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        {/* Table Content */}
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" aria-label="Baseline Tolerance Verification">
            <thead>
              <tr>
                <th scope="col">Monitored Parameter</th>
                <th scope="col">Aspen Node Path</th>
                <th scope="col" style={{ textAlign: "right" }}>Pulled Value</th>
                <th scope="col" style={{ textAlign: "right" }}>Baseline Target</th>
                <th scope="col" style={{ textAlign: "right" }}>Rel Error %</th>
                <th scope="col" style={{ textAlign: "right" }}>Allowed Tol</th>
                <th scope="col" style={{ textAlign: "center" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "24px 16px", color: "var(--color-text-muted)" }}>
                    No monitored parameters match the selected criteria.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row, idx) => {
                  const statusNormalized = row.status === "OK" ? "PASS" : row.status;
                  const rowClass =
                    statusNormalized === "ERR"
                      ? "row-alarm"
                      : statusNormalized === "CHECK"
                      ? "row-warning"
                      : "";

                  const aspenValFormatted = formatNodeValue(row.aspen_value);
                  const baselineValFormatted = formatNodeValue(row.baseline_value);
                  const relErrFormatted =
                    row.rel_err_pct !== null && row.rel_err_pct !== undefined && !Number.isNaN(row.rel_err_pct) && Number.isFinite(row.rel_err_pct)
                      ? `${row.rel_err_pct > 0 ? "+" : ""}${row.rel_err_pct.toFixed(2)}%`
                      : "--";

                  return (
                    <tr key={idx} className={rowClass}>
                      <td>
                        <strong>{row.item}</strong>
                      </td>
                      <td>
                        <code>{row.node_path}</code>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {aspenValFormatted}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {baselineValFormatted}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        {relErrFormatted}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        ± {row.tol_pct.toFixed(1)}%
                      </td>
                      <td style={{ textAlign: "center" }}>
                        {statusNormalized === "PASS" ? (
                          <span className="badge badge-ok">PASS</span>
                        ) : statusNormalized === "CHECK" ? (
                          <span className="badge badge-warning">CHECK</span>
                        ) : (
                          <span className="badge badge-alarm">ERR</span>
                        )}
                      </td>
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

ToleranceTable.displayName = "ToleranceTable";
export default ToleranceTable;
