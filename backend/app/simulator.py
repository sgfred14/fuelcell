"""
Demo feed. Plays a simulated plant (sofc_ai.telemetry) into the SAME Detector.ingest path that the HTTP endpoint uses.
One reading = one plant minute. `interval_s` is the wall-clock time per plant minute (0.5 s = 2 plant minutes per second).
Faults can be injected and cleared from the dashboard. The detector never sees the fault label: it is only shown in
the UI so the detection delay can be read off.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sofc_ai import telemetry

from . import checks as K

log = logging.getLogger("monitor.sim")

FAULTS = {
    "blower_fade": dict(label="Air blower fade", utility="air", severity=None,
                        text="Blower capacity and efficiency fall; air cannot keep up at high load."),
    "h2_restriction": dict(label="Hydrogen supply restriction", utility="hydrogen", severity=None,
                           text="12 % of the demanded H₂ stops arriving; fuel utilisation climbs."),
    "recycle_loss": dict(label="Anode recycle loss", utility="safety", severity=None,
                         text="Recycle flow drops; less steam reaches the anode inlet."),
    "dp_excursion": dict(label="Differential-pressure spikes", utility="safety", severity=None,
                         text="Repeated anode-cathode ΔP spikes above the warning band."),
    "thermal_gradient": dict(label="Air maldistribution", utility="cooling", severity=None,
                             text="The real cathode temperature rise exceeds what the measured air flow explains."),
    "sensor_drift": dict(label="Thermocouple drift", utility="cooling", severity=1.5,
                         text="The cathode-outlet thermocouple drifts upward; the process itself is healthy."),
}
CHANNEL_SET = list(K.CHANNELS)


class Simulator:
    def __init__(self, detector, publish):
        self.detector, self.publish = detector, publish
        self.running = False
        self.interval = 0.5
        self.task = None
        self.n_runs = 0
        self.seed = 1234
        self.asr, self.d_act = 1.12, 0.012
        self.df, self.i = None, 0
        self.sim_time = None
        self.fault = None
        self.slider_params = {}

    # ------------------------------------------------------------ control
    def state(self):
        return dict(running=self.running, interval_s=self.interval, sim_time=self.sim_time.isoformat().replace("+00:00", "Z") if self.sim_time else None,
                    fault=self.fault, faults={k: dict(label=v["label"], utility=v["utility"], text=v["text"]) for k, v in FAULTS.items()},
                    slider_params=self.slider_params)

    def _new_run(self, start, fault=None):
        self.n_runs += 1
        self.seed += 1
        fdict = None
        if fault:
            fdict = dict(type=fault, start_min=1, duration_min=2 * 1440 - 10, ramp_scale=0.25)
            if FAULTS[fault]["severity"] is not None:
                fdict["severity"] = FAULTS[fault]["severity"]
        self.df = telemetry.simulate_run(f"sim-{self.n_runs}", days=2, seed=self.seed, asr_mult=self.asr, d_act=self.d_act,
                                         fault=fdict, start=start.replace(tzinfo=None).isoformat(timespec="minutes"))
        self.i = 0

    def _row(self):
        if self.df is None or self.i >= len(self.df):
            self._new_run(self.sim_time, self.fault["type"] if self.fault else None)
        r = self.df.iloc[self.i]
        self.i += 1
        ts = self.sim_time
        self.sim_time = ts + timedelta(minutes=1)
        values = {ch: float(r[ch]) for ch in CHANNEL_SET}

        # If interactive sliders are active, recalculate with thermodynamics
        if self.slider_params:
            try:
                from sofc_ai import plant, config as C
                load = float(self.slider_params.get("load", r["load_set"]))
                t_ca_in = float(self.slider_params.get("temperature_C", r["t_ca_in_C"]))
                asr = float(self.slider_params.get("asr_multiplier", self.asr))
                uf = float(self.slider_params.get("fuel_utilization", C.UF_SET))
                rec = float(self.slider_params.get("recycle_ratio", C.REC_SET))
                d_act = float(self.slider_params.get("degradation_V", self.d_act))
                air_ratio_override = self.slider_params.get("air_ratio")
                n_air = None
                if air_ratio_override:
                    n_cons_est = C.N_CELLS * (C.J_DESIGN * load) * C.CELL_AREA_CM2 * 3600.0 / (2 * C.FARADAY)
                    n_air = float(air_ratio_override) * 0.5 * n_cons_est / C.Y_O2_AIR

                op = plant.operating_point(
                    load=load,
                    t_amb=r["t_amb_C"],
                    asr_mult=asr,
                    d_act=d_act,
                    uf_set=uf,
                    rec=rec,
                    n_air=n_air,
                    t_ca_in=t_ca_in,
                )
                for ch in CHANNEL_SET:
                    if ch in op:
                        values[ch] = float(op[ch])
                values["load_set"] = load
            except Exception as e:
                log.warning("Slider thermodynamic modulation error: %s", e)

        return ts, values, dict(injected_fault=self.fault["type"] if self.fault else None, fault_code=int(r["fault_code"]))

    def set_slider_params(self, params: dict):
        if not params:
            self.slider_params.clear()
            return
        for k, v in params.items():
            if v is None:
                self.slider_params.pop(k, None)
            else:
                self.slider_params[k] = float(v)
        if "asr_multiplier" in self.slider_params:
            self.asr = self.slider_params["asr_multiplier"]
        if "degradation_V" in self.slider_params:
            self.d_act = self.slider_params["degradation_V"]

    def start(self, prefill_min=120):
        if self.running:
            return
        self.detector.reset_state()
        self.fault = None
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.sim_time = now - timedelta(minutes=prefill_min)
        self._new_run(self.sim_time)
        for _ in range(prefill_min):                                  # quiet warm-up so charts and the learned model have history
            ts, values, meta = self._row()
            self.detector.ingest(ts, values, "simulator", meta, final=True)
        self.running = True
        self.task = asyncio.create_task(self._loop())

    def stop(self):
        self.running = False
        if self.task:
            self.task.cancel()
            self.task = None

    def set_interval(self, s):
        self.interval = max(0.05, min(5.0, float(s)))

    def inject(self, fault):
        if fault not in FAULTS:
            raise KeyError(fault)
        self.fault = dict(type=fault, label=FAULTS[fault]["label"], injected_ts=self.sim_time.isoformat().replace("+00:00", "Z"),
                          first_alert_ts=None, first_alert=None, delay_min=None)
        self._new_run(self.sim_time, fault)

    def clear_fault(self):
        self.fault = None
        self._new_run(self.sim_time, None)

    # ------------------------------------------------------------ loop
    async def _loop(self):
        try:
            while self.running:
                ts, values, meta = self._row()
                ticks = self.detector.ingest(ts, values, "simulator", meta, final=True)
                for t in ticks:
                    self._track_detection(t)
                    await self.publish(t)
                await self.publish(dict(type="sim", sim=self.state()))
                await asyncio.sleep(self.interval)
        except asyncio.CancelledError:
            pass
        except Exception:
            log.exception("simulator loop failed")
            self.running = False

    def _track_detection(self, tick):
        f = self.fault
        if not f or f["first_alert_ts"]:
            return
        new = [e["alert"] for e in tick["alert_events"] if e["event"] == "new" and e["alert"]["first_ts"] >= f["injected_ts"]]
        if new:
            f["first_alert_ts"] = tick["ts"]
            f["first_alert"] = new[0]["title"]
            t0 = datetime.fromisoformat(f["injected_ts"].replace("Z", "+00:00"))
            t1 = datetime.fromisoformat(tick["ts"].replace("Z", "+00:00"))
            f["delay_min"] = int((t1 - t0).total_seconds() // 60)
