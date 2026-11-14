"""GeoNames populated places, a second open gazetteer beside OpenStreetMap (docs/10 D-104).

OpenStreetMap maps few rural settlements in some flood plains: the Sylhet box holds two OSM
villages, while GeoNames (CC BY 4.0) lists seven more. The village flood card names the
settlements next to water under the trees, so both are used: a GeoNames place is added only when
no OSM place lies within MERGE_M, so a village is never listed twice.
"""

from __future__ import annotations

import csv
import io
import json
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

# The country dumps (one zip per ISO country code), free under CC BY 4.0; verified.
DUMP_URL = "https://download.geonames.org/export/dump/{cc}.zip"
POPULATED = "P"  # GeoNames feature class: city, village, ...
MERGE_M = 500  # an OSM place this close stands for the same settlement
_M_PER_DEG = 111_320.0


def _rows(zip_path: Path, cc: str):
    with zipfile.ZipFile(zip_path) as z:
        text = z.read(f"{cc}.txt").decode("utf-8")
    yield from csv.reader(io.StringIO(text), delimiter="\t")


def places_in_box(zip_path: Path, cc: str, bbox) -> list[dict]:
    """Populated places of one country dump inside bbox [w, s, e, n]."""
    w, s, e, n = (float(v) for v in bbox)
    out = []
    for r in _rows(zip_path, cc):
        if len(r) < 15 or r[6] != POPULATED:
            continue
        lat, lon = float(r[4]), float(r[5])
        if w <= lon <= e and s <= lat <= n:
            pop = int(r[14]) if r[14].isdigit() and int(r[14]) > 0 else None
            out.append(
                {"name": r[1], "lon": lon, "lat": lat, "population": pop, "source": "geonames"}
            )
    out.sort(key=lambda p: (-(p["population"] or 0), p["name"]))
    return out


def fetch(site: dict, out: Path, cache: Path) -> Path:
    """Write raw/<site>/geonames.json from the site country's dump (downloaded once, cached)."""
    cc = (site.get("country") or "").upper()
    if len(cc) != 2:
        raise SystemExit(f"{site['id']}: no two-letter country code for GeoNames")
    cache.mkdir(parents=True, exist_ok=True)
    zip_path = cache / f"{cc}.zip"
    if not zip_path.is_file():
        with urllib.request.urlopen(DUMP_URL.format(cc=cc), timeout=300) as res:  # noqa: S310 - fixed URL
            zip_path.write_bytes(res.read())
    places = places_in_box(zip_path, cc, site["bbox"])
    out.write_text(
        json.dumps(
            {"source": "GeoNames", "licence": "CC BY 4.0", "places": places}, ensure_ascii=False
        ),
        encoding="utf-8",
    )
    return out


def load(path: Path) -> list[dict]:
    return json.loads(path.read_text(encoding="utf-8")).get("places", [])


def merge(osm_places: list[dict], extra: list[dict], min_m: float = MERGE_M) -> list[dict]:
    """OSM places, plus each extra place with no OSM place within min_m (vectorised per place)."""
    if not extra:
        return list(osm_places)
    if osm_places:
        lon = np.array([p["lon"] for p in osm_places])
        lat = np.array([p["lat"] for p in osm_places])
    merged = list(osm_places)
    for p in extra:
        if osm_places:
            dx = (lon - p["lon"]) * _M_PER_DEG * np.cos(np.deg2rad(p["lat"]))
            dy = (lat - p["lat"]) * _M_PER_DEG
            if float(np.min(np.hypot(dx, dy))) < min_m:
                continue
        merged.append({k: p[k] for k in ("name", "lon", "lat", "population")})
    return merged
