"""Every published file in web/data and web/data-synthetic matches its schema (docs/03 §4).

The synthetic builds in test_build.py cannot reach paths only real data takes (ICESat-2 heights,
places analysed here), so the committed files themselves are checked.
"""

import gzip
import json
from pathlib import Path

import pytest

jsonschema = pytest.importorskip("jsonschema")

ROOT = Path(__file__).resolve().parents[2]
SCHEMA = ROOT / "pipeline" / "schema"
SUMMARIES = sorted((ROOT / "web" / "data").glob("*/summary.json")) + sorted(
    (ROOT / "web" / "data-synthetic").glob("*/summary.json")
)


@pytest.mark.parametrize("path", SUMMARIES, ids=lambda p: f"{p.parent.parent.name}/{p.parent.name}")
def test_published_summary_matches_the_schema(path):
    schema = json.loads((SCHEMA / "summary.schema.json").read_text(encoding="utf-8"))
    jsonschema.validate(json.loads(path.read_text(encoding="utf-8")), schema)


def test_published_global_grid_matches_the_schema():
    doc = ROOT / "web" / "data" / "global" / "global.json"
    if not doc.is_file():
        pytest.skip("no global grid published")
    schema = json.loads((SCHEMA / "global.schema.json").read_text(encoding="utf-8"))
    jsonschema.validate(json.loads(doc.read_text(encoding="utf-8")), schema)


MOTION = sorted((ROOT / "web" / "data" / "motion").glob("*/motion.json"))


@pytest.mark.parametrize("path", MOTION, ids=lambda p: p.parent.name)
def test_published_motion_event_matches_the_schema_and_its_binary(path):
    schema = json.loads((SCHEMA / "motion.schema.json").read_text(encoding="utf-8"))
    doc = json.loads(path.read_text(encoding="utf-8"))
    jsonschema.validate(doc, schema)
    blob = (path.parent / doc["binary"]).read_bytes()
    if doc["binary"].endswith(".gz"):
        blob = gzip.decompress(blob)
    assert len(blob) == len(doc["planes"]) * doc["grid"]["width"] * doc["grid"]["height"] * 2


ICE = sorted((ROOT / "web" / "data" / "ice").glob("*/ice.json"))


@pytest.mark.parametrize("path", ICE, ids=lambda p: p.parent.name)
def test_published_ice_matches_the_schema_and_has_its_outlines(path):
    schema = json.loads((SCHEMA / "ice.schema.json").read_text(encoding="utf-8"))
    doc = json.loads(path.read_text(encoding="utf-8"))
    jsonschema.validate(doc, schema)
    assert (path.parent / doc["glaciers"]["geojson"]).is_file()
