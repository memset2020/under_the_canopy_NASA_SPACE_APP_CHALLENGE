"""Glacier atlas (canopy/glaciers.py): flowline, vector rotation, trunk speed, published checks."""

import numpy as np
import pytest

from canopy import glaciers as gl


def straight_glacier(h=40, w=120, v_front=1000.0):
    """Ice flowing east (+x) along rows 15-24, fastest at the east end, slow at the west."""
    east = np.full((h, w), np.nan, np.float32)
    north = np.full((h, w), np.nan, np.float32)
    speed = np.linspace(20, v_front, w)
    east[15:25, :] = speed[None, :]
    north[15:25, :] = 0
    return east, north


def test_trace_upstream_follows_flow_back_to_the_head():
    east, north = straight_glacier()
    pts = gl.trace_upstream(east, north, col=119.0, row=20.0, cell=100.0)
    # Upstream is west: x falls, y stays on the centre row.
    assert pts[0][0] == pytest.approx(119.0)
    assert pts[-1][0] < 15  # stops where speed < 3 % of max (30 m/yr), near the west end
    assert np.allclose(pts[:, 1], 20.0, atol=1e-6)
    assert np.all(np.diff(pts[:, 0]) < 0)


def test_trace_stops_at_the_ice_edge():
    east, north = straight_glacier()
    east[:, :60] = np.nan
    pts = gl.trace_upstream(east, north, col=119.0, row=20.0, cell=100.0)
    assert pts[-1][0] >= 59


def test_extend_and_resample_measure_distance_from_the_new_start():
    east, north = straight_glacier()
    up = gl.trace_upstream(east, north, col=110.0, row=20.0, cell=100.0)
    pts = gl.extend_down(up, km=0.5, cell=100.0)
    # 0.5 km beyond the front, straight on (east), at half-cell steps.
    assert pts[0][0] == pytest.approx(115.0, abs=0.01)
    line, km = gl.resample_line(pts, cell=100.0, n=50)
    assert km[0] == 0
    assert km[-1] == pytest.approx((pts[0][0] - pts[-1][0]) * 0.1, rel=1e-6)
    assert line[0][0] == pytest.approx(pts[0][0])


def test_east_north_rotates_polar_grid_vectors_to_true_north():
    # EPSG:3413 (north polar stereographic, lon_0 45 W): the 45 W meridian runs from the pole
    # down the grid's -y axis, so at 45 W grid +y points north (to the pole); at 135 E, south.
    from rasterio.warp import transform as warp

    for lon, expect_north in ((-45.0, 1.0), (135.0, -1.0)):
        x, y = warp("EPSG:4326", "EPSG:3413", [lon], [70.0])
        xs, ys = np.array([x[0] - 50, x[0] + 50]), np.array([y[0] + 50, y[0] - 50])
        vx = np.zeros((2, 2), np.float32)
        vy = np.full((2, 2), 100.0, np.float32)
        e, n = gl.east_north(vx, vy, xs, ys, "EPSG:3413")
        assert np.hypot(e, n) == pytest.approx(np.full((2, 2), 100.0), rel=1e-4)
        assert np.sign(n).mean() == pytest.approx(expect_north)
        assert np.abs(e).max() < 1.0


def test_trunk_series_needs_half_the_trunk_measured():
    mean = np.array([100, 900, 1000, 950, 300], float)  # trunk: >= 500 -> indices 1-3
    hov = np.array([[90, 880, 1010, np.nan, 280], [np.nan, np.nan, 990, np.nan, np.nan]], float)
    err = np.full_like(hov, 30.0)
    out = gl.trunk_series(hov, err, mean)
    assert out[0]["v"] == pytest.approx(945.0)
    assert out[0]["cover"] == pytest.approx(0.67, abs=0.01)
    assert out[1] is None


def test_check_published_speed_and_trend():
    years = [2001, 2002, 2003, 2004]
    dist = np.linspace(0, 20, 21)
    hov = np.full((4, 21), 500.0)
    hov[2, 2] = 12000  # 2003, 2 km above the front
    hov[3, :] = 800
    trunk = [{"v": 500}, {"v": 500}, {"v": 600}, {"v": 800}]
    c = gl.check_published(
        {"what": "x", "year": 2003, "m_yr": 12600, "where": "front", "source": "s"},
        years,
        hov,
        dist,
        0.0,
        trunk,
    )
    assert c["itslive_m_yr"] == 12000 and c["agrees"] is True
    c = gl.check_published(
        {
            "what": "x",
            "year": 2004,
            "trend": "faster",
            "since": 2001,
            "where": "front",
            "source": "s",
        },
        years,
        hov,
        dist,
        0.0,
        trunk,
    )
    assert c["change_pct"] == 60 and c["agrees"] is True
    # A year not measured falls back to the nearest within two years.
    c = gl.check_published(
        {"what": "x", "year": 2006, "m_yr": 800, "where": "trunk", "source": "s"},
        years,
        hov,
        dist,
        0.0,
        trunk,
    )
    assert c["itslive_year"] == 2004 and c["agrees"] is True


def test_pack_round_trips_and_marks_nodata():
    a = np.array([[0.0, 12.34, np.nan], [-5.5, 30000.0, 1.0]], np.float32)
    sc = gl._scale_for(a, True, 0.1)
    assert sc == pytest.approx(1.0)  # 30000 does not fit at 0.1 m/yr a step
    q = gl._pack(a, sc, True).view(np.int16)
    assert q[0, 2] == -32768
    assert q[1, 1] == 30000 and q[1, 0] == -6  # -5.5 rounds to even
    u = gl._pack(np.array([1.25, np.nan]), 0.1, False)
    assert u.tolist() == [12, 65535]


def test_merc_grid_matches_the_box():
    w, h, tr = gl.merc_grid([-50.3, 68.98, -48.7, 69.3], 480)
    assert max(w, h) == 480
    from rasterio.warp import transform as warp

    lon, lat = warp("EPSG:3857", "EPSG:4326", [tr.c, tr.c + tr.a * w], [tr.f, tr.f + tr.e * h])
    assert lon == pytest.approx([-50.3, -48.7], abs=1e-6)
    assert lat == pytest.approx([69.3, 68.98], abs=1e-6)


def test_config_is_complete():
    cfg = gl.load()
    ids = [s["id"] for s in cfg["sites"]]
    assert len(ids) == len(set(ids)) >= 25
    for s in cfg["sites"]:
        w, so, e, n = s["bbox"]
        assert w < e and so < n
        assert w <= s["front"][0] <= e and so <= s["front"][1] <= n
        assert s["grace"] in cfg["grace_regions"]
        for p in s.get("published", []):
            assert (
                ("m_yr" in p) != ("trend" in p) and p["source"] and p["url"].startswith("https://")
            )
