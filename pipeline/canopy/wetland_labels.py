"""Calibration labels from independently mapped wetlands (task D-04, docs/10 D-047).

Hand labels by whoever tunes the thresholds would score the rule against that person's
guesses. These labels come from maps made by others, before 2026:

- US sites: the USFWS National Wetlands Inventory (NWI). The water-regime letter in each
  Cowardin code says how long a forested wetland stays flooded.
- elsewhere: OpenStreetMap polygons tagged `wetland=swamp` (flooded forest, e.g. Ratargul)
  and forest / wood / forest-park polygons (dry vegetation).

`fetch_*` need the network (run by `cli.py fetch --wetlands`); everything else is offline.
"""

from __future__ import annotations

import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from . import osm, raster
from .config import VEG_YES

NWI_URL = (
    "https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/"
    "Wetlands/MapServer/0/query"
)
NWI_PAGE = 1000
UA = {"User-Agent": "under-the-canopy/0.2 (NASA Space Apps)"}

# Cowardin water regimes (USFWS 2013 classification standard, FGDC-STD-004-2013):
# semipermanently / intermittently exposed / permanently flooded → water under the trees
# through the whole season; seasonally flooded → only near high water. Temporarily
# flooded (A) and saturated (B) are left out: their state on a given day is unknown.
NWI_ALWAYS = set("FGHKTV")
NWI_HIGH_WATER = set("CER")
MAX_PER_CLASS_PASS = 1500


def fetch_nwi(bbox: list[float], out: Path) -> Path:
    """Every NWI polygon in the box as lon/lat rings (all of them mark "not upland")."""
    w, s, e, n = bbox
    feats, offset = [], 0
    while True:
        q = {
            "geometry": f"{w},{s},{e},{n}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "outSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "where": "1=1",
            "outFields": "ATTRIBUTE",
            "returnGeometry": "true",
            "resultOffset": offset,
            "resultRecordCount": NWI_PAGE,
            "f": "json",
        }
        req = urllib.request.Request(f"{NWI_URL}?{urllib.parse.urlencode(q)}", headers=UA)
        with urllib.request.urlopen(req, timeout=180) as res:  # noqa: S310 - fixed URL
            page = json.load(res)
        if "error" in page:
            raise SystemExit(f"NWI query failed: {page['error']}")
        got = page.get("features", [])
        feats += [
            {"code": f["attributes"]["ATTRIBUTE"], "rings": f["geometry"]["rings"]}
            for f in got
            if f.get("geometry")
        ]
        if not got or not page.get("exceededTransferLimit"):
            break
        offset += len(got)  # the server may cap a page below NWI_PAGE
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"source": "USFWS NWI", "features": feats}), encoding="utf-8")
    return out


def osm_query(bbox: list[float]) -> str:
    w, s, e, n = bbox
    a = f"({s},{w},{n},{e})"
    return (
        "[out:json][timeout:120];("
        f'way["wetland"="swamp"]{a};'
        f'way["natural"="wood"]{a};'
        f'way["landuse"="forest"]{a};'
        ");out geom;"
    )


def fetch_osm(bbox: list[float], out: Path) -> Path:
    data = urllib.parse.urlencode({"data": osm_query(bbox)}).encode()
    last = None
    for url in [u for u in osm.OVERPASS_URLS for _ in range(osm.RETRIES_PER_SERVER)]:
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=200) as res:  # noqa: S310 - fixed URLs
                payload = json.load(res)
        except Exception as exc:  # noqa: BLE001 - try the mirror on any failure
            last = exc
            time.sleep(15)
            continue
        feats = parse_overpass(payload)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"source": "OpenStreetMap", "features": feats}), encoding="utf-8")
        return out
    raise SystemExit(f"Overpass failed on every server: {last}")


def osm_kind(tags: dict) -> str:
    """'swamp' (flooded forest), 'dry_forest', or 'wetland' (other wetland: never dry)."""
    if tags.get("wetland") == "swamp":
        return "swamp"
    if tags.get("natural") == "wetland":
        return "wetland"
    if tags.get("natural") == "wood" or tags.get("landuse") == "forest":
        return "dry_forest"
    return "other"


def parse_overpass(payload: dict) -> list[dict]:
    feats = []
    for el in payload.get("elements", []):
        geom = el.get("geometry")
        kind = osm_kind(el.get("tags", {}))
        if not geom or len(geom) < 4 or kind == "other":
            continue
        tags = el.get("tags", {})
        feats.append(
            {
                "kind": kind,
                "name": tags.get("name:en") or tags.get("name"),
                "rings": [[[p["lon"], p["lat"]] for p in geom]],
            }
        )
    return feats


def nwi_regime(code: str) -> str | None:
    """Water-regime letter of a Cowardin code, e.g. 'PFO2/1F' → 'F', 'PFO1Ch' → 'C'."""
    m = re.match(r"^P(?:FO|SS)[0-9/A-Z]*?([A-Z])[a-z0-9]*$", code)
    return m[1] if m else None


def rasterize(rings: list[list[list[float]]], bounds, height: int, width: int) -> np.ndarray:
    """Even-odd fill of lon/lat rings (holes included) on the pixel-centre grid.

    Vectorised over pixels; the Python loop runs over polygon edges only.
    """
    lon, lat = raster.grid_lonlat(bounds, height, width)
    inside = np.zeros((height, width), dtype=bool)
    for ring in rings:
        pts = np.asarray(ring, dtype=float)
        if len(pts) < 3:
            continue
        x0, y0 = pts.min(axis=0)
        x1, y1 = pts.max(axis=0)
        box = (lon >= x0) & (lon <= x1) & (lat >= y0) & (lat <= y1)
        if not box.any():
            continue
        px, py = lon[box], lat[box]
        hit = np.zeros(px.shape, dtype=bool)
        for (ax, ay), (bx, by) in zip(pts, np.roll(pts, -1, axis=0), strict=True):
            if ay == by:
                continue
            crosses = (ay > py) != (by > py)
            xs = ax + (py - ay) * (bx - ax) / (by - ay)
            hit ^= crosses & (px < xs)
        inside[box] ^= hit
    return inside


def masks(path: Path, bounds, height: int, width: int) -> dict[str, np.ndarray]:
    """{'always': …, 'high_water': …, 'dry': …} boolean masks from a cached fetch."""
    doc = json.loads(path.read_text(encoding="utf-8"))
    out = {k: np.zeros((height, width), dtype=bool) for k in ("always", "high_water", "dry")}
    any_wetland = np.zeros((height, width), dtype=bool)
    for f in doc["features"]:
        m = rasterize(f["rings"], bounds, height, width)
        if "code" in f:  # NWI
            any_wetland |= m
            regime = nwi_regime(f["code"])
            if regime in NWI_ALWAYS:
                out["always"] |= m
            elif regime in NWI_HIGH_WATER:
                out["high_water"] |= m
        elif f["kind"] == "swamp":
            any_wetland |= m
            out["high_water"] |= m  # monsoon swamp forest: flooded near high water
        elif f["kind"] == "wetland":
            any_wetland |= m
        else:
            out["dry"] |= m
    if doc["source"] == "USFWS NWI":
        # Upland: vegetation outside every mapped forested/shrub wetland is filled below.
        out["upland_outside"] = ~any_wetland
    out["dry"] &= ~any_wetland
    out["high_water"] &= ~out["always"]
    return out


def auto_labels(scene, m: dict[str, np.ndarray], high_passes: list[int], rng) -> list[tuple]:
    """(pass, row, col, label) samples; only where the vegetation gate allows a claim."""
    veg = scene.veg == VEG_YES
    if scene.terrain_gate is not None:
        veg &= ~scene.terrain_gate
    n = len(scene.dates)
    dry = m["dry"] | (m.get("upland_outside", np.zeros_like(veg)))
    rules = [
        (m["always"] & veg, range(n), "flooded_veg"),
        (m["high_water"] & veg, high_passes, "flooded_veg"),
        (dry & veg, range(n), "dry_veg"),
    ]
    labels = []
    for mask, passes, label in rules:
        rows, cols = np.nonzero(mask)
        for p in passes:
            take = rng.permutation(rows.size)[:MAX_PER_CLASS_PASS]
            labels += [(p, int(rows[k]), int(cols[k]), label) for k in take]
    return labels
