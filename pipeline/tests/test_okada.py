"""Okada (1985) surface motion (canopy/okada.py) against the paper's own check list and the
physics a reader can check by eye."""

import numpy as np
import pytest

from canopy import okada


@pytest.mark.parametrize(
    "u1, u2, want",
    [
        # Okada (1985) Table 2, case 2: x = 2, y = 3, d = 4, δ = 70°, L = 3, W = 2, λ = μ.
        (1, 0, (-8.689e-3, -4.298e-3, -2.747e-3)),  # strike slip
        (0, 1, (-4.682e-3, -3.527e-2, -3.564e-2)),  # dip slip
    ],
)
def test_okadas_check_list_is_reproduced(u1, u2, want):
    got = okada.okada_xy(np.array(2.0), np.array(3.0), 4.0, 70.0, 3.0, 2.0, u1, u2)
    assert np.allclose([float(g) for g in got], want, rtol=2e-4, atol=0)


def test_a_vertical_strike_slip_fault_is_antisymmetric_and_right_lateral():
    # A vertical fault striking north, 1 m of right-lateral slip (rake 180), from 0 to 10 km.
    pts_e = np.array([-5.0, 5.0])
    e, n, u = okada.okada_enu(pts_e, np.zeros(2), 5.0, 0.0, 90.0, 40.0, 10.0, 180.0, 1.0)
    assert np.isclose(n[0], -n[1])  # the two sides move by the same amount, opposite ways
    assert n[1] < 0 < n[0]  # right-lateral: the east side moves south, the west side north
    assert np.allclose(u, 0.0, atol=1e-9) and np.allclose(e, 0.0, atol=1e-9)


def test_motion_fades_with_distance_from_the_fault():
    far = np.array([2.0, 20.0, 200.0])
    _, n, _ = okada.okada_enu(far, np.zeros(3), 5.0, 0.0, 90.0, 40.0, 10.0, 180.0, 1.0)
    assert abs(n[0]) > abs(n[1]) > abs(n[2]) and abs(n[2]) < 0.01


FSP = """% Mw = 7.5 Mo = 2.5e+20 Nm
% Invs : Dx = 10.0 km  Dz = 8.8 km
% SEGMENT # 1: STRIKE = 81.0 deg DIP = 78.0 deg
% Dx = 10.0 km  Dz = 8.8 km
% LAT LON X==EW Y==NS Z SLIP RAKE TRUP RISE SF_MOMENT
  10.4404  -68.7140  -20.6662    0.4855    3.0846   0.5  172.35   8.4   10.5  6.17e+14
  10.4544  -68.6236  -10.6241    2.0497    3.0846   1.0  168.61   6.0   19.5  3.31e+15
"""


def test_fsp_subfaults_and_header_are_read():
    ps = okada.parse_fsp(FSP)
    assert len(ps) == 2 and ps[1]["slip_m"] == 1.0 and ps[0]["strike"] == 81.0
    assert ps[0]["dx_km"] == 10.0 and ps[0]["dz_km"] == 8.8 and ps[0]["segment"] == 1
    assert okada.fsp_header(FSP) == {"mw": 7.5, "moment_nm": 2.5e20}


def test_a_patch_outline_is_its_size_on_the_map():
    p = okada.parse_fsp(FSP)[0]
    ring = np.array(okada.patch_outline(p))
    km_e = (ring[:, 0].max() - ring[:, 0].min()) * 111.32 * np.cos(np.radians(10.44))
    assert 9.0 < km_e < 11.5  # 10 km along a strike of 81°, plus the dip's 1.8 km across
    trace = okada.top_trace(okada.parse_fsp(FSP))
    assert len(trace) == 1 and len(trace[0]) == 4


def test_a_subfault_slips_from_its_rupture_time_over_its_rise_time():
    assert okada.slip_share(4.9, 5.0, 4.0) == 0.0
    assert np.isclose(okada.slip_share(7.0, 5.0, 4.0), 0.5)  # half way through its rise
    assert okada.slip_share(9.0, 5.0, 4.0) == 1.0


def test_the_rupture_frames_release_the_whole_moment_and_end_on_the_static_field():
    p = dict(okada.parse_fsp(FSP)[1], trup_s=2.0, rise_s=4.0, moment_nm=3.0e15)
    lon, lat = np.array([-68.6, -68.5]), np.array([10.5, 10.4])
    frames, released = okada.rupture_frames([p], lon, lat, [0.0, 4.0, 10.0])
    assert np.isclose(released.sum(), 3.0e15)
    assert np.allclose(frames[0], 0.0)
    assert np.allclose(frames[-1], np.stack(okada.patches_enu([p], lon, lat)), atol=1e-6)
