"""GIBS catalogue: active fire vector layers (docs/10 D-138)."""

from canopy import gibs

# A cut-down EPSG:4326 capabilities document: one fire layer, one raster layer that must be
# skipped, and the tile matrix set the fire layer names.
XML = """
<Capabilities>
<Contents>
<Layer>
  <ows:Title>Fires and Thermal Anomalies (Day and Night, 375m)</ows:Title>
  <ows:Identifier>VIIRS_NOAA20_Thermal_Anomalies_375m_All</ows:Identifier>
  <Format>application/vnd.mapbox-vector-tile</Format>
  <Dimension><Value>2020-01-01/2020-03-17/P1D</Value><Value>2025-12-23/2026-11-12/P1D</Value></Dimension>
  <TileMatrixSetLink><TileMatrixSet>500m</TileMatrixSet></TileMatrixSetLink>
</Layer>
<Layer>
  <ows:Identifier>MODIS_Combined_Thermal_Anomalies_All</ows:Identifier>
  <Format>image/png</Format>
  <Dimension><Value>2002-07-04/2026-11-12/P1D</Value></Dimension>
  <TileMatrixSetLink><TileMatrixSet>500m</TileMatrixSet></TileMatrixSetLink>
</Layer>
<TileMatrixSet>
  <ows:Identifier>500m</ows:Identifier>
  <TileMatrix><ScaleDenominator>223632905.6114871</ScaleDenominator>
    <TileWidth>512</TileWidth><MatrixWidth>2</MatrixWidth><MatrixHeight>1</MatrixHeight></TileMatrix>
  <TileMatrix><ScaleDenominator>111816452.8057436</ScaleDenominator>
    <TileWidth>512</TileWidth><MatrixWidth>3</MatrixWidth><MatrixHeight>2</MatrixHeight></TileMatrix>
</TileMatrixSet>
</Contents>
</Capabilities>
"""


def test_fire_points_keep_vector_layers_with_their_grid_and_dates():
    fires = gibs.parse_fire_points(XML)
    assert [f["key"] for f in fires] == ["viirs_noaa20"]  # the raster-only MODIS entry is skipped
    f = fires[0]
    assert f["sensor"] == "VIIRS 375 m, NOAA-20"
    assert f["template"].endswith(
        "/VIIRS_NOAA20_Thermal_Anomalies_375m_All/default/{time}/500m/{z}/{y}/{x}.mvt"
    )
    assert f["template"].startswith("https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/")
    assert f["dates"] == [["2020-01-01", "2020-03-17", "P1D"], ["2025-12-23", "2026-11-12", "P1D"]]
    assert [lv["cols"] for lv in f["levels"]] == [2, 3]
    assert abs(f["levels"][0]["span_deg"] - 288.0) < 0.5


def test_fire_points_absent_when_the_layer_is_missing():
    assert gibs.parse_fire_points("<Capabilities></Capabilities>") == []


def test_fire_imagery_is_its_own_group():
    groups = {layer_id: group for layer_id, group, _ in gibs.LAYERS}
    assert groups["VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1"] == "fire"
    assert groups["OMPS_Aerosol_Index"] == "fire"
