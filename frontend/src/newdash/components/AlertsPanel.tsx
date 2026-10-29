import { BellRing, CheckCheck } from "lucide-react";
import type { Alert } from "../types";
import { fmtClock, fmtDuration, minutesBetween, sourceLabel } from "../lib/format";
import { StatusBadge } from "./StatusBadge";

interface Props {
  alerts: Alert[];
  recent: Alert[];
  now: string | null;
  names: Record<string, string>;
  onAck: (id: number) => void;
  onSelect: (utility: string) => void;
}

function Sources({ a }: { a: Alert }) {
  return (
    <span className="tags">
      {a.sources.map((s) => (
        <span key={s} className={`tag tag-${s}`}>{s === a.source ? sourceLabel(s) : `${sourceLabel(s)} agrees`}</span>
      ))}
    </span>
  );
}

export function AlertsPanel({ alerts, recent, now, names, onAck, onSelect }: Props) {
  return (
    <section className="panel" aria-labelledby="alerts-h">
      <h2 id="alerts-h" className="panel-title">
        <BellRing size={16} aria-hidden="true" /> Alerts
        <span className="count" aria-label={`${alerts.length} active`}>{alerts.length}</span>
      </h2>
      <div aria-live="polite">
        {alerts.length === 0 && (
          <p className="empty">
            <CheckCheck size={16} aria-hidden="true" /> No active alerts. Every monitored utility is within its limits.
          </p>
        )}
        <ul className="alerts">
          {alerts.map((a) => (
            <li key={a.id} className={`alert alert-${a.severity}${a.acknowledged ? " is-acked" : ""}`}>
              <div className="alert-top">
                <StatusBadge status={a.severity} />
                <button type="button" className="link" onClick={() => onSelect(a.utility)}>{names[a.utility] ?? "Plant-wide"}</button>
                <time className="alert-time" dateTime={a.first_ts}>
                  since {fmtClock(a.first_ts)}{now ? ` · ${fmtDuration(minutesBetween(a.first_ts, now))}` : ""}
                </time>
              </div>
              <p className="alert-title">{a.title}</p>
              <p className="alert-detail">{a.detail}</p>
              <Sources a={a} />
              {a.hint && (
                <details className="hint">
                  <summary>What to check</summary>
                  <p>{a.hint}</p>
                </details>
              )}
              <div className="alert-actions">
                {a.acknowledged ? <span className="acked">Acknowledged</span> : (
                  <button type="button" className="btn btn-small" onClick={() => onAck(a.id)}>Acknowledge</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
      {recent.length > 0 && (
        <details className="recent">
          <summary>Recently cleared ({recent.length})</summary>
          <ul>
            {recent.slice(0, 12).map((a) => (
              <li key={`${a.id}-${a.cleared_ts}`}>
                <span className="muted">{fmtClock(a.cleared_ts)}</span> {names[a.utility] ?? "Plant-wide"}: {a.title}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
