export interface SeriesDef {
  source: "v" | "c";
  key: string;
  label: string;
  unit: string;
  color: string;
  decimals?: number;
}
export interface ChartDef {
  id: string;
  title: string;
  /** When set, the chart plots this physics check and draws its warning and alarm limits. */
  check?: string;
  series?: SeriesDef[];
}

const C1 = "#0284C7"; // Precision cerulean
const C2 = "#6366F1"; // Technical indigo
const C3 = "#059669"; // Technical emerald

export const CHARTS: Record<string, ChartDef[]> = {
  hydrogen: [
    { id: "h2_dev", title: "H₂ flow vs stack demand", check: "h2_dev" },
    { id: "h2_uf", title: "Fuel utilisation", check: "h2_uf" },
    { id: "h2_flow", title: "H₂ flow", series: [{ source: "v", key: "h2_flow_kg_h", label: "H₂ flow", unit: "kg/h", color: C1, decimals: 2 }] },
    { id: "i_stack", title: "Stack current", series: [{ source: "v", key: "i_stack_A", label: "Stack current", unit: "A", color: C2, decimals: 0 }] },
  ],
  air: [
    { id: "air_deficit", title: "Air flow vs heat-balance need", check: "air_deficit" },
    { id: "blower_dev", title: "Blower power vs flow", check: "blower_dev" },
    { id: "air_flow", title: "Cathode air flow", series: [{ source: "v", key: "air_flow_kg_h", label: "Air flow", unit: "kg/h", color: C1, decimals: 0 }] },
    { id: "blower", title: "Blower power", series: [{ source: "v", key: "p_blower_kW", label: "Blower power", unit: "kW", color: C2, decimals: 1 }] },
  ],
  cooling: [
    { id: "dT", title: "Cathode temperature rise", check: "dT_cath" },
    { id: "energy", title: "Stack heat balance", check: "energy_dev" },
    { id: "temps", title: "Cathode temperatures", series: [
      { source: "v", key: "t_ca_in_C", label: "Inlet", unit: "°C", color: C1, decimals: 0 },
      { source: "v", key: "t_ca_out_C", label: "Outlet", unit: "°C", color: C2, decimals: 0 } ] },
    { id: "ab", title: "Afterburner temperature", check: "t_ab" },
  ],
  electrical: [
    { id: "v_loss", title: "Stack voltage vs new-stack model", check: "v_loss" },
    { id: "faraday", title: "DC power vs current × voltage", check: "faraday_res" },
    { id: "balance", title: "Net power balance", check: "balance_res" },
    { id: "power", title: "Power", series: [
      { source: "v", key: "p_dc_kW", label: "Stack DC", unit: "kW", color: C1, decimals: 1 },
      { source: "v", key: "p_net_kW", label: "Net AC", unit: "kW", color: C3, decimals: 1 } ] },
  ],
  steam: [
    { id: "steam_dev", title: "Steam vs heat balance", check: "steam_dev" },
    { id: "flue", title: "Flue gas leaving HRSG", check: "t_flue" },
    { id: "steam", title: "Steam flow", series: [{ source: "v", key: "steam_flow_kg_h", label: "Steam", unit: "kg/h", color: C1, decimals: 0 }] },
  ],
  safety: [
    { id: "dp", title: "Anode-cathode ΔP", check: "dp_an_ca" },
    { id: "recycle_dev", title: "Anode recycle vs expected", check: "recycle_dev" },
    { id: "recycle", title: "Anode recycle flow", series: [{ source: "v", key: "recycle_flow_kmol_h", label: "Recycle", unit: "kmol/h", color: C1, decimals: 2 }] },
  ],
};
