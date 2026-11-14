// Loads the data contract (docs/03 §4) and gives per-pixel access to the grid stack.

export const SCHEMA_VERSION = 14;
const EARTH_M_PER_DEG = 111320;

async function getJson(fetchFn, url) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function getBytes(fetchFn, url) {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function loadManifest(base = "data/", fetchFn = fetch) {
  const res = await fetchFn(`${base}manifest.json`);
  if (!res.ok) throw new Error(`${base}manifest.json: HTTP ${res.status}`);
  const m = await res.json();
  if (m.schema_version !== SCHEMA_VERSION) {
    throw new Error(`manifest schema_version ${m.schema_version}, expected ${SCHEMA_VERSION}`);
  }
  // Runtime only, not part of the contract: `cli.py serve` marks its responses (D-055).
  Object.defineProperty(m, "localServer", {
    value: res.headers?.get?.("X-Canopy-Analyse") === "1",
    enumerable: false,
  });
  return m;
}

// Global 0.25° context grid (docs/03 §4.10): one uint8 plane per layer, row 0 = 90°N.
export async function loadGlobal(base, manifest, fetchFn = fetch) {
  if (!manifest.global) return null;
  const meta = await getJson(fetchFn, `${base}${manifest.global}`);
  const dir = `${base}${manifest.global.replace(/[^/]*$/, "")}`;
  const bytes = await getBytes(fetchFn, dir + meta.binary);
  const { width: W, height: H, res_deg: res } = meta.grid;
  if (bytes.length !== meta.layers.length * W * H) {
    throw new Error(`global.bin is ${bytes.length} bytes, expected ${meta.layers.length * W * H}`);
  }
  const start = Date.parse(`${meta.nisar_window.start}T00:00:00Z`);
  const decodeGlobal = (q, encoding) => {
    if (q === meta.nodata) return null;
    if (encoding === "half_m") return q / 2;
    if (encoding === "log_people") return Math.round(10 ** (q / 25) - 1);
    if (encoding === "signed_cm") return q - 127;
    if (encoding === "log_mg") return 10 ** (q / 80) - 1;
    if (encoding === "day") return new Date(start + q * 86400000).toISOString().slice(0, 10);
    return q;
  };
  const ids = meta.layers.map((l) => l.id);
  return {
    meta,
    url: (path) => dir + path,
    // Whole uint8 plane of one layer (row 0 = 90°N), for area sums over a view.
    plane(id) {
      const k = ids.indexOf(id);
      return k < 0 ? null : bytes.subarray(k * W * H, (k + 1) * W * H);
    },
    decode: decodeGlobal,
    // Decoded values of every layer for the cell holding lon/lat.
    cell(lon, lat) {
      const col = Math.min(W - 1, Math.max(0, Math.floor((((lon + 540) % 360) - 180 + 180) / res)));
      const row = Math.min(H - 1, Math.max(0, Math.floor((90 - lat) / res)));
      const values = Object.fromEntries(
        meta.layers.map((l, k) => [l.id, decodeGlobal(bytes[k * W * H + row * W + col], l.encoding)]),
      );
      const west = -180 + col * res;
      const north = 90 - row * res;
      return { row, col, bounds: [west, north - res, west + res, north], values };
    },
  };
}

export async function loadSite(base, entry, fetchFn = fetch) {
  const siteBase = `${base}${entry.path.replace(/summary\.json$/, "")}`;
  const summary = await getJson(fetchFn, `${base}${entry.path}`);
  if (summary.schema_version !== SCHEMA_VERSION) {
    throw new Error(`${entry.id}: schema_version ${summary.schema_version}`);
  }
  const gs = summary.grid_stack;
  const [stack, statics] = await Promise.all([
    getBytes(fetchFn, siteBase + gs.stack_file),
    getBytes(fetchFn, siteBase + gs.static_file),
  ]);
  return createBundle(summary, stack, statics, siteBase);
}

function byName(layers) {
  return Object.fromEntries(layers.map((l, i) => [l.name, { ...l, index: i }]));
}

function decode(q, layer) {
  if (layer.nodata !== null && layer.nodata !== undefined && q === layer.nodata) return null;
  return q * layer.scale + layer.offset;
}

// Everything a feature needs about one loaded site.
export function createBundle(summary, stack, statics, base = "") {
  const { width: W, height: H, bounds } = summary.grid;
  const [west, south, east, north] = bounds;
  const P = summary.passes.length;
  const gs = summary.grid_stack;
  const layers = byName(gs.layers);
  const staticLayers = byName(gs.static_layers);
  const plane = W * H;
  if (stack.length !== gs.layers.length * P * plane) {
    throw new Error(`stack.bin is ${stack.length} bytes, expected ${gs.layers.length * P * plane}`);
  }
  if (statics.length !== gs.static_layers.length * plane) {
    throw new Error(`static.bin is ${statics.length} bytes`);
  }

  const passPlane = (name, p) => {
    const start = (layers[name].index * P + p) * plane;
    return stack.subarray(start, start + plane);
  };
  const staticPlane = (name) => {
    const start = staticLayers[name].index * plane;
    return statics.subarray(start, start + plane);
  };

  // Per-row pixel area in km² (same formula as raster.pixel_area_km2).
  const dLat = (north - south) / H;
  const dLon = (east - west) / W;
  const rowAreaKm2 = Float64Array.from({ length: H }, (_, r) => {
    const lat = north - (r + 0.5) * dLat;
    return (dLon * EARTH_M_PER_DEG * Math.cos((lat * Math.PI) / 180) * dLat * EARTH_M_PER_DEG) / 1e6;
  });

  return {
    summary,
    base,
    width: W,
    height: H,
    passCount: P,
    layers,
    url: (rel) => base + rel,
    passPlane,
    staticPlane,
    rowAreaKm2,

    lonLatToGrid(lon, lat) {
      const col = Math.floor(((lon - west) / (east - west)) * W);
      const row = Math.floor(((north - lat) / (north - south)) * H);
      if (row < 0 || row >= H || col < 0 || col >= W) return null;
      return { row, col };
    },
    gridToLonLat(row, col) {
      return [west + ((col + 0.5) * (east - west)) / W, north - ((row + 0.5) * (north - south)) / H];
    },

    // Time series and static values for one pixel, decoded.
    pixel(row, col) {
      const i = row * W + col;
      const series = (name) =>
        Array.from({ length: P }, (_, p) => decode(passPlane(name, p)[i], layers[name]));
      return {
        row,
        col,
        hh: series("hh"),
        hv: series("hv"),
        spread: series("hh_spread"),
        cband: Array.from({ length: P }, (_, p) => passPlane("cband", p)[i]),
        veg: staticPlane("veg")[i],
        hydroperiodDays: staticPlane("hydroperiod_days")[i],
        levelCm: layers.level_cm ? series("level_cm") : [],
        vv: layers.vv ? series("vv") : [],
        vh: layers.vh ? series("vh") : [],
        canopyCoverPct: staticLayers.canopy_cover_pct ? decode(staticPlane("canopy_cover_pct")[i], staticLayers.canopy_cover_pct) : null,
        canopyHeightM: staticLayers.canopy_height_m ? decode(staticPlane("canopy_height_m")[i], staticLayers.canopy_height_m) : null,
        highGround: staticLayers.terrain_gate ? staticPlane("terrain_gate")[i] === 1 : false,
        jrcOccurrencePct: staticLayers.jrc_occurrence ? decode(staticPlane("jrc_occurrence")[i], staticLayers.jrc_occurrence) : null,
        handM: staticLayers.hand_m ? decode(staticPlane("hand_m")[i], staticLayers.hand_m) : null,
        glwdGroup: staticLayers.glwd_class && staticPlane("glwd_class")[i] !== 255 ? staticLayers.glwd_class.codes?.[String(staticPlane("glwd_class")[i])] ?? null : null,
      };
    },

    // Area (km²) of pixels where pred(i) is true, row-weighted.
    areaKm2(pred) {
      let total = 0;
      for (let r = 0; r < H; r += 1) {
        let n = 0;
        for (let c = 0; c < W; c += 1) if (pred(r * W + c)) n += 1;
        total += n * rowAreaKm2[r];
      }
      return total;
    },
  };
}

export function passById(summary, id) {
  return summary.passes.findIndex((p) => p.id === id);
}
