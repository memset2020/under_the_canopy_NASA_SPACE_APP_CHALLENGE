"""GNSS checks (canopy/gnss.py): NGL file parsing and the rates, on inputs with known answers."""

from datetime import date

import numpy as np

from canopy import gnss

HEAD = (
    "site YYMMMDD yyyy.yyyy __MJD week d reflon _e0(m) __east(m) ____n0(m) _north(m) u0(m) "
    "____up(m) _ant(m) sig_e(m) sig_n(m) sig_u(m) __corr_en __corr_eu __corr_nu _latitude(deg) "
    "_longitude(deg) __height(m)\n"
)


def tenv3(days: int, up_m_per_day: float) -> str:
    rows = [HEAD]
    mjd0 = 61165  # 2026-05-05
    for k in range(days):
        up = 0.2 + up_m_per_day * k
        rows.append(
            f"MMX1 26MAY05 2026.3 {mjd0 + k} 2417 2 -99.1 3319 0.66 2149449 0.83 2236 {up:.6f} "
            "0.0 0.001 0.001 0.003 0.0 0.0 0.0 19.4316533 -99.0683894 2236.2\n"
        )
    return "".join(rows)


def test_a_tenv3_file_gives_dates_positions_and_place():
    s = gnss.parse_tenv3(tenv3(3, -0.001))
    assert gnss.from_day_number(s["days"][0]) == date(2026, 5, 5)
    assert np.allclose(s["u"], 2236 + 0.2 - 0.001 * np.arange(3))
    assert np.isclose(s["e"][0], 3319.66) and np.isclose(s["lat"], 19.4316533)


def test_rate_and_summary_over_the_radar_window():
    s = gnss.parse_tenv3(tenv3(150, -0.30 / 365.25))  # sinking 30 cm a year
    out = gnss.summarise(s, date(2026, 5, 5), date(2026, 9, 26))
    assert out["period"] == "same" and out["days"] == 145
    assert np.isclose(out["rate_u_cm_yr"], -30.0, atol=0.01)
    series = gnss.series_since(s, date(2026, 5, 5), date(2026, 9, 26))
    assert series[0][0] == "2026-05-02" or series[0][0] == "2026-05-05"
    assert abs(series[-1][3] - (-30.0 * 144 / 365.25)) < 0.5


def test_a_station_that_ended_long_before_is_left_out():
    s = gnss.parse_tenv3(tenv3(400, 0.0))
    assert gnss.summarise(s, date(2030, 1, 1), date(2030, 6, 1)) is None


def test_stations_in_a_box_accept_both_longitude_conventions():
    llh = "MMX1 19.43 -99.07 2236\nFAR1 10.0 20.0 0\nEAST 19.40 260.90 2200\n"
    ids = [s["id"] for s in gnss.stations_in([-99.3, 19.15, -98.85, 19.65], llh)]
    assert ids == ["MMX1", "EAST"]
