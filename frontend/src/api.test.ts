import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api";

describe("API Client — Milestone 1 Contracts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const bodyStr = init?.body ? String(init.body) : "";
      if (url.includes("error-test-string") || bodyStr.includes("error-test-string")) {
        return new Response(JSON.stringify({ detail: "Validation failed" }), { status: 422, statusText: "Unprocessable Entity" });
      }
      if (url.includes("error-test-obj") || bodyStr.includes("error-test-obj")) {
        return new Response(JSON.stringify({ detail: [{ loc: ["query", "limit"], msg: "Invalid number" }] }), { status: 422, statusText: "Unprocessable Entity" });
      }
      if (url.includes("error-test-empty") || bodyStr.includes("error-test-empty")) {
        return new Response("Not Found", { status: 404, statusText: "Not Found" });
      }
      return new Response(JSON.stringify({ ok: true, url, init }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("Database Explorer Endpoints", () => {
    it("calls dbStatus via GET /api/db/status", async () => {
      await api.dbStatus();
      expect(fetchMock).toHaveBeenCalledWith("/api/db/status", undefined);
    });

    it("serializes dbTicks query parameters and drops undefined/null fields", async () => {
      await api.dbTicks({ start_ts: "2026-03-01T00:00:00Z", overall: "ok", limit: 50, skip: undefined });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain("/api/db/ticks?");
      expect(url).toContain("start_ts=2026-03-01T00%3A00%3A00Z");
      expect(url).toContain("overall=ok");
      expect(url).toContain("limit=50");
      expect(url).not.toContain("skip");
    });

    it("serializes dbAlerts query parameters cleanly", async () => {
      await api.dbAlerts({ status: "active", utility: "Hydrogen supply", limit: 25 });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/db/alerts?status=active&utility=Hydrogen+supply&limit=25");
    });

    it("serializes dbSimulations query parameters", async () => {
      await api.dbSimulations({ limit: 10, skip: 5 });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/db/simulations?limit=10&skip=5");
    });

    it("serializes dbCalculations query parameters", async () => {
      await api.dbCalculations({ calc_type: "polarization", limit: 20 });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/db/calculations?calc_type=polarization&limit=20");
    });

    it("triggers dbFlush via POST /api/db/flush", async () => {
      await api.dbFlush();
      expect(fetchMock).toHaveBeenCalledWith("/api/db/flush", expect.objectContaining({ method: "POST" }));
    });

    it("triggers dbReconnect with custom URI via POST /api/db/reconnect", async () => {
      await api.dbReconnect({ uri: "mongodb://cluster.example.com", db_name: "custom_db" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/db/reconnect");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ uri: "mongodb://cluster.example.com", db_name: "custom_db" });
    });
  });

  describe("Aspen Integration Endpoints", () => {
    it("calls aspenStatus via GET /api/aspen/status", async () => {
      await api.aspenStatus();
      expect(fetchMock).toHaveBeenCalledWith("/api/aspen/status", undefined);
    });

    it("calls aspenConnect via POST /api/aspen/connect", async () => {
      await api.aspenConnect({ model_path: "C:\\models\\sofc.bkp", progid: "Apwn.Document" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/aspen/connect");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ model_path: "C:\\models\\sofc.bkp", progid: "Apwn.Document" });
    });

    it("calls aspenPullAndVerify with default empty object", async () => {
      await api.aspenPullAndVerify();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/aspen/pull-and-verify");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({});
    });

    it("calls aspenPullAndVerify with custom parameters", async () => {
      await api.aspenPullAndVerify({ model_file: "test.bkp", custom_values: { "AIR-IN\\FLOW_KMOL_H": 90.0 } });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/aspen/pull-and-verify");
      expect(JSON.parse(init.body)).toEqual({ model_file: "test.bkp", custom_values: { "AIR-IN\\FLOW_KMOL_H": 90.0 } });
    });

    it("calls aspenOptimize with default objective eta_el when omitted", async () => {
      await api.aspenOptimize();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/aspen/optimize");
      expect(JSON.parse(init.body)).toEqual({ objective: "eta_el" });
    });

    it("calls aspenOptimize with custom objective", async () => {
      await api.aspenOptimize({ objective: "eta_chp" });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/aspen/optimize");
      expect(JSON.parse(init.body)).toEqual({ objective: "eta_chp" });
    });

    it("calls aspenHistory with query limit", async () => {
      await api.aspenHistory(15);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/aspen/history?limit=15");
    });
  });

  describe("AI Energy Management System (EMS) Endpoints", () => {
    it("calls emsStatus via GET /api/ems/status", async () => {
      await api.emsStatus();
      expect(fetchMock).toHaveBeenCalledWith("/api/ems/status", undefined);
    });

    it("serializes emsForecast query parameters", async () => {
      await api.emsForecast({ base_demand_kw: 120, h2_cost_usd_kg: 5.5 });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/ems/forecast?base_demand_kw=120&h2_cost_usd_kg=5.5");
    });

    it("calls emsOptimize with complete parameter payload", async () => {
      await api.emsOptimize({ base_demand_kw: 95, h2_cost_usd_kg: 4.2 });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/ems/optimize");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ base_demand_kw: 95, h2_cost_usd_kg: 4.2 });
    });

    it("calls emsRecommendations via GET /api/ems/recommendations", async () => {
      await api.emsRecommendations();
      expect(fetchMock).toHaveBeenCalledWith("/api/ems/recommendations", undefined);
    });

    it("calls emsHistory with query limit", async () => {
      await api.emsHistory(30);
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/ems/history?limit=30");
    });
  });

  describe("Error extraction and serialization", () => {
    it("extracts string detail message on HTTP error", async () => {
      await expect(api.dbReconnect({ uri: "/api/error-test-string" })).rejects.toThrow("Validation failed");
    });

    it("extracts object detail list on HTTP error", async () => {
      await expect(api.dbReconnect({ uri: "/api/error-test-obj" })).rejects.toThrow(
        JSON.stringify([{ loc: ["query", "limit"], msg: "Invalid number" }])
      );
    });

    it("falls back to status code and text when body is not JSON", async () => {
      await expect(api.dbReconnect({ uri: "/api/error-test-empty" })).rejects.toThrow("404 Not Found");
    });
  });
});
