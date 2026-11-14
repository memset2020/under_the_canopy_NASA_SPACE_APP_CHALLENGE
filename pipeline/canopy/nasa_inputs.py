"""Fetch and load the docs/12 NASA layers for a real site (tasks N-01…N-07).

`fetch_*` functions are the network step (run by `cli.py fetch --nasa`); each writes a
small file already on the site's web grid under raw/<site>/nasa/. `load_*` functions
are offline and used by real.build_scene. Formats and variable names below were read
from real granules; anything still assumed is marked TODO(verify).
"""

from __future__ import annotations

import csv
import re
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np

from . import geo, io_gcov
from . import nasa_access as na
from .scene import Context, LevelChange, OpticalObs

MATCH_DAYS = 6

# OPERA DSWx-HLS WTR classes (values seen over Sylhet; meanings from the product
# colour table): 0 not water, 1 open water, 2 partial surface water, 252 snow/ice
# (TODO(verify): spurious over bright cloud edges), 253 cloud/shadow, 255 fill.
HLS_WATER = (1, 2)
HLS_CLEAR = (0, 1, 2)

GEDI_RASTERS = "GEDI_HighQuality_Shots_Rasters_2339"
GEDI_COVER = "cover-a0_vf_20190417_20230316_1000m"
GEDI_HEIGHT = "rh-95-a0_vf_20190417_20230316_1000m"

# InSAR: 12-day HH coherence above this keeps the double-bounce phase usable (docs/12 §3).
COHERENCE_MIN = 0.35
COHERENCE_STABLE = 0.5


def _day_from(text: str, pattern: str = r"(\d{8})T\d{6}") -> date | None:
    m = re.search(pattern, text)
    return datetime.strptime(m[1], "%Y%m%d").date() if m else None


def _save(path: Path, **arrays) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, **arrays)
    return path


# ---------------------------------------------------------------- N-01 optical (HLS)
def fetch_optical(site, days, out: Path, height: int, width: int, log=print) -> list[Path]:
    """Per NISAR pass, the clearest OPERA DSWx-HLS acquisition within ±6 days (mosaicked
    over tiles). Choosing the clearest is optical's best case, like C-band (docs/10 D-012)."""
    bounds = tuple(site["bbox"])
    first, last = min(days) - timedelta(days=MATCH_DAYS), max(days) + timedelta(days=MATCH_DAYS)
    granules = na.search("OPERA_L3_DSWX-HLS_V1", bounds, (first.isoformat(), last.isoformat()))
    by_day: dict[date, list[str]] = {}
    for g in granules:
        for u in g.data_links():
            if u.endswith("_B01_WTR.tif") and (
                d := _day_from(u.rsplit("/", 1)[-1], r"_(\d{8})T\d{6}Z")
            ):
                by_day.setdefault(d, []).append(u)
    saved = []
    for day in days:
        kept = out / f"dswx_hls_{day.isoformat()}.npz"
        if kept.is_file():  # an archived acquisition does not change: keep what was fetched
            saved.append(kept)
            log(f"  optical {day}: kept {kept.name}")
            continue
        best = None
        for d in sorted(by_day, key=lambda x: abs((x - day).days)):
            if abs((d - day).days) > MATCH_DAYS:
                continue
            wtr = np.full((height, width), 255.0)
            for u in by_day[d]:
                layer = na.cog_to_grid(u, bounds, height, width, how="nearest", fill=255)
                take = (wtr == 255) & np.isfinite(layer) & (layer != 255)
                wtr[take] = layer[take]
            clear = np.isin(wtr, HLS_CLEAR).mean()
            if best is None or clear > best[1]:
                best = (d, clear, wtr.astype(np.uint8))
        if best:
            saved.append(
                _save(out / f"dswx_hls_{day.isoformat()}.npz", day=best[0].isoformat(), wtr=best[2])
            )
            log(f"  optical {day}: DSWx-HLS {best[0]} clear {best[1]:.0%}")
        else:
            log(f"  optical {day}: no DSWx-HLS within ±{MATCH_DAYS} days")
    return saved


PHOTO_CANDIDATES = 6
PHOTO_MIN_COVER = 0.9


def fetch_photo(site, peak_day: date, out: Path, height: int, width: int, log=print) -> Path | None:
    """True-colour HLS frame nearest the peak pass (whatever its clouds: that is the point)."""
    bounds = tuple(site["bbox"])
    window = (
        (peak_day - timedelta(days=8)).isoformat(),
        (peak_day + timedelta(days=8)).isoformat(),
    )
    cands = []
    for sn in ("HLSS30", "HLSL30"):
        cands += [(g, None) for g in na.search(sn, bounds, window, count=50)]
    if not cands:
        log("  photo: no HLS scene within ±8 days of the peak")
        return None

    dated = []
    for g, _ in cands:
        m = re.search(r"\.(\d{4})(\d{3})T", g["umm"]["GranuleUR"])
        if m is not None:
            d = date(int(m[1]), 1, 1) + timedelta(days=int(m[2]) - 1)
            dated.append((abs((d - peak_day).days), d, g))
    dated.sort(key=lambda x: x[0])

    # HLS tiles are MGRS squares: the nearest scene can cover only a sliver of the site.
    # Take the nearest scene that covers most of it, else the best-covered of the nearest few.
    best = None
    for _, d, g in dated[:PHOTO_CANDIDATES]:
        links = {u.rsplit(".", 2)[-2]: u for u in g.data_links() if u.endswith(".tif")}
        if not {"B04", "B03", "B02"} <= links.keys():
            continue
        rgb = np.stack(
            [
                na.cog_to_grid(links[b], bounds, height, width, how="mean")
                for b in ("B04", "B03", "B02")
            ],
            -1,
        )
        cover = float(np.isfinite(rgb).all(axis=2).mean())
        if best is None or cover > best[0]:
            best = (cover, d, g, links, rgb)
        if cover >= PHOTO_MIN_COVER:
            break
    if best is None:
        return None
    cover, d, g, links, rgb = best
    fmask = (
        na.cog_to_grid(links["Fmask"], bounds, height, width, how="nearest")
        if "Fmask" in links
        else None
    )
    log(f"  photo: {g['umm']['GranuleUR']} ({d}), covers {cover:.0%} of the site")
    return _save(
        out / "hls_photo.npz",
        day=d.isoformat(),
        rgb=rgb.astype(np.float32),
        fmask=np.nan_to_num(fmask, nan=255).astype(np.uint8) if fmask is not None else np.zeros(0),
    )


def load_optical(raw: Path, days) -> list[OpticalObs | None]:
    out = []
    for day in days:
        f = raw / "nasa" / f"dswx_hls_{day.isoformat()}.npz"
        if not f.is_file():
            out.append(None)
            continue
        z = np.load(f)
        wtr = z["wtr"]
        out.append(
            OpticalObs(
                day=date.fromisoformat(str(z["day"])),
                water=np.isin(wtr, HLS_WATER),
                clear=np.isin(wtr, HLS_CLEAR),
            )
        )
    return out


def load_photo(raw: Path):
    """(rgba uint8, date, cloud fraction) from the HLS frame, or None.

    Pixels outside the scene are transparent, and cloud is a share of the pixels the
    scene actually covers (Fmask 255 is fill, not 'clear').
    """
    f = raw / "nasa" / "hls_photo.npz"
    if not f.is_file():
        return None
    z = np.load(f)
    rgb = z["rgb"].astype(float)
    valid = np.isfinite(rgb).all(axis=2)
    refl = np.clip(np.nan_to_num(rgb * 1e-4, nan=0.0), 0, None)  # HLS scale; fill < 0
    img = np.clip((refl / 0.25) ** (1 / 2.2), 0, 1) * 255  # simple display stretch
    rgba = np.dstack([img, np.where(valid, 255, 0)]).astype(np.uint8)
    if z["fmask"].size:
        fm = z["fmask"].astype(int)
        seen = valid & (fm != 255)
        # TODO(verify): Fmask bits 1 cloud, 3 shadow
        cloudy = (((fm >> 1) & 1) | ((fm >> 3) & 1)).astype(bool)
    else:
        seen = valid
        cloudy = refl[..., 2] > 0.2
    cloud = float(cloudy[seen].mean()) if seen.any() else None
    return rgba, date.fromisoformat(str(z["day"])), cloud


# ---------------------------------------------------------------- N-02 rainfall (GPM IMERG)
IMERG_OPENDAP = "https://gpm1.gesdisc.eosdis.nasa.gov/opendap/GPM_L3/"
IMERG_DATA = "https://data.gesdisc.earthdata.nasa.gov/data/GPM_L3/"


def _imerg_cells(lo: float, hi: float, origin: float) -> tuple[int, int]:
    """Index range of 0.1° IMERG cells (centres at origin + 0.1 i) covering [lo, hi]."""
    return int(round((lo - origin) / 0.1)), int(round((hi - origin) / 0.1))


def fetch_rain(site, start: date, end: date, out: Path, log=print, workers: int = 3) -> Path | None:
    """Daily IMERG Late rain (mm/day) over the site via OPeNDAP subsetting (verified).

    Opening each 31 MB global file remotely is too slow; OPeNDAP returns just our cells.
    Needs the GES DISC application approved in the Earthdata profile (HTTP 401/403 otherwise).
    """
    from concurrent.futures import ThreadPoolExecutor

    w, s, e, n = site["bbox"]
    i0, i1 = _imerg_cells(w, e, -179.95)
    j0, j1 = _imerg_cells(s, n, -89.95)
    na.login()
    session = na._earthaccess().get_requests_https_session()
    urls = []
    for g in na.search(
        "GPM_3IMERGDL", site["bbox"], (start.isoformat(), end.isoformat()), count=400
    ):
        u = next(u for u in g.data_links() if u.endswith(".nc4"))
        urls.append(
            u.replace(IMERG_DATA, IMERG_OPENDAP) + f".ascii?precipitation[0][{i0}:{i1}][{j0}:{j1}]"
        )

    def one(url: str):
        import time

        for attempt in range(6):  # GES DISC throttles: back off on 429/503
            res = session.get(url, timeout=120)
            if res.status_code not in (429, 502, 503, 504):
                break
            time.sleep(3 * 2**attempt)
        if res.status_code in (401, 403):
            raise SystemExit(
                "GES DISC refused the request. Approve the 'NASA GESDISC DATA ARCHIVE' application "
                "in your Earthdata profile (Applications → Authorized Apps), then rerun."
            )
        res.raise_for_status()
        vals = [
            float(v)
            for line in res.text.splitlines()
            if line.startswith("precipitation.precipitation[")
            for v in line.split(",")[1:]
        ]
        vals = [v for v in vals if v >= 0]
        d = _day_from(url.rsplit("/", 1)[-1], r"\.(\d{8})-S")
        return (d, float(np.mean(vals))) if vals and d else None

    with ThreadPoolExecutor(max_workers=workers) as pool:
        rows = sorted(r for r in pool.map(one, urls) if r)
    _write_series(out, rows, "rain_mm")
    log(f"  rain: {len(rows)} days of GPM IMERG Late (OPeNDAP)")
    return out


# ---------------------------------------------------------------- N-03 canopy (GEDI)
def fetch_canopy(site, out: Path, height: int, width: int, log=print) -> Path:
    na.login()
    links = [
        u
        for g in na._earthaccess().search_data(short_name=GEDI_RASTERS, count=500)
        for u in g.data_links()
    ]
    pick = lambda key: next(u for u in links if key in u and u.endswith(".tif"))  # noqa: E731
    bounds = tuple(site["bbox"])
    cover = na.cog_to_grid(pick(GEDI_COVER), bounds, height, width, how="nearest")
    rh95 = na.cog_to_grid(pick(GEDI_HEIGHT), bounds, height, width, how="nearest")
    cover[(cover < 0) | (cover > 1)] = np.nan
    rh95[(rh95 < 0) | (rh95 > 80)] = np.nan
    log(f"  canopy: GEDI 1 km grids, {np.isfinite(cover).mean():.0%} of cells with shots")
    return _save(out / "gedi.npz", cover_pct=cover * 100, height_m=rh95)


def load_canopy(raw: Path):
    f = raw / "nasa" / "gedi.npz"
    if not f.is_file():
        return None, None
    z = np.load(f)
    return z["cover_pct"], z["height_m"]


# ---------------------------------------------------------------- N-04 terrain (NASADEM)
def fetch_dem(site, out: Path, height: int, width: int, cache: Path, log=print) -> Path:
    import rasterio

    ea = na._earthaccess()
    na.login()
    granules = ea.search_data(short_name="NASADEM_HGT", bounding_box=tuple(site["bbox"]))
    cache.mkdir(parents=True, exist_ok=True)
    files = ea.download(granules, local_path=str(cache))
    acc = geo.Accumulator(height, width, 1)
    bounds = tuple(site["bbox"])
    for z in files:
        z = Path(z)
        inner = z.stem.split("_")[-1] + ".hgt"  # NASADEM_HGT_n24e091.zip → n24e091.hgt
        with rasterio.open(f"zip://{z}!/{inner}") as src:
            from rasterio.windows import from_bounds

            # A site can span two 1° tiles: clip to this tile, skip if it doesn't overlap.
            tb = src.bounds
            box = (
                max(bounds[0], tb.left),
                max(bounds[1], tb.bottom),
                min(bounds[2], tb.right),
                min(bounds[3], tb.top),
            )
            if box[0] >= box[2] or box[1] >= box[3]:
                continue
            win = from_bounds(*box, transform=src.transform).round_offsets().round_lengths()
            d = src.read(1, window=win).astype(float)
            d[d <= -32767] = np.nan
            tr = src.window_transform(win)
        r, c = np.indices(d.shape)
        lon = tr.c + (c + 0.5) * tr.a
        lat = tr.f + (r + 0.5) * tr.e
        acc.add(geo.target_index(lon, lat, bounds, height, width), [d])
    dem = acc.mean(0)
    log(
        f"  dem: NASADEM, {np.isfinite(dem).mean():.0%} of cells, "
        f"{np.nanmin(dem):.0f}–{np.nanmax(dem):.0f} m"
    )
    return _save(out / "nasadem.npz", dem=dem)


def terrain_gate(
    dem: np.ndarray,
    open_water: np.ndarray,
    pixel_m: float,
    relief_m: float,
    radius_m: float = 2000.0,
) -> np.ndarray:
    """High ground: more than `relief_m` above the local open-water surface.

    The local water surface is the median NASADEM elevation of open-water pixels within
    `radius_m` (NASADEM is a 2000 surface model, so it measures water and canopy tops,
    not the ground under trees; the margin absorbs typical canopy heights).
    """
    water_level = np.full(dem.shape, np.nan)
    ow = open_water & np.isfinite(dem)
    if not ow.any():
        return np.zeros(dem.shape, dtype=bool)
    # Coarse median filter via blocks keeps this vectorised.
    k = max(int(radius_m / pixel_m), 1)
    h, w = dem.shape
    for r0 in range(0, h, k):
        for c0 in range(0, w, k):
            rs, cs = slice(max(r0 - k, 0), r0 + 2 * k), slice(max(c0 - k, 0), c0 + 2 * k)
            vals = dem[rs, cs][ow[rs, cs]]
            if vals.size >= 10:
                water_level[r0 : r0 + k, c0 : c0 + k] = np.median(vals)
    if np.isnan(water_level).all():
        water_level[:] = np.nanmedian(dem[ow])
    water_level = np.where(np.isnan(water_level), np.nanmedian(water_level), water_level)
    return np.isfinite(dem) & (dem - water_level > relief_m)


# ---------------------------------------------------------------- N-05 SWOT
def fetch_swot(site, start: date, end: date, out: Path, log=print) -> Path | None:
    """Site-median SWOT water surface elevation (above geoid) per overpass, good water only."""
    w, s, e, n = site["bbox"]
    zone = geo.utm_epsg_for((w + e) / 2, (s + n) / 2) % 100
    per_day: dict = {}
    seen: set[str] = set()
    for g in na.search(
        "SWOT_L2_HR_Raster_100m_D", site["bbox"], (start.isoformat(), end.isoformat()), count=400
    ):
        name = g["umm"]["GranuleUR"]
        m = re.search(r"_UTM(\d{2})", name)
        if m and int(m[1]) != zone:
            continue  # CMR footprint match is loose; keep only our UTM zone
        url = next((u for u in g.data_links() if u.endswith(".nc")), None)
        if not url:
            continue
        f = na.open_h5(url)
        lat, lon = f["latitude"][()], f["longitude"][()]
        inside = (lat >= s) & (lat <= n) & (lon >= w) & (lon <= e)
        if not inside.any():
            continue
        wse = f["wse"][()].astype(float)
        frac = f["water_frac"][()].astype(float)
        qual = f["wse_qual"][()]
        good = inside & (qual <= 1) & (frac > 0.5) & (wse < 1e30)  # 0 good, 1 suspect
        if good.sum() < 5:
            continue
        if name in seen:
            continue  # the same granule can be listed twice
        seen.add(name)
        day = _day_from(name)
        per_day.setdefault(day, []).append((float(np.median(wse[good])), int(good.sum())))
        log(f"  swot {day}: {good.sum()} water pixels, median WSE {per_day[day][-1][0]:.2f} m")
    # Adjacent tiles of one overpass: one value per date, weighted by water pixels.
    rows = sorted(
        (d, sum(v * k for v, k in vals) / sum(k for _, k in vals)) for d, vals in per_day.items()
    )
    if rows:
        _write_series(out, rows, "wse_m")
    return out if rows else None


# ---------------------------------------------------------------- N-06 CYGNSS
def fetch_cygnss(site, start: date, end: date, out: Path, log=print) -> Path | None:
    """Daily water share of the site from the UC Berkeley CYGNSS 0.01° water mask."""
    w, s, e, n = site["bbox"]
    rows = []
    for g in na.search(
        "CYGNSS_L3_UC_BERKELEY_WATERMASK_DAILY_V3.2",
        site["bbox"],
        (start.isoformat(), end.isoformat()),
        count=400,
    ):
        url = next(u for u in g.data_links() if u.endswith(".nc"))
        f = na.open_h5(url)
        lat, lon = f["lat"][()], f["lon"][()]
        li = np.flatnonzero((lat >= s) & (lat <= n))
        lo = np.flatnonzero((lon >= w) & (lon <= e))
        if not li.size or not lo.size:
            continue
        m = f["watermask"][li[0] : li[-1] + 1, lo[0] : lo[-1] + 1].astype(float)
        m[m < 0] = np.nan  # −99 fill
        if np.isfinite(m).sum() == 0:
            continue
        stamp = re.search(r"(\d{4}-\d{2}-\d{2})", url.rsplit("/", 1)[-1])
        if stamp is None:
            continue
        valid = np.isfinite(m)  # missing cells are unknown, not dry
        rows.append((date.fromisoformat(stamp[1]), float((m[valid] > 0).mean())))
    rows.sort()
    if rows:
        _write_series(out, rows, "water_share")
        log(f"  cygnss: {len(rows)} days")
    return out if rows else None


# ---------------------------------------------------------------- N-08 NISAR soil moisture
def fetch_soil(site, start: date, end: date, out: Path, log=print) -> Path | None:
    bounds = tuple(site["bbox"])
    base = "/science/LSAR/SME2/grids/algorithmCandidates/DSG/"
    rows = []
    for g in na.search(
        "NISAR_L3_SME2_PROVISIONAL_V1", bounds, (start.isoformat(), end.isoformat()), count=200
    ):
        url = next(u for u in g.data_links() if u.endswith(".h5") and "QA_STATS" not in u)
        f = na.open_h5(url)
        x, y = f[base + "xCoordinates"][()], f[base + "yCoordinates"][()]
        epsg = int(np.asarray(f[base + "projection"][()]).ravel()[0])
        xmin, ymin, xmax, ymax = geo.bounds_in_crs(bounds, epsg)
        cs, rs = io_gcov._slice_for(x, xmin, xmax), io_gcov._slice_for(y, ymin, ymax)
        if cs.stop - cs.start == 0 or rs.stop - rs.start == 0:
            continue
        sm = f[base + "soilMoisture"][rs, cs].astype(float)
        sm[(sm < 0) | (sm > 1)] = np.nan
        if np.isfinite(sm).sum() < 5:
            continue
        rows.append((_day_from(g["umm"]["GranuleUR"]), float(np.nanmedian(sm))))
    rows.sort()
    if rows:
        _write_series(out, rows, "soil_m3m3")
        log(f"  soil moisture: {len(rows)} NISAR SME2 retrievals")
    return out if rows else None


# ---------------------------------------------------------------- N-07 NISAR GUNW
def fetch_gunw(
    site, group: tuple, days, out_dir: Path, height: int, width: int, log=print
) -> list[Path]:
    """Phase, coherence and incidence on the web grid for consecutive passes of our GCOV group."""
    track, direction = group[0], group[1]
    bounds = tuple(site["bbox"])
    dayset = set(days)
    first, last = min(days), max(days)
    saved = []
    tag = f"_{track:03d}_{direction[0].upper()}_"
    for g in na.search(
        "NISAR_L2_GUNW_PROVISIONAL_V1",
        bounds,
        (first.isoformat(), (last + timedelta(days=1)).isoformat()),
        count=200,
    ):
        name = g["umm"]["GranuleUR"]
        stamps = re.findall(r"_(\d{8})T\d{6}", name)
        if tag not in name or len(stamps) < 3:
            continue
        d1, d2 = (
            datetime.strptime(stamps[0], "%Y%m%d").date(),
            datetime.strptime(stamps[2], "%Y%m%d").date(),
        )
        if d1 not in dayset or d2 not in dayset:
            continue
        target = out_dir / f"gunw_{d1.isoformat()}_{d2.isoformat()}.npz"
        if target.is_file():
            saved.append(target)
            continue
        f = na.open_h5(next(u for u in g.data_links() if u.endswith(".h5")))
        b = "/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/"
        x, y = f[b + "xCoordinates"][()], f[b + "yCoordinates"][()]
        epsg = int(np.asarray(f[b + "projection"][()]).ravel()[0])
        xmin, ymin, xmax, ymax = geo.bounds_in_crs(bounds, epsg)
        cs, rs = io_gcov._slice_for(x, xmin, xmax), io_gcov._slice_for(y, ymin, ymax)
        ph = f[b + "HH/unwrappedPhase"][rs, cs].astype(float)
        iono = f[b + "HH/ionospherePhaseScreen"][rs, cs].astype(float)
        coh = f[b + "HH/coherenceMagnitude"][rs, cs].astype(float)
        cc = f[b + "HH/connectedComponents"][rs, cs]
        ph = np.where((cc > 0) & (cc != 65535), ph - np.nan_to_num(iono), np.nan)
        lam = 299_792_458.0 / float(f["/science/LSAR/GUNW/grids/frequencyA/centerFrequency"][()])
        inc = _incidence(f, bounds)
        xx, yy = np.meshgrid(x[cs], y[rs])
        lon, lat = geo.utm_to_lonlat(xx, yy, epsg)
        idx = geo.target_index(lon, lat, bounds, height, width)
        acc = geo.Accumulator(height, width, 2)
        # Average phase only within one connected component, else 2π jumps would mix.
        main = cc[(cc > 0) & (cc != 65535)]
        if main.size:
            vals, counts = np.unique(main, return_counts=True)
            ph = np.where(cc == vals[np.argmax(counts)], ph, np.nan)
        acc.add(idx, [ph, coh])
        saved.append(
            _save(
                target,
                start=d1.isoformat(),
                end=d2.isoformat(),
                phase=acc.mean(0),
                coherence=acc.mean(1),
                wavelength_m=lam,
                incidence_deg=inc,
            )
        )
        log(f"  gunw {d1}→{d2}: coherence median {np.nanmedian(coh):.2f}, incidence {inc:.1f}°")
    return saved


def _incidence(f, bounds) -> float:
    try:
        m = "/science/LSAR/GUNW/metadata/radarGrid/"
        cube = f[m + "incidenceAngle"]
        x, y = f[m + "xCoordinates"][()], f[m + "yCoordinates"][()]
        epsg = int(
            np.asarray(
                f["/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/projection"][()]
            ).ravel()[0]
        )
        cx, cy = geo.to_crs((bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2, epsg)
        i, j = int(np.argmin(np.abs(y - cy))), int(np.argmin(np.abs(x - cx)))
        return float(cube[cube.shape[0] // 2, i, j])
    except (KeyError, ValueError):
        return 37.0  # TODO(verify): mid-swath nominal when the cube is missing


def load_gunw(raw: Path) -> list[LevelChange]:
    out = []
    for f in sorted((raw / "nasa").glob("gunw_*.npz")):
        z = np.load(f)
        out.append(
            LevelChange(
                start=date.fromisoformat(str(z["start"])),
                end=date.fromisoformat(str(z["end"])),
                dh_cm=None,
                phase_rad=z["phase"],
                coherence=z["coherence"],
                wavelength_m=float(z["wavelength_m"]),
                incidence_deg=float(z["incidence_deg"]),
                coherent_share=0.0,
            )
        )
    return out


# ---------------------------------------------------------------- shared series files
def _write_series(path: Path, rows, column: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh)
        wr.writerow(["date", column])
        for d, v in rows:
            wr.writerow([d.isoformat(), f"{v:.5f}"])


def load_series(path: Path) -> list[tuple[date, float]]:
    if not path.is_file():
        return []
    with path.open(encoding="utf-8") as fh:
        rows = list(csv.reader(fh))[1:]
    return [(date.fromisoformat(d), float(v)) for d, v in rows if v not in ("", "nan")]


def load_context(raw: Path) -> Context:
    n = raw / "nasa"
    return Context(
        rain_daily=load_series(n / "imerg_daily.csv"),
        rain_source="NASA GPM IMERG Late (daily, 0.1°)"
        if (n / "imerg_daily.csv").is_file()
        else None,
        inundation_daily=load_series(n / "cygnss_daily.csv"),
        inundation_source="NASA CYGNSS UC Berkeley water mask v3.2 (daily, 0.01°)"
        if (n / "cygnss_daily.csv").is_file()
        else None,
        soil_moisture=load_series(n / "soil_moisture.csv"),
        soil_moisture_source="NISAR L3 SME2 soil moisture"
        if (n / "soil_moisture.csv").is_file()
        else None,
        water_storage_monthly=load_series(n / "grace_tws.csv"),
        water_storage_source="NASA/JPL GRACE and GRACE-FO mascons RL06.3 (monthly)"
        if (n / "grace_tws.csv").is_file()
        else None,
    )


def load_swot(raw: Path, site_name: str) -> list[dict]:
    series = load_series(raw / "nasa" / "swot_wse.csv")
    if not series:
        return []
    return [
        {
            "id": "SWOT-site",
            "name": f"SWOT water surface, {site_name}",
            "kind": "lake",
            "series": series,
        }
    ]


# ---------------------------------------------------------------- N-09 LBA-ECO reference
# LC-07 class = low-water digit × 10 + high-water digit (ORNL guide Table 1). High water:
# 1 open water; 3/5/7/9 flooded herbaceous/shrub/woodland/forest; 4/6/8 non-flooded.
LC07 = "LC07_Amazon_Wetlands_1284"


def lc07_high_water(codes: np.ndarray) -> np.ndarray:
    """Contract classes at high water: 0 unknown, 1 dry, 2 open water, 3 flooded vegetation."""
    out = np.zeros(codes.shape, dtype=np.uint8)
    c = np.nan_to_num(codes, nan=0).astype(int)
    hi = c % 10
    wet = (c >= 11) & (c <= 99)
    out[c == 1] = 1  # non-wetland
    out[wet & (hi == 1)] = 2
    out[wet & np.isin(hi, (3, 5, 7, 9))] = 3
    out[wet & np.isin(hi, (4, 6, 8))] = 1
    return out


def fetch_lc07(site, out: Path, height: int, width: int, log=print) -> Path | None:
    bounds = tuple(site["bbox"])
    granules = na.search(LC07, bounds, count=5)
    urls = [u for g in granules for u in g.data_links() if u.endswith("_3arcsec.tif")]
    if not urls:
        log("  lc07: site outside the Amazon wetland map")
        return None
    codes = na.cog_to_grid(urls[0], bounds, height, width, how="nearest", fill=0)
    log(f"  lc07: {np.isin(codes, [0, 200, 255]).mean():.0%} of cells outside the mapped basin")
    return _save(out / "lc07.npz", codes=np.nan_to_num(codes).astype(np.uint8))


def load_reference(raw: Path):
    f = raw / "nasa" / "lc07.npz"
    if not f.is_file():
        return None
    return lc07_high_water(np.load(f)["codes"])


# ---------------------------------------------------------------- N-10 OPERA RTC-S1
def fetch_rtc(site, days, out: Path, height: int, width: int, log=print) -> list[Path]:
    """C-band VV/VH (linear γ⁰ → dB) nearest each pass within ±6 days, mosaicked over bursts.

    Needs the ASF OPERA licence accepted in the Earthdata profile (HTTP 403 'EULA' otherwise).
    """
    bounds = tuple(site["bbox"])
    first, last = min(days) - timedelta(days=MATCH_DAYS), max(days) + timedelta(days=MATCH_DAYS)
    by_day: dict[date, list] = {}
    for g in na.search("OPERA_L2_RTC-S1_V1", bounds, (first.isoformat(), last.isoformat())):
        d = _day_from(g["umm"]["GranuleUR"], r"_(\d{8})T\d{6}Z")
        if d:
            by_day.setdefault(d, []).append(g)
    saved = []
    for day in days:
        near = [d for d in by_day if abs((d - day).days) <= MATCH_DAYS]
        if not near:
            continue
        d = min(near, key=lambda x: abs((x - day).days))
        vv = np.full((height, width), np.nan)
        vh = np.full((height, width), np.nan)
        for g in by_day[d]:
            links = g.data_links()
            for pol, arr in (("_VV.tif", vv), ("_VH.tif", vh)):
                u = next((x for x in links if x.endswith(pol)), None)
                if u is None:
                    continue
                try:
                    layer = na.cog_to_grid(u, bounds, height, width, how="mean")
                except Exception as exc:  # noqa: BLE001
                    if "403" in str(exc):
                        raise SystemExit(
                            "ASF refused OPERA RTC-S1 (EULA not accepted). Accept it at "
                            "https://urs.earthdata.nasa.gov/approve_app?client_id=BO_n7nTIlMljdvU6kRRB3g"
                        ) from exc
                    raise
                take = np.isnan(arr) & np.isfinite(layer) & (layer > 0)
                arr[take] = 10 * np.log10(layer[take])
        if np.isfinite(vv).any():
            saved.append(_save(out / f"rtc_{day.isoformat()}.npz", day=d.isoformat(), vv=vv, vh=vh))
            log(f"  rtc {day}: RTC-S1 {d}, {np.isfinite(vv).mean():.0%} covered")
    return saved


def load_rtc(raw: Path, days):
    files = {f.stem.split("_", 1)[1]: f for f in (raw / "nasa").glob("rtc_*.npz")}
    if not files:
        return None, None, None
    shape = np.load(next(iter(files.values())))["vv"].shape
    vv = np.full((len(days), *shape), np.nan)
    vh = np.full((len(days), *shape), np.nan)
    when: list[date | None] = []
    for i, day in enumerate(days):
        f = files.get(day.isoformat())
        if f is None:
            when.append(None)
            continue
        z = np.load(f)
        vv[i], vh[i] = z["vv"], z["vh"]
        when.append(date.fromisoformat(str(z["day"])))
    return vv, vh, when


# ---------------------------------------------------------------- N-11 SEDAC GRDI
GRDI = "CIESIN_SEDAC_PMP_GRDI_2010_2020"


def fetch_grdi(site, out: Path, height: int, width: int, cache: Path, log=print) -> Path | None:
    import zipfile

    ea = na._earthaccess()
    na.login()
    granules = [
        g
        for g in ea.search_data(short_name=GRDI, count=20)
        if g["umm"]["GranuleUR"] == "povmap-grdi-v1-grdiv1-geotiff.zip"
    ]
    if not granules:
        log("  grdi: granule not found")
        return None
    cache.mkdir(parents=True, exist_ok=True)
    zpath = Path(ea.download(granules, local_path=str(cache))[0])
    with zipfile.ZipFile(zpath) as z:
        tif = next(n for n in z.namelist() if n.lower().endswith(".tif"))
    grid = na.cog_to_grid(
        f"zip://{zpath}!/{tif}", tuple(site["bbox"]), height, width, how="nearest"
    )
    grid[(grid < 0) | (grid > 100)] = np.nan
    log(f"  grdi: {np.isfinite(grid).mean():.0%} of cells, median {np.nanmedian(grid):.0f}")
    return _save(out / "grdi.npz", grdi=grid)


def load_grdi(raw: Path):
    f = raw / "nasa" / "grdi.npz"
    return np.load(f)["grdi"] if f.is_file() else None


# ---------------------------------------------------------------- N-14 JRC Global Surface Water
# Open data (EC JRC / Google, Pekel et al. 2016): how often each 30 m pixel was water in
# 1984–2021. It separates the usual river and lakes from this season's flood.
JRC_URL = (
    "https://storage.googleapis.com/global-surface-water/downloads2021/occurrence/"
    "occurrence_{lon}_{lat}v1_4_2021.tif"
)


def _jrc_tiles(bbox) -> list[str]:
    """10° tiles named by their west and north edges, every one the box touches."""
    w, s, e, n = bbox
    urls = []
    for lon0 in range(int(np.floor(w / 10)) * 10, int(np.floor(e / 10)) * 10 + 1, 10):
        for top in range(int(np.floor(s / 10)) * 10 + 10, int(np.floor(n / 10)) * 10 + 11, 10):
            lon = f"{abs(lon0)}{'E' if lon0 >= 0 else 'W'}"
            lat = f"{abs(top)}{'N' if top >= 0 else 'S'}"
            urls.append(JRC_URL.format(lon=lon, lat=lat))
    return sorted(set(urls))


def fetch_jrc(site, out: Path, height: int, width: int, log=print) -> Path | None:
    """Water occurrence (%) on the site grid; NaN where JRC has no data."""
    grids = []
    for url in _jrc_tiles(site["bbox"]):
        try:
            g = na.cog_to_grid("/vsicurl/" + url, site["bbox"], height, width, how="mean")
        except Exception as exc:  # noqa: BLE001 - a missing tile is ocean or outside coverage
            log(f"  jrc: {url.rsplit('/', 1)[-1]} unavailable ({type(exc).__name__})")
            continue
        g[g > 100] = np.nan  # 255 = no data
        grids.append(g)
    if not grids:
        return None
    occ = np.fmax.reduce(grids) if len(grids) > 1 else grids[0]
    log(f"  jrc: occurrence ≥ 75 % (usual water) on {float(np.nanmean(occ >= 75)):.0%} of the site")
    return _save(out / "jrc_occurrence.npz", occurrence=occ.astype(np.float32))


def load_jrc(raw: Path) -> np.ndarray | None:
    f = raw / "nasa" / "jrc_occurrence.npz"
    return np.load(f)["occurrence"] if f.is_file() else None


# ---------------------------------------------------------------- HAND (ASF GLO-30, v11)
# Height Above Nearest Drainage from ASF (a NASA DAAC), computed from the Copernicus GLO-30 DEM:
# public 1° COG tiles, CC0, named by their south-west corner.
HAND_URL = "https://glo-30-hand.s3.us-west-2.amazonaws.com/v1/2021/Copernicus_DSM_COG_10_{lat}_00_{lon}_00_HAND.tif"


def hand_tiles(bbox) -> list[str]:
    """URLs of the 1° HAND tiles covering a lon/lat box."""
    w, s, e, n = bbox
    out = []
    for lat in range(int(np.floor(s)), int(np.floor(n - 1e-9)) + 1):
        for lon in range(int(np.floor(w)), int(np.floor(e - 1e-9)) + 1):
            la = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
            lo = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
            out.append(HAND_URL.format(lat=la, lon=lo))
    return out


def fetch_hand(site, out: Path, height: int, width: int, log=print) -> Path | None:
    """Mean HAND (m) on the site grid; NaN where no tile covers (ocean)."""
    grids = []
    for url in hand_tiles(site["bbox"]):
        try:
            g = na.cog_to_grid("/vsicurl/" + url, site["bbox"], height, width, how="mean")
        except Exception as exc:  # noqa: BLE001 - a missing tile is open ocean
            log(f"  hand: {url.rsplit('/', 1)[-1]} unavailable ({type(exc).__name__})")
            continue
        g[(g < 0) | (g > 2000)] = np.nan
        grids.append(g)
    if not grids:
        return None
    hand = np.fmax.reduce(grids) if len(grids) > 1 else grids[0]
    low = float(np.nanmean(hand <= 5)) if np.isfinite(hand).any() else 0.0
    log(f"  hand: {low:.0%} of the site lies within 5 m of the nearest drainage")
    return _save(out / "hand.npz", hand_m=hand.astype(np.float32))


def load_hand(raw: Path) -> np.ndarray | None:
    f = raw / "nasa" / "hand.npz"
    return np.load(f)["hand_m"] if f.is_file() else None


# ---------------------------------------------------------------- GLWD v2 wetland classes (v11)
def fetch_glwd(site, out: Path, height: int, width: int, log=print) -> Path | None:
    """GLWD v2 dominant class on the site grid (nearest; 0 dryland, 1-33 wetland, 255 none)."""
    from .global_layers import GLWD_COG, GLWD_FORESTED

    try:
        g = na.cog_to_grid(
            "/vsicurl/" + GLWD_COG, site["bbox"], height, width, how="nearest", fill=255
        )
    except Exception as exc:  # noqa: BLE001 - the site builds without it
        log(f"  glwd: unavailable ({type(exc).__name__})")
        return None
    g = np.nan_to_num(g, nan=255).astype(np.uint8)
    log(f"  glwd: forested wetland on {float(np.isin(g, GLWD_FORESTED).mean()):.0%} of the site")
    return _save(out / "glwd.npz", glwd_class=g)


def load_glwd(raw: Path) -> np.ndarray | None:
    f = raw / "nasa" / "glwd.npz"
    return np.load(f)["glwd_class"] if f.is_file() else None


# ---------------------------------------------------------------- N-15 GRACE / GRACE-FO mascons
GRACE = "TELLUS_GRAC-GRFO_MASCON_CRI_GRID_RL06.3_V4"


def fetch_grace_global(cache: Path, log=print) -> Path | None:
    """The latest JPL mascon file (all months in one netCDF), downloaded once and shared."""
    cache.mkdir(parents=True, exist_ok=True)
    have = sorted(cache.glob("*.nc"))
    if have:
        return have[-1]
    ea = na._earthaccess()
    na.login()
    grans = [
        g
        for g in ea.search_data(short_name=GRACE, count=50)
        if any(u.endswith(".nc") for u in g.data_links())
    ]
    if not grans:
        log("  grace: no granule found")
        return None
    grans.sort(key=lambda g: g["umm"]["GranuleUR"])
    ea.download(grans[-1:], str(cache))
    have = sorted(cache.glob("*.nc"))
    return have[-1] if have else None


# Normal for a calendar month: its mean over these years (GRACE 2004–2016 + GRACE-FO 2019–2023).
# The file's own anomaly is against the 2004–2009 mean of ALL months, so the seasonal cycle
# (every Amazon June is high) would read as a "wet year"; we remove it (docs/10 D-061).
CLIMATE_YEARS = (2004, 2023)


def month_normals(dates: list[date], values: np.ndarray) -> dict[int, np.ndarray]:
    """Mean per calendar month over CLIMATE_YEARS (values: (T, ...) array)."""
    out = {}
    for m in range(1, 13):
        idx = [
            k
            for k, d in enumerate(dates)
            if d.month == m and CLIMATE_YEARS[0] <= d.year <= CLIMATE_YEARS[1]
        ]
        if idx:
            with np.errstate(invalid="ignore"):
                out[m] = np.nanmean(values[idx], axis=0)
    return out


def grace_series(nc: Path, lon: float, lat: float, since: date) -> list[tuple[date, float]]:
    """Monthly water storage at the mascon holding lon/lat, in cm of water above or below
    the normal for that calendar month (2004–2023)."""
    import h5py

    with h5py.File(nc, "r") as f:
        lats = f["lat"][()]
        lons = f["lon"][()]
        t = f["time"][()]
        i = int(np.abs(lats - lat).argmin())
        j = int(np.abs(lons - (lon % 360)).argmin())
        lwe = f["lwe_thickness"][:, i, j].astype(float)
    lwe[np.abs(lwe) > 1e4] = np.nan  # _FillValue -99999
    t0 = date(2002, 1, 1)  # file attrs: time in days since 2002-01-01T00:00:00Z
    dates = [t0 + timedelta(days=float(days)) for days in t]
    normal = month_normals(dates, lwe)
    rows = []
    for d, v in zip(dates, lwe, strict=True):
        if d >= since and np.isfinite(v) and d.month in normal:
            rows.append((d, float(v - normal[d.month])))
    return rows


def fetch_grace(site, out: Path, cache: Path, log=print) -> Path | None:
    nc = fetch_grace_global(cache, log)
    if nc is None:
        return None
    w, s, e, n = site["bbox"]
    rows = grace_series(nc, (w + e) / 2, (s + n) / 2, date(2024, 1, 1))
    if not rows:
        return None
    log(f"  grace: {len(rows)} months, latest {rows[-1][0]}: {rows[-1][1]:+.1f} cm")
    _write_series(out / "grace_tws.csv", rows, "tws_cm")
    return out / "grace_tws.csv"


# ---------------------------------------------------------------- N-16 ICESat-2 ATL13
ATL13 = "ATL13"
BEAMS = ("gt1l", "gt1r", "gt2l", "gt2r", "gt3l", "gt3r")


def fetch_icesat2(site, start: date, end: date, out: Path, log=print) -> Path | None:
    """Median inland water-surface height (m above the WGS84 ellipsoid... per ATL13's
    ht_water_surf, verify datum) inside the site box, one value per ICESat-2 pass."""
    w, s, e, n = site["bbox"]
    per_day: dict = {}
    for g in na.search(ATL13, site["bbox"], (start.isoformat(), end.isoformat()), count=100):
        url = next((u for u in g.data_links() if u.endswith(".h5")), None)
        if not url:
            continue
        try:
            f = na.open_h5(url)
        except Exception as exc:  # noqa: BLE001 - skip unreadable granules
            log(f"  icesat2: skip {g['umm']['GranuleUR']} ({type(exc).__name__})")
            continue
        heights = []
        for beam in BEAMS:
            if beam not in f or "ht_water_surf" not in f[beam]:
                continue
            lat = f[beam]["segment_lat"][()]
            lon = f[beam]["segment_lon"][()]
            ht = f[beam]["ht_water_surf"][()].astype(float)
            inside = (lat >= s) & (lat <= n) & (lon >= w) & (lon <= e) & (np.abs(ht) < 1e4)
            heights.extend(ht[inside].tolist())
        if len(heights) < 5:
            continue
        day = _day_from(g["umm"]["GranuleUR"], r"_(\d{8})\d{6}_")
        if day is None:
            continue
        per_day.setdefault(day, []).extend(heights)
        log(f"  icesat2 {day}: {len(heights)} water segments, median {np.median(heights):.2f} m")
    rows = sorted((d, float(np.median(v))) for d, v in per_day.items())
    if rows:
        _write_series(out, rows, "wse_m")
    return out if rows else None


def load_icesat2(raw: Path, site_name: str) -> list[dict]:
    series = load_series(raw / "nasa" / "icesat2_wse.csv")
    if not series:
        return []
    return [
        {
            "id": "ICESat2-site",
            "name": f"ICESat-2 ATL13 water surface, {site_name}",
            "kind": "lidar",
            "series": series,
        }
    ]
