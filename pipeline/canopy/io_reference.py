"""Reference layers on the web grid: WorldCover (veg gate), DSWx-S1 (C-band), WorldPop.

Needs the `real` extra (rasterio). Inputs live in pipeline/data/raw/<site>/:
    worldcover/*.tif   ESA WorldCover 10 m map tiles (EPSG:4326)
    dswx/*WTR*.tif     OPERA DSWx-S1 WTR layers (UTM, 30 m)
    worldpop.tif       WorldPop people-per-pixel (EPSG:4326, ~100 m)
"""

from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path

import numpy as np

from . import geo, raster
from .config import VEG_BUILT_UP, VEG_OTHER, VEG_YES, WORLDCOVER_BUILT_UP, WORLDCOVER_VEG

# OPERA DSWx-S1 WTR classes (product docs; docs/04 §6).
DSWX_NOT_WATER = 0
DSWX_OPEN_WATER = 1
DSWX_INUNDATED_VEG = 3
DSWX_HAND_MASKED = 250
DSWX_LAYOVER_SHADOW = 251
DSWX_NODATA = 255

# A cell is excluded if this share of it is built-up: buildings are bright enough
# that even a small fraction can push a mixed cell over the double-bounce test.
BUILT_UP_FRACTION = 0.2
VEG_FRACTION = 0.5


def _rasterio():
    try:
        import rasterio
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("rasterio is missing: pip install -e .[real]") from exc
    return rasterio


def _pixel_centres(transform, rows: np.ndarray, cols: np.ndarray):
    x = transform.c + (cols + 0.5) * transform.a + (rows + 0.5) * transform.b
    y = transform.f + (cols + 0.5) * transform.d + (rows + 0.5) * transform.e
    return x, y


def worldcover_veg(tiles: list[Path], bounds, height: int, width: int) -> np.ndarray:
    """docs/04 §4.1 veg codes from WorldCover class fractions in each web-grid cell."""
    rasterio = _rasterio()
    from rasterio.windows import from_bounds

    acc = geo.Accumulator(height, width, 2)
    for tile in tiles:
        with rasterio.open(tile) as src:
            win = from_bounds(*bounds, transform=src.transform).round_offsets().round_lengths()
            data = src.read(1, window=win, boundless=True, fill_value=0)
            tr = src.window_transform(win)
        # In strips: sums and counts add up exactly, and a 60 × 100 km box at 10 m (109 M pixels)
        # would need ~6 GB of coordinates at once.
        for r0 in range(0, data.shape[0], 1024):
            d = data[r0 : r0 + 1024]
            r, c = np.indices(d.shape)
            lon, lat = _pixel_centres(tr, r + r0, c)
            idx = np.where(d > 0, geo.target_index(lon, lat, bounds, height, width), -1)
            acc.add(
                idx, [np.isin(d, WORLDCOVER_VEG).astype(float), (d == WORLDCOVER_BUILT_UP) * 1.0]
            )
    veg_frac = np.nan_to_num(acc.mean(0))
    built_frac = np.nan_to_num(acc.mean(1))
    veg = np.full((height, width), VEG_OTHER, dtype=np.uint8)
    veg[veg_frac >= VEG_FRACTION] = VEG_YES
    veg[built_frac >= BUILT_UP_FRACTION] = VEG_BUILT_UP
    return veg


DSWX_DATE_RE = re.compile(r"_(\d{8})T\d{6}Z")


def dswx_date(path: Path) -> date | None:
    m = DSWX_DATE_RE.search(path.name)
    return datetime.strptime(m[1], "%Y%m%d").date() if m else None


def _sample_nearest(
    path: Path, lon: np.ndarray, lat: np.ndarray, outside: int = DSWX_NODATA
) -> np.ndarray:
    """Values of a (UTM or lon/lat) GeoTIFF at points; `outside` where a point is off the raster."""
    rasterio = _rasterio()
    with rasterio.open(path) as src:
        epsg = src.crs.to_epsg() if src.crs else None
        if epsg is None:
            raise ValueError(f"{path}: no EPSG code in its CRS; reproject it to UTM or EPSG:4326")
        if epsg == 4326:
            x, y = lon, lat
        else:
            x, y = geo.lonlat_to_utm(lon, lat, epsg)
        inv = ~src.transform
        col = inv.a * x + inv.b * y + inv.c
        row = inv.d * x + inv.e * y + inv.f
        col = np.floor(col).astype(np.int64)
        row = np.floor(row).astype(np.int64)
        inside = (row >= 0) & (row < src.height) & (col >= 0) & (col < src.width)
        out = np.full(lon.shape, outside, dtype=np.float64)
        if inside.any():
            r0, r1 = row[inside].min(), row[inside].max() + 1
            c0, c1 = col[inside].min(), col[inside].max() + 1
            block = src.read(1, window=((r0, r1), (c0, c1)))
            out[inside] = block[row[inside] - r0, col[inside] - c0]
    return out


def dswx_cband(tiles: list[Path], bounds, height: int, width: int) -> np.ndarray:
    """Contract cband codes (0 no data, 1 not water, 2 water) from DSWx-S1 tiles of one date.

    Inundated vegetation (class 3) counts as water: we compare against C-band's
    best effort (docs/10 D-012).
    """
    lon, lat = raster.grid_lonlat(bounds, height, width)
    out = np.zeros((height, width), dtype=np.uint8)
    for tile in tiles:
        wtr = _sample_nearest(tile, lon, lat)
        unset = out == 0
        out[unset & (wtr == DSWX_NOT_WATER)] = 1
        out[unset & np.isin(wtr, (DSWX_OPEN_WATER, DSWX_INUNDATED_VEG))] = 2
    return out


def dswx_for_pass(
    nisar_day: date, tiles: list[Path], bounds, height: int, width: int, max_days: int
) -> tuple[np.ndarray, date | None]:
    """C-band codes for one NISAR pass, filled from the closest-in-time DSWx acquisitions.

    DSWx comes in MGRS tiles; the closest date may only cover a neighbouring tile, so
    each pixel takes the nearest date (within ±max_days) that actually covers it.
    Returns (codes, the date that supplied the most pixels).
    """
    by_day: dict[date, list[Path]] = {}
    for t in tiles:
        d = dswx_date(t)
        if d is not None and abs((d - nisar_day).days) <= max_days:
            by_day.setdefault(d, []).append(t)
    out = np.zeros((height, width), dtype=np.uint8)
    supplied: dict[date, int] = {}
    for d in sorted(by_day, key=lambda x: (abs((x - nisar_day).days), x)):
        layer = dswx_cband(by_day[d], bounds, height, width)
        fill = (out == 0) & (layer > 0)
        out[fill] = layer[fill]
        supplied[d] = int(fill.sum())
        if not (out == 0).any():
            break
    best = max(supplied, key=lambda k: supplied[k]) if any(supplied.values()) else None
    return out, best


def hand_mask(tiles: list[Path], bounds, height: int, width: int) -> np.ndarray:
    """True where OPERA marks the ground too high above the nearest drainage to flood.

    HAND is static terrain, so DSWx tiles of any date supply it (class 250).
    """
    lon, lat = raster.grid_lonlat(bounds, height, width)
    high = np.zeros((height, width), dtype=bool)
    seen: set[str] = set()
    for tile in tiles:
        mgrs = tile.name.split("_")[3] if tile.name.count("_") > 3 else tile.name
        if mgrs in seen:
            continue
        seen.add(mgrs)
        high |= _sample_nearest(tile, lon, lat) == DSWX_HAND_MASKED
    return high


def worldpop(path: Path, bounds, height: int, width: int) -> np.ndarray:
    """People per web-grid cell: density sampled at cell centres, scaled by cell area."""
    rasterio = _rasterio()
    lon, lat = raster.grid_lonlat(bounds, height, width)
    with rasterio.open(path) as src:
        nodata = src.nodata
        src_area_km2 = (
            abs(src.transform.a)
            * raster.EARTH_M_PER_DEG
            * np.cos(np.deg2rad(lat))
            * abs(src.transform.e)
            * raster.EARTH_M_PER_DEG
            / 1e6
        )
    vals = _sample_nearest(path, lon, lat, outside=-1)
    if nodata is not None:
        vals[vals == nodata] = 0
    vals[~np.isfinite(vals) | (vals < 0)] = 0  # off-raster (-1) and negative fill
    cell_km2 = np.broadcast_to(raster.pixel_area_km2(bounds, height, width), (height, width))
    return vals * cell_km2 / src_area_km2
