"""Ground that moved (canopy/motion.py): the pure steps, on inputs with known answers."""

from datetime import date

import numpy as np

from canopy import motion as mo

NAME = (
    "NISAR_L2_PR_GUNW_022_162_A_007_023_4000_SH_20260613T100656_20260613T100731_"
    "20260625T100655_20260625T100730_P05023_N_F_J_001"
)


def test_granule_names_give_geometry_frame_and_days():
    g = mo.parse_gunw(NAME)
    assert (g["track"], g["direction"], g["frame"]) == (162, "ascending", "007")
    assert (g["start"], g["end"]) == (date(2026, 6, 13), date(2026, 6, 25))
    assert mo.geom_key(61, "descending") == "061D"
    assert mo.parse_gunw("NISAR_L2_PR_GCOV_x") is None


def test_only_the_largest_coherent_component_is_kept():
    phase = np.arange(6, dtype=float).reshape(2, 3)
    coh = np.array([[0.9, 0.9, 0.1], [0.9, 0.9, 0.9]])
    cc = np.array([[1, 1, 1], [2, 1, 65535]], dtype=np.uint16)
    out = mo.main_component(phase, coh, cc)
    assert np.isfinite(out).tolist() == [[True, True, False], [False, True, False]]


def test_bilinear_is_exact_on_a_plane_and_handles_descending_axes():
    xs = np.array([0.0, 10.0, 20.0])
    ys = np.array([30.0, 20.0, 10.0])  # north-up
    zz = 2 * xs[None, :] + 3 * ys[:, None]
    got = mo.bilinear(xs, ys, zz, np.array([5.0, 12.5]), np.array([25.0, 11.0]))
    assert np.allclose(got, [2 * 5 + 3 * 25, 2 * 12.5 + 3 * 11])


def test_frames_are_tied_by_their_overlap_and_a_lone_frame_is_left_out():
    a = np.full((20, 30), np.nan)
    a[:, :22] = 1.0  # the frame with most data is the base
    b = np.full((20, 30), np.nan)
    b[:, 19:] = 2.5  # shares 3 × 20 = 60 cells with it: too few to tie
    lonely = {
        "phase": b,
        "coherence": np.ones_like(b),
        "e": np.zeros_like(b),
        "n": np.zeros_like(b),
    }
    first = {"phase": a, "coherence": np.ones_like(a), "e": np.zeros_like(a), "n": np.zeros_like(a)}
    out, offsets = mo.join_frames([first, lonely])
    assert offsets == [0.0, None] and np.isnan(out["phase"][0, 25])
    b2 = np.full((20, 30), np.nan)
    b2[:, 10:] = 2.5  # 12 × 20 = 240 shared cells: enough
    out, offsets = mo.join_frames([first, dict(lonely, phase=b2)])
    assert offsets[1] == 1.5 and np.allclose(out["phase"][np.isfinite(out["phase"])], 1.0)
    assert (out["frame"][:, 25] == 1).all() and (out["frame"][:, 0] == 0).all()
    noisy = b2.copy()
    noisy[::2, 10:22] += 4.0  # the overlap disagrees with itself by 4 rad: no single offset
    out, offsets = mo.join_frames([first, dict(lonely, phase=noisy)])
    assert offsets[1] is None and np.isnan(out["phase"][0, 25])


def test_phase_grows_with_range_so_positive_phase_is_motion_away():
    lam = 0.2420
    assert np.isclose(mo.phase_to_cm(4 * np.pi, lam), -lam * 100)  # one cycle = λ/2 of path
    assert mo.phase_to_cm(1.0, lam) < 0


def test_ascending_and_descending_separate_east_from_up():
    de_true, du_true = np.full((3, 4), 12.0), np.full((3, 4), -5.0)
    asc = {"e": np.full((3, 4), 0.62), "u": np.full((3, 4), 0.78)}
    dsc = {"e": np.full((3, 4), -0.60), "u": np.full((3, 4), 0.80)}
    los = [g["e"] * de_true + g["u"] * du_true for g in (asc, dsc)]
    de, du = mo.decompose(los, [asc["e"], dsc["e"]], [asc["u"], dsc["u"]])
    assert np.allclose(de, 12.0) and np.allclose(du, -5.0)
    one, _ = mo.decompose(
        [los[0], np.full((3, 4), np.nan)], [asc["e"], dsc["e"]], [asc["u"], dsc["u"]]
    )
    assert np.isnan(one).all()  # one geometry cannot separate the two


def test_the_longest_consecutive_chain_wins():
    d = lambda m, day: date(2026, m, day)  # noqa: E731
    pairs = [
        {"start": d(6, 3), "end": d(6, 15)},
        {"start": d(6, 15), "end": d(6, 27)},
        {"start": d(6, 15), "end": d(7, 9)},  # a 24-day alternative: the 12-day one is used
        {"start": d(6, 27), "end": d(7, 9)},
        {"start": d(8, 14), "end": d(8, 26)},  # after a gap
    ]
    ch = mo.consecutive_chain(pairs)
    assert [(p["start"], p["end"]) for p in ch] == [
        (d(6, 3), d(6, 15)),
        (d(6, 15), d(6, 27)),
        (d(6, 27), d(7, 9)),
    ]


def test_cumulative_series_and_rate_recover_a_steady_sinking():
    maps = [np.full((2, 2), -0.8) for _ in range(9)]  # 0.8 cm away per 12 days
    maps[3][0, 0] = np.nan  # a pixel lost in one pair stays lost after it
    cum = mo.cumulative(maps)
    assert cum.shape == (10, 2, 2) and np.isclose(cum[-1, 1, 1], -7.2)
    assert np.isnan(cum[4:, 0, 0]).all() and np.isfinite(cum[:4, 0, 0]).all()
    rate = mo.linear_rate(np.arange(10) * 12, cum)
    assert np.isclose(rate[1, 1], -0.8 / 12)
    assert np.isnan(mo.linear_rate(np.arange(10) * 12, cum, min_points=5)[0, 0])  # only 4 points


def test_rate_error_matches_the_scatter_about_the_line():
    rng = np.random.default_rng(3)
    days = np.arange(12) * 12.0
    noise_cm = 0.8
    trials = rng.normal(0, noise_cm, (12, 300, 1)) + (-0.07 * days)[:, None, None]
    se = mo.rate_sigma(days, trials)
    slopes = mo.linear_rate(days, trials)
    want = noise_cm / np.sqrt(((days - days.mean()) ** 2).sum())  # the textbook formula
    assert np.isclose(np.median(se), want, rtol=0.1)
    assert np.isclose(np.std(slopes), want, rtol=0.15)  # and the slopes do scatter that much
    few = trials[:4]
    assert np.isnan(mo.rate_sigma(days[:4], few)).all()


def test_up_and_east_errors_follow_the_geometry():
    e = [np.full((1, 1), 0.62), np.full((1, 1), -0.60)]
    u = [np.full((1, 1), 0.78), np.full((1, 1), 0.80)]
    se, su = mo.decompose_sigma([np.full((1, 1), 1.0)] * 2, e, u)
    # Monte Carlo through decompose itself
    rng = np.random.default_rng(0)
    draws = [rng.normal(0, 1, (1, 4000)) for _ in range(2)]
    de, du = mo.decompose(
        draws, [np.full((1, 4000), x.item()) for x in e], [np.full((1, 4000), x.item()) for x in u]
    )
    assert np.isclose(se.item(), de.std(), rtol=0.05) and np.isclose(su.item(), du.std(), rtol=0.05)
    assert su.item() < se.item()  # steep looks see up better than east


def test_our_map_is_compared_with_points_after_an_offset():
    plane = np.arange(100, dtype=float).reshape(10, 10)
    lon = np.array([0.15, 0.55, 0.85] * 20)
    lat = np.array([0.85, 0.45, 0.15] * 20)
    r = np.floor((1 - lat) * 10).astype(int)
    c = np.floor(lon * 10).astype(int)
    theirs = plane[r, c] - 5.0  # their reference differs by 5 cm
    out = mo.compare_points(plane, [0, 0, 1, 1], lon, lat, theirs)
    assert out["offset_cm"] == 5.0 and out["rms_diff_cm"] == 0.0 and out["slope"] == 1.0


def test_fit_statistics_and_profile_ends():
    obs = np.array([1.0, 2.0, 3.0, np.nan] * 20)
    st = mo.fit_stats(obs, obs + 1.0)
    assert st["rms_resid_cm"] == 1.0 and st["median_resid_cm"] == -1.0 and st["corr"] == 1.0
    a, b = mo.profile_ends({"centre": [10.0, 0.0], "azimuth_deg": 0, "half_km": 11.0574})
    assert a == [10.0, -0.1] and b == [10.0, 0.1]


def test_pairs_wanted_for_an_earthquake_and_for_subsidence():
    d = lambda m, day: date(2026, m, day)  # noqa: E731
    keys = [
        (162, "ascending", d(6, 1), d(6, 13)),
        (162, "ascending", d(6, 13), d(6, 25)),
        (162, "ascending", d(6, 25), d(7, 7)),
        (126, "descending", d(6, 22), d(7, 4)),
    ]
    quake = {"kind": "earthquake", "event_utc": "2026-06-24T22:04:31Z"}
    assert set(mo.wanted_pairs(quake, keys)) == {keys[1], keys[0], keys[3]}
    sinking = {"kind": "subsidence"}
    assert set(mo.wanted_pairs(sinking, keys)) == {keys[0], keys[1], keys[2], keys[3]}


def test_the_event_grid_is_about_res_m():
    ev = {"bbox": [-99.30, 19.15, -98.85, 19.65], "res_m": 100}
    h, w = mo.grid_shape(ev)
    assert (h, w) == (553, 472)
    lon, lat = mo.grid_lonlat(ev)
    assert lon.shape == (h, w) and lat[0, 0] > lat[-1, 0]


def test_the_product_mask_drops_fill_water_and_invalid_sub_swaths():
    codes = np.array([255, 0, 10, 1, 11, 111, 0x0100000C, 0x0100007C, 0x01000000, 12])
    assert mo.mask_valid(codes).tolist() == [
        False,
        False,
        False,
        False,
        True,
        False,
        True,
        False,
        False,
        True,
    ]


def test_height_slope_is_fitted_on_the_hills_only():
    rng = np.random.default_rng(1)
    dem = rng.uniform(2200, 3500, (60, 60))
    phase = 0.002 * dem + rng.normal(0, 0.05, dem.shape)  # weather: 2 mrad per metre
    low = dem < 2300
    phase[low] -= 3.0  # the sinking lakebed, low and flat: it must not bend the fit
    slope = mo.height_slope(phase, dem, dem >= 2400)
    assert abs(slope - 0.002) < 1e-4
    assert mo.height_slope(phase, dem, np.zeros_like(dem, bool)) is None
