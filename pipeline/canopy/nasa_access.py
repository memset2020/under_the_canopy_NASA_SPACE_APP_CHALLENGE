"""Authenticated, windowed access to NASA Earthdata Cloud files (docs/12).

Two patterns, both verified:
- GeoTIFF/COG (HLS, DSWx-HLS, GEDI rasters): resolve the protected URL to its signed
  CloudFront/S3 URL with an Earthdata bearer token, then let GDAL range-read the window.
  (GDAL would forward the Authorization header to the signed URL, which rejects it.)
- HDF5/netCDF4 (NISAR GUNW/SME2, IMERG, CYGNSS, SWOT raster): earthaccess file objects
  read by h5py, so only the chunks over the site are fetched.

Credentials come from ~/.netrc via earthaccess; nothing is stored in the repo.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import numpy as np

from . import geo, raster


def _earthaccess():
    try:
        import earthaccess  # pyright: ignore[reportMissingImports]
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("earthaccess is missing: pip install -e .[real]") from exc
    return earthaccess


@lru_cache(maxsize=1)
def login():
    ea = _earthaccess()
    auth = ea.login(strategy="netrc")
    if not getattr(auth, "authenticated", False):
        raise SystemExit("Earthdata login failed: check ~/.netrc (urs.earthdata.nasa.gov)")
    return auth


def token() -> str:
    tok = getattr(login(), "token", None)
    if not tok or "access_token" not in tok:
        raise SystemExit("Earthdata login returned no token: check ~/.netrc")
    return tok["access_token"]


def signed_url(url: str) -> str:
    """Follow the Earthdata redirect once and return the signed data URL."""
    import requests

    with requests.get(
        url, headers={"Authorization": f"Bearer {token()}"}, allow_redirects=False, timeout=60
    ) as res:
        if res.status_code in (301, 302, 303, 307, 308):
            return res.headers["Location"]
        res.raise_for_status()
    return url  # already directly readable


def search(short_name: str, bounds, temporal=None, count: int = 500, **kw) -> list:
    login()
    opts: dict[str, Any] = {"short_name": short_name, "bounding_box": tuple(bounds), "count": count}
    if temporal:
        opts["temporal"] = temporal
    opts.update(kw)
    return _earthaccess().search_data(**opts)


def open_h5(url: str) -> Any:
    """An h5py File over a remote HDF5/netCDF4 granule (range reads)."""
    import h5py

    login()
    return h5py.File(_earthaccess().open([url])[0], "r")


def cog_to_grid(
    url: str,
    bounds,
    height: int,
    width: int,
    how: str = "nearest",
    band: int = 1,
    fill: float = np.nan,
) -> np.ndarray:
    """Read a remote GeoTIFF's window over the site and put it on the web grid.

    how = "nearest": sample at web-cell centres (categorical layers);
    how = "mean": average every source pixel falling in each cell (continuous layers).
    """
    import rasterio
    from rasterio.windows import from_bounds

    path = "/vsicurl/" + signed_url(url) if url.startswith("http") else url
    with (
        rasterio.Env(
            GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif"
        ),
        rasterio.open(path) as src,
    ):
        epsg = src.crs.to_epsg()
        box = bounds if epsg == 4326 else geo.bounds_in_crs(bounds, epsg)
        win = from_bounds(*box, transform=src.transform).round_offsets().round_lengths()
        data = src.read(band, window=win, boundless=True, fill_value=src.nodata or 0).astype(float)
        if src.nodata is not None:
            data[data == src.nodata] = np.nan
        tr = src.window_transform(win)
    return grid_from_array(data, tr, epsg, bounds, height, width, how, fill)


def grid_from_array(data, transform, epsg, bounds, height, width, how="nearest", fill=np.nan):
    r, c = np.indices(data.shape)
    x = transform.c + (c + 0.5) * transform.a + (r + 0.5) * transform.b
    y = transform.f + (c + 0.5) * transform.d + (r + 0.5) * transform.e
    if how == "mean":
        if epsg not in (4326,) and not (32601 <= epsg <= 32760):
            raise ValueError(f"mean resampling needs lon/lat or UTM, got EPSG:{epsg}")
        lon, lat = (x, y) if epsg == 4326 else geo.utm_to_lonlat(x, y, epsg)
        acc = geo.Accumulator(height, width, 1)
        acc.add(geo.target_index(lon, lat, bounds, height, width), [data])
        out = acc.mean(0)
        return np.where(np.isfinite(out), out, fill)
    lon_g, lat_g = raster.grid_lonlat(bounds, height, width)
    gx, gy = geo.to_crs(lon_g, lat_g, epsg)
    inv = ~transform
    col = np.floor(inv.a * gx + inv.b * gy + inv.c).astype(int)
    row = np.floor(inv.d * gx + inv.e * gy + inv.f).astype(int)
    inside = (row >= 0) & (row < data.shape[0]) & (col >= 0) & (col < data.shape[1])
    out = np.full((height, width), fill, dtype=float)
    out[inside] = data[row[inside], col[inside]]
    return out
