"""Calibration helpers: wetland labels, polygon fill, and the acceptance gate (D-044, D-047)."""

import numpy as np

from canopy import calibrate, wetland_labels
from canopy.build import calibration_summary


def test_nwi_regime_reads_the_water_regime_letter():
    assert wetland_labels.nwi_regime("PFO2/1F") == "F"
    assert wetland_labels.nwi_regime("PFO1Ch") == "C"
    assert wetland_labels.nwi_regime("PSS1/EM1A") == "A"
    assert wetland_labels.nwi_regime("L1UBH") is None  # lake, not forest


def test_rasterize_fills_inside_and_respects_holes():
    bounds = (0.0, 0.0, 10.0, 10.0)
    outer = [[1, 1], [9, 1], [9, 9], [1, 9], [1, 1]]
    hole = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
    m = wetland_labels.rasterize([outer, hole], bounds, 10, 10)
    assert m[1, 1] and m[8, 8]  # inside the ring (row 1 = lat 8.5)
    assert not m[0, 0] and not m[9, 9]  # outside
    assert not m[5, 5]  # in the hole (lon 5.5, lat 4.5)


def test_osm_generic_wetland_is_never_dry():
    assert wetland_labels.osm_kind({"natural": "wetland", "wetland": "swamp"}) == "swamp"
    assert wetland_labels.osm_kind({"natural": "wetland"}) == "wetland"
    assert wetland_labels.osm_kind({"landuse": "forest"}) == "dry_forest"


def _report(after_ow, tuned_ow_hh):
    base = {"ow_hh_db": -16.0, "ow_hv_db": -22.0, "fv_hh_db": -5.0, "fv_ratio_db": 7.0}
    tuned = {**base, "ow_hh_db": tuned_ow_hh, "fv_hh_db": -5.25, "fv_ratio_db": 3.25}
    return {
        "defaults": base,
        "tuned": tuned,
        "held_out_before": {
            "open_water": {"balanced_accuracy": 0.5},
            "flooded_veg": {"balanced_accuracy": 0.6},
        },
        "held_out_after": {
            "open_water": {"balanced_accuracy": after_ow},
            "flooded_veg": {"balanced_accuracy": 0.65},
        },
    }


def test_gate_applies_only_good_clear_gains_off_the_search_edge():
    out, dec = calibrate.accepted(_report(0.8, -12.0))
    assert dec["open_water"]["applied"] and out["ow_hh_db"] == -12.0
    assert not dec["flooded_veg"]["applied"] and out["fv_ratio_db"] == 7.0  # 0.65 < 0.70
    out, dec = calibrate.accepted(_report(0.8, -8.0))  # -8 is the search edge
    assert not dec["open_water"]["applied"] and out["ow_hh_db"] == -16.0
    assert "edge" in dec["open_water"]["rejected"]


def test_calibration_summary_follows_the_contract():
    assert calibration_summary({"id": "x"}) is None
    fv = {"applied": True, "held_out_before": 0.57, "held_out_after": 0.78}
    ow = {"applied": False, "held_out_before": 0.54, "held_out_after": 0.74}
    site = {
        "calibration": {
            "flooded_veg": {**fv, "label_sources": ["USFWS National Wetlands Inventory"]},
            "open_water": ow,
        }
    }
    s = calibration_summary(site)
    assert s["flooded_veg"]["label_sources"] == ["USFWS National Wetlands Inventory"]
    assert s["open_water"]["label_sources"] == []
    assert set(s["open_water"]) == {
        "applied",
        "held_out_before",
        "held_out_after",
        "rejected",
        "label_sources",
    }
    assert np.isclose(s["flooded_veg"]["held_out_after"], 0.78)
