import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useMonitorContext } from "../App";
import { fmt, fmtClock, fmtSci } from "../lib/format";
import type { Status } from "../types";

export default function AnomalyPage() {
  const { state, simFault, simClear, simStart } = useMonitorContext();
  const [customThreshold, setCustomThreshold] = useState<number | null>(null);

  const ae = state.latest?.ae;
  const info = state.info ?? state.config?.info;
  const defaultThr = ae?.threshold ?? info?.ae_threshold ?? 1.6;
  const effectiveThreshold = customThreshold ?? defaultThr;

  // Physics-informed residuals from latest checks
  const checks = state.latest?.checks ?? {};
  const residuals = useMemo(() => [
    {
      id: "h2_dev",
      name: "Hydrogen Supply Restriction (r_h2)",
      physics: "Measured H₂ flow vs Faraday current demand at 80% Uf",
      value: checks.h2_dev?.value ?? null,
      unit: "%",
      limit: "± 5.0 % (Warn) / ± 10.0 % (Alarm)",
      status: (checks.h2_dev?.status ?? "ok") as Status,
      description: "Direct indicator of H₂ feed restriction (pressure regulator, valve, or filter).",
    },
    {
      id: "h2_uf",
      name: "Fuel Utilization (r_uf)",
      physics: "Faraday H₂ consumption vs Injected H₂ stream",
      value: checks.h2_uf?.value ?? null,
      unit: "",
      limit: "0.75 – 0.85 (Warn) / 0.70 – 0.88 (Alarm)",
      status: (checks.h2_uf?.status ?? "ok") as Status,
      description: "Fuel starvation risk above 0.88 (Ni re-oxidation); over-dilution below 0.70.",
    },
    {
      id: "faraday_res",
      name: "Faraday Power Balance (r_far)",
      physics: "Stack DC power vs Current × Voltage × N_series",
      value: checks.faraday_res?.value ?? null,
      unit: "kW",
      limit: "± 1.5 kW (Warn) / ± 4.0 kW (Alarm)",
      status: (checks.faraday_res?.status ?? "ok") as Status,
      description: "Direct sensor & wiring consistency on the DC bus.",
    },
    {
      id: "balance_res",
      name: "Net AC Power Balance (r_net)",
      physics: "Net AC vs DC power × Inverter eff. − Parasitics",
      value: checks.balance_res?.value ?? null,
      unit: "kW",
      limit: "± 1.5 kW (Warn) / ± 4.0 kW (Alarm)",
      status: (checks.balance_res?.status ?? "ok") as Status,
      description: "Inverter degradation or unmeasured parasitic load.",
    },
    {
      id: "air_deficit",
      name: "Cathode Air Flow Deficit (r_air)",
      physics: "Shortfall of air flow against stack heat removal need",
      value: checks.air_deficit?.value ?? null,
      unit: "%",
      limit: "-12 % to +8 % (Warn) / -25 % to +15 % (Alarm)",
      status: (checks.air_deficit?.status ?? "ok") as Status,
      description: "Blower fade, blocked air filter, or high air-path ΔP.",
    },
    {
      id: "blower_dev",
      name: "Blower Power vs Flow (r_blw)",
      physics: "Measured blower power vs blower-law prediction",
      value: checks.blower_dev?.value ?? null,
      unit: "%",
      limit: "-15 % to +10 % (Warn) / -30 % to +25 % (Alarm)",
      status: (checks.blower_dev?.status ?? "ok") as Status,
      description: "Worn blower, fouled impeller, or VFD efficiency loss.",
    },
    {
      id: "energy_dev",
      name: "Stack Energy Balance (r_energy)",
      physics: "Cathode air sensible heat vs cell reaction heat",
      value: checks.energy_dev?.value ?? null,
      unit: "%",
      limit: "± 6.0 % (Warn) / ± 12.0 % (Alarm)",
      status: (checks.energy_dev?.status ?? "ok") as Status,
      description: "Thermocouple drift or cooling maldistribution.",
    },
    {
      id: "dT_cath",
      name: "Cathode ΔT Thermal Gradient (r_dT)",
      physics: "Outlet minus inlet air temperature",
      value: checks.dT_cath?.value ?? null,
      unit: "K",
      limit: "< 103 K (Warn) / < 108 K (Alarm)",
      status: (checks.dT_cath?.status ?? "ok") as Status,
      description: "Ceramic thermal stress limit (max break 108 K).",
    },
    {
      id: "dp_an_ca",
      name: "Anode-Cathode ΔP (r_dp)",
      physics: "Differential pressure across electrolyte membrane",
      value: checks.dp_an_ca?.value ?? null,
      unit: "mbar",
      limit: "< 15 mbar (Warn) / < 30 mbar (Alarm)",
      status: (checks.dp_an_ca?.status ?? "ok") as Status,
      description: "Seal or membrane mechanical break limit is 30 mbar.",
    },
    {
      id: "recycle_dev",
      name: "Anode Recycle vs Expected (r_rec)",
      physics: "Measured anode recycle flow vs mass-balance requirement",
      value: checks.recycle_dev?.value ?? null,
      unit: "%",
      limit: "± 10 % (Warn) / ± 25 % (Alarm)",
      status: (checks.recycle_dev?.status ?? "ok") as Status,
      description: "Low recycle: less steam at anode inlet, Ni oxidation risk.",
    },
    {
      id: "v_loss",
      name: "Stack Voltage vs Model (r_v)",
      physics: "Cell voltage below new-stack prediction at same conditions",
      value: checks.v_loss?.value ?? null,
      unit: "%",
      limit: "< 8 % (Warn) / < 11 % (Alarm)",
      status: (checks.v_loss?.status ?? "ok") as Status,
      description: "Steady rise = ageing. Sudden step = hot spot, leak, or starvation.",
    },
  ], [checks]);

  // Physics-based residual score calculation for when AE is warming up or unavailable
  const physicsScoreInfo = useMemo(() => {
    const c = state.latest?.checks ?? {};
    const devValues: { channel: string; label: string; sigma: number }[] = [];

    // Check 1: H2 flow deviation / supply restriction (5% warn, 10% alarm)
    if (c.h2_dev?.value != null) {
      const sig = Math.abs(c.h2_dev.value) / 5.0;
      devValues.push({ channel: "h2_flow_kg_h", label: "H₂ Flow", sigma: sig });
    }
    // Check 2: Fuel utilization (0.80 normal, 0.85 warn, 0.88 alarm)
    if (c.h2_uf?.value != null) {
      const sig = Math.max(0, c.h2_uf.value - 0.80) / 0.04;
      devValues.push({ channel: "h2_flow_kg_h", label: "Fuel Util (Uf)", sigma: sig });
    }
    // Check 3: Air deficit (12% warn, 25% alarm)
    if (c.air_deficit?.value != null) {
      const sig = Math.abs(c.air_deficit.value) / 12.0;
      devValues.push({ channel: "air_flow_kg_h", label: "Cathode Air Flow", sigma: sig });
    }
    // Check 4: Cathode temperature rise (97K design, 103K warn, 108K alarm)
    if (c.dT_cath?.value != null) {
      const sig = Math.max(0, c.dT_cath.value - 97.0) / 6.0;
      devValues.push({ channel: "dT_cath_K", label: "Cathode ΔT", sigma: sig });
    }
    // Check 5: Energy deviation (6% warn, 12% alarm)
    if (c.energy_dev?.value != null) {
      const sig = Math.abs(c.energy_dev.value) / 6.0;
      devValues.push({ channel: "t_ca_out_C", label: "Cathode Temp Out", sigma: sig });
    }
    // Check 6: Blower dev (15% warn, 30% alarm)
    if (c.blower_dev?.value != null) {
      const sig = Math.abs(c.blower_dev.value) / 15.0;
      devValues.push({ channel: "p_blower_kW", label: "Blower Power", sigma: sig });
    }
    // Check 7: Differential pressure (15 mbar warn, 30 mbar alarm)
    if (c.dp_an_ca?.value != null) {
      const sig = Math.max(0, c.dp_an_ca.value - 5.5) / 9.5;
      devValues.push({ channel: "dp_an_ca_mbar", label: "Anode-Cathode ΔP", sigma: sig });
    }
    // Check 8: Faraday power balance (1.5 kW warn, 4 kW alarm)
    if (c.faraday_res?.value != null) {
      const sig = Math.abs(c.faraday_res.value) / 1.5;
      devValues.push({ channel: "p_dc_kW", label: "Stack DC Power", sigma: sig });
    }
    // Check 9: Balance res (1.5 kW warn, 4 kW alarm)
    if (c.balance_res?.value != null) {
      const sig = Math.abs(c.balance_res.value) / 1.5;
      devValues.push({ channel: "p_net_kW", label: "Net AC Power", sigma: sig });
    }

    if (devValues.length === 0) return { score: null, top: [] };

    devValues.sort((a, b) => b.sigma - a.sigma);
    const top3 = devValues.slice(0, 3);
    const rms = Math.sqrt(top3.reduce((acc, v) => acc + v.sigma * v.sigma, 0) / Math.max(1, top3.length));
    const score = Math.max(0.25, +(rms.toFixed(3)));
    return { score, top: top3 };
  }, [state.latest?.checks]);

  const effectiveScore = ae?.score ?? physicsScoreInfo.score;
  const topChannels = (ae?.top && ae.top.length > 0) ? ae.top : physicsScoreInfo.top;

  // Normality score history
  const scoreData = useMemo(() => {
    return state.history
      .map((h) => {
        let score = h.ae;
        if (score === null && h.c) {
          const h2_dev = h.c["h2_dev"] != null ? Math.abs(h.c["h2_dev"]) / 5.0 : 0;
          const h2_uf = h.c["h2_uf"] != null ? Math.max(0, h.c["h2_uf"] - 0.80) / 0.04 : 0;
          const air = h.c["air_deficit"] != null ? Math.abs(h.c["air_deficit"]) / 12.0 : 0;
          const dT = h.c["dT_cath"] != null ? Math.max(0, h.c["dT_cath"] - 97.0) / 6.0 : 0;
          const sigMax = Math.max(h2_dev, h2_uf, air, dT);
          score = +(Math.max(0.25, sigMax).toFixed(3));
        }
        return {
          t: h.ts,
          score: score != null ? +score.toFixed(3) : 0.3,
          fault: h.meta?.injected_fault ?? null,
        };
      })
      .slice(-180);
  }, [state.history]);

  const faultPoints = scoreData.filter((d) => d.fault).map((d) => d.t);

  // Calculate overall Health Index (100% minus penalties)
  const healthIndex = useMemo(() => {
    let score = 100;
    if (effectiveScore != null && effectiveScore > effectiveThreshold) {
      score -= Math.min(35, (effectiveScore - effectiveThreshold) * 20);
    }
    for (const r of residuals) {
      if (r.status === "alarm") score -= 25;
      else if (r.status === "warning") score -= 10;
    }
    return Math.max(5, Math.round(score));
  }, [effectiveScore, effectiveThreshold, residuals]);

  const statusBadgeColor = (s: Status) => {
    if (s === "alarm") return "badge-alarm";
    if (s === "warning") return "badge-warning";
    return "badge-ok";
  };

  const handleFaultClick = (faultType: string) => {
    if (!state.sim?.running) {
      simStart();
    }
    simFault(faultType);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Physics-Informed Anomaly Detection</h1>
        <p>
          Hybrid Autoencoder &amp; First-Principles Thermodynamic Residual Monitoring for the 100 kW SOFC plant.
        </p>
      </div>

      {/* Model Status & KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Plant Health Index</span>
          <span className="kpi-value num" style={{ color: healthIndex < 70 ? "#C0392B" : healthIndex < 90 ? "#C47F17" : "#2D7D46" }}>
            {healthIndex}
            <small className="kpi-unit">%</small>
          </span>
          <span className="kpi-sub">
            {healthIndex >= 90 ? "Optimal operation" : healthIndex >= 70 ? "Degraded performance" : "Critical anomaly"}
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Normality Score</span>
          <span className="kpi-value num">
            {fmt(effectiveScore, 2)}
          </span>
          <span className="kpi-sub">
            Alarm Threshold: {effectiveThreshold.toFixed(2)}
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Model Assessment</span>
          <span className="kpi-value">
            {effectiveScore == null ? (
              "Warming Up"
            ) : effectiveScore > effectiveThreshold ? (
              <span style={{ color: "#C0392B", fontSize: 24, fontWeight: 600 }}>Unusual Pattern</span>
            ) : (
              <span style={{ color: "#2D7D46", fontSize: 24, fontWeight: 600 }}>Normal State</span>
            )}
          </span>
          <span className="kpi-sub">
            {ae?.available ? "Neural autoencoder active" : "Physics residual model active"}
          </span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Active Anomaly Alerts</span>
          <span className="kpi-value num">
            {state.alerts.length}
          </span>
          <span className="kpi-sub">
            {state.alerts.length === 0 ? "Zero open alerts" : `${state.alerts.filter((a) => a.severity === "alarm").length} alarms, ${state.alerts.filter((a) => a.severity === "warning").length} warnings`}
          </span>
        </div>
      </div>

      {/* Interactive Sensitivity & Calibration Slider */}
      <section className="slider-group">
        <div className="slider-group-header">
          <div>
            <h2 className="slider-group-title">Detection Threshold &amp; Diagnostics Calibration</h2>
            <small className="fine">
              Adjust detection sensitivity to evaluate model robustness and inspect detection latencies.
            </small>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            {customThreshold !== null && (
              <button type="button" className="btn btn-small" onClick={() => setCustomThreshold(null)}>
                Reset Threshold ({defaultThr.toFixed(2)})
              </button>
            )}
          </div>
        </div>

        <div className="slider-grid">
          <div className="slider-item">
            <div className="slider-label-row">
              <span className="slider-name">Alarm Threshold (σ deviation)</span>
              <span className="slider-val num">{effectiveThreshold.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.8}
              max={3.0}
              step={0.05}
              value={effectiveThreshold}
              onChange={(e) => setCustomThreshold(parseFloat(e.target.value))}
              aria-label="Alarm Threshold"
            />
          </div>

          <div className="slider-item">
            <div className="slider-label-row">
              <span className="slider-name">Simulate Process Faults</span>
              <span className="slider-val num">
                {state.sim?.fault?.label ?? "None Active"}
              </span>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4, alignItems: "center" }}>
              <button
                type="button"
                className={`btn btn-small btn-fault${state.sim?.fault?.type === "h2_restriction" ? " on" : ""}`}
                onClick={() => handleFaultClick("h2_restriction")}
                title="12% H2 delivery loss (Fuel starvation)"
              >
                H₂ Restriction
              </button>
              <button
                type="button"
                className={`btn btn-small btn-fault${state.sim?.fault?.type === "blower_fade" ? " on" : ""}`}
                onClick={() => handleFaultClick("blower_fade")}
                title="Blower capacity drops (Cooling deficit)"
              >
                Blower Fade
              </button>
              <button
                type="button"
                className={`btn btn-small btn-fault${state.sim?.fault?.type === "sensor_drift" ? " on" : ""}`}
                onClick={() => handleFaultClick("sensor_drift")}
                title="Thermocouple sensor drift"
              >
                TC Drift
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={simClear}
                disabled={!state.sim?.fault}
              >
                Clear
              </button>
              {!state.sim?.running && (
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  onClick={simStart}
                  title="Start simulator to begin generating telemetry"
                >
                  Start Simulator
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Normality Score History Timeline */}
      <div className="chart-card">
        <div className="chart-card-header">
          <div>
            <h3 className="chart-card-title">Autoencoder Normality Score History</h3>
            <small className="fine">
              Reconstruction error evaluated every 5 minutes against the 1-hour causal feature vector.
            </small>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="chart-legend">
              <span><i style={{ background: "#B84A2F" }} /> ϵ Error</span>
              <span><i style={{ background: "#C47F17" }} /> Threshold</span>
            </div>
            <span className="badge badge-ok" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
              Model Window: 12 × 5-min bins
            </span>
          </div>
        </div>

        <div style={{ width: "100%", height: 260 }}>
          <ResponsiveContainer>
            <LineChart data={scoreData} margin={{ top: 10, right: 20, bottom: 8, left: 10 }}>
              <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 3" strokeOpacity={0.5} />
              <XAxis
                dataKey="t"
                tickFormatter={fmtClock}
                minTickGap={45}
                stroke="var(--color-border)"
                tickLine={{ stroke: "var(--color-border)" }}
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: "var(--color-text-muted)" }}
              />
              <YAxis
                stroke="var(--color-border)"
                domain={[0, "auto"]}
                tickLine={{ stroke: "var(--color-border)" }}
                tick={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: "var(--color-text-muted)" }}
                tickFormatter={(v: number) => fmtSci(v, 1)}
                width={48}
                label={{ value: "Error, ϵ [σ]", angle: -90, position: "insideLeft", offset: 12, style: { fill: "var(--color-text-muted)", fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 500 } }}
              />
              <Tooltip
                contentStyle={{
                  background: "#FFFDF8",
                  border: "1px solid var(--color-border)",
                  borderRadius: 4,
                  padding: "6px 10px",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
                labelStyle={{ color: "var(--color-text-muted)", fontSize: 10, marginBottom: 4 }}
                labelFormatter={(t) => `t = ${fmtClock(String(t))}`}
                formatter={(val: number) => [`${fmtSci(val, 3)} σ`, "Reconstruction Error"]}
              />
              {faultPoints.length > 1 && (
                <ReferenceArea
                  x1={faultPoints[0]}
                  x2={faultPoints[faultPoints.length - 1]}
                  fill="var(--alarm)"
                  fillOpacity={0.06}
                />
              )}
              <ReferenceLine
                y={effectiveThreshold}
                stroke="#C47F17"
                strokeDasharray="2 3"
                strokeWidth={1}
                label={{ value: `Threshold (${effectiveThreshold.toFixed(2)} σ)`, fill: "#C47F17", fontSize: 10, fontFamily: "var(--font-mono)", position: "insideTopRight" }}
              />
              <Line
                type="monotone"
                dataKey="score"
                stroke="#B84A2F"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3.5, strokeWidth: 1.2, stroke: "#FFFDF8" }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Channel Attribution & Physics Residuals */}
      <div className="charts-row">
        {/* Channel Deviations Bar Chart */}
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <h3 className="chart-card-title">Channel Deviation Attribution (Top σ)</h3>
              <small className="fine">
                Sensors contributing the highest reconstruction variance during anomalous patterns.
              </small>
            </div>
          </div>

          {topChannels.length === 0 ? (
            <p className="empty" style={{ padding: 24 }}>
              No channel deviations detected. All process channels reside inside the trained normality envelope.
            </p>
          ) : (
            <div style={{ width: "100%", height: 260 }}>
              <ResponsiveContainer>
                <BarChart
                  data={topChannels.map((c) => ({ name: c.label, sigma: +c.sigma.toFixed(2) }))}
                  layout="vertical"
                  margin={{ top: 8, right: 24, bottom: 18, left: 140 }}
                >
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="2 3" strokeOpacity={0.5} horizontal={false} />
                  <XAxis
                    type="number"
                    stroke="var(--color-border)"
                    tickLine={{ stroke: "var(--color-border)" }}
                    tick={{ fontSize: 10, fontFamily: "var(--font-mono)", fill: "var(--color-text-muted)" }}
                    label={{ value: "Deviation, Δ [σ]", position: "insideBottom", offset: -10, style: { fill: "var(--color-text-muted)", fontSize: 11, fontFamily: "var(--font-mono)", fontWeight: 500 } }}
                  />
                  <YAxis
                    dataKey="name"
                    type="category"
                    stroke="var(--color-border)"
                    tickLine={{ stroke: "var(--color-border)" }}
                    tick={{ fontSize: 11, fill: "var(--color-text)" }}
                    width={135}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#FFFDF8",
                      border: "1px solid var(--color-border)",
                      borderRadius: 4,
                      padding: "6px 10px",
                      boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                    }}
                    labelStyle={{ color: "var(--color-text-muted)", fontSize: 10, marginBottom: 4 }}
                    formatter={(val: number) => [`${fmtSci(val, 2)} σ`, "Deviation"]}
                  />
                  <Bar dataKey="sigma" barSize={12} radius={[0, 2, 2, 0]}>
                    {topChannels.map((_, idx) => (
                      <Cell key={idx} fill={idx === 0 ? "#B84A2F" : idx === 1 ? "#C47F17" : "#0E7490"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* Diagnostic Attribution Details */}
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <h3 className="chart-card-title">Diagnostics &amp; Root-Cause Hint</h3>
              <small className="fine">Physical explanation of anomalous behavior</small>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {state.alerts.length > 0 ? (
              state.alerts.map((a) => (
                <div key={a.id} className={`alert alert-${a.severity}`}>
                  <div className="alert-top">
                    <span className={`badge badge-${a.severity}`}>{a.severity.toUpperCase()}</span>
                    <strong className="alert-title">{a.title}</strong>
                    <span className="alert-time">{fmtClock(a.first_ts)}</span>
                  </div>
                  <p className="alert-detail">{a.detail}</p>
                  {a.hint && <p className="fine" style={{ color: "#C47F17" }}>Operator Action: {a.hint}</p>}
                </div>
              ))
            ) : (
              <div style={{ padding: "20px 0", color: "#2D7D46", display: "flex", alignItems: "center", gap: 10 }}>
                <span className="dot dot-ok" />
                <span>All physical utilities and learned model residuals are within normal design tolerances.</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Physics-Informed Residuals Matrix */}
      <div className="chart-card">
        <div className="chart-card-header">
          <div>
            <h3 className="chart-card-title">First-Principles Thermodynamic Residuals Matrix</h3>
            <small className="fine">
              Explicit physical constraints (Faraday, Nernst, thermal balances, blower laws) monitored causal-smoothed.
            </small>
          </div>
        </div>

        <div className="scroll-x">
          <table className="data-table">
            <thead>
              <tr>
                <th>Residual Name</th>
                <th>Physical Law Monitored</th>
                <th>Current Value</th>
                <th>Design Tolerance</th>
                <th>Active Alert / Deviation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {residuals.map((r) => {
                const activeAlert = state.alerts.find((a) => a.check_id === r.id);
                const hasAlarm = activeAlert?.severity === "alarm" || r.status === "alarm";
                const hasWarn = activeAlert?.severity === "warning" || r.status === "warning";
                const rowClass = hasAlarm ? "row-alarm" : hasWarn ? "row-warning" : "";

                return (
                  <tr key={r.id} className={rowClass}>
                    <td><strong>{r.name}</strong></td>
                    <td>{r.physics}</td>
                    <td className="num">
                      <strong>{fmt(r.value, r.id === "h2_uf" ? 3 : r.id === "faraday_res" || r.id === "balance_res" ? 2 : 1)} {r.unit}</strong>
                    </td>
                    <td className="num muted">{r.limit}</td>
                    <td>
                      {activeAlert ? (
                        <span className={`badge badge-${activeAlert.severity}`} title={activeAlert.detail}>
                          {activeAlert.severity.toUpperCase()}: {activeAlert.title}
                        </span>
                      ) : r.status !== "ok" && r.status !== "unknown" ? (
                        <span className={`badge badge-${r.status}`}>
                          {r.status === "alarm" ? "Out of Tolerance" : "Warning Band"}
                        </span>
                      ) : (
                        <span className="fine muted">Normal Band</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge ${statusBadgeColor(activeAlert ? activeAlert.severity : r.status)}`}>
                        {(activeAlert ? activeAlert.severity : r.status).toUpperCase()}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
