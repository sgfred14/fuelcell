"""
Thermodynamic calculations and polarization curve generation for the SOFC plant.
Uses physical equations calibrated to the 100 kW SOFC stack.
"""
import math
import numpy as np
from sofc_ai import config as C
from sofc_ai import plant


def compute_polarization(
    temperature_C: float = 700.0,
    asr_multiplier: float = 1.12,
    degradation_V: float = 0.012,
    fuel_utilization: float = 0.80,
    recycle_ratio: float = 0.50,
    j_min: float = 0.02,
    j_max: float = 1.45,
    n_points: int = 70,
):
    """
    Computes I-V, V-j, and P-I characteristic curves with complete overpotential breakdown.
    """
    j_range = np.linspace(j_min, j_max, n_points)
    i_stack = j_range * C.CELL_AREA_CM2 * C.N_STRINGS  # Amperes (200 cm2 * 3 strings)
    
    # Air flow estimated to maintain thermal balance
    t_in = float(temperature_C)
    t_out = t_in + C.DT_SET
    t_mean_K = 0.5 * (t_in + t_out) + 273.15
    
    # Recalibrate/clamp inputs
    rec = np.clip(recycle_ratio, 0.05, 0.85)
    uf = np.clip(fuel_utilization, 0.30, 0.95)
    
    u = uf * (1 - rec) / (1 - rec * uf)
    r_in = (1 - rec) / (rec * u)
    r_out = (1 - u) * (1 - rec) / u
    
    # Estimate molar consumption for each j
    n_cons = C.N_CELLS * j_range * C.CELL_AREA_CM2 * 3600.0 / (2 * C.FARADAY)
    # Target air flow scaled from design
    n_air_design = float(C.RES.get("air_kmol_h", C.RES["n_air_kmol_s"] * 3600.0))
    n_air = np.maximum(n_air_design * (j_range / C.J_DESIGN), 20.0)
    y_out = (n_air * C.Y_O2_AIR - 0.5 * n_cons) / np.maximum(n_air - 0.5 * n_cons, 1e-4)
    
    # Reversible Nernst Potential
    E_in = plant._nernst_end(t_in + 273.15, r_in, C.Y_O2_AIR)
    E_out = plant._nernst_end(t_out + 273.15, r_out, y_out)
    E_avg = 0.5 * (E_in + E_out)
    v_nernst = E_avg + plant._E_OFF
    
    # Ohmic Loss (Arrhenius temperature dependence * ASR multiplier)
    k_ohm_unit = j_range * C.ASR0 * plant.arrhenius_ohm(t_mean_K)
    eta_ohmic = k_ohm_unit * asr_multiplier
    
    # Activation Loss (Butler-Volmer)
    j0 = plant.J0_REF * np.exp(-C.EA_ACT / C.R_GAS * (1 / t_mean_K - 1 / C.T_REF_K))
    eta_act = (C.R_GAS * t_mean_K / (C.FARADAY / 1000.0)) * np.arcsinh(j_range / (2 * j0))
    
    # Concentration Loss (Mass transport limitation near j_lim)
    jl = np.minimum(j_range / C.J_LIM, 0.96)
    eta_conc = plant.K_CONC * (jl / (1.0 - jl)) * (uf / C.UF_SET) ** 2
    
    # Net Cell Voltage
    v_cell = v_nernst - eta_ohmic - eta_act - eta_conc - degradation_V
    v_cell = np.maximum(v_cell, 0.05)  # Physical lower bound
    
    # Stack totals
    v_stack = v_cell * C.N_SERIES
    p_dc = v_stack * i_stack / 1000.0  # kW
    p_density = j_range * v_cell  # W/cm2
    
    # Estimate auxiliary parasitic loads (blower, recycle, inverter)
    p_blw = C.RES["P_blower_kW"] * (n_air / max(1e-6, n_air_design)) ** 2.6
    p_rec = C.RES.get("P_recycle_kW", 1.66) * (j_range / C.J_DESIGN)
    p_net = p_dc * C.ETA_INV - p_blw - p_rec - C.P_AUX_KW
    p_net = np.maximum(p_net, -10.0)
    
    # Maximum Power Point (MPP)
    mpp_idx = int(np.argmax(p_dc))
    mpp = {
        "j": round(float(j_range[mpp_idx]), 4),
        "i": round(float(i_stack[mpp_idx]), 1),
        "v_cell": round(float(v_cell[mpp_idx]), 4),
        "v_stack": round(float(v_stack[mpp_idx]), 1),
        "p_dc": round(float(p_dc[mpp_idx]), 2),
        "p_density": round(float(p_density[mpp_idx]), 3),
    }
    
    return {
        "j_range": [round(float(x), 4) for x in j_range],
        "i_stack": [round(float(x), 1) for x in i_stack],
        "v_cell": [round(float(x), 4) for x in v_cell],
        "v_stack": [round(float(x), 1) for x in v_stack],
        "v_nernst": [round(float(x), 4) for x in v_nernst],
        "eta_ohmic": [round(float(x), 4) for x in eta_ohmic],
        "eta_act": [round(float(x), 4) for x in eta_act],
        "eta_conc": [round(float(x), 4) for x in eta_conc],
        "p_dc": [round(float(x), 2) for x in p_dc],
        "p_density": [round(float(x), 3) for x in p_density],
        "p_net": [round(float(x), 2) for x in p_net],
        "mpp": mpp,
    }


def compute_thermodynamic_state(values: dict):
    """
    Computes in-depth thermodynamic state from current plant telemetry values.
    """
    if not values:
        return {"available": False}
        
    i_stack = values.get("i_stack_A")
    v_cell = values.get("v_cell_V")
    p_dc = values.get("p_dc_kW")
    p_net = values.get("p_net_kW")
    h2_flow = values.get("h2_flow_kg_h")
    air_flow = values.get("air_flow_kg_h")
    t_in = values.get("t_ca_in_C")
    t_out = values.get("t_ca_out_C")
    t_ab = values.get("t_afterburner_C")
    t_flue = values.get("t_flue_out_C")
    p_blw = values.get("p_blower_kW", 0.0)
    recycle = values.get("recycle_flow_kmol_h", 0.0)
    steam = values.get("steam_flow_kg_h", 0.0)
    load = values.get("load_set", 0.8)
    
    if None in (i_stack, v_cell, h2_flow, air_flow, t_in, t_out):
        return {"available": False}
        
    j = i_stack / (C.N_STRINGS * C.CELL_AREA_CM2)
    n_cons = C.N_CELLS * j * C.CELL_AREA_CM2 * 3600.0 / (2 * C.FARADAY)
    F = h2_flow / C.MW_H2
    uf = min(max(n_cons / max(F, 1e-5), 0.3), 0.95)
    
    t_mean_K = 0.5 * (t_in + t_out) + 273.15
    n_air = air_flow / C.MW_AIR
    
    # Overpotential breakdown
    v_pristine, k_ohm, _ = plant.voltage_terms(j, t_in, t_out, uf, C.REC_SET, n_air, n_cons)
    
    rec = C.REC_SET
    u = uf * (1 - rec) / (1 - rec * uf)
    r_in = (1 - rec) / (rec * u)
    r_out = (1 - u) * (1 - rec) / u
    y_out = (n_air * C.Y_O2_AIR - 0.5 * n_cons) / max(n_air - 0.5 * n_cons, 1e-4)
    
    E_in = plant._nernst_end(t_in + 273.15, r_in, C.Y_O2_AIR)
    E_out = plant._nernst_end(t_out + 273.15, r_out, y_out)
    nernst = 0.5 * (E_in + E_out) + plant._E_OFF
    
    j0 = plant.J0_REF * np.exp(-C.EA_ACT / C.R_GAS * (1 / t_mean_K - 1 / C.T_REF_K))
    eta_act = (C.R_GAS * t_mean_K / (C.FARADAY / 1000.0)) * np.arcsinh(j / (2 * j0))
    jl = min(j / C.J_LIM, 0.95)
    eta_conc = plant.K_CONC * (jl / (1 - jl)) * (uf / C.UF_SET) ** 2
    
    # Ohmic loss from actual vs nernst-act-conc
    eta_ohmic = max(nernst - v_cell - eta_act - eta_conc, 0.0)
    
    # Energy balances
    fuel_kw = F * C.LHV_H2 / 3600.0
    q_gen = n_cons * C.LHV_H2 / 3600.0 - (p_dc or 0.0)
    q_loss = C.LOSS_FRAC * fuel_kw
    q_cath = (air_flow / C.MW_AIR) * C.CP_EFF * (t_out - t_in) / 3600.0
    
    # Tail gas combustor heat
    q_afterburner = F * (1.0 - uf) * C.LHV_H2 / 3600.0
    
    # HRSG Heat
    q_hrsg = C.RES["Q_hrsg_kW"] * (steam / max(C.RES["steam_kg_h"], 1e-3)) if steam else 0.0
    
    # Efficiencies
    # Thermodynamic reversible efficiency (Gibbs free energy / LHV)
    eff_rev = (1.2723 - 2.7645e-4 * t_mean_K) / (C.LHV_H2 / (2 * C.FARADAY / 1000.0)) * 100.0
    eff_voltage = (v_cell / max(nernst, 1e-3)) * 100.0
    eff_electrical = ((p_net or (p_dc or 0.0) * 0.95) / max(fuel_kw, 1e-3)) * 100.0
    eff_chp = (((p_net or 0.0) + q_hrsg) / max(fuel_kw, 1e-3)) * 100.0
    
    air_ratio = n_air * C.Y_O2_AIR / max(0.5 * n_cons, 1e-4)
    
    return {
        "available": True,
        "nernst_V": round(float(nernst), 4),
        "v_cell_V": round(float(v_cell), 4),
        "v_stack_V": round(float(v_cell * C.N_SERIES), 1),
        "eta_ohmic_V": round(float(eta_ohmic), 4),
        "eta_act_V": round(float(eta_act), 4),
        "eta_conc_V": round(float(eta_conc), 4),
        "p_dc_kW": round(float(p_dc), 1) if p_dc else None,
        "p_net_kW": round(float(p_net), 1) if p_net else None,
        "fuel_energy_kW": round(float(fuel_kw), 1),
        "efficiency_rev_pct": round(float(eff_rev), 1),
        "efficiency_voltage_pct": round(float(eff_voltage), 1),
        "efficiency_electrical_pct": round(float(eff_electrical), 1),
        "efficiency_chp_pct": round(float(eff_chp), 1),
        "q_gen_kW": round(float(q_gen), 1),
        "q_cath_kW": round(float(q_cath), 1),
        "q_loss_kW": round(float(q_loss), 2),
        "q_afterburner_kW": round(float(q_afterburner), 1),
        "q_hrsg_kW": round(float(q_hrsg), 1),
        "fuel_utilization": round(float(uf), 3),
        "air_ratio": round(float(air_ratio), 1),
        "t_stack_C": round(float(t_mean_K - 273.15), 1),
        "t_ca_in_C": round(float(t_in), 1),
        "t_ca_out_C": round(float(t_out), 1),
        "dT_cath_K": round(float(t_out - t_in), 1),
        "t_afterburner_C": round(float(t_ab), 1) if t_ab else None,
        "t_flue_out_C": round(float(t_flue), 1) if t_flue else None,
        "h2_flow_kg_h": round(float(h2_flow), 2),
        "air_flow_kg_h": round(float(air_flow), 0),
        "steam_flow_kg_h": round(float(steam), 1) if steam else None,
        "load_pct": round(float(load * 100.0), 0) if load else None,
    }


def compute_parameter_sweep(
    parameter: str,
    min_val: float,
    max_val: float,
    steps: int = 25,
    temperature_C: float = 700.0,
    asr_multiplier: float = 1.12,
    degradation_V: float = 0.012,
    fuel_utilization: float = 0.80,
    load_set: float = 0.80,
):
    """
    Sweeps one operating parameter while keeping others constant.
    """
    vals = np.linspace(min_val, max_val, steps)
    results = []
    
    for v in vals:
        t_in = temperature_C
        asr = asr_multiplier
        d_act = degradation_V
        uf = fuel_utilization
        ld = load_set
        
        if parameter == "temperature":
            t_in = float(v)
        elif parameter == "load":
            ld = float(v)
        elif parameter == "asr":
            asr = float(v)
        elif parameter == "utilization":
            uf = float(v)
        elif parameter == "degradation":
            d_act = float(v)
            
        op = plant.operating_point(
            load=ld,
            t_amb=30.0,
            asr_mult=asr,
            d_act=d_act,
            uf_set=uf,
            rec=C.REC_SET,
            t_ca_in=t_in,
        )
        
        fuel_kw = float(op["fuel_kW"])
        p_net = float(op["p_net_kW"])
        eff = (p_net / max(fuel_kw, 1.0)) * 100.0
        
        results.append({
            "param_value": round(float(v), 3),
            "v_cell_V": round(float(op["v_cell_V"]), 4),
            "p_dc_kW": round(float(op["p_dc_kW"]), 2),
            "p_net_kW": round(p_net, 2),
            "efficiency_pct": round(float(eff), 1),
            "dT_cath_K": round(float(op["dT_cath_K"]), 1),
            "air_flow_kg_h": round(float(op["air_flow_kg_h"]), 0),
            "h2_flow_kg_h": round(float(op["h2_flow_kg_h"]), 2),
        })
        
    return results
