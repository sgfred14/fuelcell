import React, { useState, useMemo, useEffect } from "react";
import { Search, RotateCcw, Eye, ChevronLeft, ChevronRight } from "lucide-react";
import type { CollectionTabKey } from "./CollectionTabs";
import type { DbTickDocument, DbAlertDocument, DbSimulationDocument, DbCalculationDocument, Status } from "../../types";
import { StatusBadge } from "../StatusBadge";

export interface CollectionTableProps {
  activeTab: CollectionTabKey;
  records: unknown[];
  loading: boolean;
  selectedDoc: unknown | null;
  onSelectDoc: (doc: unknown) => void;
}

export const CollectionTable: React.FC<CollectionTableProps> = React.memo(
  ({ activeTab, records, loading, selectedDoc, onSelectDoc }) => {
    const [searchQuery, setSearchQuery] = useState<string>("");
    const [statusFilter, setStatusFilter] = useState<string>("all");
    const [utilityFilter, setUtilityFilter] = useState<string>("all");
    const [minLoadFilter, setMinLoadFilter] = useState<string>("");
    const [actionFilter, setActionFilter] = useState<string>("all");
    const [calcTypeFilter, setCalcTypeFilter] = useState<string>("all");

    // Pagination state
    const [currentPage, setCurrentPage] = useState<number>(1);
    const pageSize = 10;

    // Reset filters and page when switching tabs
    useEffect(() => {
      setSearchQuery("");
      setStatusFilter("all");
      setUtilityFilter("all");
      setMinLoadFilter("");
      setActionFilter("all");
      setCalcTypeFilter("all");
      setCurrentPage(1);
    }, [activeTab]);

    const handleResetFilters = () => {
      setSearchQuery("");
      setStatusFilter("all");
      setUtilityFilter("all");
      setMinLoadFilter("");
      setActionFilter("all");
      setCalcTypeFilter("all");
      setCurrentPage(1);
    };

    // Filter logic
    const filteredRecords = useMemo(() => {
      const safeRecords = Array.isArray(records) ? [...records] : [];

      if (activeTab === "telemetry_ticks") {
        const ticks = safeRecords as DbTickDocument[];
        return ticks.filter((t) => {
          if (statusFilter !== "all" && t.overall !== statusFilter) return false;
          if (minLoadFilter !== "") {
            const minLoad = Number(minLoadFilter);
            const actualLoad = t.load_pct ?? t.values?.load_pct;
            if (!isNaN(minLoad) && typeof actualLoad === "number" && actualLoad < minLoad) return false;
          }
          if (searchQuery) {
            const query = searchQuery.toLowerCase();
            const idMatch = String(t._id ?? t.id ?? "").toLowerCase().includes(query);
            const tsMatch = String(t.timestamp ?? t.ts ?? "").toLowerCase().includes(query);
            if (!idMatch && !tsMatch) return false;
          }
          return true;
        });
      }

      if (activeTab === "alerts") {
        const alerts = safeRecords as DbAlertDocument[];
        return alerts.filter((a) => {
          if (statusFilter !== "all") {
            if (statusFilter === "active" && a.status !== "active") return false;
            if (statusFilter === "cleared" && a.status !== "cleared") return false;
            if (statusFilter === "acknowledged" && !a.acknowledged) return false;
          }
          if (utilityFilter !== "all" && a.utility !== utilityFilter) return false;
          if (searchQuery) {
            const query = searchQuery.toLowerCase();
            const titleMatch = (a.title ?? "").toLowerCase().includes(query);
            const keyMatch = (a.key ?? "").toLowerCase().includes(query);
            const utilMatch = (a.utility ?? "").toLowerCase().includes(query);
            if (!titleMatch && !keyMatch && !utilMatch) return false;
          }
          return true;
        });
      }

      if (activeTab === "simulations") {
        const sims = safeRecords as DbSimulationDocument[];
        return sims.filter((s) => {
          const act = s.action ?? (s as any).event ?? "";
          if (actionFilter !== "all" && act !== actionFilter) return false;
          if (searchQuery) {
            const query = searchQuery.toLowerCase();
            return JSON.stringify(s).toLowerCase().includes(query);
          }
          return true;
        });
      }

      if (activeTab === "thermo_calculations") {
        const calcs = safeRecords as DbCalculationDocument[];
        return calcs.filter((c) => {
          if (calcTypeFilter !== "all" && c.calc_type !== calcTypeFilter) return false;
          if (searchQuery) {
            const query = searchQuery.toLowerCase();
            return JSON.stringify(c).toLowerCase().includes(query);
          }
          return true;
        });
      }

      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        return safeRecords.filter((r) => JSON.stringify(r).toLowerCase().includes(query));
      }

      return safeRecords;
    }, [records, activeTab, statusFilter, utilityFilter, minLoadFilter, actionFilter, calcTypeFilter, searchQuery]);

    const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
    const paginatedRecords = useMemo(() => {
      const start = (currentPage - 1) * pageSize;
      return filteredRecords.slice(start, start + pageSize);
    }, [filteredRecords, currentPage, pageSize]);

    const hasActiveFilters = Boolean(
      searchQuery ||
        statusFilter !== "all" ||
        utilityFilter !== "all" ||
        minLoadFilter !== "" ||
        actionFilter !== "all" ||
        calcTypeFilter !== "all"
    );

    return (
      <div id={`panel-${activeTab}`} role="tabpanel" aria-labelledby={`tab-${activeTab}`}>
        {/* Search & Filter Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 240, maxWidth: 380 }}>
            <div style={{ position: "relative", width: "100%" }}>
              <Search
                size={16}
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
                placeholder="Search collection documents..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                style={{ paddingLeft: 34, width: "100%" }}
                aria-label="Search collection documents"
              />
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {activeTab === "telemetry_ticks" && (
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  aria-label="Filter ticks by status"
                  style={{ padding: "6px 10px", fontSize: 13 }}
                >
                  <option value="all">All Statuses</option>
                  <option value="ok">OK Status Only</option>
                  <option value="warning">Warning Status Only</option>
                  <option value="alarm">Alarm Status Only</option>
                </select>

                <input
                  type="number"
                  placeholder="Min Load %"
                  value={minLoadFilter}
                  onChange={(e) => {
                    setMinLoadFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  aria-label="Filter ticks by minimum load percentage"
                  style={{ width: 105, padding: "6px 8px", fontSize: 13 }}
                />
              </>
            )}

            {activeTab === "alerts" && (
              <>
                <select
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  aria-label="Filter alerts by state"
                  style={{ padding: "6px 10px", fontSize: 13 }}
                >
                  <option value="all">All Alert States</option>
                  <option value="active">Active Only</option>
                  <option value="acknowledged">Acknowledged Only</option>
                  <option value="cleared">Cleared Only</option>
                </select>

                <select
                  value={utilityFilter}
                  onChange={(e) => {
                    setUtilityFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  aria-label="Filter alerts by utility"
                  style={{ padding: "6px 10px", fontSize: 13 }}
                >
                  <option value="all">All Utilities</option>
                  <option value="Hydrogen supply">Hydrogen Supply</option>
                  <option value="Cathode air and blower">Cathode Air & Blower</option>
                  <option value="Stack cooling and temperatures">Stack Cooling</option>
                  <option value="Electrical and power conditioning">Electrical & Power</option>
                  <option value="Steam and water (HRSG)">Steam & Water</option>
                  <option value="Differential pressure and safety">Safety & DP</option>
                </select>
              </>
            )}

            {activeTab === "simulations" && (
              <select
                value={actionFilter}
                onChange={(e) => {
                  setActionFilter(e.target.value);
                  setCurrentPage(1);
                }}
                aria-label="Filter simulations by action"
                style={{ padding: "6px 10px", fontSize: 13 }}
              >
                <option value="all">All Events / Actions</option>
                <option value="start">Simulation Start</option>
                <option value="stop">Simulation Stop</option>
                <option value="fault">Fault Injected</option>
                <option value="clear">Fault Cleared</option>
                <option value="params">Parameters Updated</option>
              </select>
            )}

            {activeTab === "thermo_calculations" && (
              <select
                value={calcTypeFilter}
                onChange={(e) => {
                  setCalcTypeFilter(e.target.value);
                  setCurrentPage(1);
                }}
                aria-label="Filter calculations by type"
                style={{ padding: "6px 10px", fontSize: 13 }}
              >
                <option value="all">All Calculation Types</option>
                <option value="polarization">Polarization (V-j curve)</option>
                <option value="sweep">Parameter Sweep</option>
                <option value="thermodynamic_state">Thermodynamic State</option>
              </select>
            )}

            {hasActiveFilters && (
              <button
                type="button"
                className="btn btn-small"
                onClick={handleResetFilters}
                title="Reset all filters"
                style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              >
                <RotateCcw size={12} aria-hidden="true" />
                <span>Reset</span>
              </button>
            )}
          </div>
        </div>

        {/* Collection Data Table */}
        <div style={{ overflowX: "auto" }}>
          <table className="data-table" aria-label="Collection Records Table">
            <thead>
              {activeTab === "telemetry_ticks" && (
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Overall Status</th>
                  <th scope="col">Record ID</th>
                  <th scope="col">Load %</th>
                  <th scope="col">Stack Temp</th>
                  <th scope="col">DC Power</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              )}
              {activeTab === "alerts" && (
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Severity</th>
                  <th scope="col">State</th>
                  <th scope="col">Utility Subsystem</th>
                  <th scope="col">Alert Description</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              )}
              {activeTab === "simulations" && (
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Event / Action</th>
                  <th scope="col">Record ID</th>
                  <th scope="col">Simulation Details</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              )}
              {activeTab === "thermo_calculations" && (
                <tr>
                  <th scope="col">Timestamp</th>
                  <th scope="col">Calculation Type</th>
                  <th scope="col">Record ID</th>
                  <th scope="col">Summary / Parameters</th>
                  <th scope="col" style={{ textAlign: "right" }}>Actions</th>
                </tr>
              )}
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "36px 16px", color: "var(--color-text-muted)" }}>
                    Loading collection records...
                  </td>
                </tr>
              ) : filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: "center", padding: "36px 16px", color: "var(--color-text-muted)" }}>
                    No documents found matching the filter
                  </td>
                </tr>
              ) : (
                paginatedRecords.map((doc, idx) => {
                  const isSelected = selectedDoc === doc;
                  const rowClass = isSelected ? "row-selected" : "";

                  if (activeTab === "telemetry_ticks") {
                    const tick = doc as DbTickDocument;
                    const id = tick._id ?? tick.id ?? `tick_${idx}`;
                    const ts = tick.timestamp ?? tick.ts ?? "—";
                    const status = tick.overall ?? "ok";
                    const load = tick.load_pct ?? tick.values?.load_pct ?? "—";
                    const temp = tick.t_stack_c ?? tick.values?.t_stack_c ?? "—";
                    const pDc = tick.p_dc_kw ?? tick.values?.p_dc_kw ?? "—";

                    return (
                      <tr
                        key={String(id)}
                        className={rowClass}
                        onClick={() => onSelectDoc(tick)}
                        style={{
                          background: isSelected ? "rgba(184, 74, 47, 0.08)" : undefined,
                          cursor: "pointer",
                        }}
                      >
                        <td className="num">{String(ts)}</td>
                        <td>
                          <StatusBadge status={status as Status} size={13} />
                        </td>
                        <td className="num">#{String(id)}</td>
                        <td className="num">{load !== "—" ? `${load} %` : "—"}</td>
                        <td className="num">{temp !== "—" ? `${temp} °C` : "—"}</td>
                        <td className="num">{pDc !== "—" ? `${pDc} kW` : "—"}</td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectDoc(tick);
                            }}
                            aria-label={`Inspect JSON for tick ${id}`}
                          >
                            <Eye size={12} aria-hidden="true" />
                            <span>Inspect JSON</span>
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  if (activeTab === "alerts") {
                    const alert = doc as DbAlertDocument;
                    const id = alert._id ?? alert.id ?? `alert_${idx}`;
                    const ts = alert.last_ts ?? alert.first_ts ?? "—";
                    const sev = alert.severity === "alarm" ? "alarm" : "warning";

                    return (
                      <tr
                        key={String(id)}
                        className={rowClass}
                        onClick={() => onSelectDoc(alert)}
                        style={{
                          background: isSelected ? "rgba(184, 74, 47, 0.08)" : undefined,
                          cursor: "pointer",
                        }}
                      >
                        <td className="num">{String(ts)}</td>
                        <td>
                          <StatusBadge status={sev as Status} size={13} />
                        </td>
                        <td>
                          <span className={`badge ${alert.status === "active" ? "badge-alarm" : "badge-ok"}`}>
                            {alert.status?.toUpperCase() ?? "ACTIVE"}
                          </span>
                        </td>
                        <td>{alert.utility}</td>
                        <td>
                          <strong>{alert.title}</strong>
                          {alert.detail && (
                            <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--color-text-muted)" }}>
                              {alert.detail}
                            </p>
                          )}
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectDoc(alert);
                            }}
                            aria-label={`Inspect JSON for alert ${id}`}
                          >
                            <Eye size={12} aria-hidden="true" />
                            <span>Inspect JSON</span>
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  if (activeTab === "simulations") {
                    const sim = doc as DbSimulationDocument;
                    const id = sim._id ?? `sim_${idx}`;
                    const ts = sim.timestamp ?? "—";
                    const event = sim.action ?? (sim as any).event ?? "Lifecycle Event";

                    return (
                      <tr
                        key={String(id)}
                        className={rowClass}
                        onClick={() => onSelectDoc(sim)}
                        style={{
                          background: isSelected ? "rgba(184, 74, 47, 0.08)" : undefined,
                          cursor: "pointer",
                        }}
                      >
                        <td className="num">{String(ts)}</td>
                        <td>
                          <strong>{event}</strong>
                        </td>
                        <td className="num">#{String(id)}</td>
                        <td>
                          <code style={{ fontSize: 12 }}>
                            {JSON.stringify(sim.details ?? (sim as any).parameters ?? {}).slice(0, 80)}...
                          </code>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <button
                            type="button"
                            className="btn btn-small"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectDoc(sim);
                            }}
                            aria-label={`Inspect JSON for simulation ${id}`}
                          >
                            <Eye size={12} aria-hidden="true" />
                            <span>Inspect JSON</span>
                          </button>
                        </td>
                      </tr>
                    );
                  }

                  // thermo_calculations
                  const calc = doc as DbCalculationDocument;
                  const id = calc._id ?? `calc_${idx}`;
                  const ts = calc.created_at ?? (calc as any).timestamp ?? "—";
                  const calcType = calc.calc_type ?? "polarization";

                  return (
                    <tr
                      key={String(id)}
                      className={rowClass}
                      onClick={() => onSelectDoc(calc)}
                      style={{
                        background: isSelected ? "rgba(184, 74, 47, 0.08)" : undefined,
                        cursor: "pointer",
                      }}
                    >
                      <td className="num">{String(ts)}</td>
                      <td>
                        <span className="badge badge-ok">{calcType.toUpperCase()}</span>
                      </td>
                      <td className="num">#{String(id)}</td>
                      <td>
                        <code style={{ fontSize: 12 }}>
                          {JSON.stringify(calc.params ?? (calc as any).input_params ?? {}).slice(0, 80)}...
                        </code>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectDoc(calc);
                          }}
                          aria-label={`Inspect JSON for calculation ${id}`}
                        >
                          <Eye size={12} aria-hidden="true" />
                          <span>Inspect JSON</span>
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        {filteredRecords.length > 0 && (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginTop: 14,
              fontSize: 13,
              color: "var(--color-text-muted)",
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <span>
              Showing {Math.min((currentPage - 1) * pageSize + 1, filteredRecords.length)}–
              {Math.min(currentPage * pageSize, filteredRecords.length)} of {filteredRecords.length} records
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft size={14} aria-hidden="true" />
                <span>Previous</span>
              </button>
              <span style={{ padding: "0 8px" }}>
                Page {currentPage} of {totalPages}
              </span>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                disabled={currentPage >= totalPages}
                aria-label="Next page"
              >
                <span>Next</span>
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
);

CollectionTable.displayName = "CollectionTable";
