import React, { useState, useEffect, useCallback } from "react";
import { RefreshCw, X, AlertCircle } from "lucide-react";

export interface ReconnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onReconnect: (uri?: string, db_name?: string) => Promise<void>;
  currentDbName?: string;
  currentUri?: string;
}

export const ReconnectModal: React.FC<ReconnectModalProps> = React.memo(
  ({ isOpen, onClose, onReconnect, currentDbName = "sofc_monitor", currentUri = "" }) => {
    const [uri, setUri] = useState<string>(currentUri);
    const [dbName, setDbName] = useState<string>(currentDbName);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      if (isOpen) {
        setUri(currentUri);
        setDbName(currentDbName);
        setError(null);
      }
    }, [isOpen, currentUri, currentDbName]);

    // Close on Escape key
    useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && isOpen && !loading) {
          onClose();
        }
      };
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [isOpen, loading, onClose]);

    const handleSubmit = useCallback(
      async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
          await onReconnect(uri.trim() || undefined, dbName.trim() || undefined);
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to reconnect database");
        } finally {
          setLoading(false);
        }
      },
      [uri, dbName, onReconnect, onClose]
    );

    if (!isOpen) return null;

    return (
      <div
        role="presentation"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(30, 32, 34, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: 16,
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && !loading) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reconnect-dialog-title"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            width: "100%",
            maxWidth: 500,
            padding: 24,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <h3 id="reconnect-dialog-title" style={{ fontSize: 19, margin: 0 }}>
              Database Reconnect &amp; Target Setup
            </h3>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              disabled={loading}
              aria-label="Close reconnect dialog"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <p style={{ fontSize: 14, color: "var(--color-text-muted)", marginBottom: 20 }}>
            Specify a target MongoDB connection URI and database name. When applied, the backend driver tests the
            connection ping and initializes buffer flushing.
          </p>

          {error && (
            <div
              role="alert"
              style={{
                padding: "10px 14px",
                background: "rgba(192, 57, 43, 0.08)",
                border: "1px solid var(--color-error)",
                borderRadius: 4,
                color: "var(--color-error)",
                fontSize: 13,
                marginBottom: 16,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 16 }}>
              <label
                htmlFor="mongo-uri-input"
                style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}
              >
                MongoDB Target URI
              </label>
              <input
                id="mongo-uri-input"
                type="text"
                value={uri}
                onChange={(e) => setUri(e.target.value)}
                placeholder="mongodb+srv://user:pass@cluster.mongodb.net or mongodb://localhost:27017"
                style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 13 }}
                disabled={loading}
              />
              <span className="fine" style={{ display: "block", marginTop: 4 }}>
                Leave empty to retain the backend default / environment configuration.
              </span>
            </div>

            <div style={{ marginBottom: 24 }}>
              <label
                htmlFor="mongo-dbname-input"
                style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}
              >
                Database Name
              </label>
              <input
                id="mongo-dbname-input"
                type="text"
                value={dbName}
                onChange={(e) => setDbName(e.target.value)}
                placeholder="sofc_monitor"
                style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 13 }}
                disabled={loading}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                type="button"
                className="btn"
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />
                <span>{loading ? "Reconnecting..." : "Apply & Reconnect"}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }
);

ReconnectModal.displayName = "ReconnectModal";
