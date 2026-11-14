"""D-104: GeoNames villages fill in where OpenStreetMap maps none, never twice."""

import io
import zipfile

from canopy import gazetteer


def test_merge_keeps_osm_and_adds_only_distant_geonames_places():
    osm = [{"name": "Ratargul", "lon": 91.9243, "lat": 25.0026, "population": None}]
    extra = [
        {"name": "Ratargul (GeoNames)", "lon": 91.9260, "lat": 25.0030, "population": None},  # ~180 m
        {"name": "Nihain", "lon": 91.9800, "lat": 24.9500, "population": None},  # ~8 km
    ]
    merged = gazetteer.merge(osm, extra)
    assert [p["name"] for p in merged] == ["Ratargul", "Nihain"]
    assert gazetteer.merge([], extra) == [{k: p[k] for k in ("name", "lon", "lat", "population")} for p in extra]


def test_places_in_box_reads_populated_places_only(tmp_path):
    rows = [
        # geonameid, name, ascii, alt, lat, lon, class, code, cc, cc2, a1, a2, a3, a4, population
        ["1", "Atgaon", "Atgaon", "", "24.95", "91.90", "P", "PPL", "BD", "", "", "", "", "", "0"],
        ["2", "Surma", "Surma", "", "24.95", "91.90", "H", "STM", "BD", "", "", "", "", "", "0"],
        ["3", "Far", "Far", "", "23.00", "90.00", "P", "PPL", "BD", "", "", "", "", "", "500"],
    ]
    buf = io.StringIO("\n".join("\t".join(r) for r in rows))
    z = tmp_path / "BD.zip"
    with zipfile.ZipFile(z, "w") as f:
        f.writestr("BD.txt", buf.getvalue())
    out = gazetteer.places_in_box(z, "BD", [91.84, 24.92, 92.0, 25.06])
    assert [p["name"] for p in out] == ["Atgaon"]
    assert out[0]["population"] is None
