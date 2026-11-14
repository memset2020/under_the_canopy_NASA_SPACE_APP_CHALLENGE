from datetime import date, timedelta

import numpy as np

from canopy import products, raster, validate
from canopy.config import DRY, FLOODED_VEG, OPEN_WATER


def test_quantise_roundtrip_is_exact_on_quarter_db():
    db = np.array([-49.75, -16.0, -5.25, 0.0, 13.75])
    assert np.array_equal(raster.dequantize_db(raster.quantize_db(db)), db)


def test_quantise_nodata_and_clip():
    q = raster.quantize_db(np.array([np.nan, -80.0, 40.0]))
    assert q.tolist() == [0, 1, 255]
    assert np.isnan(raster.dequantize_db(q)[0])


def test_boxcar_averages_linear_power_not_db():
    lin = np.ones((3, 3))
    lin[1, 1] = 10.0
    out = raster.boxcar3(lin)
    assert np.isclose(out[1, 1], 18 / 9)  # mean of linear values


def test_boxcar_ignores_nan_neighbours():
    lin = np.ones((3, 3))
    lin[0, 0] = np.nan
    out = raster.boxcar3(lin)
    assert np.isnan(out[0, 0]) and np.isclose(out[1, 1], 1.0)


def test_pixel_area_shrinks_with_latitude():
    a = raster.pixel_area_km2((0, 0, 1, 60), 60, 1)
    assert a[0, 0] < a[-1, 0]  # northern row is smaller


def test_pass_weights_sum_to_season_and_handle_one_pass():
    dates = [date(2026, 6, 1) + timedelta(days=12 * i) for i in range(5)]
    w = products.pass_weights_days(dates)
    assert np.isclose(w.sum(), 12 * 5)
    assert products.pass_weights_days(dates[:1]).tolist() == [12.0]


def test_hydroperiod_counts_low_confidence_half():
    dates = [date(2026, 6, 1) + timedelta(days=12 * i) for i in range(3)]
    cls = np.array([[[FLOODED_VEG]], [[OPEN_WATER]], [[DRY]]], dtype=np.uint8)
    conf = np.array([[[1]], [[0]], [[1]]], dtype=np.uint8)
    assert products.hydroperiod_days(cls, conf, dates)[0, 0] == 12 + 6


def test_hidden_from_cband_needs_high_confidence_and_cband_dry():
    cls = np.array([[FLOODED_VEG, FLOODED_VEG, FLOODED_VEG, OPEN_WATER]], dtype=np.uint8)
    conf = np.array([[1, 0, 1, 1]], dtype=np.uint8)
    cband = np.array([[1, 1, 2, 1]], dtype=np.uint8)
    area = np.ones((1, 1))
    assert products.hidden_from_cband_km2(cls, conf, cband, area) == 1.0
    assert products.hidden_from_cband_km2(cls, conf, np.zeros_like(cband), area) is None


def test_gauge_validation_finds_lag():
    start = date(2026, 4, 1)
    daily = [(start + timedelta(days=i), float(np.sin(i / 20))) for i in range(200)]
    dates = [start + timedelta(days=20 + 12 * i) for i in range(12)]
    stage = dict(daily)
    area = [stage[d - timedelta(days=5)] * 10 + 50 for d in dates]
    g = validate.gauge_validation(dates, area, daily)
    assert g["best_lag_days"] == 5 and g["r_best"] > 0.999
    assert g["n"] == 12 and g["enough_passes"]


def test_pearson_degenerate_inputs():
    assert validate.pearson([1, 2], [1, 2]) is None
    assert validate.pearson([1, 1, 1], [1, 2, 3]) is None
