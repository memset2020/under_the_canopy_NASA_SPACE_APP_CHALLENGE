"""Catalogue of NASA GIBS world layers for the live map (docs/03 §4.11, docs/10 D-054).

GIBS serves daily global imagery as public map tiles with no key. The app may load those
tiles like basemap tiles, but makes no API calls: this module reads GIBS's capabilities
document once at build time and writes web/data/gibs.json with each layer's tile template,
zoom limit, legend and the date ranges it exists for.
"""

from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path

CAPABILITIES = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"
# Orbit tracks are vector tiles served only on the geographic (EPSG:4326) grid: the Web-Mercator
# entries in the 3857 capabilities answer 404.
CAPABILITIES_4326 = "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/1.0.0/WMTSCapabilities.xml"
UA = {"User-Agent": "under-the-canopy/0.2 (NASA Space Apps)"}

# (layer id in GIBS, group, why it is in the app). Ids checked against capabilities.
LAYERS = [
    (
        "NISAR_L2_Geocoded_Polarimetric_Covariance",
        "radar",
        "NISAR L-band radar image, false colour",
    ),
    (
        "OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1",
        "radar",
        "Sentinel-1 C-band radar image",
    ),
    (
        "OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1",
        "water",
        "Surface water from C-band radar",
    ),
    ("OPERA_L3_Dynamic_Surface_Water_Extent-HLS", "water", "Surface water from optical satellites"),
    ("MODIS_Combined_Flood_2-Day", "water", "MODIS flood map, 2-day window"),
    ("VIIRS_Combined_Flood_2-Day", "water", "VIIRS flood map, 2-day window"),
    ("IMERG_Precipitation_Rate", "weather", "Rain rate, GPM IMERG"),
    ("SMAP_L4_Analyzed_Surface_Soil_Moisture", "weather", "Surface soil moisture, SMAP L4"),
    ("SMAP_L4_Analyzed_Root_Zone_Soil_Moisture", "weather", "Root-zone soil moisture, SMAP L4"),
    ("VIIRS_NOAA20_CorrectedReflectance_TrueColor", "imagery", "True colour, VIIRS NOAA-20"),
    ("HLS_S30_Nadir_BRDF_Adjusted_Reflectance", "imagery", "30 m photo, Sentinel-2 (HLS)"),
    ("HLS_L30_Nadir_BRDF_Adjusted_Reflectance", "imagery", "30 m photo, Landsat (HLS)"),
    ("VIIRS_NOAA20_DayNightBand_AtSensor_M15", "imagery", "Night lights, VIIRS NOAA-20 (daily)"),
    ("OPERA_L3_DIST-ALERT-HLS_Color_Index", "context", "Vegetation disturbance alerts, OPERA DIST"),
    (
        "GEDI_ISS_L3_Canopy_Height_Mean_RH100_201904-202303",
        "context",
        "Canopy height, GEDI 2019-2023",
    ),
    ("ASTER_GDEM_Greyscale_Shaded_Relief", "context", "Terrain relief, ASTER GDEM"),
    (
        "NDH_Flood_Hazard_Frequency_Distribution_1985-2003",
        "context",
        "Past flood frequency 1985-2003, SEDAC",
    ),
    ("MODIS_Terra_NDVI_8Day", "context", "Vegetation greenness, MODIS NDVI 8-day"),
    (
        "OPERA_L3_DIST-ANN-HLS_Color_Index",
        "context",
        "Yearly vegetation disturbance, OPERA DIST-ANN",
    ),
    # Fire and smoke (docs/10 D-138). False colour with a shortwave-infrared band shows burn scars
    # (red-brown) and active fronts (bright orange) through thin smoke; the aerosol and CO layers
    # show where a fire's smoke went. Ids checked against capabilities.
    (
        "VIIRS_NOAA20_CorrectedReflectance_BandsM11-I2-I1",
        "fire",
        "Burn scars and fire fronts, VIIRS false colour (NOAA-20)",
    ),
    (
        "VIIRS_NOAA21_CorrectedReflectance_BandsM11-I2-I1",
        "fire",
        "Burn scars and fire fronts, VIIRS false colour (NOAA-21)",
    ),
    ("MODIS_Terra_CorrectedReflectance_Bands721", "fire", "Burn scars, MODIS bands 7-2-1 (Terra)"),
    ("OMPS_Aerosol_Index", "fire", "Smoke, OMPS aerosol index (Suomi NPP)"),
    (
        "MODIS_Combined_MAIAC_L2G_AerosolOpticalDepth",
        "fire",
        "Smoke and haze, MODIS MAIAC aerosol optical depth",
    ),
    (
        "AIRS_L3_Carbon_Monoxide_500hPa_Volume_Mixing_Ratio_Daily_Day",
        "fire",
        "Carbon monoxide from fires, AIRS (500 hPa, daily)",
    ),
    # Drawn above every layer, never in the layer list (live.js).
    ("Reference_Labels_15m", "reference", "Place names"),
    ("Reference_Features_15m", "reference", "Roads, borders and coastlines"),
    ("Graticule_15m", "graticule", "Latitude and longitude lines"),
    # Picked from the map's basemap control (basemap.js), never stacked with the live layers.
    ("BlueMarble_ShadedRelief_Bathymetry", "basemap", "NASA Blue Marble: relief and sea floor"),
    ("BlueMarble_NextGeneration", "basemap", "NASA Blue Marble: true colour"),
    ("VIIRS_Black_Marble", "basemap", "NASA Black Marble: night lights 2016"),
]

# Missions behind this project whose ground tracks GIBS publishes (orbits.js). The key names the
# app's text (orbits.role_<key>); ISS carries GEDI, SAOCOM-1A is the other L-band radar in orbit.
ORBITS = [
    ("nisar", "NISAR"),
    ("sentinel1a", "Sentinel-1A"),
    ("sentinel1c", "Sentinel-1C"),
    ("icesat2", "ICESAT-2"),
    ("gpm", "GPM"),
    ("smap", "SMAP"),
    ("cygnss", "CYGNSS"),
    ("landsat9", "Landsat-9"),
    ("sentinel2c", "Sentinel-2C"),
    ("iss", "ISS"),
    ("saocom1a", "SAOCOM1-A"),
]

# Active fire detections (docs/10 D-138): the near-real-time FIRMS points (LANCE), served by GIBS as
# vector tiles on the geographic grid only (the Web-Mercator entries answer 404).
# Each point carries LATITUDE, LONGITUDE, FRP (MW), CONFIDENCE, ACQ_DATE, ACQ_TIME,
# SATELLITE and DAYNIGHT. (layer id in GIBS, key, sensor as the app names it)
FIRE_POINTS = [
    ("VIIRS_NOAA20_Thermal_Anomalies_375m_All", "viirs_noaa20", "VIIRS 375 m, NOAA-20"),
    ("VIIRS_NOAA21_Thermal_Anomalies_375m_All", "viirs_noaa21", "VIIRS 375 m, NOAA-21"),
    ("VIIRS_SNPP_Thermal_Anomalies_375m_All", "viirs_snpp", "VIIRS 375 m, Suomi NPP"),
    ("MODIS_Combined_Thermal_Anomalies_All", "modis", "MODIS 1 km, Terra and Aqua"),
]


# Swath layers show only that day's strips, so each is composited over the days it needs: the
# shortest window whose union reaches about 95 % of the 48-day land footprint, measured on world
# tiles (docs/10 D-063). Sentinel-1 needs two 12-day cycles; optical layers
# need more because clouds hide most days.
COMPOSITE_DAYS = {
    "NISAR_L2_Geocoded_Polarimetric_Covariance": 12,  # 99 %
    "OPERA_L2_Radiometric_Terrain_Corrected_SAR_Sentinel-1": 24,  # 12 d: 80 %, 24 d: 98 %
    "OPERA_L3_Dynamic_Surface_Water_Extent-Sentinel-1": 12,  # 96 %
    "OPERA_L3_Dynamic_Surface_Water_Extent-HLS": 24,  # 8 d: 80 %, 24 d: 95 %
    "HLS_S30_Nadir_BRDF_Adjusted_Reflectance": 36,  # 24 d: 81 %, 36 d: 99 %
    "HLS_L30_Nadir_BRDF_Adjusted_Reflectance": 24,  # 94 %
    "OPERA_L3_DIST-ALERT-HLS_Color_Index": 24,  # 97 %
}


def fetch_capabilities(out: Path, url: str = CAPABILITIES) -> Path:
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as res:  # noqa: S310 - fixed URL
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(res.read())
    return out


def _layer_block(xml: str, layer_id: str) -> str | None:
    i = xml.find(f"<ows:Identifier>{layer_id}</ows:Identifier>")
    if i < 0:
        return None
    return xml[xml.rfind("<Layer>", 0, i) : xml.find("</Layer>", i)]


def parse(xml: str) -> list[dict]:
    """One entry per curated layer found in the capabilities document."""
    out = []
    for layer_id, group, role in LAYERS:
        blk = _layer_block(xml, layer_id)
        if blk is None:
            continue
        title = re.search(r"<ows:Title[^>]*>([^<]+)</ows:Title>", blk)
        tms = re.search(r"<TileMatrixSet>GoogleMapsCompatible_Level(\d+)</TileMatrixSet>", blk)
        fmt = re.search(r"<Format>image/(png|jpeg)</Format>", blk)
        default = re.search(r"<Default>([^<]+)</Default>", blk)
        ranges = [v.split("/") for v in re.findall(r"<Value>([^<]+)</Value>", blk) if "/" in v]
        legend = re.search(r"<LegendURL[^>]*xlink:href='([^']+_H\.svg)'", blk) or re.search(
            r"<LegendURL[^>]*xlink:href='([^']+\.(?:svg|png))'", blk
        )
        if not tms or not fmt:
            continue
        timed = bool(ranges)
        ext = "jpg" if fmt[1] == "jpeg" else "png"
        time_part = "{time}/" if timed else ""
        out.append(
            {
                "id": layer_id,
                "group": group,
                "role": role,
                "title": title[1] if title else layer_id,
                "max_zoom": int(tms[1]),
                "template": (
                    f"https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer_id}/default/"
                    f"{time_part}GoogleMapsCompatible_Level{tms[1]}/{{z}}/{{y}}/{{x}}.{ext}"
                ),
                "default_date": default[1] if default and timed else None,
                # [start, end, period]; the app snaps a requested date into one of these.
                "dates": [[r[0][:10], r[1][:10], r[2] if len(r) > 2 else "P1D"] for r in ranges],
                "legend": legend[1] if legend else None,
                "composite_days": COMPOSITE_DAYS.get(layer_id, 1),
            }
        )
    return out


def _tile_matrix_set(xml: str, name: str) -> list[dict] | None:
    """Levels of a geographic tile matrix set: tiles across and down, degrees per tile."""
    start = xml.find(f"<ows:Identifier>{name}</ows:Identifier>")
    if start < 0:
        return None
    block = xml[start : xml.find("</TileMatrixSet>", start)]
    levels = []
    for m in re.findall(r"<TileMatrix>(.*?)</TileMatrix>", block, re.S):
        scale = re.search(r"<ScaleDenominator>([^<]+)</ScaleDenominator>", m)
        size = re.search(r"<TileWidth>(\d+)</TileWidth>", m)
        cols = re.search(r"<MatrixWidth>(\d+)</MatrixWidth>", m)
        rows = re.search(r"<MatrixHeight>(\d+)</MatrixHeight>", m)
        if not (scale and size and cols and rows):
            continue
        # OGC: pixel = 0.28 mm at the scale denominator; WGS84 metres per degree at the equator.
        deg_per_px = float(scale[1]) * 0.00028 / 111319.490793
        levels.append(
            {
                "cols": int(cols[1]),
                "rows": int(rows[1]),
                "span_deg": round(deg_per_px * int(size[1]), 6),
            }
        )
    return levels or None


def parse_orbits(xml4326: str) -> list[dict]:
    """Ascending and descending ground-track vector tiles per mission (EPSG:4326 grid)."""
    out = []
    for key, name in ORBITS:
        legs = {}
        for leg in ("Ascending", "Descending"):
            layer_id = f"OrbitTracks_{name}_{leg}"
            blk = _layer_block(xml4326, layer_id)
            if blk is None:
                continue
            tms = re.search(r"<TileMatrixSet>([^<]+)</TileMatrixSet>", blk)
            ranges = [v.split("/") for v in re.findall(r"<Value>([^<]+)</Value>", blk) if "/" in v]
            if not tms or "mapbox-vector-tile" not in blk:
                continue
            legs[leg.lower()] = {
                "id": layer_id,
                "template": (
                    f"https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{layer_id}/default/"
                    f"{{time}}/{tms[1]}/{{z}}/{{y}}/{{x}}.mvt"
                ),
                "tile_matrix_set": tms[1],
                "dates": [[r[0][:10], r[1][:10], r[2] if len(r) > 2 else "P1D"] for r in ranges],
            }
        if legs:
            first = next(iter(legs.values()))
            out.append(
                {
                    "key": key,
                    "mission": name.replace("ICESAT-2", "ICESat-2").replace(
                        "SAOCOM1-A", "SAOCOM-1A"
                    ),
                    "levels": _tile_matrix_set(xml4326, first["tile_matrix_set"]),
                    **legs,
                }
            )
    return out


def parse_fire_points(xml4326: str) -> list[dict]:
    """Active fire detection layers: EPSG:4326 vector tiles, one entry per sensor."""
    out = []
    for layer_id, key, sensor in FIRE_POINTS:
        blk = _layer_block(xml4326, layer_id)
        if blk is None or "mapbox-vector-tile" not in blk:
            continue
        tms = re.search(r"<TileMatrixSet>([^<]+)</TileMatrixSet>", blk)
        ranges = [v.split("/") for v in re.findall(r"<Value>([^<]+)</Value>", blk) if "/" in v]
        levels = _tile_matrix_set(xml4326, tms[1]) if tms else None
        if not tms or not ranges or not levels:
            continue
        out.append(
            {
                "id": layer_id,
                "key": key,
                "sensor": sensor,
                "template": (
                    f"https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/{layer_id}/default/"
                    f"{{time}}/{tms[1]}/{{z}}/{{y}}/{{x}}.mvt"
                ),
                "levels": levels,
                "dates": [[r[0][:10], r[1][:10], r[2] if len(r) > 2 else "P1D"] for r in ranges],
            }
        )
    return out


def build(capabilities: Path, out: Path, capabilities_4326: Path | None = None) -> dict:

    layers = parse(capabilities.read_text(encoding="utf-8", errors="ignore"))
    orbits, fires = [], []
    if capabilities_4326 is not None and capabilities_4326.is_file():
        xml4326 = capabilities_4326.read_text(encoding="utf-8", errors="ignore")
        orbits = parse_orbits(xml4326)
        fires = parse_fire_points(xml4326)
    doc = {
        "source": (
            "NASA GIBS WMTS, EPSG:3857 'best' "
            "(orbit tracks and active fire: EPSG:4326 vector tiles)"
        ),
        "attribution": "NASA EOSDIS GIBS; active fire: NASA LANCE FIRMS",
        "layers": layers,
        "orbits": orbits,
        "fires": fires,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, ensure_ascii=False) + "\n", encoding="utf-8")
    return doc
