import React, { useState, useEffect, useCallback } from "react";
import { X, Cable, AlertCircle } from "lucide-react";

export interface ConnectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (modelPath?: string, progid?: string) => Promise<void>;
  currentModelPath?: string | null;
  currentProgId?: string;
}

export const ConnectModal: React.FC<ConnectModalProps> = React.memo(
  ({
    isOpen,
    onClose,
    onConnect,
    currentModelPath = "",
    currentProgId = "Apwn.Document",
  }) => {
    const [modelPath, setModelPath] = useState<string>(currentModelPath ?? "");
    const [progId, setProgId] = useState<string>(currentProgId ?? "Apwn.Document");
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      if (isOpen) {
        setModelPath(currentModelPath ?? "");
        setProgId(currentProgId ?? "Apwn.Document");
        setError(null);
      }
    }, [isOpen, currentModelPath, currentProgId]);

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
          await onConnect(modelPath.trim() || undefined, progId.trim() || undefined);
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to connect to Aspen Plus COM server");
        } finally {
          setLoading(false);
        }
      },
      [modelPath, progId, onConnect, onClose]
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
          aria-labelledby="aspen-connect-dialog-title"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            width: "100%",
            maxWidth: 540,
            padding: 24,
          }}
        >
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Cable size={20} style={{ color: "var(--color-primary)" }} aria-hidden="true" />
              <h3 id="aspen-connect-dialog-title" style={{ fontSize: 19, margin: 0 }}>
                Aspen Plus COM Connection Setup
              </h3>
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={onClose}
              disabled={loading}
              title="Close setup modal"
              aria-label="Close dialog"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          <p className="fine" style={{ marginBottom: 16 }}>
            Configure the local Aspen Plus document path and Windows COM Automation ProgID. If no Aspen instance is running on Windows, the system transparently utilizes the calibrated PR-BM thermodynamic digital twin fallback.
          </p>

          {error && (
            <div
              role="alert"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "10px 14px",
                background: "rgba(192, 57, 43, 0.08)",
                border: "1px solid var(--color-error)",
                borderRadius: 4,
                color: "var(--color-error)",
                fontSize: 13,
                marginBottom: 16,
              }}
            >
              <AlertCircle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Aspen Model File Path */}
              <div>
                <label
                  htmlFor="aspen-model-path-input"
                  style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}
                >
                  Aspen Plus Model File (.bkp / .apw)
                </label>
                <input
                  id="aspen-model-path-input"
                  type="text"
                  placeholder="e.g. C:\SOFC_Models\AspenPlus_SOFC_PRBM.bkp"
                  value={modelPath}
                  onChange={(e) => setModelPath(e.target.value)}
                  disabled={loading}
                  style={{ width: "100%", padding: "8px 10px", fontFamily: "var(--font-mono)" }}
                />
                <small className="fine" style={{ display: "block", marginTop: 4 }}>
                  Leave empty to connect to the currently active or default Aspen Plus session.
                </small>
              </div>

              {/* COM ProgID */}
              <div>
                <label
                  htmlFor="aspen-progid-input"
                  style={{ display: "block", fontSize: 13, fontWeight: 600, marginBottom: 4 }}
                >
                  Windows COM Automation ProgID
                </label>
                <input
                  id="aspen-progid-input"
                  type="text"
                  placeholder="Apwn.Document"
                  value={progId}
                  onChange={(e) => setProgId(e.target.value)}
                  disabled={loading}
                  style={{ width: "100%", padding: "8px 10px", fontFamily: "var(--font-mono)" }}
                />
                <small className="fine" style={{ display: "block", marginTop: 4 }}>
                  Standard COM ProgID: <code>Apwn.Document</code> for Aspen Plus v11/v12/v14.
                </small>
              </div>
            </div>

            {/* Modal Actions */}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 10,
                marginTop: 22,
                paddingTop: 16,
                borderTop: "1px solid var(--color-border)",
              }}
            >
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
              >
                {loading ? "Connecting..." : "Connect to Aspen"}
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }
);

ConnectModal.displayName = "ConnectModal";
export default ConnectModal;
