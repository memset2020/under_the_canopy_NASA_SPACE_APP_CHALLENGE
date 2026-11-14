"""Derived products: areas per pass, hydroperiod, hidden-from-C-band (docs/04 §5–6)."""

from __future__ import annotations

from datetime import date

import numpy as np

from .classify import is_flooded
from .config import DRY, FLOODED_VEG, NOMINAL_REPEAT_DAYS, OPEN_WATER


def pass_weights_days(dates: list[date]) -> np.ndarray:
    """Days each pass represents: midpoint to midpoint; the ends extend half
    the median gap outward (docs/04 §5)."""
    n = len(dates)
    if n == 0:
        return np.zeros(0)
    if n == 1:
        return np.array([float(NOMINAL_REPEAT_DAYS)])
    ordinals = np.array([d.toordinal() for d in dates], dtype=float)
    gaps = np.diff(ordinals)
    if np.any(gaps <= 0):
        raise ValueError("pass dates must be strictly increasing")
    half_med = np.median(gaps) / 2
    w = np.empty(n)
    w[1:-1] = (gaps[:-1] + gaps[1:]) / 2
    w[0] = gaps[0] / 2 + half_med
    w[-1] = gaps[-1] / 2 + half_med
    return w


def hydroperiod_days(cls: np.ndarray, conf: np.ndarray, dates: list[date]) -> np.ndarray:
    """Days flooded per pixel this season; low-confidence passes count half."""
    w = pass_weights_days(dates)[:, None, None]
    weight = np.where(conf == 1, 1.0, 0.5)
    days = (is_flooded(cls) * weight * w).sum(axis=0)
    return np.clip(np.round(days), 0, 255).astype(np.uint8)


def pass_areas(cls: np.ndarray, conf: np.ndarray, area_km2: np.ndarray) -> list[dict]:
    """Per-pass areas (km²) and the low-confidence fraction of classified pixels."""
    out = []
    for c, k in zip(cls, conf, strict=True):
        fv = float(((c == FLOODED_VEG) * area_km2).sum())
        ow = float(((c == OPEN_WATER) * area_km2).sum())
        judged = (c == DRY) | (c == OPEN_WATER) | (c == FLOODED_VEG)
        low = float((judged & (k == 0)).sum() / max(judged.sum(), 1))
        out.append(
            {
                "flooded_veg_km2": round(fv, 3),
                "open_water_km2": round(ow, 3),
                "flooded_km2": round(fv + ow, 3),
                "low_conf_fraction": round(low, 4),
            }
        )
    return out


def hidden_from_cband_km2(
    cls: np.ndarray, conf: np.ndarray, cband: np.ndarray, area_km2: np.ndarray
) -> float | None:
    """High-confidence flooded vegetation that C-band calls not-water (docs/04 §6).

    Only pixels where C-band has valid data count; None when C-band has none.
    """
    if not np.any(cband > 0):
        return None
    hidden = (cls == FLOODED_VEG) & (conf == 1) & (cband == 1)
    return round(float((hidden * area_km2).sum()), 3)


def hidden_low_conf_km2(
    cls: np.ndarray, conf: np.ndarray, cband: np.ndarray, area_km2: np.ndarray
) -> float | None:
    """Low-confidence flooded vegetation that C-band calls not-water: the part the headline
    number leaves out, reported beside it so the uncertainty is visible (v10)."""
    if not np.any(cband > 0):
        return None
    hidden = (cls == FLOODED_VEG) & (conf == 0) & (cband == 1)
    return round(float((hidden * area_km2).sum()), 3)


def peak_index(areas: list[dict]) -> int:
    return int(np.argmax([a["flooded_km2"] for a in areas])) if areas else 0
