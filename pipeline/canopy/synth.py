"""Deterministic synthetic scenes (docs/04 §9).

Everything produced here is flagged ``synthetic=True``; the web shows the
SYNTHETIC badge for it (CLAUDE.md rule 3). The scenes follow the same physics
as real data, so every feature can be built and tested before real granules
arrive. They prove nothing about the real world.
"""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np

from . import raster
from .config import NOMINAL_REPEAT_DAYS, VEG_BUILT_UP, VEG_OTHER, VEG_YES
from .scene import Context, Exposure, Gauge, LevelChange, OpticalObs, Scene

GRID = 256  # web grid size
OVERSAMPLE = 2  # simulate at 512², then average to 256² like a real multilook
N_PASSES = 14
LOOKS = 4  # equivalent number of looks before the 3×3 boxcar

# Mean backscatter per surface, dB (docs/04 §9 table).
SURFACE_DB = {
    "dry_forest": (-8.0, -13.0),
    "flooded_forest": (-2.0, -12.0),
    "flooded_forest_sparse": (-4.0, -13.0),
    "flooded_forest_dense": (-4.5, -12.5),  # L-band only partly reaches the trunks
    "open_water": (-21.0, -27.0),
    "dry_grass": (-10.0, -17.0),
    "dry_marsh": (-12.0, -19.0),
    "flooded_marsh": (-4.0, -15.0),
    "built_up": (2.0, -10.0),
}

# WorldCover-like land cover codes used by the generator.
TREE, GRASS, CROP, BUILT, WETLAND, WATER = 10, 30, 40, 50, 90, 80


def _smooth_noise(rng: np.random.Generator, n: int, scale: float, octaves: int = 4) -> np.ndarray:
    """Band-limited noise in [0, 1], built from random low-frequency Fourier modes."""
    y, x = np.mgrid[0:n, 0:n] / n
    out = np.zeros((n, n))
    for o in range(octaves):
        freq = scale * 2**o
        amp = 0.5**o
        for _ in range(3):
            kx, ky = rng.normal(0, freq, 2)
            phase = rng.uniform(0, 2 * np.pi)
            out += amp * np.cos(2 * np.pi * (kx * x + ky * y) + phase)
    out -= out.min()
    return out / max(out.max(), 1e-9)


def _terrain(rng: np.random.Generator, n: int):
    """DEM (m), channel mask, lake mask, river centre line x(y)."""
    y, x = np.mgrid[0:n, 0:n] / n
    p1, p2 = rng.uniform(0, 2 * np.pi, 2)
    centre = 0.5 + 0.17 * np.sin(2 * np.pi * 1.2 * y + p1) + 0.05 * np.sin(2 * np.pi * 3.3 * y + p2)
    d = np.abs(x - centre)
    channel = d < 0.012
    levee = 0.6 * np.exp(-(((d - 0.025) / 0.012) ** 2))
    floodplain = 7.5 * np.clip(d / 0.42, 0, 1) ** 1.4
    relief = 1.6 * (_smooth_noise(rng, n, 3.0) - 0.5)
    lx, ly = centre[n // 2, 0] + rng.choice([-0.2, 0.2]), 0.55 + rng.uniform(-0.1, 0.1)
    lake_r = np.hypot(x - lx, (y - ly) * 1.6)
    lake_bowl = -1.8 * np.exp(-((lake_r / 0.07) ** 2))
    dem = 0.8 + floodplain + levee + relief + lake_bowl
    dem[channel] = -2.0
    lake = lake_r < 0.035
    dem[lake] = np.minimum(dem[lake], -0.5)
    return dem, channel | lake, centre


def _landcover(rng: np.random.Generator, dem: np.ndarray, water: np.ndarray, n: int):
    """WorldCover-like classes and canopy openness in [0, 1]."""
    wet_noise = _smooth_noise(rng, n, 4.0)
    lc = np.full((n, n), TREE, dtype=np.uint8)
    lc[(dem < 2.2) & (wet_noise > 0.62)] = WETLAND
    lc[dem > 6.5] = CROP
    lc[(dem > 6.5) & (_smooth_noise(rng, n, 5.0) > 0.6)] = GRASS
    lc[water] = WATER
    # A village on high ground at the floodplain edge: the people who live with the flood.
    high = np.argwhere((dem > 6.8) & (dem < 8.0))
    vy, vx = high[rng.integers(len(high))] if len(high) else (n // 8, n // 8)
    yy, xx = np.mgrid[0:n, 0:n]
    village = np.hypot(yy - vy, xx - vx) < n * 0.025
    lc[village] = BUILT
    openness = 0.15 + 0.85 * _smooth_noise(rng, n, 2.5) ** 1.6
    return lc, openness, (int(vy), int(vx))


def _stage_curve(rng: np.random.Generator, start: date, days: int):
    """Daily river stage (m): a smooth, asymmetric seasonal flood pulse plus noise."""
    t = np.arange(days, dtype=float)
    peak = days * rng.uniform(0.42, 0.58)
    rise, fall = days * 0.18, days * 0.28
    width = np.where(t < peak, rise, fall)
    stage = 1.2 + 4.6 * np.exp(-(((t - peak) / width) ** 2))
    stage += 0.06 * rng.standard_normal(days)
    return [(start + timedelta(days=int(i)), float(s)) for i, s in zip(t, stage, strict=True)]


def _floodplain_level(rng: np.random.Generator, daily: list[tuple[date, float]]):
    """Water level on the floodplain, which is not the river stage the gauge reports.

    Floodplains fill quickly when the river overtops the levees but drain slowly
    through the backswamp (hysteresis), and local rain ponds water on its own.
    Without this the synthetic gauge correlation would be an unrealistic r ≈ 1.
    """
    river = np.array([s for _, s in daily])
    fill, drain_days, rain_decay_days = 0.6, 16.0, 6.0
    level = np.empty_like(river)
    rain = np.zeros_like(river)
    rain_mm = np.zeros_like(river)
    level[0] = river[0]
    for i in range(1, river.size):  # per day, not per pixel
        gap = river[i] - level[i - 1]
        level[i] = level[i - 1] + (gap * fill if gap > 0 else gap / drain_days)
        rain[i] = rain[i - 1] * np.exp(-1 / rain_decay_days)
        if rng.random() < 1 / 14:
            event = rng.uniform(0.25, 0.8)
            rain[i] += event
            rain_mm[i] = event * 120  # a storm that ponds 0.5 m ≈ 60 mm of rain
    level_by_date = {d: float(v) for (d, _), v in zip(daily, level + rain, strict=True)}
    return level_by_date, [(d, float(v)) for (d, _), v in zip(daily, rain_mm, strict=True)]


def _surface_db(lc, openness, depth_m, flooded, water):
    """Mean HH, HV (dB) for one pass from the surface state."""
    hh = np.empty(lc.shape)
    hv = np.empty(lc.shape)

    def put(mask, key):
        hh[mask], hv[mask] = SURFACE_DB[key]

    forest = lc == TREE
    put(forest, "dry_forest")
    put(np.isin(lc, (GRASS, CROP)), "dry_grass")
    put(lc == WETLAND, "dry_marsh")
    put(lc == BUILT, "built_up")
    fl_forest = forest & flooded
    put(fl_forest, "flooded_forest")
    put(fl_forest & (openness > 0.6), "flooded_forest_sparse")
    put(fl_forest & (openness < 0.22), "flooded_forest_dense")
    put((lc == WETLAND) & flooded & (depth_m < 1.2), "flooded_marsh")
    # Deep water over marsh, and any flood over grass or crops, submerges the
    # plants: specular open water.
    deep = flooded & (((lc == WETLAND) & (depth_m >= 1.2)) | np.isin(lc, (GRASS, CROP)))
    put(deep | water, "open_water")
    return hh, hv


def _optical(rng, lc, flooded, n, cloud_cover: float):
    colours = {
        TREE: (34, 92, 40),
        GRASS: (120, 150, 70),
        CROP: (170, 160, 100),
        BUILT: (150, 140, 135),
        WETLAND: (80, 120, 70),
        WATER: (40, 60, 70),
    }
    rgb = np.zeros((n, n, 3))
    for code, c in colours.items():
        rgb[lc == code] = c
    # Under the canopy the flood is invisible to a camera; only open flooded
    # ground shows as muddy water.
    rgb[flooded & (lc != TREE)] = (70, 80, 75)
    rgb *= 0.85 + 0.3 * _smooth_noise(rng, n, 12.0)[..., None]
    clouds = _smooth_noise(rng, n, 2.0, octaves=5)
    cut = np.quantile(clouds, 1 - cloud_cover)
    alpha = np.clip((clouds - cut) / 0.08, 0, 1)[..., None]
    rgb = rgb * (1 - alpha) + 235 * alpha
    return np.clip(rgb, 0, 255).astype(np.uint8), float((alpha[..., 0] > 0.5).mean())


def _exposure(rng, dem, lc, village, bounds, n_full, factor):
    """Population raster, places and roads in lon/lat for the web grid."""
    west, south, east, north = bounds

    def to_lonlat(r, c):
        return (
            round(west + (c + 0.5) / n_full * (east - west), 6),
            round(north - (r + 0.5) / n_full * (north - south), 6),
        )

    pop = np.zeros((n_full, n_full))
    vy, vx = village
    yy, xx = np.mgrid[0:n_full, 0:n_full]
    pop += 2.5 * np.exp(-((np.hypot(yy - vy, xx - vx) / (n_full * 0.02)) ** 2))
    # Scattered homes on the slightly raised ground at the floodplain edge,
    # exactly where hidden flooding comes closest.
    edge = (dem > 4.0) & (dem < 6.5) & (lc != 80)
    pop[edge] += 0.04 * rng.random(edge.sum())
    pop = raster.block_mean(pop, factor) * factor * factor
    pop *= 3500 / pop.sum()

    places = [{"name": "Demo town (synthetic)", "rc": (vy, vx), "population": 2400}]
    edge_pts = np.argwhere(edge)
    for i, label in enumerate("ABCD"):
        r, c = edge_pts[rng.integers(len(edge_pts))] if len(edge_pts) else (i * 40, 20)
        places.append(
            {"name": f"Demo village {label} (synthetic)", "rc": (r, c), "population": None}
        )
    place_out = []
    for p in places:
        lon, lat = to_lonlat(*p["rc"])
        place_out.append({"name": p["name"], "lon": lon, "lat": lat, "population": p["population"]})

    roads = []
    # Road along the high ground, and a causeway across the floodplain from the town.
    cols = np.argmax(dem > 6.0, axis=1)
    rows = np.arange(0, n_full, 8)
    roads.append(
        {
            "name": "Levee road (synthetic)",
            "highway": "secondary",
            "coords": [list(to_lonlat(r, int(cols[r]))) for r in rows if cols[r] > 0],
        }
    )
    roads.append(
        {
            "name": "Causeway (synthetic)",
            "highway": "tertiary",
            "coords": [
                list(to_lonlat(vy, vx)),
                list(to_lonlat(vy + 10, n_full // 2)),
                list(to_lonlat(vy + 30, n_full - 10)),
            ],
        }
    )
    return Exposure(population=pop, places=place_out, roads=roads)


def _v3_inputs(rng, dem, lc, openness, water, dates, level_by_date, rain_events, flooded_small):
    """Synthetic stand-ins for the docs/12 NASA layers, all driven by the same flood."""
    small = lambda a: raster.block_mean(a.astype(float), OVERSAMPLE)  # noqa: E731
    lc_s = lc.reshape(GRID, OVERSAMPLE, GRID, OVERSAMPLE)[:, 0, :, 0]
    open_s = small(openness)
    tree = lc_s == TREE

    # GEDI-like canopy: dense forest = high cover and tall; marsh low; open land ~bare.
    cover = np.where(tree, 100 * (1 - open_s), np.where(lc_s == WETLAND, 30.0, 4.0))
    height = np.where(tree, 12 + 18 * (1 - open_s), np.where(lc_s == WETLAND, 2.0, 0.5))

    # NASADEM-like terrain gate: terraces well above the floodplain cannot flood.
    gate = small(dem) > 8.0

    # DSWx-HLS-like optical water: cloud hides much of the scene, and under the canopy a
    # camera sees nothing, so only open, cloud-free water counts.
    optical: list[OpticalObs | None] = []
    for i, d in enumerate(dates):
        if rng.random() < 0.3:
            optical.append(None)  # no clear-enough optical scene within ±6 days
            continue
        cloud = _smooth_noise(rng, GRID, 2.5, octaves=4)
        clear = cloud < np.quantile(cloud, rng.uniform(0.1, 0.6))
        seen = (flooded_small[i] & ~tree) | (small(water) > 0.5)
        optical.append(
            OpticalObs(day=d + timedelta(days=int(rng.integers(-4, 5))), water=seen, clear=clear)
        )

    # NISAR GUNW-like level change: only where water stays under coherent vegetation.
    coherent = tree & (open_s > 0.25) & (open_s < 0.85)
    changes = []
    for i in range(1, len(dates)):
        both = flooded_small[i] & flooded_small[i - 1] & coherent
        dh = (level_by_date[dates[i]] - level_by_date[dates[i - 1]]) * 100
        field = np.full((GRID, GRID), np.nan)
        field[both] = dh + rng.normal(0, 1.5, both.sum())
        share = float(both.sum() / max((flooded_small[i] & tree).sum(), 1))
        changes.append(
            LevelChange(start=dates[i - 1], end=dates[i], dh_cm=field, coherent_share=share)
        )

    # Daily context: rain drives ponding; CYGNSS-like flooded fraction follows the level.
    dem_sorted = np.sort(dem.ravel())
    days = sorted(level_by_date)
    frac = [np.searchsorted(dem_sorted, level_by_date[d]) / dem_sorted.size for d in days]
    inundation = [
        (d, float(np.clip(f + rng.normal(0, 0.02), 0, 1))) for d, f in zip(days, frac, strict=True)
    ]
    drizzle = rng.gamma(0.5, 6.0, len(rain_events)) * (rng.random(len(rain_events)) < 0.45)
    rain = [(d, float(mm + dz)) for (d, mm), dz in zip(rain_events, drizzle, strict=True)]
    f_at = dict(inundation)
    soil = [(d, float(np.clip(0.22 + 0.3 * f_at[d] + rng.normal(0, 0.015), 0, 0.6))) for d in dates]

    # SWOT-like lake water surface elevation every ~10 days, with its own datum.
    swot_days = days[3::10]
    lake = [(d, level_by_date[d] + 2.0 + float(rng.normal(0, 0.08))) for d in swot_days]

    # OPERA RTC-S1-like C-band VV/VH for ~60 % of passes. C-band scatters in the crowns, so
    # over dense flooded forest it barely changes; only sparse canopy shows a little
    # double bounce (docs/04 §6).
    water_s = small(water) > 0.5
    rtc_vv = np.full((len(dates), GRID, GRID), np.nan)
    rtc_vh = np.full((len(dates), GRID, GRID), np.nan)
    rtc_dates: list[date | None] = []
    for i, d in enumerate(dates):
        if rng.random() > 0.6:
            rtc_dates.append(None)
            continue
        fl = flooded_small[i]
        vv = np.where(tree, -7.0, np.where(lc_s == WETLAND, -12.0, -11.0))
        vh = np.where(tree, -13.0, np.where(lc_s == WETLAND, -19.0, -18.0))
        vv = np.where(tree & fl & (open_s > 0.6), -4.0, vv)
        open_flood = (fl & ~tree) | water_s
        vv = np.where(open_flood, -20.0, vv)
        vh = np.where(open_flood, -26.0, vh)
        rtc_vv[i] = vv + rng.normal(0, 0.7, vv.shape)
        rtc_vh[i] = vh + rng.normal(0, 0.7, vh.shape)
        rtc_dates.append(d + timedelta(days=int(rng.integers(-3, 4))))

    # LBA-ECO-like historical reference at high water, with ~10 % disagreement.
    peak_i = int(np.argmax([f.sum() for f in flooded_small]))
    ref = np.where(
        water_s | (flooded_small[peak_i] & ~tree & (lc_s != WETLAND)),
        2,
        np.where(flooded_small[peak_i] & (tree | (lc_s == WETLAND)), 3, 1),
    ).astype(np.uint8)
    flip = rng.random(ref.shape) < 0.1
    ref[flip] = rng.integers(1, 4, flip.sum()).astype(np.uint8)

    # SEDAC-GRDI-like deprivation (0–100): higher on the floodplain edge settlements.
    grdi = 30 + 45 * _smooth_noise(rng, GRID, 3.0)

    # JRC-like water occurrence: the channel and lakes nearly always water, the floodplain
    # part of the time in proportion to how often this season flooded it.
    freq = np.mean([f.astype(float) for f in flooded_small], axis=0)
    jrc = np.where(water_s, 96.0, np.round(35.0 * freq))

    return {
        "jrc_occurrence": jrc,
        "rtc_vv_db": rtc_vv,
        "rtc_vh_db": rtc_vh,
        "rtc_dates": rtc_dates,
        "reference_cls": ref,
        "reference_name": "synthetic (stands in for LBA-ECO LC-07)",
        "reference_period": "synthetic high water",
        "grdi": grdi,
        "canopy_cover_pct": cover,
        "canopy_height_m": height,
        "canopy_source": "synthetic (stands in for GEDI L2A/L2B gridded)",
        "terrain_gate": gate,
        "terrain_source": "synthetic (stands in for NASADEM)",
        "terrain_rule": "floodplain elevation more than 8 m above the channel",
        "optical_obs": optical,
        "level_changes": changes,
        "context": Context(
            rain_daily=rain,
            rain_source="synthetic (stands in for GPM IMERG Late)",
            inundation_daily=inundation,
            inundation_source="synthetic (stands in for CYGNSS)",
            soil_moisture=soil,
            soil_moisture_source="synthetic (stands in for NISAR L3 SME2)",
            # Shaped like the real series after the seasonal swing is removed (D-061): a slow
            # drift into a wet year with a small month-to-month wobble, not a sine wave.
            water_storage_monthly=[
                (date(dates[0].year, m, 15), round(-3.0 + 0.8 * (m - 1) + 1.5 * np.sin(1.7 * m), 2))
                for m in range(1, 13)
            ],
            water_storage_source="synthetic (stands in for GRACE-FO)",
        ),
        "swot": [
            {"id": "SYN-LAKE-1", "name": "Synthetic oxbow lake", "kind": "lake", "series": lake}
        ],
    }


def make_scene(site: dict, seed: int | None = None, start: date = date(2026, 4, 1)) -> Scene:
    """Build one synthetic Scene on the site's real bounding box."""
    rng = np.random.default_rng(site.get("synthetic_seed", 0) if seed is None else seed)
    n_full = GRID * OVERSAMPLE
    west, south, east, north = (float(v) for v in site["bbox"])
    bounds = (west, south, east, north)

    dem, water, _ = _terrain(rng, n_full)
    lc, openness, village = _landcover(rng, dem, water, n_full)

    season_days = (N_PASSES - 1) * NOMINAL_REPEAT_DAYS + 1
    daily = _stage_curve(rng, start, season_days + 14)
    level_by_date, rain_events = _floodplain_level(rng, daily)
    dates = [start + timedelta(days=i * NOMINAL_REPEAT_DAYS) for i in range(N_PASSES)]

    texture = 0.8 * (_smooth_noise(rng, n_full, 20.0) - 0.5) * 2
    # Swath edge: a corner with no data in every pass, so features must cope with nodata.
    yy, xx = np.mgrid[0:n_full, 0:n_full]
    swath_gap = (xx + yy) < n_full * 0.12

    hh_p, hv_p, sp_p, cb_p, flooded_peak, flooded_small = [], [], [], [], None, []
    windy = int(rng.integers(N_PASSES))  # one pass with wind-roughened open water
    for i, d in enumerate(dates):
        stage = level_by_date[d]
        jitter = rng.normal(0, 0.12, (n_full, n_full))
        depth = stage - (dem + jitter)
        flooded = (depth > 0) | water
        hh_mean, hv_mean = _surface_db(lc, openness, depth, flooded, water)
        if i == windy:
            hh_mean[(hh_mean < -18)] += 3.0
        calib = rng.normal(0, 0.15)
        hh_lin = raster.to_linear(hh_mean + texture + calib)
        hv_lin = raster.to_linear(hv_mean + texture * 0.6 + calib)
        # Multiplicative gamma speckle, then the same filtering real data gets.
        hh_lin = hh_lin * rng.gamma(LOOKS, 1 / LOOKS, hh_lin.shape)
        hv_lin = hv_lin * rng.gamma(LOOKS, 1 / LOOKS, hv_lin.shape)
        hh_lin[swath_gap] = np.nan
        hv_lin[swath_gap] = np.nan
        spread = raster.spread3_db(raster.to_db(hh_lin))
        hh_f = raster.boxcar3(hh_lin)
        hv_f = raster.boxcar3(hv_lin)
        hh_p.append(raster.to_db(raster.block_mean(hh_f, OVERSAMPLE)))
        hv_p.append(raster.to_db(raster.block_mean(hv_f, OVERSAMPLE)))
        sp_p.append(raster.block_mean(spread, OVERSAMPLE))

        # C-band stand-in: sees open water and flooded vegetation only where the
        # canopy is sparse (docs/04 §6), with 0.5 % classification noise.
        sees = water | (flooded & ((lc != TREE) | (openness > 0.6)))
        sees_small = raster.block_mean(sees.astype(float), OVERSAMPLE) > 0.5
        noise = rng.random(sees_small.shape) < 0.005
        cb = np.where(sees_small ^ noise, 2, 1).astype(np.uint8)
        cb[raster.block_mean(swath_gap.astype(float), OVERSAMPLE) > 0.5] = 0
        cb_p.append(cb)
        flooded_small.append(raster.block_mean(flooded.astype(float), OVERSAMPLE) > 0.5)
        if flooded_peak is None or flooded.sum() > flooded_peak[1].sum():
            flooded_peak = (d, flooded)

    hh = np.stack(hh_p)
    hv = np.stack(hv_p)
    spread = np.stack(sp_p)

    lc_small = lc.reshape(GRID, OVERSAMPLE, GRID, OVERSAMPLE)[:, 0, :, 0]
    veg = np.full((GRID, GRID), VEG_OTHER, dtype=np.uint8)
    veg[np.isin(lc_small, (10, 20, 90, 95))] = VEG_YES
    veg[lc_small == 50] = VEG_BUILT_UP

    # C-band acquisitions land a few days off the NISAR dates; one has no match.
    no_match = int(rng.integers(N_PASSES))
    cband_dates: list[date | None] = []
    for i, d in enumerate(dates):
        if i == no_match:
            cband_dates.append(None)
            cb_p[i][:] = 0
        else:
            cband_dates.append(d + timedelta(days=int(rng.integers(-3, 5))))

    assert flooded_peak is not None
    peak_date, peak_flood = flooded_peak
    optical_rgb, _ = _optical(rng, lc, peak_flood, n_full, cloud_cover=0.55)
    optical_small = optical_rgb.reshape(GRID, OVERSAMPLE, GRID, OVERSAMPLE, 3)[:, 0, :, 0]

    v3 = _v3_inputs(rng, dem, lc, openness, water, dates, level_by_date, rain_events, flooded_small)

    gauge = Gauge(
        id="SYN-GAUGE-1",
        name="Synthetic river gauge",
        source="synthetic",
        daily=daily,
    )
    exposure = _exposure(rng, dem, lc, village, bounds, n_full, OVERSAMPLE)

    scene = Scene(
        site=site,
        bounds=bounds,
        dates=dates,
        hh_db=hh,
        hv_db=hv,
        spread_db=spread,
        veg=veg,
        synthetic=True,
        track_number=None,
        direction="ascending",
        cband=np.stack(cb_p),
        cband_dates=cband_dates,
        gauge=gauge,
        exposure=exposure,
        optical_rgb=optical_small,
        optical_date=peak_date + timedelta(days=1),
        **v3,
        sources=[
            {
                "id": "synthetic",
                "name": "Synthetic scene generator",
                "provider": "Under the Canopy (synth.py)",
                "url": "",
                "role": "Stands in for NISAR GCOV and GUNW, DSWx-S1, DSWx-HLS, OPERA RTC-S1, GEDI, "
                "NASADEM, GPM IMERG, CYGNSS, SWOT, LBA-ECO, SEDAC GRDI, gauges, WorldPop and OSM",
            }
        ],
    )
    scene.warn("synthetic_data", "generated by canopy.synth; not a measurement")
    return scene
