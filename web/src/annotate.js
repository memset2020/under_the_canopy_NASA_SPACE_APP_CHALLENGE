// Map annotation (F38): in every map view, mark the one or few features worth looking at and label
// each with its number, unit and date, computed from the pixels the view draws (docs/10 D-078).
// Cartographic rules followed here, as on NASA Earth Observatory and journal figures:
// - mark the feature itself (its outline, or a dot inside it), never a ring that also takes in
//   pixels that are not part of it;
// - anchor the leader at a point inside the feature (the pixel farthest from its edge), since
//   the centroid of a ragged patch can fall outside it;
// - put labels where they hide the least data: off the site if the leader stays short, never on
//   a map control, another label or another note's anchor;
// - at most three notes a view, so the map stays the subject, and a switch to hide them all.
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { CLASS, VEG, classifyGrid } from "./rules.js";
import { changeReference, levelFor } from "./layers.js";
import { ALPHA, changeStack, estimateEnl, hhUp, pairChange } from "./omnibus.js";
import { followPatches, pixelsOf } from "./patches.js";
import { mannKendall, theilSen } from "./trend.js";

export const id = "annotate";
export const slot = "map";

// Smallest patch worth a note: 0.05 km² is ~14 pixels at 60 m, above single-pixel speckle.
const MIN_KM2 = 0.05;
// Arrival and drainage notes judge confirmed pixels in 4 × 4 blocks (240 m): a block counts when
// a quarter of it changed beyond speckle, since single confirmed pixels seldom touch.
const CONFIRM_BLOCK = 4;
// Trend window: the last six passes up to the one shown, fixed in advance (choosing the window
// after looking, e.g. from the peak, would make the p-value meaningless); at least five passes,
// the fewest for which an exact two-sided p below 0.05 is possible.
const TREND_PASSES = 6;
const TREND_MIN = 5;
// Days flooded: "longest" is the site's own top tenth of flooded pixels, since a fixed share of
// the season finds nothing where most water comes and goes between passes.
const HYDRO_TOP = 0.9;

// Value at quantile q of a numeric list (nearest rank).
export function quantile(vals, q) {
  const v = Float64Array.from(vals).sort();
  return v.length ? v[Math.min(v.length - 1, Math.floor(q * (v.length - 1)))] : NaN;
}

// Largest 4-connected component of mask by area; returns
// { size, r0, r1, c0, c1, sumR, sumC, area, pixels } or null.
export function largestPatch(mask, W, H, rowArea) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let best = null;
  for (let start = 0; start < W * H; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let top = 0;
    let n = 0;
    stack[top++] = start;
    seen[start] = 1;
    const p = { size: 0, r0: H, r1: 0, c0: W, c1: 0, sumR: 0, sumC: 0, area: 0, first: start };
    while (top) {
      const i = stack[--top];
      const r = (i / W) | 0;
      const c = i - r * W;
      n += 1;
      p.sumR += r;
      p.sumC += c;
      p.area += rowArea[r];
      if (r < p.r0) p.r0 = r;
      if (r > p.r1) p.r1 = r;
      if (c < p.c0) p.c0 = c;
      if (c > p.c1) p.c1 = c;
      if (c > 0 && mask[i - 1] && !seen[i - 1]) (seen[i - 1] = 1), (stack[top++] = i - 1);
      if (c < W - 1 && mask[i + 1] && !seen[i + 1]) (seen[i + 1] = 1), (stack[top++] = i + 1);
      if (r > 0 && mask[i - W] && !seen[i - W]) (seen[i - W] = 1), (stack[top++] = i - W);
      if (r < H - 1 && mask[i + W] && !seen[i + W]) (seen[i + W] = 1), (stack[top++] = i + W);
    }
    p.size = n;
    if (!best || p.area > best.area) best = p;
  }
  if (!best) return null;
  // Second pass over the winner only: its pixel list, for outlines and per-patch statistics.
  const pixels = new Int32Array(best.size);
  const mark = new Uint8Array(W * H);
  let top = 0;
  let k = 0;
  stack[top++] = best.first;
  mark[best.first] = 1;
  while (top) {
    const i = stack[--top];
    pixels[k++] = i;
    const c = i % W;
    for (const j of [c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1, i - W, i + W]) {
      if (j >= 0 && j < W * H && mask[j] && !mark[j]) (mark[j] = 1), (stack[top++] = j);
    }
  }
  delete best.first;
  best.pixels = pixels;
  return best;
}

// The patch as a mask over its bounding box (one pixel of margin), holes filled: an outline of
// the outer edge reads as "this area"; tracing every hole would draw the speckle.
export function patchBox(p, W) {
  const bw = p.c1 - p.c0 + 3;
  const bh = p.r1 - p.r0 + 3;
  const m = new Uint8Array(bw * bh);
  for (const i of p.pixels) {
    const r = (i / W) | 0;
    m[(r - p.r0 + 1) * bw + (i - r * W - p.c0 + 1)] = 1;
  }
  // Flood the outside from the margin; whatever it cannot reach is the patch or a hole in it.
  const out = new Uint8Array(bw * bh);
  const stack = [0];
  out[0] = 1;
  while (stack.length) {
    const i = stack.pop();
    const c = i % bw;
    for (const j of [c > 0 ? i - 1 : -1, c < bw - 1 ? i + 1 : -1, i - bw, i + bw]) {
      if (j >= 0 && j < bw * bh && !m[j] && !out[j]) (out[j] = 1), stack.push(j);
    }
  }
  for (let i = 0; i < bw * bh; i += 1) m[i] = out[i] ? 0 : 1;
  return { mask: m, bw, bh, r0: p.r0 - 1, c0: p.c0 - 1 };
}

// Outline of a filled box mask as an SVG path in grid units (x = column, y = row), runs of pixel
// edges merged into single segments.
export function outlinePath({ mask, bw, bh, r0, c0 }) {
  const at = (r, c) => r >= 0 && r < bh && c >= 0 && c < bw && mask[r * bw + c] === 1;
  const d = [];
  // Horizontal edges: between row r-1 and r.
  for (let r = 0; r <= bh; r += 1) {
    let run = -1;
    for (let c = 0; c <= bw; c += 1) {
      const edge = c < bw && at(r - 1, c) !== at(r, c);
      if (edge && run < 0) run = c;
      if (!edge && run >= 0) {
        d.push(`M${c0 + run} ${r0 + r}h${c - run}`);
        run = -1;
      }
    }
  }
  // Vertical edges: between column c-1 and c.
  for (let c = 0; c <= bw; c += 1) {
    let run = -1;
    for (let r = 0; r <= bh; r += 1) {
      const edge = r < bh && at(r, c - 1) !== at(r, c);
      if (edge && run < 0) run = r;
      if (!edge && run >= 0) {
        d.push(`M${c0 + c} ${r0 + run}v${r - run}`);
        run = -1;
      }
    }
  }
  return d.join("");
}

// Where to anchor a leader in a patch: the pixel whose 9 × 9 neighbourhood is most filled by the
// patch (speckled masks: away from gaps and thin lines), then the farthest from the patch edge
// (two-pass chamfer distance; holes count as edge), then the nearest the centroid. A raster pole
// of inaccessibility, always a patch pixel. Returns [row, col].
export function interiorPoint(p, W, k = 4) {
  const bw = p.c1 - p.c0 + 3;
  const bh = p.r1 - p.r0 + 3;
  const BIG = 1 << 20;
  const dist = new Int32Array(bw * bh);
  for (const i of p.pixels) {
    const r = (i / W) | 0;
    dist[(r - p.r0 + 1) * bw + (i - r * W - p.c0 + 1)] = BIG;
  }
  // Summed-area table of patch membership, for the neighbourhood counts.
  const sat = new Int32Array((bw + 1) * (bh + 1));
  for (let r = 0; r < bh; r += 1) {
    for (let c = 0; c < bw; c += 1) {
      sat[(r + 1) * (bw + 1) + c + 1] = (dist[r * bw + c] ? 1 : 0) + sat[r * (bw + 1) + c + 1] + sat[(r + 1) * (bw + 1) + c] - sat[r * (bw + 1) + c];
    }
  }
  const fill = (r, c) => {
    const a = Math.max(0, r - k);
    const b = Math.min(bh, r + k + 1);
    const l = Math.max(0, c - k);
    const e = Math.min(bw, c + k + 1);
    return sat[b * (bw + 1) + e] - sat[a * (bw + 1) + e] - sat[b * (bw + 1) + l] + sat[a * (bw + 1) + l];
  };
  // 3-4 chamfer weights approximate Euclidean distance within 8 %.
  for (let r = 1; r < bh - 1; r += 1) {
    for (let c = 1; c < bw - 1; c += 1) {
      const i = r * bw + c;
      if (!dist[i]) continue;
      dist[i] = Math.min(dist[i], dist[i - 1] + 3, dist[i - bw] + 3, dist[i - bw - 1] + 4, dist[i - bw + 1] + 4);
    }
  }
  const cr = p.sumR / p.size - p.r0 + 1;
  const cc = p.sumC / p.size - p.c0 + 1;
  let best = null;
  for (let r = bh - 2; r >= 1; r -= 1) {
    for (let c = bw - 2; c >= 1; c -= 1) {
      const i = r * bw + c;
      if (!dist[i]) continue;
      dist[i] = Math.min(dist[i], dist[i + 1] + 3, dist[i + bw] + 3, dist[i + bw + 1] + 4, dist[i + bw - 1] + 4);
      const cand = { r, c, f: fill(r, c), d: dist[i], g: Math.hypot(r - cr, c - cc) };
      if (!best || cand.f > best.f || (cand.f === best.f && (cand.d > best.d || (cand.d === best.d && cand.g < best.g)))) best = cand;
    }
  }
  return [best.r + p.r0 - 1, best.c + p.c0 - 1];
}

// Sparse per-pixel measurements (InSAR level change keeps only coherent pixels) seldom touch:
// judge them in B × B blocks. A block counts when at least a quarter of it is measured and its
// median passes test; returns a pixel mask of the blocks that count.
export function blockMask(valid, value, W, H, B, test) {
  const out = new Uint8Array(W * H);
  const vals = [];
  for (let r0 = 0; r0 < H; r0 += B) {
    for (let c0 = 0; c0 < W; c0 += B) {
      vals.length = 0;
      for (let r = r0; r < Math.min(H, r0 + B); r += 1) {
        for (let c = c0; c < Math.min(W, c0 + B); c += 1) if (valid(r * W + c)) vals.push(value(r * W + c));
      }
      if (vals.length * 4 < B * B || !test(quantile(vals, 0.5))) continue;
      for (let r = r0; r < Math.min(H, r0 + B); r += 1) out.fill(1, r * W + c0, r * W + Math.min(W, c0 + B));
    }
  }
  return out;
}

// Pixel mask of the B × B blocks in which at least minShare of the pixels are set in mask.
export function blockShare(mask, W, H, B, minShare) {
  const out = new Uint8Array(W * H);
  for (let r0 = 0; r0 < H; r0 += B) {
    for (let c0 = 0; c0 < W; c0 += B) {
      let n = 0;
      let k = 0;
      for (let r = r0; r < Math.min(H, r0 + B); r += 1) {
        for (let c = c0; c < Math.min(W, c0 + B); c += 1) {
          n += 1;
          k += mask[r * W + c] ? 1 : 0;
        }
      }
      if (k < minShare * n) continue;
      for (let r = r0; r < Math.min(H, r0 + B); r += 1) out.fill(1, r * W + c0, r * W + Math.min(W, c0 + B));
    }
  }
  return out;
}

// p-value as text: three decimals below 0.01, "< 0.001" below that.
export const fmtP = (p) => (p < 0.001 ? "< 0.001" : `= ${fmtNumber(p, p < 0.01 ? 3 : 2)}`);
// Areas: two decimals below 1 km², so a small patch never reads "0.0".
export const fmtKm2 = (v) => fmtNumber(v, Math.abs(v) < 1 ? 2 : 1);
// Signed area change with a true minus sign.
export const fmtDelta = (d) => `${d >= 0 ? "+" : "−"}${fmtKm2(Math.abs(d))}`;

// Whether segment (x0,y0)–(x1,y1) passes through rect r (Liang–Barsky clipping).
export function segmentHitsRect([x0, y0, x1, y1], r) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  for (const [p, q] of [[-dx, x0 - r.x], [dx, r.x + r.w - x0], [-dy, y0 - r.y], [dy, r.y + r.h - y0]]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const u = q / p;
    if (p < 0) t0 = Math.max(t0, u);
    else t1 = Math.min(t1, u);
    if (t0 > t1) return false;
  }
  return true;
}

// Trend of the area series over the TREND_PASSES passes up to pass `upto`.
// Returns { n, p, exact, perDay } or { n } when there are too few passes.
export function areaTrend(passes, upto, key = "flooded_veg_km2") {
  const from = Math.max(0, upto - TREND_PASSES + 1);
  const win = passes.slice(from, upto + 1).filter((q) => Number.isFinite(q[key]));
  if (win.length < TREND_MIN) return { n: win.length };
  const y = win.map((q) => q[key]);
  const x = win.map((q) => Date.parse(`${q.date}T00:00:00Z`) / 86400000);
  const mk = mannKendall(y);
  return { n: win.length, p: mk.p, exact: mk.exact, perDay: theilSen(x, y) };
}

const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Nearest point of rect r to (x, y): where the leader meets the label.
export function nearestOnRect(r, x, y) {
  return [Math.max(r.x, Math.min(r.x + r.w, x)), Math.max(r.y, Math.min(r.y + r.h, y))];
}

// Choose a label rectangle for an anchor. Candidates ring the anchor at several distances and sit
// just outside each side of the data; the cost counts hidden map controls and labels (forbidden in
// practice), hidden data (to avoid) and leader length (to keep short). Returns { x, y, w, h }.
// `prefer` is the offset from the anchor the same note had on the previous pass: kept unless a
// clearly better place appears, so labels do not jump while the timeline plays (temporal coherence,
// Been, Daiches & Yap 2006, IEEE TVCG 12(5)).
// `leaders` and `plates` are the leaders and labels already placed: a label may not sit on another
// note's leader, nor its own leader run through another label.
export function placeLabel({ anchor, w, h, view, site, obstacles = [], margin = 8, prefer = null, leaders = [], plates = [] }) {
  const [ax, ay] = anchor;
  const cands = [];
  if (prefer) cands.push({ x: ax + prefer[0], y: ay + prefer[1], kept: true });
  for (const d of [28, 56, 96, 150]) {
    for (let k = 0; k < 16; k += 1) {
      const a = (k / 16) * 2 * Math.PI;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      // The label's near corner or edge midpoint sits at distance d along the direction.
      cands.push({ x: ax + ux * d - w / 2 + (ux * w) / 2, y: ay + uy * d - h / 2 + (uy * h) / 2 });
    }
  }
  if (site) {
    // In the margin beside each side of the data: centred on the anchor, or starting or ending at it.
    const g = 14;
    for (const cy of [ay - h / 2, ay - 10, ay - h + 10]) cands.push({ x: site.x - g - w, y: cy }, { x: site.x + site.w + g, y: cy });
    for (const cx of [ax - w / 2, ax - 10, ax - w + 10]) cands.push({ x: cx, y: site.y - g - h }, { x: cx, y: site.y + site.h + g });
  }
  let best = null;
  let bestCost = Infinity;
  for (const c0 of cands) {
    const c = {
      x: Math.max(margin, Math.min(view.w - margin - w, c0.x)),
      y: Math.max(margin, Math.min(view.h - margin - h, c0.y)),
      w,
      h,
    };
    const area = w * h;
    let cost = 0;
    // Covering a control, a label or an anchor is all but forbidden, however small the overlap.
    for (const o of obstacles) {
      const ov = overlap(c, o);
      if (ov > 0) cost += 100 + (60 * ov) / area;
    }
    for (const sgm of leaders) if (segmentHitsRect(sgm, c)) cost += 20;
    if (site) cost += (3 * overlap(c, site)) / area;
    const [nx, ny] = nearestOnRect(c, ax, ay);
    const len = Math.hypot(nx - ax, ny - ay);
    for (const pl of plates) if (segmentHitsRect([ax, ay, nx, ny], pl)) cost += 20;
    // A label sitting on its own anchor hides what it points at.
    if (len < 10) cost += 40;
    cost += len / 160;
    if (c0.kept) cost -= 0.6;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

export function init({ store, map, t, root }) {
  root.hidden = true; // draws on the map only; the switch lives in the layers card
  const svg = s("svg", { class: "vector-layer annotate-layer", role: "img" });
  map.panes.top.append(svg);
  // Running caption: the pass's numbers and what can be inferred from the series so far.
  const caption = h("div", { class: "annotate-caption", hidden: true, dataset: { mapControl: "" } });
  // The caption sits in the bar under the map, above the timeline it describes: on the map it
  // covered the data wherever the site reached the map's top edge (docs/10 D-080).
  const bar = document.getElementById("slot-map-bottom");
  if (bar) bar.prepend(caption);
  else map.panes.top.parentElement.append(caption);
  let notes = [];
  const cache = new Map();
  const clsCache = new Map();
  const analyses = new Map();
  // Offset of each note's label from its anchor on the last frame drawn, and which notes were drawn.
  const placed = new Map();
  let shown = new Set();

  function classes(site, p) {
    const key = `${site.summary.site.id}:${p}`;
    if (!clsCache.has(key)) {
      const L = site.layers;
      clsCache.set(
        key,
        classifyGrid(
          { hhQ: site.passPlane("hh", p), hvQ: site.passPlane("hv", p), spQ: site.passPlane("hh_spread", p), veg: site.staticPlane("veg") },
          { hh: L.hh, hv: L.hv, hh_spread: L.hh_spread },
          site.summary.thresholds,
        ),
      );
    }
    return clsCache.get(key);
  }

  // The time-series analysis of a site, once: speckle looks, the sequential omnibus change map and
  // the patches of water under the trees followed through the passes (docs/10 D-079).
  function analysis(site) {
    const id = site.summary.site.id;
    if (!analyses.has(id)) {
      // Every second pixel is plenty for a median over passes and both channels, at half the cost.
      const enl = estimateEnl(site, 2);
      const L = site.layers;
      const minPx = Math.ceil(MIN_KM2 / site.rowAreaKm2[site.height >> 1]);
      const masks = Array.from({ length: site.passCount }, (_, p) => classes(site, p).cls.map((k) => (k === CLASS.FLOODED_VEG ? 1 : 0)));
      analyses.set(id, {
        enl,
        changes: enl ? changeStack(site, enl.m) : null,
        masks,
        follow: followPatches(masks, site.width, site.height, site.rowAreaKm2, {
          minPx,
          seen: (p, i) => site.passPlane("hh", p)[i] !== L.hh.nodata && site.passPlane("hv", p)[i] !== L.hv.nodata,
        }),
        pairs: new Map(),
        cores: new Map(),
      });
    }
    return analyses.get(id);
  }

  // How many passes each pixel belonged to a followed patch: its persistent core anchors the
  // patch's label for its whole life, so the leader does not wander while the timeline plays.
  function persistence(site, trackId) {
    const a = analysis(site);
    if (!a.cores.has(trackId)) {
      const count = new Uint8Array(site.width * site.height);
      a.follow.passes.forEach(({ labels, comps }) => {
        const k = comps.findIndex((c) => c.track === trackId) + 1;
        if (!k) return;
        for (let i = 0; i < labels.length; i += 1) if (labels[i] === k) count[i] += 1;
      });
      a.cores.set(trackId, count);
    }
    return a.cores.get(trackId);
  }

  // Anchor in the most persistent part of patch p: the largest connected group of its pixels that
  // were in the patch on the most passes, at that group's most solid point.
  function coreAnchor(site, p, count) {
    let top = 0;
    for (const i of p.pixels) top = Math.max(top, count[i]);
    const core = new Uint8Array(site.width * site.height);
    for (const i of p.pixels) if (count[i] === top) core[i] = 1;
    const q = largestPatch(core, site.width, site.height, site.rowAreaKm2);
    return interiorPoint(q, site.width, Math.max(4, Math.min(12, Math.round(Math.sqrt(q.size) / 10))));
  }

  // A followed patch in the shape patchNote's geometry expects.
  function asPatch(site, labels, k, c) {
    return { ...c, pixels: pixelsOf(labels, k, c.size) };
  }

  function geometry(site, p, kind, label) {
    const [r, c] = interiorPoint(p, site.width, Math.max(4, Math.min(12, Math.round(Math.sqrt(p.size) / 10))));
    const outline = p.size > 0.4 * site.width * site.height ? "" : outlinePath(patchBox(p, site.width));
    return { kind, p, r, c, outline, ...label(p) };
  }

  // Confirmed transitions on pass pi: pixels whose class went into (dir 1) or out of (dir −1) water
  // under the trees AND whose backscatter changed beyond speckle at this pass with HH moving the
  // same way (double bounce gained or lost). Returns the pixel mask.
  function confirmed(site, pi, dir) {
    const a = analysis(site);
    if (!a.changes || pi === 0) return null;
    const n = site.width * site.height;
    const now = a.masks[pi];
    const before = a.masks[pi - 1];
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) {
      const code = a.changes[pi * n + i];
      if (!code) continue;
      if (dir > 0 ? now[i] && !before[i] && hhUp(code) : before[i] && !now[i] && !hhUp(code)) out[i] = 1;
    }
    return out;
  }

  // Note on the confirmed pixels, grouped in blocks; the area counts confirmed pixels only.
  function confirmedNote(site, pi, dir, kind, key) {
    const px = confirmed(site, pi, dir);
    if (!px) return null;
    const blocks = blockShare(px, site.width, site.height, CONFIRM_BLOCK, 0.25);
    const n = patchNote(site, blocks, kind, () => ({}));
    if (!n) return null;
    let km2 = 0;
    for (const i of n.p.pixels) if (px[i]) km2 += site.rowAreaKm2[(i / site.width) | 0];
    // A tenth of a km² (~28 pixels) at least: smaller confirmed areas are left to the caption.
    if (km2 < 0.1) return null;
    n.title = t(key, { prev: date(site, pi - 1) });
    n.detail = t("annotate.confirmed_detail", { km2: fmtKm2(km2), alpha: fmtNumber(ALPHA, 2) });
    n.key = kind;
    return n;
  }

  const has = (site, name) => site.summary.grid_stack.static_layers.some((l) => l.name === name);
  const date = (site, p) => fmtDate(site.summary.passes[p].date, "short");

  // A note marks one patch (outline + anchor) or one point (anchor only).
  function patchNote(site, mask, kind, label) {
    const p = largestPatch(mask, site.width, site.height, site.rowAreaKm2);
    if (!p || p.area < MIN_KM2) return null;
    // Neighbourhood for the anchor grows with the patch: 9 × 9 for small ones, up to 25 × 25.
    const [r, c] = interiorPoint(p, site.width, Math.max(4, Math.min(12, Math.round(Math.sqrt(p.size) / 10))));
    // A patch over most of the site would only be outlined by the site's own edge.
    const outline = p.size > 0.4 * site.width * site.height ? "" : outlinePath(patchBox(p, site.width));
    return { kind, p, r, c, outline, ...label(p) };
  }

  function share(p, pred) {
    let n = 0;
    for (const i of p.pixels) if (pred(i)) n += 1;
    return (100 * n) / p.size;
  }

  // One builder per view; each returns notes computed from what that view draws.
  const BUILD = {
    flood(site, pi) {
      // The largest patch, followed through the passes: its label narrates its history.
      const a = analysis(site);
      const pass = a.follow.passes[pi];
      let k = 0;
      pass.comps.forEach((c, j) => {
        if (!k || c.area > pass.comps[k - 1].area) k = j + 1;
      });
      const out = [];
      if (k && pass.comps[k - 1].area >= MIN_KM2) {
        const c = pass.comps[k - 1];
        const tr = a.follow.tracks[c.track - 1];
        const p = asPatch(site, pass.labels, k, c);
        const n = geometry(site, p, "flood", () => ({ title: t("annotate.flood") }));
        [n.r, n.c] = coreAnchor(site, p, persistence(site, c.track));
        n.key = `flood:${c.track}`;
        n.detail = t(pi === 0 ? "annotate.flood_line_first" : tr.first < pi ? "annotate.flood_line_since" : "annotate.flood_line_new", {
          km2: fmtKm2(c.area),
          date: date(site, pi),
          first: date(site, tr.first),
        });
        // History since the previous pass; parents that gave at least a tenth of the patch count.
        const clauses = [];
        if (c.prevArea !== null) clauses.push(t("annotate.clause_delta", { delta: fmtDelta(c.area - c.prevArea), prev: date(site, pi - 1) }));
        const major = c.parents.filter((q) => q.shared >= 0.1 * c.size).length;
        if (c.event === "merged" && major > 1) clauses.push(t("annotate.clause_joined", { n: major }));
        if (c.event === "split") clauses.push(t("annotate.clause_split"));
        if (site.summary.passes[pi].hidden_from_cband_km2 !== null) {
          const cb = site.passPlane("cband", pi);
          clauses.push(t("annotate.clause_cband", { pct: fmtNumber(share(p, (i) => cb[i] !== 2), 0) }));
        }
        n.more = clauses.join(" · ");
        out.push(n);
      }
      out.push(confirmedNote(site, pi, 1, "arrived", "annotate.arrived"));
      out.push(confirmedNote(site, pi, -1, "drained", "annotate.drained"));
      return out;
    },
    hydroperiod(site) {
      const hp = site.summary.products.hydroperiod;
      const d = site.staticPlane("hydroperiod_days");
      const days = quantile(d.filter((v) => v > 0), HYDRO_TOP);
      if (!(days > 0)) return [];
      const mask = d.map((v) => (v >= days ? 1 : 0));
      return [
        patchNote(site, mask, "hydro", (p) => ({
          title: t("annotate.hydro"),
          detail: t(days >= hp.season_days ? "annotate.hydro_detail_all" : "annotate.hydro_detail", { km2: fmtNumber(p.area), days, season: hp.season_days }),
        })),
      ];
    },
    level(site, pi) {
      const lv = levelFor(site.summary, pi);
      if (!lv || !site.layers.level_cm) return [];
      const L = site.layers.level_cm;
      const q = site.passPlane("level_cm", pi);
      const ok = (i) => q[i] !== L.nodata;
      const dh = (i) => q[i] * L.scale + L.offset;
      // Moved together: 4 × 4 blocks (240 m) whose median change is at least a third of the colour
      // scale and two quantisation steps, all one way.
      const step = Math.max(2 * L.scale, lv.scale_cm / 3);
      const B = 4;
      const best = [1, -1]
        .map((sign) => {
          const n = patchNote(site, blockMask(ok, dh, site.width, site.height, B, (m) => sign * m >= step), "level", () => ({}));
          if (!n) return null;
          // Count and describe only the pixels measured inside the blocks, not the blocks.
          const px = Array.from(n.p.pixels).filter(ok);
          let km2 = 0;
          for (const i of px) km2 += site.rowAreaKm2[(i / site.width) | 0];
          return { n, km2, med: quantile(px.map(dh), 0.5) };
        })
        .filter((x) => x && x.km2 >= MIN_KM2 / 4)
        .sort((a, b) => b.km2 - a.km2)[0];
      if (!best) return [];
      const { n, km2, med } = best;
      // Same rule as the legend: only a gauge fixes the sign of InSAR level change.
      const signed = lv.sign_status === "gauge";
      const args = { km2: fmtNumber(km2, 2), cm: fmtNumber(Math.abs(med), 0), from: fmtDate(lv.from, "short"), to: fmtDate(lv.to, "short") };
      n.title = t(signed ? (med > 0 ? "annotate.level_rise" : "annotate.level_fall") : "annotate.level_moved");
      n.detail = t(signed ? "annotate.level_detail" : "annotate.level_detail_unsigned", args);
      return [n];
    },
    canopy(site, pi) {
      if (!site.summary.products.canopy || !has(site, "canopy_height_m")) return [];
      const hgt = site.staticPlane("canopy_height_m");
      const veg = site.staticPlane("veg");
      const vals = [];
      for (let i = 0; i < hgt.length; i += 1) if (hgt[i] !== 255 && veg[i] === VEG.YES) vals.push(hgt[i]);
      if (!vals.length) return [];
      vals.sort((a, b) => a - b);
      // Tallest tenth of the forest, at least one metre above the median so flat canopies get no note.
      const tall = vals[Math.floor(0.9 * (vals.length - 1))];
      if (tall < vals[vals.length >> 1] + 1) return [];
      const { cls } = classes(site, pi);
      const mask = hgt.map((v, i) => (v !== 255 && v >= tall && veg[i] === VEG.YES ? 1 : 0));
      return [
        patchNote(site, mask, "canopy", (p) => ({
          title: t("annotate.canopy", { m: fmtNumber(tall, 0) }),
          detail: t("annotate.canopy_detail", {
            km2: fmtNumber(p.area),
            pct: fmtNumber(share(p, (i) => cls[i] === CLASS.FLOODED_VEG), 0),
            date: date(site, pi),
          }),
        })),
      ];
    },
    radar(site, pi) {
      // One example of each signature the legend names, at the heart of its largest patch of typical
      // pixels: confident, and HH and HV both inside the central 80 % of the class on this pass.
      // "Dry" is every pixel that is not water, so a dark river can be dry by class; typical keeps
      // the example on what the colour means.
      const { cls, conf } = classes(site, pi);
      const veg = site.staticPlane("veg");
      const hh = site.passPlane("hh", pi);
      const hv = site.passPlane("hv", pi);
      const of = (want) => {
        const inClass = (i) => conf[i] === 1 && want(cls[i], i);
        const a = [];
        const b = [];
        for (let i = 0; i < cls.length; i += 1) if (inClass(i)) a.push(hh[i]), b.push(hv[i]);
        if (!a.length) return new Uint8Array(cls.length);
        const [a0, a1, b0, b1] = [quantile(a, 0.1), quantile(a, 0.9), quantile(b, 0.1), quantile(b, 0.9)];
        return cls.map((_, i) => (inClass(i) && hh[i] >= a0 && hh[i] <= a1 && hv[i] >= b0 && hv[i] <= b1 ? 1 : 0));
      };
      const point = (mask, key) => {
        const n = patchNote(site, mask, "point", () => ({ title: t(key), detail: "" }));
        if (n) n.outline = "";
        return n;
      };
      return [
        point(of((k) => k === CLASS.FLOODED_VEG), "annotate.radar_flooded"),
        point(of((k, i) => k === CLASS.DRY && veg[i] === VEG.YES), "annotate.radar_dry"),
        point(of((k) => k === CLASS.OPEN_WATER), "annotate.radar_water"),
      ];
    },
    change(site, pi) {
      // Two-pass omnibus test against the reference: a change beyond speckle in HH and HV together,
      // at the site's own estimated looks, in place of a fixed dB step.
      const ref = changeReference(site.summary);
      const a = analysis(site);
      if (ref === pi || !a.enl) return [];
      if (!a.pairs.has(pi)) a.pairs.set(pi, pairChange(site, ref, pi, a.enl.m));
      const codes = a.pairs.get(pi);
      const refDate = date(site, ref);
      const note = (up, key) =>
        patchNote(site, codes.map((d) => (d && hhUp(d) === up ? 1 : 0)), up ? "brighter" : "darker", (p) => ({
          title: t(key, { ref: refDate }),
          detail: t("annotate.change_detail", { km2: fmtKm2(p.area), looks: fmtNumber(a.enl.m, 0), alpha: fmtNumber(ALPHA, 2) }),
        }));
      return [note(true, "annotate.change_brighter"), note(false, "annotate.change_darker")];
    },
    terrain(site, pi) {
      const hd = site.summary.products.hand;
      if (!hd || !has(site, "hand_m")) return [];
      const L = site.summary.grid_stack.static_layers.find((l) => l.name === "hand_m");
      const q = site.staticPlane("hand_m");
      const m = (i) => q[i] * L.scale + L.offset;
      const { cls } = classes(site, pi);
      let wet = 0;
      let low = 0;
      for (let i = 0; i < q.length; i += 1) {
        if (cls[i] !== CLASS.FLOODED_VEG || q[i] === L.nodata) continue;
        wet += 1;
        if (m(i) <= hd.low_m) low += 1;
      }
      const mask = q.map((v, i) => (v !== L.nodata && m(i) > hd.low_m ? 1 : 0));
      return [
        patchNote(site, mask, "terrain", (p) => ({
          title: t("annotate.terrain", { m: fmtNumber(hd.low_m, 0) }),
          detail: wet
            ? t("annotate.terrain_detail", { km2: fmtNumber(p.area), pct: fmtNumber((100 * low) / wet, 0), m: fmtNumber(hd.low_m, 0), date: date(site, pi) })
            : t("annotate.terrain_detail_dry", { km2: fmtNumber(p.area) }),
        })),
      ];
    },
    burn(site) {
      if (!site.summary.products.burn || !has(site, "burn_pass")) return [];
      const bp = site.staticPlane("burn_pass");
      return [
        patchNote(site, bp.map((v) => (v > 0 ? 1 : 0)), "burn", (p) => {
          let first = 255;
          for (const i of p.pixels) first = Math.min(first, bp[i]);
          return {
            title: t("annotate.burn"),
            detail: t("annotate.burn_detail", { km2: fmtNumber(p.area, 0), date: date(site, first - 1) }),
          };
        }),
      ];
    },
  };

  // On a fire site burned forest reads as water under trees (docs/10 D-076): only notes that do
  // not count flood are drawn there.
  const FIRE_VIEWS = ["burn", "change"];

  function compute(site, passIndex, view) {
    const build = BUILD[view];
    if (!build || (site.summary.products.burn && !FIRE_VIEWS.includes(view))) return [];
    // Days flooded and burned area do not change with the pass.
    const perPass = !["hydroperiod", "burn"].includes(view);
    const key = `${site.summary.site.id}:${view}:${perPass ? passIndex : ""}`;
    if (!cache.has(key)) {
      const out = build(site, passIndex).filter(Boolean).slice(0, 3);
      for (const n of out) [n.lon, n.lat] = site.gridToLonLat(n.r, n.c);
      cache.set(key, out);
    }
    return cache.get(key);
  }

  // Caption lines for pass pi: the area and its change, how much of the change the radar confirms
  // beyond speckle, and the trend over the last passes. Water sites, per-pass views only.
  const CAPTION_VIEWS = ["flood", "radar", "change", "canopy", "terrain", "level"];
  function captionLines(site, pi, view) {
    if (site.summary.products.burn || !CAPTION_VIEWS.includes(view)) return null;
    const ps = site.summary.passes;
    const lines = [];
    const km2 = ps[pi].flooded_veg_km2;
    lines.push(
      pi === 0
        ? t("annotate.cap_area", { date: date(site, pi), km2: fmtNumber(km2) })
        : t("annotate.cap_area_delta", { date: date(site, pi), km2: fmtNumber(km2), delta: fmtDelta(km2 - ps[pi - 1].flooded_veg_km2), prev: date(site, pi - 1) }),
    );
    const a = analysis(site);
    if (pi > 0 && a.changes) {
      const n = site.width * site.height;
      let into = 0;
      let intoC = 0;
      let out = 0;
      let outC = 0;
      for (let i = 0; i < n; i += 1) {
        const now = a.masks[pi][i];
        const before = a.masks[pi - 1][i];
        if (now === before) continue;
        const code = a.changes[pi * n + i];
        if (now) {
          into += 1;
          if (code && hhUp(code)) intoC += 1;
        } else {
          out += 1;
          if (code && !hhUp(code)) outC += 1;
        }
      }
      if (into + out > 0) {
        lines.push(t("annotate.cap_confirm", {
          prev: date(site, pi - 1),
          inPct: fmtNumber(into ? (100 * intoC) / into : 0, 0),
          outPct: fmtNumber(out ? (100 * outC) / out : 0, 0),
          looks: fmtNumber(a.enl.m, 0),
          alpha: fmtNumber(ALPHA, 2),
        }));
      }
    }
    const tr = areaTrend(ps, pi);
    if (tr.p === undefined) {
      lines.push(t("annotate.cap_trend_short", { min: TREND_MIN, k: pi + 1 }));
    } else {
      const test = t(tr.exact ? "annotate.mk_exact" : "annotate.mk_approx");
      const args = { n: tr.n, p: fmtP(tr.p), test, rate: fmtNumber(Math.abs(tr.perDay), 2) };
      lines.push(t(tr.p >= 0.05 ? "annotate.cap_trend_none" : tr.perDay < 0 ? "annotate.cap_trend_fall" : "annotate.cap_trend_rise", args));
    }
    return lines;
  }

  function renderCaption(st) {
    const lines = st.site && st.mode === "site" && !st.scientist?.enabled && st.mapNotes !== false && !document.body.classList.contains("is-story")
      ? captionLines(st.site, st.passIndex, st.view)
      : null;
    caption.hidden = !lines;
    if (!lines) return;
    caption.replaceChildren(...lines.map((l, k) => h("p", { class: k ? "annotate-cap-line" : "annotate-cap-lead", text: l })));
  }

  // Map controls and other on-map chrome, in map pixels: labels must never sit on them.
  function chrome() {
    const box = map.panes.top.getBoundingClientRect();
    const els = document.querySelectorAll(".map-stage [data-map-control], .map-stage .map-attribution, .map-stage .scale-bar, .map-stage .basemap-ctl");
    const out = [];
    for (const el of els) {
      if (el.hidden || el.closest("[hidden]") || el.offsetParent === null) continue;
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out.push({ x: r.left - box.left - 6, y: r.top - box.top - 6, w: r.width + 12, h: r.height + 12 });
    }
    return out;
  }

  map.onRender((m) => {
    const [w, h] = m.size();
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.replaceChildren();
    svg.removeAttribute("aria-label");
    svg.setAttribute("aria-hidden", "true");
    const st = store.get();
    if (!notes.length || st.mode !== "site" || st.scientist?.enabled || st.mapNotes === false) return;
    const site = st.site;
    const sb = site.summary.grid.bounds;
    const [sx0, sy0] = m.project(sb[0], sb[3]);
    const [sx1, sy1] = m.project(sb[2], sb[1]);
    // Zoomed out to a dot there is nothing to point into.
    if (sx1 - sx0 < 160) return;
    const siteRect = { x: sx0, y: sy0, w: sx1 - sx0, h: sy1 - sy0 };
    const kx = (sx1 - sx0) / site.width;
    const ky = (sy1 - sy0) / site.height;

    // Outlines first, under every leader and label; grid units scaled onto the overlay.
    const shapes = s("g", { transform: `matrix(${kx} 0 0 ${ky} ${sx0} ${sy0})` });
    for (const n of notes) {
      if (!n.outline) continue;
      shapes.append(
        s("path", { d: n.outline, class: "annotate-casing", "vector-effect": "non-scaling-stroke" }),
        // Where water left, the outline is dashed: it marks an absence.
        s("path", { d: n.outline, class: n.kind === "drained" ? "annotate-outline annotate-outline-gone" : "annotate-outline", "vector-effect": "non-scaling-stroke" }),
      );
    }
    svg.append(shapes);

    const obstacles = chrome();
    const anchors = notes.map((n) => [sx0 + (n.c + 0.5) * kx, sy0 + (n.r + 0.5) * ky]);
    // A leader to a point hidden under a card or button would point at nothing the reader can see.
    const covered = anchors.map(([x, y]) => obstacles.some((o) => x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h));
    // Every anchor dot is kept clear, not only the note's own.
    for (const [x, y] of anchors) obstacles.push({ x: x - 9, y: y - 9, w: 18, h: 18 });
    const layer = s("g");
    svg.append(layer);
    const drawn = new Set();
    const leaders = [];
    const plates = [];
    notes.forEach((n, k) => {
      const [x, y] = anchors[k];
      if (x < 0 || y < 0 || x > w || y > h || covered[k]) return; // off screen or under a control
      const key = n.key ?? n.kind;
      drawn.add(key);
      // A note that was not on the previous frame fades in, so a new event catches the eye.
      const g = s("g", { class: shown.has(key) ? "annotate-note" : "annotate-note is-new", dataset: { note: n.kind } });
      const plate = s("rect", { rx: 4, class: "annotate-box" });
      const title = s("text", { class: "annotate-text" }, n.title);
      const lines = [n.detail, n.more].filter(Boolean).map((v) => s("text", { class: "annotate-detail" }, v));
      const detail = lines[0] ?? null;
      g.append(plate, title, ...lines);
      layer.append(g);
      // Size the plate to the rendered text (fonts and languages differ in width).
      const width = (el, est) => {
        try {
          return el.getComputedTextLength() || est;
        } catch {
          return est; // detached or not rendered yet: keep the estimate
        }
      };
      const tw = Math.max(width(title, n.title.length * 7.4), ...lines.map((el) => width(el, el.textContent.length * 6.6)));
      const pw = Math.min(tw + 18, w - 16);
      const ph = 24 + 16 * lines.length;
      // Last position of this note's label, kept relative to the site's corner at the same zoom
      // (any text width): offered first to the placer, which keeps it unless clearly worse.
      const prev = placed.get(key);
      const same = prev && Math.abs(prev.zoom - siteRect.w) < 0.5;
      const r = placeLabel({ anchor: [x, y], w: pw, h: ph, view: { w, h }, site: siteRect, obstacles, leaders, plates, prefer: same ? [sx0 + prev.dx - x, sy0 + prev.dy - y] : null });
      placed.set(key, { dx: r.x - sx0, dy: r.y - sy0, zoom: siteRect.w });
      obstacles.push({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 });
      plate.setAttribute("x", r.x);
      plate.setAttribute("y", r.y);
      plate.setAttribute("width", r.w);
      plate.setAttribute("height", r.h);
      title.setAttribute("x", r.x + 9);
      title.setAttribute("y", r.y + 16);
      lines.forEach((el, j) => {
        el.setAttribute("x", r.x + 9);
        el.setAttribute("y", r.y + 32 + 16 * j);
      });
      const [lx, ly] = nearestOnRect(r, x, y);
      leaders.push([x, y, lx, ly]);
      plates.push(r);
      // Leader and dot drawn with a dark casing so they read over amber, blue, radar colour or basemap.
      g.prepend(
        s("path", { d: `M${x},${y}L${lx},${ly}`, class: "annotate-leader-casing" }),
        s("path", { d: `M${x},${y}L${lx},${ly}`, class: "annotate-leader" }),
      );
      g.append(s("circle", { cx: x, cy: y, r: 3.5, class: "annotate-dot" }));
    });
    shown = drawn;
    // Only the notes actually drawn: one hidden under a control is not on the map either.
    const said = notes.filter((n) => drawn.has(n.key ?? n.kind));
    if (!said.length) return;
    svg.removeAttribute("aria-hidden");
    svg.setAttribute("aria-label", t("annotate.aria", { list: said.map((n) => [n.title, n.detail, n.more].filter(Boolean).join(", ")).join("; ") }));
  });

  // The analysis takes a few hundred milliseconds per site: it runs once, after the map has drawn.
  let pending = 0;
  watch(store, ["site", "passIndex", "view", "mode", "scientist", "mapNotes"], (st) => {
    clearTimeout(pending);
    if (!st.site) {
      notes = [];
      renderCaption(st);
      map.refresh();
      return;
    }
    const run = () => {
      const now = store.get();
      if (now.site !== st.site) return;
      notes = compute(now.site, now.passIndex, now.view);
      renderCaption(now);
      map.refresh();
    };
    if (analyses.has(st.site.summary.site.id)) run();
    else {
      notes = [];
      caption.hidden = true;
      map.refresh();
      pending = setTimeout(run, 30);
    }
  });
}
