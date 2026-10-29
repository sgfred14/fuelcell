/**
 * Shared test contracts, interfaces, and reference fixtures for SOFC Frontend tests.
 * Authoritative source: ORIGINAL_REQUEST.md, TEST_INFRA.md, backend/app/
 */

export interface DbStatusResponse {
  enabled: boolean;
  connected: boolean;
  status_text: string;
  mode: "motor" | "pymongo" | "atlas_data_api" | "offline_buffer";
  database: string;
  target: string;
  cloud_counts: {
    telemetry_ticks: number;
    alerts: number;
    simulations: number;
    thermo_calculations: number;
  };
  local_buffer_counts: {
    telemetry_ticks: number;
    alerts: number;
    simulations: number;
    thermo_calculations: number;
  };
  pending_buffer_size: number;
  stats: {
    flushes_total: number;
    ticks_inserted: number;
    alerts_inserted: number;
    sims_inserted: number;
    calcs_inserted: number;
    errors_total: number;
  };
  last_error: string | null;
}

export interface DbTickDocument {
  _id?: string;
  timestamp: string;
  overall: "ok" | "warning" | "alarm";
  load_pct: number;
  t_stack_c: number;
  p_dc_kw: number;
  channels: Record<string, number>;
  checks: Record<string, { status: "ok" | "warning" | "alarm"; value: number | null }>;
}

export interface DbAlertDocument {
  _id?: string;
  id: number;
  key: string;
  utility: string;
  severity: "warning" | "alarm";
  title: string;
  detail: string;
  status: "active" | "cleared";
  acknowledged: boolean;
  first_ts: string;
  last_ts: string;
}

export interface DbSimulationDocument {
  _id?: string;
  event: string;
  timestamp: string;
  parameters: Record<string, unknown>;
}

export interface DbCalculationDocument {
  _id?: string;
  calc_type: string;
  timestamp: string;
  input_params: Record<string, unknown>;
  output_results: Record<string, unknown>;
}

export interface AspenStatusResponse {
  mode: "com" | "simulated";
  connected: boolean;
  aspen_processes: number;
  com_available: boolean;
  monitored_nodes_count: number;
  last_verdict: "PASS" | "CHECK_REQUIRED" | "FAIL" | "NOT_RUN";
}

export interface AspenVerificationRow {
  item: string;
  node_path: string;
  aspen_value: number | null;
  baseline_value: number;
  rel_err_pct: number | null;
  tol_pct: number;
  status: "OK" | "PASS" | "CHECK" | "ERR";
}

export interface AspenReconciliationItem {
  aspen: number;
  model: number;
  diff: number;
  unit: string;
}

export interface AspenSuggestion {
  id: string;
  text: string;
  sev: "crit" | "warn" | "tip" | "ok";
  param: string;
  suggested: number;
}

export interface AspenOptimalCandidate {
  rank: number;
  v_cell: number;
  uf: number;
  p_blower: number;
  j: number;
  eta_el: number;
  eta_chp: number;
  h2_flow: number;
  steam_flow: number;
  parasitic_pct: number;
  cell_count: number;
}

export interface AspenVerificationResponse {
  verdict: "PASS" | "CHECK_REQUIRED" | "FAIL";
  checks_passed: number;
  checks_warning: number;
  checks_error: number;
  verification_table: AspenVerificationRow[];
  model_result: {
    p_dc_kw: number;
    p_ac_kw: number;
    eta_el_pct: number;
    eta_chp_pct: number;
    t_stack_c: number;
    t_ca_out_c: number;
    t_ab_c: number;
    steam_kg_h: number;
    p_blower_kw: number;
    valid: boolean;
  };
  comparison: Record<string, AspenReconciliationItem>;
  suggestions: AspenSuggestion[];
  optimal_candidates: AspenOptimalCandidate[];
}

export interface EmsStatusResponse {
  status: "active" | "standby" | "optimizing";
  active_model: string;
  horizon_hours: number;
  last_update: string;
}

export interface EmsForecastPoint {
  hour: number;
  timestamp: string;
  demand_kw: number;
  sofc_dispatch_kw: number;
  grid_import_kw: number;
  tariff_usd_kwh: number;
  cost_baseline_usd: number;
  cost_ems_usd: number;
  savings_usd: number;
  fuel_h2_kg_h: number;
  steam_kg_h: number;
  eff_el_pct: number;
}

export interface EmsDegradationPoint {
  hours: number;
  asr_ohm_cm2: number;
  asr_mohm_cm2: number;
  cell_voltage_v: number;
  stack_health_pct: number;
  electrical_efficiency_pct: number;
}

export interface EmsRecommendation {
  id: string;
  priority: "HIGH" | "MEDIUM" | "LOW" | "INFO";
  title: string;
  category: string;
  message: string;
  action: string;
  potential_savings_usd_day: number;
}

export interface EmsSummary {
  total_demand_kwh: number;
  total_sofc_kwh: number;
  total_grid_kwh: number;
  self_sufficiency_pct: number;
  total_cost_baseline_usd: number;
  total_cost_ems_usd: number;
  total_savings_usd: number;
  savings_pct: number;
  peak_shaved_kw: number;
  co2_avoided_kg: number;
  steam_produced_kg: number;
}

export interface EmsForecastResponse {
  horizon_hours: number;
  base_demand_kw: number;
  h2_cost_usd_kg: number;
  summary: EmsSummary;
  forecast: EmsForecastPoint[];
  degradation_projection: EmsDegradationPoint[];
  recommendations: EmsRecommendation[];
}

// ----------------- Reference Fixtures -----------------

export const mockDbStatus: DbStatusResponse = {
  enabled: true,
  connected: true,
  status_text: "Connected to MongoDB Atlas",
  mode: "motor",
  database: "sofc_monitor",
  target: "mongodb+srv://***:***@cluster0.mongodb.net",
  cloud_counts: {
    telemetry_ticks: 145020,
    alerts: 142,
    simulations: 28,
    thermo_calculations: 85,
  },
  local_buffer_counts: {
    telemetry_ticks: 0,
    alerts: 0,
    simulations: 0,
    thermo_calculations: 0,
  },
  pending_buffer_size: 0,
  stats: {
    flushes_total: 120,
    ticks_inserted: 145020,
    alerts_inserted: 142,
    sims_inserted: 28,
    calcs_inserted: 85,
    errors_total: 0,
  },
  last_error: null,
};

export const mockDbTicks: DbTickDocument[] = [
  {
    _id: "tick_001",
    timestamp: "2026-10-28T22:00:00Z",
    overall: "ok",
    load_pct: 80.0,
    t_stack_c: 698.5,
    p_dc_kw: 135.4,
    channels: {
      "stack.temperature": 698.5,
      "stack.voltage": 550.2,
      "stack.current": 246.1,
    },
    checks: {
      "stack_temp_check": { status: "ok", value: 698.5 },
      "voltage_margin": { status: "ok", value: 550.2 },
    },
  },
  {
    _id: "tick_002",
    timestamp: "2026-10-28T22:01:00Z",
    overall: "warning",
    load_pct: 85.0,
    t_stack_c: 742.0,
    p_dc_kw: 142.1,
    channels: {
      "stack.temperature": 742.0,
      "stack.voltage": 542.8,
      "stack.current": 261.8,
    },
    checks: {
      "stack_temp_check": { status: "warning", value: 742.0 },
      "voltage_margin": { status: "ok", value: 542.8 },
    },
  },
];

export const mockDbAlerts: DbAlertDocument[] = [
  {
    _id: "alert_001",
    id: 101,
    key: "anode_recycle_low",
    utility: "Hydrogen supply",
    severity: "alarm",
    title: "Anode recycle vs expected below threshold",
    detail: "Recycle flow measured at 12.1 kmol/h, expected >= 15.0 kmol/h",
    status: "active",
    acknowledged: false,
    first_ts: "2026-10-28T21:45:00Z",
    last_ts: "2026-10-28T22:00:00Z",
  },
  {
    _id: "alert_002",
    id: 102,
    key: "cathode_dt_high",
    utility: "Cathode air and blower",
    severity: "warning",
    title: "Cathode temperature gradient elevated",
    detail: "Delta T across cathode is 98.5 K (threshold 95.0 K)",
    status: "cleared",
    acknowledged: true,
    first_ts: "2026-10-28T20:00:00Z",
    last_ts: "2026-10-28T21:15:00Z",
  },
];

export const mockAspenStatus: AspenStatusResponse = {
  mode: "simulated",
  connected: true,
  aspen_processes: 0,
  com_available: false,
  monitored_nodes_count: 10,
  last_verdict: "PASS",
};

export const mockAspenVerification: AspenVerificationResponse = {
  verdict: "PASS",
  checks_passed: 10,
  checks_warning: 0,
  checks_error: 0,
  verification_table: [
    {
      item: "Air to blower (kmol/h)",
      node_path: "\\Data\\Streams\\AIR-AMB\\Output\\MOLEFLMX\\MIXED",
      aspen_value: 89.05,
      baseline_value: 89.05,
      rel_err_pct: 0.0,
      tol_pct: 2.0,
      status: "PASS",
    },
    {
      item: "Anode inlet T (C)",
      node_path: "\\Data\\Streams\\ANODE-IN\\Output\\TEMP_OUT\\MIXED",
      aspen_value: 650.0,
      baseline_value: 650.0,
      rel_err_pct: 0.0,
      tol_pct: 0.5,
      status: "PASS",
    },
    {
      item: "Flue after fuel HX (C)",
      node_path: "\\Data\\Streams\\FLUE-1\\Output\\TEMP_OUT\\MIXED",
      aspen_value: 615.2,
      baseline_value: 615.0,
      rel_err_pct: 0.033,
      tol_pct: 1.0,
      status: "PASS",
    },
    {
      item: "Flue after air HX (C)",
      node_path: "\\Data\\Streams\\FLUE-2\\Output\\TEMP_OUT\\MIXED",
      aspen_value: 395.4,
      baseline_value: 396.0,
      rel_err_pct: -0.152,
      tol_pct: 3.0,
      status: "PASS",
    },
    {
      item: "Flue to stack (C)",
      node_path: "\\Data\\Streams\\FLUE-OUT\\Output\\TEMP_OUT\\MIXED",
      aspen_value: 145.8,
      baseline_value: 146.0,
      rel_err_pct: -0.137,
      tol_pct: 5.0,
      status: "PASS",
    },
    {
      item: "Air blower brake power (kW)",
      node_path: "\\Data\\Blocks\\BLOWER\\Output\\BRAKE_POWER",
      aspen_value: 12.35,
      baseline_value: 12.4,
      rel_err_pct: -0.403,
      tol_pct: 5.0,
      status: "PASS",
    },
    {
      item: "Recycle blower power (kW)",
      node_path: "\\Data\\Blocks\\RECLBR\\Output\\BRAKE_POWER",
      aspen_value: 3.12,
      baseline_value: 3.1,
      rel_err_pct: 0.645,
      tol_pct: 15.0,
      status: "PASS",
    },
    {
      item: "Fuel preheater duty (kW)",
      node_path: "\\Data\\Blocks\\FUELHX\\Output\\HX_DUTY",
      aspen_value: 18.45,
      baseline_value: 18.5,
      rel_err_pct: -0.27,
      tol_pct: 5.0,
      status: "PASS",
    },
    {
      item: "Air preheater duty (kW)",
      node_path: "\\Data\\Blocks\\AIRHX\\Output\\HX_DUTY",
      aspen_value: 65.8,
      baseline_value: 66.0,
      rel_err_pct: -0.303,
      tol_pct: 3.0,
      status: "PASS",
    },
    {
      item: "HRSG steam (kg/h)",
      node_path: "\\Data\\Streams\\STEAM\\Output\\MASSFLMX\\MIXED",
      aspen_value: 112.5,
      baseline_value: 112.0,
      rel_err_pct: 0.446,
      tol_pct: 5.0,
      status: "PASS",
    },
  ],
  model_result: {
    p_dc_kw: 135.4,
    p_ac_kw: 104.2,
    eta_el_pct: 53.2,
    eta_chp_pct: 84.5,
    t_stack_c: 698.5,
    t_ca_out_c: 747.0,
    t_ab_c: 980.2,
    steam_kg_h: 112.5,
    p_blower_kw: 12.35,
    valid: true,
  },
  comparison: {
    p_ac_kw: { aspen: 104.2, model: 104.2, diff: 0.0, unit: "kW" },
    eta_el_pct: { aspen: 53.2, model: 53.2, diff: 0.0, unit: "%" },
    eta_chp_pct: { aspen: 84.5, model: 84.5, diff: 0.0, unit: "%" },
    t_ab_c: { aspen: 980.2, model: 980.2, diff: 0.0, unit: "C" },
    t_stack_c: { aspen: 698.5, model: 698.5, diff: 0.0, unit: "C" },
    steam_kg_h: { aspen: 112.5, model: 112.5, diff: 0.0, unit: "kg/h" },
    p_blower_kw: { aspen: 12.35, model: 12.35, diff: 0.0, unit: "kW" },
  },
  suggestions: [
    {
      id: "sug_01",
      text: "Thermal stress within safe limits (dT = 97.0 K <= 100.0 K)",
      sev: "ok",
      param: "dT_cath_K",
      suggested: 97.0,
    },
  ],
  optimal_candidates: [
    {
      rank: 1,
      v_cell: 0.78,
      uf: 0.82,
      p_blower: 11.8,
      j: 0.38,
      eta_el: 54.8,
      eta_chp: 85.2,
      h2_flow: 5.8,
      steam_flow: 118.0,
      parasitic_pct: 11.2,
      cell_count: 730,
    },
    {
      rank: 2,
      v_cell: 0.77,
      uf: 0.80,
      p_blower: 12.0,
      j: 0.40,
      eta_el: 54.1,
      eta_chp: 84.9,
      h2_flow: 6.0,
      steam_flow: 116.5,
      parasitic_pct: 11.5,
      cell_count: 732,
    },
  ],
};

export const mockEmsForecast: EmsForecastResponse = {
  horizon_hours: 24,
  base_demand_kw: 100.0,
  h2_cost_usd_kg: 4.5,
  summary: {
    total_demand_kwh: 2280.0,
    total_sofc_kwh: 2150.0,
    total_grid_kwh: 130.0,
    self_sufficiency_pct: 94.3,
    total_cost_baseline_usd: 376.2,
    total_cost_ems_usd: 289.4,
    total_savings_usd: 86.8,
    savings_pct: 23.1,
    peak_shaved_kw: 28.5,
    co2_avoided_kg: 903.0,
    steam_produced_kg: 2700.0,
  },
  forecast: Array.from({ length: 24 }, (_, i) => {
    const tariff = (23 <= i || i < 6) ? 0.08 : (14 <= i && i < 20) ? 0.28 : 0.15;
    const demand = Math.round((70 + 40 * Math.sin((i / 24) * 2 * Math.PI - 1.5)) * 10) / 10;
    const dispatch = Math.min(demand, 100);
    const grid = Math.max(0, demand - dispatch);
    const costBaseline = Math.round(demand * tariff * 100) / 100;
    const costEms = Math.round((dispatch * 0.11 + grid * tariff) * 100) / 100;
    return {
      hour: i,
      timestamp: `2026-10-29T${String(i).padStart(2, "0")}:00:00Z`,
      demand_kw: demand,
      sofc_dispatch_kw: dispatch,
      grid_import_kw: grid,
      tariff_usd_kwh: tariff,
      cost_baseline_usd: costBaseline,
      cost_ems_usd: costEms,
      savings_usd: Math.round((costBaseline - costEms) * 100) / 100,
      fuel_h2_kg_h: 5.9,
      steam_kg_h: 112.5,
      eff_el_pct: 53.2,
    };
  }),
  degradation_projection: [
    { hours: 0, asr_ohm_cm2: 0.25, asr_mohm_cm2: 250.0, cell_voltage_v: 0.75, stack_health_pct: 100.0, electrical_efficiency_pct: 36.4 },
    { hours: 500, asr_ohm_cm2: 0.2512, asr_mohm_cm2: 251.2, cell_voltage_v: 0.749, stack_health_pct: 98.0, electrical_efficiency_pct: 36.3 },
    { hours: 1000, asr_ohm_cm2: 0.2522, asr_mohm_cm2: 252.2, cell_voltage_v: 0.7481, stack_health_pct: 96.0, electrical_efficiency_pct: 36.3 },
    { hours: 2500, asr_ohm_cm2: 0.2549, asr_mohm_cm2: 254.9, cell_voltage_v: 0.7455, stack_health_pct: 90.0, electrical_efficiency_pct: 36.1 },
    { hours: 5000, asr_ohm_cm2: 0.259, asr_mohm_cm2: 259.0, cell_voltage_v: 0.7414, stack_health_pct: 80.0, electrical_efficiency_pct: 35.9 },
    { hours: 7500, asr_ohm_cm2: 0.2629, asr_mohm_cm2: 262.9, cell_voltage_v: 0.7373, stack_health_pct: 70.0, electrical_efficiency_pct: 35.7 },
    { hours: 10000, asr_ohm_cm2: 0.2665, asr_mohm_cm2: 266.5, cell_voltage_v: 0.7334, stack_health_pct: 60.0, electrical_efficiency_pct: 35.5 },
    { hours: 15000, asr_ohm_cm2: 0.2735, asr_mohm_cm2: 273.5, cell_voltage_v: 0.7256, stack_health_pct: 40.0, electrical_efficiency_pct: 35.2 },
    { hours: 20000, asr_ohm_cm2: 0.2801, asr_mohm_cm2: 280.1, cell_voltage_v: 0.718, stack_health_pct: 20.0, electrical_efficiency_pct: 34.8 },
  ],
  recommendations: [
    {
      id: "rec_peak",
      priority: "HIGH",
      title: "On-Peak Tariff Dispatch Maximize",
      category: "Dispatch & Tariffs",
      message: "Grid tariff peaks at $0.28/kWh from 14:00 to 20:00. Maintain SOFC at 100 kW rated capacity.",
      action: "Lock dispatch setpoint to 100 kW during 14:00-20:00 window",
      potential_savings_usd_day: 42.5,
    },
    {
      id: "rec_thermal",
      priority: "MEDIUM",
      title: "Cogeneration Steam Offset Value",
      category: "Thermal Recovery",
      message: "HRSG producing 112.5 kg/h of industrial steam offsetting boiler fuel.",
      action: "Maintain cathode exhaust temp above 650 C",
      potential_savings_usd_day: 28.2,
    },
  ],
};
