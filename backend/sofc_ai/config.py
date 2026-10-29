"""Central constants. Everything physical is calibrated to the Phase 1 baseline (sofc_baseline.py)."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
BASELINE = json.loads((ROOT / "data" / "baseline_results.json").read_text())
RES = BASELINE["results"]
STREAMS = BASELINE["streams_kmol_h"]

# ---- constants
FARADAY = 96485332.0        # C/kmol e-
R_GAS = 8.314462            # J/(mol K)
LHV_H2 = 241830.0           # kJ/kmol
MW_H2, MW_AIR = 2.016, 28.685

# ---- stack layout (Phase 1 utility workbook)
N_SERIES = 732              # cells per string
N_STRINGS = 3
N_CELLS = N_SERIES * N_STRINGS
CELL_AREA_CM2 = 200.0
J_DESIGN = 0.40             # A/cm2
V_DESIGN = 0.75             # V per cell at design
ASR0 = 0.25                 # ohm cm2 at 700 C, new stack
EA_OHM = 80e3               # J/mol, ohmic (electrolyte) activation energy
EA_ACT = 100e3              # J/mol, exchange-current activation energy
T_REF_K = 973.15
J_LIM = 1.6                 # A/cm2, limiting current density
ETA_ACT_DESIGN = 0.06       # V at design point (calibration target)
ETA_CONC_DESIGN = 0.04      # V at design point (calibration target)

# ---- operating basis (locked first basis)
UF_SET = 0.80
REC_SET = 0.50
T_CA_IN_SET = 650.0
DT_SET = 97.0               # K, controller setpoint (3 K under the 100 K limit)
DT_LIMIT = 100.0
DP_LIMIT_MBAR = 30.0        # membrane / seal break limit
DP_WARN_MBAR = 15.0         # warning band, half the break limit
UF_BOUNDS = (0.70, 0.88)
P_STACK_BAR = 1.15
ETA_INV = 0.965
P_AUX_KW = 2.0
LOSS_FRAC = 0.015
Y_O2_AIR = 0.204333
F_AIR_SHARE = RES["Q_cathode_air_kW"] / (RES["Q_gen_kW"] - RES["Q_stack_loss_kW"])   # share of stack heat taken by cathode air
CP_EFF = RES["Q_cathode_air_kW"] / (RES["n_air_kmol_s"] * 100.0)                       # kJ/(kmol K), calibrated effective
CP_FLUE = 32.9
EOL_FRACTION = 0.10         # end of life: 10 % voltage loss at design conditions

# sensor noise (1 sigma)
NOISE = dict(v_cell_V=0.002, t_K=1.5, flow_rel=0.005, dp_mbar=0.8, p_kW=0.15, t_amb=0.3, rh=0.01, i_A=0.4)

TELEMETRY_CHANNELS = [
    "t_amb_C", "rh_amb", "load_set", "i_stack_A", "v_cell_V", "p_dc_kW", "p_net_kW",
    "t_an_in_C", "t_ca_in_C", "t_ca_out_C", "dT_cath_K", "h2_flow_kg_h", "air_flow_kg_h",
    "recycle_flow_kmol_h", "steam_flow_kg_h", "dp_an_ca_mbar", "p_blower_kW",
    "t_afterburner_C", "t_flue_out_C",
]
FAULT_CODES = {"normal": 0, "blower_fade": 1, "h2_restriction": 2, "recycle_loss": 3,
               "dp_excursion": 4, "thermal_gradient": 5, "sensor_drift": 6}
HEALTH_FEATURES = ["op_hours", "v_cell_V", "j_Acm2", "t_stack_C", "air_ratio", "p_blower_kW", "air_flow_kg_h",
                   "dT_cath_K", "t_amb_C", "load_mean", "uf_est", "p_net_kW", "cycles_24h", "cycles_total"]


def set_baseline(baseline_data: dict, persist: bool = True) -> dict:
    """Updates active baseline results and derived plant constants."""
    global BASELINE, RES, STREAMS, F_AIR_SHARE, CP_EFF
    if "results" in baseline_data:
        RES.update(baseline_data["results"])
        BASELINE["results"] = RES
        if "streams_kmol_h" in baseline_data:
            STREAMS.update(baseline_data["streams_kmol_h"])
            BASELINE["streams_kmol_h"] = STREAMS
        if "basis" in baseline_data:
            BASELINE.setdefault("basis", {}).update(baseline_data["basis"])
    else:
        # Flat dictionary of results
        RES.update(baseline_data)
        BASELINE["results"] = RES

    # Keep n_air_kmol_s and air_kmol_h in sync
    if "air_kmol_h" in RES and "n_air_kmol_s" not in baseline_data:
        RES["n_air_kmol_s"] = RES["air_kmol_h"] / 3600.0
    elif "n_air_kmol_s" in RES and "air_kmol_h" not in RES:
        RES["air_kmol_h"] = RES["n_air_kmol_s"] * 3600.0

    if "air_kmol_h" in RES and "air" in STREAMS:
        old_air_sum = sum(STREAMS["air"].values())
        if old_air_sum > 0:
            scale_fac = RES["air_kmol_h"] / old_air_sum
            STREAMS["air"] = {k: v * scale_fac for k, v in STREAMS["air"].items()}
            BASELINE["streams_kmol_h"] = STREAMS

    # Keep Q_cathode_air_kW in sync with air flow if not explicitly overridden
    if ("air_kmol_h" in RES or "n_air_kmol_s" in RES) and "Q_cathode_air_kW" not in baseline_data.get("results", baseline_data):
        RES["Q_cathode_air_kW"] = round(float(RES["n_air_kmol_s"] * 100.0 * 28.8188), 3)

    raw_f_share = RES.get("Q_cathode_air_kW", 71.28) / max(1e-6, RES.get("Q_gen_kW", 88.32) - RES.get("Q_stack_loss_kW", 4.12))
    F_AIR_SHARE = float(max(0.70, min(0.95, raw_f_share)))

    raw_cp_eff = RES.get("Q_cathode_air_kW", 71.28) / max(1e-6, RES.get("n_air_kmol_s", 0.02473) * 100.0)
    CP_EFF = float(max(25.0, min(35.0, raw_cp_eff)))

    if persist:
        try:
            (ROOT / "data" / "baseline_results.json").write_text(json.dumps(BASELINE, indent=2), encoding="utf-8")
        except Exception:
            pass
        try:
            aspen_base = ROOT.parents[0] / "aspen" / "baseline_results.json"
            if aspen_base.exists():
                aspen_base.write_text(json.dumps(BASELINE, indent=2), encoding="utf-8")
        except Exception:
            pass

    return BASELINE

