import { Flame, Wifi, WifiOff } from "lucide-react";
import type { Conn } from "../store";
import type { Status } from "../types";
import { fmtClock, statusLabel } from "../lib/format";

interface Props {
  conn: Conn;
  overall: Status;
  warnings: number;
  alarms: number;
  plantTime: string | null;
  feedStale: boolean;
  feedAgeS: number | null;
  simRunning: boolean;
}

export function TopBar({ conn, overall, warnings, alarms, plantTime, feedStale, feedAgeS, simRunning }: Props) {
  const summary = alarms ? `${alarms} alarm${alarms > 1 ? "s" : ""}${warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}` : warnings ? `${warnings} warning${warnings > 1 ? "s" : ""}` : "All utilities normal";
  return (
    <header className={`topbar topbar-${overall}`}>
      <div className="brand">
        <Flame size={20} aria-hidden="true" />
        <div>
          <h1>SOFC plant · utility monitor</h1>
          <p>100 kW hydrogen fuel cell, process utilities</p>
        </div>
      </div>
      <div className="overall" role="status" aria-live="polite">
        <span className={`overall-dot dot-${overall}`} aria-hidden="true" />
        <strong>{summary}</strong>
        <span className="sr-only">Overall status: {statusLabel(overall)}</span>
      </div>
      <div className="meta">
        <span title="Plant clock of the latest evaluated minute">Plant time <b className="num">{fmtClock(plantTime)}</b></span>
        {simRunning && <span className="pill pill-demo">Demo feed</span>}
        {feedStale && conn === "live" && <span className="pill pill-warn">No new data for {feedAgeS}s</span>}
        <span className={`conn conn-${conn}`}>
          {conn === "live" ? <Wifi size={15} aria-hidden="true" /> : <WifiOff size={15} aria-hidden="true" />}
          {conn === "live" ? "Live" : conn === "connecting" ? "Connecting…" : "Server unreachable, retrying"}
        </span>
      </div>
    </header>
  );
}
