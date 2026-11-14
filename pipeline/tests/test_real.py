"""Real-data path (D-01..D-06) end to end on mock files in the documented formats.

The mock GCOV follows docs/04 §2 (paths, UTM grid, file-name pattern). Physics is
planted so the expected answer is known: the west half floods under forest on the
2nd and 3rd pass, a river channel is open water throughout, C-band sees only the river.
"""

import json
from datetime import date, timedelta
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from canopy import config, geo, io_gcov, real
from canopy.build import build_site
from canopy.config import EXCLUDED, FLOODED_VEG, OPEN_WATER

h5py = pytest.importorskip("h5py")
rasterio = pytest.importorskip("rasterio")
from rasterio.transform import from_origin  # noqa: E402

SITE = {
    "id": "mock",
    "name": "Mock basin",
    "country": "US",
    "bbox": [-91.78, 30.17, -91.62, 30.31],
    "zoom": 12,
    "gauge": {"id": "MOCK-1", "name": "Mock gauge", "source_name": "test CSV"},
}
EPSG = 32615
DAYS = [date(2026, 7, 1), date(2026, 7, 13), date(2026, 7, 25)]
RIVER = (-91.705, -91.700)
FLOOD_WEST_OF = -91.70
BUILT = (-91.645, -91.63, 30.29, 30.30)  # w, e, s, n


def _name(day: date, track: int = 123, direction: str = "A") -> str:
    d = day.strftime("%Y%m%d")
    return (
        f"NISAR_L2_PR_GCOV_005_{track:03d}_{direction}_045_4005_DHDH_A_"
        f"{d}T120000_{d}T120030_X05007_N_F_J_001.h5"
    )


def _gcov(path, day_index: int, rng):
    xmin, ymin, xmax, ymax = geo.utm_bounds_of(SITE["bbox"], EPSG)
    x = np.arange(xmin - 400, xmax + 400, 20.0) + 10
    y = np.arange(ymax + 400, ymin - 400, -20.0) - 10
    lon, _ = geo.utm_to_lonlat(*np.meshgrid(x, y), EPSG)
    hh = np.full(lon.shape, -8.0)
    hv = np.full(lon.shape, -13.0)
    if day_index > 0:
        west = lon < FLOOD_WEST_OF
        hh[west], hv[west] = -2.0, -12.0
    river = (lon > RIVER[0]) & (lon < RIVER[1])
    hh[river], hv[river] = -21.0, -27.0
    looks = 4
    hh_lin = 10 ** (hh / 10) * rng.gamma(looks, 1 / looks, hh.shape)
    hv_lin = 10 ** (hv / 10) * rng.gamma(looks, 1 / looks, hv.shape)
    mask = np.ones(hh.shape, dtype=np.uint8)
    mask[:40, :40] = io_gcov.MASK_FILL
    g = io_gcov.GRID_GROUP
    with h5py.File(path, "w") as f:
        f[f"{g}/HHHH"] = hh_lin.astype(np.float32)
        f[f"{g}/HVHV"] = hv_lin.astype(np.float32)
        f[f"{g}/xCoordinates"] = x
        f[f"{g}/yCoordinates"] = y
        f[f"{g}/projection"] = np.uint32(EPSG)
        f[f"{g}/mask"] = mask


def _geotiff(path, data, transform, epsg, nodata=None):
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=data.shape[1],
        height=data.shape[0],
        count=1,
        dtype=data.dtype,
        crs=f"EPSG:{epsg}",
        transform=transform,
        nodata=nodata,
    ) as dst:
        dst.write(data, 1)


@pytest.fixture(scope="module")
def raw(tmp_path_factory):
    root = tmp_path_factory.mktemp("raw")
    site_dir = root / SITE["id"]
    rng = np.random.default_rng(7)
    (site_dir / "gcov").mkdir(parents=True)
    for i, d in enumerate(DAYS):
        _gcov(site_dir / "gcov" / _name(d), i, rng)
    _gcov(site_dir / "gcov" / _name(date(2026, 7, 5), track=77, direction="D"), 0, rng)

    # WorldCover-like: trees, a river channel, a built-up block.
    res = 0.0005
    w, s, e, n = -91.79, 30.16, -91.61, 30.32
    cols, rows = int((e - w) / res), int((n - s) / res)
    lon = w + (np.arange(cols) + 0.5) * res
    lat = n - (np.arange(rows) + 0.5) * res
    lon_g, lat_g = np.meshgrid(lon, lat)
    wc = np.full((rows, cols), 10, dtype=np.uint8)
    wc[(lon_g > RIVER[0]) & (lon_g < RIVER[1])] = 80
    bw, be, bs, bn = BUILT
    wc[(lon_g > bw) & (lon_g < be) & (lat_g > bs) & (lat_g < bn)] = 50
    (site_dir / "worldcover").mkdir()
    _geotiff(site_dir / "worldcover" / "wc.tif", wc, from_origin(w, n, res, res), 4326)

    # DSWx-S1-like WTR in UTM 30 m: only the river is water.
    xmin, ymin, xmax, ymax = geo.utm_bounds_of([w, s, e, n], EPSG)
    xs = np.arange(xmin, xmax, 30.0) + 15
    ys = np.arange(ymax, ymin, -30.0) - 15
    lon_u, _ = geo.utm_to_lonlat(*np.meshgrid(xs, ys), EPSG)
    wtr = np.zeros(lon_u.shape, dtype=np.uint8)
    wtr[(lon_u > RIVER[0]) & (lon_u < RIVER[1])] = 1
    (site_dir / "dswx").mkdir()
    for d in (date(2026, 7, 2), date(2026, 7, 14)):  # matches pass 1 and 2; pass 3 has none
        stamp = d.strftime("%Y%m%d")
        name = f"OPERA_L3_DSWx-S1_T15RYP_{stamp}T120000Z_{stamp}T235959Z_S1A_30_v1.0_B01_WTR.tif"
        _geotiff(site_dir / "dswx" / name, wtr, from_origin(xmin, ymax, 30, 30), EPSG, nodata=255)

    with (site_dir / "gauge.csv").open("w") as fh:
        fh.write("date,stage_m\n")
        for i in range(60):
            d = date(2026, 6, 20) + timedelta(days=i)
            fh.write(f"{d.isoformat()},{1 + min(i, 30) * 0.1:.3f}\n")

    pres = 1 / 1200  # ~3 arcsec
    pc, pr = int((e - w) / pres), int((n - s) / pres)
    _geotiff(
        site_dir / "worldpop.tif",
        np.full((pr, pc), 5.0, dtype=np.float32),
        from_origin(w, n, pres, pres),
        4326,
        nodata=-99999,
    )
    osm_payload = {
        "elements": [
            {
                "type": "node",
                "lon": -91.69,
                "lat": 30.24,
                "tags": {"place": "village", "name": "Mockville", "population": "1,200"},
            },
            {
                "type": "way",
                "tags": {"highway": "secondary", "name": "Cross road"},
                "geometry": [{"lon": -91.77, "lat": 30.20}, {"lon": -91.63, "lat": 30.20}],
            },
        ]
    }
    (site_dir / "osm.json").write_text(json.dumps(osm_payload))
    return root


@pytest.fixture(scope="module")
def built(raw, tmp_path_factory):
    scene = real.build_scene(SITE, raw_root=raw, width_px=128)
    out = tmp_path_factory.mktemp("web")
    return scene, build_site(scene, out)


def test_file_name_pattern():
    g = io_gcov.parse_name(_name(DAYS[0]))
    assert g is not None
    assert (g.track, g.direction, g.frame, g.day) == (123, "ascending", 45, DAYS[0])
    assert io_gcov.parse_name("random.h5") is None


def test_one_track_rule(built):
    scene, s = built
    assert scene.track_number == 123 and scene.direction == "ascending"
    assert scene.dates == DAYS
    assert any(
        w["code"] == "extra_tracks_dropped" and "track 77" in w["detail"] for w in s["warnings"]
    )


def test_summary_is_real_and_valid(built):
    _, s = built
    schema = json.loads((config.PIPELINE_DIR / "schema" / "summary.schema.json").read_text())
    jsonschema.validate(s, schema)
    assert s["synthetic"] is False
    assert all(w["code"] != "synthetic_data" for w in s["warnings"])
    assert {src["id"] for src in s["sources"]} >= {"nisar_gcov", "esa_worldcover", "opera_dswx_s1"}


def test_planted_physics_is_recovered(built):
    scene, s = built
    p1, p2, p3 = s["passes"]
    site_km2 = 15.4 * 15.5
    assert p1["flooded_veg_km2"] < 0.02 * site_km2  # dry forest everywhere on pass 1
    assert p2["flooded_veg_km2"] > 0.35 * site_km2  # west half flooded under trees
    assert p2["open_water_km2"] > 0.3  # the river channel
    assert p2["hidden_from_cband_km2"] > 0.3 * site_km2  # C-band saw only the river
    assert p3["cband_date"] is None and p3["hidden_from_cband_km2"] is None


def test_built_up_is_excluded_and_river_is_water(built):
    scene, _ = built
    from canopy.classify import classify

    cls, _ = classify(scene.hh_db, scene.hv_db, scene.spread_db, scene.veg, config.Thresholds())
    h, w = scene.shape
    bw, be, bs, bn = BUILT
    r = int((SITE["bbox"][3] - (bs + bn) / 2) / (SITE["bbox"][3] - SITE["bbox"][1]) * h)
    c = int(((bw + be) / 2 - SITE["bbox"][0]) / (SITE["bbox"][2] - SITE["bbox"][0]) * w)
    assert (cls[:, r, c] == EXCLUDED).all()
    assert (cls[1][:, : w // 3] == FLOODED_VEG).mean() > 0.8
    assert (cls[1] == OPEN_WATER).any()


def test_exposure_from_worldpop_and_osm(built):
    _, s = built
    e = s["exposure"]
    assert e["places"][0]["name"] == "Mockville" and e["places"][0]["population"] == 1200
    assert e["population_near_hidden_flood"] > 0
    assert e["roads_flooded_km"] > 3  # the cross road runs through the flooded west half
    assert s["validation"]["gauge"]["n"] == 3


def test_radiometry_check_drops_a_miscalibrated_pass():
    ok = io_gcov.Window(
        path=Path("ok.h5"),
        hh=np.full((4, 4), 10 ** (-9 / 10)),
        hv=np.full((4, 4), 10 ** (-16 / 10)),
        x=np.arange(4.0),
        y=np.arange(4.0),
        epsg=EPSG,
        track=1,
        direction="ascending",
        day=DAYS[0],
    )
    bad = io_gcov.Window(**{**ok.__dict__, "hh": np.full((4, 4), 10 ** (20 / 10))})
    assert real.radiometry_ok(ok)[0] is True
    good, why = real.radiometry_ok(bad)
    assert good is False and "20.0 dB" in why


def test_dswx_fills_each_pixel_from_the_nearest_covering_date(raw):
    from canopy import io_reference

    tiles = sorted((raw / SITE["id"] / "dswx").glob("*WTR*.tif"))
    codes, used = io_reference.dswx_for_pass(date(2026, 7, 1), tiles, SITE["bbox"], 32, 32, 6)
    assert used == date(2026, 7, 2) and (codes > 0).all()
    codes, used = io_reference.dswx_for_pass(date(2026, 8, 1), tiles, SITE["bbox"], 32, 32, 6)
    assert used is None and (codes == 0).all()


def test_photo_fill_is_transparent_and_not_counted_as_clear(tmp_path):
    from canopy import nasa_inputs

    rgb = np.full((4, 4, 3), 500.0, dtype=np.float32)
    rgb[:, :2] = np.nan  # scene edge: half the site has no pixels
    fmask = np.full((4, 4), 255, dtype=np.uint8)
    fmask[:, 2] = 0  # clear
    fmask[:, 3] = 2  # cloud (bit 1)
    (tmp_path / "nasa").mkdir()
    np.savez(tmp_path / "nasa" / "hls_photo.npz", day="2026-07-03", rgb=rgb, fmask=fmask)
    rgba, day, cloud = nasa_inputs.load_photo(tmp_path)
    assert rgba.shape == (4, 4, 4)
    assert (rgba[:, :2, 3] == 0).all() and (rgba[:, 2:, 3] == 255).all()
    assert cloud == 0.5  # of the covered pixels, not of the whole site


def test_listed_bad_granule_is_dropped_before_the_track_choice(tmp_path):
    """D-112: a granule with normal medians but a broken image is dropped by name."""
    listed = tmp_path / "bad.json"
    listed.write_text(
        json.dumps(
            {"granules": [{"prefix": "NISAR_L2_PR_GCOV_023_060_A_175_", "reason": "streaks"}]}
        )
    )
    entries = real.bad_granules(listed)
    w = io_gcov.Window(
        path=Path("NISAR_L2_PR_GCOV_023_060_A_175_2005_DHDH_A_20260618T095408_x.h5"),
        hh=np.full((4, 4), 10 ** (-9 / 10)),
        hv=np.full((4, 4), 10 ** (-16 / 10)),
        x=np.arange(4.0),
        y=np.arange(4.0),
        epsg=EPSG,
        track=60,
        direction="ascending",
        day=date(2026, 6, 18),
    )
    later = io_gcov.Window(**{**w.__dict__, "path": Path("NISAR_L2_PR_GCOV_028_060_A_175_x.h5")})
    assert real.radiometry_ok(w)[0] is True  # the medians alone would let it through
    assert real.known_bad(w, entries)["reason"] == "streaks"
    assert real.known_bad(later, entries) is None
    assert real.bad_granules(tmp_path / "missing.json") == []


def test_shipped_bad_granule_list_is_well_formed():
    for g in real.bad_granules():
        assert g["prefix"].startswith("NISAR_L2_") and g["reason"] and g["evidence"]
