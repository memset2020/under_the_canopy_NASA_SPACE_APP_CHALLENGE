"""Why a level-change pair has no map (canopy/build.py level_diagnosis, docs/10 D-081)."""

from types import SimpleNamespace

import numpy as np

from canopy.build import level_diagnosis
from canopy.config import DRY, FLOODED_VEG


def pair(phase, coherence):
    return SimpleNamespace(phase_rad=phase, coherence=coherence)


def test_no_phase_over_the_box():
    cls = np.full((10, 10), FLOODED_VEG)
    d = level_diagnosis(pair(np.full((10, 10), np.nan), np.ones((10, 10))), cls, cls)
    assert d["empty_reason"] == "no_phase"
    assert level_diagnosis(pair(None, None), cls, cls)["empty_reason"] == "no_phase"


def test_no_coherent_dry_ground_to_reference():
    cls = np.full((10, 10), FLOODED_VEG)
    d = level_diagnosis(pair(np.zeros((10, 10)), np.ones((10, 10))), cls, cls)
    assert d["empty_reason"] == "no_reference"
    assert d["flooded_px"] == 100


def test_too_few_pixels_flooded_on_both_passes_and_a_good_pair():
    cls = np.full((20, 20), DRY)
    cls[:2, :5] = FLOODED_VEG  # 10 flooded pixels: under the 20 the rule needs
    ph, coh = np.zeros((20, 20)), np.ones((20, 20))
    assert level_diagnosis(pair(ph, coh), cls, cls)["empty_reason"] == "too_few_flooded"
    cls[:5, :10] = FLOODED_VEG  # 50 flooded pixels and plenty of dry reference
    d = level_diagnosis(pair(ph, coh), cls, cls)
    assert d["empty_reason"] is None and d["flooded_px"] == 50 and d["phase_share"] == 1.0
