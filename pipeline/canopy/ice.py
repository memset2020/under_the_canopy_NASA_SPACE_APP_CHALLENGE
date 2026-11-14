"""Downwind ice (docs/15): wildfire smoke and glacier ice, with NASA data, for one icefield.

Fire soot darkens glaciers and makes them melt faster; on the Columbia Icefield it has been
measured (Athabasca Glacier summer albedo 0.29 in 2015, 0.16 in 2018 after the British Columbia
fires; Aubry-Wake et al. 2022). This module puts side by side, for one melt season against the
years before it, what NASA satellites recorded over the ice:

- fire upwind: VIIRS 375 m fire pixels per day in a box upwind (active_fire.py);
- smoke over the ice: VIIRS Deep Blue aerosol optical depth (AERDB_D3, 1 degree, daily);
- how dark the ice is: VIIRS VNP43MA3 shortwave albedo (1 km, daily retrieval from a 16-day
  window) over 1 km cells that RGI 7.0 says are almost entirely glacier;
- how fast the ice moves: NISAR GOFF pixel offsets, tested against stable rock and against
  ITS_LIVE (NASA MEaSUREs) velocities of the same glaciers.

It shows co-occurrence, not cause: a darker summer can also come from an early snowline (bare ice
is darker than snow), and thick smoke also cuts the sunlight that melts the ice.
"""

from __future__ import annotations

import csv
import io
import json
import re
import struct
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np

from . import config

ICE_SCHEMA = 1
# Longest wait for one remote granule read before it counts as missed.
READ_TIMEOUT_S = 120
# A year with more of its days unread than this is fetched again on the next run.
MAX_MISSED_SHARE = 0.05
EVENTS_FILE = config.PIPELINE_DIR / "config" / "ice.json"

RGI_URL = (
    "https://daacdata.apps.nsidc.org/pub/DATASETS/nsidc0770_rgi_v7/regional_files/"
    "RGI2000-v7.0-G/RGI2000-v7.0-G-02_western_canada_usa.zip"
)
RGI_STEM = "RGI2000-v7.0-G-02_western_canada_usa"
RGI_SOURCE = "Randolph Glacier Inventory 7.0 (NSIDC-0770 v7, GLIMS), region 02"

ALBEDO_SHORT, ALBEDO_VERSION = "VNP43MA3", "002"
ALBEDO_SOURCE = "NASA VIIRS VNP43MA3 v002 BRDF/albedo, white-sky shortwave (1 km, daily)"
ALBEDO_DS = "HDFEOS/GRIDS/VIIRS_Grid_BRDF/Data Fields/Albedo_WSA_shortwave"
ALBEDO_QA = "HDFEOS/GRIDS/VIIRS_Grid_BRDF/Data Fields/BRDF_Albedo_Band_Mandatory_Quality_shortwave"
# A 1 km cell counts as ice when RGI covers at least this share of it, so rock and moraine at the
# glacier edges do not darken the mean.
ICE_CELL_MIN = 0.9
# Share of the ice cells a day's retrieval must cover to count.
ALBEDO_MIN_COVER = 0.5
# MODIS/VIIRS sinusoidal grid: 10-degree tiles, 1200 cells of 926.6 m for the 1 km products.
SIN_R = 6371007.181
SIN_TILE_M = 1111950.5197665
SIN_X0, SIN_Y0 = -20015109.354, 10007554.677
SIN_CRS = "+proj=sinu +lon_0=0 +x_0=0 +y_0=0 +R=6371007.181 +units=m +no_defs"

SMOKE_SHORT, SMOKE_VERSION = "AERDB_D3_VIIRS_SNPP", "2"
SMOKE_SOURCE = "NASA VIIRS Deep Blue aerosol optical depth at 550 nm, Suomi NPP (1 degree, daily)"
SMOKE_DS = "Aerosol_Optical_Thickness_550_Land_Mean"
# Optical depth above which a day is called smoky over the ice: about three times a clear summer
# day in the Rockies (0.05-0.15) and the level where smoke plumes are plainly visible.
SMOKY_AOD = 0.4
# Days either side pooled from the other years for the smoke band.
SMOKE_POOL_DAYS = 7

GOFF_SHORT = "NISAR_L2_GOFF_PROVISIONAL_V1"
GOFF_SOURCE = "NISAR L2 GOFF pixel offsets (provisional), HH, three correlation windows"
GOFF_BASE = "science/LSAR/GOFF/grids/frequencyA/pixelOffsets"
# The three correlation windows must agree to this (m) for an offset to be kept: about twice the
# robust spread on stable rock of the noisiest window (0.5 m along track, 0.1 m in slant range).
AGREE_ALONG_M = 1.0
AGREE_RANGE_M = 0.3

ITSLIVE_STAC = "https://stac.itslive.cloud/search"
ITSLIVE_SOURCE = "ITS_LIVE image-pair velocities (NASA MEaSUREs; Landsat, Sentinel-1, Sentinel-2)"
ITSLIVE_MAX_DT_DAYS = 48
ITSLIVE_MAX_PAIRS = 60


# ---------------------------------------------------------------- events


def load_events() -> list[dict]:
    return json.loads(EVENTS_FILE.read_text(encoding="utf-8"))["events"]


def get_event(event_id: str) -> dict:
    for ev in load_events():
        if ev["id"] == event_id:
            return ev
    raise SystemExit(f"unknown ice event {event_id!r}; see {EVENTS_FILE}")


def season_days(ev: dict, year: int) -> tuple[date, date]:
    a, b = ev["season"]
    return date.fromisoformat(f"{year}-{a}"), date.fromisoformat(f"{year}-{b}")


# ---------------------------------------------------------------- glacier outlines (RGI 7.0)


def rgi_zip(raw_global: Path, log=print) -> Path:
    """RGI 7.0 region 02 from NSIDC (Earthdata Login), downloaded once."""
    out = raw_global / "rgi7" / f"{RGI_STEM}.zip"
    if out.is_file():
        return out
    from . import nasa_access as na

    ea = na._earthaccess()
    na.login()
    out.parent.mkdir(parents=True, exist_ok=True)
    sess = ea.get_requests_https_session()
    with sess.get(RGI_URL, stream=True, timeout=600) as r:
        r.raise_for_status()
        with out.open("wb") as f:
            for chunk in r.iter_content(1 << 20):
                f.write(chunk)
    log(f"  glaciers: RGI 7.0 region 02 → {out}")
    return out


def shp_polygons(data: bytes, bbox) -> list[tuple[int, list[np.ndarray]]]:
    """(record index, rings as (n, 2) lon/lat arrays) of every polygon (shape type 5 or 15)
    whose bounding box meets bbox. A minimal reader of the ESRI shapefile layout."""
    w, s, e, n = bbox
    out = []
    pos, idx = 100, 0
    while pos + 8 <= len(data):
        length = struct.unpack(">i", data[pos + 4 : pos + 8])[0] * 2
        rec = data[pos + 8 : pos + 8 + length]
        pos += 8 + length
        st = struct.unpack("<i", rec[:4])[0]
        if st in (5, 15):
            xmin, ymin, xmax, ymax = struct.unpack("<4d", rec[4:36])
            if xmax >= w and xmin <= e and ymax >= s and ymin <= n:
                nparts, npts = struct.unpack("<ii", rec[36:44])
                parts = np.frombuffer(rec[44 : 44 + 4 * nparts], "<i4").tolist() + [npts]
                o = 44 + 4 * nparts
                pts = np.frombuffer(rec[o : o + 16 * npts], "<f8").reshape(-1, 2)
                out.append((idx, [pts[a:b] for a, b in zip(parts[:-1], parts[1:], strict=True)]))
        idx += 1
    return out


def load_glaciers(zip_path: Path, bbox) -> list[dict]:
    """Glaciers whose outline meets bbox: rgi_id, name, area_km2, src_date, rings."""
    with zipfile.ZipFile(zip_path) as z:
        shp = z.read(f"{RGI_STEM}.shp")
        attrs = list(
            csv.DictReader(io.TextIOWrapper(z.open(f"{RGI_STEM}-attributes.csv"), "utf-8"))
        )
    return [
        {
            "rgi_id": attrs[i]["rgi_id"],
            "name": attrs[i]["glac_name"] or None,
            "area_km2": round(float(attrs[i]["area_km2"]), 2),
            "src_date": attrs[i]["src_date"][:10],
            "rings": rings,
        }
        for i, rings in shp_polygons(shp, bbox)
    ]


def rasterize_glaciers(glaciers: list[dict], crs: str, transform, shape) -> np.ndarray:
    """Glacier index + 1 per cell of a grid in any CRS (0 = not glacier)."""
    from rasterio.features import rasterize
    from rasterio.warp import transform as warp

    geoms = []
    for k, g in enumerate(glaciers):
        rings = []
        for r in g["rings"]:
            xs, ys = warp("EPSG:4326", crs, r[:, 0].tolist(), r[:, 1].tolist())
            rings.append(list(zip(xs, ys, strict=True)))
        geoms.append(({"type": "Polygon", "coordinates": rings}, k + 1))
    if not geoms:
        return np.zeros(shape, dtype=np.int32)
    return rasterize(geoms, out_shape=shape, transform=transform, fill=0, dtype="int32")


def glaciers_geojson(glaciers: list[dict], out: Path) -> None:
    """Outlines for the map, coordinates rounded to ~10 m."""
    feats = [
        {
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": [np.round(r, 4).tolist() for r in g["rings"]],
            },
            "properties": {"name": g["name"], "area_km2": g["area_km2"]},
        }
        for g in glaciers
    ]
    (out / "glaciers.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")),
        encoding="utf-8",
    )


# ---------------------------------------------------------------- sinusoidal 1 km grid


def sin_window(bbox, cells: int = 1200) -> tuple[int, int, int, int, int, int]:
    """Tile (h, v) and the row/col window [r0, r1) x [c0, c1) of the sinusoidal grid covering
    bbox; the box must lie in one tile (true for an icefield)."""
    w, s, e, n = bbox
    lats = np.array([s, n, s, n])
    lons = np.array([w, w, e, e])
    x = SIN_R * np.deg2rad(lons) * np.cos(np.deg2rad(lats))
    y = SIN_R * np.deg2rad(lats)
    fx = (x - SIN_X0) / SIN_TILE_M
    fy = (SIN_Y0 - y) / SIN_TILE_M
    h, v = int(np.floor(fx.min())), int(np.floor(fy.min()))
    if int(np.floor(fx.max())) != h or int(np.floor(fy.max())) != v:
        raise ValueError("box spans two sinusoidal tiles")
    c0, c1 = int((fx.min() - h) * cells), int(np.ceil((fx.max() - h) * cells))
    r0, r1 = int((fy.min() - v) * cells), int(np.ceil((fy.max() - v) * cells))
    return h, v, r0, r1, c0, c1


def ice_fraction(glaciers: list[dict], bbox, cells: int = 1200, sub: int = 10) -> np.ndarray:
    """Share of each sinusoidal cell of the window that RGI maps as glacier (sub x sub samples)."""
    from rasterio.transform import from_origin

    h, v, r0, r1, c0, c1 = sin_window(bbox, cells)
    size = SIN_TILE_M / cells
    x0 = SIN_X0 + h * SIN_TILE_M + c0 * size
    y0 = SIN_Y0 - v * SIN_TILE_M - r0 * size
    shape = ((r1 - r0) * sub, (c1 - c0) * sub)
    fine = rasterize_glaciers(glaciers, SIN_CRS, from_origin(x0, y0, size / sub, size / sub), shape)
    return (fine > 0).reshape(r1 - r0, sub, c1 - c0, sub).mean(axis=(1, 3))


# ---------------------------------------------------------------- remote reads


def _granule_day(g) -> str:
    """The granule's nominal day: its AYYYYDDD name tag where it has one (VNP43MA3's time range is
    the 16-day window it is retrieved from, which starts about 8 days before the day it is for),
    else the start of its time range."""
    m = re.search(r"\.A(\d{4})(\d{3})\.", g["umm"]["GranuleUR"])
    if m:
        return (date(int(m[1]), 1, 1) + timedelta(days=int(m[2]) - 1)).isoformat()
    return g["umm"]["TemporalExtent"]["RangeDateTime"]["BeginningDateTime"][:10]


def _latest_per_day(grans: list) -> list:
    """One granule per day: the most recently produced (reprocessed copies share a day)."""
    best: dict[str, Any] = {}
    for g in grans:
        d = _granule_day(g)
        if d not in best or g["umm"]["GranuleUR"] > best[d]["umm"]["GranuleUR"]:
            best[d] = g
    return [best[d] for d in sorted(best)]


def _remote_rows(ea, grans: list, read, workers: int = 8, log=print) -> tuple[list, int]:
    """read(h5py.File) for each granule, in parallel; (rows, granules that could not be read)."""
    import h5py

    # Small blocks: each granule gives a window of a few kB, and the default multi-MB blocks
    # turned that into megabytes per file over a slow link.
    files = (
        ea.open(grans, open_kwargs={"block_size": 262144, "cache_type": "blockcache"})
        if grans
        else []
    )

    def one(gf):
        g, f = gf
        for attempt in range(2):
            try:
                return _granule_day(g), read(h5py.File(f, "r"))
            except Exception:  # noqa: BLE001 - network or file errors from the remote read
                if attempt:
                    return _granule_day(g), None
                time.sleep(5)
        return _granule_day(g), None

    # A remote read can stall with no error; each granule gets READ_TIMEOUT_S and is then counted
    # as missed. The pool is not joined, so a stalled thread cannot hold the fetch.
    rows, missed = [], 0
    pool = ThreadPoolExecutor(workers)
    futures = [pool.submit(one, gf) for gf in zip(grans, files, strict=True)]
    deadline = time.monotonic() + READ_TIMEOUT_S * (len(futures) / workers + 1)
    for fut in futures:
        try:
            d, got = fut.result(timeout=max(READ_TIMEOUT_S, deadline - time.monotonic()))
        except TimeoutError:
            missed += 1
            continue
        if got is None:
            missed += 1
        else:
            rows.append((d, *got))
    pool.shutdown(wait=False, cancel_futures=True)
    return sorted(rows), missed


# ---------------------------------------------------------------- albedo


def fetch_albedo(ev: dict, glaciers: list[dict], out_csv: Path, log=print) -> Path:
    """Daily mean shortwave albedo of the ice cells, every season year: date, albedo, cells,
    full_inversion_cells (cells with a full BRDF inversion, QA 0)."""
    from . import nasa_access as na

    ea = na._earthaccess()
    na.login()
    frac = ice_fraction(glaciers, ev["bbox"])
    ice = frac >= ICE_CELL_MIN
    th, tv, r0, r1, c0, c1 = sin_window(ev["bbox"])
    tile = (th, tv)
    w, s, e, n = ev["bbox"]
    centre = ((w + e) / 2, (s + n) / 2)

    def read(h):
        a = np.asarray(h[ALBEDO_DS][r0:r1, c0:c1]).astype(float)
        q = np.asarray(h[ALBEDO_QA][r0:r1, c0:c1])
        ok = ice & (a >= 0) & (a <= 1000)
        if not ok.any():
            return (None, 0, 0)
        return (round(float(a[ok].mean()) / 1000, 4), int(ok.sum()), int((ok & (q == 0)).sum()))

    rows = []
    for year in [*ev["baseline_years"], ev["year"]]:
        # Each year is saved as it is read, so a long fetch resumes where it stopped.
        cache = out_csv.parent / f"{out_csv.stem}_years" / f"{year}.json"
        a, b = season_days(ev, year)
        if cache.is_file():
            kept = json.loads(cache.read_text())
            # A year saved before this rule with many days missing is fetched again.
            if len(kept) >= (1 - MAX_MISSED_SHARE) * ((b - a).days + 1):
                rows += [tuple(r) for r in kept]
                continue
        grans = ea.search_data(
            short_name=ALBEDO_SHORT,
            version=ALBEDO_VERSION,
            point=centre,
            temporal=(a.isoformat(), b.isoformat()),
            count=400,
        )
        # The 1 km window is for tile (h, v) and the season's own days.
        tag = f".h{tile[0]:02d}v{tile[1]:02d}."
        grans = [
            g
            for g in grans
            if tag in g["umm"]["GranuleUR"] and a.isoformat() <= _granule_day(g) <= b.isoformat()
        ]
        got, missed = _remote_rows(ea, _latest_per_day(grans), read)
        rows += got
        # A year with many unread days is not saved, so the next run tries it again.
        if missed <= MAX_MISSED_SHARE * (len(got) + missed):
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(got), encoding="utf-8")
        log(f"  albedo {year}: {len(got)} days, {missed} not read")
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(["date", "albedo", "cells", "full_inversion_cells"])
        wr.writerows(r for r in rows if r[1] is not None)
    log(f"  albedo: {int(ice.sum())} ice cells of 1 km → {out_csv}")
    return out_csv


def _read_csv(path: Path) -> list[dict]:
    if not path.is_file():
        return []
    with path.open(encoding="utf-8") as f:
        return list(csv.DictReader(f))


def by_day_of_season(rows: list[dict], key: str, years: list[int], ev: dict) -> np.ndarray:
    """(years, days of season) array of a daily value, NaN where missing."""
    a, b = season_days(ev, 2001)  # a non-leap year: days of season by month-day
    n = (b - a).days + 1
    out = np.full((len(years), n), np.nan)
    yi = {y: i for i, y in enumerate(years)}
    for r in rows:
        d = date.fromisoformat(r["date"])
        if d.year not in yi or r[key] in ("", None):
            continue
        k = (date(2001, d.month, d.day) - a).days if not (d.month == 2 and d.day == 29) else -1
        if 0 <= k < n:
            out[yi[d.year], k] = float(r[key])
    return out


def season_summary(
    grid: np.ndarray, years: list[int], year: int, ev: dict, digits: int, window: list[str]
) -> dict:
    """Daily value of `year` with the median and range of the other years, the window mean of
    every year and the rank of `year` (1 = lowest)."""
    a, _ = season_days(ev, 2001)
    i = years.index(year)
    base = np.delete(grid, i, axis=0)
    with np.errstate(all="ignore"):
        med = np.nanmedian(base, axis=0)
        lo, hi = np.nanmin(base, axis=0), np.nanmax(base, axis=0)
    nb = np.isfinite(base).sum(axis=0)
    rnd = lambda v: None if not np.isfinite(v) else round(float(v), digits)  # noqa: E731
    days = [
        {
            "date": (date(year, a.month, a.day) + timedelta(days=k)).isoformat(),
            "value": rnd(grid[i, k]),
            "base_median": rnd(med[k]) if nb[k] >= 3 else None,
            "base_lo": rnd(lo[k]) if nb[k] >= 3 else None,
            "base_hi": rnd(hi[k]) if nb[k] >= 3 else None,
        }
        for k in range(grid.shape[1])
    ]
    w0 = (date.fromisoformat(f"2001-{window[0]}") - a).days
    w1 = (date.fromisoformat(f"2001-{window[1]}") - a).days + 1
    with np.errstate(all="ignore"):
        means = np.nanmean(grid[:, w0:w1], axis=1)
        counts = np.isfinite(grid[:, w0:w1]).sum(axis=1)
    # A year needs half the window measured to be compared.
    full = counts >= (w1 - w0) / 2
    per_year = [
        {"year": y, "value": rnd(m), "days": int(c)}
        for y, m, c, f in zip(years, means, counts, full, strict=True)
        if f
    ]
    valid = [p for p in per_year if p["value"] is not None]
    this = next((p for p in valid if p["year"] == year), None)
    rank = None
    if this:
        rank = 1 + sum(p["value"] < this["value"] for p in valid if p["year"] != year)
    others = [p["value"] for p in valid if p["year"] != year]
    return {
        "days": days,
        "window": window,
        "years": per_year,
        "value": this["value"] if this else None,
        "base_median": round(float(np.median(others)), digits) if others else None,
        "rank_low": rank,
        "n_years": len(valid),
    }


# ---------------------------------------------------------------- smoke


def fetch_smoke(ev: dict, out_csv: Path, log=print) -> Path:
    """Daily Deep Blue AOD (550 nm) of the 1 degree cell over the icefield's centre."""
    from . import nasa_access as na

    ea = na._earthaccess()
    na.login()
    w, s, e, n = ev["bbox"]
    lat0, lon0 = (s + n) / 2, (w + e) / 2

    def read(h):
        lat = np.asarray(h["Latitude_1D"])
        lon = np.asarray(h["Longitude_1D"])
        i, j = int(np.abs(lat - lat0).argmin()), int(np.abs(lon - lon0).argmin())
        v = float(h[SMOKE_DS][i, j])
        cnt = float(h["Aerosol_Optical_Thickness_550_Land_Count"][i, j])
        return (None if v < 0 else round(v, 3), int(max(cnt, 0)))

    rows = []
    for year in [*ev["baseline_years"], ev["year"]]:
        # Each year is saved as it is read, so a long fetch resumes where it stopped.
        cache = out_csv.parent / f"{out_csv.stem}_years" / f"{year}.json"
        a, b = season_days(ev, year)
        if cache.is_file():
            kept = json.loads(cache.read_text())
            # A year saved before this rule with many days missing is fetched again.
            if len(kept) >= (1 - MAX_MISSED_SHARE) * ((b - a).days + 1):
                rows += [tuple(r) for r in kept]
                continue
        grans = ea.search_data(
            short_name=SMOKE_SHORT,
            version=SMOKE_VERSION,
            temporal=(a.isoformat(), b.isoformat()),
            count=400,
        )
        got, missed = _remote_rows(ea, _latest_per_day(grans), read)
        rows += got
        # A year with many unread days is not saved, so the next run tries it again.
        if missed <= MAX_MISSED_SHARE * (len(got) + missed):
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(got), encoding="utf-8")
        log(f"  smoke {year}: {len(got)} days, {missed} not read")
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    with out_csv.open("w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(["date", "aod", "retrievals"])
        wr.writerows((d, "" if v is None else v, c) for d, v, c in rows)
    return out_csv


def smoke_summary(grid: np.ndarray, years: list[int], year: int, ev: dict) -> dict:
    """Smoke is retrieved on about one day in four over the ice (snow and cloud stop it), so the
    other years are pooled within SMOKE_POOL_DAYS of each day (median and 10th-90th percentile,
    from at least 10 values), and summers are compared by the share of measured days that were
    smoky, which does not depend on how many days were measured."""
    a, _ = season_days(ev, 2001)
    i = years.index(year)
    base = np.delete(grid, i, axis=0)
    n = grid.shape[1]
    rnd = lambda v: None if v is None or not np.isfinite(v) else round(float(v), 3)  # noqa: E731
    days = []
    for k in range(n):
        win = base[:, max(0, k - SMOKE_POOL_DAYS) : k + SMOKE_POOL_DAYS + 1]
        vals = win[np.isfinite(win)]
        ok = vals.size >= 10
        days.append(
            {
                "date": (date(year, a.month, a.day) + timedelta(days=k)).isoformat(),
                "value": rnd(grid[i, k]),
                "base_median": rnd(np.median(vals)) if ok else None,
                "base_lo": rnd(np.percentile(vals, 10)) if ok else None,
                "base_hi": rnd(np.percentile(vals, 90)) if ok else None,
            }
        )
    per_year = []
    for y, row in zip(years, grid, strict=True):
        m = row[np.isfinite(row)]
        if m.size >= 10:
            per_year.append(
                {
                    "year": y,
                    "value": round(100 * float((m >= SMOKY_AOD).mean()), 1),
                    "days": int(m.size),
                }
            )
    this = next((p for p in per_year if p["year"] == year), None)
    others = [p["value"] for p in per_year if p["year"] != year]
    rank = 1 + sum(v < this["value"] for v in others) if this else None
    return {
        "days": days,
        "window": list(ev["season"]),
        "years": per_year,
        "value": this["value"] if this else None,
        "base_median": round(float(np.median(others)), 1) if others else None,
        "rank_low": rank,
        "n_years": len(per_year),
    }


# ---------------------------------------------------------------- fire upwind


def fetch_upwind_fire(ev: dict, out_csv: Path, log=print) -> Path:
    """VIIRS (Suomi NPP) fire pixels in the upwind box over the season; one sensor keeps the
    count comparable from day to day."""
    from . import active_fire

    a, b = season_days(ev, ev["year"])
    site = {"bbox": ev["upwind"]["bbox"]}
    return active_fire.fetch(site, a, b, out_csv, log, sensors=("VNP14IMG",))


def fire_days(rows: list[dict]) -> list[dict]:
    """Fire pixels and summed fire radiative power per day (confidence nominal or high)."""
    count: dict[str, list[float]] = {}
    for r in rows:
        if int(r["confidence"]) < 8:
            continue
        c = count.setdefault(r["time_utc"][:10], [0, 0.0])
        c[0] += 1
        c[1] += float(r["frp_mw"])
    return [{"date": d, "n": int(v[0]), "frp_mw": round(v[1], 1)} for d, v in sorted(count.items())]


# ---------------------------------------------------------------- ice speed: NISAR GOFF


def goff_pair(h, glaciers: list[dict], bbox) -> dict:
    """One GOFF pair over the box: noise on stable rock, and on each named glacier the share of
    cells where the three correlation windows agree and their speed (m/yr).

    Offsets are referenced to the median over rock (the product's raw offsets carry a few metres
    of misregistration), slant range is projected to the ground with the median incidence angle,
    and vertical motion is ignored."""
    from rasterio.transform import from_origin
    from rasterio.warp import transform as warp

    grp = h[GOFF_BASE]
    x = np.asarray(grp["xCoordinates"])
    y = np.asarray(grp["yCoordinates"])
    crs = f"EPSG:{int(grp['projection'][()])}"
    w, s, e, n = bbox
    xs, ys = warp("EPSG:4326", crs, [w, e, w, e], [s, s, n, n])
    c0, c1 = int(np.searchsorted(x, min(xs))), int(np.searchsorted(x, max(xs)))
    r0, r1 = int(np.abs(y - max(ys)).argmin()), int(np.abs(y - min(ys)).argmin())
    dx, dy = float(x[1] - x[0]), float(y[0] - y[1])
    gl = rasterize_glaciers(
        glaciers, crs, from_origin(x[c0] - dx / 2, y[r0] + dy / 2, dx, dy), (r1 - r0, c1 - c0)
    )
    ice = gl > 0
    days = float(h["science/LSAR/GOFF/metadata/orbit/temporalBaseline"][()])
    inc = float(np.nanmedian(np.asarray(h["science/LSAR/GOFF/metadata/radarGrid/incidenceAngle"])))
    along, rng = [], []
    for lay in ("layer1", "layer2", "layer3"):
        L = grp["HH"][lay]
        a = np.asarray(L["alongTrackOffset"][r0:r1, c0:c1]).astype(float)
        r = np.asarray(L["slantRangeOffset"][r0:r1, c0:c1]).astype(float)
        along.append(a - np.nanmedian(a[~ice]))
        rng.append(r - np.nanmedian(r[~ice]))
    A, R = np.stack(along), np.stack(rng)
    with np.errstate(invalid="ignore"):
        agree = (np.abs(A - A[2]).max(axis=0) < AGREE_ALONG_M) & (
            np.abs(R - R[2]).max(axis=0) < AGREE_RANGE_M
        )
        speed = np.hypot(A.mean(axis=0), R.mean(axis=0) / np.sin(np.deg2rad(inc))) / days * 365.25
    rock = ~ice & agree & np.isfinite(speed)
    per = []
    for k, g in enumerate(glaciers):
        if not g["name"]:
            continue
        sel = gl == k + 1
        ok = sel & agree & np.isfinite(speed)
        per.append(
            {
                "name": g["name"],
                "cells": int(sel.sum()),
                "agree_pct": round(100 * float(ok.sum()) / max(int(sel.sum()), 1), 1),
                "speed_m_yr": round(float(np.median(speed[ok])), 1) if ok.sum() >= 10 else None,
            }
        )
    return {
        "days": days,
        "incidence_deg": round(inc, 1),
        "res_m": dx,
        "rock_agree_pct": round(100 * float((~ice & agree).sum()) / max(int((~ice).sum()), 1), 1),
        "rock_noise_m_yr": round(float(np.median(speed[rock])), 1) if rock.any() else None,
        "rock_noise_p90_m_yr": round(float(np.percentile(speed[rock], 90)), 1)
        if rock.any()
        else None,
        "ice_agree_pct": round(100 * float((ice & agree).sum()) / max(int(ice.sum()), 1), 1),
        "glaciers": per,
    }


def fetch_goff(ev: dict, glaciers: list[dict], out_json: Path, log=print) -> Path:
    """The ice-speed test on every GOFF pair over the box in the season (12 to 24-day pairs)."""
    import h5py

    from . import nasa_access as na

    ea = na._earthaccess()
    na.login()
    a, b = season_days(ev, ev["year"])
    grans = ea.search_data(
        short_name=GOFF_SHORT,
        bounding_box=tuple(ev["bbox"]),
        temporal=(a.isoformat(), b.isoformat()),
        count=200,
    )
    # One copy per pair: reprocessed files share the name up to the product version.
    seen: dict[str, Any] = {}
    for g in grans:
        key = g["umm"]["GranuleUR"].rsplit("_", 1)[0]
        if key not in seen or g["umm"]["GranuleUR"] > seen[key]["umm"]["GranuleUR"]:
            seen[key] = g
    # Each pair takes minutes to read; results are saved after every pair and kept on a rerun.
    pairs = json.loads(out_json.read_text()) if out_json.is_file() else []
    done = {p["granule"] for p in pairs}
    out_json.parent.mkdir(parents=True, exist_ok=True)
    for _, g in sorted(seen.items()):
        name = g["umm"]["GranuleUR"]
        if name in done:
            continue
        parts = name.split("_")
        try:
            h = h5py.File(ea.open([g])[0], "r")
            got = goff_pair(h, glaciers, ev["bbox"])
        except Exception as exc:  # noqa: BLE001 - one bad pair must not stop the test
            log(f"  goff: {name} not read ({type(exc).__name__})")
            continue
        pairs.append(
            {
                "granule": name,
                "track": f"{int(parts[5])}{parts[6]}",
                "start": f"{parts[11][:4]}-{parts[11][4:6]}-{parts[11][6:8]}",
                "end": f"{parts[13][:4]}-{parts[13][4:6]}-{parts[13][6:8]}",
                **got,
            }
        )
        out_json.write_text(json.dumps(pairs, indent=1), encoding="utf-8")
        log(f"  goff: {pairs[-1]['track']} {pairs[-1]['start']}→{pairs[-1]['end']}")
    return out_json


# ---------------------------------------------------------------- ice speed: ITS_LIVE


def fetch_itslive(ev: dict, glaciers: list[dict], out_json: Path, log=print) -> Path:
    """Per named glacier, the median ITS_LIVE speed of each image pair of the season."""
    import urllib.request

    import fsspec
    import h5py
    from rasterio.transform import from_origin
    from rasterio.warp import transform as warp

    a, b = season_days(ev, ev["year"])
    w, s, e, n = ev["bbox"]
    q = {
        "collections": ["itslive-granules"],
        "bbox": [w, s, e, n],
        "datetime": f"{a.isoformat()}T00:00:00Z/{b.isoformat()}T23:59:59Z",
        "limit": 500,
    }
    req = urllib.request.Request(
        ITSLIVE_STAC, data=json.dumps(q).encode(), headers={"Content-Type": "application/json"}
    )
    feats = []
    for _ in range(20):  # pages of 500; the season over one icefield is a few thousand pairs
        with urllib.request.urlopen(req, timeout=120) as r:
            page = json.load(r)
        feats += page["features"]
        nxt = next((ln for ln in page.get("links", []) if ln.get("rel") == "next"), None)
        if not nxt or not page["features"]:
            break
        body = nxt.get("body")
        req = urllib.request.Request(
            nxt["href"],
            data=json.dumps(body).encode() if body else None,
            headers={"Content-Type": "application/json"},
            method=nxt.get("method", "GET"),
        )
    feats = [f for f in feats if f["properties"].get("date_dt", 999) <= ITSLIVE_MAX_DT_DAYS]
    # Each pair costs ~10 s to read remotely: keep at most ITSLIVE_MAX_PAIRS, spread evenly
    # through the season by middle date, one per scene pair.
    uniq = {}
    for f in feats:
        p_ = f["properties"]
        uniq.setdefault((p_.get("platform"), p_["start_datetime"][:10], p_["end_datetime"][:10]), f)
    feats = sorted(uniq.values(), key=lambda f: f["properties"]["datetime"])
    if len(feats) > ITSLIVE_MAX_PAIRS:
        idx = np.linspace(0, len(feats) - 1, ITSLIVE_MAX_PAIRS).round().astype(int)
        feats = [feats[i] for i in sorted(set(idx.tolist()))]
    # A stalled read must fail, not hang the fetch (S3 sometimes stops answering mid-file).
    import aiohttp

    http = fsspec.filesystem("http", client_kwargs={"timeout": aiohttp.ClientTimeout(total=120)})

    def one(f):
        p = f["properties"]
        try:
            h = h5py.File(http.open(f["assets"]["data"]["href"], block_size=262144), "r")
            x, y = np.asarray(h["x"]), np.asarray(h["y"])
            crs = p["proj:code"]
            xs, ys = warp("EPSG:4326", crs, [w, e, w, e], [s, s, n, n])
            c0, c1 = int(np.searchsorted(x, min(xs))), int(np.searchsorted(x, max(xs)))
            r0 = int(np.abs(y - max(ys)).argmin())
            r1 = int(np.abs(y - min(ys)).argmin())
            if c1 - c0 < 2 or r1 - r0 < 2:
                return None
            vd = h["v"]  # (1, rows, cols) in ITS_LIVE v02 files
            win = vd[0, r0:r1, c0:c1] if vd.ndim == 3 else vd[r0:r1, c0:c1]
            v = np.asarray(win).astype(float)
            ed = h["v_error"]
            ewin = ed[0, r0:r1, c0:c1] if ed.ndim == 3 else ed[r0:r1, c0:c1]
            err = np.asarray(ewin).astype(float)
            err[err < 0] = np.nan
            v[v < 0] = np.nan
            dx, dy = float(x[1] - x[0]), float(y[0] - y[1])
            gl = rasterize_glaciers(
                glaciers, crs, from_origin(x[c0] - dx / 2, y[r0] + dy / 2, dx, dy), v.shape
            )
        except Exception:  # noqa: BLE001 - skip a pair that cannot be read
            return None
        per, per_err = {}, {}
        for k, g in enumerate(glaciers):
            sel = (gl == k + 1) & np.isfinite(v)
            if g["name"] and sel.sum() >= 5:
                per[g["name"]] = round(float(np.median(v[sel])), 1)
                if np.isfinite(err[sel]).any():
                    per_err[g["name"]] = round(float(np.nanmedian(err[sel])), 1)
        return {
            "platform": p.get("platform"),
            "start": p["start_datetime"][:10],
            "end": p["end_datetime"][:10],
            "days": p.get("date_dt"),
            "glaciers": per,
            "errors": per_err,
        }

    with ThreadPoolExecutor(8) as pool:
        pairs = [r for r in pool.map(one, feats) if r and r["glaciers"]]
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(pairs, indent=1), encoding="utf-8")
    log(f"  its_live: {len(pairs)} of {len(feats)} pairs over the glaciers")
    return out_json


def speed_summary(goff: list[dict], itslive: list[dict], names: list[str]) -> dict:
    """Per glacier: ITS_LIVE median over pairs, and NISAR's best pair (most ice agreeing)."""
    best = max(goff, key=lambda p: p["ice_agree_pct"]) if goff else None
    rows = []
    for name in names:
        its = [p["glaciers"][name] for p in itslive if name in p["glaciers"]]
        errs = [p.get("errors", {})[name] for p in itslive if name in p.get("errors", {})]
        nis = next((g for g in best["glaciers"] if g["name"] == name), None) if best else None
        rows.append(
            {
                "name": name,
                "itslive_m_yr": round(float(np.median(its)), 1) if its else None,
                "itslive_iqr_m_yr": [round(float(v), 1) for v in np.percentile(its, [25, 75])]
                if len(its) >= 4
                else None,
                "itslive_pairs": len(its),
                # ITS_LIVE's own error estimate for one pair (median over the glacier and pairs)
                "itslive_error_m_yr": round(float(np.median(errs)), 1) if errs else None,
                "nisar_m_yr": nis["speed_m_yr"] if nis else None,
                "nisar_agree_pct": nis["agree_pct"] if nis else None,
            }
        )
    with np.errstate(all="ignore"):
        noise = [p["rock_noise_m_yr"] for p in goff if p["rock_noise_m_yr"] is not None]
        agree = [p["ice_agree_pct"] for p in goff]
    return {
        "goff_source": GOFF_SOURCE,
        "itslive_source": ITSLIVE_SOURCE,
        "agree_along_m": AGREE_ALONG_M,
        "agree_range_m": AGREE_RANGE_M,
        "pairs": len(goff),
        "rock_noise_median_m_yr": round(float(np.median(noise)), 1) if noise else None,
        "rock_noise_range_m_yr": [round(min(noise), 1), round(max(noise), 1)] if noise else None,
        "ice_agree_median_pct": round(float(np.median(agree)), 1) if agree else None,
        "ice_agree_max_pct": round(max(agree), 1) if agree else None,
        "best_pair": {k: best[k] for k in ("track", "start", "end", "days", "rock_noise_m_yr")}
        if best
        else None,
        "glaciers": rows,
        "by_pair": [
            {k: p[k] for k in ("track", "start", "end", "days", "rock_noise_m_yr", "ice_agree_pct")}
            for p in goff
        ],
    }


# ---------------------------------------------------------------- build


def fetch(ev: dict, raw: Path, log=print, only: list[str] | None = None) -> None:
    glaciers = load_glaciers(rgi_zip(config.RAW_DIR / "_global", log), ev["bbox"])
    log(f"  glaciers: {len(glaciers)} outlines in the box")
    steps = {
        "albedo": lambda: fetch_albedo(ev, glaciers, raw / "albedo.csv", log),
        "smoke": lambda: fetch_smoke(ev, raw / "smoke.csv", log),
        "fire": lambda: fetch_upwind_fire(ev, raw / "upwind_fire.csv", log),
        "goff": lambda: fetch_goff(ev, glaciers, raw / "goff.json", log),
        "itslive": lambda: fetch_itslive(ev, glaciers, raw / "itslive.json", log),
    }
    for name in only or list(steps):
        log(f"== ice {name}")
        try:
            steps[name]()
        except Exception as exc:  # noqa: BLE001 - keep going; report each failure
            log(f"  {name} failed: {type(exc).__name__}: {str(exc)[:200]}")


def build(ev: dict, raw: Path, out_root: Path | None = None, log=print) -> dict:
    """web/data/ice/<id>/ice.json and glaciers.geojson from what fetch() saved."""
    from .export import write_json

    out = (out_root or config.WEB_DATA_DIR / "ice") / ev["id"]
    out.mkdir(parents=True, exist_ok=True)
    glaciers = load_glaciers(rgi_zip(config.RAW_DIR / "_global", log), ev["bbox"])
    glaciers_geojson(glaciers, out)
    named = sorted((g for g in glaciers if g["name"]), key=lambda g: -g["area_km2"])
    years = [*ev["baseline_years"], ev["year"]]

    albedo = None
    rows = _read_csv(raw / "albedo.csv")
    if rows:
        # A day counts only when most of the ice was retrieved: a mean over a few cells (often the
        # low, dark tongue) is not comparable with one over the whole icefield.
        full = max(int(r["cells"]) for r in rows)
        rows = [r for r in rows if int(r["cells"]) >= ALBEDO_MIN_COVER * full]
        grid = by_day_of_season(rows, "albedo", years, ev)
        albedo = {
            "source": ALBEDO_SOURCE,
            "ice_cell_min": ICE_CELL_MIN,
            "min_cover": ALBEDO_MIN_COVER,
            "cells": full,
            **season_summary(grid, years, ev["year"], ev, 3, ev["late_summer"]),
        }
    smoke = None
    rows = _read_csv(raw / "smoke.csv")
    if rows:
        grid = by_day_of_season(rows, "aod", years, ev)
        s = smoke_summary(grid, years, ev["year"], ev)
        vals = [(d["date"], d["value"]) for d in s["days"] if d["value"] is not None]
        top = max(vals, key=lambda dv: dv[1]) if vals else None
        smoke = {
            "source": SMOKE_SOURCE,
            "cell_deg": 1,
            "smoky_aod": SMOKY_AOD,
            "smoky_days": sum(v >= SMOKY_AOD for _, v in vals),
            "smoky_dates": [d for d, v in vals if v >= SMOKY_AOD],
            "measured_days": len(vals),
            "max": {"date": top[0], "aod": top[1]} if top else None,
            **s,
        }
    fire = None
    rows = _read_csv(raw / "upwind_fire.csv")
    if (raw / "upwind_fire.csv").is_file():
        days = fire_days(rows)
        fire = {
            "source": "NASA VIIRS 375 m active fire v002, Suomi NPP (VNP14IMG)",
            "bbox": ev["upwind"]["bbox"],
            "label": ev["upwind"]["label"],
            "n": sum(d["n"] for d in days),
            "days": days,
        }
    speed = None
    goff_f, its_f = raw / "goff.json", raw / "itslive.json"
    if goff_f.is_file() or its_f.is_file():
        goff = json.loads(goff_f.read_text()) if goff_f.is_file() else []
        its = json.loads(its_f.read_text()) if its_f.is_file() else []
        speed = speed_summary(goff, its, [g["name"] for g in named])

    w, s, e, n = ev["bbox"]
    doc = {
        "schema_version": ICE_SCHEMA,
        "id": ev["id"],
        "name": ev["name"],
        "country": ev["country"],
        "bounds": [w, s, e, n],
        "year": ev["year"],
        "baseline_years": ev["baseline_years"],
        "fire_site": ev.get("fire_site"),
        "glaciers": {
            "source": RGI_SOURCE,
            "geojson": "glaciers.geojson",
            "n": len(glaciers),
            "area_km2": round(sum(g["area_km2"] for g in glaciers), 1),
            "outline_dates": sorted({g["src_date"][:4] for g in glaciers}),
            "named": [{"name": g["name"], "area_km2": g["area_km2"]} for g in named],
        },
        "measured": ev.get("measured"),
        "fire": fire,
        "smoke": smoke,
        "albedo": albedo,
        "speed": speed,
    }
    write_json(out / "ice.json", doc)
    log(f"ice: {ev['id']} → {out / 'ice.json'}")
    return doc


def write_index(out_root: Path | None = None) -> dict:
    """web/data/ice/index.json: every built icefield (the manifest points here)."""

    root = out_root or config.WEB_DATA_DIR / "ice"
    events = []
    for f in sorted(root.glob("*/ice.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        events.append(
            {
                "id": d["id"],
                "name": d["name"],
                "bounds": d["bounds"],
                "fire_site": d.get("fire_site"),
                "path": f"{f.parent.name}/ice.json",
            }
        )
    doc = {"events": events}
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.json").write_text(json.dumps(doc, ensure_ascii=False) + "\n", encoding="utf-8")
    return doc
