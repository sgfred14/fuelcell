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
  constructor(public url: string) { FakeSocket.last = this; setTimeout(() => this.onopen?.(), 0); }
  send() {}
  close() { this.onclose?.(); }
  push(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

const fetchMock = vi.fn(async (url: string) => {
  if (url === "/api/config") return new Response(JSON.stringify(config), { status: 200 });
  if (url.includes("/ack")) return new Response(JSON.stringify({ id: 1, acknowledged: true }), { status: 200 });
  if (url === "/api/sim/start") return new Response(JSON.stringify({ detail: "x" }), { status: 409 });
  return new Response("{}", { status: 200 });
});

beforeEach(() => {
  FakeSocket.last = null;
  fetchMock.mockClear();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function mountWithSnapshot(snap: unknown = snapshot) {
  render(<App />);
  await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  await act(async () => { FakeSocket.last!.push(snap); });
}

describe("dashboard", () => {
  it("waits for data, then shows all six utilities and the alarm from the server", async () => {
    render(<App />);
    expect(screen.getByText(/Waiting for the first evaluated minute/i)).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    await act(async () => { FakeSocket.last!.push(snapshot); });

    for (const name of ["Hydrogen supply", "Cathode air and blower", "Stack cooling and temperatures", "Electrical and power conditioning", "Steam and water (HRSG)", "Differential pressure and safety"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(screen.getByText("1 alarm")).toBeInTheDocument();
    const alerts = screen.getByRole("region", { name: /alerts/i });
    expect(within(alerts).getByText(/Anode recycle vs expected below/)).toBeInTheDocument();
    expect(within(alerts).getByText("Alarm")).toBeInTheDocument();      // status is words as well as colour
    expect(screen.getByLabelText(/Differential pressure and safety: alarm/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Hydrogen supply: ok/)).toBeInTheDocument();
  });

  it("acknowledges an alert through the API", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => /\/api\/alerts\/\d+\/ack$/.test(u))).toBe(true);
  });

  it("shows the plant as normal when there are no alerts", async () => {
    await mountWithSnapshot({ ...snapshot, alerts: [], latest: { ...snapshot.latest, alerts: [], overall: "ok", utilities: Object.fromEntries(Object.keys(snapshot.latest.utilities).map((k) => [k, { status: "ok", instant: "ok" }])) } });
    expect(screen.getByText("All utilities normal")).toBeInTheDocument();
    expect(screen.getByText(/No active alerts/)).toBeInTheDocument();
  });

  it("switches the detail view when a utility is selected, listing its checks with limits", async () => {
    await mountWithSnapshot();
    fireEvent.click(screen.getAllByRole("button", { name: /Cathode air and blower/ })[0]);
    expect(screen.getByRole("heading", { name: /Cathode air and blower: checks and trends/ })).toBeInTheDocument();
    expect(screen.getAllByText("Blower power vs flow").length).toBeGreaterThanOrEqual(2);   // table row and chart title
    expect(screen.getByText("< -15 or > 10%")).toBeInTheDocument();                       // warning band
    expect(screen.getByText("< -30 or > 25%")).toBeInTheDocument();                       // alarm band
  });

  it("reports a lost server connection and that it is retrying", async () => {
    await mountWithSnapshot();
    await act(async () => { FakeSocket.last!.close(); });
    expect(screen.getByText(/Server unreachable, retrying/)).toBeInTheDocument();
  });

  it("surfaces a server error message instead of failing silently", async () => {
    await mountWithSnapshot({ ...snapshot, sim: { running: false, interval_s: 0.5, sim_time: null, fault: null, faults: {} } });
    fireEvent.click(screen.getByRole("button", { name: /Start demo/ }));
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(await screen.findByRole("alert")).toHaveTextContent("x");
  });
});
