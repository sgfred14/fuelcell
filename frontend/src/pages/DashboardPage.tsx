import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";
import { useMonitorContext } from "../App";
import { fmt } from "../lib/format";
import type { PolarizationResult, ThermodynamicState } from "../types";

interface SliderState {
  temperature_C: number;
  load: number;
  fuel_utilization: number;
  asr_multiplier: number;
  recycle_ratio: number;
  degradation_V: number;
}

const DEFAULTS: SliderState = {
  temperature_C: 700,
  load: 0.80,
  fuel_utilization: 0.80,
  asr_multiplier: 1.12,
  recycle_ratio: 0.50,
  degradation_V: 0.012,
};

const SLIDERS = [
  { key: "temperature_C" as const, label: "Stack Temperature", unit: "°C", min: 600, max: 800, step: 5, decimals: 0 },
  { key: "load" as const, label: "Plant Load Fraction", unit: "×", min: 0.40, max: 1.10, step: 0.02, decimals: 2 },
  { key: "fuel_utilization" as const, label: "Fuel Utilization (Uf)", unit: "", min: 0.60, max: 0.90, step: 0.01, decimals: 2 },
  { key: "asr_multiplier" as const, label: "ASR Degradation Factor", unit: "×", min: 0.80, max: 2.20, step: 0.02, decimals: 2 },
  { key: "recycle_ratio" as const, label: "Anode Recycle Ratio", unit: "", min: 0.20, max: 0.70, step: 0.02, decimals: 2 },
  { key: "degradation_V" as const, label: "Activation Degradation", unit: "V", min: 0.000, max: 0.060, step: 0.002, decimals: 3 },
];

export default function DashboardPage() {
  const { state } = useMonitorContext();
  const [sliders, setSliders] = useState<SliderState>(DEFAULTS);
  const [polData, setPolData] = useState<PolarizationResult | null>(null);
  const [thermo, setThermo] = useState<ThermodynamicState | null>(null);
  const [loading, setLoading] = useState(false);
  const [appliedToSim, setAppliedToSim] = useState(false);
  const debounceTimer = useRef<number>();
  const isInitialMount = useRef(true);

  // Fetch polarization and thermodynamic state whenever sliders adjust
  const loadData = useCallback((s: SliderState) => {
    setLoading(true);
    Promise.all([
      api.polarization({
        temperature_C: s.temperature_C,
        asr_multiplier: s.asr_multiplier,
        degradation_V: s.degradation_V,
        fuel_utilization: s.fuel_utilization,
        recycle_ratio: s.recycle_ratio,
        j_min: 0.02,
        j_max: 1.45,
        n_points: 65,
      }),
      api.thermodynamicCalculate({
        temperature_C: s.temperature_C,
        asr_multiplier: s.asr_multiplier,
        degradation_V: s.degradation_V,
        fuel_utilization: s.fuel_utilization,
        recycle_ratio: s.recycle_ratio,
      }),
    ])
      .then(([pol, th]) => {
        setPolData(pol);
        setThermo(th);
      })
      .catch((err) => console.error("Failed to load thermodynamic data:", err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => {
      loadData(sliders);
    }, 250);
    return () => window.clearTimeout(debounceTimer.current);
  }, [sliders, loadData]);

  // Initial load
  useEffect(() => {
    loadData(DEFAULTS);
  }, [loadData]);

  const handleSliderChange = (key: keyof SliderState, val: number) => {
    setSliders((prev) => ({ ...prev, [key]: val }));
    setAppliedToSim(false);
  };

  const handleApplyToSim = async () => {
    try {
      await api.simParams({
        load: sliders.load,
        temperature_C: sliders.temperature_C,
        fuel_utilization: sliders.fuel_utilization,
        asr_multiplier: sliders.asr_multiplier,
        recycle_ratio: sliders.recycle_ratio,
        degradation_V: sliders.degradation_V,
      });
      setAppliedToSim(true);
    } catch (e) {
      console.error("Failed to apply params to simulator", e);
    }
  };

  const handleResetSliders = () => {
    setSliders(DEFAULTS);
    api.simParams({ reset: true }).catch(console.error);
    setAppliedToSim(false);
  };

  // Live telemetry values from monitor feed
  const liveValues = state.latest?.values;

  // Prepare combined I-V and Polarization data
  const chartPoints = useMemo(() => {
    if (!polData) return [];
    return polData.j_range.map((j, idx) => ({
      j: +j.toFixed(4),
      i: +polData.i_stack[idx].toFixed(1),
      v_cell: +polData.v_cell[idx].toFixed(4),
      v_stack: +polData.v_stack[idx].toFixed(1),
      v_nernst: +polData.v_nernst[idx].toFixed(4),
      eta_ohmic: +polData.eta_ohmic[idx].toFixed(4),
      eta_act: +polData.eta_act[idx].toFixed(4),
      eta_conc: +polData.eta_conc[idx].toFixed(4),
      p_dc: +polData.p_dc[idx].toFixed(2),
      p_density: +polData.p_density[idx].toFixed(3),
      p_net: +polData.p_net[idx].toFixed(2),
    }));
  }, [polData]);

  const mpp = useMemo(() => polData?.mpp, [polData]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Plant Performance &amp; Thermodynamics</h1>
        <p>
          High-temperature Solid Oxide Fuel Cell power plant electrochemistry, energy balances, and characteristic curves.
        </p>
      </div>

      {/* KPI Cards Grid */}
      <div className="kpi-grid">
        <div className="kpi-card">
          <span className="kpi-label">Net AC Power</span>
          <span className="kpi-value num">
            {fmt(liveValues?.p_net_kW ?? thermo?.p_net_kW ?? null, 1)}
            <small className="kpi-unit">kW</small>
          </span>
          <span className="kpi-sub">Stack DC: {fmt(liveValues?.p_dc_kW ?? thermo?.p_dc_kW ?? null, 1)} kW</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Electrical Efficiency</span>
          <span className="kpi-value num">
            {fmt(thermo?.efficiency_electrical_pct ?? 53.2, 1)}
            <small className="kpi-unit">%</small>
          </span>
          <span className="kpi-sub">CHP Total: {fmt(thermo?.efficiency_chp_pct ?? 84.5, 1)}%</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Average Cell Voltage</span>
          <span className="kpi-value num">
            {fmt(liveValues?.v_cell_V ?? thermo?.v_cell_V ?? null, 3)}
            <small className="kpi-unit">V</small>
          </span>
          <span className="kpi-sub">Stack: {fmt((liveValues?.v_cell_V ?? thermo?.v_cell_V ?? 0.75) * 732, 0)} V</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Fuel Utilization</span>
          <span className="kpi-value num">
            {fmt(thermo?.fuel_utilization ?? sliders.fuel_utilization, 2)}
          </span>
          <span className="kpi-sub">Target Band: 0.70 – 0.88</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Cathode Outlet Temp</span>
          <span className="kpi-value num">
            {fmt(liveValues?.t_ca_out_C ?? thermo?.t_ca_out_C ?? (sliders.temperature_C + 97), 0)}
            <small className="kpi-unit">°C</small>
          </span>
          <span className="kpi-sub">Inlet: {fmt(liveValues?.t_ca_in_C ?? sliders.temperature_C, 0)} °C (ΔT {fmt(liveValues?.dT_cath_K ?? thermo?.dT_cath_K ?? 97, 0)} K)</span>
        </div>

        <div className="kpi-card">
          <span className="kpi-label">Stack Current</span>
          <span className="kpi-value num">
            {fmt(liveValues?.i_stack_A ?? (sliders.load * 240), 1)}
            <small className="kpi-unit">A</small>
          </span>
          <span className="kpi-sub">Current Density: {fmt((liveValues?.i_stack_A ? liveValues.i_stack_A / 600 : sliders.load * 0.4), 2)} A/cm²</span>
        </div>
      </div>

      {/* Operating Parameter Sliders */}
      <section className="slider-group" aria-labelledby="sliders-title">
        <div className="slider-group-header">
          <div>
            <h2 id="sliders-title" className="slider-group-title">Interactive Operating Parameter Controls</h2>
            <small className="fine">
              Adjust parameters to explore thermodynamic responses, overpotential shifts, and polarization behavior.
            </small>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleApplyToSim}
              title="Drive the live simulation feed with these slider settings"
            >
              {appliedToSim ? "Applied to Live Plant" : "Apply to Live Feed"}
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleResetSliders}
              title="Reset all values to baseline design conditions"
            >
              Reset to Design
            </button>
          </div>
        </div>

        <div className="slider-grid">
          {SLIDERS.map((s) => (
            <div className="slider-item" key={s.key}>
              <div className="slider-label-row">
                <span className="slider-name">{s.label}</span>
                <span className="slider-val num">
                  {sliders[s.key].toFixed(s.decimals)}
                  {s.unit ? ` ${s.unit}` : ""}
                </span>
              </div>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={sliders[s.key]}
                onChange={(e) => handleSliderChange(s.key, parseFloat(e.target.value))}
                aria-label={s.label}
              />
            </div>
          ))}
        </div>
      </section>

      {/* Characteristic Graphs */}
      <div className="charts-row">
        {/* I vs V and Stack Power Characteristics */}
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <h3 className="chart-card-title">I–V Characteristics &amp; Stack Power</h3>
              <small className="fine">
                Stack terminal voltage (V) and net DC electrical output (kW) vs stack current (A).
              </small>
            </div>
            {mpp && (
              <span className="badge badge-ok">
                Peak Power: {mpp.p_dc} kW @ {mpp.i} A
              </span>
            )}
          </div>

          <div style={{ width: "100%", height: 350 }}>
            <ResponsiveContainer>
              <ComposedChart data={chartPoints} margin={{ top: 10, right: 24, bottom: 24, left: 10 }}>
                <CartesianGrid stroke="#E0D9D0" strokeDasharray="3 3" />
                <XAxis
                  dataKey="i"
                  stroke="#6B6560"
                  tick={{ fontSize: 12 }}
                  label={{ value: "Stack Current I (A)", position: "insideBottom", offset: -16, style: { fill: "#6B6560", fontSize: 13, fontWeight: 500 } }}
                />
                <YAxis
                  yAxisId="left"
                  stroke="#B84A2F"
                  domain={[0, 900]}
                  tick={{ fontSize: 12, fill: "#B84A2F" }}
                  label={{ value: "Stack Voltage (V)", angle: -90, position: "insideLeft", offset: 0, style: { fill: "#B84A2F", fontSize: 13, fontWeight: 500 } }}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#2A6496"
                  domain={[0, 180]}
                  tick={{ fontSize: 12, fill: "#2A6496" }}
                  label={{ value: "Stack DC Power (kW)", angle: 90, position: "insideRight", offset: 10, style: { fill: "#2A6496", fontSize: 13, fontWeight: 500 } }}
                />
                <Tooltip
                  contentStyle={{ background: "#FFFDF8", border: "1px solid #E0D9D0", borderRadius: 4, fontSize: 13 }}
                  formatter={(val: number, name: string) => [
                    name === "Stack Voltage" ? `${val.toFixed(1)} V` : `${val.toFixed(1)} kW`,
                    name,
                  ]}
                  labelFormatter={(curr) => `Current: ${curr} A`}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="v_stack"
                  name="Stack Voltage"
                  stroke="#B84A2F"
                  strokeWidth={2.4}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="p_dc"
                  name="Stack Power"
                  stroke="#2A6496"
                  strokeWidth={2.0}
                  dot={false}
                  isAnimationActive={false}
                />
                {mpp && (
                  <ReferenceLine
                    yAxisId="left"
                    x={mpp.i}
                    stroke="#C47F17"
                    strokeDasharray="4 4"
                    label={{ value: `MPP: ${mpp.p_dc} kW`, position: "top", fill: "#C47F17", fontSize: 11 }}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Voltage vs Current Density (V vs j) with Overpotential Breakdown */}
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <h3 className="chart-card-title">Voltage vs Current Density (V–j Polarization)</h3>
              <small className="fine">
                Electrochemical loss breakdown: Reversible Nernst potential, ohmic, activation, and concentration overpotentials.
              </small>
            </div>
            <div className="chart-legend">
              <span><i style={{ background: "#6B6560" }} /> Nernst</span>
              <span><i style={{ background: "#B84A2F" }} /> V_cell</span>
              <span><i style={{ background: "#2A6496" }} /> η_ohm</span>
              <span><i style={{ background: "#C47F17" }} /> η_act</span>
              <span><i style={{ background: "#2D7D46" }} /> η_conc</span>
            </div>
          </div>

          <div style={{ width: "100%", height: 350 }}>
            <ResponsiveContainer>
              <LineChart data={chartPoints} margin={{ top: 10, right: 16, bottom: 24, left: 10 }}>
                <CartesianGrid stroke="#E0D9D0" strokeDasharray="3 3" />
                <XAxis
                  dataKey="j"
                  stroke="#6B6560"
                  tick={{ fontSize: 12 }}
                  label={{ value: "Current Density j (A/cm²)", position: "insideBottom", offset: -16, style: { fill: "#6B6560", fontSize: 13, fontWeight: 500 } }}
                />
                <YAxis
                  stroke="#6B6560"
                  domain={[0, 1.25]}
                  tick={{ fontSize: 12 }}
                  label={{ value: "Cell Potential (V)", angle: -90, position: "insideLeft", offset: 0, style: { fill: "#6B6560", fontSize: 13, fontWeight: 500 } }}
                />
                <Tooltip
                  contentStyle={{ background: "#FFFDF8", border: "1px solid #E0D9D0", borderRadius: 4, fontSize: 13 }}
                  formatter={(val: number, name: string) => [`${val.toFixed(4)} V`, name]}
                  labelFormatter={(j) => `Current density: ${j} A/cm²`}
                />
                <Line
                  type="monotone"
                  dataKey="v_nernst"
                  name="Nernst Potential"
                  stroke="#6B6560"
                  strokeDasharray="6 4"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="v_cell"
                  name="Cell Voltage"
                  stroke="#B84A2F"
                  strokeWidth={2.4}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="eta_ohmic"
                  name="Ohmic Loss (η_ohm)"
                  stroke="#2A6496"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="eta_act"
                  name="Activation Loss (η_act)"
                  stroke="#C47F17"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="eta_conc"
                  name="Concentration Loss (η_conc)"
                  stroke="#2D7D46"
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Thermodynamic State & Energy Balances Table */}
      <div className="chart-card">
        <div className="chart-card-header">
          <div>
            <h3 className="chart-card-title">Thermodynamic State &amp; Energy Balances</h3>
            <small className="fine">
              First and second law energy distributions calculated at the selected operating condition.
            </small>
          </div>
          {loading && <span className="badge badge-warning">Computing Thermodynamics…</span>}
        </div>

        <div className="scroll-x">
          <table className="data-table">
            <thead>
              <tr>
                <th>Electrochemical Parameter</th>
                <th>Value</th>
                <th>Thermal &amp; Plant Stream</th>
                <th>Value</th>
                <th>Efficiency Metric</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Reversible Nernst OCV</td>
                <td className="num">{fmt(thermo?.nernst_V, 4)} V</td>
                <td>Reaction Enthalpy (Fuel LHV)</td>
                <td className="num">{fmt(thermo?.fuel_energy_kW, 1)} kW</td>
                <td>Thermodynamic Reversible (Gibbs)</td>
                <td className="num">{fmt(thermo?.efficiency_rev_pct, 1)}%</td>
              </tr>
              <tr>
                <td>Ohmic Overpotential (η_ohm)</td>
                <td className="num">{fmt(thermo?.eta_ohmic_V, 4)} V</td>
                <td>Stack Heat Generated (Q_gen)</td>
                <td className="num">{fmt(thermo?.q_gen_kW, 1)} kW</td>
                <td>Voltage Efficiency (V/E_nernst)</td>
                <td className="num">{fmt(thermo?.efficiency_voltage_pct, 1)}%</td>
              </tr>
              <tr>
                <td>Activation Overpotential (η_act)</td>
                <td className="num">{fmt(thermo?.eta_act_V, 4)} V</td>
                <td>Cathode Air Cooling (Q_cath)</td>
                <td className="num">{fmt(thermo?.q_cath_kW, 1)} kW</td>
                <td>Fuel Utilization Efficiency</td>
                <td className="num">{fmt((thermo?.fuel_utilization ?? 0.8) * 100, 1)}%</td>
              </tr>
              <tr>
                <td>Concentration Overpotential (η_conc)</td>
                <td className="num">{fmt(thermo?.eta_conc_V, 4)} V</td>
                <td>Tail-gas Combustor Heat</td>
                <td className="num">{fmt(thermo?.q_afterburner_kW, 1)} kW</td>
                <td>Net Electrical Efficiency (LHV)</td>
                <td className="num"><strong>{fmt(thermo?.efficiency_electrical_pct, 1)}%</strong></td>
              </tr>
              <tr>
                <td>Cell Voltage (V_cell)</td>
                <td className="num"><strong>{fmt(thermo?.v_cell_V, 4)} V</strong></td>
                <td>HRSG Steam Heat Recovery</td>
                <td className="num">{fmt(thermo?.q_hrsg_kW, 1)} kW</td>
                <td>Combined Heat &amp; Power (CHP)</td>
                <td className="num"><strong>{fmt(thermo?.efficiency_chp_pct, 1)}%</strong></td>
              </tr>
              <tr>
                <td>Total Stack Voltage (732 series)</td>
                <td className="num">{fmt(thermo?.v_stack_V, 1)} V</td>
                <td>Ambient Heat Loss (Q_loss)</td>
                <td className="num">{fmt(thermo?.q_loss_kW, 2)} kW</td>
                <td>Air Ratio (O₂ fed / O₂ consumed)</td>
                <td className="num">{fmt(thermo?.air_ratio, 1)}×</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
