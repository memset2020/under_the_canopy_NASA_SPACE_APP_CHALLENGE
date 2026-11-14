"""Independent checks: river-gauge correlation (docs/04 §7)."""

from __future__ import annotations

from datetime import date, timedelta

import numpy as np
from numpy.typing import ArrayLike

MIN_PASSES_FOR_R = 6
MAX_LAG_DAYS = 12


def pearson(x: ArrayLike, y: ArrayLike) -> float | None:
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    ok = np.isfinite(x) & np.isfinite(y)
    if ok.sum() < 3:
        return None
    x, y = x[ok], y[ok]
    sx, sy = x.std(), y.std()
    if sx == 0 or sy == 0:
        return None
    return float(((x - x.mean()) * (y - y.mean())).mean() / (sx * sy))


def gauge_validation(
    dates: list[date], flooded_km2: list[float], daily: list[tuple[date, float]]
) -> dict:
    """r at lag 0 plus the best positive-correlation lag within ±12 days.

    Lag L means area at pass date d is compared with stage at d − L days, so a
    positive lag says the floodplain responds after the river rises.
    """
    stage = dict(daily)
    area = np.asarray(flooded_km2, dtype=float)

    def stages_at(lag: int) -> np.ndarray:
        return np.array([stage.get(d - timedelta(days=lag), np.nan) for d in dates])

    s0 = stages_at(0)
    n = int(np.isfinite(s0).sum())
    r0 = pearson(area, s0)
    best_lag, best_r = 0, r0
    for lag in range(-MAX_LAG_DAYS, MAX_LAG_DAYS + 1):
        r = pearson(area, stages_at(lag))
        if r is not None and (best_r is None or r > best_r):
            best_lag, best_r = lag, r

    series = [
        {
            "date": d.isoformat(),
            "stage_m": None if not np.isfinite(s) else round(float(s), 3),
            "flooded_km2": round(float(a), 3),
        }
        for d, s, a in zip(dates, s0, area, strict=True)
    ]
    return {
        "series": series,
        "r": None if r0 is None else round(r0, 3),
        "n": n,
        "best_lag_days": best_lag,
        "r_best": None if best_r is None else round(best_r, 3),
        "enough_passes": n >= MIN_PASSES_FOR_R,
    }
