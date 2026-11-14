"""Global 0.25° context grid (docs/03 §4.10): footprints, encoding, Mercator rows."""

import gzip
import json

import numpy as np

from canopy import global_layers as gl


def test_cell_index_corners():
    assert gl.cell_index(-180.0, 90.0) == 0
    assert gl.cell_index(179.99, -89.99) == gl.WIDTH * gl.HEIGHT - 1
    r, c = divmod(int(gl.cell_index(-60.28, -3.43)), gl.WIDTH)
    assert (r, c) == (int((90 + 3.43) / 0.25), int((180 - 60.28) / 0.25))


def test_polygon_cells_covers_a_one_degree_box():
    ring = np.array([[10, 0], [11, 0], [11, 1], [10, 1], [10, 0]], dtype=float)
    cells = gl.polygon_cells(ring)
    assert cells.size == 16  # 4 × 4 cells of 0.25°
    wrap = np.array([[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]], dtype=float)
    assert gl.polygon_cells(wrap).size == 0  # antimeridian footprints are skipped


def _granule(track, day, pole="DHDH"):
    when = f"202607{day:02d}T0000"
    return (
        f"NISAR_L2_PR_GCOV_010_{track:03d}_A_050_4005_{pole}_A_{when}00_{when}20_P05023_F_P_J_001"
    )


def test_nisar_layers_counts_passes_per_track_and_needs_hv(tmp_path):
    box = [[10, 0], [10.5, 0], [10.5, 0.5], [10, 0.5], [10, 0]]
    granules = [[_granule(1, d), box] for d in (1, 13, 25)]
    granules += [[_granule(2, 5), box]]
    granules += [[_granule(3, 7, pole="SHSH"), box]]  # HH only: unusable
    granules += [[_granule(1, 1).replace("_050_", "_051_"), box]]  # 2nd frame, same pass
    p = tmp_path / "f.json.gz"
    with gzip.open(p, "wt") as f:
        json.dump({"start": "2026-06-17", "end": "2026-10-07", "granules": granules}, f)
    out = gl.nisar_layers(p)
    r, c = divmod(int(gl.cell_index(10.1, 0.4)), gl.WIDTH)
    assert out["nisar_best_track_passes"][r, c] == 3
    assert out["nisar_hv_passes"][r, c] == 4
    assert out["nisar_first_day"][r, c] == 14  # 1 Jul − 17 Jun
    assert out["nisar_last_day"][r, c] == 38


def test_encode_round_trips_documented_encodings():
    assert gl.encode(np.array([0, 55.4, np.nan]), "percent").tolist() == [0, 55, 255]
    assert gl.encode(np.array([21.3]), "half_m").tolist() == [43]
    q = gl.encode(np.array([0, 9, 1_000_000]), "log_people")
    people = np.round(10 ** (q / 25) - 1)
    assert people[0] == 0 and abs(people[2] - 1e6) / 1e6 < 0.05


def test_likely_needs_forest_and_a_water_sign():
    forest = np.array([80, 80, 80, 10])
    c = gl.likely_class(
        forest, np.array([0, 15, 0, 50]), np.array([5, 5, np.nan, 90]), np.array([0, 0, 20, 80])
    )
    assert c.tolist() == [1, 2, 2, 0]


def test_mercator_rows_put_the_equator_in_the_middle():
    g = np.zeros((gl.HEIGHT, 4))
    g[: gl.HEIGHT // 2] = 1  # northern hemisphere
    m = gl.to_mercator(g, height=100)
    assert m[:50].all() and not m[50:].any()


def test_bivariate_puts_forest_rows_and_water_columns():
    forest = np.array([10, 50, 90, 90, 90])
    wet = np.array([0, 0, 0, 6, 12])  # 0.6× and 1.2× the wetland threshold
    z = np.zeros(5)
    c = gl.bivariate_class(forest, wet, z, z)
    assert c.tolist() == [0, 3, 6, 7, 8]  # amber corner (8) = the screening rule's "likely"


def test_log_mg_round_trips_within_three_percent():
    v = np.array([0, 0.05, 1, 143.5, 430, np.nan])
    q = gl.encode(v, "log_mg")
    assert q[0] == 0 and q[-1] == gl.NODATA
    back = 10 ** (q[1:5] / 80) - 1
    assert np.all(np.abs(back[1:] - v[2:5]) / v[2:5] < 0.03)
    assert gl.encode(np.array([1e6]), "log_mg")[0] == 254  # clipped, never nodata


def test_cell_areas_add_up_to_the_sphere():
    total = gl.cell_area_m2(0.5, 360).sum() * 720
    assert abs(total / (4 * np.pi * gl.EARTH_R_M**2) - 1) < 1e-9


def test_moved_share_is_zero_for_a_scaled_copy_and_one_for_disjoint_maps():
    area = gl.cell_area_m2(45.0, 4)
    a = np.zeros((4, 8))
    a[1, 2] = 3.0
    b = np.zeros((4, 8))
    b[2, 5] = 1.0
    assert gl.moved_share(a, 2 * a, area) == 0
    assert gl.moved_share(a, b, area) == 1


def test_wetcharts_layers_mean_range_and_uncertainty_axes():
    # Codes ABCD: C (q10) 1 or 3 scales the same map; D (wetland map) 3 or 4 moves it.
    base3 = np.full((4, 8), np.nan)
    base3[1:3] = 0.0
    base3[1, 1] = 10.0
    base4 = base3.copy()
    base4[1, 1], base4[2, 5] = 0.0, 10.0
    members = {"2913": base3, "2933": 2 * base3, "2914": base4, "2934": 2 * base4}
    grids, meta = gl.wetcharts_layers(members, 2021, shape=(8, 16))
    assert grids["mean"].shape == (8, 16)
    assert np.isnan(grids["mean"][0, 0])  # no model land stays no data
    assert grids["mean"][2, 2] == 7.5 and grids["mean"][3, 3] == 7.5  # one cell → 2 × 2
    assert grids["lo"][2, 2] == 0 and grids["hi"][2, 2] == 20
    assert meta["members"] == 4 and meta["year"] == 2021
    assert meta["extent_moved_pct"] == 100.0  # the two wetland maps share no cell
    assert meta["q10_moved_pct"] == 0.0  # same places, different size
    area = gl.cell_area_m2(45.0, 4)
    assert meta["member_total_tg"][0] == round(10 * area[1] * 365 / 1e15, 1)


def test_wetcharts_2021_member_totals_match_the_stated_scale_factors():
    """Science regression on the real file (skipped without it): each member is scaled to a
    global total of 124.5, 166 or 207.5 Tg CH₄ per year (the file's global_scale_factors)."""
    import pytest

    from canopy import config

    pytest.importorskip("rasterio")
    nc = config.RAW_DIR / "_global" / "WetCHARTs" / "WetCHARTs_v1_3_3_2021.nc"
    if not nc.is_file():
        pytest.skip("WetCHARTs 2021 not downloaded")
    members, year, _ = gl.read_wetcharts(nc)
    assert year == 2021 and len(members) == 18
    area = gl.cell_area_m2(0.5, 360)
    for code, ann in members.items():
        tg = np.nansum(ann * area[:, None]) * 365 / 1e15
        stated = {"1": 124.5, "2": 166.0, "3": 207.5}[code[0]]
        assert abs(tg / stated - 1) < 0.03, (code, tg)
