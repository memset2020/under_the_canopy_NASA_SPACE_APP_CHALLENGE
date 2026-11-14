"""Per-pass flood classification (docs/04 §4).

web/src/rules.js must stay in exact parity with this file (CLAUDE.md rule 4).
Any change here needs a docs/10 line and a regenerated parity fixture.
"""

from __future__ import annotations

import numpy as np

from .config import (
    DRY,
    EXCLUDED,
    FLOODED_VEG,
    NODATA,
    OPEN_WATER,
    VEG_BUILT_UP,
    VEG_YES,
    Thresholds,
)


def classify(
    hh_db: np.ndarray,
    hv_db: np.ndarray,
    spread_db: np.ndarray,
    veg: np.ndarray,
    t: Thresholds,
) -> tuple[np.ndarray, np.ndarray]:
    """Return (class codes, confidence) as uint8 arrays; confidence 0 = low, 1 = high.

    NaN in hh or hv means nodata. Inputs broadcast, so a (P, H, W) stack works
    with an (H, W) veg layer.
    """
    hh_db, hv_db, spread_db, veg = np.broadcast_arrays(hh_db, hv_db, spread_db, veg)
    valid = np.isfinite(hh_db) & np.isfinite(hv_db)
    hh = np.where(valid, hh_db, 0.0)
    hv = np.where(valid, hv_db, 0.0)
    spread = np.nan_to_num(spread_db, nan=0.0)
    ratio = hh - hv
    m = t.margin_db

    # Rule 2: specular reflection, dark in both polarisations.
    open_water = valid & (hh < t.ow_hh_db) & (hv < t.ow_hv_db)
    # Rule 3: buildings make their own double bounce, so we make no flood claim there.
    excluded = valid & ~open_water & (veg == VEG_BUILT_UP)
    # Rule 4: double bounce off water and trunks: bright HH, large HH−HV gap.
    flooded = (
        valid
        & ~open_water
        & ~excluded
        & (veg == VEG_YES)
        & (hh > t.fv_hh_db)
        & (ratio > t.fv_ratio_db)
    )

    cls = np.full(hh.shape, NODATA, dtype=np.uint8)
    cls[valid] = DRY
    cls[open_water] = OPEN_WATER
    cls[excluded] = EXCLUDED
    cls[flooded] = FLOODED_VEG
    dry = cls == DRY

    low = (valid & ~excluded) & (spread > t.max_spread_db)
    low |= open_water & (np.minimum(t.ow_hh_db - hh, t.ow_hv_db - hv) < m)
    low |= flooded & (np.minimum(hh - t.fv_hh_db, ratio - t.fv_ratio_db) < m)
    near_ow = (hh < t.ow_hh_db + m) & (hv < t.ow_hv_db + m)
    near_fv = (veg == VEG_YES) & (hh > t.fv_hh_db - m) & (ratio > t.fv_ratio_db - m)
    low |= dry & (near_ow | near_fv)

    conf = np.where(low, 0, 1).astype(np.uint8)
    return cls, conf


def is_flooded(cls: np.ndarray) -> np.ndarray:
    """Open water or flooded vegetation."""
    return (cls == OPEN_WATER) | (cls == FLOODED_VEG)
