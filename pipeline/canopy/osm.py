"""OpenStreetMap roads and places via the Overpass API (docs/04 §8).

`fetch` (network, run by `cli.py fetch --osm`) caches raw/<site>/osm.json;
`parse` (offline, used by the build) turns that cache into Exposure inputs.
Data © OpenStreetMap contributors, ODbL.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS_URLS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)
RETRIES_PER_SERVER = 2
ROAD_TYPES = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|track"
PLACE_TYPES = "city|town|village|hamlet"


def query(bbox: list[float]) -> str:
    w, s, e, n = bbox
    area = f"({s},{w},{n},{e})"  # Overpass order: south, west, north, east
    return (
        "[out:json][timeout:90];("
        f'way["highway"~"^({ROAD_TYPES})$"]{area};'
        f'node["place"~"^({PLACE_TYPES})$"]{area};'
        ");out geom;"
    )


def fetch(bbox: list[float], out: Path) -> Path:
    """Query Overpass (public servers are often busy: retry, then try a mirror)."""
    data = urllib.parse.urlencode({"data": query(bbox)}).encode()
    last: Exception | None = None
    for url in OVERPASS_URLS:
        for attempt in range(RETRIES_PER_SERVER):
            req = urllib.request.Request(
                url, data=data, headers={"User-Agent": "under-the-canopy/0.2 (NASA Space Apps)"}
            )
            try:
                with urllib.request.urlopen(req, timeout=180) as res:  # noqa: S310 - fixed URLs
                    payload = json.load(res)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_text(json.dumps(payload), encoding="utf-8")
                return out
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last = exc
                time.sleep(10 * (attempt + 1))
    raise SystemExit(f"Overpass failed on every server: {last}")


def _population(tags: dict) -> int | None:
    raw = str(tags.get("population", "")).replace(",", "").replace(" ", "")
    return int(raw) if raw.isdigit() else None


def parse(path: Path) -> tuple[list[dict], list[dict]]:
    """(places, roads) in the shapes canopy.scene.Exposure expects."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    places, roads = [], []
    for el in payload.get("elements", []):
        tags = el.get("tags", {})
        if el.get("type") == "node" and "place" in tags and tags.get("name"):
            places.append(
                {
                    "name": tags["name"],
                    "lon": el["lon"],
                    "lat": el["lat"],
                    "population": _population(tags),
                }
            )
        elif el.get("type") == "way" and "highway" in tags and len(el.get("geometry", [])) >= 2:
            roads.append(
                {
                    "name": tags.get("name") or tags.get("ref") or tags["highway"],
                    "highway": tags["highway"],
                    "coords": [[round(p["lon"], 6), round(p["lat"], 6)] for p in el["geometry"]],
                }
            )
    places.sort(key=lambda p: (-(p["population"] or 0), p["name"]))
    return places, roads
