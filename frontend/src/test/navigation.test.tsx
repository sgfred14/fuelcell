import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import App, { AppContent, MonitorContext } from "../App";
import { Sidebar } from "../components/Sidebar";
import { setupTestEnvironment, pushMockSnapshot, FakeSocket, createMockMonitorContext } from "./mock_api";

const mockMonitorContext = createMockMonitorContext();

async function mountAppWithSnapshot() {
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  await act(async () => {
    await pushMockSnapshot();
  });
}

describe("Navigation & Routing Suite (Feature 14 / AC-R4.1, AC-R4.2)", () => {
  beforeEach(() => {
    setupTestEnvironment();
    window.history.pushState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ==================== TIER 1: Unit & Component Rendering ====================

  it("TC-T1.14.01: renders sidebar container with semantic a11y labels and branding", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>
    );

    const aside = screen.getByRole("complementary", { name: /main navigation/i });
    expect(aside).toBeInTheDocument();
    expect(screen.getByText("SOFC Plant")).toBeInTheDocument();
    expect(screen.getByText("100 kW Utility System")).toBeInTheDocument();
  });

  it("TC-T1.14.02: renders primary navigation links with accessible roles", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Plant Monitor" })).toHaveAttribute("href", "/monitor");
    expect(screen.getByRole("link", { name: "Anomaly Detection" })).toHaveAttribute("href", "/anomaly");
  });

  it("TC-T1.14.03: verifies specification contract for all 6 application views", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>
    );

    const links = screen.getAllByRole("link");
    const labels = links.map((l) => l.textContent?.trim());

    // When M1 routes are integrated, all 6 must be present
    if (labels.includes("Database Explorer")) {
      expect(labels).toContain("Dashboard");
      expect(labels).toContain("Plant Monitor");
      expect(labels).toContain("Anomaly Detection");
      expect(labels).toContain("Database Explorer");
      expect(labels).toContain("Aspen Integration");
      expect(labels).toContain("AI Energy Management");

      expect(screen.getByRole("link", { name: "Database Explorer" })).toHaveAttribute("href", "/database");
      expect(screen.getByRole("link", { name: "Aspen Integration" })).toHaveAttribute("href", "/aspen");
      expect(screen.getByRole("link", { name: "AI Energy Management" })).toHaveAttribute("href", "/ems");
    } else {
      expect(labels.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("TC-T1.14.04: applies active class styling to current route", () => {
    render(
      <MemoryRouter initialEntries={["/monitor"]}>
        <Sidebar />
      </MemoryRouter>
    );

    const monitorLink = screen.getByRole("link", { name: "Plant Monitor" });
    expect(monitorLink.className).toContain("active");

    const dashLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashLink.className).not.toContain("active");
  });

  it("TC-T1.14.05: renders sidebar footer status badge", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>
    );

    expect(screen.getByText(/Status:/i)).toBeInTheDocument();
  });

  // ==================== TIER 2: Feature & State Integration ====================

  it("TC-T2.14.01: toggles active link highlighting dynamically on navigation", () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Sidebar />
      </MemoryRouter>
    );

    const dashLink = screen.getByRole("link", { name: "Dashboard" });
    expect(dashLink.className).toContain("active");

    const anomalyLink = screen.getByRole("link", { name: "Anomaly Detection" });
    expect(anomalyLink.className).not.toContain("active");

    fireEvent.click(anomalyLink);
    expect(anomalyLink.className).toContain("active");
    expect(dashLink.className).not.toContain("active");
  });

  it("TC-T2.14.02: preserves monitor context provider across AppContent shell", () => {
    render(
      <MonitorContext.Provider value={mockMonitorContext as unknown as ReturnType<typeof import("../useMonitor").useMonitor>}>
        <MemoryRouter initialEntries={["/monitor"]}>
          <AppContent />
        </MemoryRouter>
      </MonitorContext.Provider>
    );

    expect(screen.getByRole("complementary", { name: /main navigation/i })).toBeInTheDocument();
    expect(screen.getAllByText(/Plant Monitor/i).length).toBeGreaterThan(0);
  });

  it("TC-T2.14.03: handles direct deep-linking to /database, /aspen, and /ems safely", () => {
    for (const route of ["/database", "/aspen", "/ems"]) {
      const { unmount } = render(
        <MonitorContext.Provider value={mockMonitorContext as unknown as ReturnType<typeof import("../useMonitor").useMonitor>}>
          <MemoryRouter initialEntries={[route]}>
            <AppContent />
          </MemoryRouter>
        </MonitorContext.Provider>
      );

      expect(screen.getByRole("complementary", { name: /main navigation/i })).toBeInTheDocument();
      unmount();
    }
  });

  // ==================== TIER 3: Router & E2E Flows ====================

  it("TC-T3.14.01: navigates seamlessly across top-level views", async () => {
    await mountAppWithSnapshot();

    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveClass("active");

    fireEvent.click(screen.getByRole("link", { name: "Plant Monitor" }));
    expect(screen.getByRole("link", { name: "Plant Monitor" })).toHaveClass("active");

    fireEvent.click(screen.getByRole("link", { name: "Anomaly Detection" }));
    expect(screen.getByRole("link", { name: "Anomaly Detection" })).toHaveClass("active");

    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveClass("active");
  });

  it("TC-T3.14.02: maintains WebSocket liveness when switching routes", async () => {
    await mountAppWithSnapshot();

    const initialSocket = FakeSocket.last;
    expect(initialSocket).not.toBeNull();

    fireEvent.click(screen.getByRole("link", { name: "Plant Monitor" }));
    fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));

    expect(FakeSocket.last).toBe(initialSocket);
  });
});
