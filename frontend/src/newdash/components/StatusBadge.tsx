import { AlertTriangle, CheckCircle2, CircleHelp, OctagonAlert } from "lucide-react";
import type { Status } from "../types";
import { statusLabel } from "../lib/format";

const ICON = { ok: CheckCircle2, warning: AlertTriangle, alarm: OctagonAlert, unknown: CircleHelp } as const;

/** Status is always shown as icon + word, never colour alone. */
export function StatusBadge({ status, size = 15 }: { status: Status; size?: number }) {
  const Icon = ICON[status];
  return (
    <span className={`badge badge-${status}`}>
      <Icon size={size} aria-hidden="true" />
      <span>{statusLabel(status)}</span>
    </span>
  );
}

export function StatusDot({ status }: { status: Status }) {
  return <span className={`dot dot-${status}`} role="img" aria-label={statusLabel(status)} />;
}
