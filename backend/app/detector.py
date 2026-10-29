"""
Streaming detector. Feed it readings (any rate); it works on one-minute averages.

Per finished minute:
  1. update the rolling buffers (forward-fill a missing channel for up to 5 minutes, then mark it stale)
  2. evaluate the 16 physics checks; a check must stay out of band for 3 minutes before an alert is raised,
     and back in band for 8 minutes before it is cleared
  3. sensor checks: stale, out of plausible range, flat-lined
  4. every 5 minutes: score the last hour (12 x 5-min averages) with the trained autoencoder. Three flagged steps in a row
     (15 min) raise a "learned model" alert, attributed to the utility with the largest reconstruction error. If a
     physics alert is already open on that utility, the learned model is recorded as a confirmation instead.
"""
import collections
import math
import threading
from datetime import datetime, timedelta, timezone

import numpy as np

from . import checks as K
from .alerts import AlertManager, SEV_RANK

RAISE_N = 3          # minutes out of band before an alert is raised
CLEAR_N = 8          # minutes back in band before it is cleared
STALE_AFTER = 5      # minutes without a value before a sensor alert
FLATLINE_MIN = 30
AE_STEP_MIN = 5
AE_RAISE_N = 3
AE_CLEAR_N = 3
HISTORY_MIN = 1440
UTILITY_NAMES = {u["id"]: u["name"] for u in K.UTILITIES}
UTILITY_NAMES["plant"] = "Plant-wide"


def _iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _clean(x):
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return x


class Detector:
    def __init__(self, ae=None):
        self.lock = threading.RLock()
        self.ae = ae
        self.alerts = AlertManager()
        self.reset_state()

    # ------------------------------------------------------------ state
    def reset_state(self):
        with self.lock:
            self.buf = {ch: collections.deque(maxlen=60) for ch in K.CHANNELS}
            self.flat = {ch: collections.deque(maxlen=FLATLINE_MIN) for ch in K.CHANNELS}
            self.last = {}
            self.stale = {ch: 0 for ch in K.CHANNELS}
            self.range_run = {ch: 0 for ch in K.CHANNELS}
            self.minute_log = collections.deque(maxlen=5)
            self.cstate = {c.id: dict(warn=0, alarm=0, ok=0) for c in K.CHECKS}
            self.ae_buf = collections.deque(maxlen=self.ae.window if self.ae else 12)
            self.ae_flag_run = self.ae_ok_run = 0
            self.ae_last = dict(score=None, threshold=self.ae.threshold if self.ae else None, flag=False, top=[], utility=None)
            self.bin_key = None
            self.acc = {}
            self.bin_meta = {}
            self.last_minute = None
            self.minutes = 0
            self.history = collections.deque(maxlen=HISTORY_MIN)
            self.latest = None
            self.stats = dict(readings=0, late=0, unknown_channels=0, gaps=0, last_reading_wall=None, source=None)
            self.alerts.active.clear()
            self.alerts.history.clear()

    def info(self):
        return dict(learned_model=bool(self.ae), ae_threshold=self.ae.threshold if self.ae else None,
                    raise_minutes=RAISE_N, clear_minutes=CLEAR_N, ae_step_minutes=AE_STEP_MIN, **self.stats)

    # ------------------------------------------------------------ ingest
    def ingest(self, ts: datetime, values: dict, source="plant", meta=None, final=False):
        """Add one reading. Returns the list of ticks (one per finished minute)."""
        with self.lock:
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            key = ts.replace(second=0, microsecond=0)
            self.stats["readings"] += 1
            self.stats["source"] = source
            self.stats["last_reading_wall"] = datetime.now(timezone.utc).isoformat()
            ticks = []
            if self.bin_key is not None and key < self.bin_key:
                self.stats["late"] += 1
                return ticks
            if self.bin_key is not None and key > self.bin_key:
                ticks.append(self._finalize())
            if self.bin_key is None:
                self.bin_key, self.acc = key, {}
            for ch, v in values.items():
                if ch not in K.CHANNELS:
                    self.stats["unknown_channels"] += 1
                    continue
                if v is None or (isinstance(v, float) and not math.isfinite(v)):
                    continue
                self.acc.setdefault(ch, []).append(float(v))
            self.bin_meta = meta or {}
            if final:
                ticks.append(self._finalize())
            return [t for t in ticks if t]

    def flush(self):
        with self.lock:
            return [self._finalize()] if self.bin_key is not None and self.acc else []

    # ------------------------------------------------------------ one finished minute
    def _finalize(self):
        key, acc, meta = self.bin_key, self.acc, self.bin_meta
        self.bin_key, self.acc, self.bin_meta = None, {}, {}
        if self.last_minute is not None:
            gap = int((key - self.last_minute).total_seconds() // 60)
            if gap > 1:
                self.stats["gaps"] += 1
                self.ae_buf.clear()
                self.minute_log.clear()
                if gap > 5:
                    for d in self.buf.values():
                        d.clear()
        self.last_minute = key
        self.minutes += 1
        events, vec, stale_now = [], {}, []
        for ch in K.CHANNELS:
            if ch in acc:
                v = float(np.mean(acc[ch]))
                self.last[ch], self.stale[ch] = v, 0
            else:
                self.stale[ch] += 1
                v = self.last.get(ch, math.nan) if self.stale[ch] <= STALE_AFTER else math.nan
                if self.stale[ch] > 0:
                    stale_now.append(ch)
            vec[ch] = v
            self.buf[ch].append(v)
            self.flat[ch].append(v)
        self.minute_log.append(vec)

        ts = _iso(key)
        cvals = K.compute_values({ch: np.array(d, float) for ch, d in self.buf.items()})
        check_out = {}
        for c in K.CHECKS:
            val = cvals.get(c.id, math.nan)
            st = K.status_of(c, val)
            check_out[c.id] = dict(value=_clean(float(val)) if val is not None else None, status=st)
            events += self._apply_check(c, val, st, ts)
        events += self._sensor_checks(ts)
        ae_out = self._ae_step(ts, events)

        utilities = {}
        for u in K.UTILITIES:
            sev = self.alerts.utility_severity(u["id"])
            inst = max((SEV_RANK[check_out[cid]["status"]] for cid in u["checks"]), default=0)
            known = any(not math.isnan(vec[ch]) for ch in u["channels"])
            utilities[u["id"]] = dict(status=sev if known else "unknown", instant=["ok", "warning", "alarm"][inst] if known else "unknown")
        active = self.alerts.active_list()
        overall = "alarm" if any(a["severity"] == "alarm" for a in active) else ("warning" if active else "ok")
        tick = dict(type="tick", ts=ts, minute=self.minutes, values={ch: _clean(v) for ch, v in vec.items()},
                    stale=stale_now, checks=check_out, utilities=utilities, ae=ae_out, alerts=active,
                    alert_events=events, overall=overall, meta=meta)
        self.history.append(dict(ts=ts, v=tick["values"], c={k: x["value"] for k, x in check_out.items()},
                                 ae=ae_out["score"], meta=meta))
        self.latest = tick
        return tick

    # ------------------------------------------------------------ physics checks
    def _apply_check(self, c, val, st, ts):
        s = self.cstate[c.id]
        if st == "unknown":
            return []
        if st == "alarm":
            s["alarm"] += 1; s["warn"] += 1; s["ok"] = 0
        elif st == "warning":
            s["warn"] += 1; s["alarm"] = 0; s["ok"] = 0
        else:
            s["ok"] += 1; s["warn"] = s["alarm"] = 0
        key, events = f"chk:{c.id}", []
        sev = "alarm" if s["alarm"] >= RAISE_N else ("warning" if s["warn"] >= RAISE_N else None)
        if sev:
            lim = K.limit_text(c, val, sev)
            u = f" {c.unit}" if c.unit and c.unit not in ("%", "×") else c.unit
            title = f"{c.label} {lim}"
            detail = f"{c.label} is {val:.{c.decimals}f}{u} ({lim}). {c.what}"
            ev, a = self.alerts.raise_or_update(key, ts, c.utility, sev, title, detail, "physics", float(val), c.hint, c.id, c.unit)
            if ev in ("new", "escalated"):
                events.append(dict(event=ev, alert=dict(a)))
        elif s["ok"] >= CLEAR_N and key in self.alerts.active:
            a = self.alerts.clear(key, ts)
            events.append(dict(event="cleared", alert=dict(a)))
        return events

    # ------------------------------------------------------------ sensor checks
    def _sensor_checks(self, ts):
        events = []
        for ch in K.CHANNELS:
            util = K.CHANNEL_UTILITY.get(ch, "plant")
            label = K.LABELS[ch]
            lo, hi = K.RANGES[ch]
            v = self.buf[ch][-1]
            for kind, bad, text, hint in (
                ("stale", self.stale[ch] > STALE_AFTER, f"{label} has sent no data for {self.stale[ch]} min",
                 "Check the transmitter, its cabling and the data connection."),
                ("range", (not math.isnan(v)) and (v < lo or v > hi), f"{label} reads {v:.4g}, outside its plausible range {lo:g} to {hi:g}",
                 "Check the sensor, its scaling and wiring. The process checks that use this reading are unreliable until it is fixed."),
                ("flat", len(self.flat[ch]) == FLATLINE_MIN and not any(math.isnan(x) for x in self.flat[ch])
                 and ch not in ("load_set",) and float(np.ptp(self.flat[ch])) == 0.0,
                 f"{label} has not changed at all for {FLATLINE_MIN} min", "A frozen value usually means a stuck transmitter or a stale data feed."),
            ):
                key = f"sensor:{kind}:{ch}"
                if bad:
                    if kind == "range":
                        self.range_run[ch] += 1
                        if self.range_run[ch] < RAISE_N:
                            continue
                    ev, a = self.alerts.raise_or_update(key, ts, util, "warning", text, text + ".", "sensor", None if math.isnan(v) else v, hint)
                    if ev == "new":
                        events.append(dict(event=ev, alert=dict(a)))
                else:
                    if kind == "range":
                        self.range_run[ch] = 0
                    if key in self.alerts.active:
                        a = self.alerts.clear(key, ts)
                        events.append(dict(event="cleared", alert=dict(a)))
        return events

    # ------------------------------------------------------------ learned model
    def _ae_step(self, ts, events):
        out = dict(self.ae_last)
        out["available"] = bool(self.ae)
        if not self.ae:
            return out
        if self.minutes % AE_STEP_MIN == 0 and len(self.minute_log) == AE_STEP_MIN:
            arr = np.array([[m[ch] for ch in self.ae.channels] for m in self.minute_log], float)
            if np.isnan(arr).any():
                self.ae_buf.clear()
            else:
                self.ae_buf.append(arr.mean(0))
            if len(self.ae_buf) == self.ae.window:
                score, ch_err = self.ae.score(np.array(self.ae_buf))
                flag = score > self.ae.threshold
                order = [i for i in np.argsort(-ch_err) if self.ae.channels[i] not in K.CONTEXT_CHANNELS]
                top = [dict(channel=self.ae.channels[i], label=K.LABELS[self.ae.channels[i]], sigma=float(ch_err[i])) for i in order[:3]]
                util = K.CHANNEL_UTILITY.get(top[0]["channel"], "plant") if top else "plant"
                self.ae_last = dict(score=float(score), threshold=self.ae.threshold, flag=bool(flag), top=top, utility=util)
                self.ae_flag_run, self.ae_ok_run = (self.ae_flag_run + 1, 0) if flag else (0, self.ae_ok_run + 1)
                events += self._ae_alert(ts, score, top, util)
            out = dict(self.ae_last); out["available"] = True
        return out

    def _ae_alert(self, ts, score, top, util):
        events = []
        key = f"ae:{util}"
        if self.ae_flag_run >= AE_RAISE_N and top:
            open_checks = [a for a in self.alerts.active.values() if a["source"] in ("physics", "sensor")]
            if open_checks:
                # A fault spreads: the autoencoder then points at whichever signal moves most. While a limit-based alert is
                # open, the learned model confirms it (same utility) or stays quiet instead of opening a second alert.
                for a in open_checks:
                    if a["utility"] == util and self.alerts.confirm(a["key"], "learned"):
                        events.append(dict(event="confirmed", alert=dict(a)))
                return events
            names = ", ".join(f"{t['label']} ({t['sigma']:.1f}σ)" for t in top)
            detail = (f"The trained model no longer recognises the last hour of operation as normal "
                      f"(score {score:.2f}, limit {self.ae.threshold:.2f}). Largest deviations: {names}.")
            ev, a = self.alerts.raise_or_update(key, ts, util, "warning", f"Unusual pattern in {UTILITY_NAMES[util].lower()}", detail,
                                                "learned", float(score),
                                                "No single limit has been crossed. Compare the listed signals with their normal behaviour at this load.", None, "")
            if ev == "new":
                events.append(dict(event=ev, alert=dict(a)))
        elif self.ae_ok_run >= AE_CLEAR_N:
            for k in [k for k in self.alerts.active if k.startswith("ae:")]:
                a = self.alerts.clear(k, ts)
                events.append(dict(event="cleared", alert=dict(a)))
        return events

    # ------------------------------------------------------------ views
    def snapshot(self, history_minutes=240):
        with self.lock:
            hist = list(self.history)[-history_minutes:]
            return dict(type="snapshot", latest=self.latest, history=hist, alerts=self.alerts.active_list(),
                        recent_alerts=self.alerts.recent(50), info=self.info())
