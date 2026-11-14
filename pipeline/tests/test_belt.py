"""Belt mode (docs/13, D-057): cell geometry and the compact export."""

import json

from canopy import belt


def test_cell_site_covers_exactly_one_global_cell():
    s = belt.cell_site(411, 469)
    assert s["id"] == "cell_411_0469"
    assert s["bbox"] == [-62.75, -13.0, -62.5, -12.75]
    assert s["belt"] is True


def test_export_keeps_only_the_belt_outputs(tmp_path, monkeypatch):
    monkeypatch.setattr(belt, "BELT_DIR", tmp_path / "belt")
    built = tmp_path / "built"
    (built / "passes").mkdir(parents=True)
    (built / "passes" / "p02_class.png").write_bytes(b"png2")
    (built / "hydroperiod.png").write_bytes(b"hydro")
    summary = {
        "grid": {"bounds": [0, 0, 0.25, 0.25]},
        "peak_pass": "p02",
        "passes": [
            {
                "id": "p01",
                "date": "2026-06-20",
                "class_png": "passes/p01_class.png",
                "flooded_km2": 1.0,
                "flooded_veg_km2": 0.5,
                "hidden_from_cband_km2": None,
            },
            {
                "id": "p02",
                "date": "2026-07-02",
                "class_png": "passes/p02_class.png",
                "flooded_km2": 9.876,
                "flooded_veg_km2": 4.321,
                "hidden_from_cband_km2": 1.5,
            },
        ],
        "products": {
            "hydroperiod": {"png": "hydroperiod.png", "flooded_any_km2": 12.0, "max_days": 30}
        },
        "warnings": [{"code": "hidden_flood_uncalibrated"}, {"code": "no_gauge"}],
    }
    (built / "summary.json").write_text(json.dumps(summary))
    e = belt.export_cell(belt.cell_site(10, 20), built)
    assert e["peak_date"] == "2026-07-02" and e["peak_hidden_km2"] == 4.32
    assert (tmp_path / "belt" / "cell_010_0020" / "peak_class.png").read_bytes() == b"png2"
    doc = belt.write_index()
    assert [c["id"] for c in doc["cells"]] == ["cell_010_0020"]
    assert doc["cells"][0]["warnings"] == ["hidden_flood_uncalibrated", "no_gauge"]
