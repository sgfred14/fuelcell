import React, { useState, useMemo, useCallback } from "react";
import { Check, Copy, ChevronDown, ChevronRight, FileText, Code, ListTree, AlertCircle } from "lucide-react";

export function formatJsonInspector(doc: unknown): string {
  if (doc === null || doc === undefined) return "";
  try {
    return JSON.stringify(doc, null, 2);
  } catch {
    return String(doc);
  }
}

export interface JsonInspectorProps {
  doc: unknown | null;
  className?: string;
}

// Error Boundary for resilient rendering of malformed or unexpected data
interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class JsonErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div
          role="alert"
          style={{
            padding: 16,
            background: "rgba(192, 57, 43, 0.08)",
            border: "1px solid var(--color-error)",
            borderRadius: 4,
            color: "var(--color-error)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <AlertCircle size={18} aria-hidden="true" />
          <div>
            <strong>Failed to parse JSON document</strong>
            <p style={{ margin: 0, fontSize: 13 }}>{this.state.error?.message ?? "Unknown serialization error"}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Recursive Tree Node Component
interface JsonTreeNodeProps {
  label?: string;
  value: unknown;
  isLast?: boolean;
  depth?: number;
}

const JsonTreeNode: React.FC<JsonTreeNodeProps> = React.memo(({ label, value, isLast = true, depth = 0 }) => {
  const [expanded, setExpanded] = useState<boolean>(depth < 2);

  const toggleExpanded = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggleExpanded(e);
      }
    },
    [toggleExpanded]
  );

  // Primitive value renderer with syntax coloring
  const renderPrimitive = (val: unknown) => {
    if (val === null) {
      return <span style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>null</span>;
    }
    if (val === undefined) {
      return <span style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>undefined</span>;
    }
    if (typeof val === "boolean") {
      return <span style={{ color: "#8E44AD", fontWeight: 600 }}>{val ? "true" : "false"}</span>;
    }
    if (typeof val === "number") {
      return <span style={{ color: "var(--warn, #C47F17)", fontFamily: "var(--font-mono)" }}>{val}</span>;
    }
    if (typeof val === "string") {
      return <span style={{ color: "var(--ok, #2D7D46)" }}>"{val}"</span>;
    }
    return <span>{String(val)}</span>;
  };

  const isObject = value !== null && typeof value === "object";
  const isArray = Array.isArray(value);

  if (!isObject) {
    return (
      <div style={{ paddingLeft: depth * 16, lineHeight: "1.6", fontFamily: "var(--font-mono)", fontSize: 13 }}>
        {label && <span style={{ color: "var(--color-primary)", fontWeight: 500 }}>"{label}": </span>}
        {renderPrimitive(value)}
        {!isLast && <span style={{ color: "var(--color-text-muted)" }}>,</span>}
      </div>
    );
  }

  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  const count = entries.length;
  const openBracket = isArray ? "[" : "{";
  const closeBracket = isArray ? "]" : "}";

  return (
    <div style={{ paddingLeft: depth * 16, lineHeight: "1.6", fontFamily: "var(--font-mono)", fontSize: 13 }}>
      <span
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggleExpanded}
        onKeyDown={handleKeyDown}
        style={{
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          userSelect: "none",
          verticalAlign: "middle",
        }}
      >
        {expanded ? (
          <ChevronDown size={14} style={{ color: "var(--color-text-muted)" }} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} style={{ color: "var(--color-text-muted)" }} aria-hidden="true" />
        )}
        {label && <span style={{ color: "var(--color-primary)", fontWeight: 500 }}>"{label}": </span>}
        <span style={{ color: "var(--color-text-muted)" }}>{openBracket}</span>
      </span>

      {!expanded && (
        <span
          onClick={toggleExpanded}
          style={{
            cursor: "pointer",
            color: "var(--color-text-muted)",
            fontSize: 12,
            margin: "0 6px",
            background: "var(--color-surface-alt)",
            padding: "1px 6px",
            borderRadius: 3,
            border: "1px solid var(--color-border)",
          }}
        >
          {isArray ? `${count} items` : `${count} keys`}
        </span>
      )}

      {expanded && (
        <div>
          {entries.map(([key, val], idx) => (
            <JsonTreeNode
              key={key}
              label={isArray ? undefined : key}
              value={val}
              isLast={idx === count - 1}
              depth={depth + 1}
            />
          ))}
        </div>
      )}

      <span style={{ color: "var(--color-text-muted)" }}>{closeBracket}</span>
      {!isLast && <span style={{ color: "var(--color-text-muted)" }}>,</span>}
    </div>
  );
});

// Syntax highlighted raw JSON text block
const HighlightedRawJson: React.FC<{ jsonString: string }> = React.memo(({ jsonString }) => {
  const highlightedTokens = useMemo(() => {
    // Regex matches JSON tokens: strings/keys, numbers, booleans, null
    const tokenRegex = /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}[\],])/g;
    const elements: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(jsonString)) !== null) {
      if (match.index > lastIndex) {
        elements.push(jsonString.substring(lastIndex, match.index));
      }

      const token = match[0];
      if (/^"/.test(token)) {
        if (/:$/.test(token)) {
          // Key with trailing colon
          const keyName = token.slice(0, -1);
          elements.push(
            <span key={match.index} style={{ color: "var(--color-primary)", fontWeight: 500 }}>
              {keyName}
            </span>
          );
          elements.push(
            <span key={`${match.index}-colon`} style={{ color: "var(--color-text-muted)" }}>
              :
            </span>
          );
        } else {
          // String value
          elements.push(
            <span key={match.index} style={{ color: "var(--ok, #2D7D46)" }}>
              {token}
            </span>
          );
        }
      } else if (/true|false/.test(token)) {
        elements.push(
          <span key={match.index} style={{ color: "#8E44AD", fontWeight: 600 }}>
            {token}
          </span>
        );
      } else if (/null/.test(token)) {
        elements.push(
          <span key={match.index} style={{ color: "var(--color-text-muted)", fontStyle: "italic" }}>
            {token}
          </span>
        );
      } else if (/[{}[\],]/.test(token)) {
        elements.push(
          <span key={match.index} style={{ color: "var(--color-text-muted)" }}>
            {token}
          </span>
        );
      } else {
        // Number
        elements.push(
          <span key={match.index} style={{ color: "var(--warn, #C47F17)", fontFamily: "var(--font-mono)" }}>
            {token}
          </span>
        );
      }
      lastIndex = tokenRegex.lastIndex;
    }

    if (lastIndex < jsonString.length) {
      elements.push(jsonString.substring(lastIndex));
    }

    return elements;
  }, [jsonString]);

  return <code>{highlightedTokens}</code>;
});

export const JsonInspector: React.FC<JsonInspectorProps> = React.memo(({ doc, className = "" }) => {
  const [viewMode, setViewMode] = useState<"raw" | "tree">("tree");
  const [copied, setCopied] = useState<boolean>(false);

  const formattedJson = useMemo(() => {
    return formatJsonInspector(doc);
  }, [doc]);

  const handleCopy = useCallback(async () => {
    if (!formattedJson) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(formattedJson);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = formattedJson;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [formattedJson]);

  return (
    <section className={`chart-card ${className}`} aria-label="JSON Document Inspector">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h2 style={{ fontSize: 18, margin: 0 }}>Document Inspector</h2>
          {doc !== null && doc !== undefined && (
            <div style={{ display: "flex", gap: 4 }} role="group" aria-label="Inspector View Mode">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setViewMode("tree")}
                style={{
                  background: viewMode === "tree" ? "var(--color-surface-alt)" : "transparent",
                  fontWeight: viewMode === "tree" ? 600 : 400,
                  border: "1px solid var(--color-border)",
                }}
                aria-pressed={viewMode === "tree"}
                title="Expandable Interactive Tree View"
              >
                <ListTree size={13} aria-hidden="true" />
                <span>Tree View</span>
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setViewMode("raw")}
                style={{
                  background: viewMode === "raw" ? "var(--color-surface-alt)" : "transparent",
                  fontWeight: viewMode === "raw" ? 600 : 400,
                  border: "1px solid var(--color-border)",
                }}
                aria-pressed={viewMode === "raw"}
                title="Raw Syntax-Highlighted Formatted JSON Block"
              >
                <Code size={13} aria-hidden="true" />
                <span>Raw JSON</span>
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="btn btn-small"
          onClick={handleCopy}
          disabled={!doc}
          aria-live="polite"
          title="Copy JSON document to system clipboard"
          style={{ minWidth: 100 }}
        >
          {copied ? (
            <>
              <Check size={14} style={{ color: "var(--ok, #2D7D46)" }} aria-hidden="true" />
              <span style={{ color: "var(--ok, #2D7D46)" }}>Copied!</span>
            </>
          ) : (
            <>
              <Copy size={14} aria-hidden="true" />
              <span>Copy JSON</span>
            </>
          )}
        </button>
      </div>

      <JsonErrorBoundary>
        {doc === null || doc === undefined ? (
          <div
            role="status"
            style={{
              padding: "48px 20px",
              textAlign: "center",
              background: "var(--color-surface-alt)",
              border: "1px dashed var(--color-border)",
              borderRadius: 4,
              color: "var(--color-text-muted)",
            }}
          >
            <FileText size={36} style={{ margin: "0 auto 12px", opacity: 0.5, display: "block" }} aria-hidden="true" />
            <strong style={{ display: "block", fontSize: 15, color: "var(--color-text)" }}>No document selected</strong>
            <p style={{ margin: "6px 0 0", fontSize: 13 }}>
              Select any record in the collection table above to inspect its full JSON document hierarchy and payload.
            </p>
          </div>
        ) : viewMode === "tree" ? (
          <div
            style={{
              background: "var(--color-surface-alt)",
              padding: 16,
              borderRadius: 4,
              border: "1px solid var(--color-border)",
              overflowX: "auto",
              maxHeight: 380,
            }}
            tabIndex={0}
            role="region"
            aria-label="Expandable JSON Tree"
          >
            <JsonTreeNode value={doc} />
          </div>
        ) : (
          <pre
            style={{
              background: "var(--color-surface-alt)",
              padding: 16,
              borderRadius: 4,
              border: "1px solid var(--color-border)",
              fontSize: 13,
              overflowX: "auto",
              maxHeight: 380,
              margin: 0,
            }}
            tabIndex={0}
            role="region"
            aria-label="Formatted Syntax-Highlighted JSON"
          >
            <HighlightedRawJson jsonString={formattedJson} />
          </pre>
        )}
      </JsonErrorBoundary>
    </section>
  );
});

JsonInspector.displayName = "JsonInspector";
