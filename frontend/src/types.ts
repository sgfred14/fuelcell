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

// ---- Polarization & Characteristic Curves
export interface PolarizationParams {
  temperature_C?: number;
  asr_multiplier?: number;
  degradation_V?: number;
  fuel_utilization?: number;
  recycle_ratio?: number;
  j_min?: number;
  j_max?: number;
  n_points?: number;
}

export interface MaximumPowerPoint {
  j: number;
  i: number;
  v_cell: number;
  v_stack: number;
  p_dc: number;
  p_density: number;
}

export interface PolarizationResult {
  j_range: number[];
  i_stack: number[];
  v_cell: number[];
  v_stack: number[];
  v_nernst: number[];
  eta_ohmic: number[];
  eta_act: number[];
  eta_conc: number[];
  p_dc: number[];
  p_density: number[];
  p_net: number[];
  mpp: MaximumPowerPoint;
}

// ---- Thermodynamic State
export interface ThermodynamicState {
  available: boolean;
  nernst_V?: number | null;
  v_cell_V?: number | null;
  v_stack_V?: number | null;
  eta_ohmic_V?: number | null;
  eta_act_V?: number | null;
  eta_conc_V?: number | null;
  p_dc_kW?: number | null;
  p_net_kW?: number | null;
  fuel_energy_kW?: number | null;
  efficiency_rev_pct?: number | null;
  efficiency_voltage_pct?: number | null;
  efficiency_electrical_pct?: number | null;
  efficiency_chp_pct?: number | null;
  q_gen_kW?: number | null;
  q_cath_kW?: number | null;
  q_loss_kW?: number | null;
  q_afterburner_kW?: number | null;
  q_hrsg_kW?: number | null;
  fuel_utilization?: number | null;
  air_ratio?: number | null;
  t_stack_C?: number | null;
  t_ca_in_C?: number | null;
  t_ca_out_C?: number | null;
  dT_cath_K?: number | null;
  t_afterburner_C?: number | null;
  t_flue_out_C?: number | null;
  h2_flow_kg_h?: number | null;
  air_flow_kg_h?: number | null;
  steam_flow_kg_h?: number | null;
  load_pct?: number | null;
}

// ---- Parameter Sweep
export interface SweepParams {
  parameter: string;
  min_val: number;
  max_val: number;
  steps?: number;
  temperature_C?: number;
  asr_multiplier?: number;
  degradation_V?: number;
  fuel_utilization?: number;
  load_set?: number;
}

export interface SweepPoint {
  param_value: number;
  v_cell_V: number;
  p_dc_kW: number;
  p_net_kW: number;
  efficiency_pct: number;
  dT_cath_K: number;
  air_flow_kg_h: number;
  h2_flow_kg_h: number;
}

// ---- Simulator Slider Params
export interface SimParamsUpdate {
  load?: number;
  temperature_C?: number;
  asr_multiplier?: number;
  fuel_utilization?: number;
  recycle_ratio?: number;
  degradation_V?: number;
  air_ratio?: number;
  reset?: boolean;
}


// ============================================================================
// Database Explorer & MongoDB Types
// ============================================================================

export interface MongoStats {
  ticks_queued: number;
  ticks_written: number;
  alerts_written: number;
  sims_written: number;
  calcs_written: number;
  flushes_total: number;
  failed_flushes: number;
  last_flush_ts: string | null;
}

export interface MongoStatusResponse {
  enabled: boolean;
  connected: boolean;
  status_text: "CONNECTED" | "NOT CONNECTED";
  mode: "motor" | "pymongo" | "atlas_data_api" | "offline_buffer" | "disabled";
  database: string;
  target: string;
  uri_configured: boolean;
  cloud_counts: Record<string, number>;
  local_buffer_counts: Record<string, number>;
  pending_buffer_size: number;
  stats: MongoStats;
  last_error: string | null;
}

export type DbStatusResponse = MongoStatusResponse;
export type MongoStatus = MongoStatusResponse;

export interface DbTickDocument {
  ts: string;
  minute?: number;
  overall: Status;
  type?: "tick";
  values?: Record<string, number | null>;
  stale?: string[];
  checks?: Record<string, CheckState>;
  utilities?: Record<string, { status: Status; instant: Status }>;
  ae?: AeState;
  alerts?: Alert[];
  alert_events?: AlertEvent[];
  meta?: TickMeta | null;
  [key: string]: unknown;
}

export interface DbAlertHistoryEntry {
  event: string;
  ts: string;
  severity?: Severity;
  status?: string;
  value?: number | null;
  detail?: string;
}

export interface DbAlertDocument {
  id: number;
  key: string;
  utility: string;
  severity: Severity;
  peak_severity?: Severity;
  title: string;
  detail: string;
  hint?: string;
  source?: AlertSource;
  sources?: AlertSource[];
  check_id?: string | null;
  value?: number | null;
  unit?: string;
  first_ts: string;
  last_ts: string;
  status: "active" | "cleared";
  acknowledged: boolean;
  cleared_ts?: string | null;
  updates?: number;
  last_event?: string;
  event_ts?: string;
  ack_ts?: string;
  history?: DbAlertHistoryEntry[];
  [key: string]: unknown;
}

export interface DbSimulationDocument {
  action: string;
  timestamp: string;
  details: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DbCalculationDocument<P = Record<string, unknown>, R = Record<string, unknown>> {
  calc_type: string;
  created_at: string;
  params: P;
  result: R;
  [key: string]: unknown;
}

export interface DbTicksQuery {
  start_ts?: string;
  end_ts?: string;
  overall?: "ok" | "warning" | "alarm";
  limit?: number;
  skip?: number;
}

export interface DbAlertsQuery {
  status?: "active" | "acknowledged" | "unacknowledged" | "cleared" | "all";
  utility?: string;
  limit?: number;
  skip?: number;
}

export interface DbSimulationsQuery {
  limit?: number;
  skip?: number;
}

export interface DbCalculationsQuery {
  calc_type?: string;
  limit?: number;
  skip?: number;
}

export interface ReconnectBody {
  uri?: string;
  db_name?: string;
}

export type ReconnectParams = ReconnectBody;

export interface DbFlushResponse {
  flushed: boolean;
  status: MongoStatusResponse;
}

// ============================================================================
// Aspen Plus Integration Types
// ============================================================================

export interface AspenStatusResponse {
  mode: "com" | "simulated";
  connected: boolean;
  aspen_processes: string[];
  com_available: boolean;
  model_path: string | null;
  progid: string;
  monitored_nodes_count: number;
  last_verified_at: string | null;
  last_verdict: "PASS" | "CHECK_REQUIRED" | "FAIL" | null;
}

export type AspenStatus = AspenStatusResponse;

export interface AspenConnectParams {
  model_path?: string;
  progid?: string;
}

export interface AspenPullAndVerifyParams {
  model_file?: string;
  custom_values?: Record<string, number>;
  actual_values?: Record<string, number>;
  source?: string;
  use_actual_plant_values?: boolean;
  plant_params?: Record<string, unknown>;
}

export interface AspenSetBaselineResponse {
  success: boolean;
  message: string;
  updated_fields: string[];
  baseline: Record<string, number>;
  updated_at: string;
}

export type AspenPullVerifyParams = AspenPullAndVerifyParams;

export interface AspenVerificationRow {
  item: string;
  node_path: string;
  aspen_value: number | null;
  baseline_value: number;
  rel_err_pct: number | null;
  tol_pct: number;
  status: "OK" | "CHECK" | "ERR";
}

export interface AspenModelResult {
  pac: number;
  F: number;
  h2_kgh: number;
  lhv: number;
  pdc: number;
  p_bl: number;
  p_rc: number;
  air: number;
  lam: number;
  eta_el: number;
  eta_chp: number;
  t_ab: number;
  t_flue1: number;
  t_flue2: number;
  t_stack: number;
  t_bl: number;
  t_mix: number;
  t_rc: number;
  q_fhx: number;
  q_ahx: number;
  steam: number;
  q_steam: number;
  t_dew: number;
  e_exit: number;
  ohm: number;
  resid: number;
  cells: number;
  current_kA: number;
  u_pass: number;
  parasitic: number;
  dT: number;
  [key: string]: unknown;
}

export interface AspenComparisonRow {
  aspen: number;
  model: number;
  delta: number;
  unit: string;
}

export type ComparisonMetric = AspenComparisonRow;
export type AspenComparisonMetrics = Record<string, AspenComparisonRow>;

export interface AspenSuggestion {
  sev: "crit" | "warn" | "tip" | "ok";
  msg: string;
  fix: Record<string, number> | null;
}

export interface AspenOptimalCandidateParams {
  vcell: number;
  uf: number;
  pbl: number;
  j: number;
}

export interface AspenOptimalCandidate {
  score: number;
  params: AspenOptimalCandidateParams;
  eta_el: number;
  eta_chp: number;
  h2_kgh: number;
  steam_kgh: number;
  cells: number;
  parasitic_pct: number;
  t_ab: number;
}

export type OptimalCandidate = AspenOptimalCandidate;

export interface AspenOptimizeParams {
  objective?: "eta_el" | "eta_chp" | string;
  plant_params?: Record<string, unknown>;
}

export interface AspenOptimizationResponse {
  candidates: AspenOptimalCandidate[];
  objective: string;
}

export interface AspenVerificationResponse {
  verified_at: string;
  verdict: "PASS" | "CHECK_REQUIRED" | "FAIL";
  source_mode: "com" | "simulated" | "custom_input" | string;
  total_checks: number;
  checks_passed: number;
  checks_warning: number;
  checks_error: number;
  verification_table: AspenVerificationRow[];
  model_result: AspenModelResult;
  comparison: Record<string, AspenComparisonRow>;
  suggestions: AspenSuggestion[];
  optimal_candidates: AspenOptimalCandidate[];
  operating_parameters: Record<string, unknown>;
}

export type AspenVerificationResult = AspenVerificationResponse;
export type AspenHistoryResponse = DbCalculationDocument<AspenPullAndVerifyParams, AspenVerificationResponse>[];

// ============================================================================
// AI Energy Management System (EMS) Types
// ============================================================================

export interface EmsDailySummary {
  total_demand_kwh: number;
  total_sofc_generation_kwh: number;
  total_grid_import_kwh: number;
  total_baseline_cost_usd: number;
  total_ems_cost_usd: number;
  total_savings_usd: number;
  savings_pct: number;
  co2_avoided_kg: number;
  total_steam_produced_kg: number;
  peak_demand_unmanaged_kw: number;
  peak_grid_import_ems_kw: number;
  peak_shaved_kw: number;
  self_sufficiency_pct: number;
  h2_cost_usd_kg: number;
}

export type EMSSummary = EmsDailySummary;

export interface EmsStatusResponse {
  status: string;
  current_hour: number;
  summary: EmsDailySummary;
  recommendations_count: number;
}

export type EMSStatusResponse = EmsStatusResponse;

export interface EmsForecastPoint {
  time: string;
  iso_time: string;
  hour: number;
  facility_demand_kw: number;
  sofc_dispatch_kw: number;
  grid_import_kw: number;
  tariff_usd_kwh: number;
  ambient_temp_C: number;
  h2_consumed_kg: number;
  steam_produced_kg: number;
  ems_cost_usd: number;
  baseline_cost_usd: number;
  savings_usd: number;
}

export type EMSForecastPoint = EmsForecastPoint;

export interface EmsDegradationPoint {
  hours: number;
  asr_ohm_cm2: number;
  asr_mohm_cm2: number;
  cell_voltage_v: number;
  stack_health_pct: number;
  electrical_efficiency_pct: number;
}

export type EMSDegradationPoint = EmsDegradationPoint;
export type EmsDegradationProjection = EmsDegradationPoint[];

export interface EmsRecommendationItem {
  id: string;
  priority: "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  message: string;
  category: string;
}

export type EMSRecommendation = EmsRecommendationItem;
export type EmsRecommendationsResponse = EmsRecommendationItem[];

export interface EmsOptimizeParams {
  base_demand_kw?: number;
  h2_cost_usd_kg?: number | null;
  rated_sofc_power_kw?: number;
  min_sofc_power_kw?: number;
  plant_params?: Record<string, unknown>;
}

export type EMSOptimizeParams = EmsOptimizeParams;

export interface EmsForecastParams {
  base_demand_kw?: number;
  h2_cost_usd_kg?: number;
}

export interface EmsForecastResponse {
  generated_at: string;
  summary: EmsDailySummary;
  forecast_24h: EmsForecastPoint[];
  degradation_projection: EmsDegradationPoint[];
  recommendations: EmsRecommendationItem[];
}

export type EMSForecastResult = EmsForecastResponse;
export type EmsHistoryResponse = DbCalculationDocument<EmsOptimizeParams, EmsDailySummary>[];
