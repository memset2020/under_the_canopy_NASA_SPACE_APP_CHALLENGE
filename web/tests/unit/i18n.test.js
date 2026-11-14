// Every t("key") used in src/ must exist in en.json (CLAUDE.md rule 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fmtNumber, setDictionary, t } from "../../src/i18n.js";
import { AUDIENCES, INDEX, NEXT } from "../../src/film.js";

const src = new URL("../../src/", import.meta.url);
const en = JSON.parse(readFileSync(new URL("../../i18n/en.json", import.meta.url), "utf8"));
const html = ["index.html", "landing.html"]
  .map((f) => readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"))
  .join("\n");
const WARNING_CODES = [
  "synthetic_data", "single_track_only", "extra_tracks_dropped", "no_cband_match",
  "few_passes_for_r", "no_gauge", "no_exposure", "no_optical", "radiometry_outlier", "no_level_change", "no_canopy", "no_swot", "hidden_flood_unvalidated", "hidden_flood_uncalibrated", "gap_filled_other_track", "early_mission_data", "unknown",
];

function usedKeys() {
  const keys = new Set();
  for (const file of readdirSync(src).filter((f) => f.endsWith(".js"))) {
    const code = readFileSync(new URL(file, src), "utf8");
    for (const m of code.matchAll(/\bt\(\s*"([a-z0-9_.]+)"/g)) keys.add(m[1]);
    for (const m of code.matchAll(/\b(?:key|labelKey|i18n):\s*"([a-z0-9_.]+)"/g)) keys.add(m[1]);
  }
  for (const m of html.matchAll(/data-i18n(?:-aria|-alt)?="([a-z0-9_.]+)"/g)) keys.add(m[1]);
  for (const c of WARNING_CODES) keys.add(`warning.${c}`);
  // Keys built at runtime from a fixed set of values.
  const families = {
    "explain.verdict_": ["hidden_flood", "open_water", "dry", "uncertain", "excluded", "nodata"],
    "explain.reason_": ["hidden_flood", "open_water", "dry", "uncertain", "excluded", "nodata"],
    "explain.leaning_": ["hidden", "water", "dry", "excluded", "nodata"],
    "explain.cband_": ["0", "1", "2"],
    "explain.veg_": ["yes", "built", "other"],
    "physics.panel_": ["dry", "flooded", "water"],
    "physics.sig_": ["dry", "flooded", "water", "dry_title", "flooded_title", "water_title"],
    "physics.limit_": ["1", "2", "3", "4", "5", "6", "7", "8"],
    "compare.tag_": ["optical", "cband", "nisar"],
    "story.chapter_": ["1", "2", "3"],
    "story.": ["optical", "cband", "nisar", "nisar_no_cband", "hydro", "people", "gauge", "orbit", "limits", "fire_intro", "fire_intro_clear", "fire_burn", "fire_check", "fire_lookalike"],
    "lang.name_": ["en", "bn", "pt"],
    "validation.verdict_": ["strong", "moderate", "weak"],
    "validation.calibration_rejected_": ["gauge_timing", "search_edge"],
    "globe.layer_": ["bivariate", "likely", "wettest_month", "glwd_forested_pct", "wetland_ch4", "water_storage_cm", "groundwater_pctile", "rootzone_pctile", "nisar_passes", "forest_pct", "wetland_pct", "cygnss_range_pct", "canopy_height_m", "people", "off"],
    "globe.legend_": ["bivariate", "likely", "wettest_month", "glwd_forested_pct", "wetland_ch4", "water_storage_cm", "groundwater_pctile", "rootzone_pctile", "nisar_passes", "forest_pct", "wetland_pct", "cygnss_range_pct", "canopy_height_m", "people"],
    "globe.likely_": ["0", "1", "2", "none"],
    "here.likely_": ["0", "1", "2", "none"],
    "here.gw_": ["very_dry", "dry", "normal", "wet", "very_wet"],
    "level.sign_": ["gauge", "undetermined", "no_gauge", "synthetic"],
    "live.group_": ["radar", "water", "fire", "weather", "imagery", "context"],
    "fires.class_": ["0", "1", "2", "3"],
    "fires.window_": ["1", "n", "pass"],
    "fires.": ["day", "night"],
    "exposure.grdi_": ["more", "less", "same"],
    "labels.class_": ["flooded_veg", "open_water", "dry_veg", "dry_open", "built"],
    "download.": ["areas_csv", "flood_geojson", "places_csv"],
    "scientist.": ["ow_hh_db", "ow_hv_db", "fv_hh_db", "fv_ratio_db", "margin_db", "max_spread_db"],
    "basemap.": ["auto", "streets", "relief", "truecolour", "night", "none"],
    "orbits.role_": ["nisar", "sentinel1a", "sentinel1c", "icesat2", "gpm", "smap", "cygnss", "landsat9", "sentinel2c", "iss", "saocom1a"],
    "orbits.dir_": ["ascending", "descending"],
    "tools.": ["distance", "area", "profile"],
    "tools.hint_": ["distance", "area", "profile"],
    "tools.class_": ["1", "2", "3", "4"],
    "flows.class_": ["hidden", "water", "dry", "built", "nodata"],
    "validation.hand_": ["lower", "same", "higher"],
    "events.alert_": ["red", "orange", "green"],
    "explain.glwd_": ["dryland", "open_water", "forested_wetland", "wetland", "rice"],
    "motion.layer_": ["total_up_short", "total_east_short", "east", "up", "rate_up", "rate_east", "sigma_up", "sigma_east", "east_short", "up_short", "model_east_short", "model_up_short", "resid_east_short", "resid_up_short", "rate_up_short", "rate_east_short", "sigma_up_short", "sigma_east_short"],
    "motion.key_": ["motion", "rate", "model", "resid", "coherence", "sigma"],
    "motion.": ["west", "east", "down", "up", "away", "toward", "coh_low", "coh_high", "sigma_low", "sigma_high", "note_quake", "note_sinking", "geom_quake", "geom_chain"],
    "checks.period_": ["same", "earlier"],
  };
  // The opening film's index wall, directions and audiences (src/film.js INDEX, NEXT, AUDIENCES).
  for (const [group, items] of INDEX) {
    keys.add(`film.ix_g_${group}`);
    for (const k of items) keys.add(`film.ix_${k}`);
  }
  for (const [k, status] of NEXT) for (const key of [`film.next_${k}`, `film.next_${k}d`, `film.st_${status}`]) keys.add(key);
  for (const a of AUDIENCES) for (const s of ["", "_q", "_f1", "_f2", "_f3"]) keys.add(`landing.aud_${a}${s}`);
  for (const [prefix, vals] of Object.entries(families)) for (const v of vals) keys.add(prefix + v);
  return keys;
}

test("every used key exists in en.json", () => {
  const missing = [...usedKeys()].filter((k) => !(k in en));
  assert.deepEqual(missing, []);
});

test("interpolation and missing keys", () => {
  setDictionary({ "a.b": "{n} km² hidden" });
  assert.equal(t("a.b", { n: 3 }), "3 km² hidden");
  assert.equal(t("nope.key"), "nope.key");
  assert.equal(fmtNumber(1234.56, 1), "1,234.6");
});

test("every translation has every key with the same placeholders", () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const code of ["bn", "pt"]) {
    const tr = JSON.parse(readFileSync(new URL(`../../i18n/${code}.json`, import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(en).filter((k) => !(k in tr)), [], `${code} missing keys`);
    assert.deepEqual(Object.keys(en).filter((k) => k in tr && ph(en[k]) !== ph(tr[k])), [], `${code} placeholders`);
  }
});
