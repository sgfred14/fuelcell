import React from "react";
import { AlertTriangle, OctagonAlert, CheckCircle2, Lightbulb, Wrench } from "lucide-react";
import type { AspenSuggestion } from "../../types";

export interface SuggestionListProps {
  suggestions?: AspenSuggestion[] | null;
  loading?: boolean;
  onApplyFix?: (fix: Record<string, number>) => void;
}

export const SuggestionList: React.FC<SuggestionListProps> = React.memo(
  ({ suggestions = [], onApplyFix }) => {
    const list = suggestions && suggestions.length > 0 ? suggestions : [];

    return (
      <section className="chart-card" aria-label="Diagnostic Operational Suggestions Panel">
        <div className="chart-card-header" style={{ marginBottom: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
              <h2 style={{ fontSize: 20 }}>Diagnostic Operational Suggestions &amp; Physics Advisories</h2>
              <span className="badge badge-ok">Physics-Informed</span>
            </div>
            <small className="fine">
              Automated physics constraint checks covering cathode thermal gradients, anode voltage margins, blower parasitic fractions, and flue gas dew point margins.
            </small>
          </div>
        </div>

        {list.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              background: "var(--color-surface-alt)",
              borderRadius: 6,
              border: "1px dashed var(--color-border)",
              color: "var(--color-text-muted)",
            }}
          >
            No diagnostic suggestions generated yet. Click "Pull &amp; Verify Process Values" to analyze operating parameters.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {list.map((sug, idx) => {
              const sev = sug.sev;
              // Extract text from either sug.text (contract) or sug.msg (backend)
              const message = (sug as unknown as { text?: string }).text ?? sug.msg ?? "Constraint advisory";

              // Extract fix or parameter suggestion
              const fixObj = sug.fix;
              const hasFix = fixObj !== null && fixObj !== undefined && Object.keys(fixObj).length > 0;
              const suggestedParam = (sug as unknown as { param?: string; suggested?: number }).param;
              const suggestedVal = (sug as unknown as { param?: string; suggested?: number }).suggested;

              let borderLeftColor = "var(--color-border)";
              let badgeClass = "badge-unknown";
              let badgeText = "ADVISORY";
              let Icon = Lightbulb;

              if (sev === "crit") {
                borderLeftColor = "var(--alarm, #C0392B)";
                badgeClass = "badge-alarm";
                badgeText = "CRITICAL LIMIT";
                Icon = OctagonAlert;
              } else if (sev === "warn") {
                borderLeftColor = "var(--warn, #B7791F)";
                badgeClass = "badge-warning";
                badgeText = "WARNING";
                Icon = AlertTriangle;
              } else if (sev === "tip") {
                borderLeftColor = "var(--info, #2A6496)";
                badgeClass = "badge";
                badgeText = "EFFICIENCY TIP";
                Icon = Lightbulb;
              } else if (sev === "ok") {
                borderLeftColor = "var(--ok, #2D7D46)";
                badgeClass = "badge-ok";
                badgeText = "NOMINAL (OK)";
                Icon = CheckCircle2;
              }

              return (
                <div
                  key={(sug as unknown as { id?: string }).id ?? idx}
                  style={{
                    background: "var(--color-surface)",
                    border: "1px solid var(--color-border)",
                    borderLeft: `4px solid ${borderLeftColor}`,
                    borderRadius: 4,
                    padding: "14px 18px",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 14,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flex: 1, minWidth: 280 }}>
                    <div style={{ marginTop: 2, color: borderLeftColor }}>
                      <Icon size={18} aria-hidden="true" />
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className={`badge ${badgeClass}`} style={{ fontSize: 11, fontWeight: 600 }}>
                          {badgeText}
                        </span>
                        {suggestedParam && (
                          <span className="fine" style={{ fontFamily: "var(--font-mono)" }}>
                            Param: {suggestedParam}
                          </span>
                        )}
                      </div>
                      <p style={{ margin: 0, fontSize: 14, color: "var(--color-text)", lineHeight: 1.5 }}>
                        {message}
                      </p>
                    </div>
                  </div>

                  {/* Recommended Action / Fix Button */}
                  {(hasFix || suggestedParam) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {hasFix && onApplyFix && (
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => onApplyFix(fixObj!)}
                          title="Apply suggested setpoint to plant simulation parameters"
                        >
                          <Wrench size={12} aria-hidden="true" />
                          <span>
                            Apply Fix ({Object.entries(fixObj!).map(([k, v]) => `${k} = ${v}`).join(", ")})
                          </span>
                        </button>
                      )}
                      {!hasFix && suggestedParam && suggestedVal !== undefined && (
                        <span
                          className="badge"
                          style={{
                            background: "var(--color-surface-alt)",
                            fontFamily: "var(--font-mono)",
                            fontSize: 12,
                          }}
                        >
                          Recommended: {suggestedParam} = {suggestedVal}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    );
  }
);

SuggestionList.displayName = "SuggestionList";
export default SuggestionList;
