"""GDACS flood events to the compact snapshot (docs/03 §4.15)."""

from canopy.events import parse_gdacs


def _feat(eid, alert, to, kind="FL", geom="Point"):
    return {
        "geometry": {"type": geom, "coordinates": [10.0, 5.0]},
        "properties": {
            "eventtype": kind,
            "eventid": eid,
            "episodeid": 1,
            "name": f"Flood {eid}",
            "country": "X",
            "alertlevel": alert,
            "fromdate": "2026-09-01T00:00:00",
            "todate": to,
            "iscurrent": "true",
            "source": "GLOFAS",
            "url": {"report": f"https://www.gdacs.org/report.aspx?eventid={eid}"},
        },
    }


def test_most_severe_first_then_newest_and_only_flood_points():
    doc = {
        "features": [
            _feat(1, "Green", "2026-10-07T00:00:00"),
            _feat(2, "Red", "2026-09-20T00:00:00"),
            _feat(3, "Green", "2026-10-01T00:00:00"),
            _feat(4, "Orange", "2026-10-02T00:00:00"),
            _feat(5, "Red", "2026-10-05T00:00:00", kind="TC"),
            _feat(6, "Green", "2026-10-06T00:00:00", geom="Polygon"),
        ]
    }
    ev = parse_gdacs(doc)
    assert [e["id"] for e in ev] == ["gdacs-2-1", "gdacs-4-1", "gdacs-1-1", "gdacs-3-1"]
    assert ev[0]["alert"] == "Red" and ev[0]["current"] is True and ev[0]["to"] == "2026-09-20"
    assert ev[0]["url"].startswith("https://www.gdacs.org/")
