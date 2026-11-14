"""UTM ↔ lon/lat (WGS84) and grid resampling, in numpy only.

NISAR GCOV and OPERA DSWx-S1 are delivered in UTM; the web grid is regular in
lon/lat (docs/03 §4.4). The transverse Mercator uses Krüger's series to third
order in n, accurate to well under a millimetre inside a UTM zone, far below a
pixel.
"""

from __future__ import annotations

import numpy as np

A_WGS84 = 6378137.0
F_WGS84 = 1 / 298.257223563
K0 = 0.9996
FALSE_EASTING = 500_000.0
FALSE_NORTHING_SOUTH = 10_000_000.0

_n = F_WGS84 / (2 - F_WGS84)
_A = A_WGS84 / (1 + _n) * (1 + _n**2 / 4 + _n**4 / 64)
_ALPHA = (
    _n / 2 - 2 * _n**2 / 3 + 5 * _n**3 / 16,
    13 * _n**2 / 48 - 3 * _n**3 / 5,
    61 * _n**3 / 240,
)
_BETA = (
    _n / 2 - 2 * _n**2 / 3 + 37 * _n**3 / 96,
    _n**2 / 48 + _n**3 / 15,
    17 * _n**3 / 480,
)
_DELTA = (
    2 * _n - 2 * _n**2 / 3 - 2 * _n**3,
    7 * _n**2 / 3 - 8 * _n**3 / 5,
    56 * _n**3 / 15,
)
_E2N = 2 * np.sqrt(_n) / (1 + _n)


def utm_zone_from_epsg(epsg: int) -> tuple[int, bool]:
    """(zone, is_north) for EPSG 326zz (north) or 327zz (south)."""
    if 32601 <= epsg <= 32660:
        return epsg - 32600, True
    if 32701 <= epsg <= 32760:
        return epsg - 32700, False
    raise ValueError(f"EPSG:{epsg} is not a WGS84 UTM zone")


def utm_epsg_for(lon: float, lat: float) -> int:
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def _lon0(zone: int) -> float:
    return np.deg2rad(-183.0 + 6.0 * zone)


def lonlat_to_utm(lon, lat, epsg: int):
    """Forward transverse Mercator. Returns (easting, northing) in metres."""
    zone, north = utm_zone_from_epsg(epsg)
    phi = np.deg2rad(np.asarray(lat, dtype=float))
    dlam = np.deg2rad(np.asarray(lon, dtype=float)) - _lon0(zone)
    sphi = np.sin(phi)
    t = np.sinh(np.arctanh(sphi) - _E2N * np.arctanh(_E2N * sphi))
    xi_p = np.arctan2(t, np.cos(dlam))
    eta_p = np.arctanh(np.sin(dlam) / np.sqrt(1 + t * t))
    xi, eta = xi_p.copy(), eta_p.copy()
    for j, a in enumerate(_ALPHA, start=1):
        xi += a * np.sin(2 * j * xi_p) * np.cosh(2 * j * eta_p)
        eta += a * np.cos(2 * j * xi_p) * np.sinh(2 * j * eta_p)
    e = FALSE_EASTING + K0 * _A * eta
    n = K0 * _A * xi + (0.0 if north else FALSE_NORTHING_SOUTH)
    return e, n


def utm_to_lonlat(easting, northing, epsg: int):
    """Inverse transverse Mercator. Returns (lon, lat) in degrees."""
    zone, north = utm_zone_from_epsg(epsg)
    n0 = 0.0 if north else FALSE_NORTHING_SOUTH
    xi = (np.asarray(northing, dtype=float) - n0) / (K0 * _A)
    eta = (np.asarray(easting, dtype=float) - FALSE_EASTING) / (K0 * _A)
    xi_p, eta_p = xi.copy(), eta.copy()
    for j, b in enumerate(_BETA, start=1):
        xi_p -= b * np.sin(2 * j * xi) * np.cosh(2 * j * eta)
        eta_p -= b * np.cos(2 * j * xi) * np.sinh(2 * j * eta)
    chi = np.arcsin(np.sin(xi_p) / np.cosh(eta_p))
    phi = chi.copy()
    for j, d in enumerate(_DELTA, start=1):
        phi += d * np.sin(2 * j * chi)
    lam = _lon0(zone) + np.arctan2(np.sinh(eta_p), np.cos(xi_p))
    return np.rad2deg(lam), np.rad2deg(phi)


def utm_bounds_of(bounds, epsg: int, samples: int = 16):
    """UTM bounding box (xmin, ymin, xmax, ymax) enclosing a lon/lat box (edges sampled)."""
    west, south, east, north = bounds
    t = np.linspace(0, 1, samples)
    lon = np.concatenate(
        [
            west + (east - west) * t,
            np.full(samples, east),
            west + (east - west) * t,
            np.full(samples, west),
        ]
    )
    lat = np.concatenate(
        [
            np.full(samples, south),
            south + (north - south) * t,
            np.full(samples, north),
            south + (north - south) * t,
        ]
    )
    x, y = lonlat_to_utm(lon, lat, epsg)
    return float(x.min()), float(y.min()), float(x.max()), float(y.max())


def target_index(lon, lat, bounds, height: int, width: int) -> np.ndarray:
    """Flat index into the web grid for each point, or -1 outside it."""
    west, south, east, north = bounds
    c = np.floor((np.asarray(lon) - west) / (east - west) * width).astype(np.int64)
    r = np.floor((north - np.asarray(lat)) / (north - south) * height).astype(np.int64)
    inside = (r >= 0) & (r < height) & (c >= 0) & (c < width)
    return np.where(inside, r * width + c, -1)


class Accumulator:
    """Mean of all source pixels whose centres fall in each target cell.

    Adding several granules from the same date mosaics them, because sums and
    counts simply add up.
    """

    def __init__(self, height: int, width: int, n_layers: int):
        self.shape = (height, width)
        self.sums = np.zeros((n_layers, height * width))
        self.counts = np.zeros((n_layers, height * width))

    def add(self, idx: np.ndarray, layers: list[np.ndarray]) -> None:
        idx = np.asarray(idx).ravel()
        size = self.shape[0] * self.shape[1]
        for k, values in enumerate(layers):
            v = np.asarray(values, dtype=float).ravel()
            ok = (idx >= 0) & np.isfinite(v)
            self.sums[k] += np.bincount(idx[ok], weights=v[ok], minlength=size)
            self.counts[k] += np.bincount(idx[ok], minlength=size)

    def mean(self, k: int) -> np.ndarray:
        with np.errstate(invalid="ignore", divide="ignore"):
            out = self.sums[k] / self.counts[k]
        out[self.counts[k] == 0] = np.nan
        return out.reshape(self.shape)

    def count(self, k: int) -> np.ndarray:
        return self.counts[k].reshape(self.shape)


# EASE-Grid 2.0 global (EPSG:6933): Lambert cylindrical equal-area on WGS84, standard
# parallel 30°. Used by the gridded GEDI products. Forward only: we sample at cell centres.
_E2 = F_WGS84 * (2 - F_WGS84)
_E = np.sqrt(_E2)
_PHI_S = np.deg2rad(30.0)
_K0_EASE = np.cos(_PHI_S) / np.sqrt(1 - _E2 * np.sin(_PHI_S) ** 2)


def lonlat_to_ease2(lon, lat):
    phi = np.deg2rad(np.asarray(lat, dtype=float))
    lam = np.deg2rad(np.asarray(lon, dtype=float))
    s = np.sin(phi)
    q = (1 - _E2) * (s / (1 - _E2 * s * s) - (1 / (2 * _E)) * np.log((1 - _E * s) / (1 + _E * s)))
    return A_WGS84 * _K0_EASE * lam, A_WGS84 * q / (2 * _K0_EASE)


def to_crs(lon, lat, epsg: int):
    """lon/lat → coordinates of a supported CRS (4326, WGS84 UTM, EASE-Grid 2.0)."""
    if epsg == 4326:
        return np.asarray(lon, dtype=float), np.asarray(lat, dtype=float)
    if epsg == 6933:
        return lonlat_to_ease2(lon, lat)
    return lonlat_to_utm(lon, lat, epsg)


def bounds_in_crs(bounds, epsg: int, samples: int = 16):
    """Bounding box in a CRS enclosing a lon/lat box (edges sampled)."""
    west, south, east, north = bounds
    t = np.linspace(0, 1, samples)
    lon = np.concatenate(
        [
            west + (east - west) * t,
            np.full(samples, east),
            west + (east - west) * t,
            np.full(samples, west),
        ]
    )
    lat = np.concatenate(
        [
            np.full(samples, south),
            south + (north - south) * t,
            np.full(samples, north),
            south + (north - south) * t,
        ]
    )
    x, y = to_crs(lon, lat, epsg)
    return float(x.min()), float(y.min()), float(x.max()), float(y.max())
