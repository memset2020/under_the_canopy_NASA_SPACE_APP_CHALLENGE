import numpy as np
import pytest

from canopy import geo


@pytest.mark.parametrize(
    ("lon", "lat"), [(-91.7, 30.24), (91.92, 25.0), (-60.28, -3.43), (-93.0, 30.0)]
)
def test_utm_round_trip_is_submillimetre(lon, lat):
    epsg = geo.utm_epsg_for(lon, lat)
    e, n = geo.lonlat_to_utm(lon, lat, epsg)
    lon2, lat2 = geo.utm_to_lonlat(e, n, epsg)
    assert abs(lon2 - lon) < 1e-8 and abs(lat2 - lat) < 1e-8


def test_utm_matches_proj():
    warp = pytest.importorskip("rasterio.warp")
    from rasterio.crs import CRS

    lon = np.array([-91.78, -91.62, -91.70])
    lat = np.array([30.17, 30.31, 30.24])
    for epsg in (32615, 32616):  # site zone and the neighbouring one
        xs, ys = warp.transform(CRS.from_epsg(4326), CRS.from_epsg(epsg), lon, lat)
        e, n = geo.lonlat_to_utm(lon, lat, epsg)
        assert np.max(np.abs(e - xs)) < 0.01 and np.max(np.abs(n - ys)) < 0.01


def test_utm_south_hemisphere_matches_proj():
    warp = pytest.importorskip("rasterio.warp")
    from rasterio.crs import CRS

    xs, ys = warp.transform(CRS.from_epsg(4326), CRS.from_epsg(32720), [-60.28], [-3.43])
    e, n = geo.lonlat_to_utm(-60.28, -3.43, 32720)
    assert abs(e - xs[0]) < 0.01 and abs(n - ys[0]) < 0.01


def test_zone_parsing():
    assert geo.utm_zone_from_epsg(32615) == (15, True)
    assert geo.utm_zone_from_epsg(32720) == (20, False)
    with pytest.raises(ValueError):
        geo.utm_zone_from_epsg(4326)


def test_accumulator_means_and_mosaics():
    acc = geo.Accumulator(1, 2, 1)
    acc.add(np.array([0, 0, 1]), [np.array([1.0, 3.0, 5.0])])
    acc.add(np.array([1, -1]), [np.array([7.0, 100.0])])  # second granule, one point outside
    assert acc.mean(0).tolist() == [[2.0, 6.0]]
    assert acc.count(0).tolist() == [[2.0, 2.0]]


def test_ease2_matches_proj():
    warp = pytest.importorskip("rasterio.warp")
    from rasterio.crs import CRS

    lon = np.array([91.92, -60.28, -91.7, 0.0, 120.0])
    lat = np.array([25.0, -3.43, 30.24, 60.0, -45.0])
    xs, ys = warp.transform(CRS.from_epsg(4326), CRS.from_epsg(6933), lon, lat)
    x, y = geo.lonlat_to_ease2(lon, lat)
    assert np.max(np.abs(x - xs)) < 0.01 and np.max(np.abs(y - ys)) < 0.01
