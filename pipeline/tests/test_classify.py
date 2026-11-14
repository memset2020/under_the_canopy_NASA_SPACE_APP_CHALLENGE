"""Science regression tests for the classification rules (docs/04 §4.2)."""

import numpy as np
import pytest

from canopy.classify import classify
from canopy.config import (
    DRY,
    EXCLUDED,
    FLOODED_VEG,
    NODATA,
    OPEN_WATER,
    VEG_BUILT_UP,
    VEG_OTHER,
    VEG_YES,
    Thresholds,
)

T = Thresholds()


def one(hh, hv, veg=VEG_YES, spread=0.5):
    cls, conf = classify(np.array([hh]), np.array([hv]), np.array([spread]), np.array([veg]), T)
    return int(cls[0]), int(conf[0])


@pytest.mark.parametrize(
    ("hh", "hv", "veg", "expected"),
    [
        (-2.0, -12.0, VEG_YES, FLOODED_VEG),  # double bounce under trees
        (-8.0, -13.0, VEG_YES, DRY),  # volume scattering, dry forest
        (-21.0, -27.0, VEG_OTHER, OPEN_WATER),  # specular
        (-21.0, -27.0, VEG_YES, OPEN_WATER),  # open water wins over vegetation
        (2.0, -10.0, VEG_BUILT_UP, EXCLUDED),  # buildings mimic double bounce
        (-2.0, -12.0, VEG_OTHER, DRY),  # bright but not vegetation: no hidden-flood claim
        (-4.0, -10.0, VEG_YES, DRY),  # bright HH but ratio only 6 dB: volume, not double bounce
        (np.nan, -12.0, VEG_YES, NODATA),
    ],
)
def test_rule_table(hh, hv, veg, expected):
    assert one(hh, hv, veg)[0] == expected


def test_thresholds_are_strict_inequalities():
    # Exactly on a threshold does not pass it (rules.js uses the same operators).
    assert one(T.fv_hh_db, T.fv_hh_db - 10)[0] == DRY
    assert one(T.ow_hh_db, T.ow_hv_db - 5, VEG_OTHER)[0] == DRY


def test_confidence_margins():
    assert one(-2.0, -12.0) == (FLOODED_VEG, 1)
    assert one(-4.5, -12.0) == (FLOODED_VEG, 0)  # 0.5 dB above fv_hh: inside the margin
    assert one(-5.5, -13.0) == (DRY, 0)  # almost met the flooded rule
    assert one(-8.0, -13.0) == (DRY, 1)
    assert one(-2.0, -12.0, spread=3.5) == (FLOODED_VEG, 0)  # mixed window


def test_excluded_has_no_low_confidence():
    assert one(2.0, -10.0, VEG_BUILT_UP, spread=9.0) == (EXCLUDED, 1)


def test_broadcasts_stack_against_static_veg():
    hh = np.full((3, 2, 2), -2.0)
    hv = np.full((3, 2, 2), -12.0)
    veg = np.array([[VEG_YES, VEG_OTHER], [VEG_BUILT_UP, VEG_YES]])
    cls, _ = classify(hh, hv, np.zeros_like(hh), veg, T)
    assert cls.shape == (3, 2, 2)
    assert (cls[:, 0, 0] == FLOODED_VEG).all()
    assert (cls[:, 1, 0] == EXCLUDED).all()


def test_thresholds_must_be_quarter_db():
    with pytest.raises(ValueError):
        Thresholds(fv_hh_db=-5.1)
