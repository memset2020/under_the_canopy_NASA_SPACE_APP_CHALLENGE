"""The experimental outlook: fit, gating and no extrapolation (canopy/outlook.py)."""

import numpy as np

from canopy import outlook

DAYS = (
    [f"2026-07-{d:02d}" for d in (1, 13, 25)]
    + [f"2026-08-{d:02d}" for d in (6, 18, 30)]
    + ["2026-09-11"]
)


def _passes(qs, a=10.0, b=-20.0, noise=0.0):
    rng = np.random.default_rng(0)
    return [
        {"date": d, "flooded_veg_km2": a * np.log10(q) + b + noise * rng.standard_normal()}
        for d, q in zip(DAYS, qs, strict=True)
    ]


def test_daily_means_skip_blanks():
    got = outlook.daily(
        ["2026-10-07T00:00", "2026-10-07T12:00", "2026-10-08T00:00", "2026-10-08T03:00"],
        [1.0, 3.0, "", 5.0],
    )
    assert got == {"2026-10-07": 2.0, "2026-10-08": 5.0}


def test_fit_recovers_a_log_flow_relation():
    qs = [100, 200, 400, 800, 400, 200, 100]
    f = outlook.fit(_passes(qs), dict(zip(DAYS, qs, strict=True)))
    assert f["n"] == 7 and f["r"] > 0.999
    assert abs(f["slope"] - 10.0) < 1e-6 and abs(f["intercept"] + 20.0) < 1e-6


def test_outlook_is_withheld_on_a_weak_fit_and_never_extrapolates():
    qs = [100, 200, 400, 800, 400, 200, 100]
    flows = dict(zip(DAYS, qs, strict=True))
    doc = {
        "river_id": 1,
        "mean_cms": 300.0,
        "retrospective": flows,
        "forecast": {
            "25p": {"2026-10-08": 90.0, "2026-10-09": 5000.0},
            "med": {"2026-10-08": 100.0, "2026-10-09": 6000.0},
            "75p": {"2026-10-08": 110.0, "2026-10-09": 7000.0},
        },
    }
    good = outlook.outlook(_passes(qs), doc, area_km2=200.0)
    assert good["usable"] is True
    inside, beyond = good["forecast"]
    assert (
        inside["beyond_season"] is False and abs(inside["y50"] - 0.0) < 1e-6
    )  # 10·log10(100) − 20
    assert inside["y_lo"] <= inside["y50"] <= inside["y_hi"]
    assert beyond["beyond_season"] is True and beyond["y50"] is None  # 6000 m³/s was never seen
    weak = outlook.outlook(
        [
            {"date": d, "flooded_veg_km2": v}
            for d, v in zip(DAYS, [5, 1, 4, 2, 5, 1, 3], strict=True)
        ],
        doc,
        200.0,
    )
    assert weak["usable"] is False and weak["forecast"] == []
    # A strong but inverse relation (more flow, less water under the trees) is withheld too.
    inverse = outlook.outlook(_passes(qs, a=-10.0, b=40.0), doc, 200.0)
    assert inverse["fit"]["r"] < -0.999 and inverse["usable"] is False and inverse["forecast"] == []
    assert (
        inverse["withheld"] == "inverse" and weak["withheld"] == "weak" and good["withheld"] is None
    )


def test_water_points_sit_on_permanent_water():
    occ = np.zeros((10, 10))
    occ[2, 3] = 95
    occ[7, 8] = 99
    pts = outlook.water_points(occ, (0.0, 0.0, 1.0, 1.0))
    assert len(pts) == 2
    assert all(0 <= lon <= 1 and 0 <= lat <= 1 for lon, lat in pts)
    assert outlook.water_points(None, (0, 0, 1, 1)) == []
