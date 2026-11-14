"""Glacier atlas (docs/16, D-086): how the world's glaciers flow and how that changed, NASA data.

For each glacier in config/glaciers.json:

- flow now: ITS_LIVE v2.1 (NASA MEaSUREs) 2014-2024 mean speed and direction, the trend of speed
  over those years (dv/dt), and the seasonal swing (amplitude and day of the fastest flow), 120 m;
- flow through time: ITS_LIVE v2.1 annual speed, 1985-2024, sampled along a flowline traced
  upstream from the front through the mean flow (a time-distance diagram, as glaciologists draw
  Jakobshavn's speed-up), and the speed of the fast trunk year by year with ITS_LIVE's error;
- mass: GRACE / GRACE-FO JPL mascons (RL06.3 CRI), the region's ice and water mass since 2002;
- NISAR: how many NISAR products NASA's catalogue (CMR) holds over the glacier.

Speeds measured by others (config `published`) are compared with ITS_LIVE at the same place and
year. Everything is read from public files (ITS_LIVE needs no login; GRACE uses Earthdata Login).

ITS_LIVE files are regional mosaics on AWS S3, read by window with rasterio (no new dependency)
from the Cloud-Optimized GeoTIFF copy of each variable; every read is saved and resumed.
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from . import config

GLACIER_SCHEMA = 1
CONFIG_FILE = config.PIPELINE_DIR / "config" / "glaciers.json"
RAW_ROOT = config.RAW_DIR / "glaciers"
OUT_ROOT = config.WEB_DATA_DIR / "glaciers"
BINARY = "glacier.bin.gz"

S3 = "https://its-live-data.s3.amazonaws.com/velocity_mosaic/v2.1"
ITSLIVE_SOURCE = (
    "NASA MEaSUREs ITS_LIVE v2.1 velocity mosaics (Landsat 4-9, Sentinel-1, Sentinel-2), 120 m"
)
ITSLIVE_URL = "https://its-live.jpl.nasa.gov"
ITSLIVE_CITE = (
    "Gardner et al. 2018, The Cryosphere 12, 521-547; ITS_LIVE v2.1 (doi.org/10.5067/JQ6337239C96)"
)
STATIC_VARS = (
    "v",
    "vx",
    "vy",
    "v_error",
    "dv_dt",
    "v_amp",
    "v_amp_error",
    "v_phase",
    "landice",
    "count",
)
ANNUAL_VARS = ("v", "v_error")
# Classes of the `surface` plane (every cell of a glacier's box; the map paints each).
SURFACE_ICE, SURFACE_ICE_GAP, SURFACE_ROCK, SURFACE_NODATA, SURFACE_FLOAT = 1, 2, 3, 4, 5
# Outside the land-ice mask, a cell moving faster than this and than 3x its own error is
# floating ice, icebergs or melange, not rock (real rock reads ~0.3 m/yr, D-087).
FLOAT_MIN_M_YR = 25.0
WATER_FLAT_M = 0.5  # a DEM this flat over 5 x 5 cells is a hydro-flattened lake or sea (D-087)
YEARS = tuple(range(1985, 2025))

# The web grid: Web Mercator, at most this many cells on the long side (the static maps), and the
# annual maps at half that. Mercator is conformal, so east and north are the grid's own axes.
MAX_PX = 480
ANNUAL_PX = 240
# Flowline: traced upstream one cell at a time while the mean speed stays above this share of the
# fastest speed on the glacier (or 10 m/yr), at most this long; then resampled every STEP_KM.
FLOW_MIN_SHARE = 0.03
FLOW_MIN_M_YR = (
    3.0  # 10x the noise on rock (median 0.3 m/yr): slow debris-covered tongues trace (D-087)
)
FLOW_MAX_KM = 120.0
FLOW_SAMPLES = 120
# The fast trunk: flowline points whose mean speed is at least this share of the flowline's fastest.
TRUNK_SHARE = 0.5
# A year's trunk speed needs this share of the trunk measured.
TRUNK_MIN_COVER = 0.5
# The flowline starts on the fastest ice within this distance of the configured front.
FLOW_SNAP_KM = 2.0
# Front speed (for the published checks): fastest point of the lowest FRONT_KM of the flowline.
FRONT_KM = 5.0

GRACE_SOURCE = "NASA/JPL GRACE and GRACE-FO mascons RL06.3 v04, CRI filtered (monthly)"
CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
NISAR_PRODUCTS = {
    "GOFF": "NISAR_L2_GOFF_PROVISIONAL_V1",
    "GUNW": "NISAR_L2_GUNW_PROVISIONAL_V1",
    "GCOV": "NISAR_L2_GCOV_PROVISIONAL_V1",
}
WORKERS = 12


# ---------------------------------------------------------------- config


def load() -> dict:
    return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))


def sites(ids: list[str] | None = None) -> list[dict]:
    all_ = load()["sites"]
    if not ids:
        return all_
    known = {s["id"]: s for s in all_}
    missing = [i for i in ids if i not in known]
    if missing:
        raise SystemExit(f"unknown glacier {missing}; see {CONFIG_FILE}")
    return [known[i] for i in ids]


# ---------------------------------------------------------------- remote windows (ITS_LIVE)


def cog_url(region: str, year: int | None, var: str) -> str:
    """One variable of one regional mosaic as a Cloud-Optimized GeoTIFF (ITS_LIVE publishes each
    netCDF variable as a COG beside it; a window is then a few range requests, not the minute it
    takes h5py to walk the netCDF's index over HTTP)."""
    if year is None:
        return f"{S3}/static/cog/ITS_LIVE_velocity_120m_RGI{region}_0000_V02.1_{var}.tif"
    return f"{S3}/annual/cog/ITS_LIVE_velocity_120m_RGI{region}_{year}_V02.1_{var}.tif"


def read_window(url: str, bbox, pad: int = 3) -> dict | None:
    """The cells of a COG covering a lon/lat box (densified edges: polar grids bend them), as a
    float32 array with NaN for nodata, its cell-centre coordinates and EPSG code."""
    import rasterio
    from rasterio.warp import transform_bounds
    from rasterio.windows import Window, from_bounds

    env = {
        "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
        "GDAL_HTTP_MAX_RETRY": "3",
        "GDAL_HTTP_RETRY_DELAY": "5",
        "GDAL_HTTP_TIMEOUT": "120",
    }
    with rasterio.Env(**env), rasterio.open(f"/vsicurl/{url}") as d:
        b = transform_bounds("EPSG:4326", d.crs, *bbox, densify_pts=21)
        w = from_bounds(*b, d.transform).round_offsets().round_lengths()
        c0 = max(0, int(w.col_off) - pad)
        r0 = max(0, int(w.row_off) - pad)
        c1 = min(d.width, int(w.col_off + w.width) + pad)
        r1 = min(d.height, int(w.row_off + w.height) + pad)
        if c1 - c0 < 2 or r1 - r0 < 2:
            return None
        a = d.read(1, window=Window(c0, r0, c1 - c0, r1 - r0)).astype(np.float32)
        if d.nodata is not None:
            a[a == np.float32(d.nodata)] = np.nan
        tr = d.transform
        x = tr.c + tr.a * (np.arange(c0, c1) + 0.5)
        y = tr.f + tr.e * (np.arange(r0, r1) + 0.5)
        return {"a": a, "x": x, "y": y, "crs": d.crs.to_wkt()}


def _fetch_one(task) -> str:
    g, year, names, out = task
    if out.is_file():
        return "kept"
    planes, x, y, crs = {}, None, None, None
    for var in names:
        for attempt in range(3):
            try:
                got = read_window(cog_url(g["region"], year, var), g["bbox"])
                break
            except Exception as exc:  # noqa: BLE001 - network: retry, then report
                if "404" in str(exc) or "does not exist" in str(exc):
                    got = None
                    break
                if attempt == 2:
                    return f"failed {type(exc).__name__}: {str(exc)[:100]}"
                time.sleep(5 * (attempt + 1))
        if got is None:
            continue
        planes[var] = got["a"]
        x, y, crs = got["x"], got["y"], got["crs"]
    if not planes:
        return "missing"
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, x=x, y=y, crs=crs, **planes)
    return "read"


def fetch_itslive(group: list[dict], annual: bool = True, log=print) -> None:
    """Static (2014-2024) and annual (1985-2024) ITS_LIVE windows for every glacier, read in
    parallel; windows already saved are kept."""
    tasks = []
    for g in group:
        tasks.append((g, None, STATIC_VARS, RAW_ROOT / g["id"] / "static.npz"))
        if annual:
            for year in YEARS:
                tasks.append((g, year, ANNUAL_VARS, RAW_ROOT / g["id"] / "annual" / f"{year}.npz"))
    todo = [t for t in tasks if not t[3].is_file()]
    log(f"  its_live: {len(todo)} of {len(tasks)} windows to read", flush=True)
    t0 = time.monotonic()
    counts: dict[str, int] = {}
    with ThreadPoolExecutor(WORKERS) as pool:
        for k, (task, res) in enumerate(zip(todo, pool.map(_fetch_one, todo), strict=True)):
            counts[res.split(" ")[0]] = counts.get(res.split(" ")[0], 0) + 1
            if res not in ("read", "kept"):
                log(f"  {task[0]['id']} {task[1] or 'static'}: {res}", flush=True)
            if (k + 1) % 50 == 0:
                log(f"  its_live: {k + 1}/{len(todo)} ({time.monotonic() - t0:.0f} s)", flush=True)
    log(f"  its_live: {counts}", flush=True)


# ---------------------------------------------------------------- terrain

# Copernicus DEM GLO-90 (ESA; free and open, attribution "produced using Copernicus WorldDEM-30
# © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS
# by the European Union and ESA"), public COGs on AWS Open Data, no account. Global, the
# poles included, which NASADEM (60°N-56°S) is not. Only for the map's relief (D-087).
COP90 = "https://copernicus-dem-90m.s3.amazonaws.com/{n}/{n}.tif"
COP90_CREDIT = (
    "Copernicus DEM GLO-90 (ESA; © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH"
    " 2014-2018, provided under COPERNICUS by the European Union and ESA)"
)


def cop90_name(lat0: int, lon0: int) -> str:
    ns = f"N{lat0:02d}" if lat0 >= 0 else f"S{-lat0:02d}"
    ew = f"E{lon0:03d}" if lon0 >= 0 else f"W{-lon0:03d}"
    return f"Copernicus_DSM_COG_30_{ns}_00_{ew}_00_DEM"


def fetch_dem(g: dict, log=print) -> Path | None:
    """Heights on the glacier's map grid from every 1° Copernicus tile the box touches (a tile
    that is all sea does not exist and is skipped); saved to raw/<id>/dem.npz."""
    target = RAW_ROOT / g["id"] / "dem.npz"
    if target.is_file():
        return target
    w, s, e, n = g["bbox"]
    grid = merc_grid(g["bbox"], MAX_PX)
    width, height, _ = grid
    dem = np.full((height, width), np.nan, dtype=np.float32)
    tiles = 0
    for lat0 in range(int(np.floor(s)), int(np.ceil(n))):
        for lon0 in range(int(np.floor(w)), int(np.ceil(e))):
            try:
                win = read_window(COP90.format(n=cop90_name(lat0, lon0)), g["bbox"])
            except Exception as exc:  # noqa: BLE001 - a missing (all-sea) tile is a 404
                if (
                    "404" not in str(exc)
                    and "not recognized" not in str(exc)
                    and "No such file" not in str(exc)
                ):
                    log(f"  {g['id']} dem {cop90_name(lat0, lon0)}: {type(exc).__name__}")
                continue
            if win is None:
                continue
            part = to_merc(win["a"], win["x"], win["y"], win["crs"], grid)
            dem = np.where(np.isfinite(part), part, dem)
            tiles += 1
    target.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(target, dem=dem)
    log(
        f"  {g['id']}: terrain from {tiles} Copernicus tile(s),"
        f" {100 * np.isfinite(dem).mean():.0f} % of the box"
    )
    return target


# ---------------------------------------------------------------- GRACE / GRACE-FO


def fetch_grace(log=print) -> Path | None:
    from . import nasa_inputs

    return nasa_inputs.fetch_grace_global(config.RAW_DIR / "_global" / "GRACE_MASCON", log)


def grace_region(nc: Path, bbox) -> dict | None:
    """Monthly mass anomaly (Gt) summed over the CRI cells of a box, land only, and its trend.

    lwe_thickness is cm of water over each 0.5-degree cell; mass = thickness x cell area. The
    mascons are ~3 degrees, so a box catches some leakage from its surroundings; the box stands
    in for the published region masks and the card says so."""
    import h5py

    with h5py.File(nc, "r") as f:
        lat = f["lat"][()]
        lon = f["lon"][()]
        t = f["time"][()]
        w, s, e, n = bbox
        lon180 = np.where(lon > 180, lon - 360, lon)
        li = np.where((lat >= s) & (lat <= n))[0]
        lj = np.where((lon180 >= w) & (lon180 <= e))[0]
        if not li.size or not lj.size:
            return None
        lwe = f["lwe_thickness"][:, li.min() : li.max() + 1, :][:, :, lj].astype(float)
        land = None
        if "land_mask" in f:
            land = f["land_mask"][li.min() : li.max() + 1, :][:, lj] > 0
    lwe[np.abs(lwe) > 1e4] = np.nan
    la = lat[li.min() : li.max() + 1]
    # Cell area of a 0.5-degree cell (m2) times cm of water -> kg -> Gt.
    area = (np.deg2rad(0.5) * 6371e3) ** 2 * np.cos(np.deg2rad(la))[:, None] * np.ones(lj.size)
    mask = np.ones_like(area, dtype=bool) if land is None else land
    gt = np.nansum(lwe * (area * mask)[None], axis=(1, 2)) * 1e-2 * 1e3 / 1e12
    t0 = date(2002, 1, 1)
    dates = [t0 + timedelta(days=float(d)) for d in t]
    years = np.array([d.year + (d.timetuple().tm_yday - 0.5) / 365.25 for d in dates])
    ok = np.isfinite(gt)
    slope, icpt = np.polyfit(years[ok], gt[ok], 1)
    # Trend over the published period, for the check (Apr 2002 - Sep 2019).
    pub = ok & (years >= 2002.25) & (years <= 2019.75)
    s_pub = float(np.polyfit(years[pub], gt[pub], 1)[0]) if pub.sum() > 24 else None
    gt = gt - gt[ok][: min(12, ok.sum())].mean()  # relative to the first year measured
    return {
        "months": [d.strftime("%Y-%m") for d, k in zip(dates, ok, strict=True) if k],
        "gt": [round(float(v), 1) for v in gt[ok]],
        "trend_gt_yr": round(float(slope), 1),
        "trend_2002_2019_gt_yr": None if s_pub is None else round(s_pub, 1),
        "land_mask": land is not None,
    }


# ---------------------------------------------------------------- NISAR in the catalogue


def nisar_counts(bbox) -> dict:
    """Granules NASA's CMR lists over the box for each NISAR product (public search, no login)."""
    w, s, e, n = bbox
    out = {}
    for key, short in NISAR_PRODUCTS.items():
        url = (
            f"{CMR}?short_name={short}&bounding_box={w},{s},{e},{n}"
            "&page_size=1&sort_key=-start_date"
        )
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                hits = int(r.headers.get("CMR-Hits", "0"))
                entries = json.load(r)["feed"]["entry"]
        except Exception:  # noqa: BLE001 - the count is context; a failed search is left out
            continue
        out[key] = {"n": hits, "latest": entries[0]["time_start"][:10] if entries else None}
    return out


# ---------------------------------------------------------------- NISAR ice speed vs ITS_LIVE

GOFF_MAX_PAIRS = 8


def regrid(
    src: np.ndarray,
    x: np.ndarray,
    y: np.ndarray,
    crs: str,
    dst_tr,
    dst_crs: str,
    shape,
    how="bilinear",
):
    """Reproject a window (cell centres x, y) onto any grid."""
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.warp import reproject

    dx, dy = float(x[1] - x[0]), float(y[0] - y[1])
    out = np.full(shape, np.nan, dtype=np.float32)
    reproject(
        np.asarray(src, dtype=np.float32),
        out,
        src_transform=from_origin(x[0] - dx / 2, y[0] + dy / 2, dx, dy),
        src_crs=crs,
        src_nodata=np.nan,
        dst_transform=dst_tr,
        dst_crs=dst_crs,
        dst_nodata=np.nan,
        resampling=getattr(Resampling, how),
    )
    return out


def goff_vs_itslive(h, st: dict, bbox) -> dict:
    """One NISAR GOFF pair against ITS_LIVE's 2014-2024 speed on the GOFF grid.

    As on the Columbia Icefield (docs/15, ice.goff_pair): offsets are referenced to the median
    over ground ITS_LIVE marks as not ice (rock), slant range is projected to the ground with the
    median incidence angle, and a cell counts only where the three correlation windows agree.
    Here ITS_LIVE's ice mask replaces RGI outlines (the ice sheet is not in RGI)."""
    from rasterio.transform import from_origin
    from rasterio.warp import transform as warp

    from .ice import AGREE_ALONG_M, AGREE_RANGE_M, GOFF_BASE

    grp = h[GOFF_BASE]
    x = np.asarray(grp["xCoordinates"])
    y = np.asarray(grp["yCoordinates"])
    crs = f"EPSG:{int(grp['projection'][()])}"
    w, s, e, n = bbox
    xs, ys = warp("EPSG:4326", crs, [w, e, w, e], [s, s, n, n])
    c0, c1 = int(np.searchsorted(x, min(xs))), int(np.searchsorted(x, max(xs)))
    r0, r1 = int(np.abs(y - max(ys)).argmin()), int(np.abs(y - min(ys)).argmin())
    if c1 - c0 < 10 or r1 - r0 < 10:
        return {"cells": 0}
    dx, dy = float(x[1] - x[0]), float(y[0] - y[1])
    tr = from_origin(x[c0] - dx / 2, y[r0] + dy / 2, dx, dy)
    shape = (r1 - r0, c1 - c0)
    ref_v = regrid(st["v"], st["x"], st["y"], str(st["crs"]), tr, crs, shape)
    ice = (
        regrid(
            st["landice"].astype(np.float32),
            st["x"],
            st["y"],
            str(st["crs"]),
            tr,
            crs,
            shape,
            "nearest",
        )
        >= 0.5
    )
    rock = ~ice & np.isfinite(ref_v)
    days = float(h["science/LSAR/GOFF/metadata/orbit/temporalBaseline"][()])
    inc = float(np.nanmedian(np.asarray(h["science/LSAR/GOFF/metadata/radarGrid/incidenceAngle"])))
    along, rng = [], []
    for lay in ("layer1", "layer2", "layer3"):
        L = grp["HH"][lay]
        a = np.asarray(L["alongTrackOffset"][r0:r1, c0:c1]).astype(float)
        r = np.asarray(L["slantRangeOffset"][r0:r1, c0:c1]).astype(float)
        along.append(a - np.nanmedian(a[rock]) if rock.any() else a)
        rng.append(r - np.nanmedian(r[rock]) if rock.any() else r)
    A, R = np.stack(along), np.stack(rng)
    with np.errstate(invalid="ignore"):
        agree = (np.abs(A - A[2]).max(axis=0) < AGREE_ALONG_M) & (
            np.abs(R - R[2]).max(axis=0) < AGREE_RANGE_M
        )
        speed = np.hypot(A.mean(axis=0), R.mean(axis=0) / np.sin(np.deg2rad(inc))) / days * 365.25
    ok_rock = rock & agree & np.isfinite(speed)
    noise = float(np.median(speed[ok_rock])) if ok_rock.sum() > 50 else None
    out = {
        "days": days,
        "res_m": dx,
        "incidence_deg": round(inc, 1),
        "rock_noise_m_yr": None if noise is None else round(noise, 1),
    }
    vmax = float(np.nanpercentile(ref_v[ice], 99)) if ice.any() else 0.0
    # Bands of ITS_LIVE speed: does NISAR agree on slow, fast and fastest ice alike?
    bands = []
    for lo, hi in ((0.0, 0.1), (0.1, 0.3), (0.3, 0.6), (0.6, 1.01)):
        sel = ice & np.isfinite(ref_v) & (ref_v >= lo * vmax) & (ref_v < hi * vmax)
        ok = sel & agree & np.isfinite(speed)
        bands.append(
            {
                "from_m_yr": round(lo * vmax),
                "to_m_yr": round(min(hi, 1.0) * vmax),
                "cells": int(sel.sum()),
                "agree_pct": round(100 * float(ok.sum()) / max(1, int(sel.sum())), 1),
                "nisar_m_yr": round(float(np.median(speed[ok]))) if ok.sum() >= 20 else None,
                "itslive_m_yr": round(float(np.median(ref_v[ok]))) if ok.sum() >= 20 else None,
            }
        )
    ok = ice & agree & np.isfinite(speed) & np.isfinite(ref_v)
    corr = float(np.corrcoef(speed[ok], ref_v[ok])[0, 1]) if ok.sum() >= 50 else None
    out.update(
        {
            "ice_cells": int(ice.sum()),
            "ice_agree_pct": round(100 * float(ok.sum()) / max(1, int(ice.sum())), 1),
            "r": None if corr is None else round(corr, 3),
            "ratio_median": round(float(np.median(speed[ok] / np.maximum(ref_v[ok], 1))), 2)
            if ok.sum() >= 50
            else None,
            "bands": bands,
        }
    )
    return out


def fetch_goff(g: dict, log=print) -> Path | None:
    """The NISAR ice-speed test on up to GOFF_MAX_PAIRS pairs over the glacier (spread over
    tracks and the season); results saved after each pair and kept on a rerun."""
    import h5py

    from . import nasa_access as na
    from .ice import GOFF_SHORT

    st = _load_npz(RAW_ROOT / g["id"] / "static.npz")
    if st is None:
        return None
    ea = na._earthaccess()
    na.login()
    grans = ea.search_data(short_name=GOFF_SHORT, bounding_box=tuple(g["bbox"]), count=200)
    seen: dict = {}
    for gr in grans:
        key = gr["umm"]["GranuleUR"].rsplit("_", 1)[0]
        if key not in seen or gr["umm"]["GranuleUR"] > seen[key]["umm"]["GranuleUR"]:
            seen[key] = gr
    pick = sorted(seen.values(), key=lambda gr: gr["umm"]["GranuleUR"])
    if len(pick) > GOFF_MAX_PAIRS:
        idx = np.linspace(0, len(pick) - 1, GOFF_MAX_PAIRS).round().astype(int)
        pick = [pick[i] for i in sorted(set(idx.tolist()))]
    out = RAW_ROOT / g["id"] / "goff.json"
    pairs = json.loads(out.read_text()) if out.is_file() else []
    done = {p["granule"] for p in pairs}
    log(f"  goff {g['id']}: {len(seen)} pairs listed, testing {len(pick)}", flush=True)
    for gr in pick:
        name = gr["umm"]["GranuleUR"]
        if name in done:
            continue
        parts = name.split("_")
        try:
            h = h5py.File(ea.open([gr])[0], "r")
            got = goff_vs_itslive(h, st, g["bbox"])
        except Exception as exc:  # noqa: BLE001 - one bad pair must not stop the test
            log(f"  goff: {name} not read ({type(exc).__name__}: {str(exc)[:80]})", flush=True)
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
        out.write_text(json.dumps(pairs, indent=1), encoding="utf-8")
        p = pairs[-1]
        log(
            f"  goff {p['track']} {p['start']}->{p['end']}: agree {p.get('ice_agree_pct')}%"
            f" r {p.get('r')} ratio {p.get('ratio_median')}",
            flush=True,
        )
    return out


def goff_summary(pairs: list[dict]) -> dict | None:
    """The test as the card shows it: per pair, and the best pair (most fast ice agreeing)."""
    pairs = [p for p in pairs if p.get("ice_cells")]
    if not pairs:
        return None
    fast = lambda p: p["bands"][-1]["agree_pct"] if p.get("bands") else 0  # noqa: E731
    best = max(pairs, key=fast)
    keep = (
        "track",
        "start",
        "end",
        "days",
        "res_m",
        "rock_noise_m_yr",
        "ice_agree_pct",
        "r",
        "ratio_median",
        "bands",
    )
    return {
        "source": "NISAR L2 GOFF pixel offsets (provisional), HH, three correlation windows",
        "pairs": [{k: p.get(k) for k in keep} for p in sorted(pairs, key=lambda p: p["start"])],
        "best": {k: best.get(k) for k in keep},
    }


# ---------------------------------------------------------------- web grid (Web Mercator)


def merc_grid(bbox, max_px: int) -> tuple[int, int, object]:
    """Width, height and affine transform of a Web Mercator grid whose corners are the box."""
    from rasterio.transform import from_bounds
    from rasterio.warp import transform as warp

    w, s, e, n = bbox
    (x0, x1), (y0, y1) = warp("EPSG:4326", "EPSG:3857", [w, e], [s, n])
    span = max(x1 - x0, y1 - y0)
    res = span / max_px
    width, height = max(2, round((x1 - x0) / res)), max(2, round((y1 - y0) / res))
    return width, height, from_bounds(x0, y0, x1, y1, width, height)


def to_merc(
    src: np.ndarray, x: np.ndarray, y: np.ndarray, crs: str, grid, how: str = "average"
) -> np.ndarray:
    """Reproject a window (cell centres x, y in crs) onto the Web Mercator grid."""
    from rasterio.enums import Resampling
    from rasterio.transform import from_origin
    from rasterio.warp import reproject

    width, height, tr = grid
    dx, dy = float(x[1] - x[0]), float(y[0] - y[1])
    out = np.full((height, width), np.nan, dtype=np.float32)
    reproject(
        np.asarray(src, dtype=np.float32),
        out,
        src_transform=from_origin(x[0] - dx / 2, y[0] + dy / 2, dx, dy),
        src_crs=crs,
        src_nodata=np.nan,
        dst_transform=tr,
        dst_crs="EPSG:3857",
        dst_nodata=np.nan,
        resampling=getattr(Resampling, how),
    )
    return out


def east_north(
    vx: np.ndarray, vy: np.ndarray, x: np.ndarray, y: np.ndarray, crs: str
) -> tuple[np.ndarray, np.ndarray]:
    """Turn velocity components on a projected grid into true east and north components (same
    speed). Polar stereographic grids are rotated against north by up to tens of degrees, so a
    point is moved a little along the flow and both ends are taken to lon/lat."""
    from rasterio.warp import transform as warp

    X, Y = np.meshgrid(x, y)
    speed = np.hypot(vx, vy)
    ok = np.isfinite(speed) & (speed > 0)
    e = np.full(vx.shape, np.nan, np.float32)
    nn = np.full(vx.shape, np.nan, np.float32)
    if not ok.any():
        return e, nn
    step = 50.0  # m along the flow
    ux, uy = vx[ok] / speed[ok], vy[ok] / speed[ok]
    lon0, lat0 = warp(crs, "EPSG:4326", X[ok].tolist(), Y[ok].tolist())
    lon1, lat1 = warp(crs, "EPSG:4326", (X[ok] + step * ux).tolist(), (Y[ok] + step * uy).tolist())
    lon0, lat0, lon1, lat1 = map(np.asarray, (lon0, lat0, lon1, lat1))
    de = (lon1 - lon0) * np.cos(np.deg2rad(lat0))
    dn = lat1 - lat0
    norm = np.hypot(de, dn)
    norm[norm == 0] = 1
    e[ok] = speed[ok] * de / norm
    nn[ok] = speed[ok] * dn / norm
    return e, nn


def cell_m(bbox, grid) -> float:
    """Ground size (m) of one web-grid cell at the box's middle latitude."""
    width, _, tr = grid
    lat = (bbox[1] + bbox[3]) / 2
    return float(tr.a * np.cos(np.deg2rad(lat)))


# ---------------------------------------------------------------- flowline and history


def lonlat_to_px(lon: float, lat: float, grid) -> tuple[float, float]:
    from rasterio.warp import transform as warp

    _, _, tr = grid
    (mx,), (my,) = warp("EPSG:4326", "EPSG:3857", [lon], [lat])
    col, row = ~tr * (mx, my)
    return float(col), float(row)


def px_to_lonlat(cols, rows, grid) -> tuple[np.ndarray, np.ndarray]:
    from rasterio.warp import transform as warp

    _, _, tr = grid
    mx = tr.c + tr.a * np.asarray(cols)
    my = tr.f + tr.e * np.asarray(rows)
    lon, lat = warp("EPSG:3857", "EPSG:4326", mx.tolist(), my.tolist())
    return np.asarray(lon), np.asarray(lat)


def bilinear(a: np.ndarray, col: float, row: float) -> float:
    """Value of a grid at a fractional cell position (cell centres at +0.5), NaN outside."""
    h, w = a.shape
    c, r = col - 0.5, row - 0.5
    if not (0 <= c <= w - 1 and 0 <= r <= h - 1):
        return float("nan")
    c0, r0 = int(np.floor(c)), int(np.floor(r))
    c1, r1 = min(c0 + 1, w - 1), min(r0 + 1, h - 1)
    fc, fr = c - c0, r - r0
    q = a[[r0, r0, r1, r1], [c0, c1, c0, c1]]
    wts = np.array([(1 - fc) * (1 - fr), fc * (1 - fr), (1 - fc) * fr, fc * fr])
    ok = np.isfinite(q)
    if not ok.any() or wts[ok].sum() < 0.5:
        return float("nan")
    return float((q[ok] * wts[ok]).sum() / wts[ok].sum())


def snap_front(speed: np.ndarray, col: float, row: float, radius_px: int) -> tuple[float, float]:
    """The fastest measured cell within radius_px of the configured front point: the flowline then
    starts on the glacier's main trunk, not on a slow margin beside it."""
    h, w = speed.shape
    r0, r1 = max(0, int(row) - radius_px), min(h, int(row) + radius_px + 1)
    c0, c1 = max(0, int(col) - radius_px), min(w, int(col) + radius_px + 1)
    sub = speed[r0:r1, c0:c1]
    if not np.isfinite(sub).any():
        return col, row
    rr, cc = np.unravel_index(np.nanargmax(sub), sub.shape)
    return c0 + cc + 0.5, r0 + rr + 0.5


def fill_gaps(a: np.ndarray, k: int = 2) -> np.ndarray:
    """A field with holes up to ~2k cells wide filled by the mean of its measured neighbours
    (normalised convolution), for tracing only: one unmeasured cell must not end a flowline."""
    ok = np.isfinite(a)
    v = np.where(ok, a, 0.0)
    pad = lambda x: np.pad(x, k)  # noqa: E731
    vs, ws = np.zeros_like(v), np.zeros_like(v)
    pv, pw = pad(v), pad(ok.astype(float))
    h, w = a.shape
    for dy in range(-k, k + 1):
        for dx in range(-k, k + 1):
            vs += pv[k + dy : k + dy + h, k + dx : k + dx + w]
            ws += pw[k + dy : k + dy + h, k + dx : k + dx + w]
    out = a.copy()
    fill = ~ok & (ws >= 3)
    out[fill] = vs[fill] / ws[fill]
    return out


def smooth(a: np.ndarray, k: int = 2) -> np.ndarray:
    """Mean of the measured cells in a (2k+1)^2 window, where at least 3 are measured."""
    ok = np.isfinite(a)
    v = np.where(ok, a, 0.0)
    h, w = a.shape
    pv, pw = np.pad(v, k), np.pad(ok.astype(float), k)
    vs, ws = np.zeros_like(v), np.zeros_like(v)
    for dy in range(-k, k + 1):
        for dx in range(-k, k + 1):
            vs += pv[k + dy : k + dy + h, k + dx : k + dx + w]
            ws += pw[k + dy : k + dy + h, k + dx : k + dx + w]
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(ws >= 3, vs / ws, np.nan)


def trace(
    east: np.ndarray,
    north: np.ndarray,
    col: float,
    row: float,
    cell: float,
    sign: int,
    max_km: float = FLOW_MAX_KM,
) -> np.ndarray:
    """(n, 2) col/row points from (col, row) along the flow (sign +1, down to the front) or
    against it (sign -1, up to the head): second-order Runge-Kutta, half a cell a step, until
    the ice slows below FLOW_MIN_SHARE of its fastest, the path leaves the measured ice or the
    map, turns back on itself, or reaches max_km."""
    speed = np.hypot(east, north)
    # The 99th percentile, not the maximum: single cells of ITS_LIVE can read tens of km a year.
    vmax = float(np.nanpercentile(speed, 99)) if np.isfinite(speed).any() else 0.0
    stop = max(FLOW_MIN_M_YR, FLOW_MIN_SHARE * vmax)
    h = 0.5

    def step(c, r):
        e, n = bilinear(east, c, r), bilinear(north, c, r)
        s = np.hypot(e, n)
        if not np.isfinite(s) or s < stop:
            return None
        return sign * e / s, -sign * n / s  # rows grow southward

    pts = [(col, row)]
    for _ in range(int(max_km * 1000 / (cell * h))):
        c, r = pts[-1]
        k1 = step(c, r)
        if k1 is None:
            break
        k2 = step(c + h * k1[0] / 2, r + h * k1[1] / 2)
        if k2 is None:
            break
        nxt = (c + h * k2[0], r + h * k2[1])
        # Stop where the path turns back (a divide or a noisy patch): the last 20 steps moved
        # less than 5 cells.
        if len(pts) > 40 and np.hypot(nxt[0] - pts[-20][0], nxt[1] - pts[-20][1]) < 5 * h:
            break
        pts.append(nxt)
    return np.array(pts)


def trace_upstream(east, north, col, row, cell):
    return trace(east, north, col, row, cell, -1)


def flowline(east: np.ndarray, north: np.ndarray, speed: np.ndarray, hint, cell: float):
    """The glacier's centre flowline from its front to its head, through the mean flow.

    It starts on the fastest ice within FLOW_SNAP_KM of the configured hint (the main trunk,
    whatever the hint's accuracy), runs downstream to where measured ice ends (the 2014-2024
    front) and upstream to the head. Returns (points from front to head, index of the start)."""
    # Traced on lightly smoothed fields (5 x 5 mean, holes filled): slow, debris-covered ice has
    # noisy directions cell to cell, and one odd cell must not turn or end the line.
    ef, nf = smooth(east), smooth(north)
    sm = smooth(speed)
    sp = np.hypot(ef, nf)
    vmax = float(np.nanpercentile(sp, 99)) if np.isfinite(sp).any() else 0.0
    stop = max(FLOW_MIN_M_YR, FLOW_MIN_SHARE * vmax)
    # Widen the search when the hint lies off moving ice (a front that retreated past it, or
    # a slow tongue): first ice moving at least twice the trace's stop speed, within 12 km.
    for km in (FLOW_SNAP_KM, 4.0, 8.0, 12.0):
        sc, sr = snap_front(sm, hint[0], hint[1], radius_px=max(2, int(km * 1000 / cell)))
        if np.isfinite(bilinear(sp, sc, sr)) and bilinear(sp, sc, sr) >= 2 * stop:
            break
    down = trace(ef, nf, sc, sr, cell, +1, max_km=40.0)
    up = trace(ef, nf, sc, sr, cell, -1)
    return np.vstack([down[::-1], up[1:]]), len(down) - 1


def extend_down(pts: np.ndarray, km: float, cell: float) -> np.ndarray:
    """Prepend a straight run of `km` beyond the front, along the direction of the lowest 2 km of
    the flowline, so fronts that stood further out in earlier years fall on the line."""
    if km <= 0 or len(pts) < 3:
        return pts
    k = min(len(pts) - 1, max(2, int(2000 / (cell * 0.5))))
    d = pts[0] - pts[k]
    d = d / max(np.hypot(*d), 1e-9)
    n = int(km * 1000 / (cell * 0.5))
    ext = pts[0] + d[None, :] * (np.arange(n, 0, -1)[:, None] * 0.5)
    return np.vstack([ext, pts])


def resample_line(pts: np.ndarray, cell: float, n: int) -> tuple[np.ndarray, np.ndarray]:
    """n points evenly spaced along the polyline, and their distance (km) from its start."""
    seg = np.hypot(*np.diff(pts, axis=0).T) * cell / 1000
    d = np.concatenate([[0], np.cumsum(seg)])
    at = np.linspace(0, d[-1], n)
    return np.column_stack([np.interp(at, d, pts[:, 0]), np.interp(at, d, pts[:, 1])]), at


def sample_line(a: np.ndarray, line: np.ndarray, scale: float = 1.0) -> np.ndarray:
    """Values of a grid along a line given in another grid's cells (scale = cells of a per cell of
    the line's grid)."""
    return np.array([bilinear(a, c * scale, r * scale) for c, r in line])


def trunk_series(hov: np.ndarray, err: np.ndarray, mean_line: np.ndarray) -> list[dict | None]:
    """Per year, the median speed and error over the fast trunk (flowline points whose mean speed
    is at least TRUNK_SHARE of the flowline's fastest), where enough of it was measured."""
    vmax = np.nanmax(mean_line) if np.isfinite(mean_line).any() else np.nan
    trunk = np.isfinite(mean_line) & (mean_line >= TRUNK_SHARE * vmax)
    out = []
    for row, erow in zip(hov, err, strict=True):
        ok = trunk & np.isfinite(row)
        if trunk.sum() == 0 or ok.sum() < TRUNK_MIN_COVER * trunk.sum():
            out.append(None)
            continue
        e = erow[ok & np.isfinite(erow)]
        out.append(
            {
                "v": round(float(np.median(row[ok])), 1),
                "err": round(float(np.median(e)), 1) if e.size else None,
                "cover": round(float(ok.sum() / trunk.sum()), 2),
            }
        )
    return out


def front_speed(row: np.ndarray, dist_km: np.ndarray, front_km: float) -> float | None:
    """Fastest measured speed within FRONT_KM upstream of the flowline's front point."""
    sel = (dist_km >= front_km) & (dist_km <= front_km + FRONT_KM) & np.isfinite(row)
    return float(np.max(row[sel])) if sel.any() else None


def check_published(
    pub: dict, years: list[int], hov: np.ndarray, dist: np.ndarray, front_km: float, trunk: list
) -> dict:
    """Compare one published statement with ITS_LIVE: a speed (m_yr) in a year at the front or on
    the trunk, or a direction of change (trend faster/slower) between `since` and `year`."""
    yi = {y: i for i, y in enumerate(years)}

    def at(year):
        if year not in yi:
            return None
        if pub.get("where") == "trunk":
            t = trunk[yi[year]]
            return None if t is None else t["v"]
        return front_speed(hov[yi[year]], dist, front_km)

    # The nearest measured year within two years of the one published.
    def near(year):
        for dy in (0, 1, -1, 2, -2):
            v = at(year + dy)
            if v is not None:
                return year + dy, v
        return None, None

    out = {k: pub[k] for k in ("what", "year", "source", "url", "where") if k in pub}
    if "m_yr" in pub:
        y, v = near(pub["year"])
        out.update(
            {
                "published_m_yr": pub["m_yr"],
                "itslive_year": y,
                "itslive_m_yr": None if v is None else round(v),
            }
        )
        if v is not None:
            out["ratio"] = round(v / pub["m_yr"], 2)
            out["agrees"] = bool(0.67 <= v / pub["m_yr"] <= 1.5)
    else:
        y0, v0 = near(pub["since"])
        y1, v1 = near(pub["year"])
        out.update(
            {"trend": pub["trend"], "since": pub["since"], "itslive_from": y0, "itslive_to": y1}
        )
        if v0 is not None and v1 is not None:
            out.update({"itslive_from_m_yr": round(v0), "itslive_to_m_yr": round(v1)})
            change = (v1 - v0) / v0 if v0 else 0
            out["change_pct"] = round(100 * change)
            out["agrees"] = bool(change > 0.1) if pub["trend"] == "faster" else bool(change < -0.1)
    return out


# ---------------------------------------------------------------- build


def _load_npz(p: Path) -> dict | None:
    if not p.is_file():
        return None
    with np.load(p) as z:
        return {k: z[k] for k in z.files}


def _nan(a: np.ndarray, fill=None) -> np.ndarray:
    a = a.astype(np.float32)
    if fill is not None:
        a[a == fill] = np.nan
    return a


def _pack(a: np.ndarray, scale: float, signed: bool) -> np.ndarray:
    """Quantise a float plane to (u)int16 at `scale` units a step; NaN -> the nodata value."""
    if signed:
        out = np.full(a.shape, -32768, np.int16)
        ok = np.isfinite(a)
        out[ok] = np.clip(np.rint(a[ok] / scale), -32767, 32767).astype(np.int16)
        return out.view(np.uint16)
    out = np.full(a.shape, 65535, np.uint16)
    ok = np.isfinite(a)
    out[ok] = np.clip(np.rint(a[ok] / scale), 0, 65534).astype(np.uint16)
    return out


def _scale_for(a: np.ndarray, signed: bool, base: float) -> float:
    """The finest of base x 10^k (k >= 0) at which the plane's largest value still fits."""
    top = float(np.nanmax(np.abs(a))) if np.isfinite(a).any() else 0.0
    lim = 32767 if signed else 65534
    s = base
    while top / s > lim:
        s *= 10
    return s


def build_site(g: dict, grace_nc: Path | None, regions: dict, log=print) -> dict | None:
    from .export import write_json

    raw = RAW_ROOT / g["id"]
    st = _load_npz(raw / "static.npz")
    if st is None:
        log(f"  {g['id']}: no ITS_LIVE window yet")
        return None
    crs = str(st["crs"])
    x, y = st["x"], st["y"]
    grid = merc_grid(g["bbox"], MAX_PX)
    width, height, _ = grid
    cell = cell_m(g["bbox"], grid)
    land = st.get("landice")

    def plane(name, fill=None, how="average"):
        a = _nan(st[name], fill)
        return to_merc(a, x, y, crs, grid, how)

    vx, vy = _nan(st["vx"]), _nan(st["vy"])
    e_src, n_src = east_north(vx, vy, x, y, crs)
    east = to_merc(e_src, x, y, crs, grid)
    north = to_merc(n_src, x, y, crs, grid)
    speed = plane("v")
    err = plane("v_error", 65535) if "v_error" in st else None
    trend = plane("dv_dt")
    amp = plane("v_amp", 65535)
    amp_err = plane("v_amp_error", 65535)
    phase = plane("v_phase", 65535, "nearest")
    ice = to_merc(land.astype(np.float32), x, y, crs, grid) if land is not None else None
    # Every cell of the box gets a class, so the map can paint all of it (no holes): ice with a
    # speed, ice without one, rock (ITS_LIVE measures it, at near-zero speed), and water or no
    # measurement (ITS_LIVE leaves open water and missing scenes empty).
    on_ice = ice >= 0.5 if ice is not None else np.isfinite(speed)
    surface = np.where(
        on_ice,
        np.where(np.isfinite(speed), SURFACE_ICE, SURFACE_ICE_GAP),
        np.where(np.isfinite(speed), SURFACE_ROCK, SURFACE_NODATA),
    ).astype(np.float32)
    # Floating ice, icebergs and melange: outside the land-ice mask but measured moving. The map
    # shows their measured flow (it carries the ice from the front out to sea); every analysis
    # below stays on the land ice.
    noise = 3 * np.nan_to_num(err, nan=np.inf) if err is not None else 0.0
    floating = (surface == SURFACE_ROCK) & (speed > np.maximum(FLOAT_MIN_M_YR, noise))
    surface[floating] = SURFACE_FLOAT
    dem_file = RAW_ROOT / g["id"] / "dem.npz"
    if dem_file.is_file():
        # Lakes and sea that ITS_LIVE reads as still ground: the Copernicus DEM flattens water
        # bodies to one height, while ground varies cell to cell. A "rock" cell whose 5 x 5
        # neighbourhood spans under half a metre is water.
        z = np.load(dem_file)["dem"].astype(np.float32)
        k = 2
        pz = np.pad(z, k, mode="edge")
        hi = np.full(z.shape, -np.inf, dtype=np.float32)
        lo = np.full(z.shape, np.inf, dtype=np.float32)
        hh, ww = z.shape
        for dy in range(2 * k + 1):
            for dx in range(2 * k + 1):
                win = pz[dy : dy + hh, dx : dx + ww]
                hi = np.fmax(hi, win)
                lo = np.fmin(lo, win)
        flat = np.isfinite(z) & (hi - lo < WATER_FLAT_M)
        surface[(surface == SURFACE_ROCK) & flat] = SURFACE_NODATA
    show = {
        k: np.where(floating, a, np.nan)
        for k, a in (("speed", speed), ("east", east), ("north", north))
    }
    if ice is not None:
        # ITS_LIVE measures rock as well (it should read ~0); the maps show ice only.
        on = ice >= 0.5
        for a in (speed, east, north, trend, amp, amp_err, phase, err):
            if a is not None:
                a[~on] = np.nan
    # The seasonal swing counts where it is larger than twice its own error.
    phase[~(np.isfinite(amp) & np.isfinite(amp_err) & (amp > 2 * amp_err))] = np.nan

    # Flowline from the front, upstream through the mean flow.
    # Where the trace starts: the front, or a point up the main trunk where the snout's slow,
    # debris-covered ice would send it up a side valley (`trace_from`, D-087).
    up, _ = flowline(east, north, speed, lonlat_to_px(*g.get("trace_from", g["front"]), grid), cell)
    pts = extend_down(up, g.get("extend_km", 0), cell)
    line, dist = resample_line(pts, cell, FLOW_SAMPLES)
    front_km = float(g.get("extend_km", 0)) if len(up) > 2 else 0.0
    mean_line = sample_line(speed, line)

    # Year by year along the flowline, and the annual maps at half resolution.
    agrid = merc_grid(g["bbox"], ANNUAL_PX)
    years, hov, hov_err, annual = [], [], [], []
    for year in YEARS:
        a = _load_npz(raw / "annual" / f"{year}.npz")
        if a is None or "v" not in a:
            continue
        ax_, ay_, ae = a["x"], a["y"], str(a["crs"])
        v = _nan(a["v"])
        verr = _nan(a["v_error"], 65535) if "v_error" in a else np.full_like(v, np.nan)
        vm = to_merc(v, ax_, ay_, ae, grid)
        em = to_merc(verr, ax_, ay_, ae, grid)
        if ice is not None:
            vm[~(ice >= 0.5)] = np.nan
        years.append(year)
        hov.append(sample_line(vm, line))
        hov_err.append(sample_line(em, line))
        small = to_merc(v, ax_, ay_, ae, agrid)
        if ice is not None:
            ice_small = to_merc(land.astype(np.float32), x, y, crs, agrid)
            small[~(ice_small >= 0.5)] = np.nan
        annual.append(small)
    hov_a = np.array(hov) if hov else np.zeros((0, FLOW_SAMPLES))
    err_a = np.array(hov_err) if hov_err else np.zeros((0, FLOW_SAMPLES))
    trunk = trunk_series(hov_a, err_a, mean_line) if hov else []

    # Planes for the browser: uint16 (speeds) or int16 (signed), one scale each.
    planes, blobs = [], []

    def add(pid, a, unit, signed, base):
        sc = _scale_for(a, signed, base)
        planes.append({"id": pid, "unit": unit, "scale": sc, "signed": signed})
        blobs.append(_pack(a, sc, signed))

    # Map planes: the land ice plus the floating ice and melange (surface class 5).
    add("speed", np.where(floating, show["speed"], speed), "m/yr", False, 0.1)
    add("east", np.where(floating, show["east"], east), "m/yr", True, 0.1)
    add("north", np.where(floating, show["north"], north), "m/yr", True, 0.1)
    add("trend", trend, "m/yr/yr", True, 0.01)
    add("amp", amp, "m/yr", False, 0.1)
    add("phase", phase, "day", False, 1)
    if err is not None:
        add("error", err, "m/yr", False, 0.1)
    add("surface", surface, "class", False, 1)
    dem_file = RAW_ROOT / g["id"] / "dem.npz"
    if dem_file.is_file():
        # Heights for the map's relief only (Copernicus GLO-90); sea and gaps as no data.
        add("dem", np.load(dem_file)["dem"].astype(np.float32), "m", True, 1)
    out = OUT_ROOT / g["id"]
    out.mkdir(parents=True, exist_ok=True)
    blob = np.concatenate([b.ravel() for b in blobs]).astype("<u2").tobytes()
    ann_scale = None
    if annual:
        stack = np.array(annual)
        ann_scale = _scale_for(stack, False, 0.1)
        blob += _pack(stack, ann_scale, False).astype("<u2").tobytes()
    (out / BINARY).write_bytes(gzip.compress(blob, 9, mtime=0))

    lon, lat = px_to_lonlat(line[:, 0], line[:, 1], grid)
    fin = lambda a, d=0: [None if not np.isfinite(v) else round(float(v), d) for v in a]  # noqa: E731
    vals = speed[np.isfinite(speed)]
    tvals = trend[np.isfinite(trend)]
    region = regions.get(g.get("grace"))
    grace = None
    if grace_nc and region:
        series = grace_region(grace_nc, region["bbox"])
        if series:
            grace = {
                "region": region["name"],
                "bbox": region["bbox"],
                "source": GRACE_SOURCE,
                "published": region.get("published"),
                **series,
            }
    # Speed then and now at the front, for the one-line story and the atlas tiles.
    front_by_year = [front_speed(hov_a[i], dist, front_km) for i in range(len(years))]
    doc = {
        "schema_version": GLACIER_SCHEMA,
        "id": g["id"],
        "name": g["name"],
        "country": g["country"],
        "kind": g["kind"],
        "region": g["region"],
        "bounds": g["bbox"],
        "links": g.get("links", {}),
        "source": {
            "name": ITSLIVE_SOURCE,
            "url": ITSLIVE_URL,
            "cite": ITSLIVE_CITE,
            "static_years": [2014, 2024],
        },
        "relief_source": COP90_CREDIT if (RAW_ROOT / g["id"] / "dem.npz").is_file() else None,
        "grid": {"width": width, "height": height, "cell_m": round(cell, 1), "crs": "EPSG:3857"},
        "annual_grid": {"width": agrid[0], "height": agrid[1], "years": years, "scale": ann_scale},
        "planes": planes,
        "nodata_u16": 65535,
        "nodata_i16": -32768,
        "stats": {
            "max_m_yr": round(float(np.percentile(vals, 99.5))) if vals.size else None,
            "median_m_yr": round(float(np.median(vals))) if vals.size else None,
            "p02_m_yr": round(float(np.percentile(vals, 2)), 1) if vals.size else None,
            "trend_p02": round(float(np.percentile(tvals, 2)), 2) if tvals.size else None,
            "trend_p98": round(float(np.percentile(tvals, 98)), 2) if tvals.size else None,
            "ice_km2": round(float(np.isfinite(speed).sum()) * cell * cell / 1e6, 1),
            # Share of the box in each surface class (the map's legend states them).
            "surface_share": {
                k: round(float((surface == c).mean()), 4)
                for k, c in (
                    ("ice", SURFACE_ICE),
                    ("ice_gap", SURFACE_ICE_GAP),
                    ("rock", SURFACE_ROCK),
                    ("nodata", SURFACE_NODATA),
                    ("floating", SURFACE_FLOAT),
                )
            },
            "seasonal_share": round(
                float(np.isfinite(phase).sum() / max(1, np.isfinite(speed).sum())), 2
            ),
        },
        "flowline": {
            "lon": [round(float(v), 5) for v in lon],
            "lat": [round(float(v), 5) for v in lat],
            "km": [round(float(v), 2) for v in dist],
            "front_km": front_km,
            "mean_m_yr": fin(mean_line),
            "trunk_share": TRUNK_SHARE,
        },
        "history": {
            "years": years,
            "speed": [fin(r) for r in hov_a],
            "trunk": trunk,
            "front": [None if v is None else round(v) for v in front_by_year],
        },
        "checks": [
            check_published(p, years, hov_a, dist, front_km, trunk) for p in g.get("published", [])
        ],
        "grace": grace,
        "nisar": nisar_counts(g["bbox"]),
        "nisar_test": goff_summary(
            json.loads((raw / "goff.json").read_text()) if (raw / "goff.json").is_file() else []
        ),
    }
    write_json(out / "glacier.json", doc, compact=True)
    first = next((i for i, t in enumerate(trunk) if t), None)
    last = next((i for i in range(len(trunk) - 1, -1, -1) if trunk[i]), None)
    msg = f"  {g['id']}: {width}x{height} @ {cell:.0f} m, flowline {dist[-1]:.0f} km"
    msg += f", {len(years)} years"
    if first is not None and last is not None:
        a, b = trunk[first], trunk[last]
        msg += f", trunk {years[first]} {a['v']:.0f} -> {years[last]} {b['v']:.0f} m/yr"
    log(msg)
    return doc


def write_index(log=print) -> dict:
    """web/data/glaciers/index.json: every built glacier, with what the atlas tiles draw."""
    from .export import write_json

    cfg = {g["id"]: i for i, g in enumerate(load()["sites"])}
    items = []
    for f in OUT_ROOT.glob("*/glacier.json"):
        d = json.loads(f.read_text(encoding="utf-8"))
        h = d["history"]
        items.append(
            {
                "id": d["id"],
                "name": d["name"],
                "country": d["country"],
                "kind": d["kind"],
                "region": d["region"],
                "bounds": d["bounds"],
                "path": f"{f.parent.name}/glacier.json",
                "max_m_yr": d["stats"]["max_m_yr"],
                "years": h["years"],
                "trunk": [None if t is None else t["v"] for t in h["trunk"]],
                "front": h["front"],
                "checks": [c.get("agrees") for c in d["checks"]],
                "nisar": sum(v["n"] for v in d["nisar"].values()) if d["nisar"] else 0,
            }
        )
    items.sort(key=lambda it: cfg.get(it["id"], 999))
    doc = {"schema_version": GLACIER_SCHEMA, "glaciers": items}
    write_json(OUT_ROOT / "index.json", doc, compact=True)
    log(f"glaciers: {len(items)} in the atlas")
    return doc


def run(
    ids: list[str] | None, fetch: bool, annual: bool = True, goff: bool = False, log=print
) -> None:
    cfg = load()
    group = sites(ids)
    if fetch:
        log("== glaciers: ITS_LIVE")
        fetch_itslive(group, annual=annual, log=log)
        for g in group:
            fetch_dem(g, log)
    if goff:
        for g in group:
            if g.get("nisar_test"):
                try:
                    fetch_goff(g, log)
                except Exception as exc:  # noqa: BLE001 - the test is optional
                    log(f"  goff {g['id']}: failed ({type(exc).__name__}: {str(exc)[:120]})")
    grace_nc = None
    try:
        grace_nc = (
            fetch_grace(log)
            if fetch
            else next(
                iter(sorted((config.RAW_DIR / "_global" / "GRACE_MASCON").glob("*.nc"))), None
            )
        )
    except Exception as exc:  # noqa: BLE001 - GRACE is one panel; the atlas stands without it
        log(f"  grace: unavailable ({type(exc).__name__}: {str(exc)[:120]})")
    for g in group:
        try:
            build_site(g, grace_nc, cfg["grace_regions"], log)
        except Exception as exc:  # noqa: BLE001 - one glacier must not stop the atlas
            log(f"  {g['id']}: build failed ({type(exc).__name__}: {exc})")
    write_index(log)
