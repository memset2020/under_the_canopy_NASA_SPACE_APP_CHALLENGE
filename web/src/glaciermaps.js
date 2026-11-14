// Glacier atlas (docs/16, D-086): the maths and painting behind glaciers.js. Pure functions on the
// planes of glacier.bin (ITS_LIVE speed, east/north flow, trend, seasonal swing, annual speeds),
// plus canvas painters and the flow-particle step. No DOM outside the painters, no shared state.
import { lut } from "./motionmaps.js";

// ---------------------------------------------------------------- colour

// Ice speed: an ice ramp (deep blue to white) interpolated in OKLab so equal steps of log speed look
// equally different, and lightness rises monotonically (readable in greyscale and with colour-vision
// deficiency). Glaciologists map speed on a log scale: 1 to 10,000 m a year spans a valley glacier
// to Jakobshavn's front (Joughin et al. 2010; Gardner et al. 2018; Mouginot et al. 2019).
const ICE_ANCHORS = ["0d1b3a", "1c3f7a", "2f6db0", "4ea0d0", "8fcde6", "d4eef6", "ffffff"];

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(v) {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}
export function toOklab([r, g, b]) {
  const [R, G, B] = [r, g, b].map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
export function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(linearToSrgb);
}

let ICE_LUT = null;
// 256 × RGB of the ice ramp.
export function iceLut() {
  if (ICE_LUT) return ICE_LUT;
  const labs = ICE_ANCHORS.map((hx) => toOklab([0, 2, 4].map((o) => parseInt(hx.slice(o, o + 2), 16))));
  const out = new Uint8ClampedArray(256 * 3);
  const n = labs.length - 1;
  for (let i = 0; i < 256; i++) {
    const f = (i / 255) * n;
    const k = Math.min(n - 1, Math.floor(f));
    const t = f - k;
    const rgb = fromOklab(labs[k].map((v, c) => v * (1 - t) + labs[k + 1][c] * t));
    out.set(rgb, i * 3);
  }
  ICE_LUT = out;
  return out;
}

export function rampColour(name, f) {
  const l = name === "ice" ? iceLut() : lut(name);
  const i = Math.max(0, Math.min(255, Math.round(f * 255))) * 3;
  return `rgb(${l[i]} ${l[i + 1]} ${l[i + 2]})`;
}

// ---------------------------------------------------------------- scales

// Log speed scale: [lo, hi] m/yr to 0..1. lo is at least 1 m/yr.
export function logScale(lo, hi) {
  const a = Math.log10(Math.max(1, lo));
  const b = Math.log10(Math.max(lo * 10, hi));
  return {
    lo: 10 ** a,
    hi: 10 ** b,
    f: (v) => Math.max(0, Math.min(1, (Math.log10(Math.max(v, 1e-6)) - a) / (b - a))),
    inv: (f) => 10 ** (a + f * (b - a)),
  };
}

// The speed range a glacier's maps use: from its slow ice (2nd percentile, at least 3 m/yr) to its
// fastest (99.5th percentile) rounded out to 1, 2 or 5 × 10^k, so the ends read as round numbers.
export function speedRange(stats) {
  const nice = (v, up) => {
    const e = 10 ** Math.floor(Math.log10(v));
    const steps = up ? [1, 2, 5, 10] : [10, 5, 2, 1];
    for (const s of steps) if (up ? s * e >= v : s * e <= v) return s * e;
    return v;
  };
  const lo = Math.max(3, stats.p02_m_yr ?? 3);
  const hi = Math.max(lo * 10, stats.max_m_yr ?? lo * 100);
  return [nice(lo, false), nice(hi, true)];
}

// Ticks of a log scale: 1, 2, 5 × 10^k inside [lo, hi], thinned to at most n.
export function logTicks(lo, hi, n = 5) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  }
  if (out.length <= n) return out;
  const ones = out.filter((v) => Math.abs(Math.log10(v) % 1) < 1e-9 || Math.abs((Math.log10(v) % 1) - 1) < 1e-9);
  return ones.length >= 2 ? ones : [out[0], out.at(-1)];
}

// Symmetric range for the trend map, from the 2nd and 98th percentiles, rounded out.
export function trendRange(stats) {
  const m = Math.max(Math.abs(stats.trend_p02 ?? 0), Math.abs(stats.trend_p98 ?? 0), 0.5);
  const e = 10 ** Math.floor(Math.log10(m));
  for (const s of [1, 2, 5, 10]) if (s * e >= m) return s * e;
  return m;
}

// ---------------------------------------------------------------- planes

// Decode glacier.bin: { [plane id]: Float32Array (NaN = no data) } and `annual`: Float32Array[] per
// year on the half-resolution grid. Speeds are uint16, signed planes int16 stored as their bits.
export function decodePlanes(doc, buf) {
  const n = doc.grid.width * doc.grid.height;
  const u16 = new Uint16Array(buf);
  const out = {};
  doc.planes.forEach((p, k) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const q = u16[k * n + i];
      if (p.signed) {
        const sgn = q >= 32768 ? q - 65536 : q;
        a[i] = sgn === -32768 ? NaN : sgn * p.scale;
      } else a[i] = q === 65535 ? NaN : q * p.scale;
    }
    out[p.id] = a;
  });
  const ag = doc.annual_grid;
  const m = ag.width * ag.height;
  const base = doc.planes.length * n;
  out.annual = ag.years.map((_, y) => {
    const a = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const q = u16[base + y * m + i];
      a[i] = q === 65535 ? NaN : q * ag.scale;
    }
    return a;
  });
  return out;
}

// ---------------------------------------------------------------- painting

// RGBA of a plane. kind: "speed" (log ice ramp), "trend" (vik, symmetric), "phase" (romaO, day of
// year as a cycle). Off-ice and unmeasured cells stay clear so the relief shows through.
export function paintPlane(values, kind, range) {
  const rgba = new Uint8ClampedArray(values.length * 4);
  const map = kind === "speed" ? iceLut() : lut(kind === "trend" ? "vik" : "romaO");
  const sc = kind === "speed" ? logScale(range[0], range[1]) : null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let f;
    if (kind === "speed") f = sc.f(v);
    else if (kind === "trend") f = 0.5 + 0.5 * Math.max(-1, Math.min(1, v / range));
    else f = (((v - 1) / 365.25) % 1 + 1) % 1;
    const j = Math.round(f * 255) * 3;
    const o = i * 4;
    rgba[o] = map[j];
    rgba[o + 1] = map[j + 1];
    rgba[o + 2] = map[j + 2];
    rgba[o + 3] = 235;
  }
  return rgba;
}

// Every cell of the box gets a colour (no holes): where the shown layer has no value, the
// surface class from the pipeline decides. Neutral greys, apart from the ice ramp's blues:
// ice without a value in this layer, rock (ITS_LIVE measures it, near zero), and open water
// or no measurement. `surface` is on the full grid; rgba may be coarser (the annual grid).
export const SURFACE_COLOURS = { 2: [146, 160, 168], 3: [92, 88, 82], 4: [38, 45, 50] };
// `shade` (0-1 hillshade on the full grid, or null): rock is drawn as terrain (the relief at full
// strength), the ice and its colours keep a light relief under them, open water stays flat.
export function fillSurface(rgba, w, h, surface, fullW, fullH, layerIce = [146, 160, 168], shade = null) {
  if (!surface) return rgba;
  for (let r = 0; r < h; r++) {
    const sr = Math.min(fullH - 1, Math.floor(((r + 0.5) * fullH) / h));
    for (let c = 0; c < w; c++) {
      const o = (r * w + c) * 4;
      const sc = Math.min(fullW - 1, Math.floor(((c + 0.5) * fullW) / w));
      const fi = sr * fullW + sc;
      const sh = shade ? shade[fi] : NaN;
      if (rgba[o + 3]) {
        if (Number.isFinite(sh)) {
          const f = 0.84 + 0.2 * sh; // GMT grdimage -I style: the colour lit by the relief
          rgba[o] *= f;
          rgba[o + 1] *= f;
          rgba[o + 2] *= f;
        }
        continue;
      }
      const k = surface[fi];
      // Ice that has a speed but no value in this layer reads as ice without a value.
      const col = k === 1 || k === 2 || k === 5 ? layerIce : SURFACE_COLOURS[k] ?? SURFACE_COLOURS[4];
      const f = k === 3 && Number.isFinite(sh) ? 0.45 + 0.95 * sh : k === 4 ? 1 : Number.isFinite(sh) ? 0.84 + 0.2 * sh : 1;
      rgba[o] = col[0] * f;
      rgba[o + 1] = col[1] * f;
      rgba[o + 2] = col[2] * f;
      rgba[o + 3] = 235;
    }
  }
  return rgba;
}

// ---------------------------------------------------------------- flow particles

// Bilinear east/north speed at a fractional cell (x right, y down); null off the ice.
export function flowAt(east, north, w, h, x, y) {
  const cx = x - 0.5;
  const cy = y - 0.5;
  if (cx < 0 || cy < 0 || cx > w - 1 || cy > h - 1) return null;
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  let e = 0;
  let n = 0;
  let wsum = 0;
  for (const [i, wt] of [[y0 * w + x0, (1 - fx) * (1 - fy)], [y0 * w + x1, fx * (1 - fy)], [y1 * w + x0, (1 - fx) * fy], [y1 * w + x1, fx * fy]]) {
    if (wt === 0 || !Number.isFinite(east[i]) || !Number.isFinite(north[i])) continue;
    e += east[i] * wt;
    n += north[i] * wt;
    wsum += wt;
  }
  if (wsum < 0.5) return null;
  return [e / wsum, n / wsum];
}

// The flow over the whole box (docs/10 D-087), so the ice ends up somewhere: on measured ice
// the measurement; across a gap in the ice the flow of the nearest measured ice; past the
// front, over open water, the front's own flow carried on and fading with distance from it
// (exp(-d / decayKm)) until a shore or the box edge, which is where calved ice and meltwater
// go; rock keeps no flow (ITS_LIVE measures it still). `surface` classes as the pipeline's:
// 1 ice, 2 ice without a speed, 3 rock, 4 water or no measurement, 5 floating ice and melange
// (measured: it takes part as measured ice). Returns new east/north
// arrays and `drawn` (0 measured, 1 carried on). A shortest-path search from the ice at the
// edges (faster ice starting ahead), then a light smoothing of the carried-on cells only.
export function extendFlow(east, north, surface, w, h, cellM, decayKm = 6) {
  const n = w * h;
  const e = Float32Array.from(east);
  const no = Float32Array.from(north);
  const drawn = new Uint8Array(n);
  if (!surface) return { east: e, north: no, drawn };
  const src = new Int32Array(n).fill(-1); // the measured cell each carried-on cell takes its flow from
  const steps = new Float32Array(n).fill(-1); // path length from that cell, in cells
  const cost = new Float32Array(n).fill(Infinity);
  const open = (i) => surface[i] === 2 || surface[i] === 4 || (surface[i] === 1 && !(Number.isFinite(east[i]) && Number.isFinite(north[i])));
  const isSrc = (i) => Number.isFinite(east[i]) && Number.isFinite(north[i]);
  // Ice leaves a glacier mostly through its fastest part: a source's cost starts lower the
  // faster it moves (HEAD cells less per tenfold speed), so the fast trunk, not a slow margin
  // beside it, feeds the water in front of it. Dijkstra on 8 neighbours (diagonal sqrt 2).
  const HEAD = 10;
  let vref = 0;
  for (let i = 0; i < n; i++) if (isSrc(i)) vref = Math.max(vref, Math.hypot(east[i], north[i]));
  const heap = [];
  const push = (c, i) => {
    heap.push([c, i]);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (heap[p][0] <= heap[k][0]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) {
    if (!isSrc(i)) continue;
    // Only ice that borders an open cell can feed one.
    const r = Math.floor(i / w);
    const c = i % w;
    let edge = false;
    for (let dr = -1; dr <= 1 && !edge; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr >= 0 && rr < h && cc >= 0 && cc < w && open(rr * w + cc)) {
          edge = true;
          break;
        }
      }
    }
    src[i] = i;
    steps[i] = 0;
    if (!edge) continue;
    const v = Math.max(1e-3, Math.hypot(east[i], north[i]));
    cost[i] = -HEAD * Math.log10(v / Math.max(vref, 1e-3));
    push(cost[i], i);
  }
  while (heap.length) {
    const [ci, i] = pop();
    if (ci > cost[i]) continue;
    const r = Math.floor(i / w);
    const c = i % w;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
        const j = rr * w + cc;
        if (!open(j)) continue;
        const d = dr && dc ? Math.SQRT2 : 1;
        if (ci + d < cost[j]) {
          cost[j] = ci + d;
          src[j] = src[i];
          steps[j] = steps[i] + d;
          push(cost[j], j);
        }
      }
    }
  }
  const kmPerStep = cellM / 1000;
  for (let i = 0; i < n; i++) {
    if (steps[i] <= 0) continue;
    // Ice keeps moving across a gap; past the front the flow fades with distance from it.
    const k = surface[i] === 4 ? Math.exp(-(steps[i] * kmPerStep) / decayKm) : 1;
    e[i] = east[src[i]] * k;
    no[i] = north[src[i]] * k;
    drawn[i] = 1;
  }
  // Nearest-source copying leaves seams where two sources meet: smooth the carried-on cells.
  for (let pass = 0; pass < 3; pass++) {
    const pe = Float32Array.from(e);
    const pn = Float32Array.from(no);
    for (let i = 0; i < n; i++) {
      if (!drawn[i]) continue;
      const r = Math.floor(i / w);
      const c = i % w;
      let se = 0;
      let sn = 0;
      let m = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= h || cc < 0 || cc >= w) continue;
          const j = rr * w + cc;
          if (!Number.isFinite(pe[j]) || !Number.isFinite(pn[j])) continue;
          se += pe[j];
          sn += pn[j];
          m++;
        }
      }
      if (m) {
        e[i] = se / m;
        no[i] = sn / m;
      }
    }
  }
  return { east: e, north: no, drawn };
}

// Cells a particle may start in: measured ice moving faster than `min` m/yr.
export function seedCells(east, north, min) {
  const out = [];
  for (let i = 0; i < east.length; i++) {
    if (Number.isFinite(east[i]) && Number.isFinite(north[i]) && Math.hypot(east[i], north[i]) >= min) out.push(i);
  }
  return Uint32Array.from(out);
}

// Particles drift with the ice. `cellsPerYear`: grid cells one m/yr moves in a year of animation;
// `yearsPerFrame`: years of flow each frame shows. Returns the segments to draw (x0, y0, x1, y1,
// speed) and respawns particles that leave the ice, stall, or age out. rand: () => [0, 1).
export function stepParticles(parts, field, { cellsPerYear, yearsPerFrame, maxAge, rand = Math.random }) {
  const { east, north, width, height, seeds } = field;
  const segs = [];
  const kinds = []; // per segment: 0 measured, 1 carried on (when the field says)
  Object.defineProperty(segs, "kinds", { value: kinds }); // beside the flat list, not in it
  const k = cellsPerYear * yearsPerFrame;
  for (const p of parts) {
    const v = p.age < maxAge ? flowAt(east, north, width, height, p.x, p.y) : null;
    if (!v) {
      respawn(p, seeds, width, rand, maxAge);
      continue;
    }
    // Rows grow southward, so north moves the particle up.
    const nx = p.x + v[0] * k;
    const ny = p.y - v[1] * k;
    segs.push(p.x, p.y, nx, ny, Math.hypot(v[0], v[1]));
    if (field.drawn) {
      const ci = Math.min(height - 1, Math.max(0, Math.floor(p.y))) * width + Math.min(width - 1, Math.max(0, Math.floor(p.x)));
      kinds.push(field.drawn[ci]);
    }
    p.x = nx;
    p.y = ny;
    p.age++;
  }
  return segs;
}

export function respawn(p, seeds, width, rand = Math.random, maxAge = 80) {
  if (!seeds.length) return;
  const i = seeds[Math.floor(rand() * seeds.length)];
  p.x = (i % width) + rand();
  p.y = Math.floor(i / width) + rand();
  p.age = Math.floor(rand() * maxAge * 0.6);
}

// ---------------------------------------------------------------- readouts

// A speed for people: m a day when the ice moves at least a metre a day, else m a year; km a year
// when it moves more than 1,000 m a year. Returns [value, unit key, digits].
export function humanSpeed(mYr) {
  if (mYr === null || mYr === undefined || !Number.isFinite(mYr)) return null;
  if (mYr >= 1000) return [mYr / 1000, "km_yr", mYr >= 10000 ? 0 : 1];
  return [mYr, "m_yr", 0];
}

// Per-day equivalent, for the plain-words line ("about 29 m a day").
export function perDay(mYr) {
  return mYr / 365.25;
}

// Day of year (1..366) to month index 0..11, for the seasonal legend.
export function monthOfDay(day) {
  const d = new Date(Date.UTC(2001, 0, 1) + (Math.round(day) - 1) * 86400000);
  return d.getUTCMonth();
}

// The value of a plane at a lon/lat inside a glacier's Mercator grid (null outside or not measured).
export function cellAt(doc, lon, lat, width = doc.grid.width, height = doc.grid.height) {
  const [w, s, e, n] = doc.bounds;
  const merc = (la) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360));
  const x = ((lon - w) / (e - w)) * width;
  const y = ((merc(n) - merc(lat)) / (merc(n) - merc(s))) * height;
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  return Math.floor(y) * width + Math.floor(x);
}

// Year-on-year change of the trunk speed from the first to the last measured year, as a share.
export function trunkChange(years, trunk) {
  const pts = years.map((y, i) => [y, trunk[i]]).filter(([, v]) => v !== null && v !== undefined);
  if (pts.length < 2) return null;
  const [y0, v0] = pts[0];
  const [y1, v1] = pts.at(-1);
  return { from: y0, to: y1, v0, v1, change: v0 ? (v1 - v0) / v0 : null };
}
