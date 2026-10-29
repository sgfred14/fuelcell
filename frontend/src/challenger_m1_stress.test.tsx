import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api";
import App, { useMonitorContext } from "./App";
import config from "./fixtures/config.json";
import snapshot from "./fixtures/snapshot.json";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      if (!this.closed) this.onopen?.();
    }, 0);
  }

  send() {}
  close() {
    this.closed = true;
    this.onclose?.();
  }

  push(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
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

describe("Milestone 1 Adversarial & Empirical Stress Suite", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/config") {
        return new Response(JSON.stringify(config), { status: 200 });
      }
      if (url === "/api/polarization") {
        return new Response(JSON.stringify(mockPolarization), { status: 200 });
      }
      if (url.includes("/api/thermodynamic")) {
        return new Response(JSON.stringify(mockThermodynamic), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, url, method: init?.method || "GET" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Adversarial API Query Serialization & Edge Cases", () => {
    it("handles completely empty query objects without trailing ? or undefined", async () => {
      await api.dbTicks({});
      await api.dbAlerts({});
      await api.dbSimulations({});
      await api.dbCalculations({});
      await api.emsForecast({});

      for (const call of fetchMock.mock.calls) {
        const url = String(call[0]);
        expect(url).not.toContain("?");
        expect(url).not.toContain("undefined");
        expect(url).not.toContain("null");
      }
    });

    it("handles undefined and null inputs cleanly without trailing ?", async () => {
      await api.dbTicks(undefined);
      await api.dbAlerts(undefined);
      await api.dbSimulations(undefined);
      await api.dbCalculations(undefined);
      await api.emsForecast(undefined);
      await api.aspenHistory(undefined);
      await api.emsHistory(undefined);

      for (const call of fetchMock.mock.calls) {
        const url = String(call[0]);
        expect(url).not.toContain("?");
        expect(url).not.toContain("undefined");
      }
    });

    it("preserves number 0, negative numbers, and extreme integers without dropping or corrupting them", async () => {
      await api.dbTicks({ limit: 0, skip: 0 });
      expect(fetchMock).toHaveBeenLastCalledWith("/api/db/ticks?limit=0&skip=0", undefined);

      await api.dbTicks({ limit: -100, skip: 0 });
      expect(fetchMock).toHaveBeenLastCalledWith("/api/db/ticks?limit=-100&skip=0", undefined);

      const maxInt = Number.MAX_SAFE_INTEGER;
      await api.dbAlerts({ limit: maxInt });
      expect(fetchMock).toHaveBeenLastCalledWith(`/api/db/alerts?limit=${maxInt}`, undefined);

      await api.emsForecast({ base_demand_kw: 0, h2_cost_usd_kg: 0 });
      expect(fetchMock).toHaveBeenLastCalledWith("/api/ems/forecast?base_demand_kw=0&h2_cost_usd_kg=0", undefined);

      await api.aspenHistory(0);
      expect(fetchMock).toHaveBeenLastCalledWith("/api/aspen/history?limit=0", undefined);

      await api.emsHistory(0);
      expect(fetchMock).toHaveBeenLastCalledWith("/api/ems/history?limit=0", undefined);
    });

    it("preserves boolean false and true without dropping them", async () => {
      // In JS, passing boolean fields in Record<string, unknown>
      await api.dbTicks({ overall: false as unknown as "ok" });
      expect(fetchMock).toHaveBeenLastCalledWith("/api/db/ticks?overall=false", undefined);

      await api.dbAlerts({ status: true as unknown as "active" });
      expect(fetchMock).toHaveBeenLastCalledWith("/api/db/alerts?status=true", undefined);
    });

    it("correctly encodes special characters, symbols, and Unicode strings", async () => {
      await api.dbAlerts({
        status: "active",
        utility: "Hydrogen & Fuel + Cell / 100% #1? (Specially Tested)",
      });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("Hydrogen+%26+Fuel+%2B+Cell+%2F+100%25+%231%3F+%28Specially+Tested%29");

      await api.dbAlerts({
        utility: "Électricité / 水素 / 燃料電池",
      });
      const [unicodeUrl] = fetchMock.mock.calls[1];
      expect(unicodeUrl).toContain("%C3%89lectricit%C3%A9");
      expect(unicodeUrl).toContain("%E6%B0%B4%E7%B4%A0");
    });

    it("filters out empty string, null, and undefined while keeping populated values", async () => {
      await api.dbTicks({
        start_ts: "2026-03-01T00:00:00Z",
        end_ts: "",
        overall: undefined,
        limit: 100,
        skip: null as unknown as undefined,
      });
      expect(fetchMock).toHaveBeenLastCalledWith("/api/db/ticks?start_ts=2026-03-01T00%3A00%3A00Z&limit=100", undefined);
    });

    it("verifies POST default payload guarantees", async () => {
      await api.aspenPullAndVerify();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/aspen/pull-and-verify",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        })
      );

      await api.aspenOptimize();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/aspen/optimize",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ objective: "eta_el" }),
        })
      );

      await api.dbReconnect();
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/db/reconnect",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({}),
        })
      );
    });
  });

  describe("Adversarial HTTP Error Handling", () => {
    it("handles non-JSON HTML 500 error bodies gracefully", async () => {
      fetchMock.mockImplementationOnce(async () => {
        return new Response("<html><body>500 Internal Server Error</body></html>", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "text/html" },
        });
      });
      await expect(api.dbStatus()).rejects.toThrow("500 Internal Server Error");
    });

    it("handles empty 502 Bad Gateway responses gracefully", async () => {
      fetchMock.mockImplementationOnce(async () => {
        return new Response("", { status: 502, statusText: "Bad Gateway" });
      });
      await expect(api.emsStatus()).rejects.toThrow("502 Bad Gateway");
    });

    it("handles JSON error bodies lacking detail property gracefully", async () => {
      fetchMock.mockImplementationOnce(async () => {
        return new Response(JSON.stringify({ error: "Unauthorized access", code: 401 }), {
          status: 401,
          statusText: "Unauthorized",
        });
      });
      await expect(api.aspenStatus()).rejects.toThrow("401 Unauthorized");
    });

    it("handles complex nested object details gracefully", async () => {
      const nestedDetail = { field: "limit", constraints: { min: 1, max: 1000 }, code: "VALUE_TOO_LARGE" };
      fetchMock.mockImplementationOnce(async () => {
        return new Response(JSON.stringify({ detail: nestedDetail }), {
          status: 422,
          statusText: "Unprocessable Entity",
        });
      });
      await expect(api.dbSimulations({ limit: 99999 })).rejects.toThrow(JSON.stringify(nestedDetail));
    });

    it("propagates genuine network / fetch connection errors", async () => {
      fetchMock.mockImplementationOnce(async () => {
        throw new TypeError("Failed to fetch");
      });
      await expect(api.dbStatus()).rejects.toThrow("Failed to fetch");
    });
  });

  describe("Adversarial Router Mounting and Navigation Resilience", () => {
    it("survives unknown and invalid routes without crashing the app shell", async () => {
      window.history.pushState({}, "", "/completely-invalid-nonexistent-path-404");
      render(<App />);

      // Shell brand and sidebar must still be rendered and fully operational
      expect(screen.getByText("SOFC Plant")).toBeInTheDocument();
      expect(screen.getByText("100 kW Utility System")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Database Explorer" })).toBeInTheDocument();
    });

    it("survives rapid consecutive route transitions across M1 views without crashing", async () => {
      render(<App />);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
        MockWebSocket.instances[0]?.push(snapshot);
      });

      const routes = [
        "Database Explorer",
        "Aspen Integration",
        "AI Energy Management",
        "Plant Monitor",
        "Anomaly Detection",
        "Dashboard",
        "Database Explorer",
        "AI Energy Management",
        "Aspen Integration",
        "Database Explorer",
      ];

      for (const routeName of routes) {
        await act(async () => {
          fireEvent.click(screen.getByRole("link", { name: routeName }));
        });
      }

      // Final target was Database Explorer
      expect(screen.getByRole("heading", { name: /Database Explorer/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Database Explorer" })).toHaveClass("active");
    });

    it("preserves active sidebar highlight when query parameters or hash fragments are present", async () => {
      window.history.pushState({}, "", "/database?tab=alerts&filter=active#json-section");
      render(<App />);

      expect(screen.getByRole("heading", { name: /Database Explorer/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Database Explorer" })).toHaveClass("active");
    });

    it("throws a descriptive error when useMonitorContext is invoked outside provider", () => {
      // Create a test component to invoke the hook inside React's render phase
      function OutsideConsumer() {
        useMonitorContext();
        return <div>Consumer</div>;
      }

      // Suppress React error boundary console.error during this test
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(() => render(<OutsideConsumer />)).toThrow(
        "useMonitorContext must be used within MonitorContext.Provider"
      );
      spy.mockRestore();
    });
  });
});
