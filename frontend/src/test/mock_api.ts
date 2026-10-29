import { vi } from "vitest";
import configFixture from "../fixtures/config.json";
import snapshotFixture from "../fixtures/snapshot.json";
import { initialState, type State } from "../store";
import type { Config } from "../types";

export function createMockMonitorContext(overrides?: Partial<State>) {
  return {
    state: {
      ...initialState,
      config: configFixture as unknown as Config,
      latest: (snapshotFixture as any).tick,
      tickTimes: [1000, 2000, 3000],
      toasts: [],
      ...overrides,
    },
    connected: true,
    connecting: false,
    error: null,
    reconnect: vi.fn(),
    ackAlert: vi.fn(),
  };
}
import {
  mockAspenStatus,
  mockAspenVerification,
  mockDbAlerts,
  mockDbStatus,
  mockDbTicks,
  mockEmsForecast,
} from "./contracts";

export class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }

  send() {}
  close() {
    this.onclose?.();
  }
  push(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

export const mockPolarizationData = {
  j_range: [0.1, 0.2, 0.3, 0.4, 0.5],
  i_stack: [60, 120, 180, 240, 300],
  v_cell: [0.92, 0.86, 0.81, 0.75, 0.69],
  v_stack: [673.4, 629.5, 592.9, 549.0, 505.1],
  v_nernst: [1.02, 1.01, 1.00, 0.99, 0.98],
  eta_ohmic: [0.03, 0.06, 0.09, 0.12, 0.15],
  eta_act: [0.05, 0.06, 0.07, 0.08, 0.09],
  eta_conc: [0.01, 0.02, 0.03, 0.04, 0.05],
  p_dc: [40.4, 75.5, 106.7, 131.8, 151.5],
  p_density: [0.092, 0.172, 0.243, 0.300, 0.345],
  p_net: [32.1, 65.2, 94.1, 116.4, 132.8],
  mpp: { j: 0.5, i: 300, v_cell: 0.69, v_stack: 505.1, p_dc: 151.5, p_density: 0.345 },
};

export const mockThermodynamicData = {
  available: true,
  nernst_V: 0.985,
  v_cell_V: 0.752,
  v_stack_V: 550.5,
  eta_ohmic_V: 0.105,
  eta_act_V: 0.078,
  eta_conc_V: 0.050,
  p_dc_kW: 135.4,
  p_net_kW: 104.2,
  fuel_energy_kW: 215.0,
  efficiency_rev_pct: 78.4,
  efficiency_voltage_pct: 76.3,
  efficiency_electrical_pct: 53.2,
  efficiency_chp_pct: 84.5,
  q_gen_kW: 79.6,
  q_cath_kW: 68.2,
  q_loss_kW: 3.2,
  q_afterburner_kW: 38.5,
  q_hrsg_kW: 67.2,
  fuel_utilization: 0.8,
  air_ratio: 10.5,
  t_stack_C: 698.5,
  t_ca_in_C: 650.0,
  t_ca_out_C: 747.0,
  dT_cath_K: 97.0,
  load_pct: 80.0,
};

export function createFetchMock(customOverrides?: (url: string, init?: RequestInit) => Response | null) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (customOverrides) {
      const custom = customOverrides(url, init);
      if (custom) return custom;
    }

    // Config & simulation
    if (url === "/api/config") return new Response(JSON.stringify(configFixture), { status: 200 });
    if (url.includes("/ack")) return new Response(JSON.stringify({ id: 1, acknowledged: true }), { status: 200 });
    if (url === "/api/polarization") return new Response(JSON.stringify(mockPolarizationData), { status: 200 });
    if (url.includes("/api/thermodynamic")) return new Response(JSON.stringify(mockThermodynamicData), { status: 200 });
    if (url.includes("/api/sim/params")) return new Response(JSON.stringify({ running: true }), { status: 200 });

    // Database Explorer endpoints
    if (url.includes("/api/db/status")) return new Response(JSON.stringify(mockDbStatus), { status: 200 });
    if (url.includes("/api/db/ticks")) return new Response(JSON.stringify(mockDbTicks), { status: 200 });
    if (url.includes("/api/db/alerts")) return new Response(JSON.stringify(mockDbAlerts), { status: 200 });
    if (url.includes("/api/db/simulations")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes("/api/db/calculations")) return new Response(JSON.stringify([]), { status: 200 });
    if (url.includes("/api/db/flush")) return new Response(JSON.stringify({ flushed: true, status: mockDbStatus }), { status: 200 });
    if (url.includes("/api/db/reconnect")) return new Response(JSON.stringify(mockDbStatus), { status: 200 });

    // Aspen endpoints
    if (url.includes("/api/aspen/status")) return new Response(JSON.stringify(mockAspenStatus), { status: 200 });
    if (url.includes("/api/aspen/pull-and-verify")) return new Response(JSON.stringify(mockAspenVerification), { status: 200 });
    if (url.includes("/api/aspen/optimize")) {
      return new Response(JSON.stringify({ candidates: mockAspenVerification.optimal_candidates, objective: "eta_el" }), { status: 200 });
    }
    if (url.includes("/api/aspen/history")) return new Response(JSON.stringify([mockAspenVerification]), { status: 200 });
    if (url.includes("/api/aspen/set-baseline")) {
      return new Response(
        JSON.stringify({
          success: true,
          message: "Aspen values set as plant baseline successfully.",
          updated_fields: ["air_kmol_h", "P_blower_kW"],
          baseline: { air_kmol_h: 89.05, P_blower_kW: 23.37 },
          updated_at: new Date().toISOString(),
        }),
        { status: 200 }
      );
    }
    if (url.includes("/api/aspen/baseline")) {
      return new Response(
        JSON.stringify({
          baseline: { air_kmol_h: 89.05, P_blower_kW: 23.37 },
          paths: {},
        }),
        { status: 200 }
      );
    }

    // EMS endpoints
    if (url.includes("/api/ems/status")) {
      return new Response(JSON.stringify({ status: "active", active_model: "MILP_v2", horizon_hours: 24, last_update: "2026-10-28T22:00:00Z" }), { status: 200 });
    }
    if (url.includes("/api/ems/forecast")) return new Response(JSON.stringify(mockEmsForecast), { status: 200 });
    if (url.includes("/api/ems/optimize")) return new Response(JSON.stringify(mockEmsForecast), { status: 200 });
    if (url.includes("/api/ems/recommendations")) return new Response(JSON.stringify(mockEmsForecast.recommendations), { status: 200 });
    if (url.includes("/api/ems/history")) return new Response(JSON.stringify([]), { status: 200 });

    return new Response("{}", { status: 200 });
  });
}

export function setupTestEnvironment(customOverrides?: (url: string, init?: RequestInit) => Response | null) {
  FakeSocket.last = null;
  const fetchMock = createFetchMock(customOverrides);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, FakeSocket };
}

export async function pushMockSnapshot(snap: unknown = snapshotFixture) {
  if (FakeSocket.last) {
    FakeSocket.last.push(snap);
    await new Promise((r) => setTimeout(r, 10));
  }
}
