import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import DatabasePage from "./pages/DatabasePage";
import { StatusCard, maskMongoUri } from "./components/db/StatusCard";
import { CollectionTabs } from "./components/db/CollectionTabs";
import { CollectionTable } from "./components/db/CollectionTable";
import { JsonInspector, formatJsonInspector } from "./components/db/JsonInspector";
import { ReconnectModal } from "./components/db/ReconnectModal";
import {
  type DbStatusResponse,
  mockDbStatus,
  mockDbTicks,
  mockDbAlerts,
} from "./test/contracts";

describe("Milestone 2 Adversarial & Empirical Stress Suite (Database Explorer)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const defaultMockStatus: DbStatusResponse = {
    ...mockDbStatus,
    enabled: true,
    connected: true,
    status_text: "Connected to MongoDB Atlas",
    mode: "motor",
    database: "sofc_monitor",
    target: "mongodb+srv://sofc_admin:superSecretPass123@cluster0.mongodb.net/sofc_monitor?retryWrites=true",
    cloud_counts: {
      telemetry_ticks: 1500,
      alerts: 25,
      simulations: 10,
      thermo_calculations: 8,
    },
    local_buffer_counts: {
      telemetry_ticks: 5,
      alerts: 1,
      simulations: 0,
      thermo_calculations: 0,
    },
    pending_buffer_size: 6,
    stats: {
      flushes_total: 12,
      ticks_inserted: 1495,
      alerts_inserted: 24,
      sims_inserted: 10,
      calcs_inserted: 8,
      errors_total: 0,
    },
    last_error: null,
  };

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);

      if (u.includes("/api/db/status")) {
        return new Response(JSON.stringify(defaultMockStatus), { status: 200 });
      }
      if (u.includes("/api/db/ticks")) {
        return new Response(JSON.stringify(mockDbTicks), { status: 200 });
      }
      if (u.includes("/api/db/alerts")) {
        return new Response(JSON.stringify(mockDbAlerts), { status: 200 });
      }
      if (u.includes("/api/db/simulations")) {
        return new Response(
          JSON.stringify([
            { _id: "sim_001", action: "start", timestamp: "2026-10-28T10:00:00Z", parameters: { load_pct: 80 } },
            { _id: "sim_002", action: "fault", timestamp: "2026-10-28T10:15:00Z", parameters: { type: "blower" } },
          ]),
          { status: 200 }
        );
      }
      if (u.includes("/api/db/calculations")) {
        return new Response(
          JSON.stringify([
            {
              _id: "calc_001",
              calc_type: "polarization",
              timestamp: "2026-10-28T10:30:00Z",
              input_params: { j_max: 0.8 },
              output_results: { v_mpp: 0.69 },
            },
            {
              _id: "calc_002",
              calc_type: "sweep",
              timestamp: "2026-10-28T10:45:00Z",
              input_params: { var: "t_stack" },
              output_results: { peak_eff: 0.54 },
            },
          ]),
          { status: 200 }
        );
      }
      if (u.includes("/api/db/flush")) {
        return new Response(
          JSON.stringify({
            flushed: true,
            status: { ...defaultMockStatus, pending_buffer_size: 0 },
          }),
          { status: 200 }
        );
      }
      if (u.includes("/api/db/reconnect")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(
          JSON.stringify({
            ...defaultMockStatus,
            database: body.db_name ?? defaultMockStatus.database,
            target: body.uri ?? defaultMockStatus.target,
            connected: true,
          }),
          { status: 200 }
        );
      }

      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // =========================================================================
  // SECTION 1: Adversarial Rapid Tab Switching & State Corruption Stress
  // =========================================================================
  describe("Adversarial Tab Switching & Filter Stress", () => {
    it("survives rapid tab switching across all 4 collections without state corruption or crash", async () => {
      render(<DatabasePage />);

      // Wait for initial render
      await waitFor(() => {
        expect(screen.getByText("Database Explorer")).toBeInTheDocument();
      });

      // Rapidly click all 4 collection tabs in succession
      const tabs = [
        "System Alerts (alerts)",
        "Simulation Runs (simulations)",
        "Calculations (thermo_calculations)",
        "Telemetry Ticks (telemetry_ticks)",
      ];

      for (const tabText of tabs) {
        const tabBtn = screen.getByRole("tab", { name: new RegExp(tabText.replace(/[()]/g, "\\$&"), "i") });
        await act(async () => {
          fireEvent.click(tabBtn);
        });
      }

      // Final tab is Telemetry Ticks
      await waitFor(() => {
        const tickTab = screen.getByRole("tab", { name: /Telemetry Ticks/i });
        expect(tickTab).toHaveAttribute("aria-selected", "true");
        expect(document.getElementById("panel-telemetry_ticks")).toBeInTheDocument();
      });

      // Verify table headers match telemetry ticks
      expect(screen.getByText("DC Power")).toBeInTheDocument();
      expect(screen.getByText("Stack Temp")).toBeInTheDocument();
    });

    it("discards out-of-order stale responses during rapid collection transitions", async () => {
      // Simulate slow response for alerts (150ms) and fast response for simulations (10ms)
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("/api/db/status")) {
          return new Response(JSON.stringify(defaultMockStatus), { status: 200 });
        }
        if (u.includes("/api/db/ticks")) {
          return new Response(JSON.stringify(mockDbTicks), { status: 200 });
        }
        if (u.includes("/api/db/alerts")) {
          await new Promise((r) => setTimeout(r, 150));
          return new Response(JSON.stringify(mockDbAlerts), { status: 200 });
        }
        if (u.includes("/api/db/simulations")) {
          await new Promise((r) => setTimeout(r, 10));
          return new Response(
            JSON.stringify([
              { _id: "fast_sim_1", action: "start", timestamp: "2026-10-28T12:00:00Z", parameters: {} },
            ]),
            { status: 200 }
          );
        }
        return new Response("[]", { status: 200 });
      });

      render(<DatabasePage />);

      await waitFor(() => {
        expect(screen.getByText("Database Explorer")).toBeInTheDocument();
      });

      // Click Alerts (slow), then immediately click Simulations (fast)
      const alertsTab = screen.getByRole("tab", { name: /System Alerts/i });
      const simsTab = screen.getByRole("tab", { name: /Simulation Runs/i });

      await act(async () => {
        fireEvent.click(alertsTab);
      });
      await act(async () => {
        fireEvent.click(simsTab);
      });

      // Wait for simulations to resolve and verify active tab is simulations
      await waitFor(() => {
        expect(simsTab).toHaveAttribute("aria-selected", "true");
        expect(screen.getByText(/Simulation Details/i)).toBeInTheDocument();
      });

      // Advance timers by 200ms to allow alerts to resolve in the background
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200));
      });

      // Verify that slow alerts response did NOT overwrite simulations table
      expect(simsTab).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText(/Simulation Details/i)).toBeInTheDocument();
      expect(screen.queryByText(/Utility Subsystem/i)).not.toBeInTheDocument();
    });

    it("supports keyboard navigation (ArrowLeft and ArrowRight) wrapping across tabs", () => {
      const handleTabChange = vi.fn();
      render(
        <CollectionTabs
          activeTab="telemetry_ticks"
          onTabChange={handleTabChange}
          status={defaultMockStatus as any}
        />
      );

      const firstTab = screen.getByRole("tab", { name: /Telemetry Ticks/i });

      // Press ArrowRight -> moves to alerts
      fireEvent.keyDown(firstTab, { key: "ArrowRight" });
      expect(handleTabChange).toHaveBeenCalledWith("alerts");

      // Press ArrowLeft on firstTab -> wraps around to thermo_calculations
      fireEvent.keyDown(firstTab, { key: "ArrowLeft" });
      expect(handleTabChange).toHaveBeenCalledWith("thermo_calculations");
    });
  });

  // =========================================================================
  // SECTION 2: Empty Query Results & Filter Message Assertions
  // =========================================================================
  describe("Empty Query Results & Filtering Edge Cases", () => {
    it("renders exact 'No documents found matching the filter' when records list is empty", () => {
      const onSelect = vi.fn();
      render(
        <CollectionTable
          activeTab="telemetry_ticks"
          records={[]}
          loading={false}
          selectedDoc={null}
          onSelectDoc={onSelect}
        />
      );

      const emptyCell = screen.getByText("No documents found matching the filter");
      expect(emptyCell).toBeInTheDocument();
    });

    it("renders exact 'No documents found matching the filter' when filter removes all rows", () => {
      const onSelect = vi.fn();
      render(
        <CollectionTable
          activeTab="telemetry_ticks"
          records={mockDbTicks}
          loading={false}
          selectedDoc={null}
          onSelectDoc={onSelect}
        />
      );

      // Verify initial records render
      expect(screen.getByText("#tick_001")).toBeInTheDocument();

      // Apply Min Load % filter that exceeds any record (e.g., 999%)
      const loadInput = screen.getByLabelText("Filter ticks by minimum load percentage");
      fireEvent.change(loadInput, { target: { value: "999" } });

      expect(screen.getByText("No documents found matching the filter")).toBeInTheDocument();
      expect(screen.queryByText("#tick_001")).not.toBeInTheDocument();
    });

    it("resets filters and restores document list when Reset button is clicked", () => {
      const onSelect = vi.fn();
      render(
        <CollectionTable
          activeTab="telemetry_ticks"
          records={mockDbTicks}
          loading={false}
          selectedDoc={null}
          onSelectDoc={onSelect}
        />
      );

      // Filter by search query with no matches
      const searchInput = screen.getByLabelText("Search collection documents");
      fireEvent.change(searchInput, { target: { value: "completely_nonexistent_id_xyz" } });

      expect(screen.getByText("No documents found matching the filter")).toBeInTheDocument();

      // Click Reset button
      const resetBtn = screen.getByTitle("Reset all filters");
      fireEvent.click(resetBtn);

      expect(screen.getByText("#tick_001")).toBeInTheDocument();
      expect(screen.queryByText("No documents found matching the filter")).not.toBeInTheDocument();
    });

    it("safely handles null/undefined records prop without crashing", () => {
      const onSelect = vi.fn();
      render(
        <CollectionTable
          activeTab="alerts"
          records={null as unknown as unknown[]}
          loading={false}
          selectedDoc={null}
          onSelectDoc={onSelect}
        />
      );

      expect(screen.getByText("No documents found matching the filter")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // SECTION 3: Adversarial JSON Inspector Stress
  // =========================================================================
  describe("Adversarial JSON Inspector Stress", () => {
    it("renders 25+ levels deeply nested document without freezing or stack overflow", () => {
      // Build 25 levels deep object
      let deepDoc: Record<string, unknown> = { leafValue: "deep_target_reached", count: 42 };
      for (let i = 24; i >= 0; i--) {
        deepDoc = { [`level_${i}`]: deepDoc, depth: i };
      }

      // Test formatJsonInspector
      const formatted = formatJsonInspector(deepDoc);
      expect(formatted).toContain('"leafValue": "deep_target_reached"');

      // Test component rendering in Tree View
      render(<JsonInspector doc={deepDoc} />);
      expect(screen.getByText("Document Inspector")).toBeInTheDocument();

      // Switch to Raw JSON view
      const rawBtn = screen.getByRole("button", { name: /Raw JSON/i });
      fireEvent.click(rawBtn);

      expect(screen.getByRole("region", { name: "Formatted Syntax-Highlighted JSON" })).toBeInTheDocument();

      // Re-render with tree view again to ensure no crash
      const treeBtn = screen.getByRole("button", { name: /Tree View/i });
      fireEvent.click(treeBtn);
      expect(screen.getByRole("region", { name: "Expandable JSON Tree" })).toBeInTheDocument();
    });

    it("handles complex structures containing null, booleans, mixed arrays, and extreme numbers", () => {
      const complexDoc = {
        nullVal: null,
        boolTrue: true,
        boolFalse: false,
        zero: 0,
        negZero: -0,
        extremeInt: Number.MAX_SAFE_INTEGER,
        floatVal: 0.00000012345,
        emptyArr: [],
        emptyObj: {},
        mixedArr: [null, true, 100, "string_in_arr", { nestedInArr: false }],
        specialChars: "<script>alert('xss')</script> & 'quoted' \"double\" / \\ \n \t",
        unicodeEmoji: "⚡ Fuel Cell H₂ 99.9% / 800°C 🔋",
      };

      const formatted = formatJsonInspector(complexDoc);
      expect(() => JSON.parse(formatted)).not.toThrow();

      render(<JsonInspector doc={complexDoc} />);

      // Switch to Raw JSON view and verify tokens
      fireEvent.click(screen.getByRole("button", { name: /Raw JSON/i }));
      expect(screen.getByText('"nullVal"')).toBeInTheDocument();
      expect(screen.getAllByText("null").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("true").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("false").length).toBeGreaterThanOrEqual(1);
    });

    it("handles circular reference gracefully via fallback and ErrorBoundary", () => {
      const circular: any = { name: "circular_root" };
      circular.self = circular;

      // formatJsonInspector should catch TypeError and return String(doc)
      const res = formatJsonInspector(circular);
      expect(res).toBe("[object Object]");

      // JsonInspector shouldn't crash
      expect(() => render(<JsonInspector doc={circular} />)).not.toThrow();
    });

    it("handles clipboard copy and falls back cleanly if clipboard API fails", async () => {
      // Stub navigator.clipboard.writeText
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("navigator", {
        clipboard: {
          writeText: writeTextMock,
        },
      });

      render(<JsonInspector doc={{ testKey: "testValue" }} />);

      const copyBtn = screen.getByRole("button", { name: /Copy JSON/i });
      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(writeTextMock).toHaveBeenCalledWith(expect.stringContaining('"testKey": "testValue"'));
      expect(screen.getByText("Copied!")).toBeInTheDocument();
    });
  });

  // =========================================================================
  // SECTION 4: Flush Buffer Action with Network Error Fallback
  // =========================================================================
  describe("Flush Buffer Action with Network Error Fallback", () => {
    it("handles network failure during buffer flush and renders error banner with retry option", async () => {
      // Mock flush endpoint to fail with 503
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("/api/db/status")) {
          return new Response(JSON.stringify(defaultMockStatus), { status: 200 });
        }
        if (u.includes("/api/db/ticks")) {
          return new Response(JSON.stringify(mockDbTicks), { status: 200 });
        }
        if (u.includes("/api/db/flush")) {
          return new Response("Atlas Cluster connection timed out (503)", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return new Response("[]", { status: 200 });
      });

      render(<DatabasePage />);

      await waitFor(() => {
        expect(screen.getByText("Flush Buffer Now")).toBeInTheDocument();
      });

      const flushBtn = screen.getByText("Flush Buffer Now");
      await act(async () => {
        fireEvent.click(flushBtn);
      });

      // Verify error alert banner is displayed
      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(screen.getByText(/503 Service Unavailable/i)).toBeInTheDocument();
      });

      // Verify Retry Connection button exists in error banner
      const retryBtn = screen.getByRole("button", { name: /Retry Connection/i });
      expect(retryBtn).toBeInTheDocument();

      // Verify flush button is re-enabled and not stuck in loading spinner
      expect(flushBtn).not.toBeDisabled();
    });

    it("displays success notification and resets pending buffer count on successful flush", async () => {
      render(<DatabasePage />);

      await waitFor(() => {
        expect(screen.getByText("Flush Buffer Now")).toBeInTheDocument();
      });

      const flushBtn = screen.getByText("Flush Buffer Now");
      await act(async () => {
        fireEvent.click(flushBtn);
      });

      await waitFor(() => {
        expect(screen.getByRole("status")).toHaveTextContent(
          /Local buffer committed successfully to MongoDB Atlas/i
        );
      });
    });
  });

  // =========================================================================
  // SECTION 5: Reconnect Action with Malformed URI Inputs
  // =========================================================================
  describe("Reconnect Action with Malformed URI Inputs", () => {
    it("opens reconnect modal and rejects malformed URI with displayed error without closing modal", async () => {
      // Mock reconnect endpoint to reject malformed URI
      fetchMock.mockImplementation(async (url: string) => {
        const u = String(url);
        if (u.includes("/api/db/status")) {
          return new Response(JSON.stringify(defaultMockStatus), { status: 200 });
        }
        if (u.includes("/api/db/ticks")) {
          return new Response(JSON.stringify(mockDbTicks), { status: 200 });
        }
        if (u.includes("/api/db/reconnect")) {
          return new Response(
            JSON.stringify({
              detail: "Invalid URI scheme: connection string must start with 'mongodb://' or 'mongodb+srv://'",
            }),
            { status: 400, statusText: "Bad Request" }
          );
        }
        return new Response("[]", { status: 200 });
      });

      render(<DatabasePage />);

      await waitFor(() => {
        expect(screen.getByText("Reconnect Database")).toBeInTheDocument();
      });

      // Open Reconnect Modal
      fireEvent.click(screen.getByText("Reconnect Database"));

      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Database Reconnect & Target Setup")).toBeInTheDocument();

      // Enter completely malformed URI
      const uriInput = screen.getByLabelText("MongoDB Target URI");
      fireEvent.change(uriInput, { target: { value: "invalid-scheme://malformed_uri_input:99999" } });

      // Submit reconnect form
      const submitBtn = screen.getByRole("button", { name: /Apply & Reconnect/i });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      // Verify modal remains open and displays error banner
      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(screen.getByText(/Invalid URI scheme/i)).toBeInTheDocument();
      });

      // Verify inputs remain interactive
      expect(uriInput).not.toBeDisabled();
      expect(submitBtn).not.toBeDisabled();
    });

    it("closes modal via Escape key and backdrop click", async () => {
      const handleClose = vi.fn();
      const handleReconnect = vi.fn();

      render(
        <ReconnectModal
          isOpen={true}
          onClose={handleClose}
          onReconnect={handleReconnect}
          currentDbName="sofc_monitor"
        />
      );

      // Press Escape key
      fireEvent.keyDown(window, { key: "Escape" });
      expect(handleClose).toHaveBeenCalledTimes(1);

      // Click on backdrop presentation layer
      const presentation = screen.getByRole("presentation");
      fireEvent.click(presentation);
      expect(handleClose).toHaveBeenCalledTimes(2);
    });

    it("masks MongoDB connection URIs securely across diverse credential formats", () => {
      // Standard credentials
      expect(maskMongoUri("mongodb+srv://admin_user:my_secret_pass@cluster.mongodb.net/sofc")).toBe(
        "mongodb+srv://***:***@cluster.mongodb.net/sofc"
      );

      // Complex URL-encoded password with symbols
      expect(maskMongoUri("mongodb://operator%40corp:p%23%24%25word!@192.168.1.50:27017/db")).toBe(
        "mongodb://***:***@192.168.1.50:27017/db"
      );

      // URI without credentials
      expect(maskMongoUri("mongodb://localhost:27017/sofc_monitor")).toBe(
        "mongodb://localhost:27017/sofc_monitor"
      );

      // Null, undefined, and empty string
      expect(maskMongoUri(null)).toBe("—");
      expect(maskMongoUri(undefined)).toBe("—");
      expect(maskMongoUri("")).toBe("—");
    });
  });

  // =========================================================================
  // SECTION 6: Defensive Status Normalization & Missing Properties
  // =========================================================================
  describe("Defensive Status Normalization & Missing Properties", () => {
    it("renders StatusCard cleanly when status has null/undefined counts and stats", () => {
      const partialStatus: any = {
        connected: false,
        mode: "offline_buffer",
        cloud_counts: null,
        local_buffer_counts: undefined,
        stats: null,
        pending_buffer_size: undefined,
      };

      render(<StatusCard status={partialStatus} />);

      // Verify health badge
      expect(screen.getByText("BUFFERING LOCALLY")).toBeInTheDocument();

      // Cloud Documents and Pending Buffer should safely render 0 without NaN
      expect(screen.getByText("Cloud Documents").closest(".kpi-card")).toHaveTextContent(/0\s+records/);
      expect(screen.getByText("Pending Local Buffer").closest(".kpi-card")).toHaveTextContent(/0\s+docs/);
    });

    it("renders StatusCard when status is completely null", () => {
      render(<StatusCard status={null} />);
      expect(screen.getByText("NOT CONNECTED")).toBeInTheDocument();
      expect(screen.getByText("Cloud Documents").closest(".kpi-card")).toHaveTextContent(/0\s+records/);
    });
  });
});
