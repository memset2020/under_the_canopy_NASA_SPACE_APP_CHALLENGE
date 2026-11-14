// Ground that moved: the maths and drawing shared by motion.js, motionprofile.js and
// motionchecks.js (docs/10 D-082). Pure functions on the planes of motion.bin, plus canvas
// painters. No DOM outside the painters, no shared state (that lives in the store).

// Colour maps: Crameri's Scientific colour maps v8 (MIT; Crameri, Shephard & Heron 2020, Nature
// Communications 11:5444): perceptually uniform and readable with colour-vision deficiency.
// vik (diverging) for signed motion, romaO (cyclic) for fringes, batlow (sequential) for
// errors and coherence. 33 stops each, linearly interpolated (within 2.3/255 of the full map).
const STOPS = {
  vik: "001261021f69022b710237790344810551890c5e921c6d9c307da6488db2619ebd7aaec894bed2adcdddc6dbe6dee6e9ece5e0eedbd0e9ccbae3bca5dcac90d69d7ccf8e68c98056c37243bd6431b3531fa5400f942f06832106741506670a07590008",
  romaO: "73395779384c7e3942843d3a8b4433924d2f99582ca2662caa752fb48636bd9842c6aa52cfbc66d4cb7bd6d790d3dea3cbe1b3c1e1beb1ddc7a0d6cc8dcccf7bc0ce6ab2cb5da4c75495c04f86b84f76ae5267a15859935f4d836644746c3d65723959",
  batlow: "01195908255b0d315d0f3b5f114360134b611752621b59622260612b655e356a59416f534d734d5a7745677b3e747e388282318f862d9f892baf8d2ebe9035cd923fdb954be7985af19d6bf8a27efca890fdaea2fdb4b4fdbac4fcbfd6fbc6e8faccfa",
};
const LUTS = {};

// 256 × RGB of a named map.
export function lut(name) {
  if (LUTS[name]) return LUTS[name];
  const hex = STOPS[name];
  const n = hex.length / 6;
  const stops = Array.from({ length: n }, (_, k) => [0, 2, 4].map((o) => parseInt(hex.slice(k * 6 + o, k * 6 + o + 2), 16)));
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * (n - 1);
    const k = Math.min(n - 2, Math.floor(f));
    const t = f - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[k][c] * (1 - t) + stops[k + 1][c] * t;
  }
  LUTS[name] = out;
  return out;
}

export function cssColour(name, f) {
  const l = lut(name);
  const i = Math.max(0, Math.min(255, Math.round(f * 255))) * 3;
  return `rgb(${l[i]} ${l[i + 1]} ${l[i + 2]})`;
}

// ---------------------------------------------------------------- planes

export const DISPLACEMENT = new Set(["los", "east", "up", "cum", "model_los", "model_east", "model_up", "before_los", "before_east", "before_up"]);
const SIGNED = new Set([...DISPLACEMENT, "rate_los", "rate_up", "rate_east", "resid"]);

export function planeIndex(doc, id) {
  return doc.planes.findIndex((p) => p.id === id);
}

// Float32 values of plane k (NaN = no data), cached per view.
const cache = new WeakMap();
export function planeValues(doc, view, k) {
  if (!cache.has(view)) cache.set(view, new Map());
  const m = cache.get(view);
  if (m.has(k)) return m.get(k);
  const n = doc.grid.width * doc.grid.height;
  const scale = doc.planes[k].scale ?? doc.scale_cm;
  const out = new Float32Array(n);
  const off = k * n;
  for (let i = 0; i < n; i++) {
    const q = view[off + i];
    out[i] = q === doc.nodata ? NaN : q * scale;
  }
  m.set(k, out);
  return out;
}

// A shown layer: a plane, or a residual (radar minus the USGS model) built from two planes.
// { id, kind, unit, geometry, noise, values, of? }
export function layerData(doc, view, id) {
  if (id.startsWith("resid:")) {
    const [, dataId, modelId] = id.split(":");
    const kd = planeIndex(doc, dataId);
    const km = planeIndex(doc, modelId);
    if (kd < 0 || km < 0) return null;
    const a = planeValues(doc, view, kd);
    const b = planeValues(doc, view, km);
    const key = `${id}`;
    if (!cache.get(view).has(key)) {
      const r = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) r[i] = a[i] - b[i];
      cache.get(view).set(key, r);
    }
    const p = doc.planes[kd];
    return { id, kind: "resid", base: p.kind, unit: p.unit, geometry: p.geometry, noise: p.noise ?? null, values: cache.get(view).get(key) };
  }
  const k = planeIndex(doc, id);
  if (k < 0) return null;
  const p = doc.planes[k];
  return { ...p, values: planeValues(doc, view, k) };
}

export const isSigned = (kind) => SIGNED.has(kind);
export const canFringe = (layer) => layer && (DISPLACEMENT.has(layer.kind) || (layer.kind === "resid" && DISPLACEMENT.has(layer.base)));

// ---------------------------------------------------------------- scales

export function quantile(values, q) {
  const v = [];
  for (const x of values) if (Number.isFinite(x)) v.push(x);
  if (!v.length) return NaN;
  v.sort((a, b) => a - b);
  const f = (v.length - 1) * q;
  const i = Math.floor(f);
  return i + 1 < v.length ? v[i] + (v[i + 1] - v[i]) * (f - i) : v[i];
}

// The next round number at or above x: 1, 2, 2.5, 3, 4, 5, 6, 8 × 10^k.
export function niceCeil(x) {
  if (!(x > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(x));
  const step = [1, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * mag >= x - 1e-9 * mag);
  return +(step * mag).toPrecision(6);
}

// The default colour range: symmetric about zero at the 99th percentile of |value| for signed
// layers (the 1 % beyond is shown saturated and counted), 0 to the 99th percentile otherwise.
export function autoRange(layer) {
  if (layer.kind === "coherence") return [0, 1];
  if (isSigned(layer.kind)) {
    const abs = Float32Array.from(layer.values, Math.abs);
    const m = niceCeil(quantile(abs, 0.99));
    return [-m, m];
  }
  return [0, niceCeil(quantile(layer.values, 0.99))];
}

// Counts in `bins` equal bins over [lo, hi], with the values beyond each end.
export function histogram(values, lo, hi, bins = 48) {
  const counts = new Array(bins).fill(0);
  let below = 0;
  let above = 0;
  let n = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    n++;
    if (v < lo) below++;
    else if (v > hi) above++;
    else counts[Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins))]++;
  }
  return { counts, below, above, n };
}

// ---------------------------------------------------------------- relief

// Hillshade 0…1 from heights (Horn 1981 slope, sun from the north-west at 45°), on a grid of
// cells res_m apart; NaN where no height.
export function hillshade(dem, width, height, resM) {
  const out = new Float32Array(width * height).fill(NaN);
  // ESRI's formulation: the sun's azimuth turned to maths angle (360 − 315 + 90 = 135°).
  const azMath = ((360 - 315 + 90) * Math.PI) / 180;
  const zenith = (45 * Math.PI) / 180;
  const z = (r, c) => dem[Math.min(height - 1, Math.max(0, r)) * width + Math.min(width - 1, Math.max(0, c))];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!Number.isFinite(dem[r * width + c])) continue;
      const a = z(r - 1, c - 1), b = z(r - 1, c), cc = z(r - 1, c + 1);
      const d = z(r, c - 1), f = z(r, c + 1);
      const g = z(r + 1, c - 1), hh = z(r + 1, c), i = z(r + 1, c + 1);
      const dzdx = (cc + 2 * f + i - (a + 2 * d + g)) / (8 * resM);
      const dzdy = (g + 2 * hh + i - (a + 2 * b + cc)) / (8 * resM);
      if (!Number.isFinite(dzdx) || !Number.isFinite(dzdy)) continue;
      const slope = Math.atan(Math.hypot(dzdx, dzdy));
      const aspect = Math.atan2(dzdy, -dzdx);
      const s = Math.cos(zenith) * Math.cos(slope) + Math.sin(zenith) * Math.sin(slope) * Math.cos(azMath - aspect);
      out[r * width + c] = Math.max(0, Math.min(1, s));
    }
  }
  return out;
}

// ---------------------------------------------------------------- painting

// Paint a layer into ImageData-sized RGBA. style: { lo, hi, fringe_cm (null = continuous),
// shade (Float32Array|null), sea (Uint8Array|null: no-data cells drawn clear) }.
export function paint(layer, width, height, style) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const signed = isSigned(layer.kind);
  const map = style.fringe_cm ? lut("romaO") : lut(signed ? "vik" : "batlow");
  const { lo, hi, fringe_cm: fr, shade, sea } = style;
  const v = layer.values;
  for (let i = 0; i < v.length; i++) {
    const o = i * 4;
    const x = v[i];
    const sh = shade ? shade[i] : NaN;
    if (Number.isFinite(x)) {
      let f = fr ? (((x / fr) % 1) + 1) % 1 : (x - lo) / (hi - lo);
      f = Math.max(0, Math.min(1, f));
      const j = Math.round(f * 255) * 3;
      // Relief under the colour, lightly (GMT's grdimage -I convention): 0.82…1.0 of the colour.
      const k = Number.isFinite(sh) ? 0.82 + 0.18 * sh : 1;
      rgba[o] = map[j] * k;
      rgba[o + 1] = map[j + 1] * k;
      rgba[o + 2] = map[j + 2] * k;
      rgba[o + 3] = 242;
    } else if (Number.isFinite(sh) && !(sea && sea[i])) {
      // Not measured: grey relief, so a hole reads as "no data here", not as "no motion".
      const g = 70 + 120 * sh;
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = 150;
    }
  }
  return rgba;
}

// The stable reference as fine diagonal hatching on its own overlay, `k` canvas pixels per
// cell so the lines stay thin when the map is zoomed in.
export function paintHatch(mask, width, height, k = 3) {
  const W = width * k;
  const H = height * k;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const row = Math.floor(y / k) * width;
    for (let x = (8 - (y % 8)) % 8; x < W; x += 8) {
      if (!mask[row + Math.floor(x / k)]) continue;
      const o = (y * W + x) * 4;
      rgba[o] = 11;
      rgba[o + 1] = 18;
      rgba[o + 2] = 20;
      rgba[o + 3] = 150;
    }
  }
  return { rgba, width: W, height: H };
}

export function toCanvas(rgba, width, height, canvas = document.createElement("canvas")) {
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

// ---------------------------------------------------------------- profiles

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLon = (lat) => 111.32 * Math.cos((lat * Math.PI) / 180);

// Swath profile from a to b ([lon, lat]): every measured cell within halfWidthKm of the line,
// as (distance along km, value); then per bin the median and the 25th and 75th percentiles
// (a swath profile, as in fault studies: Telbisz et al. 2013; MintPy's transects).
export function swathProfile(values, grid, a, b, halfWidthKm, binKm = null) {
  const [w, s, e, n] = grid.bounds;
  const lat0 = (a[1] + b[1]) / 2;
  const kx = kmPerDegLon(lat0);
  const ax = 0, ay = 0;
  const bx = (b[0] - a[0]) * kx;
  const by = (b[1] - a[1]) * KM_PER_DEG_LAT;
  const len = Math.hypot(bx, by);
  if (!(len > 0)) return null;
  const ux = bx / len, uy = by / len;
  const dLon = (e - w) / grid.width;
  const dLat = (n - s) / grid.height;
  const pad = halfWidthKm / Math.min(kx, KM_PER_DEG_LAT);
  const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - pad - w) / dLon));
  const c1 = Math.min(grid.width - 1, Math.ceil((Math.max(a[0], b[0]) + pad - w) / dLon));
  const r0 = Math.max(0, Math.floor((n - Math.max(a[1], b[1]) - pad) / dLat));
  const r1 = Math.min(grid.height - 1, Math.ceil((n - Math.min(a[1], b[1]) + pad) / dLat));
  const pts = [];
  for (let r = r0; r <= r1; r++) {
    const lat = n - (r + 0.5) * dLat;
    const py = (lat - a[1]) * KM_PER_DEG_LAT - ay;
    for (let c = c0; c <= c1; c++) {
      const v = values[r * grid.width + c];
      if (!Number.isFinite(v)) continue;
      const px = (w + (c + 0.5) * dLon - a[0]) * kx - ax;
      const along = px * ux + py * uy;
      const across = -px * uy + py * ux;
      if (along < 0 || along > len || Math.abs(across) > halfWidthKm) continue;
      pts.push([along, v]);
    }
  }
  const bin = binKm ?? Math.max((grid.res_m / 1000) * 2, len / 60);
  const nb = Math.max(1, Math.ceil(len / bin));
  const groups = Array.from({ length: nb }, () => []);
  for (const [d, v] of pts) groups[Math.min(nb - 1, Math.floor(d / bin))].push(v);
  const bins = groups.map((g, k) => {
    if (g.length < 3) return { s: (k + 0.5) * bin, n: g.length, med: NaN, p25: NaN, p75: NaN };
    g.sort((x, y) => x - y);
    const q = (p) => {
      const f = (g.length - 1) * p;
      const i = Math.floor(f);
      return i + 1 < g.length ? g[i] + (g[i + 1] - g[i]) * (f - i) : g[i];
    };
    return { s: (k + 0.5) * bin, n: g.length, med: q(0.5), p25: q(0.25), p75: q(0.75) };
  });
  return { lengthKm: len, bin, bins, points: pts };
}

// Where segment a-b first crosses a polyline (lon/lat), as km from a; null if it does not.
export function crossingKm(a, b, line) {
  const lat0 = (a[1] + b[1]) / 2;
  const kx = kmPerDegLon(lat0);
  const P = (p) => [(p[0] - a[0]) * kx, (p[1] - a[1]) * KM_PER_DEG_LAT];
  const B = P(b);
  let best = null;
  for (let k = 0; k + 1 < line.length; k++) {
    const C = P(line[k]);
    const D = P(line[k + 1]);
    const den = B[0] * (D[1] - C[1]) - B[1] * (D[0] - C[0]);
    if (Math.abs(den) < 1e-12) continue;
    const t = (C[0] * (D[1] - C[1]) - C[1] * (D[0] - C[0])) / den;
    const u = (C[0] * B[1] - C[1] * B[0]) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const d = t * Math.hypot(B[0], B[1]);
      if (best === null || d < best) best = d;
    }
  }
  return best;
}

// The cells within radiusM of a point (row-major indices).
export function cellsNear(grid, lon, lat, radiusM) {
  const [w, s, e, n] = grid.bounds;
  const dLon = (e - w) / grid.width;
  const dLat = (n - s) / grid.height;
  const kx = kmPerDegLon(lat) * 1000;
  const ky = KM_PER_DEG_LAT * 1000;
  const out = [];
  const rc = Math.ceil(radiusM / (dLon * kx)) + 1;
  const rr = Math.ceil(radiusM / (dLat * ky)) + 1;
  const c0 = Math.floor((lon - w) / dLon);
  const r0 = Math.floor((n - lat) / dLat);
  for (let r = r0 - rr; r <= r0 + rr; r++) {
    if (r < 0 || r >= grid.height) continue;
    for (let c = c0 - rc; c <= c0 + rc; c++) {
      if (c < 0 || c >= grid.width) continue;
      const dx = (w + (c + 0.5) * dLon - lon) * kx;
      const dy = (n - (r + 0.5) * dLat - lat) * ky;
      if (dx * dx + dy * dy <= radiusM * radiusM) out.push(r * grid.width + c);
    }
  }
  return out;
}

export function medianAt(values, cells) {
  const v = cells.map((i) => values[i]).filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Least-squares line through (x, y) pairs: { slope, intercept } or null with fewer than 2.
export function fitLine(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 2) return null;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxx = 0, sxy = 0;
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

// Read the event binary: gzip undone by the browser's own DecompressionStream (a server that
// already undid it is detected by the gzip magic bytes).
export async function readBinary(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
    buf = await new Response(stream).arrayBuffer();
  }
  return buf;
}
