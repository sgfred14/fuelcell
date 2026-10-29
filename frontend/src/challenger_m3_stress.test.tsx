import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import AspenPage from "./pages/AspenPage";
import { StatusCard } from "./components/aspen/StatusCard";
import { ToleranceTable, formatNodeValue } from "./components/aspen/ToleranceTable";
import { ReconciliationCard } from "./components/aspen/ReconciliationCard";
import { SuggestionList } from "./components/aspen/SuggestionList";
import { OptimizerPanel } from "./components/aspen/OptimizerPanel";
import type {
  AspenVerificationRow,
  AspenOptimalCandidate,
  AspenSuggestion,
  AspenStatusResponse,
} from "./types";
import { mockAspenStatus, mockAspenVerification } from "./test/contracts";

describe("Milestone 3 Adversarial & Empirical Stress Suite (Aspen Integration View)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);

      if (u.includes("/api/aspen/status")) {
        return new Response(JSON.stringify(mockAspenStatus), { status: 200 });
      }
      if (u.includes("/api/aspen/pull-and-verify")) {
        return new Response(JSON.stringify(mockAspenVerification), { status: 200 });
      }
      if (u.includes("/api/aspen/optimize")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        const obj = body.objective ?? "eta_el";
        return new Response(
          JSON.stringify({
            candidates: mockAspenVerification.optimal_candidates,
            objective: obj,
          }),
          { status: 200 }
        );
      }
      if (u.includes("/api/aspen/connect")) {
        return new Response(
          JSON.stringify({
            ...mockAspenStatus,
            connected: true,
            mode: "com",
            aspen_processes: ["AspenPlus.exe"],
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
  });

  // ==========================================================================
  // SECTION 1: Missing, Corrupted, and NaN Node Readings & Formatting
  // ==========================================================================

  describe("1. Missing, Corrupted, or NaN Node Readings Handling", () => {
    it("empirically verifies formatNodeValue handles all corrupted, nullish, and non-finite floats gracefully", () => {
      expect(formatNodeValue(NaN)).toBe("--");
      expect(formatNodeValue(null)).toBe("--");
      expect(formatNodeValue(undefined)).toBe("--");
      expect(formatNodeValue(Infinity)).toBe("--");
      expect(formatNodeValue(-Infinity)).toBe("--");
      expect(formatNodeValue(0)).toBe("0.00");
      expect(formatNodeValue(89.054)).toBe("89.05");
      expect(formatNodeValue(112.5)).toBe("112.50");
    });

    it("renders corrupted readings with '--' placeholder and 'ERR' badge without crashing table", () => {
      const corruptedRows: AspenVerificationRow[] = [
        {
          item: "Air to blower (kmol/h)",
          node_path: "\\Data\\Streams\\AIR-AMB\\Output\\MOLEFLMX\\MIXED",
          aspen_value: NaN,
          baseline_value: 89.05,
          rel_err_pct: null,
          tol_pct: 2.0,
          status: "ERR",
        },
        {
          item: "Anode inlet T (C)",
          node_path: "\\Data\\Streams\\ANODE-IN\\Output\\TEMP_OUT\\MIXED",
          aspen_value: null,
          baseline_value: 650.0,
          rel_err_pct: NaN,
          tol_pct: 0.5,
          status: "ERR",
        },
        {
          item: "Flue to stack (C)",
          node_path: "\\Data\\Streams\\FLUE-OUT\\Output\\TEMP_OUT\\MIXED",
          aspen_value: 145.8,
          baseline_value: 146.0,
          rel_err_pct: -0.137,
          tol_pct: 5.0,
          status: "OK",
        },
      ];

      render(
        <ToleranceTable
          rows={corruptedRows}
          verdict="FAIL"
          checksPassed={1}
          checksWarning={0}
          checksError={2}
        />
      );

      // Verify overall verdict banner reflects FAIL
      expect(screen.getByText(/OVERALL: FAIL/i)).toBeInTheDocument();

      // Verify the NaN and null nodes rendered "--"
      const dashes = screen.getAllByText("--");
      expect(dashes.length).toBeGreaterThanOrEqual(2);

      // Verify error badges
      const errBadges = screen.getAllByText("ERR");
      // 1 in pill counter + 2 in row status badges = at least 3
      expect(errBadges.length).toBeGreaterThanOrEqual(3);

      // Verify valid row is rendered
      expect(screen.getByText("Flue to stack (C)")).toBeInTheDocument();
      expect(screen.getByText("145.80")).toBeInTheDocument();
      expect(screen.getByText("-0.14%")).toBeInTheDocument();
    });

    it("handles total sensor blackouts gracefully (all 10 nodes corrupted)", () => {
      const blackoutRows: AspenVerificationRow[] = Array.from({ length: 10 }, (_, i) => ({
        item: `Process Sensor ${i + 1}`,
        node_path: `\\Data\\Node\\${i + 1}`,
        aspen_value: null,
        baseline_value: 100 + i,
        rel_err_pct: null,
        tol_pct: 2.0,
        status: "ERR",
      }));

      render(
        <ToleranceTable
          rows={blackoutRows}
          verdict="FAIL"
          checksPassed={0}
          checksWarning={0}
          checksError={10}
        />
      );

      expect(screen.getByText("10 ERR")).toBeInTheDocument();
      expect(screen.getByText(/OVERALL: FAIL/i)).toBeInTheDocument();
      const errStatusCells = screen.getAllByText("ERR");
      expect(errStatusCells.length).toBe(11); // 1 pill + 10 rows
    });
  });

  // ==========================================================================
  // SECTION 2: Out-of-Tolerance Values & Verdict Cascading
  // ==========================================================================

  describe("2. Out-of-Tolerance Values & Verdict Cascading", () => {
    it("renders CHECK status and triggers overall CHECK_REQUIRED verdict when warnings occur without errors", () => {
      const warningRows: AspenVerificationRow[] = [
        {
          item: "Air to blower (kmol/h)",
          node_path: "\\Data\\Streams\\AIR-AMB\\Output\\MOLEFLMX\\MIXED",
          aspen_value: 91.5,
          baseline_value: 89.05,
          rel_err_pct: 2.75,
          tol_pct: 2.0, // 2.75% > 2.0% => CHECK
          status: "CHECK",
        },
        {
          item: "Anode inlet T (C)",
          node_path: "\\Data\\Streams\\ANODE-IN\\Output\\TEMP_OUT\\MIXED",
          aspen_value: 650.0,
          baseline_value: 650.0,
          rel_err_pct: 0.0,
          tol_pct: 0.5,
          status: "OK",
        },
      ];

      render(
        <ToleranceTable
          rows={warningRows}
          verdict="CHECK_REQUIRED"
          checksPassed={1}
          checksWarning={1}
          checksError={0}
        />
      );

      expect(screen.getByText(/OVERALL: CHECK REQUIRED/i)).toBeInTheDocument();
      expect(screen.getByText("1 CHECK")).toBeInTheDocument();
      expect(screen.getByText("+2.75%")).toBeInTheDocument();

      // Check badge in row
      const checkBadges = screen.getAllByText("CHECK");
      expect(checkBadges.length).toBeGreaterThanOrEqual(1);
    });

    it("verifies StatusCard displays CHECK REQUIRED badge and warning styling correctly", () => {
      render(
        <StatusCard
          status={{
            ...mockAspenStatus,
            model_path: null,
            progid: "Apwn.Document",
            last_verified_at: null,
            aspen_processes: [],
            last_verdict: "CHECK_REQUIRED",
          } as AspenStatusResponse}
          lastVerdict="CHECK_REQUIRED"
          checksPassed={9}
          checksWarning={1}
          checksError={0}
        />
      );

      expect(screen.getByText("CHECK REQUIRED")).toBeInTheDocument();
      expect(screen.getByText("Digital Twin PR-BM Simulated")).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // SECTION 3: Severe Violations & Precedence of FAIL Verdict
  // ==========================================================================

  describe("3. Severe Violations & Precedence of FAIL Verdict", () => {
    it("ensures ERR takes strict precedence over CHECK yielding overall FAIL", () => {
      const mixedRows: AspenVerificationRow[] = [
        {
          item: "Air to blower (kmol/h)",
          node_path: "\\Data\\Streams\\AIR-AMB\\Output\\MOLEFLMX\\MIXED",
          aspen_value: 92.0,
          baseline_value: 89.05,
          rel_err_pct: 3.31,
          tol_pct: 2.0,
          status: "CHECK",
        },
        {
          item: "Anode inlet T (C)",
          node_path: "\\Data\\Streams\\ANODE-IN\\Output\\TEMP_OUT\\MIXED",
          aspen_value: NaN,
          baseline_value: 650.0,
          rel_err_pct: null,
          tol_pct: 0.5,
          status: "ERR",
        },
        {
          item: "Flue to stack (C)",
          node_path: "\\Data\\Streams\\FLUE-OUT\\Output\\TEMP_OUT\\MIXED",
          aspen_value: 145.8,
          baseline_value: 146.0,
          rel_err_pct: -0.137,
          tol_pct: 5.0,
          status: "OK",
        },
      ];

      render(
        <ToleranceTable
          rows={mixedRows}
          verdict="FAIL"
          checksPassed={1}
          checksWarning={1}
          checksError={1}
        />
      );

      expect(screen.getByText(/OVERALL: FAIL/i)).toBeInTheDocument();
      expect(screen.getByText("1 PASS")).toBeInTheDocument();
      expect(screen.getByText("1 CHECK")).toBeInTheDocument();
      expect(screen.getByText("1 ERR")).toBeInTheDocument();
    });

    it("verifies StatusCard displays FAIL badge and alarm indicators under severe errors", () => {
      render(
        <StatusCard
          status={{
            ...mockAspenStatus,
            model_path: null,
            progid: "Apwn.Document",
            last_verified_at: null,
            aspen_processes: [],
            last_verdict: "FAIL",
            connected: false,
            mode: "com",
          } as AspenStatusResponse}
          lastVerdict="FAIL"
          checksPassed={0}
          checksWarning={0}
          checksError={10}
        />
      );

      expect(screen.getByText("COM Disconnected")).toBeInTheDocument();
      expect(screen.getByText("FAIL")).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // SECTION 4: Dual-Key Reconciliation Schema Compatibility
  // ==========================================================================

  describe("4. Dual-Key Reconciliation Schema Compatibility", () => {
    it("handles contract schema using 'diff' and 'p_ac_kw' keys", () => {
      const contractComparison = {
        p_ac_kw: { aspen: 104.2, model: 104.2, diff: 0.0, unit: "kW" },
        eta_el: { aspen: 53.2, model: 53.5, diff: 0.3, unit: "%" },
        eta_chp: { aspen: 84.5, model: 84.8, diff: 0.3, unit: "%" },
        t_ab: { aspen: 980.2, model: 982.0, diff: 1.8, unit: "°C" },
        t_stack: { aspen: 698.5, model: 698.5, diff: 0.0, unit: "°C" },
        steam: { aspen: 112.5, model: 114.0, diff: 1.5, unit: "kg/h" },
        p_bl: { aspen: 12.35, model: 12.35, diff: 0.0, unit: "kW" },
      };

      render(<ReconciliationCard comparison={contractComparison} />);

      expect(screen.getByText("Net AC Power")).toBeInTheDocument();
      // Both Aspen and Model values are 104.20 kW
      const kwCells = screen.getAllByText("104.20 kW");
      expect(kwCells.length).toBe(2);
      expect(screen.getAllByText("+0.30 %").length).toBe(2);
      expect(screen.getByText("+1.80 °C")).toBeInTheDocument();
      expect(screen.getByText("7 / 7 Reconciled")).toBeInTheDocument();
    });

    it("handles backend schema using 'delta' and 'net_power_ac_kw' keys", () => {
      const backendComparison = {
        net_power_ac_kw: { aspen: 104.2, model: 104.6, delta: 0.4, unit: "kW" },
        electrical_efficiency_pct: { aspen: 53.2, model: 53.7, delta: 0.5, unit: "%" },
        chp_efficiency_pct: { aspen: 84.5, model: 84.9, delta: 0.4, unit: "%" },
        afterburner_temp_C: { aspen: 980.2, model: 982.5, delta: 2.3, unit: "°C" },
        stack_exit_temp_C: { aspen: 698.5, model: 698.0, delta: -0.5, unit: "°C" },
        steam_production_kgh: { aspen: 112.5, model: 115.0, delta: 2.5, unit: "kg/h" },
        blower_power_kw: { aspen: 12.35, model: 12.55, delta: 0.2, unit: "kW" },
      };

      render(<ReconciliationCard comparison={backendComparison} />);

      expect(screen.getByText("Net AC Power")).toBeInTheDocument();
      expect(screen.getByText("+0.40 kW")).toBeInTheDocument();
      expect(screen.getByText("Electrical Efficiency")).toBeInTheDocument();
      expect(screen.getByText("+0.50 %")).toBeInTheDocument();
      expect(screen.getByText("-0.50 °C")).toBeInTheDocument();
    });

    it("gracefully falls back to PR-BM baseline defaults when comparison data is null or empty", () => {
      render(<ReconciliationCard comparison={null} />);

      expect(screen.getByText("Net AC Power")).toBeInTheDocument();
      expect(screen.getByText("Electrical Efficiency")).toBeInTheDocument();
      expect(screen.getByText("CHP Efficiency")).toBeInTheDocument();
      expect(screen.getByText("Afterburner Flame Temp")).toBeInTheDocument();
      expect(screen.getByText("Stack Exit Temp")).toBeInTheDocument();
      expect(screen.getByText("Steam Generation")).toBeInTheDocument();
      expect(screen.getByText("Air Blower Power")).toBeInTheDocument();
      expect(screen.getByText("7 / 7 Reconciled")).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // SECTION 5: Optimizer Objective Switching & Candidate Ranking Table
  // ==========================================================================

  describe("5. Optimizer Objective Switching & Candidate Table Rendering", () => {
    const testCandidates: AspenOptimalCandidate[] = [
      {
        score: 54.0,
        eta_el: 54.0,
        eta_chp: 88.5, // Best CHP
        v_cell: 0.76,
        uf: 0.85,
        p_blower: 12.1,
        j: 0.42,
        h2_flow: 6.1,
        steam_flow: 125.0,
        parasitic_pct: 12.0,
        cell_count: 750,
      } as unknown as AspenOptimalCandidate,
      {
        score: 56.5,
        eta_el: 56.5, // Best Electrical
        eta_chp: 82.0,
        v_cell: 0.80,
        uf: 0.78,
        p_blower: 10.5,
        j: 0.32,
        h2_flow: 5.4,
        steam_flow: 110.0,
        parasitic_pct: 10.2,
        cell_count: 710,
      } as unknown as AspenOptimalCandidate,
    ];

    it("sorts descending by eta_el and awards #1 badge to candidate with highest electrical efficiency", () => {
      const onSelect = vi.fn();
      const onRun = vi.fn();

      render(
        <OptimizerPanel
          candidates={testCandidates}
          currentObjective="eta_el"
          onSelectObjective={onSelect}
          onRunOptimization={onRun}
        />
      );

      // Verify Electrical button is marked active
      const elButton = screen.getByRole("button", { name: /Electrical Efficiency/i });
      expect(elButton).toHaveAttribute("aria-pressed", "true");

      // Verify Rank #1 is the candidate with eta_el = 56.5%
      const rows = screen.getAllByRole("row");
      // Header row + 2 data rows
      expect(rows.length).toBe(3);

      const topRow = rows[1];
      expect(topRow).toHaveTextContent("#1");
      expect(topRow).toHaveTextContent("56.5%");
      expect(topRow).toHaveTextContent("0.80 V");
    });

    it("sorts descending by eta_chp when switching to CHP objective and awards #1 badge accordingly", () => {
      const onSelect = vi.fn();
      const onRun = vi.fn();

      const { rerender } = render(
        <OptimizerPanel
          candidates={testCandidates}
          currentObjective="eta_el"
          onSelectObjective={onSelect}
          onRunOptimization={onRun}
        />
      );

      // Click CHP button
      const chpButton = screen.getByRole("button", { name: /CHP Total Efficiency/i });
      fireEvent.click(chpButton);

      expect(onSelect).toHaveBeenCalledWith("eta_chp");
      expect(onRun).toHaveBeenCalledWith(
        expect.objectContaining({ objective: "eta_chp" })
      );

      // Re-render with active objective = "eta_chp"
      rerender(
        <OptimizerPanel
          candidates={testCandidates}
          currentObjective="eta_chp"
          onSelectObjective={onSelect}
          onRunOptimization={onRun}
        />
      );

      const rows = screen.getAllByRole("row");
      const topRow = rows[1];
      // In CHP mode, the candidate with 88.5% must be #1
      expect(topRow).toHaveTextContent("#1");
      expect(topRow).toHaveTextContent("88.5%");
      expect(topRow).toHaveTextContent("0.76 V");
    });

    it("renders empty state placeholder gracefully when candidates list is empty", () => {
      render(
        <OptimizerPanel
          candidates={[]}
          currentObjective="eta_el"
          onSelectObjective={vi.fn()}
          onRunOptimization={vi.fn()}
        />
      );

      expect(
        screen.getByText(/No optimization candidates calculated/i)
      ).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // SECTION 6: Diagnostic Suggestions & Parameter Fix Action Triggers
  // ==========================================================================

  describe("6. Diagnostic Suggestions & Parameter Fix Execution", () => {
    it("renders physics constraint suggestions with appropriate severity badges and fix buttons", () => {
      const suggestions: AspenSuggestion[] = [
        {
          id: "sug_01",
          msg: "Cathode dT excessive (108 K > 100 K)",
          sev: "crit",
          fix: { air_ratio: 11.5 },
        } as unknown as AspenSuggestion,
        {
          id: "sug_02",
          msg: "Anode exit voltage margin low (32 mV < 40 mV)",
          sev: "warn",
          fix: { fuel_utilization: 0.78 },
        } as unknown as AspenSuggestion,
        {
          id: "sug_03",
          msg: "Thermal gradient within safe limits",
          sev: "ok",
          fix: null,
        } as unknown as AspenSuggestion,
      ];

      const applyMock = vi.fn();

      render(<SuggestionList suggestions={suggestions} onApplyFix={applyMock} />);

      expect(screen.getByText("CRITICAL LIMIT")).toBeInTheDocument();
      expect(screen.getByText(/Cathode dT excessive/i)).toBeInTheDocument();
      expect(screen.getByText("WARNING")).toBeInTheDocument();
      expect(screen.getByText(/Anode exit voltage margin low/i)).toBeInTheDocument();
      expect(screen.getByText("NOMINAL (OK)")).toBeInTheDocument();

      // Trigger fix button
      const fixBtn = screen.getByRole("button", { name: /Apply Fix \(air_ratio = 11.5\)/i });
      fireEvent.click(fixBtn);
      expect(applyMock).toHaveBeenCalledWith({ air_ratio: 11.5 });
    });

    it("renders empty placeholder when suggestions list is empty or null", () => {
      render(<SuggestionList suggestions={[]} />);
      expect(
        screen.getByText(/No diagnostic suggestions generated yet/i)
      ).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // SECTION 7: Search and Filter Ergonomics in ToleranceTable
  // ==========================================================================

  describe("7. Search & Filter Ergonomics in Baseline Tolerance Table", () => {
    const sampleRows: AspenVerificationRow[] = [
      {
        item: "Air to blower (kmol/h)",
        node_path: "\\Data\\Streams\\AIR-AMB\\Output\\MOLEFLMX\\MIXED",
        aspen_value: 89.05,
        baseline_value: 89.05,
        rel_err_pct: 0.0,
        tol_pct: 2.0,
        status: "OK",
      },
      {
        item: "Anode inlet T (C)",
        node_path: "\\Data\\Streams\\ANODE-IN\\Output\\TEMP_OUT\\MIXED",
        aspen_value: 654.0,
        baseline_value: 650.0,
        rel_err_pct: 0.615,
        tol_pct: 0.5,
        status: "CHECK",
      },
      {
        item: "HRSG steam (kg/h)",
        node_path: "\\Data\\Streams\\STEAM\\Output\\MASSFLMX\\MIXED",
        aspen_value: NaN,
        baseline_value: 112.0,
        rel_err_pct: null,
        tol_pct: 5.0,
        status: "ERR",
      },
    ];

    it("filters rows by text query across item name and node path", () => {
      render(<ToleranceTable rows={sampleRows} />);

      const searchInput = screen.getByPlaceholderText(/Search parameter or node path/i);

      // Search for "steam"
      fireEvent.change(searchInput, { target: { value: "steam" } });
      expect(screen.getByText("HRSG steam (kg/h)")).toBeInTheDocument();
      expect(screen.queryByText("Air to blower (kmol/h)")).not.toBeInTheDocument();

      // Search for node path "ANODE-IN"
      fireEvent.change(searchInput, { target: { value: "ANODE-IN" } });
      expect(screen.getByText("Anode inlet T (C)")).toBeInTheDocument();
      expect(screen.queryByText("HRSG steam (kg/h)")).not.toBeInTheDocument();
    });

    it("filters rows by status pills: ERR, CHECK, PASS, and restores with ALL", () => {
      render(<ToleranceTable rows={sampleRows} />);

      // Filter by ERR
      fireEvent.click(screen.getByRole("button", { name: "ERR" }));
      expect(screen.getByText("HRSG steam (kg/h)")).toBeInTheDocument();
      expect(screen.queryByText("Air to blower (kmol/h)")).not.toBeInTheDocument();
      expect(screen.queryByText("Anode inlet T (C)")).not.toBeInTheDocument();

      // Filter by CHECK
      fireEvent.click(screen.getByRole("button", { name: "CHECK" }));
      expect(screen.getByText("Anode inlet T (C)")).toBeInTheDocument();
      expect(screen.queryByText("HRSG steam (kg/h)")).not.toBeInTheDocument();

      // Filter by PASS
      fireEvent.click(screen.getByRole("button", { name: "PASS" }));
      expect(screen.getByText("Air to blower (kmol/h)")).toBeInTheDocument();
      expect(screen.queryByText("Anode inlet T (C)")).not.toBeInTheDocument();

      // Restore ALL
      fireEvent.click(screen.getByRole("button", { name: "ALL" }));
      expect(screen.getByText("Air to blower (kmol/h)")).toBeInTheDocument();
      expect(screen.getByText("Anode inlet T (C)")).toBeInTheDocument();
      expect(screen.getByText("HRSG steam (kg/h)")).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // SECTION 8: Full End-to-End AspenPage Integration & State Machine
  // ==========================================================================

  describe("8. Full End-to-End AspenPage Lifecycle & Network Fault Tolerance", () => {
    it("renders AspenPage, executes initial parallel requests, and populates subcomponents", async () => {
      await act(async () => {
        render(<AspenPage />);
      });

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /Aspen Plus Integration & Reconciliation/i })).toBeInTheDocument();
      });

      // Verify StatusCard rendered
      expect(screen.getByText(/Connector Mode/i)).toBeInTheDocument();
      expect(screen.getByText(/Digital Twin PR-BM Simulated/i)).toBeInTheDocument();

      // Verify Tolerance Table rendered
      expect(screen.getByRole("heading", { name: /Baseline Tolerance Verification/i })).toBeInTheDocument();

      // Verify Side-by-Side Reconciliation rendered
      expect(screen.getByRole("heading", { name: /Side-by-Side Model Reconciliation/i })).toBeInTheDocument();

      // Verify Diagnostic Suggestions rendered
      expect(screen.getByRole("heading", { name: /Diagnostic Operational Suggestions/i })).toBeInTheDocument();

      // Verify Multi-Parameter Optimizer rendered
      expect(screen.getByRole("heading", { name: /Multi-Parameter Grid Optimizer/i })).toBeInTheDocument();
    });

    it("triggers Pull & Verify process values without uncaught exceptions", async () => {
      await act(async () => {
        render(<AspenPage />);
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Pull & Verify Process Values/i })).toBeInTheDocument();
      });

      const pullButton = screen.getByRole("button", { name: /Pull & Verify Process Values/i });

      await act(async () => {
        fireEvent.click(pullButton);
      });

      await waitFor(() => {
        expect(screen.getByText(/Process values verified successfully/i)).toBeInTheDocument();
      });

      // Verify fetch was called with pull-and-verify endpoint
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/aspen/pull-and-verify"),
        expect.any(Object)
      );
    });

    it("triggers parameter fix action from SuggestionList and executes re-verification safely", async () => {
      await act(async () => {
        render(<AspenPage />);
      });

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /Diagnostic Operational Suggestions/i })).toBeInTheDocument();
      });

      // Look for any Apply Fix button in the page
      const fixButtons = screen.queryAllByRole("button", { name: /Apply Fix/i });
      if (fixButtons.length > 0) {
        await act(async () => {
          fireEvent.click(fixButtons[0]);
        });

        // Verify pull-and-verify was triggered with custom plant_params
        await waitFor(() => {
          expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining("/api/aspen/pull-and-verify"),
            expect.objectContaining({
              method: "POST",
            })
          );
        });
      }
    });

    it("survives catastrophic backend failure during action with visible error alert and retry button", async () => {
      await act(async () => {
        render(<AspenPage />);
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Pull & Verify Process Values/i })).toBeInTheDocument();
      });

      // Simulate a network failure during Pull & Verify action
      fetchMock.mockImplementationOnce(async (url: string) => {
        if (url.includes("/api/aspen/pull-and-verify")) {
          throw new Error("Aspen COM Server Timeout: 504 Gateway Timeout");
        }
        return new Response("{}", { status: 200 });
      });

      const pullButton = screen.getByRole("button", { name: /Pull & Verify Process Values/i });
      await act(async () => {
        fireEvent.click(pullButton);
      });

      // Confirm page remains mounted and renders error alert
      await waitFor(() => {
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Retry Connection/i })).toBeInTheDocument();
      });

      // Clicking Retry restores state
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/api/aspen/status")) {
          return new Response(JSON.stringify(mockAspenStatus), { status: 200 });
        }
        if (url.includes("/api/aspen/pull-and-verify")) {
          return new Response(JSON.stringify(mockAspenVerification), { status: 200 });
        }
        if (url.includes("/api/aspen/optimize")) {
          return new Response(JSON.stringify({ candidates: mockAspenVerification.optimal_candidates }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Retry Connection/i }));
      });

      await waitFor(() => {
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      });
    });

    it("opens and submits ConnectModal to switch from simulated to live COM mode", async () => {
      await act(async () => {
        render(<AspenPage />);
      });

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Aspen Connection Setup/i })).toBeInTheDocument();
      });

      // Click Aspen Connection Setup button
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Aspen Connection Setup/i }));
      });

      // Verify modal dialog appeared
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByText("Aspen Plus COM Connection Setup")).toBeInTheDocument();

      // Fill in model path
      const modelPathInput = screen.getByLabelText(/Aspen Plus Model File/i);
      fireEvent.change(modelPathInput, {
        target: { value: "C:\\AspenModels\\SOFC_Plant_Rev3.bkp" },
      });

      // Submit form
      const submitBtn = screen.getByRole("button", { name: /Connect to Aspen/i });
      await act(async () => {
        fireEvent.click(submitBtn);
      });

      // Modal closes
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Verify connect endpoint called with body
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/aspen/connect"),
        expect.objectContaining({
          body: JSON.stringify({
            model_path: "C:\\AspenModels\\SOFC_Plant_Rev3.bkp",
            progid: "Apwn.Document",
          }),
        })
      );
    });
  });
});
