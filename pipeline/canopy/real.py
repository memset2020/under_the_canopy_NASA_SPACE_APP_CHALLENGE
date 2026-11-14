"""Assemble a real-data Scene from files in pipeline/data/raw/<site>/ (tasks D-01..D-06).

Layout (written by `cli.py fetch`, or placed by hand):
    gcov/*.h5          NISAR L2 GCOV granules           (required)
    worldcover/*.tif   ESA WorldCover map tiles         (required: the vegetation gate)
    dswx/*WTR*.tif     OPERA DSWx-S1 WTR layers         (optional: C-band comparison)
    gauge.csv          date,stage_m                     (optional: F05)
    worldpop.tif       WorldPop people per pixel        (optional: F08, with osm.json)
    osm.json           Overpass cache                   (optional: F08)
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

import numpy as np

from . import gazetteer, geo, io_gauge, io_gcov, io_reference, nasa_inputs, osm, raster
from .config import CBAND_MATCH_DAYS, PIPELINE_DIR, RAW_DIR, VEG_OTHER, VEG_YES
from .scene import Exposure, Gauge, Scene

DEFAULT_GRID_PX = 256
# Ground this far above the local open-water surface cannot flood (docs/10 D-036).
TERRAIN_RELIEF_M = 12.0
# Share of canopy height by which SRTM/NASADEM overestimates the ground under forest.
# TODO(verify): literature puts the C-band phase centre at roughly half to most of the
# canopy height; 0.6 is a mid value until calibrated (docs/10 D-042).
SRTM_CANOPY_FRACTION = 0.6

SOURCES = {
    "nisar_gcov": {
        "id": "nisar_gcov",
        "name": "NISAR L2 GCOV (L-band, HH/HV)",
        "provider": "NASA/ISRO via ASF DAAC",
        "url": "https://nisar-docs.asf.alaska.edu/gcov/",
        "role": "L-band backscatter for every pass",
    },
    "dswx": {
        "id": "opera_dswx_s1",
        "name": "OPERA DSWx-S1",
        "provider": "NASA JPL OPERA (Copernicus Sentinel-1)",
        "url": "https://www.jpl.nasa.gov/go/opera",
        "role": "C-band water map for the comparison",
    },
    "worldcover": {
        "id": "esa_worldcover",
        "name": "ESA WorldCover 10 m",
        "provider": "ESA",
        "url": "https://esa-worldcover.org/",
        "role": "Where vegetation can hide water; built-up exclusion",
    },
    "gauge": {
        "id": "gauge",
        "name": "River gauge",
        "provider": "",
        "url": "",
        "role": "Independent check of flood timing",
    },
    "worldpop": {
        "id": "worldpop",
        "name": "WorldPop population",
        "provider": "WorldPop, University of Southampton",
        "url": "https://www.worldpop.org/",
        "role": "People living near the flood",
    },
    "hls": {
        "id": "nasa_hls",
        "name": "NASA HLS (Landsat 8/9 + Sentinel-2, 30 m)",
        "provider": "NASA LP DAAC",
        "url": "https://www.earthdata.nasa.gov/data/projects/hls",
        "role": "The optical photo in the reveal",
    },
    "dswx_hls": {
        "id": "opera_dswx_hls",
        "name": "OPERA DSWx-HLS",
        "provider": "NASA JPL OPERA via PO.DAAC",
        "url": "https://www.jpl.nasa.gov/go/opera",
        "role": "What optical satellites saw as water (cloud-free pixels only)",
    },
    "gedi": {
        "id": "nasa_gedi",
        "name": "NASA GEDI canopy cover and height (gridded high-quality shots, 1 km)",
        "provider": "NASA ORNL DAAC",
        "url": "https://gedi.umd.edu/",
        "role": "How dense and tall the canopy is where L-band sees water",
    },
    "nasadem": {
        "id": "nasadem",
        "name": "NASADEM 30 m",
        "provider": "NASA LP DAAC",
        "url": "https://www.earthdata.nasa.gov/data/catalog/lpcloud-nasadem-hgt-001",
        "role": "Terrain gate: no hidden-flood claim on high ground",
    },
    "imerg": {
        "id": "gpm_imerg",
        "name": "NASA GPM IMERG Late (daily)",
        "provider": "NASA GES DISC",
        "url": "https://gpm.nasa.gov/data/imerg",
        "role": "Daily rainfall over the site",
    },
    "cygnss": {
        "id": "cygnss",
        "name": "NASA CYGNSS water mask (UC Berkeley v3.2, daily)",
        "provider": "NASA PO.DAAC",
        "url": "https://podaac.jpl.nasa.gov/CYGNSS",
        "role": "Independent daily L-band (GNSS reflection) check of inundation",
    },
    "geoglows": {
        "id": "geoglows",
        "name": "GEOGloWS ECMWF Streamflow (v2): retrospective and 15-day ensemble forecast",
        "provider": "GEOGloWS / ECMWF, free API",
        "role": "The main river's flow: the experimental two-week outlook of the hidden flood",
        "url": "https://geoglows.ecmwf.int/",
    },
    "glwd": {
        "id": "glwd",
        "name": "GLWD v2.0 Global Lakes and Wetlands Database (2025)",
        "provider": "WWF / McGill (Lehner et al. 2025), CC BY 4.0",
        "role": "Where wetlands, and forested wetlands, are usually mapped: an independent check",
        "url": "https://www.hydrosheds.org/products/glwd",
    },
    "hand": {
        "id": "hand",
        "name": "GLO-30 HAND, height above nearest drainage (v1, 2021)",
        "provider": "Alaska Satellite Facility (NASA DAAC) from the Copernicus GLO-30 DEM, CC0",
        "role": "How far above the nearest stream or river each place is: floods reach low ground",
        "url": "https://registry.opendata.aws/glo-30-hand/",
    },
    "jrc": {
        "id": "jrc",
        "name": "JRC Global Surface Water occurrence 1984–2021 (v1.4)",
        "provider": "European Commission JRC / Google (open data)",
        "role": "Where water usually is, so the usual river is not counted as flood",
        "url": "https://global-surface-water.appspot.com/",
    },
    "grace": {
        "id": "grace",
        "name": "GRACE/GRACE-FO JPL mascons RL06.3",
        "provider": "NASA PO.DAAC",
        "role": "Whole-basin water storage: is this a wet year?",
        "url": "https://grace.jpl.nasa.gov/",
    },
    "icesat2": {
        "id": "icesat2",
        "name": "ICESat-2 ATL13 inland water surface height",
        "provider": "NASA NSIDC DAAC",
        "role": "Independent lidar water heights, a second check after SWOT",
        "url": "https://icesat-2.gsfc.nasa.gov/",
    },
    "swot": {
        "id": "swot",
        "name": "SWOT L2 HR Raster 100 m (version D)",
        "provider": "NASA/CNES via PO.DAAC",
        "url": "https://swot.jpl.nasa.gov/",
        "role": "Independent satellite water surface elevation",
    },
    "gunw": {
        "id": "nisar_gunw",
        "name": "NISAR L2 GUNW interferograms (HH)",
        "provider": "NASA/ISRO via ASF DAAC",
        "url": "https://nisar-docs.asf.alaska.edu/",
        "role": "Water-level change under the canopy between passes",
    },
    "sme2": {
        "id": "nisar_sme2",
        "name": "NISAR L3 SME2 soil moisture",
        "provider": "NASA/ISRO via ASF DAAC",
        "url": "https://nisar-docs.asf.alaska.edu/",
        "role": "Was the ground already saturated?",
    },
    "lc07": {
        "id": "lba_eco_lc07",
        "name": "LBA-ECO LC-07 Amazon wetland map (JERS-1 L-band, dual season)",
        "provider": "NASA ORNL DAAC (Hess et al.)",
        "url": "https://doi.org/10.3334/ORNLDAAC/1284",
        "role": "Independent L-band reference for flooded forest at high water",
    },
    "rtc": {
        "id": "opera_rtc_s1",
        "name": "OPERA RTC-S1 (C-band VV/VH backscatter)",
        "provider": "NASA JPL OPERA via ASF DAAC",
        "url": "https://www.jpl.nasa.gov/go/opera",
        "role": "C-band's own numbers at each spot, for comparison with L-band",
    },
    "grdi": {
        "id": "sedac_grdi",
        "name": "SEDAC Global Gridded Relative Deprivation Index v1",
        "provider": "NASA SEDAC (CIESIN, Columbia University)",
        "url": "https://search.earthdata.nasa.gov/search?q=CIESIN_SEDAC_PMP_GRDI_2010_2020",
        "role": "How deprived the communities next to the hidden flood are",
    },
    "mcd64a1": {
        "id": "mcd64a1",
        "name": "MODIS MCD64A1 v061 burned area (500 m, monthly)",
        "provider": "NASA LP DAAC",
        "url": "https://doi.org/10.5067/MODIS/MCD64A1.061",
        "role": "Independent check of where and when the forest burned (optical and thermal)",
    },
    "vnp64a1": {
        "id": "vnp64a1",
        "name": "VIIRS VNP64A1 v002 burned area (500 m, monthly)",
        "provider": "NASA LP DAAC",
        "url": "https://doi.org/10.5067/VIIRS/VNP64A1.002",
        "role": "Second check of the burned forest; reaches later months than MODIS",
    },
    "viirs_af": {
        "id": "viirs_af",
        "name": "VIIRS 375 m active fire v002 (VNP14IMG, VJ114IMG, VJ214IMG)",
        "provider": "NASA LAADS DAAC",
        "url": "https://doi.org/10.5067/VIIRS/VNP14IMG.002",
        "role": "Where and when the fire burned, several times a day, between radar passes",
    },
    "geonames": {
        "id": "geonames",
        "name": "GeoNames populated places",
        "provider": "GeoNames (CC BY 4.0)",
        "url": "https://www.geonames.org/",
        "role": "Village names where OpenStreetMap maps none",
    },
    "osm": {
        "id": "osm",
        "name": "OpenStreetMap roads and places",
        "provider": "© OpenStreetMap contributors (ODbL)",
        "url": "https://www.openstreetmap.org/copyright",
        "role": "Roads and place names",
    },
}


def grid_shape(bounds, width_px: int = DEFAULT_GRID_PX) -> tuple[int, int]:
    """(height, width) giving roughly square pixels over the site."""
    west, south, east, north = bounds
    lat0 = np.deg2rad((south + north) / 2)
    ratio = (north - south) / ((east - west) * np.cos(lat0))
    return max(int(round(width_px * ratio)), 8), width_px


MIN_PASSES = 6  # docs/04 §7, as fetch.MIN_PASSES
EARLY_BEFORE = date(2026, 6, 17)  # fetch.CALIBRATED_FROM: calibrated public NISAR data start here
FULL_VALID = 0.98  # as fetch.FULL_VALID: a group this complete counts as imaging the whole box


def _group(w: io_gcov.Window) -> tuple:
    name = io_gcov.parse_name(w.path)
    return name.group if name else (w.track, w.direction, "", "")


def select_track(
    windows: list[io_gcov.Window], bounds=None
) -> tuple[list[io_gcov.Window], list[str]]:
    """One track, direction, bandwidth and polarisation per site (docs/04 §3.1).

    Mixing them changes incidence angle or resolution and fakes flood change. Keep the group
    with the most *imaged* passes (each date counts by the share of the box it has radar for,
    all frames of the date together) among groups with enough dates: a swath edge can leave a
    third of the box empty on every pass (D-064).
    """
    days: dict[tuple, set] = defaultdict(set)
    cover: dict[tuple, dict] = defaultdict(dict)
    for w in windows:
        g = _group(w)
        days[g].add(w.day)
        if bounds is not None:
            m = io_gcov.coverage_mask(w, bounds)
            cover[g][w.day] = cover[g][w.day] | m if w.day in cover[g] else m
    if bounds is None:
        imaged = {g: float(len(d)) for g, d in days.items()}
    else:
        imaged = {g: sum(float(m.mean()) for m in cover[g].values()) for g in days}
    floor = min(MIN_PASSES, max(len(d) for d in days.values()))
    eligible = [g for g in days if len(days[g]) >= floor]
    # A group that images (nearly) the whole box wins over one with more dates that leaves part
    # of it empty: every number of a cut map silently excludes that part (D-064).
    complete = [g for g in eligible if imaged[g] >= FULL_VALID * len(days[g])]
    if complete:
        best = max(complete, key=lambda g: (len(days[g]), imaged[g]))
    else:
        best = max(eligible, key=lambda g: (imaged[g], len(days[g])))
    kept = [w for w in windows if _group(w) == best]
    count = Counter(_group(w) for w in windows)
    dropped = [
        f"track {g[0]} {g[1]} {g[2]} {g[3]}: {n} granule(s)".strip()
        for g, n in count.most_common()
        if g != best
    ]
    return kept, dropped


# Scene-median γ⁰ bounds for a land scene at L-band. Healthy Sylhet passes sit at
# HH −11…−8.6 dB; a provisional granule of 22 Aug 2026 came in at +19.9 dB (bad
# calibration), so anything outside these bounds is dropped and reported.
MEDIAN_HH_DB = (-25.0, 2.0)
MEDIAN_HV_DB = (-32.0, -8.0)


BAD_GRANULES_FILE = PIPELINE_DIR / "config" / "bad_granules.json"


def bad_granules(path: Path = BAD_GRANULES_FILE) -> list[dict]:
    """Granules found broken by QA (D-112): normal medians, so radiometry_ok lets them through,
    but the image itself is wrong (streaks, rivers missing). Listed by hand with evidence."""
    if not path.is_file():
        return []
    import json

    return json.loads(path.read_text(encoding="utf-8")).get("granules", [])


def known_bad(w: io_gcov.Window, listed: list[dict]) -> dict | None:
    name = Path(w.path).name
    return next((g for g in listed if name.startswith(g["prefix"])), None)


def radiometry_ok(w: io_gcov.Window) -> tuple[bool, str]:
    ok = np.isfinite(w.hh) & np.isfinite(w.hv)
    if ok.mean() < 0.05:
        return False, "fewer than 5 % valid pixels"
    hh = float(np.median(raster.to_db(w.hh[ok])))
    hv = float(np.median(raster.to_db(w.hv[ok])))
    good = MEDIAN_HH_DB[0] <= hh <= MEDIAN_HH_DB[1] and MEDIAN_HV_DB[0] <= hv <= MEDIAN_HV_DB[1]
    return good, f"median HH {hh:.1f} dB, HV {hv:.1f} dB"


def stack_passes(windows: list[io_gcov.Window], bounds, height: int, width: int):
    """Per date: speckle-filter on the native grid, then average into web-grid cells."""
    days = sorted({w.day for w in windows if w.day})
    hh_p, hv_p, sp_p = [], [], []
    for day in days:
        acc = geo.Accumulator(height, width, 3)
        for w in (w for w in windows if w.day == day):
            hh_f = raster.boxcar3(w.hh)  # linear power, before dB (docs/04 §3.3)
            hv_f = raster.boxcar3(w.hv)
            spread = raster.spread3_db(raster.to_db(w.hh))
            xx, yy = np.meshgrid(w.x, w.y)
            lon, lat = geo.utm_to_lonlat(xx, yy, w.epsg)
            idx = geo.target_index(lon, lat, bounds, height, width)
            acc.add(idx, [hh_f, hv_f, spread])
        hh_p.append(raster.to_db(acc.mean(0)))
        hv_p.append(raster.to_db(acc.mean(1)))
        sp_p.append(acc.mean(2))
    return days, np.stack(hh_p), np.stack(hv_p), np.stack(sp_p)


# D-112: a pass whose HH pattern does not match the site's other passes is not the site. Some
# provisional GCOV granules (e.g. track 60, 18 Jun to 24 Jul 2026, Amazonas) came in streaked,
# with the river drawn as bright as forest, yet with a normal median, so the median check above
# let them through. Rivers, oxbows and forest edges stay put between passes, and a real flood
# changes only part of a scene, so a healthy pass keeps a clear correlation with the others.
CONSISTENT_MIN_R = 0.25  # leave-one-out r against the median of the other passes
CONSISTENT_MIN_PEERS = 3  # judge only with at least this many other passes


def pass_consistency(hh_db: np.ndarray) -> np.ndarray:
    """Per pass: Pearson r of its HH (dB) with the median of the other passes; NaN if unknown."""
    n = hh_db.shape[0]
    r = np.full(n, np.nan)
    if n - 1 < CONSISTENT_MIN_PEERS:
        return r
    for i in range(n):
        others = np.nanmedian(np.delete(hh_db, i, axis=0), axis=0)
        a, b = hh_db[i], others
        m = np.isfinite(a) & np.isfinite(b)
        if m.sum() < 100:
            continue
        a, b = a[m] - a[m].mean(), b[m] - b[m].mean()
        den = np.sqrt((a * a).sum() * (b * b).sum())
        r[i] = (a * b).sum() / den if den > 0 else np.nan
    return r


def drop_inconsistent(days, hh, hv, spread):
    """Drop passes that do not look like the site; iterate so a block of bad passes cannot
    pull the median towards itself. Returns the kept stack and (day, r) for each dropped pass."""
    dropped = []
    while True:
        r = pass_consistency(hh)
        bad = np.where(np.isfinite(r) & (r < CONSISTENT_MIN_R))[0]
        if bad.size == 0:
            return days, hh, hv, spread, dropped
        worst = int(bad[np.argmin(r[bad])])
        dropped.append((days[worst], float(r[worst])))
        keep = [i for i in range(len(days)) if i != worst]
        days = [days[i] for i in keep]
        hh, hv, spread = hh[keep], hv[keep], spread[keep]


FILL_MAX_DAYS = 7  # as fetch.FILL_MAX_DAYS (D-101)
FILL_MIN_OVERLAP = 500  # cells both tracks image, to match their levels; fewer: no level match


def fill_gaps(fill_windows, bounds, height: int, width: int, days, hh, hv, spread):
    """Where a pass's own track has no radar, take another track's nearest pass (D-101).

    A swath edge can leave the same part of the box empty on every pass of the site's track
    (Janauacá: the western 30 % on track 140). Each such gap is filled from the nearest pass,
    within FILL_MAX_DAYS, of another track (a neighbouring swath) that images it. The other
    track looks from another angle, so its levels are matched first: the median HH and HV
    difference over cells both passes image is added to its values (relative radiometric
    normalisation, as in SAR mosaicking). The filled cells are marked, and each pass says which
    track and date filled it, by how many days apart and with what level shift.
    Returns (mask (P, H, W) bool or None, per-pass info list); hh, hv, spread are changed in place.
    """
    by: dict[tuple, list] = defaultdict(list)
    for w in fill_windows:
        if w.day is not None:
            by[(_group(w), w.day)].append(w)
    planes = {}
    for key, ws in by.items():
        _d, h1, v1, s1 = stack_passes(ws, bounds, height, width)
        planes[key] = (h1[0], v1[0], s1[0])
    mask = np.zeros(hh.shape, dtype=bool)
    info: list[dict | None] = [None] * len(days)
    for i, d in enumerate(days):
        gap = ~(np.isfinite(hh[i]) & np.isfinite(hv[i]))
        if not gap.any():
            continue
        ranked = []
        for key, (ch, cv, _cs) in planes.items():
            apart = (key[1] - d).days
            ok = gap & np.isfinite(ch) & np.isfinite(cv)
            if abs(apart) <= FILL_MAX_DAYS and ok.any():
                ranked.append((abs(apart), -int(ok.sum()), key))
        if not ranked:
            continue
        key = min(ranked)[2]
        ch, cv, cs = planes[key]
        ok = gap & np.isfinite(ch) & np.isfinite(cv)
        both = ~gap & np.isfinite(ch) & np.isfinite(cv)
        off_hh = off_hv = 0.0
        if both.sum() >= FILL_MIN_OVERLAP:
            off_hh = float(np.median(hh[i][both] - ch[both]))
            off_hv = float(np.median(hv[i][both] - cv[both]))
        hh[i][ok] = ch[ok] + off_hh
        hv[i][ok] = cv[ok] + off_hv
        spread[i][ok] = cs[ok]
        mask[i] = ok
        (track, direction, _mode, _pole), day = key
        info[i] = {
            "track": int(track),
            "direction": str(direction),
            "date": day.isoformat(),
            "days_apart": int((day - d).days),
            "share": round(float(ok.mean()), 3),
            "offset_hh_db": round(off_hh, 2),
            "offset_hv_db": round(off_hv, 2),
        }
    return (mask if mask.any() else None), info


def fine_burn_inputs(
    site: dict, windows, bounds, canopy_h, raw: Path, wc_tiles, site_width: int
) -> dict | None:
    """The burn rule's inputs on its finer grid (burn.FINE_PIXEL_M cells, D-088), from the radar
    windows already read: passes, WorldCover vegetation, GEDI height repeated onto the grid
    (GEDI is a 1 km product; repeating it adds no detail) and the burned-area references."""
    from . import burn as burn_mod

    west, south, east, north = bounds
    width_m = (east - west) * 111_320 * np.cos(np.radians((south + north) / 2))
    wpx = int(round(width_m / burn_mod.FINE_PIXEL_M))
    if wpx <= site_width:
        return None  # the site's own grid is already as fine
    h, w = grid_shape(bounds, wpx)
    _days, hh, hv, _sp = stack_passes(windows, bounds, h, w)
    lon = west + (np.arange(w) + 0.5) * (east - west) / w
    lat = north - (np.arange(h) + 0.5) * (north - south) / h
    ch = None
    if canopy_h is not None:
        rows = ((np.arange(h) + 0.5) * canopy_h.shape[0] / h).astype(int)
        cols = ((np.arange(w) + 0.5) * canopy_h.shape[1] / w).astype(int)
        ch = canopy_h[rows][:, cols]
    return {
        # Quantised as the site's own stack is (0.25 dB steps), so both grids see equal values.
        "hh_db": raster.dequantize_db(raster.quantize_db(hh)),
        "hv_db": raster.dequantize_db(raster.quantize_db(hv)),
        "veg": io_reference.worldcover_veg(wc_tiles, bounds, h, w),
        "canopy_height_m": ch,
        "area": raster.pixel_area_km2(bounds, h, w),
        "refs": burn_mod.load_refs(raw, *np.meshgrid(lon, lat)),
    }


def build_scene(site: dict, raw_root: Path = RAW_DIR, width_px: int = DEFAULT_GRID_PX) -> Scene:
    raw = raw_root / site["id"]
    west, south, east, north = (float(v) for v in site["bbox"])
    bounds = (west, south, east, north)
    height, width = grid_shape(bounds, width_px)
    warnings: list[dict] = []

    granules = sorted((raw / "gcov").glob("*.h5"))
    if not granules:
        raise SystemExit(
            f"No GCOV granules in {raw / 'gcov'}. "
            f"Run: python cli.py fetch --site {site['id']} --gcov"
        )
    windows = [w for w in (io_gcov.read_window(p, bounds) for p in granules) if w is not None]
    if not windows:
        raise SystemExit(
            f"None of the {len(granules)} granules in {raw / 'gcov'} overlap {site['id']}"
        )
    # Before the track choice, so a broken pass cannot win a track its place (D-112).
    listed = bad_granules()
    usable = []
    for w in windows:
        bad = known_bad(w, listed)
        if bad:
            warnings.append(
                {"code": "radiometry_outlier", "detail": f"{w.day}: {bad['reason']} (D-112)"}
            )
        else:
            usable.append(w)
    if not usable:
        raise SystemExit(f"{site['id']}: every granule is on the bad-granule list (D-112)")
    windows, dropped = select_track(usable, bounds)
    if dropped:
        warnings.append({"code": "extra_tracks_dropped", "detail": "; ".join(dropped)})
    kept = []
    for w in windows:
        good, why = radiometry_ok(w)
        if good:
            kept.append(w)
        else:
            warnings.append({"code": "radiometry_outlier", "detail": f"{w.day}: {why}"})
    if not kept:
        raise SystemExit(f"{site['id']}: every pass failed the radiometric check")
    windows = kept
    days, hh, hv, spread = stack_passes(windows, bounds, height, width)
    # D-107: passes before NASA's calibrated public release are early mission data;
    # the site says so.
    early = [d for d in days if d < EARLY_BEFORE]
    if early:
        warnings.append(
            {"code": "early_mission_data", "detail": ", ".join(d.isoformat() for d in early)}
        )
    fill_mask, fill = None, None
    fill_files = sorted((raw / "gcov_fill").glob("*.h5"))
    if fill_files:
        fill_windows = []
        for w in (io_gcov.read_window(p, bounds) for p in fill_files):
            if w is not None and not known_bad(w, listed) and radiometry_ok(w)[0]:
                fill_windows.append(w)
        fill_mask, fill = fill_gaps(fill_windows, bounds, height, width, days, hh, hv, spread)
        for d, f in zip(days, fill, strict=True):
            if f is not None:
                warnings.append(
                    {
                        "code": "gap_filled_other_track",
                        "detail": f"{d.isoformat()}: {f['share']:.0%} from track {f['track']} "
                        f"{f['direction']} {f['date']}",
                    }
                )
    # The radar's own time stamp per pass: the earliest frame start of the date (UTC).
    starts: dict = {}
    for w in windows:
        name = io_gcov.parse_name(w.path)
        if name is not None and w.day is not None:
            starts[w.day] = min(starts.get(w.day, name.start), name.start)
    acquired = [starts.get(d) for d in days]
    sources = [SOURCES["nisar_gcov"]]

    wc_tiles = sorted((raw / "worldcover").glob("*.tif"))
    if not wc_tiles:
        raise SystemExit(
            f"No WorldCover tiles in {raw / 'worldcover'}: without them no pixel can count as "
            f"vegetation. Run: python cli.py fetch --site {site['id']} --worldcover"
        )
    veg = io_reference.worldcover_veg(wc_tiles, bounds, height, width)
    sources.append(SOURCES["worldcover"])

    dswx_tiles = sorted((raw / "dswx").glob("*WTR*.tif"))
    if dswx_tiles:
        # Water cannot stand on hillsides: no hidden-flood claim on ground OPERA marks as
        # high above drainage (HAND). Bright forested slopes otherwise mimic double bounce.
        high = io_reference.hand_mask(dswx_tiles, bounds, height, width)
        veg[(veg == VEG_YES) & high] = VEG_OTHER

    cband = None
    cband_dates = None
    if dswx_tiles:
        cband = np.zeros((len(days), height, width), dtype=np.uint8)
        cband_dates = []
        for i, day in enumerate(days):
            codes, used = io_reference.dswx_for_pass(
                day, dswx_tiles, bounds, height, width, CBAND_MATCH_DAYS
            )
            cband[i] = codes
            cband_dates.append(used)
        sources.append(SOURCES["dswx"])

    gauge = None
    gauge_csv = raw / "gauge.csv"
    if gauge_csv.is_file():
        cfg = site.get("gauge") or {}
        gauge = Gauge(
            id=str(cfg.get("id", "local")),
            name=cfg.get("name", "River gauge"),
            source=cfg.get("source_name", cfg.get("source", "local CSV")),
            daily=io_gauge.load_csv(gauge_csv),
        )
        sources.append({**SOURCES["gauge"], "provider": gauge.source, "name": gauge.name})

    expo = None
    if (raw / "worldpop.tif").is_file() and (raw / "osm.json").is_file():
        places, roads = osm.parse(raw / "osm.json")
        if (raw / "geonames.json").is_file():  # D-104: villages OSM does not map
            places = gazetteer.merge(places, gazetteer.load(raw / "geonames.json"))
            sources.append(SOURCES["geonames"])
        expo = Exposure(
            population=io_reference.worldpop(raw / "worldpop.tif", bounds, height, width),
            places=places,
            roads=roads,
        )
        sources += [SOURCES["worldpop"], SOURCES["osm"]]

    # docs/12 NASA layers, each optional: a missing file just hides its feature.
    nasa = raw / "nasa"
    optical_obs = nasa_inputs.load_optical(raw, days)
    if any(o is not None for o in optical_obs):
        sources.append(SOURCES["dswx_hls"])
    else:
        optical_obs = None
    photo = nasa_inputs.load_photo(raw)
    if photo is not None:
        sources.append(SOURCES["hls"])
    cover, canopy_h = nasa_inputs.load_canopy(raw)
    if cover is not None:
        sources.append(SOURCES["gedi"])
    gate = None
    gate_rule = None
    if (nasa / "nasadem.npz").is_file():
        dem = np.load(nasa / "nasadem.npz")["dem"]
        # Observed open water in any pass (same rule as classify.py rule 2) sets the local
        # water surface; NASADEM is a surface model, so the relief margin covers canopy tops.
        observed_water = ((hh < -16.0) & (hv < -22.0)).any(axis=0)
        relief = float(site.get("terrain_relief_m", TERRAIN_RELIEF_M))
        # NASADEM (SRTM C-band) sees canopy tops, so tall flooded forest would look like
        # high ground. Subtract part of the GEDI canopy height to approximate the ground
        # (docs/10 D-042); SRTM's phase centre sits partway into the canopy.
        if canopy_h is not None:
            dem = dem - SRTM_CANOPY_FRACTION * np.nan_to_num(canopy_h, nan=0.0)
        gate = nasa_inputs.terrain_gate(
            dem, observed_water, raster.pixel_size_m(bounds, height, width)[0], relief
        )
        gate_rule = f"more than {relief:.0f} m above the local open-water surface (NASADEM)"
        sources.append(SOURCES["nasadem"])
    level_changes = nasa_inputs.load_gunw(raw)
    if level_changes:
        sources.append(SOURCES["gunw"])
    context = nasa_inputs.load_context(raw)
    for key, present in (
        ("imerg", context.rain_daily),
        ("cygnss", context.inundation_daily),
        ("sme2", context.soil_moisture),
    ):
        if present:
            sources.append(SOURCES[key])
    reference = nasa_inputs.load_reference(raw)
    if reference is not None:
        sources.append(SOURCES["lc07"])
    rtc_vv, rtc_vh, rtc_dates = nasa_inputs.load_rtc(raw, days)
    if rtc_vv is not None:
        sources.append(SOURCES["rtc"])
    grdi = nasa_inputs.load_grdi(raw)
    if grdi is not None:
        sources.append(SOURCES["grdi"])
    icesat2 = nasa_inputs.load_icesat2(raw, site["name"])
    if icesat2:
        sources.append(SOURCES["icesat2"])
    jrc = nasa_inputs.load_jrc(raw)
    if jrc is not None:
        sources.append(SOURCES["jrc"])
    hand = nasa_inputs.load_hand(raw)
    if hand is not None:
        sources.append(SOURCES["hand"])
    glwd = nasa_inputs.load_glwd(raw)
    if glwd is not None:
        sources.append(SOURCES["glwd"])
    from . import outlook as outlook_mod

    river = outlook_mod.load(raw)
    if river is not None:
        sources.append(SOURCES["geoglows"])
    burn_refs, fire_det, burn_fine = [], None, None
    if site.get("fire"):
        from . import active_fire
        from . import burn as burn_mod

        lon = west + (np.arange(width) + 0.5) * (east - west) / width
        lat = north - (np.arange(height) + 0.5) * (north - south) / height
        glon, glat = np.meshgrid(lon, lat)
        burn_refs = burn_mod.load_refs(raw, glon, glat)
        sources.extend(SOURCES[r["product"].lower()] for r in burn_refs)
        burn_fine = fine_burn_inputs(site, windows, bounds, canopy_h, raw, wc_tiles, width)
        fire_det = active_fire.load(raw)
        if fire_det is not None:
            sources.append(SOURCES["viirs_af"])
    if context.water_storage_monthly:
        sources.append(SOURCES["grace"])
    swot = nasa_inputs.load_swot(raw, site["name"])
    if swot:
        sources.append(SOURCES["swot"])

    scene = Scene(
        site=site,
        bounds=bounds,
        dates=days,
        hh_db=hh,
        fill_mask=fill_mask,
        fill=fill,
        hv_db=hv,
        spread_db=spread,
        veg=veg,
        synthetic=False,
        track_number=windows[0].track,
        direction=windows[0].direction
        if windows[0].direction in ("ascending", "descending")
        else "unknown",
        cband=cband,
        cband_dates=cband_dates,
        acquired=acquired,
        gauge=gauge,
        exposure=expo,
        optical_rgb=photo[0] if photo else None,
        optical_date=photo[1] if photo else None,
        optical_cloud=photo[2] if photo else None,
        optical_obs=optical_obs,
        canopy_cover_pct=cover,
        canopy_height_m=canopy_h,
        canopy_source=SOURCES["gedi"]["name"] if cover is not None else None,
        terrain_gate=gate,
        hand_m=hand,
        glwd_class=glwd,
        river=river,
        burn_refs=burn_refs,
        burn_fine=burn_fine,
        active_fire=fire_det,
        terrain_source=SOURCES["nasadem"]["name"] if gate is not None else None,
        terrain_rule=gate_rule,
        level_changes=level_changes,
        context=context,
        swot=swot,
        icesat2=icesat2,
        jrc_occurrence=jrc,
        rtc_vv_db=rtc_vv,
        rtc_vh_db=rtc_vh,
        rtc_dates=rtc_dates,
        reference_cls=reference,
        reference_name=SOURCES["lc07"]["name"] if reference is not None else None,
        reference_period="high water, May–July 1996 (JERS-1)" if reference is not None else None,
        grdi=grdi,
        sources=sources,
        warnings=warnings,
    )
    return scene
