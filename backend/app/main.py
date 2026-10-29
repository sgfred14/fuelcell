"""FastAPI server: ingest endpoint, REST views, live WebSocket, optional static dashboard."""
import asyncio
import json
import logging
import math
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

# Auto-load .env from backend/.env or current working directory
try:
    import dotenv
    env_candidates = [
        Path(__file__).resolve().parents[1] / ".env",
        Path(__file__).resolve().parents[2] / ".env",
        Path.cwd() / "backend" / ".env",
        Path.cwd() / ".env",
    ]
    for env_path in env_candidates:
        if env_path.is_file():
            dotenv.load_dotenv(dotenv_path=env_path, override=False)
            break
    else:
        dotenv.load_dotenv()
except Exception:
    pass

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import checks as K
from . import thermo
from .ae import try_load
from .aspen_service import aspen_service, optimize_model_parameters
from .db import mongo_manager
from .detector import Detector
from .ems import ems_engine
from .simulator import Simulator

log = logging.getLogger("monitor")
API_KEY = os.environ.get("MONITOR_API_KEY")
DIST = Path(os.environ.get("FRONTEND_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist"))


def sanitize(o):
    """JSON-safe: NaN / inf -> null."""
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict):
        return {k: sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [sanitize(v) for v in o]
    return o


class Hub:
    def __init__(self):
        self.clients = set()

    async def publish(self, msg):
        if not self.clients:
            return
        text = json.dumps(sanitize(msg))
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(text)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()
detector: Detector = None
sim: Simulator = None


async def broadcast(msg):
    """Dispatches a message both to Cloud MongoDB (if a tick) and to connected WebSocket clients."""
    if isinstance(msg, dict) and msg.get("type") == "tick":
        await mongo_manager.record_tick(msg)
    await hub.publish(msg)


@asynccontextmanager
async def lifespan(app):
    global detector, sim
    logging.basicConfig(level=logging.INFO)
    await mongo_manager.start()
    detector = Detector(ae=None if os.environ.get("DISABLE_AE") == "1" else await asyncio.to_thread(try_load))
    sim = Simulator(detector, broadcast)
    log.info("learned-model detector: %s", "on" if detector.ae else "off (physics checks only)")
    if os.environ.get("SIM_AUTOSTART", "1") == "1":
        sim.start()
    yield
    sim.stop()
    await mongo_manager.stop()
    print("[MongoDB] Server shutdown: flushed buffer and disconnected cleanly.", flush=True)


app = FastAPI(title="SOFC utility monitor", version="1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","),
                   allow_methods=["*"], allow_headers=["*"])


def require_key(x_api_key: Optional[str] = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(401, "Missing or wrong X-API-Key header")


# ---------------------------------------------------------------- schemas
class Reading(BaseModel):
    ts: Optional[datetime] = Field(None, description="Reading time (ISO 8601). Server time if omitted.")
    source: str = "plant"
    values: Dict[str, Optional[float]] = Field(..., min_length=1, description="Channel name -> value. See GET /api/config for the channel names.")


class Batch(BaseModel):
    readings: List[Reading] = Field(..., min_length=1, max_length=2000)


class IntervalBody(BaseModel):
    interval_s: float


class FaultBody(BaseModel):
    fault: str


class PolarizationParams(BaseModel):
    temperature_C: float = 700.0
    asr_multiplier: float = 1.12
    degradation_V: float = 0.012
    fuel_utilization: float = 0.80
    recycle_ratio: float = 0.50
    j_min: float = 0.02
    j_max: float = 1.45
    n_points: int = 70


class SweepParams(BaseModel):
    parameter: str = "temperature"
    min_val: float = 600.0
    max_val: float = 800.0
    steps: int = 25
    temperature_C: float = 700.0
    asr_multiplier: float = 1.12
    degradation_V: float = 0.012
    fuel_utilization: float = 0.80
    load_set: float = 0.80


class SimParams(BaseModel):
    load: Optional[float] = None
    temperature_C: Optional[float] = None
    asr_multiplier: Optional[float] = None
    fuel_utilization: Optional[float] = None
    recycle_ratio: Optional[float] = None
    degradation_V: Optional[float] = None
    air_ratio: Optional[float] = None
    reset: bool = False


class AspenPullVerifyParams(BaseModel):
    model_file: Optional[str] = None
    custom_values: Optional[Dict[str, float]] = None
    actual_values: Optional[Dict[str, float]] = None
    use_actual_plant_values: bool = False
    source: Optional[str] = None
    plant_params: Optional[Dict[str, Any]] = None


AspenPullVerifyParams.model_rebuild()


class AspenOptimizeParams(BaseModel):
    objective: str = "eta_el"
    plant_params: Optional[Dict[str, Any]] = None


AspenOptimizeParams.model_rebuild()


class AspenConnectParams(BaseModel):
    model_path: Optional[str] = None
    progid: Optional[str] = "Apwn.Document"


AspenConnectParams.model_rebuild()


class EMSOptimizeParams(BaseModel):
    base_demand_kw: float = 85.0
    h2_cost_usd_kg: Optional[float] = None
    rated_sofc_power_kw: Optional[float] = 100.0
    min_sofc_power_kw: Optional[float] = 35.0


EMSOptimizeParams.model_rebuild()


# ---------------------------------------------------------------- routes
@app.get("/api/health")
def health():
    return dict(
        status="ok",
        simulator=sim.running if sim else False,
        mongodb_connected=mongo_manager.is_connected,
        mongodb_mode=mongo_manager.mode,
        mongodb_status="connected" if mongo_manager.is_connected else "disconnected",
        **(detector.info() if detector else {})
    )


@app.get("/api/config")
def config():
    checks = [dict(id=c.id, utility=c.utility, label=c.label, unit=c.unit, decimals=c.decimals, warn_lo=c.warn_lo, warn_hi=c.warn_hi,
                   alarm_lo=c.alarm_lo, alarm_hi=c.alarm_hi, window=c.window, inputs=list(c.inputs), what=c.what, hint=c.hint) for c in K.CHECKS]
    channels = [dict(id=ch, label=K.LABELS[ch], unit=K.UNITS[ch], range=K.RANGES[ch], utility=K.CHANNEL_UTILITY.get(ch, "context")) for ch in K.CHANNELS]
    return sanitize(dict(
        utilities=K.UTILITIES,
        checks=checks,
        channels=channels,
        info=detector.info() if detector else {},
        api_key_required=bool(API_KEY),
        mongodb=dict(
            connected=mongo_manager.is_connected,
            status="connected" if mongo_manager.is_connected else "disconnected",
            mode=mongo_manager.mode,
            database=mongo_manager.db_name,
        ),
    ))


@app.get("/api/state")
def state():
    return sanitize(dict(detector.snapshot(history_minutes=240), sim=sim.state()))


@app.get("/api/history")
def history(minutes: int = Query(240, ge=1, le=1440)):
    return sanitize(detector.snapshot(history_minutes=minutes)["history"])


@app.get("/api/alerts")
def alerts(status: str = Query("active", pattern="^(active|recent|all)$")):
    out = []
    if status in ("active", "all"):
        out += detector.alerts.active_list()
    if status in ("recent", "all"):
        out += detector.alerts.recent(100)
    return sanitize(out)


@app.post("/api/alerts/{alert_id}/ack")
async def ack(alert_id: int):
    a = detector.alerts.ack(alert_id)
    if a is None:
        raise HTTPException(404, "No active alert with that id")
    await broadcast(dict(type="ack", alert=a))
    await mongo_manager.record_alert_ack(alert_id, a)
    return sanitize(a)


@app.post("/api/ingest", dependencies=[Depends(require_key)])
async def ingest(body: Union[Batch, Reading], final: bool = Query(False, description="Treat each reading as a complete minute")):
    """Send one reading, or {"readings": [...]}. Readings are averaged into one-minute bins; a minute is evaluated when
    the first reading of the next minute arrives (or immediately with final=true)."""
    if sim.running:
        raise HTTPException(409, "The demo simulator is running. POST /api/sim/stop first, or start the server with SIM_AUTOSTART=0.")
    readings = body.readings if isinstance(body, Batch) else [body]
    unknown, ticks = set(), 0
    for r in readings:
        unknown |= {k for k in r.values if k not in K.CHANNELS}
        for t in detector.ingest(r.ts or datetime.now(timezone.utc), r.values, r.source, None, final=final):
            ticks += 1
            await broadcast(t)
    return dict(accepted=len(readings), minutes_evaluated=ticks, unknown_channels=sorted(unknown))


@app.get("/api/sim")
def sim_state():
    return sim.state()


@app.post("/api/sim/start")
async def sim_start():
    sim.start()
    st = sim.state()
    await mongo_manager.record_sim_event("start", st)
    await broadcast(dict(type="snapshot", **{k: v for k, v in detector.snapshot().items() if k != "type"}, sim=st))
    return st


@app.post("/api/sim/stop")
async def sim_stop():
    sim.stop()
    st = sim.state()
    await mongo_manager.record_sim_event("stop", st)
    await broadcast(dict(type="sim", sim=st))
    return st


@app.post("/api/sim/interval")
async def sim_interval(b: IntervalBody):
    sim.set_interval(b.interval_s)
    st = sim.state()
    await mongo_manager.record_sim_event("interval", {"interval_s": b.interval_s, "state": st})
    await broadcast(dict(type="sim", sim=st))
    return st


@app.post("/api/sim/fault")
async def sim_fault(b: FaultBody):
    if not sim.running:
        raise HTTPException(409, "Start the simulator first")
    try:
        sim.inject(b.fault)
    except KeyError:
        raise HTTPException(400, f"Unknown fault. Choose one of {sorted(sim.state()['faults'])}")
    st = sim.state()
    await mongo_manager.record_sim_event("fault_injected", {"fault": b.fault, "state": st})
    await broadcast(dict(type="sim", sim=st))
    return st


@app.post("/api/sim/clear")
async def sim_clear():
    sim.clear_fault()
    st = sim.state()
    await mongo_manager.record_sim_event("fault_cleared", st)
    await broadcast(dict(type="sim", sim=st))
    return st


@app.post("/api/sim/params")
async def sim_params(b: SimParams):
    if b.reset:
        sim.set_slider_params({})
    else:
        sim.set_slider_params(b.model_dump(exclude={"reset"}, exclude_none=True))
    st = sim.state()
    await mongo_manager.record_sim_event("params_updated", {"params": b.model_dump(), "state": st})
    await broadcast(dict(type="sim", sim=st))
    return st


@app.post("/api/polarization")
async def polarization(params: PolarizationParams):
    res = thermo.compute_polarization(
        temperature_C=params.temperature_C,
        asr_multiplier=params.asr_multiplier,
        degradation_V=params.degradation_V,
        fuel_utilization=params.fuel_utilization,
        recycle_ratio=params.recycle_ratio,
        j_min=params.j_min,
        j_max=params.j_max,
        n_points=params.n_points,
    )
    await mongo_manager.record_calculation("polarization", params.model_dump(), res)
    return sanitize(res)


@app.get("/api/thermodynamic")
async def thermodynamic():
    latest = detector.latest if detector else None
    values = latest.get("values") if latest else None
    if not values:
        from sofc_ai import plant
        op = plant.operating_point(0.8, 30.0)
        values = {k: float(v) for k, v in op.items() if isinstance(v, (int, float))}
    res = thermo.compute_thermodynamic_state(values)
    await mongo_manager.record_calculation("thermodynamic_state", {"source": "latest" if latest else "baseline"}, res)
    return sanitize(res)


@app.post("/api/thermodynamic/calculate")
async def thermodynamic_calculate(params: PolarizationParams):
    from sofc_ai import plant
    op = plant.operating_point(
        load=0.8,
        t_amb=30.0,
        asr_mult=params.asr_multiplier,
        d_act=params.degradation_V,
        uf_set=params.fuel_utilization,
        rec=params.recycle_ratio,
        t_ca_in=params.temperature_C,
    )
    values = {k: float(v) for k, v in op.items() if isinstance(v, (int, float))}
    res = thermo.compute_thermodynamic_state(values)
    await mongo_manager.record_calculation("thermodynamic_calculate", params.model_dump(), res)
    return sanitize(res)


@app.post("/api/sweep")
async def sweep(params: SweepParams):
    res = thermo.compute_parameter_sweep(
        parameter=params.parameter,
        min_val=params.min_val,
        max_val=params.max_val,
        steps=params.steps,
        temperature_C=params.temperature_C,
        asr_multiplier=params.asr_multiplier,
        degradation_V=params.degradation_V,
        fuel_utilization=params.fuel_utilization,
        load_set=params.load_set,
    )
    await mongo_manager.record_calculation("sweep", params.model_dump(), {"points_count": len(res)})
    return sanitize(res)


# ---------------------------------------------------------------- cloud MongoDB routes
@app.get("/api/db/status")
async def db_status():
    """Returns Cloud MongoDB integration status, connectivity, and collection statistics."""
    st = await mongo_manager.get_status()
    return sanitize(st)


@app.get("/api/db/ticks")
async def db_ticks(
    start_ts: Optional[str] = Query(None, description="Start ISO timestamp filter (inclusive)"),
    end_ts: Optional[str] = Query(None, description="End ISO timestamp filter (inclusive)"),
    overall: Optional[str] = Query(None, pattern="^(ok|warning|alarm)$", description="Filter by overall status"),
    limit: int = Query(100, ge=1, le=1000, description="Max documents to return"),
    skip: int = Query(0, ge=0, description="Offset for pagination"),
):
    """Query historical telemetry ticks stored in Cloud MongoDB."""
    ticks = await mongo_manager.query_ticks(start_ts=start_ts, end_ts=end_ts, overall=overall, limit=limit, skip=skip)
    return sanitize(ticks)


@app.get("/api/db/alerts")
async def db_alerts(
    status: Optional[str] = Query(None, description="Filter by status (active, acknowledged, unacknowledged, cleared, all)"),
    utility: Optional[str] = Query(None, description="Filter by utility name"),
    limit: int = Query(50, ge=1, le=500),
    skip: int = Query(0, ge=0),
):
    """Query alert history stored in Cloud MongoDB."""
    alerts_list = await mongo_manager.query_alerts(status=status, utility=utility, limit=limit, skip=skip)
    return sanitize(alerts_list)


@app.get("/api/db/simulations")
async def db_simulations(
    limit: int = Query(50, ge=1, le=500),
    skip: int = Query(0, ge=0),
):
    """Query simulation runs and lifecycle events stored in Cloud MongoDB."""
    sims = await mongo_manager.query_simulations(limit=limit, skip=skip)
    return sanitize(sims)


@app.get("/api/db/calculations")
async def db_calculations(
    calc_type: Optional[str] = Query(None, description="polarization, thermodynamic_state, thermodynamic_calculate, sweep"),
    limit: int = Query(50, ge=1, le=500),
    skip: int = Query(0, ge=0),
):
    """Query saved thermodynamic calculations and curves from Cloud MongoDB."""
    calcs = await mongo_manager.query_calculations(calc_type=calc_type, limit=limit, skip=skip)
    return sanitize(calcs)


class ReconnectBody(BaseModel):
    uri: Optional[str] = None
    db_name: Optional[str] = None


@app.post("/api/db/flush")
async def db_flush():
    """Trigger an immediate batch flush of queued documents to Cloud MongoDB."""
    await mongo_manager.flush()
    return {"flushed": True, "status": await mongo_manager.get_status()}


@app.post("/api/db/reconnect")
async def db_reconnect(body: Optional[ReconnectBody] = None):
    """Force an immediate reconnection attempt to Cloud MongoDB, optionally updating URI/database."""
    if body:
        if body.uri:
            mongo_manager.uri = body.uri.strip().strip('"').strip("'")
        if body.db_name:
            mongo_manager.db_name = body.db_name.strip()
    await mongo_manager.start(start_worker=False)
    return await mongo_manager.get_status()


# ---------------------------------------------------------------- Aspen integration routes
@app.get("/api/aspen/status")
def aspen_status():
    """Returns Aspen Plus COM connection status, running processes, and last verification verdict."""
    return sanitize(aspen_service.get_status())


@app.post("/api/aspen/connect")
def aspen_connect(params: AspenConnectParams):
    """Configures Aspen Plus model file path and COM ProgID."""
    if params.model_path:
        aspen_service.model_path = params.model_path
    if params.progid:
        aspen_service.progid = params.progid
    return sanitize(aspen_service.get_status())


@app.post("/api/aspen/pull-and-verify")
async def aspen_pull_and_verify(params: AspenPullVerifyParams = Body(default_factory=AspenPullVerifyParams)):
    """
    Pulls values from Aspen Plus (or digital twin simulation, or live plant telemetry),
    verifies them against baseline tolerances, runs the verified parameters through
    our SOFC plant model, and computes model reconciliation.
    """
    body = params
    res = aspen_service.verify_and_run(
        custom_values=body.custom_values,
        actual_values=body.actual_values,
        source=body.source,
        use_actual_plant_values=body.use_actual_plant_values,
        detector=detector,
        plant_params=body.plant_params,
        model_file=body.model_file
    )
    await mongo_manager.record_calculation("aspen_verification", body.model_dump(), res)
    return sanitize(res)


@app.post("/api/aspen/set-baseline")
async def aspen_set_baseline(body: Dict[str, Any] = Body(default_factory=dict)):
    """
    Sets Aspen values (or last verified Aspen run) as the baseline results for the SOFC plant model.
    Updates plant calibration, thermodynamic balances, and persistent baseline configuration.
    """
    values = body.get("values") or body.get("custom_values") or body.get("actual_values")
    if values is None and body and not any(k in body for k in ("values", "custom_values", "actual_values")):
        values = body
    res = aspen_service.set_aspen_as_baseline(values)
    await mongo_manager.record_calculation("aspen_set_baseline", body, res)
    return sanitize(res)


@app.get("/api/aspen/baseline")
def aspen_get_baseline():
    """Returns current active plant baseline results and tolerance specifications."""
    from app.aspen_service import PATHS
    return sanitize({
        "baseline": aspen_service.get_baseline(),
        "paths": {k: {"node_path": v[0], "ref_key": v[1], "tol_pct": v[2] * 100.0} for k, v in PATHS.items()},
    })



@app.post("/api/aspen/optimize")
async def aspen_optimize(params: AspenOptimizeParams = Body(default_factory=AspenOptimizeParams)):
    """
    Runs multi-parameter optimization (cell voltage, fuel utilization, blower pressure, current density)
    to maximize electrical or CHP efficiency subject to thermal stress and voltage margin constraints.
    """
    body = params
    candidates = optimize_model_parameters(body.plant_params or {}, objective=body.objective)
    res = {"candidates": candidates, "objective": body.objective}
    await mongo_manager.record_calculation("aspen_optimization", body.model_dump(), res)
    return sanitize(res)


@app.get("/api/aspen/history")
async def aspen_history(limit: int = Query(20, ge=1, le=100)):
    """Retrieves past Aspen verification runs stored in MongoDB."""
    calcs = await mongo_manager.query_calculations(calc_type="aspen_verification", limit=limit)
    return sanitize(calcs)


# ---------------------------------------------------------------- AI Energy Management System (EMS) routes
@app.get("/api/ems/status")
def ems_status():
    """Returns real-time AI EMS status, active dispatch strategy, and daily summary."""
    forecast = ems_engine.generate_24h_forecast()
    return sanitize({
        "status": "active",
        "current_hour": datetime.now(timezone.utc).hour,
        "summary": forecast["summary"],
        "recommendations_count": len(forecast["recommendations"]),
    })


@app.get("/api/ems/forecast")
def ems_forecast(base_demand_kw: float = Query(85.0, ge=10.0, le=500.0), h2_cost_usd_kg: Optional[float] = Query(None)):
    """Generates 24-hour predictive forecast, TOU tariff arbitrage, and stack degradation horizon."""
    res = ems_engine.generate_24h_forecast(base_demand_kw=base_demand_kw, h2_price_override=h2_cost_usd_kg)
    return sanitize(res)


@app.post("/api/ems/optimize")
async def ems_optimize(params: EMSOptimizeParams):
    """Runs AI predictive dispatch optimization for custom facility demand and hydrogen prices."""
    res = ems_engine.generate_24h_forecast(
        base_demand_kw=params.base_demand_kw,
        h2_price_override=params.h2_cost_usd_kg
    )
    await mongo_manager.record_calculation("ems_forecast", params.model_dump(), res["summary"])
    return sanitize(res)


@app.get("/api/ems/recommendations")
def ems_recommendations():
    """Returns real-time actionable advisory insights and recommendations from the AI EMS."""
    forecast = ems_engine.generate_24h_forecast()
    return sanitize(forecast["recommendations"])


@app.get("/api/ems/history")
async def ems_history(limit: int = Query(20, ge=1, le=100)):
    """Retrieves past EMS optimization schedules stored in MongoDB."""
    calcs = await mongo_manager.query_calculations(calc_type="ems_forecast", limit=limit)
    return sanitize(calcs)


# ---------------------------------------------------------------- WebSocket
@app.websocket("/ws")
async def ws(socket: WebSocket):
    await socket.accept()
    hub.clients.add(socket)
    try:
        await socket.send_text(json.dumps(sanitize(dict(detector.snapshot(history_minutes=240), sim=sim.state()))))
        while True:
            await socket.receive_text()          # keep-alive; the server only pushes
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        hub.clients.discard(socket)


if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="dashboard")
