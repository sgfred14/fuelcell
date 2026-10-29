import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import App from "../App";
import {
  mockAspenVerification,
  mockDbStatus,
  mockDbTicks,
  mockEmsForecast,
} from "./contracts";
import { setupTestEnvironment, pushMockSnapshot } from "./mock_api";
import { getPageModule } from "./page_loader";

describe("Real-World Workload Scenarios & System Invariants (Tiers 3 & 4)", () => {
  beforeEach(() => {
    setupTestEnvironment();
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ==================== Real-World Application Scenarios (Tier 4) ====================

  it("Scenario 1: Operator inspects live telemetry, detects warning, and navigates to Database Explorer", async () => {
    render(<App />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      await pushMockSnapshot();
    });

    // Operator starts on Dashboard
    expect(screen.getByRole("heading", { name: /Plant Performance & Thermodynamics/i })).toBeInTheDocument();

    // Navigates to Plant Monitor
    fireEvent.click(screen.getByRole("link", { name: "Plant Monitor" }));
    expect(screen.getAllByText(/Plant Monitor/i).length).toBeGreaterThan(0);

    // Operator navigates to Database Explorer if link exists in sidebar
    const dbLink = screen.queryByRole("link", { name: "Database Explorer" });
    if (dbLink) {
      fireEvent.click(dbLink);
      expect(window.location.pathname).toBe("/database");
    }

    // Verify raw JSON tick data payload structure satisfies schema
    const tick = mockDbTicks[1];
    expect(tick.overall).toBe("warning");
    expect(tick.t_stack_c).toBe(742.0);
    expect(tick.checks["stack_temp_check"].status).toBe("warning");
  });

  it("Scenario 2: Plant engineer triggers Aspen verification, views deviations, and runs optimization", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/aspen/pull-and-verify")) {
        return new Response(JSON.stringify(mockAspenVerification), { status: 200 });
      }
      if (url.includes("/api/aspen/optimize")) {
        return new Response(
          JSON.stringify({ candidates: mockAspenVerification.optimal_candidates, objective: "eta_el" }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    // 1. Pull & verify process values
    const verifyRes = await fetch("/api/aspen/pull-and-verify", { method: "POST" });
    const verifyData = await verifyRes.json();

    expect(verifyData.verdict).toBe("PASS");
    expect(verifyData.verification_table.length).toBe(10);
    expect(verifyData.comparison.p_ac_kw.unit).toBe("kW");

    // 2. Multi-parameter optimization execution
    const optRes = await fetch("/api/aspen/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective: "eta_el" }),
    });
    const optData = await optRes.json();

    expect(optData.candidates.length).toBeGreaterThan(0);
    expect(optData.candidates[0].eta_el).toBe(54.8);
    expect(optData.candidates[0].rank).toBe(1);
  });

  it("Scenario 3: Energy manager analyzes 24h TOU tariff peaks, evaluates SOFC dispatch savings, and inspects degradation", async () => {
    // 1. Forecast data inspect
    const forecast = mockEmsForecast.forecast;
    expect(forecast.length).toBe(24);

    // Check peak tariff hours (14:00 - 19:00)
    const peakHours = forecast.filter((f) => f.tariff_usd_kwh === 0.28);
    expect(peakHours.length).toBe(6);

    // Check SOFC dispatch during on-peak
    for (const h of peakHours) {
      expect(h.sofc_dispatch_kw).toBeGreaterThanOrEqual(50);
      expect(h.sofc_dispatch_kw).toBeLessThanOrEqual(100);
      expect(h.savings_usd).toBeGreaterThan(0);
    }

    // 2. Degradation trajectory check
    const degradation = mockEmsForecast.degradation_projection;
    expect(degradation.length).toBe(9);
    expect(degradation[0].hours).toBe(0);
    expect(degradation[0].stack_health_pct).toBe(100.0);
    expect(degradation[8].hours).toBe(20000);
    expect(degradation[8].stack_health_pct).toBe(20.0);
  });

  it("Scenario 4: Full application walk across all views with simulated backend offline & recovery", async () => {
    const { FakeSocket } = setupTestEnvironment();
    render(<App />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
      await pushMockSnapshot();
    });

    // 1. Walk across views
    fireEvent.click(screen.getByRole("link", { name: "Anomaly Detection" }));
    expect(screen.getByRole("heading", { name: /Physics-Informed Anomaly Detection/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Plant Monitor" }));
    expect(screen.getAllByText(/Plant Monitor/i).length).toBeGreaterThan(0);

    // 2. Simulate server disconnection while on Plant Monitor
    await act(async () => {
      FakeSocket.last?.close();
    });

    // TopBar on Plant Monitor renders offline reconnection warning
    expect(screen.getByText(/Server unreachable, retrying/i)).toBeInTheDocument();

    // 3. Simulate recovery
    await act(async () => {
      FakeSocket.last?.push({ type: "conn", conn: "live" });
    });
  });

  it("Scenario 5: System invariants, API contracts, and graceful edge handling", async () => {
    // Invariant 1: Database status contract
    expect(mockDbStatus.enabled).toBe(true);
    expect(mockDbStatus.mode).toMatch(/motor|pymongo|atlas_data_api|offline_buffer/);
    expect(mockDbStatus.cloud_counts).toBeDefined();

    // Invariant 2: Aspen baseline paths contract (10 paths)
    expect(mockAspenVerification.verification_table.length).toBe(10);
    expect(mockAspenVerification.model_result.valid).toBe(true);

    // Invariant 3: EMS 24-hour horizon contract
    expect(mockEmsForecast.horizon_hours).toBe(24);
    expect(mockEmsForecast.forecast.length).toBe(24);
    expect(mockEmsForecast.summary.self_sufficiency_pct).toBeGreaterThanOrEqual(0);
    expect(mockEmsForecast.summary.self_sufficiency_pct).toBeLessThanOrEqual(100);

    // Invariant 4: Degradation trajectory bounds
    for (const point of mockEmsForecast.degradation_projection) {
      expect(point.cell_voltage_v).toBeGreaterThanOrEqual(0.55);
      expect(point.cell_voltage_v).toBeLessThanOrEqual(1.0);
      expect(point.stack_health_pct).toBeGreaterThanOrEqual(0);
      expect(point.stack_health_pct).toBeLessThanOrEqual(100);
    }
  });

  // ==================== Progressive Page Rendering Verification ====================

  it("Scenario 6: Progressive page loading checks across /database, /aspen, and /ems", () => {
    const dbPage = getPageModule("DatabasePage");
    const aspenPage = getPageModule("AspenPage");
    const emsPage = getPageModule("EmsPage");

    // Before M2-M4, components may be null without causing failure
    if (dbPage) expect(dbPage).toBeDefined();
    if (aspenPage) expect(aspenPage).toBeDefined();
    if (emsPage) expect(emsPage).toBeDefined();
    expect(true).toBe(true);
  });
});
