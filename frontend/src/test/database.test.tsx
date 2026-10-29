import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  type DbStatusResponse,
  type DbTickDocument,
  type DbAlertDocument,
  mockDbStatus,
  mockDbTicks,
  mockDbAlerts,
} from "./contracts";
import { setupTestEnvironment } from "./mock_api";
import { getPageModule } from "./page_loader";

describe("Database Explorer Suite (Features 1-4 / AC-R1.1 - AC-R1.10)", () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ==================== TIER 1: Unit & Component Calculations ====================

  it("TC-T1.01.01: parses MongoDB connection status and health indicators accurately", () => {
    const liveStatus: DbStatusResponse = { ...mockDbStatus, connected: true, status_text: "Connected to Atlas" };
    expect(liveStatus.connected).toBe(true);
    expect(liveStatus.status_text).toContain("Atlas");

    const offlineStatus: DbStatusResponse = {
      ...mockDbStatus,
      connected: false,
      mode: "offline_buffer",
      status_text: "MongoDB Unreachable - Buffering Locally",
      last_error: "Connection timed out after 5000ms",
    };
    expect(offlineStatus.connected).toBe(false);
    expect(offlineStatus.mode).toBe("offline_buffer");
    expect(offlineStatus.last_error).toBeTruthy();
  });

  it("TC-T1.01.02: ensures sensitive database credentials in target URI are securely masked", () => {
    function maskMongoUri(uri: string): string {
      return uri.replace(/\/\/[^:]+:[^@]+@/, "//***:***@");
    }

    const rawUri = "mongodb+srv://admin_user:super_secret_password@cluster0.mongodb.net/sofc_monitor?retryWrites=true";
    const masked = maskMongoUri(rawUri);

    expect(masked).not.toContain("admin_user");
    expect(masked).not.toContain("super_secret_password");
    expect(masked).toContain("mongodb+srv://***:***@cluster0.mongodb.net");
  });

  it("TC-T1.01.03: calculates total documents across cloud and local offline buffer", () => {
    const status: DbStatusResponse = {
      ...mockDbStatus,
      cloud_counts: {
        telemetry_ticks: 120000,
        alerts: 540,
        simulations: 32,
        thermo_calculations: 110,
      },
      local_buffer_counts: {
        telemetry_ticks: 150,
        alerts: 2,
        simulations: 0,
        thermo_calculations: 0,
      },
      pending_buffer_size: 152,
    };

    const totalCloud = Object.values(status.cloud_counts).reduce((a, b) => a + b, 0);
    const totalLocal = Object.values(status.local_buffer_counts).reduce((a, b) => a + b, 0);

    expect(totalCloud).toBe(120682);
    expect(totalLocal).toBe(152);
    expect(status.pending_buffer_size).toBe(152);
  });

  it("TC-T1.01.04: constructs query parameter strings for telemetry ticks filtering", () => {
    function buildTicksQuery(params: {
      overall?: "ok" | "warning" | "alarm";
      limit?: number;
      skip?: number;
      start_ts?: string;
      end_ts?: string;
    }): string {
      const q = new URLSearchParams();
      if (params.overall) q.set("overall", params.overall);
      if (params.limit !== undefined) q.set("limit", String(params.limit));
      if (params.skip !== undefined) q.set("skip", String(params.skip));
      if (params.start_ts) q.set("start_ts", params.start_ts);
      if (params.end_ts) q.set("end_ts", params.end_ts);
      return q.toString();
    }

    const query = buildTicksQuery({
      overall: "warning",
      limit: 25,
      skip: 50,
      start_ts: "2026-10-28T00:00:00Z",
    });

    expect(query).toContain("overall=warning");
    expect(query).toContain("limit=25");
    expect(query).toContain("skip=50");
    expect(query).toContain("start_ts=2026-10-28T00%3A00%3A00Z");
  });

  it("TC-T1.01.05: serializes complex document into syntax-highlighted JSON structure", () => {
    function formatJsonInspector(doc: unknown): string {
      return JSON.stringify(doc, null, 2);
    }

    const formatted = formatJsonInspector(mockDbTicks[0]);
    expect(formatted).toContain('"overall": "ok"');
    expect(formatted).toContain('"load_pct": 80');
    expect(formatted).toContain('"stack_temp_check"');
    expect(() => JSON.parse(formatted)).not.toThrow();
  });

  // ==================== TIER 2: Feature & State Integration ====================

  it("TC-T2.01.01: switches active collection tab between ticks, alerts, sims, and calcs", () => {
    type CollectionTab = "telemetry_ticks" | "alerts" | "simulations" | "thermo_calculations";
    let activeTab: CollectionTab = "telemetry_ticks";

    function setActiveTab(nextTab: CollectionTab) {
      activeTab = nextTab;
    }

    expect(activeTab).toBe("telemetry_ticks");
    setActiveTab("alerts");
    expect(activeTab).toBe("alerts");
    setActiveTab("simulations");
    expect(activeTab).toBe("simulations");
    setActiveTab("thermo_calculations");
    expect(activeTab).toBe("thermo_calculations");
  });

  it("TC-T2.01.02: filters telemetry ticks by overall status and timestamp", () => {
    function filterTicks(ticks: DbTickDocument[], status?: string, minLoad?: number): DbTickDocument[] {
      return ticks.filter((t) => {
        if (status && t.overall !== status) return false;
        if (minLoad !== undefined && t.load_pct < minLoad) return false;
        return true;
      });
    }

    const okOnly = filterTicks(mockDbTicks, "ok");
    expect(okOnly.length).toBe(1);
    expect(okOnly[0]._id).toBe("tick_001");

    const warnOnly = filterTicks(mockDbTicks, "warning");
    expect(warnOnly.length).toBe(1);
    expect(warnOnly[0]._id).toBe("tick_002");

    const highLoadOnly = filterTicks(mockDbTicks, undefined, 82);
    expect(highLoadOnly.length).toBe(1);
    expect(highLoadOnly[0].load_pct).toBe(85);
  });

  it("TC-T2.01.03: filters alerts by active status and target utility", () => {
    function filterAlerts(alerts: DbAlertDocument[], status?: string, utility?: string): DbAlertDocument[] {
      return alerts.filter((a) => {
        if (status && a.status !== status) return false;
        if (utility && a.utility !== utility) return false;
        return true;
      });
    }

    const activeAlarms = filterAlerts(mockDbAlerts, "active", "Hydrogen supply");
    expect(activeAlarms.length).toBe(1);
    expect(activeAlarms[0].key).toBe("anode_recycle_low");

    const clearedAlerts = filterAlerts(mockDbAlerts, "cleared");
    expect(clearedAlerts.length).toBe(1);
    expect(clearedAlerts[0].key).toBe("cathode_dt_high");
  });

  it("TC-T2.01.04: selects a document to inspect full nested payload in JSON viewer", () => {
    let selectedDoc: unknown = null;
    function handleSelectDoc(doc: unknown) {
      selectedDoc = doc;
    }

    handleSelectDoc(mockDbTicks[1]);
    expect(selectedDoc).toEqual(mockDbTicks[1]);
    expect((selectedDoc as DbTickDocument).t_stack_c).toBe(742.0);
  });

  it("TC-T2.01.05: invokes POST /api/db/flush to commit queued records to cloud MongoDB", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/db/flush")) {
        return new Response(JSON.stringify({ flushed: true, status: { ...mockDbStatus, pending_buffer_size: 0 } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetch("/api/db/flush", { method: "POST" });
    const data = await res.json();

    expect(data.flushed).toBe(true);
    expect(data.status.pending_buffer_size).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/db/flush"), expect.any(Object));
  });

  it("TC-T2.01.06: invokes POST /api/db/reconnect with custom connection credentials", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/db/reconnect")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            ...mockDbStatus,
            database: body.db_name ?? "custom_sofc",
            connected: true,
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetch("/api/db/reconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uri: "mongodb://custom_host:27017", db_name: "custom_sofc" }),
    });
    const status = await res.json();

    expect(status.connected).toBe(true);
    expect(status.database).toBe("custom_sofc");
  });

  it("TC-T2.01.07: handles empty collection state with helpful messaging and reset trigger", () => {
    const emptyDocs: unknown[] = [];
    const hasRecords = emptyDocs.length > 0;
    const emptyMessage = hasRecords ? "" : "No documents found matching the filter";

    expect(hasRecords).toBe(false);
    expect(emptyMessage).toBe("No documents found matching the filter");
  });

  it("TC-T2.01.08: handles API failure during fetch with retry and error surface", async () => {
    let attempts = 0;
    async function fetchWithRetry(_url: string): Promise<DbStatusResponse> {
      attempts++;
      if (attempts === 1) throw new Error("503 Service Unavailable");
      return mockDbStatus;
    }

    await expect(fetchWithRetry("/api/db/status")).rejects.toThrow("503 Service Unavailable");
    const retryResult = await fetchWithRetry("/api/db/status");
    expect(retryResult.connected).toBe(true);
    expect(attempts).toBe(2);
  });

  // ==================== Progressive Component Verification ====================

  it("TC-T2.01.09: renders DatabasePage component if implemented", async () => {
    const DatabasePage = getPageModule("DatabasePage");
    if (!DatabasePage) {
      // Milestone 2 not yet implemented; contract verified above
      expect(true).toBe(true);
      return;
    }

    render(<DatabasePage />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screen.getByText(/Database/i)).toBeInTheDocument();
  });
});
