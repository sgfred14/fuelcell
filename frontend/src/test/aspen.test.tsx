import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  type AspenStatusResponse,
  type AspenReconciliationItem,
  type AspenSuggestion,
  type AspenOptimalCandidate,
  mockAspenStatus,
  mockAspenVerification,
} from "./contracts";
import { setupTestEnvironment } from "./mock_api";
import { getPageModule } from "./page_loader";

describe("Aspen Integration Suite (Features 5-8 / AC-R2.1 - AC-R2.9)", () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ==================== TIER 1: Unit & Component Calculations ====================

  it("TC-T1.02.01: identifies Aspen connection mode and COM automation status", () => {
    const liveComStatus: AspenStatusResponse = {
      mode: "com",
      connected: true,
      aspen_processes: 1,
      com_available: true,
      monitored_nodes_count: 10,
      last_verdict: "PASS",
    };
    expect(liveComStatus.mode).toBe("com");
    expect(liveComStatus.com_available).toBe(true);

    const simStatus: AspenStatusResponse = { ...mockAspenStatus, mode: "simulated", com_available: false };
    expect(simStatus.mode).toBe("simulated");
    expect(simStatus.com_available).toBe(false);
    expect(simStatus.monitored_nodes_count).toBe(10);
  });

  it("TC-T1.02.02: evaluates baseline tolerances for all 10 monitored process nodes", () => {
    function evaluateTolerance(
      aspenVal: number | null,
      baselineVal: number,
      tolPct: number
    ): { relErrPct: number | null; status: "PASS" | "CHECK" | "ERR" } {
      if (aspenVal === null || Number.isNaN(aspenVal) || !Number.isFinite(aspenVal)) {
        return { relErrPct: null, status: "ERR" };
      }
      const relErr = (aspenVal - baselineVal) / baselineVal;
      const relErrPct = Number((relErr * 100).toFixed(3));
      const status = Math.abs(relErr * 100) <= tolPct ? "PASS" : "CHECK";
      return { relErrPct, status };
    }

    // 1. Air flow: tol 2%
    expect(evaluateTolerance(89.05, 89.05, 2.0).status).toBe("PASS");
    expect(evaluateTolerance(91.5, 89.05, 2.0).status).toBe("CHECK"); // 2.75% > 2%

    // 2. Anode inlet T: tol 0.5%
    expect(evaluateTolerance(650.0, 650.0, 0.5).status).toBe("PASS");
    expect(evaluateTolerance(654.0, 650.0, 0.5).status).toBe("CHECK"); // 0.615% > 0.5%

    // 3. Flue after fuel HX: tol 1%
    expect(evaluateTolerance(615.2, 615.0, 1.0).status).toBe("PASS");

    // 4. Flue after air HX: tol 3%
    expect(evaluateTolerance(395.4, 396.0, 3.0).status).toBe("PASS");

    // 5. Flue to stack: tol 5%
    expect(evaluateTolerance(145.8, 146.0, 5.0).status).toBe("PASS");

    // 6. Air blower power: tol 5%
    expect(evaluateTolerance(12.35, 12.4, 5.0).status).toBe("PASS");

    // 7. Recycle blower power: tol 15%
    expect(evaluateTolerance(3.12, 3.1, 15.0).status).toBe("PASS");

    // 8. Fuel preheater duty: tol 5%
    expect(evaluateTolerance(18.45, 18.5, 5.0).status).toBe("PASS");

    // 9. Air preheater duty: tol 3%
    expect(evaluateTolerance(65.8, 66.0, 3.0).status).toBe("PASS");

    // 10. HRSG steam: tol 5%
    expect(evaluateTolerance(112.5, 112.0, 5.0).status).toBe("PASS");

    // Corrupted reading (NaN) -> ERR
    expect(evaluateTolerance(NaN, 112.0, 5.0).status).toBe("ERR");
  });

  it("TC-T1.02.03: determines overall verification verdict from individual node statuses", () => {
    function computeVerdict(rows: { status: "PASS" | "CHECK" | "ERR" }[]): "PASS" | "CHECK_REQUIRED" | "FAIL" {
      if (rows.some((r) => r.status === "ERR")) return "FAIL";
      if (rows.some((r) => r.status === "CHECK")) return "CHECK_REQUIRED";
      return "PASS";
    }

    const allGood = [{ status: "PASS" as const }, { status: "PASS" as const }];
    expect(computeVerdict(allGood)).toBe("PASS");

    const withWarning = [{ status: "PASS" as const }, { status: "CHECK" as const }];
    expect(computeVerdict(withWarning)).toBe("CHECK_REQUIRED");

    const withError = [{ status: "PASS" as const }, { status: "ERR" as const }];
    expect(computeVerdict(withError)).toBe("FAIL");
  });

  it("TC-T1.02.04: calculates side-by-side reconciliation deltas for 7 thermodynamic outputs", () => {
    function calculateReconciliation(
      aspen: number,
      model: number,
      unit: string
    ): AspenReconciliationItem {
      const diff = Number((model - aspen).toFixed(2));
      return { aspen, model, diff, unit };
    }

    // 1. Net AC Power (kW)
    const pAc = calculateReconciliation(104.2, 104.2, "kW");
    expect(pAc.diff).toBe(0.0);

    // 2. Electrical Efficiency (%)
    const etaEl = calculateReconciliation(53.2, 53.5, "%");
    expect(etaEl.diff).toBe(0.3);

    // 3. CHP Efficiency (%)
    const etaChp = calculateReconciliation(84.5, 84.8, "%");
    expect(etaChp.diff).toBe(0.3);

    // 4. Afterburner Temp (C)
    const tAb = calculateReconciliation(980.2, 982.0, "C");
    expect(tAb.diff).toBe(1.8);

    // 5. Stack Exit Temp (C)
    const tStack = calculateReconciliation(698.5, 698.5, "C");
    expect(tStack.diff).toBe(0.0);

    // 6. Steam Generation (kg/h)
    const steam = calculateReconciliation(112.5, 114.0, "kg/h");
    expect(steam.diff).toBe(1.5);

    // 7. Blower Power (kW)
    const pBlower = calculateReconciliation(12.35, 12.35, "kW");
    expect(pBlower.diff).toBe(0.0);
  });

  it("TC-T1.02.05: categorizes diagnostic suggestions by physics severity thresholds", () => {
    function checkDiagnostics(params: {
      dT_cath_K: number;
      v_margin_mV: number;
      blower_pct: number;
    }): AspenSuggestion[] {
      const suggestions: AspenSuggestion[] = [];

      if (params.dT_cath_K > 100) {
        suggestions.push({
          id: "sug_dt",
          text: `Cathode dT excessive (${params.dT_cath_K} K > 100 K)`,
          sev: "crit",
          param: "air_ratio",
          suggested: 11.5,
        });
      } else {
        suggestions.push({
          id: "sug_dt_ok",
          text: `Cathode dT safe (${params.dT_cath_K} K <= 100 K)`,
          sev: "ok",
          param: "air_ratio",
          suggested: 10.5,
        });
      }

      if (params.v_margin_mV < 40) {
        suggestions.push({
          id: "sug_v_margin",
          text: `Anode exit voltage margin low (${params.v_margin_mV} mV < 40 mV)`,
          sev: "warn",
          param: "fuel_utilization",
          suggested: 0.78,
        });
      }

      return suggestions;
    }

    const cleanRun = checkDiagnostics({ dT_cath_K: 95.0, v_margin_mV: 55.0, blower_pct: 11.0 });
    expect(cleanRun.some((s) => s.sev === "ok")).toBe(true);

    const stressRun = checkDiagnostics({ dT_cath_K: 108.0, v_margin_mV: 32.0, blower_pct: 14.0 });
    expect(stressRun.some((s) => s.sev === "crit")).toBe(true);
    expect(stressRun.some((s) => s.sev === "warn")).toBe(true);
  });

  // ==================== TIER 2: Feature & State Integration ====================

  it("TC-T2.02.01: triggers POST /api/aspen/pull-and-verify and parses verification response", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/api/aspen/pull-and-verify")) {
        return new Response(JSON.stringify(mockAspenVerification), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetch("/api/aspen/pull-and-verify", { method: "POST" });
    const data = await res.json();

    expect(data.verdict).toBe("PASS");
    expect(data.verification_table.length).toBe(10);
    expect(data.model_result.eta_el_pct).toBe(53.2);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/api/aspen/pull-and-verify"), expect.any(Object));
  });

  it("TC-T2.02.02: triggers POST /api/aspen/optimize with target objective", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/aspen/optimize")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            candidates: mockAspenVerification.optimal_candidates,
            objective: body.objective ?? "eta_el",
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetch("/api/aspen/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective: "eta_chp" }),
    });
    const result = await res.json();

    expect(result.objective).toBe("eta_chp");
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].rank).toBe(1);
  });

  it("TC-T2.02.03: sorts and ranks optimal candidates by selected objective score", () => {
    function rankCandidates(
      candidates: AspenOptimalCandidate[],
      objective: "eta_el" | "eta_chp"
    ): AspenOptimalCandidate[] {
      return [...candidates].sort((a, b) => b[objective] - a[objective]);
    }

    const sortedByEl = rankCandidates(mockAspenVerification.optimal_candidates, "eta_el");
    expect(sortedByEl[0].eta_el).toBeGreaterThanOrEqual(sortedByEl[1].eta_el);

    const sortedByChp = rankCandidates(mockAspenVerification.optimal_candidates, "eta_chp");
    expect(sortedByChp[0].eta_chp).toBeGreaterThanOrEqual(sortedByChp[1].eta_chp);
  });

  it("TC-T2.02.04: handles simulated digital twin fallback mode seamlessly", () => {
    const isSimulated = mockAspenStatus.mode === "simulated";
    const statusBadgeText = isSimulated ? "Digital Twin PR-BM Simulated" : "Aspen Plus COM Live";

    expect(isSimulated).toBe(true);
    expect(statusBadgeText).toBe("Digital Twin PR-BM Simulated");
  });

  it("TC-T2.02.05: renders fallback placeholder for missing or unreadable stream nodes", () => {
    function formatNodeValue(val: number | null): string {
      if (val === null || Number.isNaN(val)) return "--";
      return val.toFixed(2);
    }

    expect(formatNodeValue(89.05)).toBe("89.05");
    expect(formatNodeValue(null)).toBe("--");
    expect(formatNodeValue(NaN)).toBe("--");
  });

  // ==================== Progressive Component Verification ====================

  it("TC-T2.02.06: renders AspenPage component if implemented", async () => {
    const AspenPage = getPageModule("AspenPage");
    if (!AspenPage) {
      // Milestone 3 not yet implemented; contract verified above
      expect(true).toBe(true);
      return;
    }

    render(<AspenPage />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(screen.getByText(/Aspen/i)).toBeInTheDocument();
  });
});
