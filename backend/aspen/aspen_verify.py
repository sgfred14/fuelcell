"""
Aspen Plus <-> Python verification (Windows, Aspen Plus, pywin32 + pandas).

STATUS: not tested against a live Aspen install (none was available where this was written). The node paths in PATHS
assume the stream and block names of the Phase 1 setup guide; if your model uses other names, run with --list-nodes.

Usage (run from the folder that contains baseline_results.json):
    python aspen_verify.py "C:\\path\\to\\model.bkp" --list-nodes     # show the stream and block names in YOUR model
    python aspen_verify.py "C:\\path\\to\\model.bkp" --no-run         # compare the results already stored in the file
    python aspen_verify.py "C:\\path\\to\\model.bkp"                  # run the simulation first, then compare
    add --visible to show the Aspen window once the model is open
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd

BASELINE = Path(__file__).with_name("baseline_results.json")

# label -> (Aspen node path, baseline key or number, relative tolerance)
PATHS = {
    "Air to blower (kmol/h)":     (r"\Data\Streams\AIR-AMB\Output\MOLEFLMX\MIXED",    "air_kmol_h",       0.02),
    "Anode inlet T (C)":          (r"\Data\Streams\ANODE-IN\Output\TEMP_OUT\MIXED",   650.0,              0.005),
    "Flue after fuel HX (C)":     (r"\Data\Streams\FLUE-1\Output\TEMP_OUT\MIXED",     "T_flue_after_fuel_pre_C", 0.01),
    "Flue after air HX (C)":      (r"\Data\Streams\FLUE-2\Output\TEMP_OUT\MIXED",     "T_flue_after_air_pre_C",  0.03),
    "Flue to stack (C)":          (r"\Data\Streams\FLUE-OUT\Output\TEMP_OUT\MIXED",   "T_stack_exit_C",   0.05),
    "Air blower brake power (kW)": (r"\Data\Blocks\BLOWER\Output\BRAKE_POWER",        "P_blower_kW",      0.05),
    "Recycle blower power (kW)":  (r"\Data\Blocks\RECLBR\Output\BRAKE_POWER",         "P_recycle_kW",     0.15),
    "Fuel preheater duty (kW)":   (r"\Data\Blocks\FUELHX\Output\HX_DUTY",             "Q_fuel_preheat_kW", 0.05),   # check units (W vs kW)
    "Air preheater duty (kW)":    (r"\Data\Blocks\AIRHX\Output\HX_DUTY",              "Q_air_preheat_kW", 0.03),
    "HRSG steam (kg/h)":          (r"\Data\Streams\STEAM\Output\MASSFLMX\MIXED",      "steam_kg_h",       0.05),
}




HINTS_OPEN = """
Aspen could not open the file. Work through these in order (most likely first):
  1. Close every Aspen Plus window, then end leftover Aspen processes in Task Manager (Details tab) and run again.
     A half-started background instance from an earlier failed run is a common cause.
  2. Open the SAME file by double-clicking it. If the Aspen window cannot open it either, the file is the problem
     (damaged, or saved by a newer Aspen version than the one installed). Re-save it from Aspen with
     File > Save As > Aspen Plus Backup Files (*.bkp). A hidden upgrade prompt cannot be seen from Python:
     open the file once in the Aspen window, accept any upgrade prompt, and save a new .bkp.
  3. Version: the line printed above as "saved by" must not be a NEWER release than the Aspen Plus that Python starts
     ("Aspen Plus 40.0 OLE Services" in the error message). A file from an older release is normally upgraded when opened.
  4. Keep the model in a plain local folder (for example C:\\aspen_work\\). OneDrive "online-only" files and network drives fail.
     This script already works on a copy in a local temp folder, so if that copy step reports an error, OneDrive is the cause:
     right-click the file in File Explorer and choose "Always keep on this device".
  5. If several Aspen versions are installed, Python starts the one that registered last. Use the ProgID of the version you saved with,
     for example --progid Apwn.Document.38.0 (see the registry key HKEY_CLASSES_ROOT\\Apwn.Document.* for what you have).
"""


def load_baseline():
    if not BASELINE.exists():
        sys.exit(f"baseline_results.json not found next to this script ({BASELINE}). Copy it from the same download as sofc_baseline.py.")
    d = json.loads(BASELINE.read_text())
    r = d["results"]
    derived = dict(r)
    derived["H2_kmol_h"] = d["streams_kmol_h"]["fresh"]["H2"]
    derived["air_kmol_h"] = sum(d["streams_kmol_h"]["air"].values())
    return derived


def aspen_processes():
    try:
        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return []
    return sorted({line.split('","')[0].strip('"') for line in out.splitlines() if re.search(r"aspen|apwn", line, re.I)})


def preflight(model):
    """Check the file, print what it says about itself, and return a copy in a plain local folder."""
    src = Path(model)
    if not src.exists():
        sys.exit(f"File not found: {src}\nCheck the path. In Windows use quotes around a path with spaces.")
    if not src.is_file():
        sys.exit(f"Not a file: {src}")
    size = src.stat().st_size
    print(f"Model file : {src}  ({size / 1024:.0f} KB)")
    if size == 0:
        sys.exit("The file is empty (0 bytes). If it lives in OneDrive, make sure it finished syncing, then re-save it from Aspen.")
    try:
        with open(src, "rb") as f:
            head = f.read(4096)
    except OSError as exc:
        sys.exit(f"Cannot read the file ({exc}). If it is in OneDrive: right-click it in File Explorer, choose 'Always keep on this device', and retry.")
    if head.startswith(b"PK"):
        print("File type  : compressed archive (.apwz style), not a plain-text .bkp. That is fine for Aspen, but check the extension.")
    else:
        txt = head.decode("latin-1", errors="replace")
        first = next((ln.strip() for ln in txt.splitlines() if ln.strip()), "")
        m = re.search(r"Aspen Plus[^\r\n]{0,80}", txt)
        print("Saved by   :", m.group(0).strip() if m else f"no Aspen version text found. The file starts with: {first[:90]!r}")
    if src.suffix.lower() not in (".bkp", ".apwz", ".apw"):
        print(f"Warning    : unexpected extension '{src.suffix}'. Expected .bkp, .apwz or .apw.")
    procs = aspen_processes()
    if procs:
        print("Running    : Aspen-related processes already running:", ", ".join(procs), "(close them if opening fails)")
    work = Path(tempfile.gettempdir()) / "sofc_verify"
    work.mkdir(exist_ok=True)
    dst = work / ("model" + src.suffix.lower())
    try:
        shutil.copy2(src, dst)
    except Exception as exc:
        sys.exit(f"Could not copy the model to {work} ({exc}). Close any program holding the file and retry.")
    print(f"Working copy: {dst}")
    return dst


def open_model(win32, model, progid, visible):
    app = win32.Dispatch(progid)
    try:
        if Path(model).suffix.lower() == ".apw":
            app.InitFromFile2(str(model))
        else:
            app.InitFromArchive2(str(model))
    except Exception as exc:
        try:
            app.Close()
        except Exception:
            pass
        print(f"\nOpening failed: {exc}")
        print(HINTS_OPEN)
        sys.exit(2)
    try:
        app.Visible = bool(visible)               # Aspen only accepts this AFTER the document is initialised
    except Exception as exc:
        print(f"(could not change window visibility: {exc})")
    return app


def children(app, path):
    node = app.Tree.FindNode(path)
    if node is None:
        return None
    els = node.Elements
    names = []
    for i in range(els.Count):
        try:
            names.append(els.Item(i).Name)
        except Exception:
            names.append(els.Item(i + 1).Name)
    return names


def list_nodes(app):
    for label, p in (("Streams", r"\Data\Streams"), ("Blocks", r"\Data\Blocks")):
        names = children(app, p)
        print(f"\n{label}:", "path not found" if names is None else (", ".join(names) or "none"))
    print("\nThe PATHS table expects these IDs:")
    ids = sorted({re.search(r"\\(?:Streams|Blocks)\\([^\\]+)", v[0]).group(1) for v in PATHS.values()})
    streams = set(children(app, r"\Data\Streams") or []) | set(children(app, r"\Data\Blocks") or [])
    for i in ids:
        print(f"  {i:10s}", "found" if i in streams else "MISSING: rename it in your model or edit PATHS")


def read_node(app, path):
    node = app.Tree.FindNode(path)
    if node is None:
        raise KeyError("node not found")
    return float(node.Value)


def main():
    ap = argparse.ArgumentParser(description="Compare an Aspen Plus model with the Phase 1 baseline.")
    ap.add_argument("model")
    ap.add_argument("--no-run", action="store_true", help="compare the results stored in the file, do not run")
    ap.add_argument("--list-nodes", action="store_true", help="list the stream and block IDs in the model and exit")
    ap.add_argument("--visible", action="store_true", help="show the Aspen window after the model is open")
    ap.add_argument("--progid", default="Apwn.Document", help="COM ProgID, for example Apwn.Document.38.0 to pick a version")
    a = ap.parse_args()

    local = preflight(a.model)
    import win32com.client as win32                       # imported late so the file checks above work anywhere

    app = open_model(win32, local, a.progid, a.visible)
    try:
        print("Opened     : OK")
        if a.list_nodes:
            list_nodes(app)
            return
        if not a.no_run:
            app.Engine.Run2()
            while app.Engine.IsRunning:
                pass
        base = load_baseline()
        rows = []
        for label, (path, ref, tol) in PATHS.items():
            expected = base[ref] if isinstance(ref, str) else ref
            try:
                got = read_node(app, path)
                err = (got - expected) / expected if expected else float("nan")
                status = "OK" if abs(err) <= tol else "CHECK"
            except Exception as exc:
                got, err, status = float("nan"), float("nan"), f"ERR ({exc})"
            rows.append(dict(item=label, aspen=got, baseline=expected, rel_err_pct=100 * err, tol_pct=100 * tol, status=status))
        df = pd.DataFrame(rows)
        pd.set_option("display.width", 160)
        print("\n" + df.to_string(index=False, float_format=lambda x: f"{x:,.3f}"))
        out = Path.cwd() / "aspen_vs_baseline.csv"
        df.to_csv(out, index=False)
        print(f"\nSaved {out}")
        if (df.status.str.startswith("ERR")).all():
            print("Every node failed to read. The stream/block IDs in your model probably differ: run with --list-nodes.")
    finally:
        try:
            app.Close()
        except Exception:
            pass


if __name__ == "__main__":
    main()