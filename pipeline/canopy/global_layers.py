"""Global context layers on a 0.25° grid (docs/03 §4.10, docs/10 D-049).

Detailed hidden-flood maps need NISAR radar processed site by site. Everywhere else the
app shows what NASA's global products say about a 0.25° cell: does NISAR cover it, is it
forest, is it wetland, how often did it look wet this season, how many people live there.
None of these is a hidden-flood detection; the app says so.

`fetch_*` need the network and an Earthdata login (cli.py global --fetch); `build` is
offline and writes web/data/global/.
"""

from __future__ import annotations

import gzip
import json
import re
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

from . import io_gcov

RES_DEG = 0.25
WIDTH = int(360 / RES_DEG)
HEIGHT = int(180 / RES_DEG)
BOUNDS = (-180.0, -90.0, 180.0, 90.0)

CMR = "https://cmr.earthdata.nasa.gov/search/granules.json"
GCOV_COLLECTION = "C2854338529-ASF"  # NISAR_L2_GCOV_PROVISIONAL_V1
UA = {"User-Agent": "under-the-canopy/0.2 (NASA Space Apps)"}


# ---------------------------------------------------------------- grid helpers


def cell_index(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Flat index of the 0.25° cell holding each lon/lat (row 0 = 90°N)."""
    col = np.clip(((np.asarray(lon) + 180.0) / RES_DEG).astype(int), 0, WIDTH - 1)
    row = np.clip(((90.0 - np.asarray(lat)) / RES_DEG).astype(int), 0, HEIGHT - 1)
    return row * WIDTH + col


def polygon_cells(ring: np.ndarray) -> np.ndarray:
    """Flat indices of cells whose centre lies inside a lon/lat ring (even-odd rule)."""
    x0, y0 = ring.min(axis=0)
    x1, y1 = ring.max(axis=0)
    if x1 - x0 > 180:  # crosses the antimeridian: footprints are small, skip rather than wrap
        return np.zeros(0, dtype=int)
    c0 = max(int(np.floor((x0 + 180) / RES_DEG)), 0)
    c1 = min(int(np.ceil((x1 + 180) / RES_DEG)), WIDTH - 1)
    r0 = max(int(np.floor((90 - y1) / RES_DEG)), 0)
    r1 = min(int(np.ceil((90 - y0) / RES_DEG)), HEIGHT - 1)
    cols = np.arange(c0, c1 + 1)
    rows = np.arange(r0, r1 + 1)
    cx, cy = np.meshgrid(-180 + (cols + 0.5) * RES_DEG, 90 - (rows + 0.5) * RES_DEG)
    hit = np.zeros(cx.shape, dtype=bool)
    for (ax, ay), (bx, by) in zip(ring, np.roll(ring, -1, axis=0), strict=True):
        if ay == by:
            continue
        crosses = (ay > cy) != (by > cy)
        xs = ax + (cy - ay) * (bx - ax) / (by - ay)
        hit ^= crosses & (cx < xs)
    rr, cc = np.meshgrid(rows, cols, indexing="ij")
    return (rr[hit] * WIDTH + cc[hit]).ravel()


# ---------------------------------------------------------------- NISAR coverage


def fetch_nisar_footprints(out: Path, start: str, end: str, log=print) -> Path:
    """Every GCOV granule's name and footprint in the window, as compact gzip JSON."""
    params = {
        "collection_concept_id": GCOV_COLLECTION,
        "temporal": f"{start}T00:00:00Z,{end}T23:59:59Z",
        "page_size": 2000,
    }
    url = f"{CMR}?{urllib.parse.urlencode(params)}"
    rows, after = [], None
    while True:
        headers = dict(UA)
        if after:
            headers["CMR-Search-After"] = after
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=300) as res:  # noqa: S310 - fixed host
            after = res.headers.get("CMR-Search-After")
            hits = res.headers.get("CMR-Hits")
            entries = json.load(res)["feed"]["entry"]
        for e in entries:
            poly = (e.get("polygons") or [[None]])[0][0]
            if not poly:
                continue
            v = [float(x) for x in poly.split()]
            rows.append([e["title"], [[v[i + 1], v[i]] for i in range(0, len(v), 2)]])
        log(f"  nisar footprints: {len(rows)} / {hits}")
        if not entries or not after:
            break
    out.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out, "wt", encoding="utf-8") as f:
        json.dump({"collection": GCOV_COLLECTION, "start": start, "end": end, "granules": rows}, f)
    return out


def nisar_layers(path: Path) -> dict[str, np.ndarray]:
    """Per cell: passes on the best single track with HH+HV, all HH+HV passes, first/last day.

    The best-track count is what decides whether the detailed pipeline can run there
    (it compares passes from one track, direction, bandwidth and polarisation; docs/04 §3.1).
    """
    with gzip.open(path, "rt", encoding="utf-8") as f:
        doc = json.load(f)
    t0 = date.fromisoformat(doc["start"])
    n = WIDTH * HEIGHT
    any_hv = np.zeros(n, dtype=np.int32)
    first = np.full(n, 10**6, dtype=np.int32)
    last = np.full(n, -1, dtype=np.int32)
    groups: dict[tuple, list[np.ndarray]] = defaultdict(list)
    seen: set[tuple] = set()
    for title, ring in doc["granules"]:
        g = io_gcov.parse_name(title + ".h5")
        if g is None or not g.has_hv:
            continue
        key = (g.group, g.start.date())
        cells = polygon_cells(np.asarray(ring, dtype=float))
        if not cells.size:
            continue
        # Adjacent frames of one pass overlap: count a pass once per cell.
        day = (g.start.date() - t0).days
        groups[key].append(cells)
        seen.add(key)
        first[cells] = np.minimum(first[cells], day)
        last[cells] = np.maximum(last[cells], day)
    # Sparse per group: a dense grid per track group (~1,000 groups) would need gigabytes.
    best = np.zeros(n, dtype=np.int32)
    per_group: dict[tuple, list[np.ndarray]] = defaultdict(list)
    for (group, _day), cell_lists in groups.items():
        cells = np.unique(np.concatenate(cell_lists))
        per_group[group].append(cells)
        any_hv[cells] += 1
    for passes in per_group.values():
        cells, counts = np.unique(np.concatenate(passes), return_counts=True)
        np.maximum.at(best, cells, counts.astype(np.int32))
    first = np.where(last >= 0, first, -1)
    return {
        "nisar_best_track_passes": best.reshape(HEIGHT, WIDTH),
        "nisar_hv_passes": any_hv.reshape(HEIGHT, WIDTH),
        "nisar_first_day": first.reshape(HEIGHT, WIDTH),
        "nisar_last_day": last.reshape(HEIGHT, WIDTH),
    }


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


# ---------------------------------------------------------------- other global products

PRODUCTS = {
    # short_name: (temporal filter, file-name filter)
    "MCD12C1": (("2025-01-01", "2025-12-31"), ".hdf"),
    "GEDI_L3_LandSurface_Metrics_V3_2525": (None, "rh100_mean"),
    "CYGNSS_L3_UC_BERKELEY_WATERMASK_V3.1": (("2025-08-01", "2026-07-31"), ".nc"),
    "CIESIN_SEDAC_GPWv4_POPCOUNT_R11": (None, "2020_15_min_tif"),
}


def fetch_products(raw: Path, log=print) -> list[Path]:
    """Download the global files (skips ones already on disk)."""
    from . import nasa_access as na

    ea = na._earthaccess()
    na.login()
    saved = []
    for sn, (temporal, pick) in PRODUCTS.items():
        kw = {"temporal": temporal} if temporal else {}
        grans = [
            g
            for g in ea.search_data(short_name=sn, count=200, **kw)
            if any(pick in u for u in g.data_links())
        ]
        target = raw / sn
        target.mkdir(parents=True, exist_ok=True)
        todo = [
            g
            for g in grans
            if not all(
                (target / u.rsplit("/", 1)[-1]).is_file() for u in g.data_links() if pick in u
            )
        ]
        log(f"  {sn}: {len(grans)} file(s), {len(todo)} to download")
        if todo:
            ea.download(todo, str(target))
        saved += sorted(target.iterdir())
    return saved


# ---------------------------------------------------------------- readers (offline)

NODATA = 255
# MODIS IGBP classes in MCD12C1 Land_Cover_Type_1_Percent, band order 0…16 as named in
# the file's own 'Layer N' attributes: 0 water, 1–5 forests, 11 permanent wetlands.
IGBP_WATER, IGBP_FORESTS, IGBP_WETLAND = 0, (1, 2, 3, 4, 5), 11


def _block_mean(a: np.ndarray, f: int) -> np.ndarray:
    h, w = a.shape[0] // f, a.shape[1] // f
    return a[: h * f, : w * f].reshape(h, f, w, f, *a.shape[2:]).mean(axis=(1, 3))


def read_mcd12c1(path: Path) -> dict[str, np.ndarray]:
    """Forest, permanent-wetland and water cover (% of the 0.25° cell) from MODIS IGBP.

    Reads one class band at a time: the full 17-band array is 1.8 GB as float.
    """
    from pyhdf.SD import SD, SDC  # pyright: ignore[reportMissingImports]

    sd = SD(str(path), SDC.READ)
    ds = sd.select("Land_Cover_Type_1_Percent")  # (3600, 7200, 17)
    f = int(RES_DEG / 0.05)

    def band(k: int) -> np.ndarray:
        b = ds[:, :, k].astype(np.float32)
        b[b == 255] = np.nan  # _FillValue
        return _block_mean(b, f)

    forest = sum(band(k) for k in IGBP_FORESTS)
    out = {"forest_pct": forest, "wetland_pct": band(IGBP_WETLAND), "water_pct": band(IGBP_WATER)}
    sd.end()
    return out


def read_gedi_height(path: Path) -> np.ndarray:
    """GEDI L3 mean canopy height (rh100, m), averaged onto the 0.25° grid; NaN = no shots."""
    import rasterio
    from rasterio.warp import Resampling, reproject

    out = np.full((HEIGHT, WIDTH), np.nan, dtype=np.float32)
    with rasterio.open(path) as src:
        transform = rasterio.transform.from_bounds(*BOUNDS, WIDTH, HEIGHT)
        reproject(
            source=rasterio.band(src, 1),
            destination=out,
            src_nodata=src.nodata,
            dst_transform=transform,
            dst_crs="EPSG:4326",
            dst_nodata=np.nan,
            resampling=Resampling.average,
        )
    out[out < 0] = np.nan
    return out


def _find(f, names):
    for n in names:
        if n in f:
            return f[n]
    raise KeyError(f"none of {names} in {list(f)}")


def read_cygnss(paths: list[Path]) -> dict[str, np.ndarray]:
    """Monthly surface-water share per 0.25° cell; return max, min and seasonal range (%).

    CYGNSS sees water under vegetation and through cloud (GNSS reflections), but only
    between about ±37° latitude; elsewhere the layer is no-data.
    """
    import h5py

    stack = []
    for p in sorted(paths):
        with h5py.File(p, "r") as f:
            wm = np.squeeze(_find(f, ("watermask", "water_mask", "WaterMask"))[...])
            lat = _find(f, ("lat", "latitude"))[...].astype(float).ravel()
            lon = _find(f, ("lon", "longitude"))[...].astype(float).ravel()
        if wm.shape != (lat.size, lon.size):
            wm = wm.T
        # Block sums with reduceat over contiguous cell runs: no per-pixel index array
        # (that would be 270 M int64 entries, 2 GB, per month).
        rows = np.clip(((90.0 - lat) / RES_DEG).astype(int), 0, HEIGHT - 1)
        cols = np.clip(((lon + 180.0) / RES_DEG).astype(int), 0, WIDTH - 1)
        r0 = np.flatnonzero(np.r_[True, np.diff(rows) != 0])
        c0 = np.flatnonzero(np.r_[True, np.diff(cols) != 0])
        sums = {}
        for name, mask in (("water", wm == 1), ("valid", (wm == 0) | (wm == 1))):
            a = np.add.reduceat(mask, c0, axis=1, dtype=np.int32)
            sums[name] = np.add.reduceat(a, r0, axis=0)
        frac = np.full((HEIGHT, WIDTH), np.nan, dtype=np.float32)
        with np.errstate(invalid="ignore", divide="ignore"):
            share = np.where(sums["valid"] > 0, sums["water"] / sums["valid"] * 100.0, np.nan)
        frac[np.ix_(rows[r0], cols[c0])] = share
        stack.append(frac)
    a = np.stack(stack)
    with np.errstate(invalid="ignore"), np.testing.suppress_warnings() as sup:
        sup.filter(RuntimeWarning)
        mx, mn = np.nanmax(a, axis=0), np.nanmin(a, axis=0)
    # Calendar month (1–12) with the most surface water; only where the season moves at
    # least WETTEST_MIN_RANGE_PCT points, otherwise "the wettest month" is noise.
    month_of = []
    for p in sorted(paths):
        m = re.search(r"\.(\d{4})-(\d{2})\.", p.name)
        month_of.append(int(m[2]) if m else 0)
    filled = np.where(np.isfinite(a), a, -1.0)
    idx = filled.argmax(axis=0)
    wettest = np.asarray(month_of, dtype=np.float64)[idx]
    wettest[~np.isfinite(mx) | ((mx - mn) < WETTEST_MIN_RANGE_PCT) | (wettest == 0)] = np.nan
    return {
        "cygnss_water_max_pct": mx,
        "cygnss_water_range_pct": mx - mn,
        "wettest_month": wettest,
        "months": len(stack),
    }


WETTEST_MIN_RANGE_PCT = 5


def read_grace_latest(nc: Path, ocean: np.ndarray) -> tuple[np.ndarray, str]:
    """Latest month's GRACE/GRACE-FO water storage against the normal for that calendar
    month (cm), on the 0.25° grid.

    Mascons are ~3° (300 km) blocks on a 0.5° grid; nearest-cell sampling keeps that
    blockiness honest instead of smoothing it into fake detail. Ocean cells are blanked.
    """
    import h5py

    from .nasa_inputs import CLIMATE_YEARS

    with h5py.File(nc, "r") as f:
        lat = f["lat"][()].astype(float)
        lon = f["lon"][()].astype(float)
        t = f["time"][()].astype(float)
        k = int(np.argmax(t))
        dates = [date(2002, 1, 1) + timedelta(days=float(v)) for v in t]
        m = dates[k].month
        same = [
            i
            for i, d in enumerate(dates)
            if d.month == m and CLIMATE_YEARS[0] <= d.year <= CLIMATE_YEARS[1]
        ]
        lwe_all = f["lwe_thickness"][same].astype(np.float32)
        lwe_now = f["lwe_thickness"][k].astype(float)
    lwe_all[np.abs(lwe_all) > 1e4] = np.nan
    with np.errstate(invalid="ignore"), np.testing.suppress_warnings() as sup:
        sup.filter(RuntimeWarning)
        normal = np.nanmean(lwe_all, axis=0)
    # This month against the same calendar month in 2004–2023, not against the yearly mean.
    lwe = lwe_now - normal
    when = dates[k].isoformat()
    rows = 90 - (np.arange(HEIGHT) + 0.5) * RES_DEG
    cols = (-180 + (np.arange(WIDTH) + 0.5) * RES_DEG) % 360
    i = np.abs(lat[:, None] - rows[None, :]).argmin(axis=0)
    j = np.abs(lon[:, None] - cols[None, :]).argmin(axis=0)
    out = lwe[np.ix_(i, j)]
    out[(np.abs(out) > 1e4) | ocean] = np.nan
    return out, when


def read_gpw(zip_path: Path) -> np.ndarray:
    """GPWv4.11 2020 population count per 15′ (= 0.25°) cell."""
    import zipfile

    import rasterio

    with zipfile.ZipFile(zip_path) as z:
        tif = next(n for n in z.namelist() if n.endswith(".tif"))
    with rasterio.open(f"/vsizip/{zip_path}/{tif}") as src:
        a = src.read(1).astype(np.float64)
        nod = src.nodata
    if nod is not None:
        a[a == nod] = np.nan
    a[a < 0] = np.nan
    if a.shape != (HEIGHT, WIDTH):  # pad if a product stops short of the poles
        pad = np.full((HEIGHT, WIDTH), np.nan)
        pad[: a.shape[0], : a.shape[1]] = a
        a = pad
    return a


# ---------------------------------------------------------------- encoding + export

# Screening rule for "where hidden floods are likely" (docs/10 D-049). Not a detection:
# forest cover plus any independent sign of standing water in the cell.
LIKELY_FOREST_PCT = 30
LIKELY_WETLAND_PCT = 10
LIKELY_CYGNSS_RANGE_PCT = 10
LIKELY_CYGNSS_MAX_PCT = 25
MIN_PASSES_DETAILED = 6  # docs/04 §7: fewer passes cannot validate against a gauge

ENCODINGS = {
    "percent": "value = q (0–100)",
    "count": "value = q",
    "day": "date = nisar_window.start + q days",
    "half_m": "metres = q / 2",
    "log_people": "people = round(10^(q / 25) − 1)",
    "class": "0 none, 1 forest without a water signal, 2 forest with a water signal",
    "month": "calendar month 1–12",
    "signed_cm": "centimetres = q − 127",
    "log_mg": "mg per m² per day = 10^(q / 80) − 1",
}


def encode(values: np.ndarray, kind: str) -> np.ndarray:
    v = np.asarray(values, dtype=np.float64)
    ok = np.isfinite(v)
    if kind in ("percent", "count", "day", "class"):
        q = np.clip(np.rint(v), 0, 254)
    elif kind == "half_m":
        q = np.clip(np.rint(v * 2), 0, 254)
    elif kind == "log_people":
        q = np.clip(np.rint(np.log10(np.maximum(v, 0) + 1) * 25), 0, 254)
    elif kind == "month":
        q = np.clip(np.rint(v), 1, 12)
    elif kind == "signed_cm":
        q = np.clip(np.rint(v) + 127, 0, 254)
    elif kind == "log_mg":
        # 2.9 % steps from 0.03 to about 1500 mg m⁻² d⁻¹; the strongest WetCHARTs member reaches 430
        q = np.clip(np.rint(np.log10(np.maximum(v, 0) + 1) * 80), 0, 254)
    else:
        raise ValueError(kind)
    out = np.full(v.shape, NODATA, dtype=np.uint8)
    out[ok] = q[ok].astype(np.uint8)
    return out


def likely_class(forest, wetland, cyg_max, cyg_range) -> np.ndarray:
    forested = forest >= LIKELY_FOREST_PCT
    with np.errstate(invalid="ignore"):
        wet = (
            (wetland >= LIKELY_WETLAND_PCT)
            | (np.nan_to_num(cyg_range) >= LIKELY_CYGNSS_RANGE_PCT)
            | (np.nan_to_num(cyg_max) >= LIKELY_CYGNSS_MAX_PCT)
        )
    out = np.zeros(forest.shape, dtype=np.float64)
    out[forested] = 1
    out[forested & wet] = 2
    out[~np.isfinite(forest)] = np.nan
    return out


# Bivariate screening map: forest cover (rows) × strength of the water sign (columns), 3 × 3.
# Water sign = the strongest of the three screening tests, as a share of its threshold, so
# column 2 is exactly "meets the likely rule" and column 1 is "halfway there".
FOREST_BINS = (30, 70)  # %
BIVARIATE_RGBA = {
    0: (0, 0, 0, 0),
    1: (58, 79, 99, 150),
    2: (59, 119, 168, 200),
    3: (61, 90, 76, 150),
    4: (122, 122, 60, 180),
    5: (201, 143, 30, 210),
    6: (63, 107, 82, 170),
    7: (176, 138, 42, 200),
    8: (230, 159, 0, 230),
}


def bivariate_class(forest, wetland, cyg_max, cyg_range) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        sign = np.fmax.reduce(
            [
                np.nan_to_num(wetland) / LIKELY_WETLAND_PCT,
                np.nan_to_num(cyg_range) / LIKELY_CYGNSS_RANGE_PCT,
                np.nan_to_num(cyg_max) / LIKELY_CYGNSS_MAX_PCT,
            ]
        )
    w = np.where(sign >= 1, 2, np.where(sign >= 0.5, 1, 0))
    f = np.where(forest >= FOREST_BINS[1], 2, np.where(forest >= FOREST_BINS[0], 1, 0))
    out = (f * 3 + w).astype(np.float64)
    out[~np.isfinite(forest)] = np.nan
    return out


def _colour_classes(c: np.ndarray, palette: dict) -> np.ndarray:
    out = np.zeros((*c.shape, 4), dtype=np.uint8)
    for k, rgba in palette.items():
        out[c == k] = rgba
    return out


def to_mercator(grid: np.ndarray, height: int | None = None) -> np.ndarray:
    """Resample lat-regular rows onto Web-Mercator rows (±85.0511°), so the browser's
    linear stretch between the corners is exact at world scale."""
    h = height or grid.shape[1]
    y = (np.arange(h) + 0.5) / h  # 0 = north edge
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * y))))
    rows = np.clip(((90.0 - lat) / RES_DEG).astype(int), 0, grid.shape[0] - 1)
    return grid[rows]


MERCATOR_LAT = 85.0511287798


# Display colours (colour-blind safe: Okabe–Ito amber/blues, sequential greens/teals).
HIDDEN_AMBER = (230, 159, 0)
FOREST_GREEN = (63, 107, 82)
WATER_RAMP = [(222, 235, 247), (158, 202, 225), (86, 180, 233), (0, 114, 178), (8, 48, 107)]
TEAL_RAMP = [(204, 236, 230), (102, 194, 164), (35, 139, 69), (0, 88, 36)]
PEOPLE_RAMP = [(254, 235, 226), (251, 180, 185), (247, 104, 161), (174, 1, 126), (73, 0, 106)]


# A cyclic 12-step wheel for "wettest month" (December sits next to January).
MONTH_RGB = [
    (76, 110, 219),
    (62, 143, 217),
    (47, 176, 184),
    (63, 191, 127),
    (140, 198, 63),
    (214, 200, 58),
    (242, 163, 58),
    (233, 116, 74),
    (217, 80, 95),
    (192, 74, 142),
    (145, 80, 184),
    (106, 91, 208),
]
STORAGE_RAMP = [(94, 60, 153), (178, 171, 210), (245, 245, 245), (128, 205, 193), (1, 133, 113)]


def read_grace_da(nc: Path) -> tuple[dict[str, np.ndarray], str]:
    """GRACE-DA-DM v3 weekly percentiles (0–100) on our grid: groundwater, root zone.

    Same 0.25° cells as ours (60°S–90°N, rows south to north), so only a flip is needed.
    A model that assimilates GRACE-FO, not a direct measurement: the app labels it so.
    """
    import h5py

    out = {}
    with h5py.File(nc, "r") as f:
        lat = f["lat"][()].astype(float)
        t = float(f["time"][0])
        for key, var in (("groundwater", "gws_inst"), ("rootzone", "rtzsm_inst")):
            a = f[var][0].astype(float)
            a[a < 0] = np.nan  # _FillValue -999
            grid = np.full((HEIGHT, WIDTH), np.nan)
            rows = np.rint((90 - RES_DEG / 2 - lat) / RES_DEG).astype(int)
            grid[rows] = a
            out[key] = grid
    week = (date(2003, 2, 2) + timedelta(days=t)).isoformat()  # file attrs: days since 2003-02-02
    return out, week


def _colour_pctile(p: np.ndarray) -> np.ndarray:
    """Percentile 0–100: purple drier than usual, near-white typical, teal wetter."""
    from . import png

    out = np.zeros((*p.shape, 4), dtype=np.uint8)
    ok = np.isfinite(p)
    out[ok, :3] = png._ramp(STORAGE_RAMP, np.clip(p[ok], 0, 100) / 100).round().astype(np.uint8)
    out[ok, 3] = 185
    return out


def _colour_months(m: np.ndarray) -> np.ndarray:
    out = np.zeros((*m.shape, 4), dtype=np.uint8)
    for k, rgb in enumerate(MONTH_RGB, start=1):
        out[m == k] = (*rgb, 200)
    return out


def _colour_storage(cm: np.ndarray, lim: float = 50.0) -> np.ndarray:
    from . import png

    out = np.zeros((*cm.shape, 4), dtype=np.uint8)
    ok = np.isfinite(cm)
    t = (np.clip(cm[ok], -lim, lim) + lim) / (2 * lim)
    out[ok, :3] = png._ramp(STORAGE_RAMP, t).round().astype(np.uint8)
    out[ok, 3] = 190
    return out


def _colour_likely(c: np.ndarray) -> np.ndarray:
    out = np.zeros((*c.shape, 4), dtype=np.uint8)
    out[c == 1] = (*FOREST_GREEN, 110)
    out[c == 2] = (*HIDDEN_AMBER, 215)
    return out


def _colour_passes(n: np.ndarray) -> np.ndarray:
    out = np.zeros((*n.shape, 4), dtype=np.uint8)
    out[(n >= 1) & (n < MIN_PASSES_DETAILED)] = (150, 160, 170, 120)
    out[n >= MIN_PASSES_DETAILED] = (86, 180, 233, 190)
    out[n >= 9] = (0, 114, 178, 220)
    return out


def _colour_glow(values, vmax, ramp, floor=0.0):
    """More is brighter and more opaque: reads on the dark streets and on the Blue Marble alike
    (a light-to-dark ramp sinks into the Blue Marble's own dark forests)."""
    from . import png

    v = np.asarray(values, dtype=float)
    out = np.zeros((*v.shape, 4), dtype=np.uint8)
    ok = np.isfinite(v) & (v > floor)
    f = np.clip(v[ok] / vmax, 0, 1)
    out[ok, :3] = png._ramp(ramp[::-1], f).round().astype(np.uint8)
    out[ok, 3] = np.round(70 + 170 * f).astype(np.uint8)
    return out


def _colour_ramp(values, vmax, ramp, floor=0.0, alpha=200):
    from . import png

    v = np.where(np.asarray(values) > floor, values, np.nan)
    return png.colour_scalar(v, vmax, ramp, alpha)


# GLWD v2 (Lehner et al. 2025, CC BY 4.0): dominant wetland class per 15" cell, read from the COG
# mirror on source.coop (verify against figshare 10.6084/m9.figshare.28519994 before a release).
GLWD_COG = "https://data.source.coop/cboettig/wetlands/glwd/glwd-main-class-cog.tif"
# Forested wetland classes: lacustrine, riverine (regularly/seasonally flooded, saturated),
# palustrine, ephemeral and peatland forests, and mangrove.
GLWD_FORESTED = (8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28)


def glwd_forested_grid(url: str = GLWD_COG, log=print) -> np.ndarray:
    """Share (%) of each 0.25° cell whose GLWD v2 class is a forested wetland; NaN without data.

    Read from the 1:4 overview (15 × 15 samples per cell) in strips, so it never holds the
    3-gigapixel full-resolution grid.
    """
    import rasterio
    from rasterio.windows import Window

    out = np.full((HEIGHT, WIDTH), np.nan)
    env = rasterio.Env(
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"
    )
    with env, rasterio.open("/vsicurl/" + url) as src:
        step = 4
        per = int(round(RES_DEG / src.res[0] / step))  # samples per cell side at the overview
        row0 = int(round((90 - src.bounds.top) / RES_DEG))
        n_rows = int(round((src.bounds.top - src.bounds.bottom) / RES_DEG))
        strip = 20
        for r in range(0, n_rows, strip):
            k = min(strip, n_rows - r)
            win = Window(0, r * per * step, src.width, k * per * step)
            a = src.read(1, window=win, out_shape=(k * per, WIDTH * per))
            valid = (a != 255).reshape(k, per, WIDTH, per).sum(axis=(1, 3))
            fores = np.isin(a, GLWD_FORESTED).reshape(k, per, WIDTH, per).sum(axis=(1, 3))
            with np.errstate(invalid="ignore", divide="ignore"):
                out[row0 + r : row0 + r + k] = np.where(valid > 0, 100.0 * fores / valid, np.nan)
            if r % 100 == 0:
                log(f"  glwd: rows {r}/{n_rows}")
    return out


def glwd_cached(raw: Path, log=print) -> np.ndarray | None:
    """The 0.25° GLWD grid, computed once from the remote COG and kept in raw/_global/GLWD."""
    f = raw / "GLWD" / "glwd_forested_pct_025.npy"
    if not f.is_file():
        try:
            grid = glwd_forested_grid(log=log)
        except Exception as exc:  # noqa: BLE001 - the world grid builds without it
            log(f"  glwd: not available ({type(exc).__name__}: {exc})")
            return None
        f.parent.mkdir(parents=True, exist_ok=True)
        np.save(f, grid.astype(np.float32))
    return np.load(f)


# WetCHARTs v1.3.3 (Bloom et al. 2017, GMD; ORNL DAAC doi:10.3334/ORNLDAAC/2346): monthly wetland
# CH₄ emissions at 0.5°, 2001-2022, as an ensemble of model set-ups coded ABCD (A global scale
# factor, B respiration model, C CH₄:C temperature dependence, D wetland-extent map). A model, not a
# measurement: the app shows the ensemble mean with its lowest and highest member.
WETCHARTS_COLLECTION = "C3236621594-ORNL_CLOUD"  # CMR concept id
WETCHARTS_YEAR = 2021  # the newest complete year: the 2022 file ends in August
CH4_FLOOR_MG = 1.0  # cells under 1 mg m⁻² d⁻¹ stay clear: the layer is about wetlands
CH4_MAX_MG = 100.0  # brightest step; the Congo and Pastaza-Marañón cells reach 200-275
CH4_RAMP = [(239, 233, 255), (190, 170, 240), (140, 110, 210), (94, 60, 170)]
EARTH_R_M = 6371007.2  # mean radius, as in the dataset's own global totals (verify)


def fetch_wetcharts(raw: Path, year: int = WETCHARTS_YEAR, log=print) -> Path | None:
    """One year of WetCHARTs (448 MB netCDF) into raw/WetCHARTs; skipped when already there."""
    from . import nasa_access as na

    target = raw / "WetCHARTs"
    name = f"WetCHARTs_v1_3_3_{year}.nc"
    if (target / name).is_file():
        return target / name
    ea = na._earthaccess()
    na.login()
    grans = [
        g
        for g in ea.search_data(concept_id=WETCHARTS_COLLECTION, count=50)
        if any(u.endswith(name) for u in g.data_links())
    ]
    if not grans:
        log(f"  wetcharts: {name} not in the collection")
        return None
    target.mkdir(parents=True, exist_ok=True)
    ea.download(grans, str(target))
    return target / name if (target / name).is_file() else None


def read_wetcharts(nc: Path) -> tuple[dict[str, np.ndarray], int, str]:
    """Annual mean (mg CH₄ m⁻² d⁻¹, weighted by days per month) of each ensemble member, keyed
    by its code, on the file's 0.5° grid (row 0 = 90°N, NaN off the model's land), the year and
    the version. Bands are grouped by their own model/time tags, never by position, and read
    one at a time (the whole file is 448 MB as float64)."""
    import calendar

    import rasterio

    sums: dict[str, np.ndarray] = {}
    missing: dict[str, np.ndarray] = {}
    months: dict[str, list[tuple[int, int]]] = defaultdict(list)
    with rasterio.open(f'netcdf:"{nc}":wetland_CH4_emissions') as ds:
        tags = ds.tags()
        m = re.match(r"days since (\d{4})-(\d\d)-(\d\d)", tags.get("time#units", ""))
        if not m or tags.get("wetland_CH4_emissions#units") != "mg m-2 d-1":
            raise ValueError(f"{nc.name}: unexpected time or emission units")
        t0 = date(int(m[1]), int(m[2]), int(m[3]))
        for b in range(1, ds.count + 1):
            bt = ds.tags(b)
            code = bt["NETCDF_DIM_model"]
            day = t0 + timedelta(days=float(bt["NETCDF_DIM_time"]))
            grid = ds.read(b).astype(np.float64)
            bad = grid == ds.nodata
            grid[bad] = 0.0
            n = calendar.monthrange(day.year, day.month)[1]
            sums[code] = sums.get(code, 0.0) + grid * n
            missing[code] = missing.get(code, False) | bad
            months[code].append((day.year, day.month))
    years = {y for v in months.values() for y, _ in v}
    if len(years) != 1:
        raise ValueError(f"{nc.name}: more than one year ({sorted(years)})")
    year = years.pop()
    out = {}
    for code, seen in months.items():
        if sorted(mo for _, mo in seen) != list(range(1, 13)):
            raise ValueError(f"{nc.name}: member {code} lacks a month")
        ann = sums[code] / (366 if calendar.isleap(year) else 365)
        ann[missing[code]] = np.nan  # a cell missing in any month has no annual mean
        out[code] = ann
    return out, year, tags.get("NC_GLOBAL#version", "WetCHARTs")


def cell_area_m2(res_deg: float, rows: int) -> np.ndarray:
    """Area of one cell in each row of a global lat/lon grid (row 0 at 90°N), on a sphere."""
    edges = np.radians(90.0 - res_deg * np.arange(rows + 1))
    return EARTH_R_M**2 * np.radians(res_deg) * (np.sin(edges[:-1]) - np.sin(edges[1:]))


def moved_share(a: np.ndarray, b: np.ndarray, row_area: np.ndarray) -> float:
    """Share of the emissions that sit in other cells in map b than in map a: the total variation
    distance of the two maps, each scaled to its own total (0 the same places, 1 none shared)."""
    ea = np.nan_to_num(a) * row_area[:, None]
    eb = np.nan_to_num(b) * row_area[:, None]
    return float(0.5 * np.abs(ea / ea.sum() - eb / eb.sum()).sum())


def _axis_moved_pct(members: dict[str, np.ndarray], pos: int, row_area) -> float | None:
    """Mean moved share (%) between member pairs that differ only in code digit `pos`, taking
    the two ends of that axis (the two extent maps; q10 = 1 against q10 = 3)."""
    values = sorted({c[pos] for c in members})
    if len(values) < 2:
        return None
    lo, hi = values[0], values[-1]
    pairs = [
        (c, c[:pos] + hi + c[pos + 1 :])
        for c in sorted(members)
        if c[pos] == lo and c[:pos] + hi + c[pos + 1 :] in members
    ]
    if not pairs:
        return None
    return round(
        100 * float(np.mean([moved_share(members[x], members[y], row_area) for x, y in pairs])), 1
    )


def wetcharts_layers(
    members: dict[str, np.ndarray], year: int, shape: tuple[int, int] = (HEIGHT, WIDTH)
) -> tuple[dict[str, np.ndarray], dict]:
    """Ensemble mean, lowest and highest member per cell on the output grid (each native cell
    repeated), and the global numbers the legend quotes: totals (Tg CH₄ per year) and how much
    of the emission changes place when only the wetland map, or only the temperature
    dependence, changes. Totals are computed on the native grid."""
    import warnings

    codes = sorted(members)
    stack = np.stack([members[c] for c in codes])
    rows, cols = stack.shape[1:]
    if shape[0] % rows or shape[1] % cols or shape[0] // rows != shape[1] // cols:
        raise ValueError(f"WetCHARTs grid {rows}x{cols} does not nest in {shape}")
    k = shape[0] // rows
    area = cell_area_m2(180.0 / rows, rows)
    days = 366 if year % 4 == 0 and (year % 100 or year % 400 == 0) else 365
    totals = np.nansum(stack * area[None, :, None], axis=(1, 2)) * days / 1e15  # mg → Tg
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN ocean cells
        mean, lo, hi = np.nanmean(stack, 0), np.nanmin(stack, 0), np.nanmax(stack, 0)
    up = lambda g: np.repeat(np.repeat(g, k, axis=0), k, axis=1)  # noqa: E731
    meta = {
        "year": year,
        "members": len(codes),
        "total_tg": round(float(np.nansum(mean * area[:, None]) * days / 1e15), 1),
        "member_total_tg": [round(float(totals.min()), 1), round(float(totals.max()), 1)],
        "extent_moved_pct": _axis_moved_pct(members, 3, area),
        "q10_moved_pct": _axis_moved_pct(members, 2, area),
    }
    return {"mean": up(mean), "lo": up(lo), "hi": up(hi)}, meta


def _colour_ch4(mg: np.ndarray) -> np.ndarray:
    """Log scale from CH4_FLOOR_MG to CH4_MAX_MG (one legend step per decade), glowing like GLWD
    so the strongest cells read on the dark streets and on the Blue Marble's dark forests."""
    with np.errstate(divide="ignore", invalid="ignore"):
        v = np.log10(np.where(np.asarray(mg) > 0, mg, np.nan) / CH4_FLOOR_MG)
    return _colour_glow(v, np.log10(CH4_MAX_MG / CH4_FLOOR_MG), CH4_RAMP, floor=0.0)


def build(raw: Path, out: Path, sites: list[dict], log=print) -> dict:
    """Write web/data/global/: global.json, global.bin (layer-major uint8) and PNGs."""
    from . import png

    layers: dict[str, tuple[np.ndarray, str, str, np.ndarray]] = {}
    sources = []

    nisar_file = raw / "nisar_gcov.json.gz"
    with gzip.open(nisar_file, "rt", encoding="utf-8") as f:
        window = {k: v for k, v in json.load(f).items() if k in ("start", "end")}
    nis = nisar_layers(nisar_file)
    best = nis["nisar_best_track_passes"].astype(float)
    layers["nisar_passes"] = (best, "count", "nisar", _colour_passes(best))
    first = np.where(nis["nisar_first_day"] >= 0, nis["nisar_first_day"], np.nan)
    last = np.where(nis["nisar_last_day"] >= 0, nis["nisar_last_day"], np.nan)
    layers["nisar_first_day"] = (first, "day", "nisar", None)
    layers["nisar_last_day"] = (last, "day", "nisar", None)
    sources.append(SOURCE_INFO["nisar"])

    lc = read_mcd12c1(next((raw / "MCD12C1").glob("*.hdf")))
    sources.append(SOURCE_INFO["modis_lc"])
    cyg_files = sorted((raw / "CYGNSS_L3_UC_BERKELEY_WATERMASK_V3.1").glob("*.nc"))
    cyg = read_cygnss(cyg_files)
    sources.append(SOURCE_INFO["cygnss"])
    likely = likely_class(
        lc["forest_pct"],
        lc["wetland_pct"],
        cyg["cygnss_water_max_pct"],
        cyg["cygnss_water_range_pct"],
    )
    layers["likely"] = (likely, "class", "derived", _colour_likely(likely))
    biv = bivariate_class(
        lc["forest_pct"],
        lc["wetland_pct"],
        cyg["cygnss_water_max_pct"],
        cyg["cygnss_water_range_pct"],
    )
    layers["bivariate"] = (biv, "class", "derived", _colour_classes(biv, BIVARIATE_RGBA))
    layers["forest_pct"] = (
        lc["forest_pct"],
        "percent",
        "modis_lc",
        _colour_ramp(lc["forest_pct"], 100, png.CANOPY_RAMP, floor=5),
    )
    layers["wetland_pct"] = (
        lc["wetland_pct"],
        "percent",
        "modis_lc",
        _colour_ramp(lc["wetland_pct"], 60, TEAL_RAMP, floor=1),
    )
    layers["water_pct"] = (lc["water_pct"], "percent", "modis_lc", None)
    layers["cygnss_range_pct"] = (
        cyg["cygnss_water_range_pct"],
        "percent",
        "cygnss",
        _colour_ramp(cyg["cygnss_water_range_pct"], 50, WATER_RAMP, floor=2),
    )
    layers["cygnss_max_pct"] = (cyg["cygnss_water_max_pct"], "percent", "cygnss", None)
    layers["wettest_month"] = (
        cyg["wettest_month"],
        "month",
        "cygnss",
        _colour_months(cyg["wettest_month"]),
    )
    grace_nc = sorted((raw / "GRACE_MASCON").glob("*.nc"))
    storage_month = None
    if grace_nc:
        ocean = np.nan_to_num(lc["water_pct"], nan=100.0) >= 99
        storage, storage_month = read_grace_latest(grace_nc[-1], ocean)
        layers["water_storage_cm"] = (storage, "signed_cm", "grace", _colour_storage(storage))
        sources.append(SOURCE_INFO["grace"])
    da_nc = sorted((raw / "GRACE_DA").glob("*.nc4"))
    da_week = None
    if da_nc:
        da, da_week = read_grace_da(da_nc[-1])
        layers["groundwater_pctile"] = (
            da["groundwater"],
            "percent",
            "grace_da",
            _colour_pctile(da["groundwater"]),
        )
        layers["rootzone_pctile"] = (
            da["rootzone"],
            "percent",
            "grace_da",
            _colour_pctile(da["rootzone"]),
        )
        sources.append(SOURCE_INFO["grace_da"])

    glwd = glwd_cached(raw)
    if glwd is not None:
        layers["glwd_forested_pct"] = (
            glwd,
            "percent",
            "glwd",
            _colour_glow(glwd, 60, TEAL_RAMP, floor=1),
        )
        sources.append(SOURCE_INFO["glwd"])

    wc_nc = sorted((raw / "WetCHARTs").glob("WetCHARTs_*.nc"))
    ch4_meta = None
    if wc_nc:
        members, year, version = read_wetcharts(wc_nc[-1])
        ch4, ch4_meta = wetcharts_layers(members, year)
        ch4_meta["version"] = version
        layers["wetland_ch4"] = (ch4["mean"], "log_mg", "wetcharts", _colour_ch4(ch4["mean"]))
        layers["wetland_ch4_lo"] = (ch4["lo"], "log_mg", "wetcharts", None)
        layers["wetland_ch4_hi"] = (ch4["hi"], "log_mg", "wetcharts", None)
        sources.append(SOURCE_INFO["wetcharts"])
        log(
            f"  wetcharts {year}: {ch4_meta['total_tg']} Tg CH₄/yr, extent map moves "
            f"{ch4_meta['extent_moved_pct']}%, q10 moves {ch4_meta['q10_moved_pct']}%"
        )

    gedi = next((raw / "GEDI_L3_LandSurface_Metrics_V3_2525").glob("*rh100_mean*.tif"))
    hgt = read_gedi_height(gedi)
    layers["canopy_height_m"] = (
        hgt,
        "half_m",
        "gedi",
        _colour_ramp(hgt, 40, png.CANOPY_RAMP, floor=5),  # < 5 m is lidar ground noise,
    )
    sources.append(SOURCE_INFO["gedi"])

    gpw = next((raw / "CIESIN_SEDAC_GPWv4_POPCOUNT_R11").glob("*15_min*.zip"))
    pop = read_gpw(gpw)
    layers["people"] = (
        pop,
        "log_people",
        "gpw",
        _colour_ramp(np.log10(np.nan_to_num(pop) + 1), 6, PEOPLE_RAMP, floor=1),
    )
    sources.append(SOURCE_INFO["gpw"])

    out.mkdir(parents=True, exist_ok=True)
    order = list(layers)
    blob = np.stack([encode(layers[k][0], layers[k][1]) for k in order])
    (out / "global.bin").write_bytes(blob.tobytes())
    meta = []
    for k in order:
        values, kind, src, rgba = layers[k]
        entry = {"id": k, "encoding": kind, "source": src, "png": None}
        if rgba is not None:
            # 2 rows per 0.25° near the equator, so cell edges sit within a quarter cell.
            png.write_png(out / f"{k}.png", to_mercator(rgba, height=2 * WIDTH))
            entry["png"] = f"{k}.png"
        meta.append(entry)
    doc = {
        "grid": {"res_deg": RES_DEG, "width": WIDTH, "height": HEIGHT, "bounds": list(BOUNDS)},
        "png_bounds": [-180.0, -MERCATOR_LAT, 180.0, MERCATOR_LAT],
        "binary": "global.bin",
        "nodata": NODATA,
        "nisar_window": window,
        "min_passes_detailed": MIN_PASSES_DETAILED,
        "cygnss_months": cyg["months"],
        "water_storage_month": storage_month,
        "groundwater_week": da_week,
        "wetland_ch4": ch4_meta,
        "bivariate_rule": {"forest_bins_pct": list(FOREST_BINS), "water_sign_bins": [0.5, 1.0]},
        "likely_rule": {
            "forest_pct": LIKELY_FOREST_PCT,
            "wetland_pct": LIKELY_WETLAND_PCT,
            "cygnss_range_pct": LIKELY_CYGNSS_RANGE_PCT,
            "cygnss_max_pct": LIKELY_CYGNSS_MAX_PCT,
        },
        "layers": meta,
        "sites": sites,
        "sources": sources,
    }
    (out / "global.json").write_text(json.dumps(doc, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"global: {len(order)} layers, {blob.nbytes // 1_000_000} MB → {out}")
    return doc


SOURCE_INFO = {
    "nisar": {
        "id": "nisar",
        "name": "NISAR L2 GCOV (provisional), granule footprints",
        "provider": "NASA/ISRO via ASF DAAC (CMR)",
        "role": "How many L-band passes from one track cover the cell (HH+HV only)",
    },
    "glwd": {
        "id": "glwd",
        "name": "GLWD v2.0 Global Lakes and Wetlands Database (2025), 15 arc-second classes",
        "provider": "WWF / McGill (Lehner et al. 2025), CC BY 4.0; COG mirror on source.coop",
        "role": "Where forested wetlands are mapped: an independent check on the screening",
    },
    "modis_lc": {
        "id": "modis_lc",
        "name": "MODIS MCD12C1 v061 land cover, 2025",
        "provider": "NASA LP DAAC",
        "role": "Forest, permanent-wetland and water cover in the cell (IGBP classes)",
    },
    "cygnss": {
        "id": "cygnss",
        "name": "CYGNSS L3 UC Berkeley monthly watermask v3.1",
        "provider": "NASA PO.DAAC",
        "role": "Surface water seen by GNSS reflections, also under vegetation (±37° only)",
    },
    "gedi": {
        "id": "gedi",
        "name": "GEDI L3 gridded land surface metrics v3 (rh100 mean)",
        "provider": "NASA ORNL DAAC",
        "role": "Canopy height from space lidar, 2019–2025 (±52° only)",
    },
    "grace": {
        "id": "grace",
        "name": "GRACE/GRACE-FO JPL mascons RL06.3, latest month",
        "provider": "NASA PO.DAAC",
        "role": "Region wetter or drier than normal for the month, 2004–2023 (≈ 300 km blocks)",
    },
    "grace_da": {
        "id": "grace_da",
        "name": "GRACE-DA-DM v3 weekly drought indicators (GRACEDADM_CLSM025GL_7D)",
        "provider": "NASA GES DISC (model assimilating GRACE-FO)",
        "role": "Groundwater and root-zone wetness as percentiles of 1948–2014",
    },
    "wetcharts": {
        "id": "wetcharts",
        "name": "WetCHARTs v1.3.3 wetland CH₄ emissions, 0.5° monthly, annual mean of one year",
        "provider": "NASA JPL (Bloom et al. 2017) via ORNL DAAC, doi:10.3334/ORNLDAAC/2346",
        "role": "Methane from wetlands in an ensemble of model set-ups; a model, not a measurement",
    },
    "gpw": {
        "id": "gpw",
        "name": "GPWv4.11 population count 2020, 15′",
        "provider": "NASA SEDAC (CIESIN)",
        "role": "People living in the cell",
    },
}
