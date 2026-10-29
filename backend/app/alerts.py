"""Alert lifecycle: one alert per condition, raised after persistence, escalated, acknowledged, cleared."""
import collections
import itertools

SEV_RANK = {"ok": 0, "unknown": 0, "warning": 1, "alarm": 2}


class AlertManager:
    def __init__(self, max_history=500):
        self._ids = itertools.count(1)
        self.active = {}                                   # key -> alert
        self.history = collections.deque(maxlen=max_history)

    def raise_or_update(self, key, ts, utility, severity, title, detail, source, value=None, hint="", check_id=None, unit=""):
        a = self.active.get(key)
        if a is None:
            a = dict(id=next(self._ids), key=key, utility=utility, severity=severity, peak_severity=severity, title=title,
                     detail=detail, hint=hint, source=source, sources=[source], check_id=check_id, value=value, unit=unit,
                     first_ts=ts, last_ts=ts, status="active", acknowledged=False, cleared_ts=None, updates=1)
            self.active[key] = a
            return "new", a
        escalated = SEV_RANK[severity] > SEV_RANK[a["severity"]]
        if escalated:
            a["severity"] = a["peak_severity"] = severity
            a["acknowledged"] = False                      # an escalation must be seen again
        a.update(title=title, detail=detail, value=value, last_ts=ts)
        a["updates"] += 1
        return ("escalated" if escalated else "update"), a

    def confirm(self, key, source):
        a = self.active.get(key)
        if a and source not in a["sources"]:
            a["sources"].append(source)
            return True
        return False

    def clear(self, key, ts):
        a = self.active.pop(key, None)
        if a is None:
            return None
        a["status"], a["cleared_ts"] = "cleared", ts
        self.history.appendleft(a)
        return a

    def ack(self, alert_id):
        for a in self.active.values():
            if a["id"] == alert_id:
                a["acknowledged"] = True
                return a
        return None

    def active_list(self):
        return sorted(self.active.values(), key=lambda a: (-SEV_RANK[a["severity"]], a["first_ts"]))

    def utility_severity(self, utility):
        r = max((SEV_RANK[a["severity"]] for a in self.active.values() if a["utility"] == utility), default=0)
        return {0: "ok", 1: "warning", 2: "alarm"}[r]

    def recent(self, n=50):
        return list(self.history)[:n]
