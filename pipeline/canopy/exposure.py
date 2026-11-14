"""Who lives next to the hidden flood (docs/04 §8)."""

from __future__ import annotations

import numpy as np

from . import raster


def dilate_m(mask: np.ndarray, radius_m: float, dx_m: float, dy_m: float) -> np.ndarray:
    """Binary dilation by a metric disk (anisotropic pixels), via vectorised shifts."""
    ry, rx = int(np.ceil(radius_m / dy_m)), int(np.ceil(radius_m / dx_m))
    h, w = mask.shape
    padded = np.pad(mask, ((ry, ry), (rx, rx)))
    out = np.zeros_like(mask, dtype=bool)
    for oy in range(-ry, ry + 1):
        for ox in range(-rx, rx + 1):
            if (oy * dy_m) ** 2 + (ox * dx_m) ** 2 <= radius_m**2:
                out |= padded[ry + oy : ry + oy + h, rx + ox : rx + ox + w]
    return out


def population_near(pop: np.ndarray, hidden: np.ndarray, buffer_m: float, dx: float, dy: float):
    if not hidden.any():
        return 0
    return int(round(float(pop[dilate_m(hidden, buffer_m, dx, dy)].sum())))


def _lonlat_to_rc(bounds, h, w, lon, lat):
    west, south, east, north = bounds
    c = np.floor((np.asarray(lon) - west) / (east - west) * w).astype(int)
    r = np.floor((north - np.asarray(lat)) / (north - south) * h).astype(int)
    return r, c


def places_report(places, flooded, hydro_days, bounds) -> list[dict]:
    """Distance from each place to the nearest flooded pixel, and that pixel's hydroperiod."""
    h, w = flooded.shape
    lon_g, lat_g = raster.grid_lonlat(bounds, h, w)
    fr, fc = np.nonzero(flooded)
    lat0 = np.deg2rad((bounds[1] + bounds[3]) / 2)
    out = []
    for p in places:
        rec = {
            "name": p["name"],
            "lon": p["lon"],
            "lat": p["lat"],
            "population": p.get("population"),
            "nearest_flood_m": None,
            "days_flooded": None,
        }
        if fr.size:
            dx = (lon_g[fr, fc] - p["lon"]) * raster.EARTH_M_PER_DEG * np.cos(lat0)
            dy = (lat_g[fr, fc] - p["lat"]) * raster.EARTH_M_PER_DEG
            d = np.hypot(dx, dy)
            i = int(np.argmin(d))
            rec["nearest_flood_m"] = int(round(float(d[i]), -1))
            rec["days_flooded"] = int(hydro_days[fr[i], fc[i]])
        out.append(rec)
    return out


def roads_flooded_km(roads, flooded, bounds, step_m: float = 15.0) -> tuple[float, list[dict]]:
    """Length of each road whose sample points fall on flooded pixels."""
    h, w = flooded.shape
    lat0 = np.deg2rad((bounds[1] + bounds[3]) / 2)
    mx = raster.EARTH_M_PER_DEG * np.cos(lat0)
    my = raster.EARTH_M_PER_DEG
    total = 0.0
    per_road = []
    for road in roads:
        pts = np.asarray(road["coords"], dtype=float)
        flooded_m = 0.0
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:], strict=True):
            seg_m = np.hypot((x1 - x0) * mx, (y1 - y0) * my)
            k = max(int(seg_m // step_m), 1)
            t = (np.arange(k) + 0.5) / k
            r, c = _lonlat_to_rc(bounds, h, w, x0 + t * (x1 - x0), y0 + t * (y1 - y0))
            inside = (r >= 0) & (r < h) & (c >= 0) & (c < w)
            hit = np.zeros(k, dtype=bool)
            hit[inside] = flooded[r[inside], c[inside]]
            flooded_m += hit.mean() * seg_m
        total += flooded_m
        per_road.append({**road, "flooded_km": round(flooded_m / 1000, 3)})
    return round(total / 1000, 3), per_road
