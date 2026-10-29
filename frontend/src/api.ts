import type {
  Config,
  SimState,
  Alert,
  PolarizationParams,
  PolarizationResult,
  ThermodynamicState,
  SweepParams,
  SweepPoint,
  SimParamsUpdate,
  MongoStatusResponse,
  DbTickDocument,
  DbAlertDocument,
  DbSimulationDocument,
  DbCalculationDocument,
  DbTicksQuery,
  DbAlertsQuery,
  DbSimulationsQuery,
  DbCalculationsQuery,
  ReconnectBody,
  DbFlushResponse,
  AspenStatusResponse,
  AspenConnectParams,
  AspenPullAndVerifyParams,
  AspenVerificationResponse,
  AspenOptimizeParams,
  AspenOptimizationResponse,
  AspenHistoryResponse,
  AspenSetBaselineResponse,
  EmsStatusResponse,
  EmsForecastResponse,
  EmsForecastParams,
  EmsOptimizeParams,
  EmsRecommendationsResponse,
  EmsHistoryResponse,
} from "./types";

function toQueryString(params?: Record<string, unknown>): string {
  if (!params) return "";
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.append(key, String(value));
    }
  }
  const qs = searchParams.toString();
  return qs ? `?${qs}` : "";
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body?.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch { /* keep default message */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const post = <T,>(path: string, body?: unknown) =>
  j<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

export const api = {
  // Existing core routes (12 endpoints)
  config: () => j<Config>("/api/config"),
  ack: (id: number) => post<Alert>(`/api/alerts/${id}/ack`),
  simStart: () => post<SimState>("/api/sim/start"),
  simStop: () => post<SimState>("/api/sim/stop"),
  simInterval: (s: number) => post<SimState>("/api/sim/interval", { interval_s: s }),
  simFault: (fault: string) => post<SimState>("/api/sim/fault", { fault }),
  simClear: () => post<SimState>("/api/sim/clear"),
  simParams: (params: SimParamsUpdate) => post<SimState>("/api/sim/params", params),
  polarization: (params: PolarizationParams = {}) => post<PolarizationResult>("/api/polarization", params),
  thermodynamic: () => j<ThermodynamicState>("/api/thermodynamic"),
  thermodynamicCalculate: (params: PolarizationParams = {}) => post<ThermodynamicState>("/api/thermodynamic/calculate", params),
  sweep: (params: SweepParams) => post<SweepPoint[]>("/api/sweep", params),

  // Database Explorer routes (7 endpoints)
  dbStatus: () => j<MongoStatusResponse>("/api/db/status"),
  dbTicks: (params?: DbTicksQuery) => j<DbTickDocument[]>(`/api/db/ticks${toQueryString(params as Record<string, unknown>)}`),
  dbAlerts: (params?: DbAlertsQuery) => j<DbAlertDocument[]>(`/api/db/alerts${toQueryString(params as Record<string, unknown>)}`),
  dbSimulations: (params?: DbSimulationsQuery) => j<DbSimulationDocument[]>(`/api/db/simulations${toQueryString(params as Record<string, unknown>)}`),
  dbCalculations: (params?: DbCalculationsQuery) => j<DbCalculationDocument[]>(`/api/db/calculations${toQueryString(params as Record<string, unknown>)}`),
  dbFlush: () => post<DbFlushResponse>("/api/db/flush"),
  dbReconnect: (body?: ReconnectBody) => post<MongoStatusResponse>("/api/db/reconnect", body),

  // Aspen Integration routes (5 endpoints)
  aspenStatus: () => j<AspenStatusResponse>("/api/aspen/status"),
  aspenConnect: (params: AspenConnectParams) => post<AspenStatusResponse>("/api/aspen/connect", params),
  aspenPullAndVerify: (params?: AspenPullAndVerifyParams) => post<AspenVerificationResponse>("/api/aspen/pull-and-verify", params ?? {}),
  aspenOptimize: (params?: AspenOptimizeParams) => post<AspenOptimizationResponse>("/api/aspen/optimize", params ?? { objective: "eta_el" }),
  aspenHistory: (limit?: number) => j<AspenHistoryResponse>(`/api/aspen/history${toQueryString(limit != null ? { limit } : undefined)}`),
  aspenSetBaseline: (values?: Record<string, number>) => post<AspenSetBaselineResponse>("/api/aspen/set-baseline", values ? { values } : {}),
  aspenGetBaseline: () => j<Record<string, unknown>>("/api/aspen/baseline"),

  // AI Energy Management System (EMS) routes (5 endpoints)
  emsStatus: () => j<EmsStatusResponse>("/api/ems/status"),
  emsForecast: (params?: EmsForecastParams) => j<EmsForecastResponse>(`/api/ems/forecast${toQueryString(params as Record<string, unknown>)}`),
  emsOptimize: (params: EmsOptimizeParams) => post<EmsForecastResponse>("/api/ems/optimize", params),
  emsRecommendations: () => j<EmsRecommendationsResponse>("/api/ems/recommendations"),
  emsHistory: (limit?: number) => j<EmsHistoryResponse>(`/api/ems/history${toQueryString(limit != null ? { limit } : undefined)}`),
};
