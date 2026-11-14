"""Burned forest through the smoke (canopy/burn.py): the rule and the MODIS check."""

from datetime import date
from pathlib import Path

import numpy as np
import pytest

from canopy import burn

DATES = [
    date(2026, 6, 17),
    date(2026, 6, 29),
    date(2026, 7, 11),
    date(2026, 7, 23),
    date(2026, 8, 16),
]


def test_ratio_change_is_against_the_pre_fire_median():
    hh = np.array([[[-8.0]], [[-7.0]], [[-8.0]], [[-6.0]], [[-6.0]]])
    hv = np.array([[[-14.0]], [[-12.0]], [[-13.0]], [[-14.0]], [[-14.5]]])
    delta, pre = burn.ratio_change(hh, hv, DATES, date(2026, 7, 11))
    assert pre == [0, 1, 2]
    # HH - HV: 6, 5, 5 before (median 5), then 8 and 8.5
    assert np.allclose(delta[:, 0, 0], [1.0, 0.0, 0.0, 3.0, 3.5])
    with pytest.raises(ValueError):
        burn.ratio_change(hh, hv, DATES, date(2026, 6, 20))  # one pre-fire pass is not a baseline


def test_wet_weather_that_moves_both_channels_is_not_a_burn():
    hh = np.zeros((5, 1, 1)) - 8.0
    hv = np.zeros((5, 1, 1)) - 14.0
    hh[3:] += 1.5  # rain: both channels brighter by the same amount
    hv[3:] += 1.5
    delta, _ = burn.ratio_change(hh, hv, DATES, date(2026, 7, 11))
    assert burn.first_rise(delta, np.ones((1, 1), bool), start=3)[0, 0] == -1


def test_a_rise_must_last_and_the_last_pass_needs_more():
    # cells: burned at pass 3 and stays; one bright pass at 3 only; rise at the last pass only
    # (1.2 dB: not enough there), 1.6 dB at the last pass (enough), not forest.
    d = np.zeros((5, 1, 5))
    d[3:, 0, 0] = 1.5
    d[3, 0, 1] = 1.5
    d[4, 0, 2] = 1.2
    d[4, 0, 3] = 1.6
    d[3:, 0, 4] = 1.5
    forest = np.array([[True, True, True, True, False]])
    first = burn.first_rise(d, forest, start=3)
    assert first[0].tolist() == [3, -1, -1, 4, -1]


def test_lasting_is_the_mean_over_later_passes_and_gaps_are_skipped():
    d = np.zeros((5, 1, 3))
    d[3:, 0, 0] = [1.2, 0.9]  # dips below at the last pass, but the mean from pass 3 holds
    d[3:, 0, 1] = [1.2, 0.5]  # falls back: the mean from pass 3 is 0.85
    d[3, 0, 2], d[4, 0, 2] = 1.2, np.nan  # not measured next: the last-pass rule applies
    first = burn.first_rise(d, np.ones((1, 3), bool), start=3)
    assert first[0].tolist() == [3, -1, -1]


def test_a_burn_is_dated_by_its_onset_not_by_when_it_passed_the_threshold():
    # The ratio climbs for weeks after the fire: 0.6, 1.1, 1.4, 1.6 from pass 3 on.
    dates = DATES + [date(2026, 8, 28), date(2026, 9, 9)]
    d = np.zeros((7, 1, 2))
    d[3:, 0, 0] = [0.6, 1.1, 1.4, 1.6]
    d[3:, 0, 1] = [0.6, 0.6, 0.6, 0.6]  # never confirmed: not dated either
    got = burn.burn_dates(d, np.ones((1, 2), bool), start=3)
    assert len(dates) == d.shape[0]
    assert burn.first_rise(d, np.ones((1, 2), bool), start=3)[0, 0] == 4
    assert got[0].tolist() == [3, -1]


def test_east_half_is_the_held_out_half():
    e = burn.east_half((2, 5))
    assert e[0].tolist() == [False, False, True, True, True]


def test_fire_read_as_flood_is_measured_after_the_fire_inside_the_burn():
    # 3 passes before (start = 3), 2 after; code 2 = flooded vegetation in this test
    cls = np.zeros((5, 1, 4), dtype=int)
    cls[1, 0, 3] = 2  # one cell of water under trees before the fire
    cls[3, 0, :2] = 2
    cls[4, 0, :3] = 2  # the most after the fire: three cells, two of them burned by then
    first = np.array([[3, 4, -1, -1]])
    area = np.full((1, 4), 0.5)
    got = burn.flood_lookalike(cls, first, area, start=3, flooded_code=2)
    assert got == {"before_km2": 0.5, "pass_index": 4, "km2": 1.5, "in_burned_pct": 66.7}
    assert burn.flood_lookalike(np.zeros((3, 1, 1), int), first[:, :1], area[:, :1], 3, 2) is None


def test_modis_months_come_from_the_file_start_day():
    files = [
        Path("MCD64A1.A2026182.h12v03.061.x.hdf"),
        Path("MCD64A1.A2026152.h12v04.061.x.hdf"),
        Path("MCD64A1.A2026182.h12v04.061.x.hdf"),
    ]
    assert burn.modis_months(files) == ["2026-06", "2026-07"]


def test_modis_tile_and_cell_for_armstrong_ontario():
    h, v, row, col = burn.modis_cells(np.array([-89.03]), np.array([50.30]))
    assert (int(h[0]), int(v[0])) == (12, 3)
    assert 0 <= int(row[0]) < 2400 and 0 <= int(col[0]) < 2400


def test_agreement_counts_forest_cells_with_reference_data_only():
    burned = np.array([[True, True, False, False, True]])
    ref = np.array([[200.0, 0.0, 195.0, 0.0, np.nan]])
    forest = np.ones((1, 5), bool)
    a = burn.agreement(burned, ref, forest)
    assert a == {"precision": 0.5, "recall": 0.5, "f1": 0.5, "cells": 4}


def test_date_agreement_allows_one_step_either_side():
    first = np.array([[3, 3, 4, -1]])
    doy = np.array([[195.0, 150.0, 200.0, 199.0]])  # 14 Jul, 30 May, 19 Jul, unburned by NISAR
    got = burn.date_agreement(first, doy, DATES, 2026)
    assert got["cells"] == 3
    assert got["within_pct"] == pytest.approx(66.7, abs=0.1)


def test_forest_needs_vegetation_and_gedi_height_where_measured():
    veg = np.array([[1, 1, 0, 1]])
    height = np.array([[12.0, 3.0, 20.0, np.nan]])
    assert burn.forest_mask(veg, height).tolist() == [[True, False, False, True]]


def test_summary_scores_each_reference_and_the_site_picks_the_primary(tmp_path):
    from types import SimpleNamespace

    # 3 pre-fire passes, then a 2 dB rise in the west column only.
    hh = np.full((5, 1, 2), -8.0)
    hv = np.full((5, 1, 2), -14.0)
    hh[3:, 0, 0] += 2.0
    doy_a = np.array([[200.0, 0.0]])  # agrees
    doy_b = np.array([[0.0, 200.0]])  # disagrees
    refs = [
        {"product": "MCD64A1", "source": "a", "doy": doy_a, "months": ["2026-07"]},
        {"product": "VNP64A1", "source": "b", "doy": doy_b, "months": ["2026-07", "2026-08"]},
    ]
    site = {"fire": {"name": "x", "before": "2026-07-11", "reference": "VNP64A1"}}
    scene = SimpleNamespace(
        site=site,
        dates=DATES,
        canopy_height_m=None,
        burn_refs=refs,
        active_fire=None,
        bounds=(-1.0, 0.0, 0.0, 1.0),
    )
    doc, _ = burn.summarise(scene, hh, hv, np.ones((1, 2), int), np.ones((1, 2)), tmp_path)
    assert doc["validation"]["product"] == "VNP64A1" and doc["validation"]["f1"] is None
    assert doc["validation"]["ref_months"] == ["2026-07", "2026-08"]
    assert [c["product"] for c in doc["checks"]] == ["MCD64A1"]
    assert doc["checks"][0]["f1"] == 1.0 and doc["checks"][0]["ref_burned_km2"] == 1.0
    assert doc["active_fire"] is None
    # A map that ends before the fire is left out, not scored.
    refs[0]["months"] = ["2026-06"]
    doc, _ = burn.summarise(scene, hh, hv, np.ones((1, 2), int), np.ones((1, 2)), tmp_path)
    assert doc["checks"] == []


def test_small_burned_patches_are_dropped_and_large_ones_kept():
    m = np.zeros((6, 8), bool)
    m[0, 0] = True  # a lone speckle
    m[3:6, 4:8] = True  # a 12-cell patch
    m[0, 5] = m[1, 6] = True  # two cells joined at a corner: one 2-cell patch
    out = burn.patches_at_least(m, 3)
    assert not out[0, 0] and not out[0, 5] and out[3:6, 4:8].all()
    assert burn.patches_at_least(m, 1).sum() == m.sum()


def test_a_fine_burn_map_goes_back_to_the_site_grid():
    f = np.full((4, 4), -1)
    f[0:2, 0:2] = [[3, 4], [5, -1]]  # 3 of 4 burned: burned, dated by the earliest
    f[2, 2] = 2  # 1 of 4: not burned on the site grid
    out = burn.to_grid(f, (2, 2))
    assert out.tolist() == [[3, -1], [-1, -1]]


def test_the_site_layer_keeps_the_site_grid_when_area_is_per_row(tmp_path):
    from types import SimpleNamespace

    # Site grid 2 x 4; area given per row (as raster.pixel_area_km2 does); fine grid 4 x 8.
    dates = DATES
    hh = np.full((5, 4, 8), -8.0)
    hv = np.full((5, 4, 8), -14.0)
    hh[3:, :, :4] += 2.0
    fine = {
        "hh_db": hh,
        "hv_db": hv,
        "veg": np.ones((4, 8), int),
        "canopy_height_m": None,
        "area": np.full((4, 1), 0.01),
        "refs": [],
    }
    site = {"fire": {"name": "x", "before": "2026-07-11"}}
    scene = SimpleNamespace(
        site=site,
        dates=dates,
        canopy_height_m=None,
        burn_refs=[],
        active_fire=None,
        bounds=(-1.0, 0.0, 0.0, 1.0),
        burn_fine=fine,
    )
    doc, burn_pass = burn.summarise(
        scene,
        hh[:, ::2, ::2],
        hv[:, ::2, ::2],
        np.ones((2, 4), int),
        np.full((2, 1), 0.04),
        tmp_path,
    )
    assert burn_pass.shape == (2, 4) and burn_pass[:, :2].all() and not burn_pass[:, 2:].any()
    assert doc["grid"]["width"] == 8
