// Every source the project uses, in one registry (docs/10 D-110): the sources page draws it, and
// every card and the "How we know" guide link into it with small flags. Grouped under umbrellas,
// each with a colour and an icon. `ids` lists the source ids the published summaries use, so a
// summary's sources map to entries here. Names and citations stay as their providers write them.
// `used`: which of the four changes rest on it (water, fire, ground, ice) or the world map.

export const UMBRELLAS = [
  { id: "radar", icon: "satellite", colour: "#e69f00" },
  { id: "water", icon: "wave", colour: "#56b4e9" },
  { id: "land", icon: "tree", colour: "#7fa894" },
  { id: "ground", icon: "pin", colour: "#cc79a7" },
  { id: "fire", icon: "fire", colour: "#d55e00" },
  { id: "ice", icon: "ice", colour: "#a8d8ea" },
  { id: "climate", icon: "drop", colour: "#009e73" },
  { id: "people", icon: "people", colour: "#f0e442" },
  { id: "science", icon: "book", colour: "#eef3f1" },
  { id: "imagery", icon: "map", colour: "#9fb0ab" },
];

const S = (id, umbrella, name, provider, licence, used, url, cite, role, ids = [id]) => ({ id, umbrella, name, provider, licence, used, url, cite, role, ids });

export const SOURCES = [
  // The radar
  S("nisar_gcov", "radar", "NISAR L2 GCOV, L-band HH and HV", "NASA/JPL and ISRO, via the Alaska Satellite Facility DAAC", "Open (NASA data policy)", ["water", "fire", "world"], "https://nisar-docs.asf.alaska.edu/gcov/", "NASA/JPL and ISRO (2026), NISAR L2 GCOV, provisional, ASF DAAC.", "The radar echo of every pixel, every pass: the heart of every map.", ["nisar_gcov", "nisar"]),
  S("nisar_gunw", "radar", "NISAR L2 GUNW interferograms", "NASA/JPL and ISRO, via ASF DAAC", "Open (NASA data policy)", ["ground", "water"], "https://nisar-docs.asf.alaska.edu/", "NASA/JPL and ISRO (2026), NISAR L2 GUNW, provisional, ASF DAAC.", "The phase between two passes: centimetres of ground motion, and water-level change under the canopy."),
  S("nisar_sme2", "radar", "NISAR L3 SME2 soil moisture", "NASA/JPL and ISRO, via ASF DAAC", "Open (NASA data policy)", ["water"], "https://nisar-docs.asf.alaska.edu/", "NASA/JPL and ISRO (2026), NISAR L3 SME2.", "Was the ground already saturated before the water rose?"),
  S("opera_rtc_s1", "radar", "OPERA RTC-S1, C-band VV and VH", "NASA JPL OPERA, via ASF DAAC; contains modified Copernicus Sentinel data (2026)", "Open; Copernicus Sentinel data", ["water"], "https://www.jpl.nasa.gov/go/opera", "OPERA project, NASA JPL (2026), RTC-S1.", "C-band's own echo at each spot, the shorter wave L-band is compared against."),
  // Water seen from above
  S("opera_dswx_s1", "water", "OPERA DSWx-S1", "NASA JPL OPERA; contains modified Copernicus Sentinel data (2026)", "Open; Copernicus Sentinel data", ["water"], "https://www.jpl.nasa.gov/go/opera", "OPERA project, NASA JPL (2026), DSWx-S1.", "C-band's water map, including its flooded-vegetation class: the comparison for what C-band misses."),
  S("opera_dswx_hls", "water", "OPERA DSWx-HLS", "NASA JPL OPERA, via PO.DAAC", "Open (NASA data policy)", ["water"], "https://www.jpl.nasa.gov/go/opera", "OPERA project, NASA JPL (2026), DSWx-HLS.", "What optical satellites saw as water, when the sky was clear."),
  S("jrc", "water", "JRC Global Surface Water occurrence 1984–2021 (v1.4)", "European Commission JRC and Google", "Copernicus programme, free; Source: EC JRC/Google", ["water", "world"], "https://global-surface-water.appspot.com/", "Pekel et al. (2016), Nature 540, 418–422, doi:10.1038/nature20584.", "Where water usually is, so the usual river is not counted as flood."),
  S("glwd", "water", "GLWD v2 Global Lakes and Wetlands Database", "WWF and McGill University", "CC BY 4.0", ["water", "world"], "https://www.hydrosheds.org/products/glwd", "Lehner et al. (2025), GLWD v2.", "Where wetlands, and forested wetlands, are mapped: an independent check of the setting."),
  S("cygnss", "water", "CYGNSS water masks (UC Berkeley)", "NASA, via PO.DAAC", "Open (NASA data policy)", ["water", "world"], "https://podaac.jpl.nasa.gov/CYGNSS", "CYGNSS mission; UC Berkeley watermask v3.", "Daily L-band reflections of GNSS signals: a second, coarse look at inundation."),
  S("swot", "water", "SWOT L2 HR Raster, version D", "NASA and CNES, via PO.DAAC", "Open (NASA data policy)", ["water"], "https://swot.jpl.nasa.gov/", "SWOT project, NASA/CNES (2026).", "An independent satellite's water-surface height, to check the map's rise and fall."),
  S("icesat2", "water", "ICESat-2 ATL13 inland water height", "NASA, via NSIDC DAAC", "Open (NASA data policy)", ["water"], "https://icesat-2.gsfc.nasa.gov/", "ICESat-2 project, NASA.", "Laser water heights, wired as a check once the season is published."),
  S("lba_eco_lc07", "water", "LBA-ECO LC-07 Amazon wetland map", "NASA, via ORNL DAAC", "Open (NASA data policy)", ["water"], "https://doi.org/10.3334/ORNLDAAC/1284", "Hess et al. (2003), Remote Sensing of Environment 87, 404–428.", "The classic L-band map of Amazon floodplain forest, from JERS-1: labels for calibration."),
  S("gdacs", "water", "GDACS flood alerts", "European Commission JRC and UN OCHA", "Free, attribution (verify)", ["world"], "https://www.gdacs.org/", "GDACS.", "Floods reported now, on the world map."),
  // Land, forest and terrain
  S("esa_worldcover", "land", "ESA WorldCover 2021, 10 m", "ESA; contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium", "CC BY 4.0", ["water", "fire"], "https://esa-worldcover.org/", "© ESA WorldCover project 2021.", "Which pixels are trees, shrubs or wetland: only there can water hide under vegetation."),
  S("nasa_gedi", "land", "GEDI canopy cover and height", "NASA, via ORNL DAAC", "Open (NASA data policy)", ["water", "fire", "world"], "https://gedi.umd.edu/", "GEDI mission, NASA.", "How dense and tall the canopy is where L-band sees water.", ["nasa_gedi", "gedi"]),
  S("nasadem", "land", "NASADEM, 30 m", "NASA, via LP DAAC", "Open (NASA data policy)", ["water"], "https://www.earthdata.nasa.gov/data/catalog/lpcloud-nasadem-hgt-001", "NASA JPL (2020), NASADEM.", "A terrain gate: no hidden-flood claim on high ground."),
  S("hand", "land", "GLO-30 HAND, height above nearest drainage", "Alaska Satellite Facility, from the Copernicus DEM", "CC0; Copernicus DEM: © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA", ["water"], "https://registry.opendata.aws/glo-30-hand/", "ASF (2021), GLO-30 HAND v1.", "How far above the nearest stream each place is: floods reach low ground."),
  S("copdem_glo90", "land", "Copernicus DEM GLO-90", "ESA", "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA", ["ice"], "https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model", "Copernicus DEM GLO-90.", "The relief under each glacier's speed map."),
  S("nasa_hls", "land", "HLS, Landsat 8/9 and Sentinel-2, 30 m", "NASA, via LP DAAC; contains modified Copernicus Sentinel data", "Open (NASA data policy)", ["water", "fire"], "https://www.earthdata.nasa.gov/data/projects/hls", "HLS project, NASA.", "The photo from space: what a camera saw, often cloud."),
  S("modis_lc", "land", "MODIS MCD12C1 land cover", "NASA, via LP DAAC", "Open (NASA data policy)", ["world"], "https://lpdaac.usgs.gov/products/mcd12c1v061/", "MODIS land team, MCD12C1 v061.", "Forest share of every world cell."),
  // On the ground
  S("gauge_usgs", "ground", "USGS river gauge, Atchafalaya at Butte La Rose", "USGS NWIS", "U.S. public domain", ["water"], "https://waterdata.usgs.gov/", "U.S. Geological Survey, NWIS.", "A ruler in the river, read daily: the witness the map is checked against."),
  S("gauge_ana", "ground", "ANA river gauges, Solimões and Paraguai", "Agência Nacional de Águas, Hidro-Telemetria", "Reproduction with source cited (verify)", ["water"], "https://www.snirh.gov.br/hidrotelemetria/", "ANA, Brazil.", "Daily river levels for the Amazon and Pantanal sites."),
  S("gauge_ffwc", "ground", "BWDB FFWC river gauge, Surma at Sylhet", "Bangladesh Water Development Board, Flood Forecasting and Warning Centre", "Public data (verify)", ["water"], "http://www.ffwc.gov.bd/", "BWDB FFWC, Bangladesh.", "The Surma's daily level beside Sylhet's haor."),
  S("ngl", "ground", "GNSS daily positions", "Nevada Geodetic Laboratory", "Free; citation requested", ["ground"], "https://geodesy.unr.edu/", "Blewitt, Hammond and Kreemer (2018), Eos 99, doi:10.1029/2018EO104623.", "GPS stations that felt the ground move: the check on the radar's centimetres."),
  S("usgs_ffm", "ground", "USGS finite-fault model and epicentres", "USGS", "U.S. public domain", ["ground"], "https://earthquake.usgs.gov/", "U.S. Geological Survey.", "The earthquake's slip, modelled forward with Okada (1985) to compare with what NISAR measured."),
  // Fire
  S("firms_nrt", "fire", "VIIRS and MODIS active fire, near real time (FIRMS)", "NASA LANCE FIRMS, tiles via NASA GIBS", "Open (NASA data policy); acknowledgement requested", ["fire", "world"], "https://firms.modaps.eosdis.nasa.gov/", "We acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS).", "Fires burning anywhere on Earth, on any day, on the map: VIIRS 375 m (Suomi NPP, NOAA-20, NOAA-21) and MODIS 1 km."),
  S("mcd64a1", "fire", "MODIS MCD64A1 burned area", "NASA, via LP DAAC", "Open (NASA data policy)", ["fire"], "https://doi.org/10.5067/MODIS/MCD64A1.061", "Giglio et al., MCD64A1 v061.", "An independent burned-area map to check the radar's."),
  S("vnp64a1", "fire", "VIIRS VNP64A1 burned area", "NASA, via LP DAAC", "Open (NASA data policy)", ["fire"], "https://doi.org/10.5067/VIIRS/VNP64A1.002", "VIIRS land team, VNP64A1 v002.", "The burned-area check for a fire MODIS has not mapped yet."),
  S("viirs_af", "fire", "VIIRS 375 m active fire", "NASA, via LAADS DAAC", "Open (NASA data policy)", ["fire"], "https://doi.org/10.5067/VIIRS/VNP14IMG.002", "Schroeder et al., VIIRS active fire v002.", "Where and when it burned, day by day, between radar passes."),
  // Ice
  S("itslive", "ice", "NASA MEaSUREs ITS_LIVE glacier velocity", "NASA JPL, via NSIDC", "Open (NASA data policy)", ["ice"], "https://its-live.jpl.nasa.gov", "Gardner et al. (2018), The Cryosphere 12, 521–547; ITS_LIVE v2.1.", "How fast each glacier flows, 1985 to 2024."),
  S("rgi7", "ice", "Randolph Glacier Inventory 7.0", "RGI Consortium, via NSIDC", "CC BY 4.0 or U.S. government work (verify)", ["ice"], "https://nsidc.org/data/nsidc-0770", "RGI Consortium (2023), doi:10.5067/F6JMOVY5NAVZ.", "The outline of every glacier."),
  // Water and climate
  S("grace", "climate", "GRACE/GRACE-FO JPL mascons RL06.3", "NASA JPL, via PO.DAAC", "Open (NASA data policy)", ["water", "ice", "world"], "https://grace.jpl.nasa.gov/", "Watkins et al. (2015); JPL mascons RL06.3.", "Whole-basin water storage: is this a wet year?"),
  S("grace_da", "climate", "GRACE-DA-DM v3 drought indicators", "NASA, via GES DISC", "Open (NASA data policy)", ["world"], "https://disc.gsfc.nasa.gov/", "NASA GES DISC, GRACE-DA-DM v3.", "Groundwater and root-zone wetness, as percentiles."),
  S("gpm_imerg", "climate", "GPM IMERG Late, daily", "NASA, via GES DISC", "Open (NASA data policy)", ["water"], "https://gpm.nasa.gov/data/imerg", "Huffman et al., GPM IMERG.", "Daily rain over each site."),
  S("smap", "climate", "SMAP soil moisture", "NASA, via NSIDC DAAC", "Open (NASA data policy)", ["world"], "https://smap.jpl.nasa.gov/", "SMAP mission, NASA.", "Soil moisture on the world map."),
  S("wetcharts", "climate", "WetCHARTs v1.3.3 wetland methane", "NASA JPL, via ORNL DAAC", "Open (NASA data policy)", ["world", "water"], "https://doi.org/10.3334/ORNLDAAC/2346", "Bloom et al. (2017), Geoscientific Model Development 10, 2141–2156.", "Modelled wetland methane across the world."),
  S("geoglows", "climate", "GEOGloWS ECMWF Streamflow v2", "GEOGloWS and ECMWF", "CC BY 4.0", ["water"], "https://geoglows.ecmwf.int/", "GEOGloWS ECMWF Streamflow Service.", "The main river's flow and its 15-day forecast: the experimental outlook."),
  // People and places
  S("worldpop", "people", "WorldPop population, 100 m", "WorldPop, University of Southampton", "CC BY 4.0", ["water"], "https://www.worldpop.org/", "WorldPop.", "How many people live near the hidden water."),
  S("sedac_grdi", "people", "SEDAC Global Gridded Relative Deprivation Index", "NASA SEDAC (CIESIN, Columbia University)", "CC BY 4.0", ["water"], "https://sedac.ciesin.columbia.edu/", "CIESIN, NASA SEDAC.", "How deprived the communities next to the hidden flood are."),
  S("gpw", "people", "GPWv4.11 population", "NASA SEDAC (CIESIN)", "CC BY 4.0", ["world"], "https://sedac.ciesin.columbia.edu/", "CIESIN, GPWv4.11.", "People in every world cell."),
  S("osm", "people", "OpenStreetMap roads and places", "OpenStreetMap contributors", "ODbL", ["water", "world"], "https://www.openstreetmap.org/copyright", "© OpenStreetMap contributors.", "Roads that run through the flood, and village names."),
  S("geonames", "people", "GeoNames populated places", "GeoNames", "CC BY 4.0", ["water"], "https://www.geonames.org/", "GeoNames.", "Village names where OpenStreetMap has none."),
  // Published science (the methods and the checks)
  S("bartlett1988", "science", "Methane flux from the central Amazonian floodplain", "Bartlett et al. (1988)", "Journal article", ["water"], "https://doi.org/10.1029/JD093iD02p01571", "Bartlett, K. B., et al. (1988), Journal of Geophysical Research 93(D2), 1571–1582.", "Flooded-forest methane rates for the ledger (tropical)."),
  S("bartlett1990", "science", "Methane flux from the Amazon River floodplain: emissions during rising water", "Bartlett et al. (1990)", "Journal article", ["water"], "https://doi.org/10.1029/JD095iD10p16773", "Bartlett, K. B., et al. (1990), Journal of Geophysical Research 95(D10), 16773–16788.", "Flooded-forest methane rates for the ledger (tropical)."),
  S("harriss1981", "science", "Methane flux in forested freshwater swamps of the south-eastern United States", "Harriss and Sebacher (1981)", "Journal article", ["water"], "", "Harriss, R. C., and Sebacher, D. I. (1981), Geophysical Research Letters 8(9), 1002–1004.", "Forested-swamp methane rates for the ledger (temperate)."),
  S("ward2020", "science", "Pathways for methane emissions and oxidation in a subtropical cypress swamp", "Ward et al. (2020)", "Journal article", ["water"], "https://doi.org/10.3389/feart.2020.573357", "Ward, N. D., et al. (2020), Frontiers in Earth Science 8, 573357.", "The central temperate methane rate."),
  S("saunois2025", "science", "Global Methane Budget 2000–2020", "Saunois et al. (2025)", "Journal article (open access)", ["water"], "https://essd.copernicus.org/articles/17/1873/2025/", "Saunois, M., et al. (2025), Earth System Science Data 17, 1873.", "Why wetland methane is the budget's largest uncertainty."),
  S("ipcc_ar6", "science", "IPCC AR6 WG1, chapter 7", "Forster et al. (2021)", "Report", ["water"], "https://www.ipcc.ch/report/ar6/wg1/", "Forster, P., et al. (2021), IPCC AR6 WG1, chapter 7, Table 7.15.", "Methane's 100-year warming potential (27 for natural methane)."),
  S("okada1985", "science", "Surface deformation due to shear and tensile faults in a half-space", "Okada (1985)", "Journal article", ["ground"], "", "Okada, Y. (1985), Bulletin of the Seismological Society of America 75(4), 1135–1154.", "Turning the USGS fault model into the motion NISAR should see."),
  S("joughin2004", "science", "Large fluctuations in speed on Greenland's Jakobshavn Isbræ glacier", "Joughin, Abdalati and Fahnestock (2004)", "Journal article", ["ice"], "https://doi.org/10.1038/nature03130", "Joughin, I., Abdalati, W., and Fahnestock, M. (2004), Nature 432, 608–610.", "A published speed the glacier map is checked against."),
  S("khazendar2019", "science", "Interruption of two decades of Jakobshavn Isbrae acceleration and thinning", "Khazendar et al. (2019)", "Journal article", ["ice"], "https://doi.org/10.1038/s41561-019-0329-3", "Khazendar, A., et al. (2019), Nature Geoscience 12, 277–283.", "The slowdown the glacier map should show, and does."),
  // Basemaps and imagery
  S("gibs", "imagery", "NASA GIBS imagery tiles", "NASA ESDIS", "Open (NASA data policy)", ["world", "water", "fire", "ice"], "https://www.earthdata.nasa.gov/gibs", "We acknowledge the use of imagery from NASA's Global Imagery Browse Services (GIBS), part of NASA's ESDIS.", "Blue Marble, relief and live daily layers, among them burn scars, smoke and fire carbon monoxide."),
  S("osm_tiles", "imagery", "OpenStreetMap basemap tiles", "OpenStreetMap contributors", "ODbL; tile usage policy", ["water", "fire", "ground"], "https://www.openstreetmap.org/copyright", "© OpenStreetMap contributors.", "The street map under every site."),
  S("pia26672", "imagery", "NISAR's view of Mount Rainier (PIA26672)", "NASA/JPL-Caltech", "Free to reuse with credit", ["world"], "https://www.jpl.nasa.gov/images/pia26672-nisars-view-of-mount-rainier/", "NASA/JPL-Caltech, PIA26672.", "The challenge's own image, on the landing page."),
];

// The registry entry for a summary's source (gauges by their provider).
export function entryForSource(src) {
  if (src.id === "gauge") {
    const p = `${src.provider ?? ""} ${src.name ?? ""}`;
    return SOURCES.find((s) => s.id === (/USGS/.test(p) ? "gauge_usgs" : /ANA/.test(p) ? "gauge_ana" : "gauge_ffwc"));
  }
  return SOURCES.find((s) => s.ids.includes(src.id)) ?? null;
}

// Entries grouped by umbrella, in umbrella order.
export function byUmbrella(entries) {
  const out = new Map(UMBRELLAS.map((u) => [u.id, []]));
  for (const e of entries) if (e && out.has(e.umbrella)) out.get(e.umbrella).push(e);
  return [...out].filter(([, list]) => list.length).map(([id, list]) => ({ umbrella: UMBRELLAS.find((u) => u.id === id), list }));
}

export const sourcesHref = (anchor, lang = "en") => `sources.html${lang === "en" ? "" : `?lang=${lang}`}#${anchor}`;
