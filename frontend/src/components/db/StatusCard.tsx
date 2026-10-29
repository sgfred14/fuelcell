import React, { useMemo } from "react";
import { CheckCircle2, AlertTriangle, OctagonAlert, Database, UploadCloud, RefreshCw } from "lucide-react";
import type { MongoStatusResponse } from "../../types";

export function maskMongoUri(uri?: string | null): string {
  if (!uri) return "—";
  return uri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@");
}

export interface StatusCardProps {
  status: MongoStatusResponse | null;
  loading?: boolean;
  onFlush?: () => Promise<void> | void;
  onOpenReconnect?: () => void;
  isFlushing?: boolean;
}

export const StatusCard: React.FC<StatusCardProps> = React.memo(
  ({ status, loading = false, onFlush, onOpenReconnect, isFlushing = false }) => {
    const totalCloud = useMemo(() => {
      if (!status?.cloud_counts) return 0;
      return Object.values(status.cloud_counts).reduce((acc, count) => acc + (typeof count === "number" ? count : 0), 0);
    }, [status?.cloud_counts]);

    const totalLocal = useMemo(() => {
      if (!status?.local_buffer_counts) return 0;
      return Object.values(status.local_buffer_counts).reduce((acc, count) => acc + (typeof count === "number" ? count : 0), 0);
    }, [status?.local_buffer_counts]);

    const isConnected = status?.connected ?? false;
    const isOfflineBuffering = status?.mode === "offline_buffer";
    const pendingSize = status?.pending_buffer_size ?? totalLocal;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
        {/* KPI Grid */}
        <div className="kpi-grid" role="region" aria-label="MongoDB Connection and Buffer Metrics">
          {/* 1. Connection Health */}
          <div className="kpi-card">
            <span className="kpi-label">Connection Health</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              {isConnected ? (
                <span className="badge badge-ok">
                  <CheckCircle2 size={14} aria-hidden="true" />
                  <span>CONNECTED</span>
                </span>
              ) : isOfflineBuffering ? (
                <span className="badge badge-warning">
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>BUFFERING LOCALLY</span>
                </span>
              ) : (
                <span className="badge badge-alarm">
                  <OctagonAlert size={14} aria-hidden="true" />
                  <span>NOT CONNECTED</span>
                </span>
              )}
            </div>
            <span className="kpi-sub">
              Driver: {status?.mode ? status.mode.toUpperCase() : "OFFLINE_BUFFER"}
            </span>
          </div>

          {/* 2. Target Database */}
          <div className="kpi-card">
            <span className="kpi-label">Target Database</span>
            <span className="kpi-value" style={{ fontSize: 20 }}>
              {status?.database ?? "sofc_monitor"}
            </span>
            <span className="kpi-sub" title={status?.target ?? ""}>
              Cluster: {maskMongoUri(status?.target ?? "mongodb+srv://***:***@cluster0.mongodb.net")}
            </span>
          </div>

          {/* 3. Total Cloud Documents */}
          <div className="kpi-card">
            <span className="kpi-label">Cloud Documents</span>
            <span className="kpi-value num">
              {totalCloud.toLocaleString()}{" "}
              <small className="kpi-unit">records</small>
            </span>
            <span className="kpi-sub">
              Ticks: {status?.cloud_counts?.telemetry_ticks?.toLocaleString() ?? "0"} | Alerts: {status?.cloud_counts?.alerts?.toLocaleString() ?? "0"}
            </span>
          </div>

          {/* 4. Pending Local Buffer */}
          <div className="kpi-card">
            <span className="kpi-label">Pending Local Buffer</span>
            <span className="kpi-value num">
              {pendingSize.toLocaleString()}{" "}
              <small className="kpi-unit">docs</small>
            </span>
            <span className="kpi-sub">
              Buffer status: {pendingSize === 0 ? "Synchronized" : "Queued"}
            </span>
          </div>

          {/* 5. Total Flushes */}
          <div className="kpi-card">
            <span className="kpi-label">Total Flushes</span>
            <span className="kpi-value num">
              {status?.stats?.flushes_total?.toLocaleString() ?? "0"}
            </span>
            <span className="kpi-sub">
              Last flush: {status?.stats?.last_flush_ts ? new Date(status.stats.last_flush_ts).toLocaleTimeString() : "Ready"}
            </span>
          </div>
        </div>

        {/* Database Operations Toolbar */}
        {(onFlush || onOpenReconnect) && (
          <section className="chart-card" style={{ padding: "16px 20px" }} aria-label="Database Management Actions">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Database size={18} style={{ color: "var(--color-primary)" }} aria-hidden="true" />
                <strong>Database Operations &amp; Buffer Control</strong>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                {onFlush && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void onFlush()}
                    disabled={isFlushing || loading}
                    title="Commit in-memory buffered records to MongoDB"
                  >
                    <UploadCloud size={14} className={isFlushing ? "spin" : ""} aria-hidden="true" />
                    <span>{isFlushing ? "Flushing Buffer..." : "Flush Buffer Now"}</span>
                  </button>
                )}
                {onOpenReconnect && (
                  <button
                    type="button"
                    className="btn"
                    onClick={onOpenReconnect}
                    disabled={loading}
                    title="Test connection and reconnect database driver"
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    <span>Reconnect Database</span>
                  </button>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    );
  }
);

StatusCard.displayName = "StatusCard";
