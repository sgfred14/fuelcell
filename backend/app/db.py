"""
Cloud MongoDB integration for SOFC Utility Monitor.

Supports:
1. MongoDB Atlas (Cloud) via mongodb+srv:// connection strings (using motor or pymongo).
2. MongoDB Atlas Data API over HTTPS (using httpx).
3. Resilient in-memory/disk buffer fallback when cloud database is offline or drivers are not yet installed.
4. Non-blocking asynchronous batch ingestion pipeline so real-time plant telemetry and WebSocket
   broadcasts are never slowed down by cloud network latency.
"""

import asyncio
from datetime import datetime, timezone
import json
import logging
import math
import os
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

log = logging.getLogger("monitor.db")

# Environment configuration
MONGODB_URI = os.environ.get("MONGODB_URI", "")
MONGODB_DB_NAME = os.environ.get("MONGODB_DB_NAME", "sofc_monitor")
MONGODB_ENABLED = os.environ.get("MONGODB_ENABLED", "1").lower() not in ("0", "false", "no", "off")
MONGODB_BATCH_SIZE = int(os.environ.get("MONGODB_BATCH_SIZE", "20"))
MONGODB_FLUSH_INTERVAL = float(os.environ.get("MONGODB_FLUSH_INTERVAL", "3.0"))
MONGODB_MAX_BUFFER = int(os.environ.get("MONGODB_MAX_BUFFER", "5000"))

# Atlas Data API (alternative serverless cloud endpoint)
ATLAS_DATA_API_URL = os.environ.get("MONGODB_ATLAS_DATA_API_URL", "")
ATLAS_DATA_API_KEY = os.environ.get("MONGODB_ATLAS_DATA_API_KEY", "")
ATLAS_DATA_SOURCE = os.environ.get("MONGODB_ATLAS_DATA_SOURCE", "Cluster0")

# Collection names
COLL_TICKS = os.environ.get("MONGODB_COLL_TICKS", "telemetry_ticks")
COLL_ALERTS = os.environ.get("MONGODB_COLL_ALERTS", "alerts")
COLL_SIMS = os.environ.get("MONGODB_COLL_SIMS", "simulations")
COLL_CALCS = os.environ.get("MONGODB_COLL_CALCS", "thermo_calculations")


def mask_uri(uri: str) -> str:
    """Masks credentials in a MongoDB URI so it is safe to log and print."""
    if not uri:
        return ""
    import re
    return re.sub(r"://([^:]+):([^@]+)@", r"://\1:***@", uri)


def sanitize_for_mongo(o: Any) -> Any:
    """Sanitizes objects for MongoDB / BSON: handles NaN, inf, numpy types, and invalid keys."""
    if isinstance(o, float):
        if math.isnan(o) or math.isinf(o):
            return None
        return o
    if hasattr(o, "item"):  # numpy scalars
        val = o.item()
        return sanitize_for_mongo(val)
    if isinstance(o, dict):
        clean = {}
        for k, v in o.items():
            # MongoDB disallows dots and leading dollar signs in key names in some contexts
            key = str(k).replace(".", "_")
            if key.startswith("$"):
                key = "_" + key[1:]
            clean[key] = sanitize_for_mongo(v)
        return clean
    if isinstance(o, (list, tuple, set)):
        return [sanitize_for_mongo(v) for v in o]
    if isinstance(o, datetime):
        return o.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return o


class AsyncLock:
    def __init__(self):
        self._lock: Optional[asyncio.Lock] = None

    async def __aenter__(self):
        try:
            if self._lock is None:
                self._lock = asyncio.Lock()
            await self._lock.acquire()
        except Exception:
            pass
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self._lock and self._lock.locked():
            try:
                self._lock.release()
            except Exception:
                pass


class OfflineMongoBuffer:
    """
    Resilient in-memory collection store used when cloud connection is unavailable,
    unconfigured, or during offline/mock operations.
    Maintains FIFO buffers and provides query/filter functionality matching MongoDB.
    """

    def __init__(self, max_records: int = MONGODB_MAX_BUFFER):
        self.max_records = max_records
        self.ticks: List[Dict[str, Any]] = []
        self.alerts: Dict[Any, Dict[str, Any]] = {}  # id/key -> alert doc
        self.simulations: List[Dict[str, Any]] = []
        self.calculations: List[Dict[str, Any]] = []

    def insert_tick(self, doc: Dict[str, Any]):
        self.ticks.append(doc)
        if len(self.ticks) > self.max_records:
            self.ticks.pop(0)

    def insert_ticks(self, docs: List[Dict[str, Any]]):
        self.ticks.extend(docs)
        if len(self.ticks) > self.max_records:
            self.ticks = self.ticks[-self.max_records:]

    def upsert_alert(self, alert_doc: Dict[str, Any], event_entry: Optional[Dict[str, Any]] = None):
        key = alert_doc.get("id") or alert_doc.get("key")
        if key is not None:
            if key in self.alerts:
                existing_history = self.alerts[key].get("history", [])
                self.alerts[key].update(alert_doc)
                self.alerts[key]["history"] = existing_history
            else:
                self.alerts[key] = dict(alert_doc)
                if "history" not in self.alerts[key]:
                    self.alerts[key]["history"] = []
            if event_entry:
                self.alerts[key]["history"].append(dict(event_entry))

    def insert_sim(self, doc: Dict[str, Any]):
        self.simulations.append(doc)
        if len(self.simulations) > self.max_records:
            self.simulations.pop(0)

    def insert_calc(self, doc: Dict[str, Any]):
        self.calculations.append(doc)
        if len(self.calculations) > self.max_records:
            self.calculations.pop(0)

    def query_ticks(self, start_ts: Optional[str] = None, end_ts: Optional[str] = None,
                    overall: Optional[str] = None, limit: int = 100, skip: int = 0) -> List[Dict[str, Any]]:
        results = self.ticks
        if isinstance(start_ts, str) and start_ts:
            results = [t for t in results if str(t.get("ts", "")) >= start_ts]
        if isinstance(end_ts, str) and end_ts:
            results = [t for t in results if str(t.get("ts", "")) <= end_ts]
        if isinstance(overall, str) and overall:
            results = [t for t in results if t.get("overall") == overall]
        # Return newest first
        reversed_res = list(reversed(results))
        return reversed_res[skip:skip + limit]

    def query_alerts(self, status: Optional[str] = None, utility: Optional[str] = None,
                     limit: int = 50, skip: int = 0) -> List[Dict[str, Any]]:
        items = list(self.alerts.values())
        if isinstance(status, str) and status and status != "all":
            if status == "acknowledged":
                items = [a for a in items if a.get("acknowledged") is True]
            elif status == "unacknowledged":
                items = [a for a in items if a.get("status") == "active" and not a.get("acknowledged")]
            else:
                items = [a for a in items if a.get("status") == status]
        if isinstance(utility, str) and utility:
            items = [a for a in items if a.get("utility") == utility]
        items.sort(key=lambda a: a.get("last_ts", a.get("first_ts", "")), reverse=True)
        return items[skip:skip + limit]

    def query_simulations(self, limit: int = 50, skip: int = 0) -> List[Dict[str, Any]]:
        reversed_res = list(reversed(self.simulations))
        return reversed_res[skip:skip + limit]

    def query_calculations(self, calc_type: Optional[str] = None, limit: int = 50, skip: int = 0) -> List[Dict[str, Any]]:
        results = self.calculations
        if isinstance(calc_type, str) and calc_type:
            results = [c for c in results if c.get("calc_type") == calc_type]
        reversed_res = list(reversed(results))
        return reversed_res[skip:skip + limit]

    def counts(self) -> Dict[str, int]:
        return {
            COLL_TICKS: len(self.ticks),
            COLL_ALERTS: len(self.alerts),
            COLL_SIMS: len(self.simulations),
            COLL_CALCS: len(self.calculations),
        }


class MongoManager:
    """
    Manages connections and asynchronous ingestion to cloud MongoDB.
    Provides batch buffering so fast ticks are safely gathered and committed
    without impacting server response time.
    """

    def __init__(self, uri: Optional[str] = None, db_name: Optional[str] = None, enabled: Optional[bool] = None):
        self.uri = uri if uri is not None else MONGODB_URI
        self.db_name = db_name if db_name is not None else MONGODB_DB_NAME
        self.enabled = enabled if enabled is not None else MONGODB_ENABLED
        self.batch_size = MONGODB_BATCH_SIZE
        self.flush_interval = MONGODB_FLUSH_INTERVAL

        self.client: Any = None
        self.db: Any = None
        self.mode = "disabled" if not self.enabled else "offline_buffer"
        self.is_connected = False
        self.last_error: Optional[str] = None

        self.offline_store = OfflineMongoBuffer()
        self._tick_buffer: List[Dict[str, Any]] = []
        self._buffer_lock: Optional[AsyncLock] = None
        self._flush_task: Optional[asyncio.Task] = None
        self._retry_task: Optional[asyncio.Task] = None

        self.stats = {
            "ticks_queued": 0,
            "ticks_written": 0,
            "alerts_written": 0,
            "sims_written": 0,
            "calcs_written": 0,
            "flushes_total": 0,
            "failed_flushes": 0,
            "last_flush_ts": None,
        }

    def _get_lock(self) -> AsyncLock:
        if self._buffer_lock is None:
            self._buffer_lock = AsyncLock()
        return self._buffer_lock

    def print_connection_status(self):
        """Prints whether MongoDB is connected or not clearly to stdout."""
        masked_target = mask_uri(self.uri) if self.uri else (ATLAS_DATA_API_URL or "none")
        banner_width = 72
        print("=" * banner_width, flush=True)
        if not self.enabled:
            print("  [MongoDB Integration] STATUS: DISABLED (MONGODB_ENABLED=0)", flush=True)
            print("  Notice:   Cloud storage is turned off. Readings are not persisted.", flush=True)
        elif self.is_connected:
            print("  [MongoDB Integration] STATUS: CONNECTED", flush=True)
            print(f"  Driver:   {self.mode.upper()} (Cloud MongoDB Driver)", flush=True)
            print(f"  Database: {self.db_name}", flush=True)
            print(f"  Endpoint: {masked_target}", flush=True)
            print("  Storage:  Streaming telemetry ticks and alerts to cloud active", flush=True)
        else:
            print("  [MongoDB Integration] STATUS: NOT CONNECTED", flush=True)
            print(f"  Mode:     {self.mode} (Resilient Offline Fallback)", flush=True)
            print(f"  Target:   {masked_target}", flush=True)
            print(f"  Reason:   {self.last_error or 'URI not provided or database unreachable'}", flush=True)
            print("  Storage:  Safely buffering telemetry, alerts, and calculations in memory", flush=True)
        print("=" * banner_width, flush=True)

    async def start(self, start_worker: bool = True):
        """Starts MongoDB client connection and background batch flush worker."""
        if not self.enabled:
            self.mode = "disabled"
            log.info("MongoDB integration is disabled via configuration.")
            self.print_connection_status()
            return

        self._get_lock()
        await self._connect(start_worker=start_worker)
        self.print_connection_status()

        # Start periodic flush worker if requested
        if start_worker and (self._flush_task is None or self._flush_task.done()):
            try:
                loop = asyncio.get_running_loop()
                self._flush_task = loop.create_task(self._flush_loop())
            except RuntimeError:
                pass

    async def _connect(self, start_worker: bool = True):
        """Attempts connection to cloud MongoDB (via motor or pymongo or Atlas Data API)."""
        if not self.uri:
            self.uri = os.environ.get("MONGODB_URI", "")
        if self.uri:
            self.uri = str(self.uri).strip().strip('"').strip("'")

        if not self.uri and not ATLAS_DATA_API_URL:
            self.mode = "offline_buffer"
            self.is_connected = False
            self.last_error = "MONGODB_URI not set. Running in local buffer mode."
            log.info("No MONGODB_URI provided. MongoDB operating in offline buffer mode.")
            return

        # 1. Try motor (async driver)
        try:
            import motor.motor_asyncio
            self.client = motor.motor_asyncio.AsyncIOMotorClient(
                self.uri,
                serverSelectionTimeoutMS=2500,
                connectTimeoutMS=2500,
                retryWrites=True,
            )
            # Verify connectivity
            await self.client.admin.command("ping")
            try:
                self.db = self.client.get_default_database()
            except Exception:
                self.db = None
            if self.db is None or self.db.name in ("admin", "local", "config", "test"):
                self.db = self.client[self.db_name]
            self.db_name = self.db.name
            self.mode = "motor"
            self.is_connected = True
            self.last_error = None
            log.info("Connected successfully to Cloud MongoDB (%s) via motor.", self.db_name)
            await self._create_indexes()
            return
        except ImportError:
            log.debug("motor library not installed. Checking for pymongo...")
        except Exception as exc:
            err_msg = str(exc)
            hint = ""
            if "localhost" in self.uri or "127.0.0.1" in self.uri:
                hint = " (Local MongoDB not responding on port 27017. Verify mongod is running)"
            elif "mongodb+srv" in self.uri:
                hint = " (Check Atlas IP Whitelist / credentials / DNS)"
            self.last_error = f"Motor connection failed: {err_msg}{hint}"
            log.warning("Could not connect to MongoDB via motor: %s", self.last_error)

        # 2. Try pymongo (sync driver wrapped in threadpool)
        try:
            import pymongo
            self.client = pymongo.MongoClient(
                self.uri,
                serverSelectionTimeoutMS=2500,
                connectTimeoutMS=2500,
                retryWrites=True,
            )
            # Verify connectivity in thread
            await asyncio.to_thread(self.client.admin.command, "ping")
            try:
                self.db = self.client.get_default_database()
            except Exception:
                self.db = None
            if self.db is None or self.db.name in ("admin", "local", "config", "test"):
                self.db = self.client[self.db_name]
            self.db_name = self.db.name
            self.mode = "pymongo"
            self.is_connected = True
            self.last_error = None
            log.info("Connected successfully to Cloud MongoDB (%s) via pymongo.", self.db_name)
            await asyncio.to_thread(self._create_sync_indexes)
            return
        except ImportError:
            log.debug("pymongo library not installed.")
        except Exception as exc:
            err_msg = str(exc)
            hint = ""
            if "localhost" in self.uri or "127.0.0.1" in self.uri:
                hint = " (Local MongoDB not responding on port 27017. Verify mongod is running)"
            elif "mongodb+srv" in self.uri:
                hint = " (Check Atlas IP Whitelist / credentials / DNS)"
            self.last_error = f"PyMongo connection failed: {err_msg}{hint}"
            log.warning("Could not connect to MongoDB via pymongo: %s", self.last_error)

        # 3. Check for Atlas Data API
        if ATLAS_DATA_API_URL and ATLAS_DATA_API_KEY:
            self.mode = "atlas_data_api"
            self.is_connected = True
            self.last_error = None
            log.info("Operating in MongoDB Atlas Data API mode (%s).", ATLAS_DATA_API_URL)
            return

        # Fallback to local offline buffer
        self.mode = "offline_buffer"
        self.is_connected = False
        if not self.last_error:
            self.last_error = "Neither motor nor pymongo installed. Running in local buffer mode."
        log.warning("%s Data will be buffered locally.", self.last_error)

        # Start background reconnect loop if URI is configured
        if start_worker and self.uri and (self._retry_task is None or self._retry_task.done()):
            try:
                loop = asyncio.get_running_loop()
                self._retry_task = loop.create_task(self._retry_loop())
            except RuntimeError:
                pass

    async def _create_indexes(self):
        """Creates indexes on collections via motor."""
        try:
            await self.db[COLL_TICKS].create_index([("ts", -1)])
            await self.db[COLL_TICKS].create_index([("minute", -1)])
            await self.db[COLL_TICKS].create_index([("overall", 1)])
            await self.db[COLL_ALERTS].create_index([("id", 1)], unique=True)
            await self.db[COLL_ALERTS].create_index([("status", 1)])
            await self.db[COLL_ALERTS].create_index([("utility", 1)])
            await self.db[COLL_SIMS].create_index([("timestamp", -1)])
            await self.db[COLL_CALCS].create_index([("created_at", -1)])
            log.info("MongoDB indexes verified.")
        except Exception as exc:
            log.warning("Index creation note: %s", exc)

    def _create_sync_indexes(self):
        """Creates indexes on collections via pymongo."""
        try:
            self.db[COLL_TICKS].create_index([("ts", -1)])
            self.db[COLL_TICKS].create_index([("minute", -1)])
            self.db[COLL_TICKS].create_index([("overall", 1)])
            self.db[COLL_ALERTS].create_index([("id", 1)], unique=True)
            self.db[COLL_ALERTS].create_index([("status", 1)])
            self.db[COLL_ALERTS].create_index([("utility", 1)])
            self.db[COLL_SIMS].create_index([("timestamp", -1)])
            self.db[COLL_CALCS].create_index([("created_at", -1)])
        except Exception as exc:
            log.warning("Sync index creation note: %s", exc)

    async def _retry_loop(self):
        """Periodically retries connection if configured but initially unreachable."""
        while not self.is_connected and self.enabled and self.uri:
            try:
                await asyncio.sleep(15.0)
                if not self.is_connected and self.enabled:
                    await self._connect()
                    if self.is_connected:
                        self.print_connection_status()
                        await self.flush()
                        break
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.debug("Background MongoDB retry attempt failed: %s", e)

    async def stop(self):
        """Flushes remaining items and closes connections."""
        if self._retry_task:
            self._retry_task.cancel()
            self._retry_task = None
        if self._flush_task:
            self._flush_task.cancel()
            self._flush_task = None
        await self.flush()
        if self.client:
            try:
                if hasattr(self.client, "close"):
                    self.client.close()
            except Exception:
                pass
        self.is_connected = False
        log.info("MongoDB manager stopped.")

    # ------------------------------------------------------------ Ingestion API
    async def record_tick(self, tick: Dict[str, Any]):
        """Buffers a real-time tick for asynchronous writing to MongoDB."""
        if not self.enabled:
            return

        clean_doc = sanitize_for_mongo(dict(tick))
        clean_doc["stored_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        # Always record to offline buffer as immediate read cache & fallback
        self.offline_store.insert_tick(clean_doc)
        self.stats["ticks_queued"] += 1

        # Also store alert transitions if tick produced events
        if tick.get("alert_events"):
            for event in tick["alert_events"]:
                await self.record_alert_event(event)

        # Queue for cloud batch write
        lock = self._get_lock()
        async with lock:
            self._tick_buffer.append(clean_doc)
            should_flush = len(self._tick_buffer) >= self.batch_size

        if should_flush:
            await self.flush()

    async def record_alert_event(self, event: Dict[str, Any]):
        """Records an alert transition event (new, escalated, cleared)."""
        if not self.enabled:
            return
        alert = event.get("alert", {})
        if not alert:
            return

        clean_alert = sanitize_for_mongo(dict(alert))
        event_name = event.get("event", "update")
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        clean_alert["last_event"] = event_name
        clean_alert["event_ts"] = now_iso

        event_entry = {
            "event": event_name,
            "ts": now_iso,
            "severity": clean_alert.get("severity"),
            "status": clean_alert.get("status"),
            "value": clean_alert.get("value"),
            "detail": clean_alert.get("detail"),
        }

        self.offline_store.upsert_alert(clean_alert, event_entry=event_entry)
        self.stats["alerts_written"] += 1

        alert_id = clean_alert.get("id")
        sev = str(clean_alert.get("severity", "info")).upper()
        util = str(clean_alert.get("utility", "plant"))
        title = clean_alert.get("title", "")
        ev_label = str(event_name).upper()

        log.info("[MongoDB] Alert #%s [%s] %s - %s: %s", alert_id, ev_label, util, sev, title)
        print(f"[MongoDB] Alert #{alert_id} [{ev_label}] {util} - {sev}: {title}", flush=True)

        if self.is_connected and self.db is not None:
            try:
                update_doc = {
                    "$set": clean_alert,
                    "$push": {"history": event_entry},
                }
                if self.mode == "motor":
                    await self.db[COLL_ALERTS].update_one(
                        {"id": alert_id},
                        update_doc,
                        upsert=True
                    )
                elif self.mode == "pymongo":
                    await asyncio.to_thread(
                        self.db[COLL_ALERTS].update_one,
                        {"id": alert_id},
                        update_doc,
                        True
                    )
            except Exception as exc:
                log.warning("Failed writing alert to MongoDB: %s", exc)

    async def record_alert_ack(self, alert_id: int, alert: Dict[str, Any]):
        """Records an alert acknowledgment."""
        if not self.enabled:
            return
        clean_alert = sanitize_for_mongo(dict(alert))
        clean_alert["acknowledged"] = True
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        clean_alert["ack_ts"] = now_iso

        ack_entry = {
            "event": "acknowledged",
            "ts": now_iso,
            "severity": clean_alert.get("severity"),
            "status": clean_alert.get("status"),
            "value": clean_alert.get("value"),
            "detail": clean_alert.get("detail"),
        }

        self.offline_store.upsert_alert(clean_alert, event_entry=ack_entry)

        sev = str(clean_alert.get("severity", "info")).upper()
        util = str(clean_alert.get("utility", "plant"))
        title = clean_alert.get("title", "")

        log.info("[MongoDB] Alert #%s [ACKNOWLEDGED] by operator (%s - %s: %s)", alert_id, util, sev, title)
        print(f"[MongoDB] Alert #{alert_id} [ACKNOWLEDGED] by operator ({util} - {sev}: {title})", flush=True)

        if self.is_connected and self.db is not None:
            try:
                update_doc = {
                    "$set": clean_alert,
                    "$push": {"history": ack_entry},
                }
                if self.mode == "motor":
                    await self.db[COLL_ALERTS].update_one(
                        {"id": alert_id},
                        update_doc,
                        upsert=True
                    )
                elif self.mode == "pymongo":
                    await asyncio.to_thread(
                        self.db[COLL_ALERTS].update_one,
                        {"id": alert_id},
                        update_doc,
                        True
                    )
            except Exception as exc:
                log.warning("Failed updating acknowledged alert in MongoDB: %s", exc)

    async def record_sim_event(self, action: str, details: Dict[str, Any]):
        """Records simulation lifecycle actions (start, stop, fault, clear, params)."""
        if not self.enabled:
            return
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        doc = {
            "action": action,
            "timestamp": now_iso,
            "details": sanitize_for_mongo(details),
        }
        self.offline_store.insert_sim(doc)
        self.stats["sims_written"] += 1

        log.info("[MongoDB] Recorded simulation event: '%s' to '%s'", action, COLL_SIMS)
        print(f"[MongoDB] Recorded simulation event: '{action}' to '{COLL_SIMS}'", flush=True)

        if self.is_connected and self.db is not None:
            try:
                if self.mode == "motor":
                    await self.db[COLL_SIMS].insert_one(doc)
                elif self.mode == "pymongo":
                    await asyncio.to_thread(self.db[COLL_SIMS].insert_one, doc)
            except Exception as exc:
                log.warning("Failed writing simulation event to MongoDB: %s", exc)

    async def record_calculation(self, calc_type: str, params: Dict[str, Any], result: Dict[str, Any]):
        """Records thermodynamic / polarization / sweep calculations."""
        if not self.enabled:
            return
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        doc = {
            "calc_type": calc_type,
            "created_at": now_iso,
            "params": sanitize_for_mongo(params),
            "result": sanitize_for_mongo(result),
        }
        self.offline_store.insert_calc(doc)
        self.stats["calcs_written"] += 1

        log.info("[MongoDB] Saved calculation '%s' to '%s'", calc_type, COLL_CALCS)
        print(f"[MongoDB] Saved calculation '{calc_type}' to '{COLL_CALCS}'", flush=True)

        if self.is_connected and self.db is not None:
            try:
                if self.mode == "motor":
                    await self.db[COLL_CALCS].insert_one(doc)
                elif self.mode == "pymongo":
                    await asyncio.to_thread(self.db[COLL_CALCS].insert_one, doc)
            except Exception as exc:
                log.warning("Failed writing calculation to MongoDB: %s", exc)

    # ------------------------------------------------------------ Batch Flush
    async def flush(self):
        """Flushes buffered ticks to cloud MongoDB in a single batch."""
        lock = self._get_lock()
        async with lock:
            if not self._tick_buffer:
                return
            batch = list(self._tick_buffer)
            self._tick_buffer.clear()

        now_str = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        self.stats["flushes_total"] += 1
        self.stats["last_flush_ts"] = now_str

        if not self.is_connected or self.db is None:
            # Stored in offline buffer
            return

        try:
            if self.mode == "motor":
                await self.db[COLL_TICKS].insert_many(batch, ordered=False)
            elif self.mode == "pymongo":
                await asyncio.to_thread(self.db[COLL_TICKS].insert_many, batch, ordered=False)
            elif self.mode == "atlas_data_api":
                await self._post_atlas_data_api(COLL_TICKS, batch)
            self.stats["ticks_written"] += len(batch)
            log.info("[MongoDB] Flushed batch of %d telemetry ticks to '%s' (total written: %d)", len(batch), COLL_TICKS, self.stats["ticks_written"])
            print(f"[MongoDB] Flushed batch of {len(batch)} telemetry ticks to '{COLL_TICKS}' (total written: {self.stats['ticks_written']})", flush=True)
        except Exception as exc:
            self.stats["failed_flushes"] += 1
            self.last_error = f"Batch write failed: {exc}"
            log.warning("Failed flushing batch to MongoDB: %s. Re-buffering.", exc)
            print(f"[MongoDB] Failed flushing batch to MongoDB: {exc}. Re-buffering {len(batch)} ticks.", flush=True)
            # Re-queue failed items up to max buffer
            async with self._get_lock():
                self._tick_buffer = (batch + self._tick_buffer)[:MONGODB_MAX_BUFFER]

    async def _post_atlas_data_api(self, collection: str, documents: List[Dict[str, Any]]):
        """Sends batch of documents to MongoDB Atlas Data API over HTTPS."""
        import httpx
        url = f"{ATLAS_DATA_API_URL.rstrip('/')}/action/insertMany"
        payload = {
            "dataSource": ATLAS_DATA_SOURCE,
            "database": self.db_name,
            "collection": collection,
            "documents": documents,
        }
        headers = {
            "Content-Type": "application/json",
            "api-key": ATLAS_DATA_API_KEY,
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()

    async def _flush_loop(self):
        """Background coroutine that flushes ticks periodically."""
        try:
            while True:
                await asyncio.sleep(self.flush_interval)
                await self.flush()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            log.exception("MongoDB flush loop encountered error: %s", exc)

    # ------------------------------------------------------------ Status & Queries
    async def get_status(self) -> Dict[str, Any]:
        """Returns the current MongoDB integration status, modes, and statistics."""
        cloud_counts = {}
        if self.is_connected and self.db is not None:
            try:
                if self.mode == "motor":
                    for c_name in (COLL_TICKS, COLL_ALERTS, COLL_SIMS, COLL_CALCS):
                        cloud_counts[c_name] = await self.db[c_name].count_documents({})
                elif self.mode == "pymongo":
                    for c_name in (COLL_TICKS, COLL_ALERTS, COLL_SIMS, COLL_CALCS):
                        cloud_counts[c_name] = await asyncio.to_thread(self.db[c_name].count_documents, {})
            except Exception:
                cloud_counts = {}

        return {
            "enabled": self.enabled,
            "connected": self.is_connected,
            "status_text": "CONNECTED" if self.is_connected else "NOT CONNECTED",
            "mode": self.mode,
            "database": self.db_name,
            "target": mask_uri(self.uri) if self.uri else (ATLAS_DATA_API_URL or "local offline buffer"),
            "uri_configured": bool(self.uri or ATLAS_DATA_API_URL),
            "cloud_counts": cloud_counts,
            "local_buffer_counts": self.offline_store.counts(),
            "pending_buffer_size": len(self._tick_buffer),
            "stats": dict(self.stats),
            "last_error": self.last_error,
        }

    async def query_ticks(self, start_ts: Optional[str] = None, end_ts: Optional[str] = None,
                          overall: Optional[str] = None, limit: int = 100, skip: int = 0) -> List[Dict[str, Any]]:
        """Queries telemetry ticks from cloud MongoDB (or offline buffer)."""
        start_ts = start_ts if isinstance(start_ts, str) else None
        end_ts = end_ts if isinstance(end_ts, str) else None
        overall = overall if isinstance(overall, str) else None
        limit = limit if isinstance(limit, int) else 100
        skip = skip if isinstance(skip, int) else 0
        limit = max(1, min(1000, limit))
        skip = max(0, skip)

        if self.is_connected and self.db is not None:
            q: Dict[str, Any] = {}
            if start_ts or end_ts:
                ts_q = {}
                if start_ts:
                    ts_q["$gte"] = start_ts
                if end_ts:
                    ts_q["$lte"] = end_ts
                q["ts"] = ts_q
            if overall:
                q["overall"] = overall

            try:
                if self.mode == "motor":
                    cursor = self.db[COLL_TICKS].find(q, {"_id": 0}).sort("ts", -1).skip(skip).limit(limit)
                    return await cursor.to_list(length=limit)
                elif self.mode == "pymongo":
                    def _query():
                        cur = self.db[COLL_TICKS].find(q, {"_id": 0}).sort("ts", -1).skip(skip).limit(limit)
                        return list(cur)
                    return await asyncio.to_thread(_query)
            except Exception as exc:
                log.warning("Cloud query failed (%s), falling back to buffer.", exc)

        return self.offline_store.query_ticks(start_ts, end_ts, overall, limit, skip)

    async def query_alerts(self, status: Optional[str] = None, utility: Optional[str] = None,
                          limit: int = 50, skip: int = 0) -> List[Dict[str, Any]]:
        """Queries stored alerts from cloud MongoDB (or offline buffer)."""
        status = status if isinstance(status, str) else None
        utility = utility if isinstance(utility, str) else None
        limit = limit if isinstance(limit, int) else 50
        skip = skip if isinstance(skip, int) else 0
        limit = max(1, min(500, limit))
        skip = max(0, skip)

        if self.is_connected and self.db is not None:
            q: Dict[str, Any] = {}
            if status and status != "all":
                if status == "acknowledged":
                    q["acknowledged"] = True
                elif status == "unacknowledged":
                    q["status"] = "active"
                    q["acknowledged"] = False
                else:
                    q["status"] = status
            if utility:
                q["utility"] = utility

            try:
                if self.mode == "motor":
                    cursor = self.db[COLL_ALERTS].find(q, {"_id": 0}).sort("id", -1).skip(skip).limit(limit)
                    return await cursor.to_list(length=limit)
                elif self.mode == "pymongo":
                    def _query():
                        cur = self.db[COLL_ALERTS].find(q, {"_id": 0}).sort("id", -1).skip(skip).limit(limit)
                        return list(cur)
                    return await asyncio.to_thread(_query)
            except Exception as exc:
                log.warning("Cloud alerts query failed (%s), falling back to buffer.", exc)

        return self.offline_store.query_alerts(status, utility, limit, skip)

    async def query_simulations(self, limit: int = 50, skip: int = 0) -> List[Dict[str, Any]]:
        """Queries stored simulation run records."""
        limit = limit if isinstance(limit, int) else 50
        skip = skip if isinstance(skip, int) else 0
        limit = max(1, min(500, limit))
        skip = max(0, skip)

        if self.is_connected and self.db is not None:
            try:
                if self.mode == "motor":
                    cursor = self.db[COLL_SIMS].find({}, {"_id": 0}).sort("timestamp", -1).skip(skip).limit(limit)
                    return await cursor.to_list(length=limit)
                elif self.mode == "pymongo":
                    def _query():
                        cur = self.db[COLL_SIMS].find({}, {"_id": 0}).sort("timestamp", -1).skip(skip).limit(limit)
                        return list(cur)
                    return await asyncio.to_thread(_query)
            except Exception as exc:
                log.warning("Cloud simulations query failed (%s), falling back to buffer.", exc)

        return self.offline_store.query_simulations(limit, skip)

    async def query_calculations(self, calc_type: Optional[str] = None, limit: int = 50, skip: int = 0) -> List[Dict[str, Any]]:
        """Queries stored thermodynamic calculations."""
        calc_type = calc_type if isinstance(calc_type, str) else None
        limit = limit if isinstance(limit, int) else 50
        skip = skip if isinstance(skip, int) else 0
        limit = max(1, min(500, limit))
        skip = max(0, skip)

        if self.is_connected and self.db is not None:
            q = {"calc_type": calc_type} if calc_type else {}
            try:
                if self.mode == "motor":
                    cursor = self.db[COLL_CALCS].find(q, {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit)
                    return await cursor.to_list(length=limit)
                elif self.mode == "pymongo":
                    def _query():
                        cur = self.db[COLL_CALCS].find(q, {"_id": 0}).sort("created_at", -1).skip(skip).limit(limit)
                        return list(cur)
                    return await asyncio.to_thread(_query)
            except Exception as exc:
                log.warning("Cloud calculations query failed (%s), falling back to buffer.", exc)

        return self.offline_store.query_calculations(calc_type, limit, skip)


# Global singleton instance
mongo_manager = MongoManager()
