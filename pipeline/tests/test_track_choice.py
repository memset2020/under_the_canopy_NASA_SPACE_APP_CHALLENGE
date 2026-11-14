"""Track choice prefers passes that actually image the box (docs/10 D-064)."""

from datetime import date
from pathlib import Path

import numpy as np

from canopy import fetch, real
from canopy.io_gcov import Window

NAME = (
    "NISAR_L2_PR_GCOV_030_{track:03d}_A_025_2005_DHDH_M_{d}T110654_{d}T110729_P05023_N_F_J_001.h5"
)


class _Result:
    def __init__(self, track: int, d: str):
        self.properties = {"fileName": NAME.format(track=track, d=d), "pathNumber": track}


BOX = (-93.0, 46.0, -92.9, 46.1)


def _window(track: int, d: str, valid: float) -> Window:
    from canopy import geo

    xmin, ymin, xmax, ymax = geo.utm_bounds_of(BOX, 32615)
    x = np.linspace(xmin, xmax, 256)
    y = np.linspace(ymax, ymin, 256)
    hh = np.ones((256, 256))
    hh[:, : int(round(256 * (1 - valid)))] = np.nan  # the swath edge leaves a strip empty
    day = date.fromisoformat(f"{d[:4]}-{d[4:6]}-{d[6:]}")
    return Window(
        Path(NAME.format(track=track, d=d)), hh, hh.copy(), x, y, 32615, track, "ascending", day
    )


DAYS = [f"202607{d:02d}" for d in range(1, 10)]


def test_plan_prefers_a_complete_group_over_one_more_cut_pass(monkeypatch):
    results = [_Result(76, d) for d in DAYS] + [_Result(148, d) for d in DAYS[:8]]
    monkeypatch.setattr(fetch, "_search", lambda *a, **k: results)
    valid = {76: 0.7, 148: 1.0}
    group, chosen = fetch.plan_gcov(
        {"bbox": [0, 0, 1, 1]}, probe=lambda fr: valid[fr[0].properties["pathNumber"]]
    )
    assert group[0] == 148 and len(chosen) == 8


def test_plan_stops_probing_when_the_top_group_is_complete(monkeypatch):
    results = [_Result(76, d) for d in DAYS] + [_Result(148, d) for d in DAYS[:8]]
    monkeypatch.setattr(fetch, "_search", lambda *a, **k: results)
    probed = []
    group, _ = fetch.plan_gcov({"bbox": [0, 0, 1, 1]}, probe=lambda fr: probed.append(fr) or 1.0)
    assert group[0] == 76 and len(probed) == 1


def test_plan_never_trades_down_below_the_pass_minimum(monkeypatch):
    results = [_Result(140, d) for d in DAYS[:7]] + [_Result(132, d) for d in DAYS[:5]]
    monkeypatch.setattr(fetch, "_search", lambda *a, **k: results)
    group, _ = fetch.plan_gcov(
        {"bbox": [0, 0, 1, 1]},
        probe=lambda fr: 0.69 if fr[0].properties["pathNumber"] == 140 else 1.0,
    )
    assert group[0] == 140  # 5 complete passes cannot be validated; keep 7 cut ones and say so


def test_build_keeps_the_group_with_most_imaged_passes():
    windows = [_window(76, d, 0.7) for d in DAYS] + [_window(148, d, 1.0) for d in DAYS[:8]]
    kept, dropped = real.select_track(windows, BOX)
    assert {w.track for w in kept} == {148} and len(kept) == 8
    assert any("track 76" in d for d in dropped)


def test_two_frames_of_one_date_union_to_one_full_pass_and_overlap_is_not_double_counted():
    from canopy import io_gcov

    top, bottom = _window(17, DAYS[0], 1.0), _window(17, DAYS[0], 1.0)
    top.hh[128:], bottom.hh[:128] = np.nan, np.nan  # each frame covers half the box
    halves = [io_gcov.coverage_mask(w, BOX) for w in (top, bottom)]
    assert all(0.4 < m.mean() < 0.6 for m in halves)
    assert np.logical_or(*halves).mean() > 0.95
    # Two copies of the same half do not make a whole.
    assert np.logical_or(halves[0], halves[0]).mean() < 0.6


def test_no_radar_stripes_only_paint_empty_pixels():
    from canopy import png

    rgba = np.zeros((12, 12, 4), np.uint8)
    rgba[0, 0] = (0, 114, 178, 220)  # mapped water stays as it is
    no_radar = np.zeros((12, 12), bool)
    no_radar[:, :6] = True
    back = png.decode_png(png.encode_png(png.stripe_no_radar(rgba, no_radar)))
    assert tuple(back[0, 0]) == (0, 114, 178, 220)
    assert (back[:, 6:, 3] == 0).all() and (back[:, :6, 3] > 0).any()


def test_build_prefers_a_complete_group_even_with_one_date_fewer():
    # Peru hotspot, real numbers: track 17 has 8 dates at 87 %, track 118 has 7 at 100 %.
    windows = [_window(17, d, 0.87) for d in DAYS[:8]] + [_window(118, d, 1.0) for d in DAYS[:7]]
    kept, _ = real.select_track(windows, BOX)
    assert {w.track for w in kept} == {118}
