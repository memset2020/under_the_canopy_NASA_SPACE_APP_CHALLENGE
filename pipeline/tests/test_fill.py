"""D-101: a swath gap on the site's own track is filled from another track's nearest pass."""

from datetime import date
from pathlib import Path

import numpy as np

from canopy import fetch, geo, io_gcov, real

BOUNDS = (-60.36, -3.5, -60.2, -3.36)
EPSG = 32721
H, W = 32, 36


def _window(day: date, track: int, direction: str, hh_db: float, hv_db: float, west_empty: bool):
    xmin, ymin, xmax, ymax = geo.utm_bounds_of(BOUNDS, EPSG)
    x = np.arange(xmin - 200, xmax + 200, 100.0) + 50
    y = np.arange(ymax + 200, ymin - 200, -100.0) - 50
    lon, _ = geo.utm_to_lonlat(*np.meshgrid(x, y), EPSG)
    hh = np.full(lon.shape, 10 ** (hh_db / 10))
    hv = np.full(lon.shape, 10 ** (hv_db / 10))
    if west_empty:  # the swath edge: no radar west of the box's middle
        hh[lon < -60.28] = np.nan
        hv[lon < -60.28] = np.nan
    d = day.strftime("%Y%m%d")
    name = (
        f"NISAR_L2_PR_GCOV_023_{track:03d}_{direction[0].upper()}_090_4005_DHDH_A_"
        f"{d}T221633_{d}T221711_P05023_N_F_J_001.h5"
    )
    return io_gcov.Window(Path(name), hh, hv, x, y, EPSG, track, direction, day)


def _own(day):
    return _window(day, 140, "descending", -8.0, -14.0, west_empty=True)


def test_gap_filled_from_nearest_other_pass_with_levels_matched():
    days_own = [date(2026, 6, 23), date(2026, 7, 5)]
    days, hh, hv, sp = real.stack_passes([_own(d) for d in days_own], BOUNDS, H, W)
    gap_before = ~np.isfinite(hh)
    assert 0.3 < gap_before[0].mean() < 0.7
    # Track 68 is 2 dB brighter everywhere (another look angle); the 18 Jun pass is nearer
    # to 23 Jun than 12 Jul is, and nothing is within 7 days of 5 Jul except 12 Jul.
    others = [
        _window(date(2026, 6, 18), 68, "descending", -6.0, -12.0, west_empty=False),
        _window(date(2026, 7, 12), 68, "descending", -6.0, -12.0, west_empty=False),
    ]
    mask, info = real.fill_gaps(others, BOUNDS, H, W, days, hh, hv, sp)
    assert mask is not None
    assert np.array_equal(mask, gap_before)
    assert np.isfinite(hh).all() and np.isfinite(hv).all()
    # Levels matched over the overlap: filled cells read like the own track (−8 / −14 dB).
    assert np.allclose(hh[mask], -8.0, atol=0.05)
    assert np.allclose(hv[mask], -14.0, atol=0.05)
    assert info[0]["date"] == "2026-06-18" and info[0]["days_apart"] == -5
    assert info[1]["date"] == "2026-07-12" and info[1]["days_apart"] == 7
    assert info[0]["track"] == 68 and abs(info[0]["offset_hh_db"] + 2.0) < 0.05
    assert abs(info[0]["share"] - gap_before[0].mean()) < 1e-3


def test_no_fill_beyond_seven_days_and_none_without_a_gap():
    days, hh, hv, sp = real.stack_passes([_own(date(2026, 6, 23))], BOUNDS, H, W)
    far = [_window(date(2026, 7, 1), 68, "descending", -6.0, -12.0, west_empty=False)]
    mask, info = real.fill_gaps(far, BOUNDS, H, W, days, hh, hv, sp)
    assert mask is None and info == [None]
    assert (~np.isfinite(hh)).any()  # the gap stays, and the map stripes it

    full = _window(date(2026, 6, 23), 140, "descending", -8.0, -14.0, west_empty=False)
    days, hh, hv, sp = real.stack_passes([full], BOUNDS, H, W)
    near = [_window(date(2026, 6, 22), 68, "descending", -6.0, -12.0, west_empty=False)]
    mask, info = real.fill_gaps(near, BOUNDS, H, W, days, hh, hv, sp)
    assert mask is None and info == [None]
    assert np.allclose(hh, -8.0, atol=0.05)  # an imaged pass is never touched


def test_plan_fill_prefers_nearest_date_then_the_track_with_more_passes():
    a = (68, "descending", "2005", "DHDH")
    b = (132, "ascending", "4005", "DHDH")
    own = [date(2026, 6, 23), date(2026, 8, 10), date(2026, 9, 30)]
    cands = [
        (date(2026, 6, 18), a),
        (date(2026, 7, 12), a),
        (date(2026, 8, 10), b),
        (date(2026, 8, 12), a),
        (date(2026, 8, 22), b),
    ]
    plan = fetch.plan_fill(own, cands, max_days=7)
    assert plan[date(2026, 6, 23)] == (date(2026, 6, 18), a)
    assert plan[date(2026, 8, 10)] == (date(2026, 8, 10), b)  # same day beats 2 days
    assert date(2026, 9, 30) not in plan  # nothing within 7 days
