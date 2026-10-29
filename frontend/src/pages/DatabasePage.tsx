import { useState, useEffect, useCallback } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { api } from "../api";
import type { MongoStatusResponse } from "../types";
import {
  StatusCard,
  CollectionTabs,
  CollectionTable,
  JsonInspector,
  ReconnectModal,
  type CollectionTabKey,
} from "../components/db";

const DEFAULT_STATUS: MongoStatusResponse = {
  enabled: true,
  connected: false,
  status_text: "NOT CONNECTED",
  mode: "offline_buffer",
  database: "sofc_monitor",
  target: "mongodb+srv://***:***@cluster0.mongodb.net",
  uri_configured: false,
  cloud_counts: {
    telemetry_ticks: 0,
    alerts: 0,
    simulations: 0,
    thermo_calculations: 0,
  },
  local_buffer_counts: {
    telemetry_ticks: 0,
    alerts: 0,
    simulations: 0,
    thermo_calculations: 0,
  },
  pending_buffer_size: 0,
  stats: {
    ticks_queued: 0,
    ticks_written: 0,
    alerts_written: 0,
    sims_written: 0,
    calcs_written: 0,
    flushes_total: 0,
    failed_flushes: 0,
    last_flush_ts: null,
  },
  last_error: null,
};

function normalizeStatus(raw?: Partial<MongoStatusResponse> | null): MongoStatusResponse {
  if (!raw) return DEFAULT_STATUS;
  return {
    ...DEFAULT_STATUS,
    ...raw,
    cloud_counts: {
      ...DEFAULT_STATUS.cloud_counts,
      ...(raw.cloud_counts ?? {}),
    },
    local_buffer_counts: {
      ...DEFAULT_STATUS.local_buffer_counts,
      ...(raw.local_buffer_counts ?? {}),
    },
    stats: {
      ...DEFAULT_STATUS.stats,
      ...(raw.stats ?? {}),
    },
  };
}

async function fetchActiveCollection(tab: CollectionTabKey): Promise<unknown[]> {
  if (tab === "telemetry_ticks") {
    const res = await api.dbTicks({ limit: 50 });
    return Array.isArray(res) ? res : [];
  }
  if (tab === "alerts") {
    const res = await api.dbAlerts({ limit: 50 });
    return Array.isArray(res) ? res : [];
  }
  if (tab === "simulations") {
    const res = await api.dbSimulations({ limit: 50 });
    return Array.isArray(res) ? res : [];
  }
  const res = await api.dbCalculations({ limit: 50 });
  return Array.isArray(res) ? res : [];
}

export default function DatabasePage() {
  const [activeTab, setActiveTab] = useState<CollectionTabKey>("telemetry_ticks");
  const [status, setStatus] = useState<MongoStatusResponse>(DEFAULT_STATUS);
  const [records, setRecords] = useState<unknown[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<unknown | null>(null);

  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [flushLoading, setFlushLoading] = useState<boolean>(false);
  const [flushMessage, setFlushMessage] = useState<string | null>(null);
  const [isReconnectOpen, setIsReconnectOpen] = useState<boolean>(false);


  // Data fetching for Status and Collection records (React Best Practices: async-parallel)
  const loadData = useCallback(async (tabToLoad: CollectionTabKey) => {
    setLoading(true);
    setError(null);
    try {
      // Execute both independent fetches concurrently using Promise.all to avoid sequential waterfall
      const [statusRes, recordsRes] = await Promise.all([
        api.dbStatus(),
        fetchActiveCollection(tabToLoad),
      ]);

      setStatus(normalizeStatus(statusRes));
      const safeRecords = Array.isArray(recordsRes) ? recordsRes : [];
      setRecords(safeRecords);
      // Auto-select first record if none selected or if switching tabs
      if (safeRecords.length > 0) {
        setSelectedDoc(safeRecords[0]);
      } else {
        setSelectedDoc(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load database records from server");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    Promise.all([api.dbStatus(), fetchActiveCollection(activeTab)])
      .then(([statusRes, recordsRes]) => {
        if (!mounted) return;
        setStatus(normalizeStatus(statusRes));
        const safeRecords = Array.isArray(recordsRes) ? recordsRes : [];
        setRecords(safeRecords);
        if (safeRecords.length > 0) {
          setSelectedDoc(safeRecords[0]);
        } else {
          setSelectedDoc(null);
        }
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "Failed to load database records from server");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [activeTab]);

  // Tab change handler
  const handleTabChange = useCallback((tab: CollectionTabKey) => {
    setActiveTab(tab);
  }, []);

  // Flush buffer handler
  const handleFlush = useCallback(async () => {
    setFlushLoading(true);
    setFlushMessage(null);
    try {
      const res = await api.dbFlush();
      if (res && res.flushed) {
        setStatus(normalizeStatus(res.status));
        setFlushMessage("Local buffer committed successfully to MongoDB Atlas.");
        setTimeout(() => setFlushMessage(null), 3000);
        // Refresh active collection records after flush
        const updatedRecords = await fetchActiveCollection(activeTab);
        setRecords(Array.isArray(updatedRecords) ? updatedRecords : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to execute database buffer flush");
    } finally {
      setFlushLoading(false);
    }
  }, [activeTab]);

  // Reconnect handler
  const handleReconnect = useCallback(
    async (uri?: string, db_name?: string) => {
      const updatedStatus = await api.dbReconnect({ uri, db_name });
      setStatus(normalizeStatus(updatedStatus));
      await loadData(activeTab);
    },
    [activeTab, loadData]
  );

  return (
    <div className="page" role="main">
      <div className="page-header">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1>Database Explorer</h1>
            <p>
              Cloud MongoDB Atlas telemetry archives, system event logs, and local buffer synchronization.
            </p>
          </div>
          {loading && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--color-text-muted)", fontSize: 13, paddingTop: 8 }}>
              <RefreshCw size={14} className="spin" aria-hidden="true" />
              <span>Fetching telemetry data...</span>
            </div>
          )}
        </div>
      </div>

      {/* Global Error Notice with Retry Action (satisfies TC-T2.01.08) */}
      {error && (
        <div
          role="alert"
          style={{
            padding: "14px 18px",
            background: "rgba(192, 57, 43, 0.08)",
            border: "1px solid var(--color-error)",
            borderRadius: 6,
            color: "var(--color-error)",
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AlertCircle size={18} aria-hidden="true" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => loadData(activeTab)}
            style={{ borderColor: "var(--color-error)", color: "var(--color-error)" }}
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* Flush Success Notice */}
      {flushMessage && (
        <div
          role="status"
          aria-live="polite"
          style={{
            padding: "12px 18px",
            background: "rgba(45, 125, 70, 0.08)",
            border: "1px solid var(--ok, #2D7D46)",
            borderRadius: 6,
            color: "var(--ok, #2D7D46)",
            marginBottom: 20,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <strong>Success:</strong> {flushMessage}
        </div>
      )}

      {/* Connection Health & Status KPI Grid + Operations Control Toolbar */}
      <StatusCard
        status={status}
        loading={loading}
        onFlush={handleFlush}
        onOpenReconnect={() => setIsReconnectOpen(true)}
        isFlushing={flushLoading}
      />

      {/* Collection Browser (Tabs, Search, Filter, and Table) */}
      <section className="chart-card" aria-label="Collection Browser" style={{ marginBottom: 20 }}>
        <CollectionTabs activeTab={activeTab} onTabChange={handleTabChange} status={status} />

        <CollectionTable
          activeTab={activeTab}
          records={records}
          loading={loading}
          selectedDoc={selectedDoc}
          onSelectDoc={setSelectedDoc}
        />
      </section>

      {/* Formatted JSON Document Inspector */}
      <JsonInspector doc={selectedDoc} />

      {/* Reconnect Target Modal */}
      <ReconnectModal
        isOpen={isReconnectOpen}
        onClose={() => setIsReconnectOpen(false)}
        onReconnect={handleReconnect}
        currentDbName={status?.database}
        currentUri={status?.target}
      />
    </div>
  );
}
