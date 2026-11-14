"""Pick new detailed sites from the global grid (docs/10 D-056).

Candidates are 0.25° cells in the bivariate map's amber corner (forest ≥ 70 % and a full
water sign) with enough NISAR passes on one track. They are ranked by the strength of the
seasonal water signal and taken greedily, at least `min_km` apart from each other and from
existing sites, so the batch covers different flooded forests rather than one basin.
Names come from OpenStreetMap Nominatim reverse geocoding (build time only, 1 request/s).
"""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from . import global_layers as gl

NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
MAX_ABS_LAT = 35.0
MAX_CELL_WATER_PCT = 30
MAX_NEIGHBOUR_WATER_PCT = 60
UA = {"User-Agent": "under-the-canopy/0.2 (NASA Space Apps; site naming at build time)"}


def _load(global_dir: Path) -> dict[str, np.ndarray]:
    meta = json.loads((global_dir / "global.json").read_text(encoding="utf-8"))
    w, h = meta["grid"]["width"], meta["grid"]["height"]
    blob = np.frombuffer((global_dir / meta["binary"]).read_bytes(), np.uint8)
    blob = blob.reshape(len(meta["layers"]), h, w)
    return {layer["id"]: blob[i] for i, layer in enumerate(meta["layers"])}


def _km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(np.radians, (*a, *b))
    x = (
        np.sin((lat2 - lat1) / 2) ** 2
        + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    )
    return float(2 * 6371 * np.arcsin(np.sqrt(x)))


def candidates(layers: dict[str, np.ndarray], min_passes: int) -> list[tuple[float, float, float]]:
    """(score, lon, lat) for amber-corner cells with enough NISAR passes, best first."""
    nodata = gl.NODATA
    biv, passes = layers["bivariate"], layers["nisar_passes"]
    # CYGNSS's seasonal range is contaminated by sea water along coasts and islands and is
    # unreliable at the edge of its ±37.4° coverage; keep inland cells well inside it.
    lat = 90 - (np.arange(biv.shape[0]) + 0.5) * gl.RES_DEG
    inside = (np.abs(lat) <= MAX_ABS_LAT)[:, None]
    water = np.where(layers["water_pct"] == nodata, 100, layers["water_pct"]).astype(float)
    near = np.maximum.reduce(
        [np.roll(np.roll(water, dr, 0), dc, 1) for dr in (-1, 0, 1) for dc in (-1, 0, 1)]
    )
    inland = (water <= MAX_CELL_WATER_PCT) & (near <= MAX_NEIGHBOUR_WATER_PCT)
    ok = (biv == 8) & (passes != nodata) & (passes >= min_passes) & inside & inland
    rng = np.where(layers["cygnss_range_pct"] == nodata, 0, layers["cygnss_range_pct"]).astype(
        float
    )
    wet = np.where(layers["wetland_pct"] == nodata, 0, layers["wetland_pct"]).astype(float)
    score = rng + wet
    rows, cols = np.nonzero(ok)
    out = [
        (
            float(score[r, c]),
            -180 + (c + 0.5) * gl.RES_DEG,
            90 - (r + 0.5) * gl.RES_DEG,
        )
        for r, c in zip(rows, cols, strict=True)
    ]
    return sorted(out, reverse=True)


def pick(cands, existing: list[tuple[float, float]], n: int, min_km: float):
    chosen: list[tuple[float, float, float]] = []
    taken = list(existing)
    for score, lon, lat in cands:
        if all(_km((lon, lat), p) >= min_km for p in taken):
            chosen.append((score, lon, lat))
            taken.append((lon, lat))
            if len(chosen) == n:
                break
    return chosen


def place_name(lon: float, lat: float) -> tuple[str, str]:
    """(name, ISO alpha-2 country code) from Nominatim; falls back to coordinates."""
    q = urllib.parse.urlencode(
        {"lat": lat, "lon": lon, "zoom": 8, "format": "jsonv2", "accept-language": "en"}
    )
    try:
        req = urllib.request.Request(f"{NOMINATIM}?{q}", headers=UA)
        with urllib.request.urlopen(req, timeout=60) as res:  # noqa: S310 - fixed host
            j = json.load(res)
        a = j.get("address", {})
        local = a.get("county") or a.get("state_district") or a.get("state") or a.get("region")
        country = a.get("country")
        name = ", ".join(x for x in (local, country) if x) or j.get("display_name", "")
        return name, (a.get("country_code") or "").upper()
    except Exception:  # noqa: BLE001 - a name is nice to have, never required
        return "", ""
    finally:
        time.sleep(1.1)  # Nominatim usage policy: at most one request per second


def site_entry(lon: float, lat: float, name: str, cc: str, rank: int) -> dict:
    w, h = 0.16, 0.14
    tag = f"{'n' if lat >= 0 else 's'}{abs(lat):.2f}_{'e' if lon >= 0 else 'w'}{abs(lon):.2f}"
    coords = f"{abs(lat):.2f}°{'N' if lat >= 0 else 'S'}, {abs(lon):.2f}°{'E' if lon >= 0 else 'W'}"
    return {
        "id": "hot_" + tag.replace(".", "p"),
        "name": f"{name or 'Flooded forest'} ({coords})",
        "country": cc,
        "bbox": [
            round(lon - w / 2, 4),
            round(lat - h / 2, 4),
            round(lon + w / 2, 4),
            round(lat + h / 2, 4),
        ],
        "zoom": 12,
        "language": "en",
        "flood_season": "unknown (picked from the global grid)",
        "hotspot": {"rank": rank, "source": "global bivariate amber corner, D-056"},
    }
