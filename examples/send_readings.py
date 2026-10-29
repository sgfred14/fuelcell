#!/usr/bin/env python3
"""
Send readings to the monitor's HTTP endpoint. Standard library only, so it runs anywhere Python 3.8+ does.

Replay a CSV (first column `ts`, other columns are channel names):
    python examples/send_readings.py --csv examples/sample_normal_then_blower_fade.csv --interval 0.2

Use it as a template for live sensors: replace `rows()` with a function that reads your PLC / historian / OPC UA server
and yields (iso_timestamp, {channel: value}) every few seconds.

The server must not be running its demo simulator (start it with SIM_AUTOSTART=0 or POST /api/sim/stop).
"""
import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request


def rows(path):
    with open(path, newline="") as f:
        for r in csv.DictReader(f):
            ts = r.pop("ts")
            yield ts, {k: (float(v) if v not in ("", None) else None) for k, v in r.items()}


def post(url, body, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-API-Key"] = key
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--interval", type=float, default=1.0, help="seconds between readings")
    ap.add_argument("--api-key", default=os.environ.get("MONITOR_API_KEY"))
    ap.add_argument("--final", action="store_true", help="each reading is a complete minute (use when sending one reading per minute)")
    a = ap.parse_args()
    endpoint = a.url.rstrip("/") + "/api/ingest" + ("?final=true" if a.final else "")
    n = 0
    try:
        for ts, values in rows(a.csv):
            out = post(endpoint, {"ts": ts, "source": "csv-replay", "values": values}, a.api_key)
            n += 1
            if out.get("unknown_channels"):
                print("ignored unknown channels:", out["unknown_channels"], file=sys.stderr)
            time.sleep(a.interval)
    except urllib.error.HTTPError as e:
        print(f"server refused the reading ({e.code}): {e.read().decode()[:300]}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"cannot reach {a.url}: {e.reason}", file=sys.stderr)
        sys.exit(1)
    print(f"sent {n} readings")


if __name__ == "__main__":
    main()
