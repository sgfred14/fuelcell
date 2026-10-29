import React, { useCallback } from "react";
import type { MongoStatusResponse } from "../../types";

export type CollectionTabKey = "telemetry_ticks" | "alerts" | "simulations" | "thermo_calculations";

export interface CollectionTabsProps {
  activeTab: CollectionTabKey;
  onTabChange: (tab: CollectionTabKey) => void;
  status: MongoStatusResponse | null;
}

interface TabDef {
  key: CollectionTabKey;
  label: string;
  countKey: string;
}

const TABS: TabDef[] = [
  { key: "telemetry_ticks", label: "Telemetry Ticks (telemetry_ticks)", countKey: "telemetry_ticks" },
  { key: "alerts", label: "System Alerts (alerts)", countKey: "alerts" },
  { key: "simulations", label: "Simulation Runs (simulations)", countKey: "simulations" },
  { key: "thermo_calculations", label: "Calculations (thermo_calculations)", countKey: "thermo_calculations" },
];

export const CollectionTabs: React.FC<CollectionTabsProps> = React.memo(({ activeTab, onTabChange, status }) => {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        const next = (index + 1) % TABS.length;
        onTabChange(TABS[next].key);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const prev = (index - 1 + TABS.length) % TABS.length;
        onTabChange(TABS[prev].key);
      }
    },
    [onTabChange]
  );

  return (
    <div
      role="tablist"
      aria-label="Database Collections"
      style={{
        display: "flex",
        borderBottom: "1px solid var(--color-border)",
        gap: 8,
        marginBottom: 16,
        overflowX: "auto",
      }}
    >
      {TABS.map((tab, idx) => {
        const isActive = activeTab === tab.key;
        const count = status?.cloud_counts?.[tab.countKey];

        return (
          <button
            key={tab.key}
            id={`tab-${tab.key}`}
            role="tab"
            aria-selected={isActive}
            aria-controls={`panel-${tab.key}`}
            tabIndex={isActive ? 0 : -1}
            type="button"
            className="btn btn-small"
            onClick={() => onTabChange(tab.key)}
            onKeyDown={(e) => handleKeyDown(e, idx)}
            style={{
              borderRadius: "4px 4px 0 0",
              borderBottom: isActive ? "2px solid var(--color-primary)" : "none",
              background: isActive ? "var(--color-surface-alt)" : "transparent",
              fontWeight: isActive ? 600 : 400,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 14px",
              cursor: "pointer",
            }}
          >
            <span>{tab.label}</span>
            {count !== undefined && typeof count === "number" && (
              <span
                className="badge"
                style={{
                  fontSize: 11,
                  padding: "1px 6px",
                  background: isActive ? "var(--color-surface)" : "var(--color-surface-alt)",
                }}
              >
                {count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});

CollectionTabs.displayName = "CollectionTabs";
