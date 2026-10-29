import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import App from "./App";
import config from "./fixtures/config.json";
import snapshot from "./fixtures/snapshot.json";

class FakeSocket {
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

const mockPolarization = {
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

const mockThermodynamic = {
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

const fetchMock = vi.fn(async (url: string) => {
  if (url === "/api/config") return new Response(JSON.stringify(config), { status: 200 });
  if (url.includes("/ack")) return new Response(JSON.stringify({ id: 1, acknowledged: true }), { status: 200 });
  if (url === "/api/sim/start") return new Response(JSON.stringify({ detail: "x" }), { status: 409 });
  if (url === "/api/polarization") return new Response(JSON.stringify(mockPolarization), { status: 200 });
  if (url.includes("/api/thermodynamic")) return new Response(JSON.stringify(mockThermodynamic), { status: 200 });
  if (url.includes("/api/sim/params")) return new Response(JSON.stringify({ running: true }), { status: 200 });
  return new Response("{}", { status: 200 });
});

beforeEach(() => {
  FakeSocket.last = null;
  fetchMock.mockClear();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", fetchMock);
  window.history.pushState({}, "", "/");
});
afterEach(() => vi.unstubAllGlobals());

async function mountWithSnapshot(snap: unknown = snapshot) {
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  await act(async () => {
    FakeSocket.last!.push(snap);
  });
}

describe("SOFC Monitor Routed App", () => {
  it("renders the sidebar with text-only navigation links", async () => {
    render(<App />);
    expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plant Monitor" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Anomaly Detection" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Database Explorer" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Aspen Integration" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "AI Energy Management" })).toBeInTheDocument();
  });

  it("renders the Dashboard page by default with thermodynamic graphs and parameter sliders", async () => {
    await mountWithSnapshot();
    expect(screen.getByRole("heading", { name: /Plant Performance & Thermodynamics/i })).toBeInTheDocument();
    expect(screen.getByText("Interactive Operating Parameter Controls")).toBeInTheDocument();
    expect(screen.getByText("I–V Characteristics & Stack Power")).toBeInTheDocument();
    expect(screen.getByText("Voltage vs Current Density (V–j Polarization)")).toBeInTheDocument();
    expect(screen.getByText("Stack Temperature")).toBeInTheDocument();
    expect(screen.getByText("Fuel Utilization (Uf)")).toBeInTheDocument();
  });

  it("navigates to Plant Monitor and displays all six utilities with active alerts", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("link", { name: "Plant Monitor" }));

    for (const name of [
      "Hydrogen supply",
      "Cathode air and blower",
      "Stack cooling and temperatures",
      "Electrical and power conditioning",
      "Steam and water (HRSG)",
      "Differential pressure and safety",
    ]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("1 alarm")).toBeInTheDocument();
    const alerts = screen.getByRole("region", { name: /alerts/i });
    expect(within(alerts).getByText(/Anode recycle vs expected below/)).toBeInTheDocument();
    expect(within(alerts).getByText("Alarm")).toBeInTheDocument();
  });

  it("acknowledges an alert through the API on Plant Monitor", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("link", { name: "Plant Monitor" }));
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => /\/api\/alerts\/\d+\/ack$/.test(u))).toBe(true);
  });

  it("navigates to Anomaly Detection and renders the residual matrix and normality chart", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("link", { name: "Anomaly Detection" }));

    expect(screen.getByRole("heading", { name: /Physics-Informed Anomaly Detection/i })).toBeInTheDocument();
    expect(screen.getByText("Autoencoder Normality Score History")).toBeInTheDocument();
    expect(screen.getByText("First-Principles Thermodynamic Residuals Matrix")).toBeInTheDocument();
    expect(screen.getByText("Faraday Power Balance (r_far)")).toBeInTheDocument();
    expect(screen.getByText("Cathode ΔT Thermal Gradient (r_dT)")).toBeInTheDocument();
  });

  it("switches detail view when a utility is selected in Plant Monitor", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("link", { name: "Plant Monitor" }));
    fireEvent.click(screen.getAllByRole("button", { name: /Cathode air and blower/ })[0]);
    expect(screen.getByRole("heading", { name: /Cathode air and blower: checks and trends/ })).toBeInTheDocument();
    expect(screen.getAllByText("Blower power vs flow").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("< -15 or > 10%")).toBeInTheDocument();
  });

  it("reports a lost server connection and retries", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("link", { name: "Plant Monitor" }));
    await act(async () => {
      FakeSocket.last!.close();
    });
    expect(screen.getByText(/Server unreachable, retrying/)).toBeInTheDocument();
  });

  it("navigates to Database Explorer view", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("link", { name: "Database Explorer" }));
    expect(screen.getByRole("heading", { name: /Database Explorer/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Database Explorer" })).toHaveClass("active");
  });

  it("navigates to Aspen Integration view", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("link", { name: "Aspen Integration" }));
    expect(screen.getByRole("heading", { name: /Aspen Plus Integration/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Aspen Integration" })).toHaveClass("active");
  });

  it("navigates to AI Energy Management view", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("link", { name: "AI Energy Management" }));
    expect(screen.getByRole("heading", { name: /AI Energy Management System/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "AI Energy Management" })).toHaveClass("active");
  });
});
