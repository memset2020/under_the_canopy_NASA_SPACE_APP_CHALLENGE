"""Downwind ice (canopy/ice.py): outlines, the sinusoidal window, season comparison, speed test."""

import struct
from datetime import date

import numpy as np

from canopy import ice

EV = {"season": ["08-01", "08-05"], "late_summer": ["08-01", "08-05"]}


def _shp(polys):
    """A shapefile (type 5) with one record per polygon ring list."""
    recs = b""
    for i, rings in enumerate(polys):
        pts = np.concatenate(rings)
        parts = np.cumsum([0] + [len(r) for r in rings[:-1]]).astype("<i4")
        body = struct.pack("<i4d", 5, *pts.min(0), *pts.max(0))
        body += struct.pack("<ii", len(rings), len(pts)) + parts.tobytes()
        body += pts.astype("<f8").tobytes()
        recs += struct.pack(">ii", i + 1, len(body) // 2) + body
    return b"\0" * 100 + recs


def test_shapefile_reader_keeps_polygons_meeting_the_box():
    sq = lambda x, y: np.array([[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]], float)  # noqa: E731
    data = _shp([[sq(0, 0)], [sq(10, 10), sq(10.2, 10.2)]])
    got = ice.shp_polygons(data, (9.5, 9.5, 12, 12))
    assert [i for i, _ in got] == [1]
    assert len(got[0][1]) == 2 and got[0][1][0].shape == (5, 2)


def test_columbia_icefield_is_one_tile_of_the_sinusoidal_grid():
    h, v, r0, r1, c0, c1 = ice.sin_window((-117.55, 52.05, -117.05, 52.30))
    assert (h, v) == (10, 3)
    assert 0 <= r0 < r1 <= 1200 and 0 <= c0 < c1 <= 1200
    # ~28 km north-south at ~0.93 km a cell
    assert 25 <= r1 - r0 <= 35


def test_season_summary_ranks_the_year_against_the_others():
    rows = [
        {"date": f"{y}-08-0{d}", "v": str(v)}
        for y, v in ((2020, 0.30), (2021, 0.28), (2022, 0.26), (2026, 0.20))
        for d in range(1, 6)
    ]
    years = [2020, 2021, 2022, 2026]
    grid = ice.by_day_of_season(rows, "v", years, EV)
    s = ice.season_summary(grid, years, 2026, EV, 3, EV["late_summer"])
    assert s["value"] == 0.2 and s["rank_low"] == 1 and s["n_years"] == 4
    assert s["base_median"] == 0.28
    assert s["days"][0] == {
        "date": "2026-08-01",
        "value": 0.2,
        "base_median": 0.28,
        "base_lo": 0.26,
        "base_hi": 0.3,
    }


def test_fire_days_count_confident_pixels_only():
    rows = [
        {"time_utc": "2026-08-08T10:00:00", "confidence": "9", "frp_mw": "10"},
        {"time_utc": "2026-08-08T21:00:00", "confidence": "7", "frp_mw": "99"},
        {"time_utc": "2026-08-09T10:00:00", "confidence": "8", "frp_mw": "2.5"},
    ]
    assert ice.fire_days(rows) == [
        {"date": "2026-08-08", "n": 1, "frp_mw": 10.0},
        {"date": "2026-08-09", "n": 1, "frp_mw": 2.5},
    ]


def test_speed_summary_uses_the_pair_with_most_ice_agreeing():
    goff = [
        {
            "track": "48A",
            "start": "2026-08-16",
            "end": "2026-08-28",
            "days": 12.0,
            "rock_noise_m_yr": 5.0,
            "ice_agree_pct": 18.0,
            "glaciers": [
                {"name": "Athabasca Glacier", "cells": 100, "agree_pct": 7.0, "speed_m_yr": 12.0}
            ],
        },
        {
            "track": "71D",
            "start": "2026-08-18",
            "end": "2026-08-30",
            "days": 12.0,
            "rock_noise_m_yr": 70.0,
            "ice_agree_pct": 12.0,
            "glaciers": [
                {"name": "Athabasca Glacier", "cells": 100, "agree_pct": 3.0, "speed_m_yr": 55.0}
            ],
        },
    ]
    its = [{"glaciers": {"Athabasca Glacier": v}} for v in (20.0, 30.0, 40.0, 50.0)]
    s = ice.speed_summary(goff, its, ["Athabasca Glacier"])
    assert s["best_pair"]["track"] == "48A" and s["rock_noise_median_m_yr"] == 37.5
    g = s["glaciers"][0]
    assert g["itslive_m_yr"] == 35.0 and g["itslive_pairs"] == 4 and g["nisar_m_yr"] == 12.0


def test_season_days_are_inclusive():
    assert ice.season_days(EV, 2026) == (date(2026, 8, 1), date(2026, 8, 5))


def test_smoke_pools_other_years_and_compares_summers_by_smoky_share():
    ev = {"season": ["08-01", "08-20"]}
    years = [2020, 2021, 2026]
    grid = np.full((3, 20), np.nan)
    grid[0, ::2] = 0.1  # 10 clear days measured
    grid[1, ::2] = 0.1
    grid[1, 0] = 0.9  # one smoky day of 10
    grid[2, :10] = 0.5  # 10 smoky days of 10
    s = ice.smoke_summary(grid, years, 2026, ev)
    assert [y["value"] for y in s["years"]] == [0.0, 10.0, 100.0]
    assert s["value"] == 100.0 and s["base_median"] == 5.0 and s["rank_low"] == 3
    assert s["days"][5]["base_median"] == 0.1 and s["days"][5]["value"] == 0.5
    assert s["days"][15]["value"] is None


def test_a_granule_is_dated_by_its_name_tag_not_its_retrieval_window():
    g = {
        "umm": {
            "GranuleUR": "VNP43MA3.A2026213.h10v03.002.2026222000000",
            "TemporalExtent": {"RangeDateTime": {"BeginningDateTime": "2026-07-24T00:00:00Z"}},
        }
    }
    assert ice._granule_day(g) == "2026-08-01"
    g["umm"]["GranuleUR"] = "LAADS:9991504791"
    assert ice._granule_day(g) == "2026-07-24"
