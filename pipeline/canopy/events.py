"""Floods reported now: a dated snapshot of GDACS flood events for World mode (docs/03 §4.15).

GDACS (the UN / European Commission Global Disaster Alert and Coordination System) lists flood
events with an alert level, mostly from GloFAS. It is fetched once at build time and written as a
static file; the browser never calls the API (CLAUDE.md rule 5).
"""

from __future__ import annotations

import json
import urllib.request
from datetime import date, timedelta
from pathlib import Path

GDACS = (
    "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=FL"
    "&fromdate={start}&todate={end}&alertlevel=green;orange;red"
)
UA = {"User-Agent": "under-the-canopy/0.2 (NASA Space Apps)"}
LEVELS = {"Green": 1, "Orange": 2, "Red": 3}


def parse_gdacs(doc: dict) -> list[dict]:
    """GDACS GeoJSON to compact events (points only), most severe and newest first."""
    out = []
    for f in doc.get("features", []):
        p = f.get("properties", {})
        g = f.get("geometry") or {}
        if g.get("type") != "Point" or p.get("eventtype") != "FL":
            continue
        lon, lat = g["coordinates"][:2]
        out.append(
            {
                "id": f"gdacs-{p.get('eventid')}-{p.get('episodeid')}",
                "name": p.get("name") or p.get("description") or "Flood",
                "country": p.get("country") or "",
                "alert": p.get("alertlevel") or "Green",
                "from": str(p.get("fromdate", ""))[:10],
                "to": str(p.get("todate", ""))[:10],
                "current": str(p.get("iscurrent", "")).lower() == "true",
                "source": p.get("source") or "",
                "lon": round(float(lon), 4),
                "lat": round(float(lat), 4),
                "url": (p.get("url") or {}).get("report", ""),
            }
        )
    out.sort(key=lambda e: (LEVELS.get(e["alert"], 0), e["to"]), reverse=True)
    return out


def fetch_gdacs(days: int = 45, today: date | None = None) -> dict:
    end = today or date.today()
    url = GDACS.format(start=(end - timedelta(days=days)).isoformat(), end=end.isoformat())
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=120) as res:  # noqa: S310 - fixed host
        return json.loads(res.read().decode("utf-8"))


def build(out: Path, days: int = 45) -> dict:
    events = parse_gdacs(fetch_gdacs(days))
    doc = {
        "source": "GDACS (UN OCHA / European Commission JRC), flood events",
        "url": "https://www.gdacs.org/",
        "window_days": days,
        "events": events,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False) + "\n", encoding="utf-8")
    return doc
