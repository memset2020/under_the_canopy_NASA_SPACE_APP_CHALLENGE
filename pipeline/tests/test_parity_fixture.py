"""Writes the fixture that proves web/src/rules.js matches classify.py (task T-05).

The JS test (web/tests/unit/rules.test.js) decodes the same quantised bytes
and must reproduce every class and confidence value exactly.
"""

import json

import numpy as np

from canopy import raster
from canopy.classify import classify
from canopy.config import REPO_ROOT, Thresholds

FIXTURE = REPO_ROOT / "web" / "tests" / "unit" / "fixtures" / "rules_fixture.json"

THRESHOLD_SETS = [
    Thresholds(),
    Thresholds(fv_hh_db=-6.5, fv_ratio_db=5.5, margin_db=0.5),
    Thresholds(ow_hh_db=-18.0, ow_hv_db=-24.0, max_spread_db=2.0, margin_db=2.0),
]


def _cases(rng: np.random.Generator) -> dict[str, np.ndarray]:
    n = 4000
    hh_q = rng.integers(0, 256, n).astype(np.uint8)
    hv_q = rng.integers(0, 256, n).astype(np.uint8)
    # Dense sampling around every threshold, where off-by-one errors live.
    near = rng.integers(0, n, n // 2)
    hh_q[near] = rng.integers(130, 190, near.size)  # -17.5 … -2.5 dB
    hv_q[near] = rng.integers(100, 160, near.size)  # -25 … -10 dB
    sp_q = rng.integers(0, 24, n).astype(np.uint8)
    veg = rng.integers(0, 3, n).astype(np.uint8)
    return {"hh_q": hh_q, "hv_q": hv_q, "sp_q": sp_q, "veg": veg}


def test_write_parity_fixture():
    c = _cases(np.random.default_rng(2026))
    hh = raster.dequantize_db(c["hh_q"])
    hv = raster.dequantize_db(c["hv_q"])
    sp = raster.dequantize_spread(c["sp_q"])
    sets = []
    for t in THRESHOLD_SETS:
        cls, conf = classify(hh, hv, sp, c["veg"], t)
        sets.append({"thresholds": t.to_dict(), "cls": cls.tolist(), "conf": conf.tolist()})
        assert len(np.unique(cls)) == 5  # every class is exercised
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(
        json.dumps({k: v.tolist() for k, v in c.items()} | {"sets": sets}, separators=(",", ":"))
    )
