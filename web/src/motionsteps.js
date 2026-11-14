// Ground that moved: what plays in the bar under the map (docs/10 D-089, D-090, D-091). Every
// layer has a time-stepping target:
// - earthquake (east-west, up-down, each track's line of sight): the map 12 days before the
//   quake (measured, the noise floor), then the rupture second by second from the USGS fault
//   model (each subfault's static Okada displacement scaled by how much of its slip it has
//   reached at its rupture and rise times, the bars being the moment released per step: the
//   source-time function), then NISAR's measured map across the quake;
// - subsidence: a track's total since its first date, date by date; or the vertical and
//   east-west totals, split from the two tracks at the ascending track's dates (the descending
//   series interpolated in time to them), as InSAR time-series tools animate them.
// Layers that do not change in time (model, residual, uncertainty, coherence) play their
// event's main motion. Pure functions on the loaded bundle; nothing here touches the DOM.
import { layerData, planeIndex, planeValues, quantile } from "./motionmaps.js";

// The choice a layer plays through.
export function targetOf(doc, choice) {
  if (!choice) return null;
  if (doc.kind === "earthquake") {
    if (choice === "east" || choice === "up" || /^los_/.test(choice)) return choice;
    if (planeIndex(doc, "east") >= 0) return "east";
    return doc.planes.find((p) => p.kind === "los")?.id ?? null;
  }
  if (choice.startsWith("cum:") || choice.startsWith("total:")) return choice;
  const rate = /^rate_(\d{3}[AD])$/.exec(choice);
  if (rate) return `cum:${rate[1]}`;
  const sig = /^sigma_rate_(\d{3}[AD])$/.exec(choice);
  if (sig) return `cum:${sig[1]}`;
  const split = splitPair(doc);
  if (!split) return firstCum(doc);
  return /east/.test(choice) ? "total:east" : "total:up";
}

export const isTemporal = (doc, choice) => Boolean(choice) && targetOf(doc, choice) === choice;

function firstCum(doc) {
  const p = doc.planes.find((q) => q.kind === "cum");
  return p ? `cum:${p.geometry}` : null;
}

// The ascending and descending geometries with a time series, if both exist.
export function splitPair(doc) {
  const withCum = (dir) => doc.geometries.find((g) => g.direction === dir && doc.planes.some((p) => p.kind === "cum" && p.geometry === g.key));
  const a = withCum("ascending");
  const d = withCum("descending");
  return a && d ? { asc: a, desc: d } : null;
}

const cumPlanes = (doc, geom) => doc.planes.filter((p) => p.kind === "cum" && p.geometry === geom).sort((a, b) => (a.date < b.date ? -1 : 1));
const dayOf = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

// Linear interpolation of a dated series of maps at day `t` (clamped at its ends).
export function interpAt(days, maps, t) {
  if (t <= days[0]) return maps[0];
  if (t >= days.at(-1)) return maps.at(-1);
  let i = 0;
  while (days[i + 1] < t) i++;
  const w = (t - days[i]) / (days[i + 1] - days[i]);
  const a = maps[i];
  const b = maps[i + 1];
  const out = new Float32Array(a.length);
  for (let k = 0; k < a.length; k++) out[k] = a[k] * (1 - w) + b[k] * w;
  return out;
}

// East and up from an ascending and a descending line of sight (north left out, as the
// pipeline's decompose), with each geometry's median look vector.
export function splitEU(la, ld, asc, desc) {
  const [ea, , ua] = asc.los_enu;
  const [ed, , ud] = desc.los_enu;
  const det = ea * ud - ua * ed;
  const e = new Float32Array(la.length);
  const u = new Float32Array(la.length);
  for (let i = 0; i < la.length; i++) {
    e[i] = (ud * la[i] - ua * ld[i]) / det;
    u[i] = (ea * ld[i] - ed * la[i]) / det;
  }
  return { e, u };
}

// Bilinear upsampling of a coarse plane (w2 x h2) to the map grid (W x H), cell centres aligned.
export function upsample(src, w2, h2, W, H) {
  const out = new Float32Array(W * H);
  for (let r = 0; r < H; r++) {
    const y = Math.min(h2 - 1, Math.max(0, ((r + 0.5) * h2) / H - 0.5));
    const y0 = Math.floor(y);
    const y1 = Math.min(h2 - 1, y0 + 1);
    const fy = y - y0;
    for (let c = 0; c < W; c++) {
      const x = Math.min(w2 - 1, Math.max(0, ((c + 0.5) * w2) / W - 0.5));
      const x0 = Math.floor(x);
      const x1 = Math.min(w2 - 1, x0 + 1);
      const fx = x - x0;
      out[r * W + c] =
        src[y0 * w2 + x0] * (1 - fx) * (1 - fy) + src[y0 * w2 + x1] * fx * (1 - fy) + src[y1 * w2 + x0] * (1 - fx) * fy + src[y1 * w2 + x1] * fx * fy;
    }
  }
  return out;
}

// Moment magnitude of a seismic moment (N m), Hanks & Kanamori 1979.
export const mwOf = (m0) => (m0 > 0 ? (2 / 3) * (Math.log10(m0) - 9.1) : null);

const cache = new WeakMap();

// The steps of a target: [{ type: "before"|"model"|"across"|"date", time_s?, date?, height,
// moment_nm?, cumulative_nm?, layer(): { id, kind, unit, noise, values } }].
export function stepsOf(b, target) {
  if (!b || !target) return [];
  if (!cache.has(b)) cache.set(b, new Map());
  const memo = cache.get(b);
  if (memo.has(target)) return memo.get(target);
  const { doc, view } = b;
  const lazy = (fn) => {
    let v = null;
    return () => (v ??= fn());
  };
  let steps = [];
  if (doc.kind === "earthquake") {
    const across = layerData(doc, view, target);
    const beforeId = target === "east" ? "before_east" : target === "up" ? "before_up" : `before_${target}`;
    if (planeIndex(doc, beforeId) >= 0) steps.push({ type: "before", layer: lazy(() => ({ ...layerData(doc, view, beforeId), kind: across.kind })) });
    const rup = doc.rupture;
    if (rup && b.rupture) {
      const comp = target === "east" ? [1, 0, 0] : target === "up" ? [0, 0, 1] : doc.geometries.find((g) => `los_${g.key}` === target)?.los_enu;
      const peak = Math.max(...rup.moment_released_nm, 1e-9);
      let cum = 0;
      rup.times_s.forEach((t, k) => {
        cum += rup.moment_released_nm[k];
        steps.push({
          type: "model",
          time_s: t,
          moment_nm: rup.moment_released_nm[k],
          cumulative_nm: cum,
          height: rup.moment_released_nm[k] / peak,
          layer: lazy(() => ({ id: `rupture_${k}_${target}`, kind: across.kind, unit: "cm", noise: null, values: ruptureFrame(b, k, comp, across.values) })),
        });
      });
    }
    steps.push({ type: "across", layer: () => across });
    // Measured steps: bars sized by how much the map moves next to the model's last frame.
    const p99 = (vals) => quantile(Float32Array.from(vals, Math.abs), 0.99) || 0;
    const ref = p99(across.values) || 1;
    for (const s of steps) if (s.type !== "model") s.height = Math.max(0.04, Math.min(1, p99(s.layer().values) / ref)) * (rup ? 0.35 : 1);
  } else if (target.startsWith("cum:")) {
    const ps = cumPlanes(doc, target.slice(4));
    const lay = ps.map((p) => lazy(() => layerData(doc, view, p.id)));
    steps = ps.map((p, i) => ({ type: "date", date: p.date, layer: lay[i] }));
    sinkHeights(steps);
  } else {
    const pair = splitPair(doc);
    const asc = cumPlanes(doc, pair.asc.key);
    const desc = cumPlanes(doc, pair.desc.key);
    const ascMaps = asc.map((p) => planeValues(doc, view, planeIndex(doc, p.id)));
    const descMaps = desc.map((p) => planeValues(doc, view, planeIndex(doc, p.id)));
    const dDays = desc.map((p) => dayOf(p.date));
    // Both series start at zero on the ascending track's first date.
    const d0 = interpAt(dDays, descMaps, dayOf(asc[0].date));
    const comp = target === "total:east" ? "e" : "u";
    steps = asc.map((p, i) => ({
      type: "date",
      date: p.date,
      layer: lazy(() => {
        const ld = interpAt(dDays, descMaps, dayOf(p.date));
        const rel = Float32Array.from(ld, (v, k) => v - d0[k]);
        const eu = splitEU(ascMaps[i], rel, pair.asc, pair.desc);
        return { id: `${target}_${p.date}`, kind: comp === "e" ? "east" : "up", unit: "cm", noise: null, values: eu[comp] };
      }),
    }));
    sinkHeights(steps, comp === "e");
  }
  memo.set(target, steps);
  return steps;
}

// Bars for a dated series: how far the fastest-moving 5 % had gone (5th percentile of the
// total for sinking; the 99th of |east| for east-west), against the last date.
function sinkHeights(steps, absolute = false) {
  const v = steps.map((s) => {
    const vals = s.layer().values;
    return absolute ? quantile(Float32Array.from(vals, Math.abs), 0.99) || 0 : Math.abs(quantile(vals, 0.05)) || 0;
  });
  const top = Math.max(...v, 1e-9);
  steps.forEach((s, i) => (s.height = v[i] / top));
}

// One rupture frame on the map grid, projected on `comp` (east, north, up weights), referenced
// like the data (the median over the reference box removed) and shown where the measured map
// is, so the model grows into the radar's own footprint.
function ruptureFrame(b, k, comp, measured) {
  const { doc } = b;
  const { width: w2, height: h2 } = doc.rupture.grid;
  const n2 = w2 * h2;
  const sc = doc.rupture.scale_cm;
  const base = k * 3 * n2;
  const v2 = new Float32Array(n2);
  for (let i = 0; i < n2; i++) {
    const e = b.rupture[base + i];
    const n = b.rupture[base + n2 + i];
    const u = b.rupture[base + 2 * n2 + i];
    v2[i] = (comp[0] * e + comp[1] * n + comp[2] * u) * sc;
  }
  const { width: W, height: H, bounds } = doc.grid;
  const full = upsample(v2, w2, h2, W, H);
  const [w, s, e, n] = bounds;
  const box = doc.reference.bbox;
  const inRef = [];
  for (let r = 0; r < H; r++) {
    const lat = n - ((r + 0.5) * (n - s)) / H;
    if (lat < box[1] || lat > box[3]) continue;
    for (let c = 0; c < W; c++) {
      const lon = w + ((c + 0.5) * (e - w)) / W;
      if (lon >= box[0] && lon <= box[2] && Number.isFinite(measured[r * W + c])) inRef.push(full[r * W + c]);
    }
  }
  const off = inRef.length ? quantile(inRef, 0.5) : 0;
  for (let i = 0; i < full.length; i++) full[i] = Number.isFinite(measured[i]) ? full[i] - off : NaN;
  return full;
}

// The layer shown for a choice at a step index (null = the last step).
export function shownLayer(b, choice, idx) {
  const target = targetOf(b.doc, choice);
  if (!isTemporal(b.doc, choice)) return layerData(b.doc, b.view, choice);
  const steps = stepsOf(b, target);
  if (!steps.length) return null;
  const k = idx === null || idx === undefined ? steps.length - 1 : Math.max(0, Math.min(steps.length - 1, idx));
  return steps[k].layer();
}
