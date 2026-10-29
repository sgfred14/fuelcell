export type Status = "ok" | "warning" | "alarm" | "unknown";
export type Severity = "warning" | "alarm";
export type AlertSource = "physics" | "learned" | "sensor";

export interface Alert {
  id: number;
  key: string;
  utility: string;
  severity: Severity;
  peak_severity: Severity;
  title: string;
  detail: string;
  hint: string;
  source: AlertSource;
  sources: AlertSource[];
  check_id: string | null;
  value: number | null;
  unit: string;
  first_ts: string;
  last_ts: string;
  status: "active" | "cleared";
  acknowledged: boolean;
  cleared_ts: string | null;
  updates: number;
}

export interface CheckState {
  value: number | null;
  status: Status;
}

export interface AeState {
  available?: boolean;
  score: number | null;
  threshold: number | null;
  flag: boolean;
  top: { channel: string; label: string; sigma: number }[];
  utility: string | null;
}

export interface TickMeta {
  injected_fault?: string | null;
  fault_code?: number;
}

export interface AlertEvent {
  event: "new" | "escalated" | "cleared" | "confirmed";
  alert: Alert;
}

export interface Tick {
  type: "tick";
  ts: string;
  minute: number;
  values: Record<string, number | null>;
  stale: string[];
  checks: Record<string, CheckState>;
  utilities: Record<string, { status: Status; instant: Status }>;
  ae: AeState;
  alerts: Alert[];
  alert_events: AlertEvent[];
  overall: Status;
  meta: TickMeta | null;
}

export interface HistoryPoint {
  ts: string;
  v: Record<string, number | null>;
  c: Record<string, number | null>;
  ae: number | null;
  meta: TickMeta | null;
}

export interface FaultInfo {
  type: string;
  label: string;
  injected_ts: string;
  first_alert_ts: string | null;
  first_alert: string | null;
  delay_min: number | null;
}

export interface SimState {
  running: boolean;
  interval_s: number;
  sim_time: string | null;
  fault: FaultInfo | null;
  faults: Record<string, { label: string; utility: string; text: string }>;
}

export interface DetectorInfo {
  learned_model: boolean;
  ae_threshold: number | null;
  raise_minutes: number;
  clear_minutes: number;
  ae_step_minutes: number;
  readings: number;
  late: number;
  gaps: number;
  source: string | null;
}

export interface UtilityDef {
  id: string;
  name: string;
  blurb: string;
  icon: string;
  key: string[];
  checks: string[];
  channels: string[];
}

export interface CheckDef {
  id: string;
  utility: string;
  label: string;
  unit: string;
  decimals: number;
  warn_lo: number | null;
  warn_hi: number | null;
  alarm_lo: number | null;
  alarm_hi: number | null;
  window: number;
  inputs: string[];
  what: string;
  hint: string;
}

export interface ChannelDef {
  id: string;
  label: string;
  unit: string;
  range: [number, number];
  utility: string;
}

export interface Config {
  utilities: UtilityDef[];
  checks: CheckDef[];
  channels: ChannelDef[];
  info: DetectorInfo;
  api_key_required: boolean;
}

export interface Snapshot {
  type: "snapshot";
  latest: Tick | null;
  history: HistoryPoint[];
  alerts: Alert[];
  recent_alerts: Alert[];
  info: DetectorInfo;
  sim?: SimState;
}
