"""Raster helpers: dB conversion, speckle filtering, quantisation, pixel areas."""

from __future__ import annotations

import numpy as np

from .config import Q_OFFSET_DB, Q_STEP_DB

EARTH_M_PER_DEG = 111_320.0


def to_db(linear: np.ndarray) -> np.ndarray:
    """Linear power to dB; non-positive or non-finite values become NaN."""
    lin = np.asarray(linear, dtype=np.float64)
    out = np.full(lin.shape, np.nan)
    ok = np.isfinite(lin) & (lin > 0)
    out[ok] = 10.0 * np.log10(lin[ok])
    return out


def to_linear(db: np.ndarray) -> np.ndarray:
    return np.power(10.0, np.asarray(db, dtype=np.float64) / 10.0)


def _window_sums(arr: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Sum and count of finite values in each 3×3 window (edges use what exists)."""
    finite = np.isfinite(arr)
    vals = np.where(finite, arr, 0.0)
    pv = np.pad(vals, ((0, 0),) * (arr.ndim - 2) + ((1, 1), (1, 1)))
    pc = np.pad(finite.astype(np.float64), ((0, 0),) * (arr.ndim - 2) + ((1, 1), (1, 1)))
    h, w = arr.shape[-2:]
    total = np.zeros(arr.shape)
    count = np.zeros(arr.shape)
    for dr in range(3):
        for dc in range(3):
            total += pv[..., dr : dr + h, dc : dc + w]
            count += pc[..., dr : dr + h, dc : dc + w]
    return total, count


def boxcar3(linear: np.ndarray) -> np.ndarray:
    """3×3 mean of linear power, ignoring NaN. Must run before dB conversion:
    averaging dB values biases the mean low (docs/04 §3.3)."""
    total, count = _window_sums(linear)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = total / count
    out[~np.isfinite(np.asarray(linear))] = np.nan
    return out


def spread3_db(db: np.ndarray) -> np.ndarray:
    """Standard deviation of dB values in each 3×3 window (docs/04 §3.5)."""
    s1, n = _window_sums(db)
    s2, _ = _window_sums(np.where(np.isfinite(db), db * db, np.nan))
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s1 / n
        var = np.maximum(s2 / n - mean * mean, 0.0)
    out = np.sqrt(var)
    out[~np.isfinite(db)] = np.nan
    return out


def block_mean(arr: np.ndarray, factor: int) -> np.ndarray:
    """Downsample the last two axes by an integer factor, averaging finite values."""
    if factor == 1:
        return np.asarray(arr, dtype=np.float64)
    h, w = arr.shape[-2:]
    if h % factor or w % factor:
        raise ValueError(f"shape {(h, w)} not divisible by {factor}")
    lead = arr.shape[:-2]
    blocks = np.asarray(arr, dtype=np.float64).reshape(
        *lead, h // factor, factor, w // factor, factor
    )
    finite = np.isfinite(blocks)
    total = np.where(finite, blocks, 0.0).sum(axis=(-3, -1))
    count = finite.sum(axis=(-3, -1))
    with np.errstate(invalid="ignore", divide="ignore"):
        out = total / count
    out[count == 0] = np.nan
    return out


def quantize_db(db: np.ndarray) -> np.ndarray:
    """dB → uint8 with 0.25 dB steps; 0 means nodata (docs/04 §3.7)."""
    db = np.asarray(db, dtype=np.float64)
    q = np.zeros(db.shape, dtype=np.uint8)
    ok = np.isfinite(db)
    q[ok] = np.clip(np.round((db[ok] - Q_OFFSET_DB) / Q_STEP_DB), 1, 255).astype(np.uint8)
    return q


def dequantize_db(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q)
    out = q.astype(np.float64) * Q_STEP_DB + Q_OFFSET_DB
    out[q == 0] = np.nan
    return out


def quantize_spread(spread_db: np.ndarray) -> np.ndarray:
    s = np.nan_to_num(np.asarray(spread_db, dtype=np.float64), nan=0.0)
    return np.clip(np.round(s / Q_STEP_DB), 0, 255).astype(np.uint8)


def dequantize_spread(q: np.ndarray) -> np.ndarray:
    return np.asarray(q).astype(np.float64) * Q_STEP_DB


def pixel_size_m(bounds: tuple[float, float, float, float], height: int, width: int) -> tuple:
    """(dx_m, dy_m) of a pixel at the grid's centre latitude."""
    west, south, east, north = bounds
    lat0 = np.deg2rad((south + north) / 2)
    dx = (east - west) / width * EARTH_M_PER_DEG * np.cos(lat0)
    dy = (north - south) / height * EARTH_M_PER_DEG
    return float(dx), float(dy)


def pixel_area_km2(bounds: tuple[float, float, float, float], height: int, width: int):
    """Per-row pixel area (km²) as an (H, 1) column; rows shrink toward the poles."""
    west, south, east, north = bounds
    dlat = (north - south) / height
    dlon = (east - west) / width
    lat = north - (np.arange(height) + 0.5) * dlat
    area_m2 = (dlon * EARTH_M_PER_DEG * np.cos(np.deg2rad(lat))) * (dlat * EARTH_M_PER_DEG)
    return (area_m2 / 1e6)[:, None]


def grid_lonlat(bounds: tuple[float, float, float, float], height: int, width: int):
    """Pixel-centre longitude and latitude arrays (docs/03 §4.4)."""
    west, south, east, north = bounds
    lon = west + (np.arange(width) + 0.5) * (east - west) / width
    lat = north - (np.arange(height) + 0.5) * (north - south) / height
    return np.meshgrid(lon, lat)
