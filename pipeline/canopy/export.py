"""Writes the web data contract (docs/03 §4). The web reads nothing else."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import SCHEMA_VERSION


def write_json(path: Path, obj: dict, compact: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = (
        json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        if compact
        else json.dumps(obj, indent=1, ensure_ascii=False)
    )
    path.write_text(text + "\n", encoding="utf-8")


def write_stack(path: Path, layers: list[np.ndarray]) -> None:
    """Concatenate uint8 layers in order (docs/03 §4.4: layer, pass, row, col)."""
    for a in layers:
        if a.dtype != np.uint8:
            raise TypeError(f"stack layers must be uint8, got {a.dtype}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(np.ascontiguousarray(a).tobytes() for a in layers))


def roads_geojson(roads: list[dict]) -> dict:
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {
                    "name": r["name"],
                    "highway": r.get("highway"),
                    "flooded_km": r.get("flooded_km", 0.0),
                },
                "geometry": {"type": "LineString", "coordinates": r["coords"]},
            }
            for r in roads
        ],
    }


def write_manifest(out_root: Path, default_site: str | None = None) -> dict:
    """List every site directory holding a summary.json, so partial rebuilds stay consistent."""
    sites = []
    for summary_path in sorted(out_root.glob("*/summary.json")):
        s = json.loads(summary_path.read_text(encoding="utf-8"))
        sites.append(
            {
                "id": s["site"]["id"],
                "name": s["site"]["name"],
                "country": s["site"]["country"],
                "synthetic": bool(s["synthetic"]),
                "kind": s["site"].get("kind", "flood"),
                "path": f"{summary_path.parent.name}/summary.json",
                "bounds": s["grid"]["bounds"],
            }
        )
    ids = [s["id"] for s in sites]
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "default_site": default_site if default_site in ids else (ids[0] if ids else None),
        "sites": sites,
        "global": "global/global.json" if (out_root / "global" / "global.json").is_file() else None,
        "gibs": "gibs.json" if (out_root / "gibs.json").is_file() else None,
        "events": "events.json" if (out_root / "events.json").is_file() else None,
        "belt": "belt/index.json" if (out_root / "belt" / "index.json").is_file() else None,
        "motion": "motion/index.json" if (out_root / "motion" / "index.json").is_file() else None,
        "ice": "ice/index.json" if (out_root / "ice" / "index.json").is_file() else None,
        "glaciers": (
            "glaciers/index.json" if (out_root / "glaciers" / "index.json").is_file() else None
        ),
    }
    write_json(out_root / "manifest.json", manifest)
    return manifest


def flood_geojson(cls: np.ndarray, conf: np.ndarray, bounds, codes: dict[int, str]) -> dict:
    """Vectorise class rasters as merged horizontal pixel runs (one rectangle per run).

    Exact to the pixel and dependency-free; GIS tools can dissolve the runs if needed.
    """
    west, south, east, north = bounds
    h, w = cls.shape
    dx = (east - west) / w
    dy = (north - south) / h
    features = []
    for code, name in codes.items():
        for conf_value, conf_name in ((1, "high"), (0, "low")):
            mask = (cls == code) & (conf == conf_value)
            polys = []
            for r in np.flatnonzero(mask.any(axis=1)):
                edges = np.diff(np.concatenate(([0], mask[r].astype(np.int8), [0])))
                starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
                top, bot = round(north - r * dy, 6), round(north - (r + 1) * dy, 6)
                for c0, c1 in zip(starts, ends, strict=True):
                    x0, x1 = round(west + c0 * dx, 6), round(west + c1 * dx, 6)
                    polys.append([[[x0, top], [x1, top], [x1, bot], [x0, bot], [x0, top]]])
            if polys:
                features.append(
                    {
                        "type": "Feature",
                        "properties": {"class": name, "confidence": conf_name},
                        "geometry": {"type": "MultiPolygon", "coordinates": polys},
                    }
                )
    return {"type": "FeatureCollection", "features": features}


def write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    def cell(v) -> str:
        if v is None:
            return ""
        text = str(v)
        return (
            f'"{text.replace(chr(34), chr(34) * 2)}"' if any(ch in text for ch in ',"\n') else text
        )

    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [",".join(header)] + [",".join(cell(v) for v in row) for row in rows]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
