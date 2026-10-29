"""
Physics residuals built from the Phase 1 constraints. Zero (or inside its bound) means "physically consistent".

  r_far     DC power vs current x voltage x cells in series          (sensor / wiring consistency)
  r_net     net AC power vs DC power x inverter eff. - parasitic loads (power balance)
  r_uf      fuel utilisation from Faraday current and H2 flow vs the 0.70-0.88 band
  r_energy  heat picked up by cathode air vs heat released by the cell reaction (stack energy balance)
  r_dT      cathode temperature rise above the 100 K limit
  r_dp      anode-cathode differential pressure above the 15 mbar warning band (break limit is 30 mbar)

All residuals are scaled so that ~1 is "worth noticing". Signals are smoothed with a causal rolling mean
(default 15 min) so sensor noise does not trip the limits, as a real alarm would.
"""
import numpy as np
import pandas as pd

from . import config as C

RESIDUALS = ["r_far", "r_net", "r_uf", "r_energy", "r_dT", "r_dp"]
SCALES = dict(r_far=1.0, r_net=1.0, r_uf=0.03, r_energy=0.05, r_dT=5.0, r_dp=5.0)
_COLS = ["p_dc_kW", "p_net_kW", "i_stack_A", "v_cell_V", "h2_flow_kg_h", "air_flow_kg_h", "dT_cath_K",
         "dp_an_ca_mbar", "p_blower_kW", "recycle_flow_kmol_h"]


def residuals_from_arrays(p_dc, p_net, i_stack, v_cell, h2_kgh, air_kgh, dT, dp, p_blw, recycle):
    n_cons = i_stack * C.N_SERIES * 3600.0 / (2 * C.FARADAY)                    # kmol/h
    F = h2_kgh / C.MW_H2
    uf = n_cons / np.maximum(F, 1e-6)
    q_gen = n_cons * C.LHV_H2 / 3600.0 - p_dc
    q_loss = C.LOSS_FRAC * F * C.LHV_H2 / 3600.0
    q_exp = C.F_AIR_SHARE * (q_gen - q_loss)
    q_meas = (air_kgh / C.MW_AIR) * C.CP_EFF * dT / 3600.0
    p_rec = C.RES["P_recycle_kW"] * recycle / 4.093
    out = {
        "r_far": (p_dc - i_stack * v_cell * C.N_SERIES / 1000.0),
        "r_net": (p_net - (p_dc * C.ETA_INV - p_blw - p_rec - C.P_AUX_KW)),
        "r_uf": np.maximum(uf - C.UF_BOUNDS[1], 0) + np.maximum(C.UF_BOUNDS[0] - uf, 0) + np.abs(uf - C.UF_SET) * 0.25,
        "r_energy": (q_meas - q_exp) / np.maximum(q_exp, 1.0),
        "r_dT": np.maximum(dT - C.DT_LIMIT, 0),
        "r_dp": np.maximum(dp - C.DP_WARN_MBAR, 0),
    }
    return {k: v / SCALES[k] for k, v in out.items()}


def residual_frame(df, window=15, dp_window=3):
    """Residuals for a telemetry DataFrame (needs run_id and channel columns), causal smoothing per run.
    Differential pressure uses a short window so that brief spikes are not averaged away."""
    parts = []
    for _, g in df.groupby("run_id", sort=False):
        sm = g[_COLS].rolling(window, min_periods=1).mean()
        sm["dp_an_ca_mbar"] = g["dp_an_ca_mbar"].rolling(dp_window, min_periods=1).mean()
        res = residuals_from_arrays(*[sm[c].to_numpy() for c in
                                      ["p_dc_kW", "p_net_kW", "i_stack_A", "v_cell_V", "h2_flow_kg_h",
                                       "air_flow_kg_h", "dT_cath_K", "dp_an_ca_mbar", "p_blower_kW", "recycle_flow_kmol_h"]])
        parts.append(pd.DataFrame(res, index=g.index))
    return pd.concat(parts).loc[df.index]
