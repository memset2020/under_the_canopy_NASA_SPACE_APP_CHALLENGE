"""VIIRS 375 m active fire: where and when a fire burned, day by day (docs/15 §2).

NISAR passes every 12 days; the VIIRS imagers on Suomi NPP, NOAA-20 and NOAA-21 see a fire's
heat several times a day through smoke (not through thick cloud). Their detections say what
happened between two radar passes and give an independent date for each burned patch.

Fetching reads only the fire-pixel arrays of each granule (FP_latitude, FP_longitude, FP_power,
FP_confidence) from NASA Earthdata (LAADS), so a season over one site is a few megabytes.
"""

from __future__ import annotations

import csv
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from pathlib import Path

import numpy as np

# VIIRS 375 m active fire, standard products (the same detections FIRMS serves).
SENSORS = {"VNP14IMG": "Suomi NPP", "VJ114IMG": "NOAA-20", "VJ214IMG": "NOAA-21"}
SOURCE = "NASA VIIRS 375 m active fire v002 (VNP14IMG, VJ114IMG, VJ214IMG)"
# One collection version only, so a reprocessed copy of a granule is never counted twice.
VERSION = "002"
# FP_confidence for the 375 m product: 7 low, 8 nominal, 9 high (Schroeder et al. 2014).
CONFIDENCE = {7: "low", 8: "nominal", 9: "high"}
# Detections are binned to cells of this size before dates are compared with NISAR's: a VIIRS
# pixel is 375 m at nadir and up to ~800 m at the swath edge.
CELL_DEG = 0.005
# Position step of the published points (degrees, ~10 m).
STEP_DEG = 0.0001


def _arrays(f):
    import h5py

    h = h5py.File(f, "r")
    if "FP_latitude" not in h:
        return None
    lat = np.asarray(h["FP_latitude"])
    if lat.size == 0:
        return None
    lon = np.asarray(h["FP_longitude"])
    frp = np.asarray(h["FP_power"])
    conf = np.asarray(h["FP_confidence"]) if "FP_confidence" in h else np.full(lat.shape, 8)
    return lat, lon, frp, conf


def _read(granule_and_file, bbox) -> list[tuple] | None:
    """Fire pixels of one granule inside bbox; None if the granule could not be read (the
    archive sometimes answers 502 under load: one retry, then it is counted as missed)."""
    g, f = granule_and_file
    w, s, e, n = bbox
    t = g["umm"]["TemporalExtent"]["RangeDateTime"]["BeginningDateTime"][:19]
    short = g["umm"]["CollectionReference"]["ShortName"]
    got = None
    for attempt in range(2):
        try:
            got = _arrays(f)
            break
        except Exception:  # noqa: BLE001 - network or file errors from the remote read
            if attempt:
                return None
            time.sleep(5)
    if got is None:
        return []
    lat, lon, frp, conf = got
    sel = (lon >= w) & (lon <= e) & (lat >= s) & (lat <= n)
    return [
        (short, t, round(float(a), 5), round(float(b), 5), round(float(c), 2), int(d))
        for a, b, c, d in zip(lat[sel], lon[sel], frp[sel], conf[sel], strict=True)
    ]


def fetch(
    site: dict,
    start: date,
    end: date,
    out_csv: Path,
    log=print,
    workers: int = 8,
    sensors: tuple[str, ...] = tuple(SENSORS),
) -> Path:
    """Every VIIRS 375 m fire pixel in the site box between start and end, to a CSV."""
    from . import nasa_access as na

    ea = na._earthaccess()
    na.login()
    bbox = tuple(float(v) for v in site["bbox"])
    rows: list[tuple] = []
    missed: list[str] = []
    for short in sensors:
        grans = ea.search_data(
            short_name=short,
            version=VERSION,
            bounding_box=bbox,
            temporal=(start.isoformat(), end.isoformat()),
            count=2000,
        )
        if not grans:
            continue
        files = ea.open(grans)
        with ThreadPoolExecutor(workers) as pool:
            got_all = pool.map(lambda gf: _read(gf, bbox), zip(grans, files, strict=True))
            for g, got in zip(grans, got_all, strict=True):
                if got is None:
                    missed.append(g["umm"]["GranuleUR"])
                else:
                    rows.extend(got)
        log(f"  active fire: {short} ({SENSORS[short]}) {len(grans)} granules")
    rows.sort(key=lambda r: r[1])
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(["product", "time_utc", "lat", "lon", "frp_mw", "confidence"])
        wr.writerows(rows)
    log(f"  active fire: {len(rows)} fire pixels → {out_csv}")
    # Granules that could not be read are listed, never silently dropped (docs/15 §2).
    miss = out_csv.with_name("active_fire_missed.txt")
    miss.write_text("".join(f"{m}\n" for m in missed), encoding="utf-8")
    if missed:
        log(f"  active fire: {len(missed)} granules could not be read (listed in {miss.name})")
    return out_csv


def load(raw: Path) -> dict | None:
    """The fetched detections as arrays, or None."""
    f = raw / "nasa" / "active_fire.csv"
    if not f.is_file():
        return None
    with f.open(encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        return {
            "time": [],
            "lat": np.zeros(0),
            "lon": np.zeros(0),
            "frp": np.zeros(0),
            "conf": np.zeros(0, int),
            "product": [],
        }
    return {
        "time": [datetime.fromisoformat(r["time_utc"]) for r in rows],
        "lat": np.array([float(r["lat"]) for r in rows]),
        "lon": np.array([float(r["lon"]) for r in rows]),
        "frp": np.array([float(r["frp_mw"]) for r in rows]),
        "conf": np.array([int(r["confidence"]) for r in rows]),
        "product": [r["product"] for r in rows],
    }


def _cell(lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    return np.floor(lat / CELL_DEG).astype(np.int64) * 100_000 + np.floor(lon / CELL_DEG).astype(
        np.int64
    )


def date_check(
    det: dict, first: np.ndarray, dates: list[date], bbox: tuple[float, float, float, float]
) -> dict:
    """For ~500 m cells where both saw fire: does VIIRS's first detection fall between NISAR's
    last pass before detection and the detecting pass? (first: grid of first-burned pass, -1
    none; row 0 north.) Low-confidence detections are left out."""
    w, s, e, n = bbox
    h, wd = first.shape
    keep = det["conf"] >= 8
    if not keep.any() or not (first >= 0).any():
        return {"cells": 0, "within_pct": None, "before_pct": None, "median_lead_days": None}
    rows, cols = np.nonzero(first >= 0)
    lat = n - (rows + 0.5) * (n - s) / h
    lon = w + (cols + 0.5) * (e - w) / wd
    # NISAR's verdict per coarse cell: the earliest pass that saw it burned.
    cb, kb = _cell(lat, lon), first[rows, cols].astype(np.int64)
    order = np.lexsort((kb, cb))
    nis_cell, i0 = np.unique(cb[order], return_index=True)
    nis_pass = kb[order][i0]
    # VIIRS's verdict per coarse cell: the day of its first confident detection.
    vday = np.array([t.date().toordinal() for t in det["time"]])[keep]
    cv = _cell(det["lat"][keep], det["lon"][keep])
    order = np.lexsort((vday, cv))
    vi_cell, i1 = np.unique(cv[order], return_index=True)
    vi_day = vday[order][i1]
    _, ib, iv = np.intersect1d(nis_cell, vi_cell, return_indices=True)
    if ib.size == 0:
        return {"cells": 0, "within_pct": None, "before_pct": None, "median_lead_days": None}
    ords = np.array([d.toordinal() for d in dates])
    k = nis_pass[ib]
    hi = ords[k]
    lo = np.where(k > 0, ords[np.maximum(k - 1, 0)], ords[0] - 12)
    v = vi_day[iv]
    return {
        "cells": int(ib.size),
        "cell_deg": CELL_DEG,
        "within_pct": round(100 * float(((v > lo) & (v <= hi)).mean()), 1),
        "before_pct": round(100 * float((v <= hi).mean()), 1),
        "median_lead_days": float(np.median(hi - v)),
    }


def summarise(det: dict | None, dates: list[date], first: np.ndarray | None, bbox, out: Path):
    """products.burn.active_fire and active_fire.json (every fire pixel, in columns)."""
    if det is None:
        return None
    n = len(det["time"])
    day = np.array([t.date().toordinal() for t in det["time"]], dtype=np.int64)
    uniq, inv = np.unique(day, return_inverse=True)
    by_day = [
        {
            "date": date.fromordinal(int(d)).isoformat(),
            "n": int((inv == i).sum()),
            "frp_mw": round(float(det["frp"][inv == i].sum()), 1),
        }
        for i, d in enumerate(uniq)
    ]
    # Between radar passes: what the fire did while NISAR was away.
    ords = np.array([d.toordinal() for d in dates])
    lows = np.concatenate([[ords[0] - 12], ords[:-1]])
    by_pass = []
    for d, lo, hi in zip(dates, lows, ords, strict=True):
        sel = (day > lo) & (day <= hi)
        by_pass.append(
            {
                "date": d.isoformat(),
                "n_since_last": int(sel.sum()),
                "frp_mw": round(float(det["frp"][sel].sum()), 1),
            }
        )
    # One entry per fire pixel, in columns of small integers: day since `day0`, and position in
    # STEP_DEG steps from the box's south-west corner (~10 m). Thousands of points stay ~20 bytes
    # each; the map needs the day, not the minute (the raw CSV keeps the time).
    w, s_, *_ = bbox
    d0 = int(day.min()) if n else 0
    pts = {
        "day0": date.fromordinal(d0).isoformat() if n else None,
        "origin": [w, s_],
        "step_deg": STEP_DEG,
        "d": (day - d0).tolist(),
        "x": np.round((det["lon"] - w) / STEP_DEG).astype(int).tolist(),
        "y": np.round((det["lat"] - s_) / STEP_DEG).astype(int).tolist(),
        "frp": np.round(det["frp"]).astype(int).tolist(),
        "c": det["conf"].astype(int).tolist(),
    }
    import json

    (out / "active_fire.json").write_text(json.dumps(pts, separators=(",", ":")), encoding="utf-8")
    sensors = sorted({SENSORS.get(p, p) for p in det["product"]})
    doc = {
        "source": SOURCE,
        "sensors": sensors,
        "n": n,
        "first": by_day[0]["date"] if by_day else None,
        "last": by_day[-1]["date"] if by_day else None,
        "frp_max_mw": round(float(det["frp"].max()), 1) if n else None,
        "by_day": by_day,
        "by_pass": by_pass,
        "points": "active_fire.json",
        "dates": date_check(det, first, dates, bbox) if first is not None and n else None,
    }
    return doc
