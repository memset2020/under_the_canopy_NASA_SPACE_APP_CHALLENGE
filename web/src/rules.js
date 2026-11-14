// Classification rules: an exact port of pipeline/canopy/classify.py (docs/04 §4).
// Parity is tested against a fixture written by pytest. Change both files together
// and add a docs/10 line (CLAUDE.md rule 4).

export const CLASS = Object.freeze({ NODATA: 0, DRY: 1, OPEN_WATER: 2, FLOODED_VEG: 3, EXCLUDED: 4 });
export const VEG = Object.freeze({ OTHER: 0, YES: 1, BUILT_UP: 2 });
export const THRESHOLD_KEYS = Object.freeze([
  "ow_hh_db", "ow_hv_db", "fv_hh_db", "fv_ratio_db", "margin_db", "max_spread_db",
]);

// Classify one pixel. hh/hv in dB or null for nodata; returns { cls, conf } (conf 0 = low).
export function classifyPixel(hh, hv, spread, veg, t) {
  if (hh === null || hv === null || !Number.isFinite(hh) || !Number.isFinite(hv)) {
    return { cls: CLASS.NODATA, conf: 1 };
  }
  const s = Number.isFinite(spread) ? spread : 0;
  const ratio = hh - hv;
  const m = t.margin_db;

  // Same order as classify.py: open water, then built-up, then double bounce.
  let cls = CLASS.DRY;
  if (hh < t.ow_hh_db && hv < t.ow_hv_db) cls = CLASS.OPEN_WATER;
  else if (veg === VEG.BUILT_UP) cls = CLASS.EXCLUDED;
  else if (veg === VEG.YES && hh > t.fv_hh_db && ratio > t.fv_ratio_db) cls = CLASS.FLOODED_VEG;

  if (cls === CLASS.EXCLUDED) return { cls, conf: 1 };

  let low = s > t.max_spread_db;
  if (cls === CLASS.OPEN_WATER) {
    low ||= Math.min(t.ow_hh_db - hh, t.ow_hv_db - hv) < m;
  } else if (cls === CLASS.FLOODED_VEG) {
    low ||= Math.min(hh - t.fv_hh_db, ratio - t.fv_ratio_db) < m;
  } else {
    const nearOw = hh < t.ow_hh_db + m && hv < t.ow_hv_db + m;
    const nearFv = veg === VEG.YES && hh > t.fv_hh_db - m && ratio > t.fv_ratio_db - m;
    low ||= nearOw || nearFv;
  }
  return { cls, conf: low ? 0 : 1 };
}

// Decode a quantised dB byte (docs/03 §4.4). Returns null for nodata.
export function decodeDb(q, layer) {
  if (layer.nodata !== null && q === layer.nodata) return null;
  return q * layer.scale + layer.offset;
}

// Classify one whole pass from raw quantised bytes. Returns Uint8Arrays of length H·W.
export function classifyGrid({ hhQ, hvQ, spQ, veg }, layers, t) {
  const n = hhQ.length;
  const cls = new Uint8Array(n);
  const conf = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const r = classifyPixel(
      decodeDb(hhQ[i], layers.hh),
      decodeDb(hvQ[i], layers.hv),
      spQ[i] * layers.hh_spread.scale + layers.hh_spread.offset,
      veg[i],
      t,
    );
    cls[i] = r.cls;
    conf[i] = r.conf;
  }
  return { cls, conf };
}

// Plain-language verdict key for F03: five verdicts plus nodata.
export function verdict({ cls, conf }) {
  if (cls === CLASS.NODATA) return "nodata";
  if (cls === CLASS.EXCLUDED) return "excluded";
  if (conf === 0) return "uncertain";
  if (cls === CLASS.FLOODED_VEG) return "hidden_flood";
  if (cls === CLASS.OPEN_WATER) return "open_water";
  return "dry";
}

// True when every threshold is a multiple of 0.25 dB (needed for exact parity, docs/04 §4.3).
export function validThresholds(t) {
  return THRESHOLD_KEYS.every((k) => Number.isFinite(t[k]) && Number.isInteger(t[k] / 0.25));
}
