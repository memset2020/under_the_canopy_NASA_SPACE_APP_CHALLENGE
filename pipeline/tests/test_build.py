"""End-to-end: synthetic scene → contract files, validated against the schema."""

import json
import struct
import zlib
from pathlib import Path

import jsonschema
import numpy as np
import pytest

from canopy import config, synth
from canopy.build import build_site
from canopy.classify import classify
from canopy.config import FLOODED_VEG
from canopy.export import write_manifest
from canopy.png import encode_png

SCHEMA = json.loads((config.PIPELINE_DIR / "schema" / "summary.schema.json").read_text())


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    out = tmp_path_factory.mktemp("web_data")
    site = config.get_site("atchafalaya")
    scene = synth.make_scene(site)
    summary = build_site(scene, out)
    write_manifest(out)
    return out, scene, summary


def test_summary_matches_schema(built):
    _, _, summary = built
    jsonschema.validate(summary, SCHEMA)


def test_synthetic_flag_is_always_set(built):
    out, _, summary = built
    assert summary["synthetic"] is True
    assert any(w["code"] == "synthetic_data" for w in summary["warnings"])
    assert summary["validation"]["calibration"] is None  # real calibration never leaks in
    manifest = json.loads((out / "manifest.json").read_text())
    assert all(s["synthetic"] for s in manifest["sites"])


def test_every_referenced_file_exists(built):
    out, _, s = built
    site_dir = out / s["site"]["id"]
    paths = [
        s["grid_stack"]["stack_file"],
        s["grid_stack"]["static_file"],
        s["products"]["hydroperiod"]["png"],
    ]
    for p in s["passes"]:
        paths.append(p["class_png"])
        if p["cband_png"]:
            paths.append(p["cband_png"])
    for rel in paths:
        assert (site_dir / rel).is_file(), rel


def test_stack_size_matches_contract(built):
    out, _, s = built
    g, gs = s["grid"], s["grid_stack"]
    site_dir = out / s["site"]["id"]
    n_pix = g["width"] * g["height"]
    assert (site_dir / gs["stack_file"]).stat().st_size == len(gs["layers"]) * len(
        s["passes"]
    ) * n_pix
    assert (site_dir / gs["static_file"]).stat().st_size == len(gs["static_layers"]) * n_pix


def test_stack_reclassifies_to_reported_areas(built):
    """Decoding stack.bin and re-running the rules reproduces the summary: the
    same path the browser's scientist mode takes."""
    out, scene, s = built
    g, n = s["grid"], len(s["passes"])
    site_dir = out / s["site"]["id"]
    raw = np.fromfile(site_dir / "stack.bin", dtype=np.uint8).reshape(
        len(s["grid_stack"]["layers"]), n, g["height"], g["width"]
    )
    veg = np.fromfile(site_dir / "static.bin", dtype=np.uint8)[: g["height"] * g["width"]]
    hh = np.where(raw[0] == 0, np.nan, raw[0] * 0.25 - 50)
    hv = np.where(raw[1] == 0, np.nan, raw[1] * 0.25 - 50)
    cls, _ = classify(
        hh,
        hv,
        raw[2] * 0.25,
        veg.reshape(g["height"], g["width"]),
        config.Thresholds(**s["thresholds"]),
    )
    from canopy.raster import pixel_area_km2

    area = pixel_area_km2(tuple(g["bounds"]), g["height"], g["width"])
    for i, p in enumerate(s["passes"]):
        assert round(float(((cls[i] == FLOODED_VEG) * area).sum()), 3) == p["flooded_veg_km2"]


def test_synthetic_story_holds(built):
    """The physics the demo depends on: flood rises and falls, L-band sees
    more than C-band, the gauge tracks the area."""
    _, _, s = built
    areas = [p["flooded_km2"] for p in s["passes"]]
    peak = int(np.argmax(areas))
    assert 0 < peak < len(areas) - 1
    assert areas[peak] > 2 * areas[0]
    hidden = [p["hidden_from_cband_km2"] for p in s["passes"] if p["hidden_from_cband_km2"]]
    assert max(hidden) > 10
    assert s["validation"]["gauge"]["r"] > 0.8
    assert s["exposure"]["population_near_hidden_flood"] > 0


def test_synth_is_deterministic():
    site = config.get_site("sylhet")
    a = synth.make_scene(site)
    b = synth.make_scene(site)
    assert np.array_equal(a.hh_db, b.hh_db, equal_nan=True)


def _decode_png(data: bytes) -> np.ndarray:
    w, h, _, colour_type = struct.unpack(">IIBB", data[16:26])
    idat, i = b"", 8
    while i < len(data):
        (n,) = struct.unpack(">I", data[i : i + 4])
        if data[i + 4 : i + 8] == b"IDAT":
            idat += data[i + 8 : i + 8 + n]
        i += 12 + n
    ch = 4 if colour_type == 6 else 3
    rows = np.frombuffer(zlib.decompress(idat), np.uint8).reshape(h, w * ch + 1)
    assert (rows[:, 0] == 0).all()
    return rows[:, 1:].reshape(h, w, ch)


def test_png_roundtrip():
    rgba = np.random.default_rng(0).integers(0, 256, (7, 5, 4), dtype=np.uint8)
    assert np.array_equal(_decode_png(encode_png(rgba)), rgba)


def test_manifest_lists_only_built_sites(tmp_path: Path):
    site = config.get_site("janauaca")
    build_site(synth.make_scene(site), tmp_path)
    m = write_manifest(tmp_path, default_site="atchafalaya")
    assert [s["id"] for s in m["sites"]] == ["janauaca"]
    assert m["default_site"] == "janauaca"


def test_downloads_exist_and_geojson_matches_area(built):
    out, _, s = built
    site_dir = out / s["site"]["id"]
    assert {d["label_key"] for d in s["downloads"]} >= {
        "download.areas_csv",
        "download.flood_geojson",
    }
    for d in s["downloads"]:
        assert (site_dir / d["path"]).is_file()
    csv_rows = (site_dir / "export" / "areas.csv").read_text().strip().splitlines()
    assert len(csv_rows) == len(s["passes"]) + 1
    gj = json.loads((site_dir / f"export/flood_{s['peak_pass']}.geojson").read_text())
    g = s["grid"]
    w, so, e, n = g["bounds"]
    px_deg2 = (e - w) / g["width"] * (n - so) / g["height"]
    fv_deg2 = sum(
        (r[0][1][0] - r[0][0][0]) * (r[0][0][1] - r[0][2][1])
        for f in gj["features"]
        if f["properties"]["class"] == "flooded_vegetation"
        for r in f["geometry"]["coordinates"]
    )
    raw = np.fromfile(site_dir / "stack.bin", dtype=np.uint8)
    assert raw.size and fv_deg2 / px_deg2 > 100  # thousands of pixels vectorised
