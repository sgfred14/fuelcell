"""
Quasi-steady, vectorised model of the 100 kW H2-fed SOFC plant.

It reproduces the Phase 1 design point (0.75 V, Uf 0.80, 50 % recycle, ~100 kW net) and responds to load,
ambient temperature, stack degradation and fault parameters with the same physics used in Phase 1:
Faraday current, Nernst potential from the anode gas composition, ohmic / activation / concentration losses,
stack heat balance removed by cathode air, afterburner temperature, HRSG steam from the heat balance.

This is a reduced-order model. It is calibrated at ONE point (the Phase 1 baseline) and has not been
validated against measurements of a real stack.
"""
import numpy as np

from . import config as C


def _arr(a):
    return np.asarray(a, dtype=float)


def _nernst_end(T_K, ratio_h2_h2o, y_o2):
    E0 = 1.2723 - 2.7645e-4 * T_K
    pO2 = np.maximum(y_o2 * C.P_STACK_BAR, 1e-12)
    ratio_safe = np.maximum(ratio_h2_h2o, 1e-12)
    arg = np.maximum(ratio_safe * np.sqrt(pO2), 1e-12)
    return E0 + C.R_GAS * T_K / (2 * C.FARADAY / 1000.0) * np.log(arg)


# ---- calibration of activation exchange current and concentration constant at the design point
_FRT = C.FARADAY / 1000.0 / (C.R_GAS * C.T_REF_K)
J0_REF = C.J_DESIGN / (2 * np.sinh(C.ETA_ACT_DESIGN * _FRT))
K_CONC = C.ETA_CONC_DESIGN / ((C.J_DESIGN / C.J_LIM) / (1 - C.J_DESIGN / C.J_LIM))
_E_OFF = 0.0   # set by calibrate()


def arrhenius_ohm(T_mean_K):
    return np.exp(C.EA_OHM / C.R_GAS * (1.0 / T_mean_K - 1.0 / C.T_REF_K))


def voltage_terms(j, T_in_C, T_out_C, uf, rec, n_air, n_cons, e_off=None):
    """Return pristine cell voltage (no ageing) and the unit ohmic coefficient (V per unit asr multiplier)."""
    e_off = _E_OFF if e_off is None else e_off
    rec = np.clip(rec, 0.05, 0.85)
    uf_cl = np.clip(uf, 0.05, 0.999)
    u = uf_cl * (1 - rec) / (1 - rec * uf_cl)
    r_in = (1 - rec) / max(float(np.mean(rec * u)), 1e-6)
    r_out = np.maximum((1 - u) * (1 - rec) / np.maximum(u, 1e-6), 1e-6)
    o2_rem = np.maximum(n_air * C.Y_O2_AIR - 0.5 * n_cons, 1e-6)
    air_rem = np.maximum(n_air - 0.5 * n_cons, 1e-6)
    y_out = np.clip(o2_rem / air_rem, 1e-6, 1.0)
    E_in = _nernst_end(T_in_C + 273.15, r_in, C.Y_O2_AIR)
    E_out = _nernst_end(T_out_C + 273.15, r_out, y_out)
    E_avg = 0.5 * (E_in + E_out)
    T_mean_K = 0.5 * (T_in_C + T_out_C) + 273.15
    k_ohm = j * C.ASR0 * arrhenius_ohm(T_mean_K)                       # V per unit multiplier
    j0 = J0_REF * np.exp(-C.EA_ACT / C.R_GAS * (1 / T_mean_K - 1 / C.T_REF_K))
    eta_act = (C.R_GAS * T_mean_K / (C.FARADAY / 1000.0)) * np.arcsinh(j / (2 * j0))
    jl = np.minimum(j / C.J_LIM, 0.95)
    eta_conc = K_CONC * (jl / (1 - jl)) * (uf / C.UF_SET) ** 2
    v_pristine = np.maximum(E_avg + e_off - k_ohm - eta_act - eta_conc, 0.05)          # includes the ASR0 ohmic loss once (multiplier 1)
    return v_pristine, k_ohm, T_mean_K


def operating_point(load, t_amb=30.0, asr_mult=1.0, d_act=0.0, uf_set=C.UF_SET, rec=C.REC_SET,
                    dT_set=C.DT_SET, n_air=None, h2_restr=0.0, blower_eff=1.0, t_ca_in=C.T_CA_IN_SET):
    """Noise-free steady-state operating point. All inputs broadcast. Returns dict of arrays.

    load      fraction of design current density (1.0 = 0.40 A/cm2)
    asr_mult  ohmic ageing multiplier (1 = new)         d_act  extra activation loss (V)
    n_air     override air flow (kmol/h); None = controller demand for dT_set
    h2_restr  fraction of demanded H2 not delivered     blower_eff relative blower efficiency (1 = new)
    """
    load, t_amb, asr_mult, d_act, rec = map(_arr, (load, t_amb, asr_mult, d_act, rec))
    j = C.J_DESIGN * load
    I_string = j * C.CELL_AREA_CM2
    I_stack = C.N_STRINGS * I_string
    n_cons = C.N_CELLS * j * C.CELL_AREA_CM2 * 3600.0 / (2 * C.FARADAY)      # kmol/h
    F_dem = n_cons / uf_set
    F_act = F_dem * (1 - _arr(h2_restr))
    uf_act = np.minimum(n_cons / F_act, 0.97)
    t_ca_in = _arr(t_ca_in) + 0.12 * (t_amb - 30.0)                           # small ambient disturbance on preheat

    shape = np.broadcast(j, t_amb, asr_mult, rec, d_act, _arr(h2_restr), _arr(blower_eff)).shape
    T_out = np.broadcast_to(t_ca_in + C.DT_SET, shape).astype(float).copy()
    n_air_d = C.RES["n_air_kmol_s"] * 3600.0
    air_given = None if n_air is None else np.broadcast_to(_arr(n_air), shape).astype(float)
    n_air_cur = np.full(shape, n_air_d) if air_given is None else air_given.copy()
    for _ in range(6):                                                        # fixed point: V -> heat -> air -> T_out -> V
        v_pr, k_ohm, T_mean_K = voltage_terms(j, t_ca_in, T_out, uf_act, rec, n_air_cur, n_cons)
        v_cell = v_pr - k_ohm * (asr_mult - 1.0) - d_act
        p_dc = v_cell * I_stack * C.N_SERIES / 1000.0
        q_gen = n_cons * C.LHV_H2 / 3600.0 - p_dc
        q_loss = C.LOSS_FRAC * F_act * C.LHV_H2 / 3600.0
        q_cath = C.F_AIR_SHARE * (q_gen - q_loss)
        if air_given is None:
            n_air_cur = q_cath / (C.CP_EFF * dT_set) * 3600.0
            dT = np.full_like(T_out, dT_set)
        else:
            dT = np.clip(q_cath / (C.CP_EFF * np.maximum(n_air_cur, 1e-3) / 3600.0), 5.0, 500.0)
        T_out = t_ca_in + dT
    air_ratio = n_air_cur * C.Y_O2_AIR / (0.5 * n_cons)
    fuel_kw = F_act * C.LHV_H2 / 3600.0
    flow_ratio = n_air_cur / n_air_d
    p_blw = C.RES["P_blower_kW"] * flow_ratio ** 2.6 / np.clip(blower_eff, 0.4, 1.2) * (t_amb + 273.15) / 303.15
    S = F_act / (1 - rec * (1 - uf_act * (1 - rec) / (1 - rec * uf_act)))
    u_pass = uf_act * (1 - rec) / (1 - rec * uf_act)
    an_out_total = S * (1 + rec * u_pass / (1 - rec))
    recycle = rec * an_out_total
    rec_d = sum(C.STREAMS.get("recycle", {}).values()) if "recycle" in C.STREAMS else 4.093
    p_rec = C.RES["P_recycle_kW"] * recycle / max(1e-6, rec_d)
    p_net = p_dc * C.ETA_INV - p_blw - p_rec - C.P_AUX_KW
    n_flue = n_air_cur + 0.5 * F_act
    q_burn = F_act * (1 - uf_act) * C.LHV_H2 / 3600.0
    t_ab = T_out + q_burn / (n_flue / 3600.0 * C.CP_FLUE)
    q_flue = fuel_kw - p_dc - q_loss
    steam_kw = (C.RES["Q_hrsg_kW"] / max(1e-6, C.RES["fuel_LHV_kW"] - C.RES["P_dc_kW"] - C.RES["Q_stack_loss_kW"])) * q_flue
    steam = steam_kw * C.RES["steam_kg_h"] / max(1e-6, C.RES["Q_hrsg_kW"])
    cathode_ratio = flow_ratio
    s_d = C.STREAMS.get("an_in", {}).get("H2", 4.9116) if "an_in" in C.STREAMS else 4.9116
    anode_ratio = S / max(1e-6, s_d)
    dp_an_ca = 5.0 + 6.0 * (anode_ratio ** 1.7 - cathode_ratio ** 1.8)
    t_exit_d = float(C.RES.get("T_stack_exit_C", 132.7))
    return dict(
        load=load, j_Acm2=j, i_stack_A=I_stack, v_cell_V=v_cell, p_dc_kW=p_dc, p_net_kW=p_net,
        t_an_in_C=t_ca_in + 0 * j, t_ca_in_C=t_ca_in + 0 * j, t_ca_out_C=T_out, t_an_out_C=T_out, dT_cath_K=dT,
        h2_flow_kg_h=F_act * C.MW_H2, air_flow_kg_h=n_air_cur * C.MW_AIR, air_kmol_h=n_air_cur,
        recycle_flow_kmol_h=recycle, steam_flow_kg_h=steam, dp_an_ca_mbar=dp_an_ca, p_blower_kW=p_blw,
        t_afterburner_C=t_ab, t_flue_out_C=t_exit_d + 0.35 * (t_amb - 30.0) - 6.0 * (steam_kw / max(1e-6, C.RES["Q_hrsg_kW"]) - 1.0),
        n_cons_kmolh=n_cons, uf_act=uf_act, air_ratio=air_ratio, t_stack_C=T_mean_K - 273.15,
        q_gen_kW=q_gen, q_loss_kW=q_loss, q_cath_kW=q_cath, fuel_kW=fuel_kw, t_amb_C=t_amb + 0 * j,
        v_pristine_V=v_pr, k_ohm_V=k_ohm,
    )


def calibrate():
    """Fix the Nernst offset so the design point gives exactly 0.75 V per cell."""
    global _E_OFF
    _E_OFF = 0.0
    for _ in range(6):
        op = operating_point(1.0, 30.0)
        _E_OFF += C.V_DESIGN - float(op["v_cell_V"])
    return _E_OFF


E_OFFSET = calibrate()


def reference_voltage(asr_mult, d_act):
    """Cell voltage at the fixed design condition (load 1, 30 degC): the physical health indicator."""
    op = operating_point(1.0, 30.0, asr_mult=asr_mult, d_act=d_act)
    return op["v_cell_V"]


V_REF_NEW = float(reference_voltage(1.0, 0.0))


def degradation_fraction(asr_mult, d_act):
    return 1.0 - reference_voltage(asr_mult, d_act) / V_REF_NEW


def recalibrate():
    """Recalibrate activation, concentration and Nernst offset constants when baseline changes."""
    global _FRT, J0_REF, K_CONC, _E_OFF, E_OFFSET, V_REF_NEW
    _FRT = C.FARADAY / 1000.0 / (C.R_GAS * C.T_REF_K)
    J0_REF = C.J_DESIGN / (2 * np.sinh(C.ETA_ACT_DESIGN * _FRT))
    K_CONC = C.ETA_CONC_DESIGN / ((C.J_DESIGN / C.J_LIM) / (1 - C.J_DESIGN / C.J_LIM))
    _E_OFF = 0.0
    E_OFFSET = calibrate()
    V_REF_NEW = float(reference_voltage(1.0, 0.0))
    return E_OFFSET


def set_baseline(baseline_data: dict, persist: bool = True) -> dict:
    """Sets new baseline results into the plant model and recalibrates."""
    base = C.set_baseline(baseline_data, persist=persist)
    recalibrate()
    return base



if __name__ == "__main__":
    op = operating_point(1.0, 30.0)
    for k in ["v_cell_V", "p_dc_kW", "p_net_kW", "h2_flow_kg_h", "air_flow_kg_h", "air_ratio", "dT_cath_K",
              "t_afterburner_C", "steam_flow_kg_h", "p_blower_kW", "recycle_flow_kmol_h", "dp_an_ca_mbar", "t_flue_out_C"]:
        print(f"{k:22s} {float(op[k]):10.3f}")
    print("E_offset", E_OFFSET)
