"""VIIRS active fire (canopy/active_fire.py): day-by-day fire and its date check against NISAR."""

import json
from datetime import date, datetime

import numpy as np

from canopy import active_fire

DATES = [date(2026, 7, 30), date(2026, 8, 11), date(2026, 8, 23)]
BBOX = (-120.0, 49.5, -119.9, 49.6)


def _det(rows):
    """rows: (iso time, lat, lon, frp, confidence)."""
    return {
        "time": [datetime.fromisoformat(r[0]) for r in rows],
        "lat": np.array([r[1] for r in rows], float),
        "lon": np.array([r[2] for r in rows], float),
        "frp": np.array([r[3] for r in rows], float),
        "conf": np.array([r[4] for r in rows], int),
        "product": ["VNP14IMG"] * len(rows),
    }


def test_detections_are_counted_by_day_and_between_radar_passes(tmp_path):
    det = _det(
        [
            ("2026-08-08T10:12", 49.55, -119.95, 20.0, 9),
            ("2026-08-08T21:00", 49.56, -119.94, 5.0, 8),
            ("2026-08-12T10:00", 49.57, -119.93, 7.5, 8),
        ]
    )
    doc = active_fire.summarise(det, DATES, None, BBOX, tmp_path)
    assert doc["n"] == 3 and doc["first"] == "2026-08-08" and doc["last"] == "2026-08-12"
    assert doc["by_day"] == [
        {"date": "2026-08-08", "n": 2, "frp_mw": 25.0},
        {"date": "2026-08-12", "n": 1, "frp_mw": 7.5},
    ]
    # Between 30 Jul and 11 Aug: the two 8 Aug pixels; 11-23 Aug: the 12 Aug one.
    assert [p["n_since_last"] for p in doc["by_pass"]] == [0, 2, 1]
    pts = json.loads((tmp_path / doc["points"]).read_text())
    assert pts["day0"] == "2026-08-08" and pts["d"] == [0, 0, 4]
    assert pts["x"][0] == 500 and pts["y"][0] == 500  # 0.05° from the south-west corner
    assert pts["frp"] == [20, 5, 8] and pts["c"] == [9, 8, 8]


def test_no_file_means_no_active_fire(tmp_path):
    assert active_fire.load(tmp_path) is None
    assert active_fire.summarise(None, DATES, None, BBOX, tmp_path) is None


def test_date_check_puts_viirs_first_day_inside_nisars_window():
    first = np.full((20, 20), -1)
    first[10, 10] = 1  # NISAR: burned by the 11 Aug pass
    h, w = first.shape
    lat = BBOX[3] - (10 + 0.5) * (BBOX[3] - BBOX[1]) / h
    lon = BBOX[0] + (10 + 0.5) * (BBOX[2] - BBOX[0]) / w
    det = _det(
        [
            ("2026-08-09T10:00", lat, lon, 10.0, 9),
            ("2026-08-07T10:00", lat, lon, 1.0, 7),  # earlier but low confidence: left out
        ]
    )
    got = active_fire.date_check(det, first, DATES, BBOX)
    assert got["cells"] == 1 and got["within_pct"] == 100.0 and got["median_lead_days"] == 2.0
