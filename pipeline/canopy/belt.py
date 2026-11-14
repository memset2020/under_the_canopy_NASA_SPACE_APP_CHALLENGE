"""Belt mode: detailed NISAR maps for every flooded-forest cell, at $0 (docs/13, D-057).

One compact build per 0.25° cell of the global grid, using only free open data through
Earthdata Login: NISAR GCOV window reads, OPERA DSWx-S1, NASADEM and GEDI (terrain gate),
plus ESA WorldCover (vegetation gate). Outputs per cell are small (peak-pass classes, days
flooded, a few numbers) and go to web/data/belt/, indexed by belt/index.json; the cell's raw
inputs stay under pipeline/data/raw/<cell id>/ like any site.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from . import config, png
from . import global_layers as gl
from . import hotspots as hs

BELT_DIR = config.WEB_DATA_DIR / "belt"
CELL_PX = 256  # ≈ 110 m pixels across a 0.25° cell
MIN_PASSES = 6  # docs/04 §7
STEPS = [
    ("radar", ["fetch", "--gcov"]),
    ("land cover", ["fetch", "--worldcover"]),
    ("C-band water", ["fetch", "--dswx"]),
    ("terrain and canopy", ["fetch", "--nasa", "--only", "dem,canopy"]),
]


def cell_id(row: int, col: int) -> str:
    return f"cell_{row:03d}_{col:04d}"


def cell_site(row: int, col: int) -> dict:
    """A site config covering exactly one 0.25° cell of the global grid."""
    w = -180 + col * gl.RES_DEG
    n = 90 - row * gl.RES_DEG
    lat, lon = n - gl.RES_DEG / 2, w + gl.RES_DEG / 2
    where = f"{abs(lat):.2f}°{'N' if lat >= 0 else 'S'}, {abs(lon):.2f}°{'E' if lon >= 0 else 'W'}"
    return {
        "id": cell_id(row, col),
        "name": f"Belt cell {where}",
        "country": "",
        "bbox": [w, n - gl.RES_DEG, w + gl.RES_DEG, n],
        "zoom": 11,
        "language": "en",
        "flood_season": "unknown (belt cell)",
        "belt": True,
    }


def plan(scope: str = "strict") -> list[tuple[int, int, float]]:
    """(row, col, score) of belt cells, best first. strict = the D-056 hotspot rule without
    spacing; full = every "hidden floods likely" cell with ≥ 6 passes."""
    layers = hs._load(config.WEB_DATA_DIR / "global")
    if scope == "strict":
        cands = hs.candidates(layers, 7)
        out = []
        for score, lon, lat in cands:
            row, col = int((90 - lat) / gl.RES_DEG), int((lon + 180) / gl.RES_DEG)
            out.append((row, col, score))
        return out
    likely, passes = layers["likely"], layers["nisar_passes"]
    rows, cols = np.nonzero((likely == 2) & (passes != gl.NODATA) & (passes >= 6))
    rng = layers["cygnss_range_pct"].astype(float)
    return sorted(
        ((int(r), int(c), float(rng[r, c])) for r, c in zip(rows, cols, strict=True)),
        key=lambda x: -x[2],
    )


def _local_sites_add(site: dict) -> None:
    path = config.LOCAL_SITES_FILE
    doc = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {"sites": []}
    if not any(s["id"] == site["id"] for s in doc["sites"]):
        doc["sites"].append(site)
        path.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def run_cell(row: int, col: int, log=print, force: bool = False) -> dict | None:
    """Fetch and build one cell; returns its index entry, or None if it cannot be mapped.

    A mapped cell is reused unless `force` (a rerun after the track choice changed, D-064)."""
    site = cell_site(row, col)
    if not force and (BELT_DIR / site["id"] / "cell.json").is_file():
        return json.loads((BELT_DIR / site["id"] / "cell.json").read_text(encoding="utf-8"))
    _local_sites_add(site)
    gcov = config.RAW_DIR / site["id"] / "gcov"
    for label, args in STEPS:
        cmd = [sys.executable, "cli.py", *args, "--site", site["id"]]
        tries = 2 if label == "radar" else 1  # radar reads resume, so a retry costs little
        for attempt in range(tries):
            proc = subprocess.run(  # noqa: S603 - fixed argv
                cmd, cwd=config.PIPELINE_DIR, capture_output=True, text=True, timeout=7200
            )
            if proc.returncode == 0:
                break
            tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or [""]
            why = tail[0][:120]
            log(f"  {site['id']}: {label} exit {proc.returncode} (try {attempt + 1}) {why}")
    n = len(list(gcov.glob("*.h5"))) if gcov.is_dir() else 0
    if n < MIN_PASSES:
        log(f"  {site['id']}: only {n} radar pass(es), {MIN_PASSES} needed")
        return None
    with tempfile.TemporaryDirectory() as tmp:
        cmd = [
            sys.executable,
            "cli.py",
            "all",
            "--site",
            site["id"],
            "--out",
            tmp,
            "--grid",
            str(CELL_PX),
        ]
        proc = subprocess.run(  # noqa: S603 - fixed argv
            cmd, cwd=config.PIPELINE_DIR, capture_output=True, text=True, timeout=7200
        )
        summary_path = Path(tmp) / site["id"] / "summary.json"
        if proc.returncode != 0 or not summary_path.is_file():
            log(f"  {site['id']}: build failed ({proc.stderr.strip()[-160:]})")
            return None
        return export_cell(site, Path(tmp) / site["id"])


def _no_radar(s: dict, built: Path) -> np.ndarray | None:
    """(P, H, W) True where a pass has no HH or HV, read from the built stack."""
    g, grid = s.get("grid_stack"), s["grid"]
    if not g or not (built / g["stack_file"]).is_file():
        return None
    f = built / g["stack_file"]
    p, h, w = len(s["passes"]), grid["height"], grid["width"]
    stack = np.fromfile(f, dtype=np.uint8)[: len(g["layers"]) * p * h * w]
    stack = stack.reshape(len(g["layers"]), p, h, w)
    names = [layer["name"] for layer in g["layers"]]
    hh, hv = (g["layers"][names.index(n)] for n in ("hh", "hv"))
    return (stack[names.index("hh")] == hh["nodata"]) | (stack[names.index("hv")] == hv["nodata"])


def export_cell(site: dict, built: Path) -> dict:
    """Keep only what the belt overlay shows: peak classes, days flooded, a few numbers."""
    s = json.loads((built / "summary.json").read_text(encoding="utf-8"))
    out = BELT_DIR / site["id"]
    out.mkdir(parents=True, exist_ok=True)
    peak = next(p for p in s["passes"] if p["id"] == s["peak_pass"])
    shutil.copy(built / peak["class_png"], out / "peak_class.png")
    shutil.copy(built / s["products"]["hydroperiod"]["png"], out / "days_flooded.png")
    no_radar = _no_radar(s, built)
    if no_radar is not None:
        # Stripe what the radar never saw: the peak pass for its map, any pass for days flooded.
        k = s["passes"].index(peak)
        for name, mask in (("peak_class.png", no_radar[k]), ("days_flooded.png", no_radar.any(0))):
            if mask.any():
                rgba = png.decode_png((out / name).read_bytes())
                png.write_png(out / name, png.stripe_no_radar(rgba, mask))
    entry = {
        "id": site["id"],
        "bounds": s["grid"]["bounds"],
        "passes": len(s["passes"]),
        "first": s["passes"][0]["date"],
        "last": s["passes"][-1]["date"],
        "peak_date": peak["date"],
        "peak_flooded_km2": round(peak["flooded_km2"], 2),
        "peak_hidden_km2": round(peak["flooded_veg_km2"], 2),
        "hidden_from_cband_km2": peak["hidden_from_cband_km2"],
        "flooded_any_km2": round(s["products"]["hydroperiod"]["flooded_any_km2"], 2),
        "peak_png": f"{site['id']}/peak_class.png",
        "days_png": f"{site['id']}/days_flooded.png",
        "max_days": s["products"]["hydroperiod"]["max_days"],
        "warnings": sorted({w["code"] for w in s["warnings"]}),
    }
    (out / "cell.json").write_text(json.dumps(entry) + "\n", encoding="utf-8")
    return entry


def write_index() -> dict:
    cells = [
        json.loads(p.read_text(encoding="utf-8")) for p in sorted(BELT_DIR.glob("cell_*/cell.json"))
    ]

    doc = {
        "res_deg": gl.RES_DEG,
        "thresholds": "literature defaults (docs/04 §4.3); not calibrated per cell",
        "cells": cells,
    }
    BELT_DIR.mkdir(parents=True, exist_ok=True)
    (BELT_DIR / "index.json").write_text(json.dumps(doc) + "\n", encoding="utf-8")
    return doc
