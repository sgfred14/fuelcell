"""
The six monitored process utilities and the physics checks behind them.

Every check turns the last few minutes of raw readings into ONE number in engineering units (a percentage deviation,
a power mismatch in kW, a temperature rise in K ...) and compares it with a warning and an alarm band. The numbers
come from the Phase 1 plant balances (Faraday current, stack heat balance, blower law, anode-loop mass balance,
HRSG heat balance). They are calibrated to the Phase 1 design point of a 100 kW plant: for another plant the
constants in sofc_ai/config.py and the limits below must be recalibrated.
"""
import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from sofc_ai import config as C
from sofc_ai import plant

CHANNELS = list(C.TELEMETRY_CHANNELS)

# plausible sensor range per channel (outside = sensor / wiring problem, not a process problem)
RANGES = {
    "t_amb_C": (-10, 60), "rh_amb": (0, 1.0), "load_set": (0, 1.2), "i_stack_A": (0, 400), "v_cell_V": (0.3, 1.2),
    "p_dc_kW": (0, 200), "p_net_kW": (-20, 200), "t_an_in_C": (300, 900), "t_ca_in_C": (300, 900),
    "t_ca_out_C": (300, 1000), "dT_cath_K": (-20, 250), "h2_flow_kg_h": (0, 20), "air_flow_kg_h": (0, 6000),
    "recycle_flow_kmol_h": (0, 15), "steam_flow_kg_h": (0, 300), "dp_an_ca_mbar": (-60, 100),
    "p_blower_kW": (0, 60), "t_afterburner_C": (300, 1300), "t_flue_out_C": (20, 400),
}
UNITS = {
    "t_amb_C": "°C", "rh_amb": "", "load_set": "", "i_stack_A": "A", "v_cell_V": "V", "p_dc_kW": "kW", "p_net_kW": "kW",
    "t_an_in_C": "°C", "t_ca_in_C": "°C", "t_ca_out_C": "°C", "dT_cath_K": "K", "h2_flow_kg_h": "kg/h",
    "air_flow_kg_h": "kg/h", "recycle_flow_kmol_h": "kmol/h", "steam_flow_kg_h": "kg/h", "dp_an_ca_mbar": "mbar",
    "p_blower_kW": "kW", "t_afterburner_C": "°C", "t_flue_out_C": "°C",
}
LABELS = {
    "t_amb_C": "Ambient temperature", "rh_amb": "Ambient humidity", "load_set": "Load setpoint",
    "i_stack_A": "Stack current", "v_cell_V": "Cell voltage", "p_dc_kW": "Stack DC power", "p_net_kW": "Net AC power",
    "t_an_in_C": "Anode inlet temperature", "t_ca_in_C": "Cathode inlet temperature",
    "t_ca_out_C": "Cathode outlet temperature", "dT_cath_K": "Cathode temperature rise", "h2_flow_kg_h": "H₂ flow",
    "air_flow_kg_h": "Cathode air flow", "recycle_flow_kmol_h": "Anode recycle flow", "steam_flow_kg_h": "Steam flow",
    "dp_an_ca_mbar": "Anode-cathode ΔP", "p_blower_kW": "Air blower power", "t_afterburner_C": "Afterburner temperature",
    "t_flue_out_C": "Flue gas to stack",
}
CONTEXT_CHANNELS = {"t_amb_C", "rh_amb", "load_set"}


@dataclass(frozen=True)
class Check:
    id: str
    utility: str
    label: str
    unit: str
    decimals: int
    warn_lo: Optional[float] = None
    warn_hi: Optional[float] = None
    alarm_lo: Optional[float] = None
    alarm_hi: Optional[float] = None
    window: int = 15                     # minutes of smoothing
    inputs: tuple = ()
    what: str = ""                        # one-line explanation of what the number means
    hint: str = ""                        # what an operator should look at


CHECKS = [
    # ---- Hydrogen supply
    Check("h2_dev", "hydrogen", "H₂ flow vs stack demand", "%", 1, -5, 5, -10, 10, 15, ("h2_flow_kg_h", "i_stack_A"),
          "Measured H₂ flow compared with the flow the stack current requires at 80 % utilisation.",
          "Negative: supply restriction (regulator, valve, upstream pressure, filter). Positive: leak or flow-meter error."),
    Check("h2_uf", "hydrogen", "Fuel utilisation", "", 3, 0.75, 0.85, 0.70, 0.88, 15, ("h2_flow_kg_h", "i_stack_A"),
          "Share of the H₂ that the Faraday current oxidises. Above 0.88 the anode risks fuel starvation and nickel re-oxidation.",
          "High utilisation with a normal current means too little H₂ is arriving. Check supply pressure and the H₂ regulator."),
    # ---- Cathode air and blower
    Check("air_deficit", "air", "Air flow vs heat-balance need", "%", 1, -12, 8, -25, 15, 15, ("air_flow_kg_h", "p_dc_kW", "i_stack_A"),
          "Shortfall of the measured air flow against the flow that removes the stack heat at a 97 K temperature rise.",
          "Deficit: blower fade, blocked air filter, closed damper or high air-path ΔP. The stack then runs hotter."),
    Check("blower_dev", "air", "Blower power vs flow", "%", 1, -15, 10, -30, 25, 15, ("p_blower_kW", "air_flow_kg_h", "t_amb_C"),
          "Blower power compared with what the blower law predicts for the measured air flow and ambient temperature.",
          "Excess power for the flow delivered: worn blower, fouled impeller, motor or VFD problem, or extra resistance in the air path."),
    Check("air_ratio", "air", "Air ratio (O₂ fed / O₂ consumed)", "×", 1, 8.0, 16.0, 6.5, 20.0, 15, ("air_flow_kg_h", "i_stack_A"),
          "How much more oxygen is supplied than the cells consume. Cooling, not oxygen demand, sets it (design about 11).",
          "Low: air starvation risk and hot stack. High: wasted blower power and over-cooling."),
    # ---- Stack cooling and temperatures
    Check("dT_cath", "cooling", "Cathode temperature rise", "K", 1, None, 103, None, 108, 15, ("t_ca_in_C", "t_ca_out_C"),
          "Outlet minus inlet air temperature (15-min mean). The ceramic cells tolerate at most 100 K across the stack; the warning starts at 103 K so that the short overshoots seen during load changes on this plant do not raise alerts.",
          "Above the band: more air, lower load, or find the cause (blower, maldistribution). Do not keep running above 108 K."),
    Check("energy_dev", "cooling", "Stack heat balance", "%", 1, -6, 6, -12, 12, 15, ("air_flow_kg_h", "dT_cath_K", "p_dc_kW", "h2_flow_kg_h"),
          "Heat carried away by the measured air flow and temperature rise, compared with the heat the cell reaction releases.",
          "A mismatch means a reading is wrong or heat goes somewhere unexpected: thermocouple drift, air maldistribution, a leak or an internal fault."),
    Check("t_ca_in_dev", "cooling", "Cathode inlet vs setpoint", "K", 1, -12, 12, -25, 25, 15, ("t_ca_in_C",),
          "Cathode inlet temperature minus its 650 °C setpoint.",
          "Check the air preheater, the flue gas path and the temperature controller."),
    Check("t_ab", "cooling", "Afterburner temperature", "°C", 0, 720, 900, 650, 1000, 15, ("t_afterburner_C",),
          "Tail-gas combustor outlet. Too low: incomplete burn-out. Too high: damage to the catalyst and exchangers.",
          "Low: unburned H₂ may slip or the burner is not lit. High: excess fuel reaching the burner."),
    # ---- Electrical and power conditioning
    Check("faraday_res", "electrical", "DC power vs current × voltage", "kW", 2, -1.5, 1.5, -4, 4, 15, ("p_dc_kW", "i_stack_A", "v_cell_V"),
          "Difference between the DC power reading and stack current times voltage times the cells in series.",
          "A mismatch means a bad sensor or a wiring or scaling error on the DC side."),
    Check("balance_res", "electrical", "Net power balance", "kW", 2, -1.5, 1.5, -4, 4, 15, ("p_net_kW", "p_dc_kW", "p_blower_kW"),
          "Net AC power minus (DC power × inverter efficiency − blowers − auxiliaries).",
          "A mismatch means the inverter is losing more than expected, or a parasitic load is not being counted."),
    Check("v_loss", "electrical", "Stack voltage vs new-stack model", "%", 1, -4, 8, -8, 11, 15, ("v_cell_V", "i_stack_A", "t_ca_out_C"),
          "Cell voltage below what a new stack gives at the same current, temperature and utilisation. 10 % is end of life.",
          "A steady rise is ageing: plan maintenance. A sudden step points to a fault such as a hot spot, leak or fuel starvation."),
    # ---- Steam and water (HRSG)
    Check("steam_dev", "steam", "Steam vs heat balance", "%", 1, -10, 10, -20, 20, 15, ("steam_flow_kg_h", "p_dc_kW", "h2_flow_kg_h"),
          "Steam output compared with the heat the plant should be leaving in the exhaust.",
          "Low: HRSG fouling, feedwater shortage, bypassed exhaust. High: flow-meter error."),
    Check("t_flue", "steam", "Flue gas leaving HRSG", "°C", 0, 115, 155, 100, 175, 15, ("t_flue_out_C",),
          "Exhaust temperature to the stack (design about 133 °C).",
          "High: HRSG fouling or low feedwater flow, heat is being wasted. Low: over-extraction, risk of condensation."),
    # ---- Differential pressure and safety
    Check("dp_an_ca", "safety", "Anode-cathode ΔP", "mbar", 1, -5, 15, -12, 30, 3, ("dp_an_ca_mbar",),
          "Pressure difference across the thin ceramic electrolyte. Above 30 mbar the cells or seals can break.",
          "Spikes point to a valve or regulator hunting or a blocked line. Check both manifold pressure controls."),
    Check("recycle_dev", "safety", "Anode recycle vs expected", "%", 1, -10, 10, -25, 25, 15, ("recycle_flow_kmol_h", "h2_flow_kg_h", "i_stack_A"),
          "Measured anode recycle flow compared with the flow the anode-loop mass balance requires.",
          "Low recycle means less steam at the anode inlet and a risk of nickel oxidation. Check the recycle blower or ejector and its valves."),
]
CHECK_BY_ID = {c.id: c for c in CHECKS}

UTILITIES = [
    dict(id="hydrogen", name="Hydrogen supply", blurb="Fuel flow and utilisation", icon="fuel",
         key=["h2_flow_kg_h", "i_stack_A"]),
    dict(id="air", name="Cathode air and blower", blurb="Cooling air, blower health", icon="wind",
         key=["air_flow_kg_h", "p_blower_kW"]),
    dict(id="cooling", name="Stack cooling and temperatures", blurb="Thermal limits and heat balance", icon="thermo",
         key=["dT_cath_K", "t_ca_out_C", "t_afterburner_C"]),
    dict(id="electrical", name="Electrical and power conditioning", blurb="Stack, inverter and parasitic loads", icon="bolt",
         key=["v_cell_V", "p_dc_kW", "p_net_kW"]),
    dict(id="steam", name="Steam and water (HRSG)", blurb="Heat recovery and exhaust", icon="steam",
         key=["steam_flow_kg_h", "t_flue_out_C"]),
    dict(id="safety", name="Differential pressure and safety", blurb="Electrolyte protection, anode loop", icon="shield",
         key=["dp_an_ca_mbar", "recycle_flow_kmol_h"]),
]
UTILITY_IDS = [u["id"] for u in UTILITIES]

CHANNEL_UTILITY = {
    "h2_flow_kg_h": "hydrogen", "i_stack_A": "electrical", "air_flow_kg_h": "air", "p_blower_kW": "air",
    "dT_cath_K": "cooling", "t_an_in_C": "cooling", "t_ca_in_C": "cooling", "t_ca_out_C": "cooling", "t_afterburner_C": "cooling",
    "v_cell_V": "electrical", "p_dc_kW": "electrical", "p_net_kW": "electrical",
    "steam_flow_kg_h": "steam", "t_flue_out_C": "steam", "dp_an_ca_mbar": "safety", "recycle_flow_kmol_h": "safety",
}
for u in UTILITIES:
    u["checks"] = [c.id for c in CHECKS if c.utility == u["id"]]
    u["channels"] = sorted({ch for ch, ut in CHANNEL_UTILITY.items() if ut == u["id"]})


# ---------------------------------------------------------------- evaluation
def status_of(check: Check, value: Optional[float]) -> str:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "unknown"
    if (check.alarm_lo is not None and value < check.alarm_lo) or (check.alarm_hi is not None and value > check.alarm_hi):
        return "alarm"
    if (check.warn_lo is not None and value < check.warn_lo) or (check.warn_hi is not None and value > check.warn_hi):
        return "warning"
    return "ok"


def limit_text(check: Check, value: float, severity: str) -> str:
    """Human wording for the limit that was crossed, e.g. 'above the 100 K limit'."""
    hi = check.alarm_hi if severity == "alarm" else check.warn_hi
    lo = check.alarm_lo if severity == "alarm" else check.warn_lo
    u = f" {check.unit}" if check.unit and check.unit not in ("%", "×") else check.unit
    if hi is not None and value > hi:
        return f"above the {hi:g}{u} {severity} limit"
    if lo is not None and value < lo:
        return f"below the {lo:g}{u} {severity} limit"
    return f"outside its {severity} band"


def _mean(buf, ch, n):
    a = buf.get(ch)
    if a is None or len(a) == 0:
        return math.nan
    a = np.asarray(a[-n:], float)
    return float(np.nanmean(a)) if not np.all(np.isnan(a)) else math.nan


def compute_values(buf: dict) -> dict:
    """buf: channel -> array of the last minutes (newest last). Returns check values and helper quantities."""
    g = lambda ch, n=15: _mean(buf, ch, n)
    out = {c.id: math.nan for c in CHECKS}
    out["dp_an_ca"] = g("dp_an_ca_mbar", 3)
    p_dc, p_net, i, v = g("p_dc_kW"), g("p_net_kW"), g("i_stack_A"), g("v_cell_V")
    h2, air, dT = g("h2_flow_kg_h"), g("air_flow_kg_h"), g("dT_cath_K")
    p_blw, rec, steam = g("p_blower_kW"), g("recycle_flow_kmol_h"), g("steam_flow_kg_h")
    t_amb, t_in, t_out = g("t_amb_C"), g("t_ca_in_C"), g("t_ca_out_C")
    out["t_ab"], out["t_flue"], out["t_ca_in_dev"] = g("t_afterburner_C"), g("t_flue_out_C"), t_in - C.T_CA_IN_SET

    n_cons = i * C.N_SERIES * 3600.0 / (2 * C.FARADAY) if not math.isnan(i) else math.nan
    F = h2 / C.MW_H2 if not math.isnan(h2) else math.nan
    if not (math.isnan(n_cons) or math.isnan(F)) and F > 1e-6 and n_cons > 1e-6:
        uf = n_cons / F
        out["h2_uf"] = uf
        out["h2_dev"] = (h2 / (n_cons / C.UF_SET * C.MW_H2) - 1.0) * 100.0
        if not math.isnan(p_dc):
            q_gen = n_cons * C.LHV_H2 / 3600.0 - p_dc
            q_loss = C.LOSS_FRAC * F * C.LHV_H2 / 3600.0
            q_exp = C.F_AIR_SHARE * (q_gen - q_loss)
            if not math.isnan(air) and q_exp > 1.0:
                n_air = air / C.MW_AIR
                out["air_deficit"] = (1.0 - air / (q_exp / (C.CP_EFF * C.DT_SET) * 3600.0 * C.MW_AIR)) * 100.0
                out["air_ratio"] = n_air * C.Y_O2_AIR / (0.5 * n_cons)
                if not math.isnan(dT):
                    out["energy_dev"] = ((n_air * C.CP_EFF * dT / 3600.0) / q_exp - 1.0) * 100.0
            if not math.isnan(steam):
                k = C.RES["Q_hrsg_kW"] / (C.RES["fuel_LHV_kW"] - C.RES["P_dc_kW"] - C.RES["Q_stack_loss_kW"])
                steam_kw = k * (F * C.LHV_H2 / 3600.0 - p_dc - q_loss)
                if steam_kw > 1.0:
                    out["steam_dev"] = (steam / (steam_kw * C.RES["steam_kg_h"] / C.RES["Q_hrsg_kW"]) - 1.0) * 100.0
        if not math.isnan(rec):
            r = C.REC_SET
            ufc = min(max(uf, 0.3), 0.95)
            u = ufc * (1 - r) / (1 - r * ufc)
            S = F / (1 - r * (1 - u))
            exp_rec = r * S * (1 + r * u / (1 - r))
            out["recycle_dev"] = (rec / exp_rec - 1.0) * 100.0
        if not any(math.isnan(x) for x in (v, air, t_in, t_out)):
            try:
                j = i / (C.N_STRINGS * C.CELL_AREA_CM2)
                v_pr, _, _ = plant.voltage_terms(j, t_in, t_out, min(max(uf, 0.3), 0.95), C.REC_SET, air / C.MW_AIR, n_cons)
                out["v_loss"] = (1.0 - v / float(v_pr)) * 100.0
            except Exception:
                pass
    if not math.isnan(air) and not math.isnan(p_blw) and not math.isnan(t_amb):
        n_air_d = C.RES["n_air_kmol_s"] * 3600.0
        p_exp = C.RES["P_blower_kW"] * ((air / C.MW_AIR) / n_air_d) ** 2.6 * (t_amb + 273.15) / 303.15
        out["blower_dev"] = (p_blw / p_exp - 1.0) * 100.0 if p_exp > 0.5 else math.nan
    if not (math.isnan(p_dc) or math.isnan(i) or math.isnan(v)):
        out["faraday_res"] = p_dc - i * v * C.N_SERIES / 1000.0
        if not (math.isnan(p_net) or math.isnan(p_blw) or math.isnan(rec)):
            p_rec = C.RES["P_recycle_kW"] * rec / 4.093
            out["balance_res"] = p_net - (p_dc * C.ETA_INV - p_blw - p_rec - C.P_AUX_KW)
    out["dT_cath"] = dT
    return out
