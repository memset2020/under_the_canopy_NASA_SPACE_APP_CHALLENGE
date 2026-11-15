// Opening film (film.html, docs/10 D-084, second cut D-113). A composition drawn from the
// published data as a pure function of time: seek(t) sets every element from t alone, so
// tools/film/render.mjs can step it frame by frame into a video and any frame renders the same in
// any order. Every word is an i18n key (CLAUDE.md rule 7); every result is read from web/data,
// never typed in, and a synthetic summary stops the film (rule 3). The opening's outside facts
// (the 2022 Sylhet flood) are sourced on screen and listed in docs/film/RESEARCH.md §3.
// Script, feature map and edit workflow: docs/film/.
import { LANGUAGES, fmtApprox, fmtDate, fmtNumber, fmtYear, language, loadLocale, t } from "./i18n.js";
import { autoRange, cssColour, hillshade, layerData, paint, planeIndex, planeValues, readBinary, toCanvas } from "./motionmaps.js";
import { decodePlanes, fillSurface, paintPlane, speedRange } from "./glaciermaps.js";
import { drawCard } from "./floodcard.js";
import { SOURCES } from "./sources-registry.js";

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const PORTRAIT = params.get("aspect") === "portrait";
const SHORT = params.get("cut") === "short";
const RENDER = params.has("render");
const W = PORTRAIT ? 1080 : 1920;
const H = PORTRAIT ? 1920 : 1080;
const FPS = 30;
const DEG = Math.PI / 180;
const SVGNS = "http://www.w3.org/2000/svg";

// [scene, seconds in the full film, seconds in the 30-second Space Apps cut (0 = left out)].
// Holds follow subtitle reading speed (about 0.3 s a word plus a second; Netflix and BBC).
// The arc (docs/film/SCRIPT.md): what is (a 2022 flood the maps could not see under the trees),
// but (NISAR), therefore (the reveal, its people, its season), then the other changes, the
// checks and limits, who uses it, everything in it, and where it can go.
// The 30-second cut (v3, D-116) is a feature sweep: every change the app maps (water, its people,
// its season, the village card, places worldwide, fire, ground, ice), the checks, all six
// audiences and the index wall, at the 1.4 s floor where a scene carries one number or picture.
export const SCENES = [
  ["cold", 7.0, 1.8],
  ["toll", 6.0, 0],
  ["blind", 7.5, 1.8],
  ["hook", 6.0, 1.5],
  ["zoom", 2.6, 1.4],
  ["camera", 3.6, 1.4],
  ["cband", 3.6, 1.4],
  ["nisar", 6.0, 2.2],
  ["physics", 6.5, 0],
  ["people", 5.0, 1.4],
  ["season", 5.5, 1.4],
  ["card", 5.5, 1.4],
  ["places", 7.0, 1.6],
  ["fire", 6.0, 1.5],
  ["ground", 6.5, 1.6],
  ["ice", 6.5, 1.5],
  ["proof", 6.0, 1.4],
  ["limits", 5.5, 0],
  ["audience", 27.6, 2.8],
  ["index", 6.0, 1.6],
  ["next", 7.5, 0],
  ["title", 6.0, 2.0],
];
// The audience scene steps through the landing page's six audiences (landing.aud_*).
export const AUDIENCES = ["resp", "local", "sci", "climate", "edu", "plan"];
// The index wall: every feature not shown in a scene of its own, by group (film.ix_*). Keep in step
// with docs/film/FEATURE_MAP.md §3 when a feature is added.
export const INDEX = [
  ["water", ["level", "drivers", "canopy", "basin", "outlook", "season", "ridges", "flows", "methane", "waltz", "sonify"]],
  ["world", ["globe", "here", "belt", "placebuild", "live", "orbits", "overpass", "events"]],
  ["groundice", ["rupture", "profile", "motionchecks", "glaciers", "smoke"]],
  ["tools", ["explain", "annotate", "measure", "space", "scientist", "labels", "download"]],
  ["learn", ["story", "guide", "notebooks", "game", "lessons"]],
  ["share", ["links", "languages", "sources", "offline", "licence"]],
];
// Where it can go next, each with an honest status (docs/film/FEATURE_MAP.md §4).
export const NEXT = [
  ["belt", "started"],
  ["faster", "idea"],
  ["methane", "started"],
  ["outlook", "exp"],
  ["farms", "notyet"],
  ["class", "ready"],
];

export function timeline(short = false) {
  const marks = {};
  let at = 0;
  for (const [id, full, cut] of SCENES) {
    const d = short ? cut : full;
    marks[id] = { a: at, b: at + d, d };
    at += d;
  }
  return { marks, duration: at };
}

// ---------------------------------------------------------------- easing and timing

const clamp = (x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const lerp = (a, b, f) => a + (b - a) * f;
const seg = (x, a, b) => (b <= a ? (x >= b ? 1 : 0) : clamp((x - a) / (b - a)));
const easeOut = (f) => 1 - (1 - f) ** 3;
const easeInOut = (f) => (f < 0.5 ? 4 * f ** 3 : 1 - (-2 * f + 2) ** 3 / 2);
const expoOut = (f) => (f >= 1 ? 1 : 1 - 2 ** (-10 * f));
// Neighbouring scenes overlap by this much, so one dissolves into the next instead of both
// fading through an empty frame.
const XF = 0.3;
// Opacity of something on screen from a to b: in over `fin` seconds, out over `fout`.
const shown = (x, a, b, fin = 0.45, fout = 0.35) =>
  x < a || x > b ? 0 : Math.min(seg(x, a, a + fin), 1 - seg(x, b - fout, b));

// ---------------------------------------------------------------- DOM

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  if (parent) parent.append(e);
  return e;
}

function sv(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.append(e);
  return e;
}

// A line whose words rise in one after another.
function words(parent, cls, text) {
  const p = el("p", cls, parent);
  for (const w of text.split(/(\s+)/)) {
    if (!w) continue;
    if (/^\s+$/.test(w)) p.append(w);
    else el("span", "word", p, w);
  }
  return p;
}

function showWords(p, since, alpha = 1) {
  p.querySelectorAll(".word").forEach((w, i) => {
    const f = easeOut(seg(since, i * 0.045, i * 0.045 + 0.5));
    w.style.opacity = String(f * alpha);
    w.style.transform = `translateY(${((1 - f) * 28).toFixed(2)}px)`;
  });
}

function setOpacity(e, a) {
  e.style.opacity = a.toFixed(3);
  e.style.visibility = a <= 0.001 ? "hidden" : "visible";
}

function swatch(parent, colour, text) {
  const s = el("span", "", parent);
  el("i", "swatch", s).style.background = colour;
  s.append(text);
  return s;
}

// ---------------------------------------------------------------- data

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function getImage(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// The world under the opening: land shaded by forest cover, where NISAR first imaged each cell
// this season, and the screening map of forests that flood (the app's World mode, D-031).
function globeTexture(meta, bytes) {
  const { width: GW, height: GH } = meta.grid;
  const ids = meta.layers.map((l) => l.id);
  const plane = (id) => {
    const k = ids.indexOf(id);
    return bytes.subarray(k * GW * GH, (k + 1) * GW * GH);
  };
  const people = plane("people");
  const wet = plane("glwd_forested_pct");
  const first = plane("nisar_first_day");
  const forest = plane("forest_pct");
  const likely = plane("likely");
  const n = GW * GH;
  const rgb = new Float32Array(n * 3);
  const land = new Uint8Array(n);
  const LAND = [44, 60, 66];
  const FOREST = [76, 134, 100];
  for (let i = 0; i < n; i++) {
    // The grid has no land mask of its own: a cell is land if any land layer holds a value.
    if (people[i] === 255 && wet[i] === 255 && first[i] === 255 && forest[i] === 0) continue;
    land[i] = 1;
    const f = Math.min(1, forest[i] / 100);
    for (let c = 0; c < 3; c++) rgb[i * 3 + c] = LAND[c] + (FOREST[c] - LAND[c]) * f;
  }
  return { GW, GH, rgb, land, first, likely };
}

// burn.png colours the pass that first burned each pixel dark red (first) to light red (last),
// on BURN_RAMP (pipeline/canopy/burn.py colour_progression): read the pass back by colour.
const BURN_RAMP = [[92, 14, 32], [168, 32, 46], [222, 84, 72], [247, 160, 140]];
function rampAt(stops, f) {
  const x = clamp(f) * (stops.length - 1);
  const k = Math.min(stops.length - 2, Math.floor(x));
  const u = x - k;
  return stops[k].map((c, j) => c * (1 - u) + stops[k + 1][j] * u);
}

function burnStates(img, burn) {
  const hits = burn.by_pass.flatMap((p, i) => (p.new_km2 > 0 ? [i] : []));
  const lo = hits[0];
  const hi = hits.at(-1);
  const colours = [];
  for (let p = lo; p <= hi; p++) colours.push([p, rampAt(BURN_RAMP, (p - lo) / Math.max(hi - lo, 1))]);
  const { width: w, height: h } = img;
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(img, 0, 0);
  const px = sctx.getImageData(0, 0, w, h).data;
  const pass = new Int8Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (px[o + 3] < 8) continue;
    let best = -1;
    let bestD = Infinity;
    for (const [p, c] of colours) {
      const d = (px[o] - c[0]) ** 2 + (px[o + 1] - c[1]) ** 2 + (px[o + 2] - c[2]) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    pass[i] = best;
  }
  // One canvas per pass: everything burned by then, the newest pixels brightest.
  return burn.by_pass.map((_, k) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    const out = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      if (pass[i] < 0 || pass[i] > k) continue;
      const o = i * 4;
      const fresh = pass[i] === k;
      const col = fresh ? [255, 128, 112] : rampAt(BURN_RAMP, 0.15 + 0.6 * ((pass[i] - lo) / Math.max(hi - lo, 1)));
      out.data[o] = col[0];
      out.data[o + 1] = col[1];
      out.data[o + 2] = col[2];
      out.data[o + 3] = fresh ? 255 : 235;
    }
    ctx.putImageData(out, 0, 0);
    c.className = "px";
    return c;
  });
}

// A motion map painted exactly as the app paints it (motionmaps.js), over the same relief.
async function motionMap(dir, layerId) {
  const doc = await getJson(`${dir}/motion.json`);
  const view = new Int16Array(await readBinary(`${dir}/${doc.binary}`));
  const { width, height, res_m: res } = doc.grid;
  const dem = planeValues(doc, view, planeIndex(doc, "dem"));
  const shade = hillshade(dem, width, height, res);
  const sea = Uint8Array.from(dem, (z) => (Number.isFinite(z) && z <= 0 ? 1 : 0));
  const layer = layerData(doc, view, layerId);
  const [lo, hi] = autoRange(layer);
  const canvas = toCanvas(paint(layer, width, height, { lo, hi, fringe_cm: null, shade, sea }), width, height);
  return { doc, canvas, lo, hi };
}

// The glacier the landing page shows (Greenland's fastest), painted as the app paints it.
const HERO_GLACIER = "jakobshavn";
async function glacierMap(index) {
  const g = index.glaciers.find((x) => x.id === HERO_GLACIER) ?? index.glaciers[0];
  const doc = await getJson(`data/glaciers/${g.path}`);
  const planes = decodePlanes(doc, await readBinary(`data/glaciers/${g.path.replace("glacier.json", "glacier.bin.gz")}`));
  const { width: w, height: h, cell_m: cell } = doc.grid;
  const relief = planes.dem ? hillshade(planes.dem, w, h, cell) : null;
  const rgba = fillSurface(paintPlane(planes.speed, "speed", speedRange(doc.stats)), w, h, planes.surface ?? null, w, h, undefined, relief);
  return { g, canvas: toCanvas(rgba, w, h), aspect: w / h, years: doc.source.static_years };
}

// The village card for Sylhet's first pass, drawn by the app's own code in the film's language.
// Its "next passes" count from the last published pass, not from the day of rendering, so the
// film renders the same on any day.
async function villageCard(sylhet) {
  const canvas = document.createElement("canvas");
  const site = { summary: sylhet, url: (rel) => `data/sylhet/${rel}` };
  await drawCard(canvas, site, 0, t, sylhet.passes.at(-1).date);
  return canvas;
}

async function loadData() {
  const [sylhet, fire, globeMeta, manifest, limpopo, glaciers, motionIndex, belt, notebooks, world] = await Promise.all([
    getJson("data/sylhet/summary.json"),
    getJson("data/thunder_bay_36/summary.json"),
    getJson("data/global/global.json"),
    getJson("data/manifest.json"),
    getJson("data/limpopo_2026/summary.json"),
    getJson("data/glaciers/index.json"),
    getJson("data/motion/index.json"),
    getJson("data/belt/index.json"),
    getJson("data/notebooks.json"),
    getJson("media/world.json"),
  ]);
  if (sylhet.synthetic || fire.synthetic || limpopo.synthetic) throw new Error("the film quotes real NISAR results only");
  const pass = sylhet.passes.find((p) => p.id === "p01");
  // Limpopo: the last pass before the flood and the flood's widest pass (D-107).
  const lpBefore = limpopo.passes.filter((p) => p.date < "2026-01-01").at(-1);
  const lpPeak = limpopo.passes.reduce((a, b) => (b.open_water_km2 > a.open_water_km2 ? b : a));
  const [optical, cband, nisar, burnImg, globeBytes, quake, sink, hydro, lpA, lpB, worldImg, ice, card, ...shots] = await Promise.all([
    getImage(`data/sylhet/${sylhet.products.optical.png}`),
    getImage(`data/sylhet/${pass.cband_png}`),
    getImage(`data/sylhet/${pass.class_png}`),
    getImage(`data/thunder_bay_36/${fire.products.burn.png}`),
    getBytes(`data/global/${globeMeta.binary}`),
    motionMap("data/motion/venezuela_2026", "east"),
    motionMap("data/motion/mexico_city", "rate_up"),
    getImage(`data/sylhet/${sylhet.products.hydroperiod.png}`),
    getImage(`data/limpopo_2026/${lpBefore.class_png}`),
    getImage(`data/limpopo_2026/${lpPeak.class_png}`),
    getImage("media/world.png"),
    glacierMap(glaciers),
    villageCard(sylhet),
    ...AUDIENCES.map((a) => getImage(`media/film/aud-${a}.jpg`)),
  ]);
  return {
    sylhet,
    pass,
    fire,
    manifest,
    limpopo: { summary: limpopo, before: lpBefore, peak: lpPeak, images: [lpA, lpB] },
    glaciers,
    motionIndex,
    beltCells: belt.cells.length,
    notebookCount: Object.keys(notebooks.notebooks ?? {}).length,
    world: { meta: world, img: worldImg },
    images: { optical, cband, nisar, hydro },
    burn: burnStates(burnImg, fire.products.burn),
    globe: globeTexture(globeMeta, globeBytes),
    quake,
    sink,
    ice,
    card,
    shots,
  };
}

// ---------------------------------------------------------------- the globe

const SEA = [13, 31, 42];
const SCAN = [170, 232, 255];
const AMBER = [230, 159, 0];
const LIGHT = (() => {
  const v = [-0.45, 0.5, 0.74];
  const m = Math.hypot(...v);
  return v.map((x) => x / m);
})();
const SYLHET = [91.92, 24.99];

// Orthographic globe, drawn per pixel so every cell is a real 0.25° cell of the grid.
function drawGlobe(g, v) {
  const { ctx, img, tex } = g;
  ctx.clearRect(0, 0, W, H);
  const data = img.data;
  const x0 = Math.max(0, Math.floor(v.cx - v.R));
  const x1 = Math.min(W, Math.ceil(v.cx + v.R));
  const y0 = Math.max(0, Math.floor(v.cy - v.R));
  const y1 = Math.min(H, Math.ceil(v.cy + v.R));
  if (x1 <= x0 || y1 <= y0) return;
  const sinL = Math.sin(v.lat0 * DEG);
  const cosL = Math.cos(v.lat0 * DEG);
  const { GW, GH, rgb, land, first, likely } = tex;
  const inv = 1 / v.R;
  for (let y = y0; y < y1; y++) {
    const q = (v.cy - y - 0.5) * inv;
    for (let x = x0; x < x1; x++) {
      const o = (y * W + x) * 4;
      const u = (x + 0.5 - v.cx) * inv;
      const rr = u * u + q * q;
      if (rr > 1) {
        data[o + 3] = 0;
        continue;
      }
      const z = Math.sqrt(1 - rr);
      const lat = Math.asin(clamp(z * sinL + q * cosL, -1, 1)) / DEG;
      const lon = v.lon0 + Math.atan2(u, z * cosL - q * sinL) / DEG;
      let col = Math.floor(((((lon + 180) % 360) + 360) % 360) / 0.25);
      if (col >= GW) col -= GW;
      const row = Math.min(GH - 1, Math.max(0, Math.floor((90 - lat) / 0.25)));
      const k = row * GW + col;
      const lit = 0.3 + 0.7 * Math.max(0, u * LIGHT[0] + q * LIGHT[1] + z * LIGHT[2]);
      let r = SEA[0];
      let gg = SEA[1];
      let b = SEA[2];
      if (land[k]) {
        r = rgb[k * 3];
        gg = rgb[k * 3 + 1];
        b = rgb[k * 3 + 2];
        const lk = likely[k];
        if (v.amber > 0 && lk > 0 && lk !== 255) {
          // Screening classes: 2 = likely, 1 = possible (globe.js); amber, never mixed with green.
          const s = lk === 2 ? 1 : 0.62;
          r += (AMBER[0] * s - r) * v.amber;
          gg += (AMBER[1] * s - gg) * v.amber;
          b += (AMBER[2] * s - b) * v.amber;
        }
        const fd = first[k];
        if (fd === 255 || fd > v.day) {
          // Not imaged yet this season (the dimming eases off for the zoom).
          const dim = 0.4 + 0.6 * v.scanOff;
          r *= dim;
          gg *= dim;
          b *= dim;
        } else {
          const fresh = v.day - fd;
          if (fresh < 1.6) {
            const s = (1 - fresh / 1.6) * 0.85;
            r += (SCAN[0] - r) * s;
            gg += (SCAN[1] - gg) * s;
            b += (SCAN[2] - b) * s;
          }
        }
      }
      data[o] = r * lit;
      data[o + 1] = gg * lit;
      data[o + 2] = b * lit;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0, x0, y0, x1 - x0, y1 - y0);
  ctx.save();
  ctx.globalCompositeOperation = "destination-over";
  const glow = ctx.createRadialGradient(v.cx, v.cy, v.R * 0.97, v.cx, v.cy, v.R * 1.16);
  glow.addColorStop(0, "rgba(86, 180, 233, 0.34)");
  glow.addColorStop(1, "rgba(86, 180, 233, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(v.cx, v.cy, v.R * 1.16, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// NISAR's near-polar orbit, 747 km up (to scale), seen at an angle; `s` is where it is.
function drawOrbit(ctx, v, s, alpha) {
  if (alpha <= 0) return;
  const k = 1 + 747 / 6371;
  const tilt = 16 * DEG;
  const phi = 62 * DEG;
  const e1 = [Math.sin(tilt), Math.cos(tilt), 0];
  const e2 = [Math.cos(phi) * Math.cos(tilt), -Math.cos(phi) * Math.sin(tilt), Math.sin(phi)];
  const P = (a) => [0, 1, 2].map((i) => k * (Math.cos(a) * e1[i] + Math.sin(a) * e2[i]));
  const hidden = (p) => p[2] < 0 && p[0] ** 2 + p[1] ** 2 < 1;
  const X = (p) => v.cx + p[0] * v.R;
  const Y = (p) => v.cy - p[1] * v.R;
  ctx.save();
  ctx.lineWidth = 2;
  const N = 220;
  for (let i = 0; i < N; i++) {
    const p0 = P((i / N) * Math.PI * 2);
    const p1 = P(((i + 1) / N) * Math.PI * 2);
    if (hidden(p0) || hidden(p1)) continue;
    ctx.strokeStyle = `rgba(232, 238, 234, ${(p0[2] >= 0 ? 0.5 : 0.16) * alpha})`;
    ctx.beginPath();
    ctx.moveTo(X(p0), Y(p0));
    ctx.lineTo(X(p1), Y(p1));
    ctx.stroke();
  }
  const p = P(s);
  if (!hidden(p)) {
    const x = X(p);
    const y = Y(p);
    if (p[2] > 0) {
      // The radar beam to the ground beneath.
      const m = Math.hypot(...p);
      const gx = v.cx + (p[0] / m) * v.R;
      const gy = v.cy - (p[1] / m) * v.R;
      const beam = ctx.createLinearGradient(x, y, gx, gy);
      beam.addColorStop(0, `rgba(170, 232, 255, ${0.8 * alpha})`);
      beam.addColorStop(1, "rgba(170, 232, 255, 0)");
      ctx.strokeStyle = beam;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(gx, gy);
      ctx.stroke();
    }
    const halo = ctx.createRadialGradient(x, y, 0, x, y, 26);
    halo.addColorStop(0, `rgba(232, 238, 234, ${0.9 * alpha})`);
    halo.addColorStop(1, "rgba(232, 238, 234, 0)");
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------- waves (physics scene)

// A wave drawn along a polyline from arc length s0 to s1: a sine of wavelength `lam` across
// the path, tapering at both ends, its crests moving with `phase`.
function wavePath(pts, s0, s1, lam, amp, phase) {
  const segs = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    segs.push([pts[i - 1], pts[i], total, L]);
    total += L;
  }
  s1 = Math.min(s1, total);
  if (s1 <= s0) return "";
  const out = [];
  for (let s = s0; s <= s1; s += 3) {
    const sg = segs.find(([, , a, L]) => s <= a + L) ?? segs.at(-1);
    const [p, q, a, L] = sg;
    const f = (s - a) / L;
    const dx = (q[0] - p[0]) / L;
    const dy = (q[1] - p[1]) / L;
    const taper = Math.min(1, (s - s0) / 24, (s1 - s) / 24);
    const off = amp * taper * Math.sin((2 * Math.PI * s) / lam - phase);
    const x = p[0] + (q[0] - p[0]) * f - dy * off;
    const y = p[1] + (q[1] - p[1]) * f + dx * off;
    out.push(`${out.length ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return out.join("");
}

const pathLength = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

function pointAt(pts, s) {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (s <= acc + L) {
      const f = (s - acc) / L;
      return [lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f)];
    }
    acc += L;
  }
  return pts.at(-1);
}

function satellite(parent, x, y) {
  const g = sv("g", { transform: `translate(${x} ${y})` }, parent);
  sv("rect", { x: -60, y: -9, width: 40, height: 18, rx: 2, fill: "#3a5a6e" }, g);
  sv("rect", { x: 20, y: -9, width: 40, height: 18, rx: 2, fill: "#3a5a6e" }, g);
  sv("rect", { x: -16, y: -14, width: 32, height: 28, rx: 5, fill: "#c9d4d0" }, g);
  sv("path", { d: "M-22 16 A 30 14 0 0 0 22 16", fill: "none", stroke: "#c9d4d0", "stroke-width": 3 }, g);
  return g;
}

function forest(parent) {
  sv("rect", { x: 0, y: 600, width: 800, height: 100, fill: "#0f3a58" }, parent);
  sv("path", { d: "M0 600 Q 50 594 100 600 T 200 600 T 300 600 T 400 600 T 500 600 T 600 600 T 700 600 T 800 600", stroke: "#56b4e9", "stroke-width": 2, fill: "none", opacity: 0.8 }, parent);
  for (const x of [170, 400, 630]) {
    sv("rect", { x: x - 9, y: 350, width: 18, height: 250, fill: "#6b5442" }, parent);
    sv("ellipse", { cx: x, cy: 292, rx: 112, ry: 82, fill: "#2c5541" }, parent);
    sv("ellipse", { cx: x - 18, cy: 270, rx: 74, ry: 50, fill: "#3f6b52" }, parent);
  }
}

// C-band's short wave meeting the canopy (in a forest() group): it reaches the leaves and
// scatters back out, in every direction, and never reaches the water. Returns update(lt), lt in
// seconds since the scene began.
const SHORT_PATH = [[690, 84], [600, 214]];
const SCATTER = [-168, -140, -112, -84, -56, -28].map((a) => a * DEG);
const WAVE_V = 330;
function shortWave(g) {
  const len = pathLength(SHORT_PATH);
  const wave = sv("path", { fill: "none", stroke: "#56b4e9", "stroke-width": 4, "stroke-linecap": "round" }, g);
  const scatter = SCATTER.map(() => sv("path", { fill: "none", stroke: "#56b4e9", "stroke-width": 3, "stroke-linecap": "round" }, g));
  return (lt) => {
    const phase = lt * 11;
    const head = WAVE_V * (lt - 0.7);
    wave.setAttribute("d", head > 0 ? wavePath(SHORT_PATH, 0, head, 15, 9, phase) : "");
    const hit = 0.7 + len / WAVE_V;
    const c = SHORT_PATH[1];
    scatter.forEach((p, i) => {
      // Each wavelet leaves the leaves again and again, in its own direction, fading.
      const cycle = 1.1;
      const since = lt - hit - i * 0.09;
      if (since <= 0) return p.setAttribute("d", "");
      const L = 8 + (since % cycle) * 190;
      const end = [c[0] + Math.cos(SCATTER[i]) * L, c[1] + Math.sin(SCATTER[i]) * L];
      p.setAttribute("d", wavePath([c, end], Math.max(0, L - 80), L, 15, 6, phase));
      p.setAttribute("opacity", (0.95 * (1 - (since % cycle) / cycle)).toFixed(2));
    });
  };
}

// The mark (docs/BRAND.md, D-109): canopy, the L of trunk and water, NISAR's signal and its echo,
// on a 32 grid. `draw` adds pathLength so the title can draw it stroke by stroke.
function brandMark(parent, size, draw = false) {
  const svg = sv("svg", { viewBox: "0 0 32 32", width: size, height: size, fill: "none", "stroke-linecap": "round", "stroke-linejoin": "round" }, parent);
  const p = (d, stroke, w) => sv("path", { d, stroke, "stroke-width": w, ...(draw ? { pathLength: 1 } : {}) }, svg);
  const parts = [
    p("M3.4 13.2C5.6 6.2 14.4 6.2 16.6 13.2", "#7FA894", 2.6),
    p("M10 13.2V26", "#EEF3F1", 2.8),
    p("M10 26H28.5", "#56B4E9", 2.8),
    p("M27.45 5.63Q25.24 5.30 24.17 3.34M26.44 8.83Q23.18 8.25 21.52 5.39", "#E69F00", 1.8),
    p("M22.15 9.73L12.6 23.4", "#E69F00", 2),
  ];
  const echo = sv("circle", { cx: 12.4, cy: 23.7, r: 2, fill: "#E69F00" }, svg);
  return { svg, parts, echo };
}

// ---------------------------------------------------------------- the film

function buildFilm(stage, data) {
  const { marks: M, duration } = timeline(SHORT);
  const fade = (d) => Math.min(0.45, d * 0.18);
  const layers = [];
  const add = (cls) => {
    const l = el("div", `layer ${cls}`, stage);
    return l;
  };

  // Opening: Sylhet, June 2022 --------------------------------------------------
  // A person's own published words, then the toll, then the map of that week. No photographs of
  // people (Dóchas code, docs/film/RESEARCH.md §1); the water is drawn, not filmed.
  const flood = add("flood-bg");
  const waterSvg = sv("svg", { class: "water", viewBox: `0 0 ${W} 400`, preserveAspectRatio: "none" }, flood);
  const waterBody = sv("path", { fill: "url(#water-fill)" }, waterSvg);
  const wdefs = sv("defs", {}, waterSvg);
  const wfill = sv("linearGradient", { id: "water-fill", x1: 0, y1: 0, x2: 0, y2: 1 }, wdefs);
  sv("stop", { offset: "0", "stop-color": "#1d5a80", "stop-opacity": "0.95" }, wfill);
  sv("stop", { offset: "1", "stop-color": "#06141c", "stop-opacity": "1" }, wfill);
  const waterLine = sv("path", { fill: "none", stroke: "#56b4e9", "stroke-width": 3, opacity: 0.85 }, waterSvg);

  const cold = add("cold");
  const cWrap = el("div", "cold-wrap", cold);
  const cWhere = el("p", "eyebrow", cWrap, t("film.cold_where"));
  const cQuote = words(cWrap, "quote", t("film.cold_quote"));
  const cWho = el("p", "lead", cWrap, t("film.cold_who"));

  const toll = add("toll");
  const tlWrap = el("div", "cold-wrap", toll);
  const tlBig = el("div", "big", tlWrap);
  const tlLead = words(tlWrap, "lead", t("film.toll_lead"));
  const tlWarn = words(tlWrap, "h1", t("film.toll_warn"));
  const tlSrc = el("p", "source", toll, t("film.toll_src"));

  const blind = add("blind");
  const bSplit = el("div", "split", blind);
  const bCopy = el("div", "copy", bSplit);
  const bH = words(bCopy, "h1", t("film.blind_title"));
  const bLead = el("p", "lead", bCopy, t("film.blind_forest"));
  const bSrc = el("p", "label", bCopy, t("film.blind_chip"));
  const bVis = el("div", "visual", bSplit);
  const bSvg = sv("svg", { class: "blind-svg", viewBox: "0 0 800 700", preserveAspectRatio: "xMidYMid meet" }, bVis);
  const bG = sv("g", {}, bSvg);
  forest(bG);
  // The water under the trees, unseen: drawn faint, with a question where the map is blank.
  const bUnseen = sv("rect", { x: 0, y: 600, width: 800, height: 100, fill: "#e69f00", opacity: 0 }, bG);
  satellite(bG, 680, 60);
  const bLab = sv("text", { x: 32, y: 52, fill: "#e8eeea", "font-size": 34, "font-family": "Bahnschrift, Segoe UI, sans-serif", "font-weight": 600 }, bG);
  bLab.textContent = t("film.short_waves");
  const bWave = shortWave(bG);
  const bQ = sv("text", { x: 400, y: 664, fill: "#f2c14e", "font-size": 34, "font-weight": 600, "text-anchor": "middle", opacity: 0 }, bG);
  bQ.textContent = t("film.blind_q");

  // Globe (hook and zoom) -------------------------------------------------------
  const gcanvas = el("canvas", "full", stage);
  gcanvas.width = W;
  gcanvas.height = H;
  const gctx = gcanvas.getContext("2d");
  const globe = { ctx: gctx, img: gctx.createImageData(W, H), tex: data.globe };
  const G0 = PORTRAIT ? { cx: 540, cy: 760, R: 430 } : { cx: 1270, cy: 540, R: 430 };

  const hook = add("hook");
  const hookCopy = el("div", "hook-copy", hook);
  const hook1 = words(hookCopy, "h1", t("film.hook_launch"));
  const hook2 = words(hookCopy, "lead", t("film.hook_every"));
  const placeNote = (n) => {
    if (PORTRAIT) Object.assign(n.style, { left: "72px", right: "72px", top: "250px", justifyContent: "center" });
    else Object.assign(n.style, { left: `${G0.cx - 420}px`, width: "840px", top: `${G0.cy + G0.R + 50}px`, justifyContent: "center" });
    return n;
  };
  const noteScan = placeNote(el("div", "globe-note", hook));
  const scanKey = el("span", "", noteScan);
  el("i", "swatch", scanKey).style.background = `rgb(${SCAN.join(",")})`;
  scanKey.append(t("film.globe_scan"));
  const noteDay = el("b", "", noteScan);
  const noteAmber = placeNote(el("div", "globe-note", hook));
  const amberKey = el("span", "", noteAmber);
  el("i", "swatch", amberKey).style.background = "var(--hidden)";
  amberKey.append(t("film.globe_floodforest"));

  const pin = add("pin-layer");
  const pinBox = el("div", "pin", pin);
  el("div", "ring", pinBox);
  el("div", "name", pinBox, t("film.place"));

  // Sylhet: camera, then other radar, then NISAR -------------------------------------
  const syl = add("sylhet");
  const sSplit = el("div", "split", syl);
  const sCopy = el("div", "copy stack", sSplit);
  const camCopy = el("div", "copy", sCopy);
  const camH = words(camCopy, "h1", t("film.camera_title"));
  const camL = el("p", "lead", camCopy, t("film.camera_note", { pct: fmtNumber(data.sylhet.products.optical.cloud_fraction * 100, 0) }));
  const cbCopy = el("div", "copy", sCopy);
  const cbH = words(cbCopy, "h1", t("film.cband_title"));
  const cbL = el("p", "lead", cbCopy, t("film.cband_note"));
  const niCopy = el("div", "copy", sCopy);
  const niH = words(niCopy, "h1", t("film.nisar_title"));
  const niStat = el("div", "stat-row", niCopy);
  const niBig = el("div", "big", niStat);
  const niNum = el("span", "", niBig);
  el("small", "", niBig, t("film.km2"));
  el("p", "lead", niStat, t("film.nisar_stat"));
  const niMissed = el("div", "stat-line", niCopy);
  el("i", "swatch", niMissed).style.background = "var(--hidden)";
  niMissed.append(t("film.nisar_missed", { km2: fmtNumber(data.pass.hidden_from_cband_km2, 1) }));

  const sVis = el("div", "visual", sSplit);
  const sCol = el("div", "", sVis);
  const frame = el("div", "frame sylhet-frame", sCol);
  const imgPhoto = el("img", "px", frame);
  imgPhoto.src = data.images.optical.src;
  const imgCb = el("img", "px", frame);
  imgCb.src = data.images.cband.src;
  const imgNi = el("img", "px", frame);
  imgNi.src = data.images.nisar.src;
  const wipe = el("div", "wipe", frame);
  const chipPhoto = el("div", "chip", frame, t("film.chip_photo", { date: fmtDate(data.sylhet.products.optical.date) }));
  const chipCb = el("div", "chip", frame, t("film.chip_cband", { date: fmtDate(data.pass.cband_date) }));
  const chipNi = el("div", "chip", frame, t("film.chip_nisar", { date: fmtDate(data.pass.date) }));
  const keyRow = el("div", "stack", sCol);
  keyRow.style.marginTop = "22px";
  const keyCb = el("div", "key", keyRow);
  swatch(keyCb, "var(--cband)", t("film.key_cband"));
  const keyNi = el("div", "key", keyRow);
  swatch(keyNi, "var(--hidden)", t("film.key_hidden"));
  swatch(keyNi, "#0072b2", t("film.key_open"));

  // Physics ----------------------------------------------------------------------------
  const phys = add("physics");
  const pWrap = el("div", "physics-wrap", phys);
  const pH = words(pWrap, "h1", t("film.physics_title"));
  pH.style.maxWidth = PORTRAIT ? "none" : "1400px";
  const svg = sv("svg", { viewBox: PORTRAIT ? "0 0 800 1400" : "0 0 1600 700", preserveAspectRatio: "xMidYMid meet" }, pWrap);
  const defs = sv("defs", {}, svg);
  const flare = sv("radialGradient", { id: "flare" }, defs);
  sv("stop", { offset: "0", "stop-color": "#e69f00", "stop-opacity": "0.95" }, flare);
  sv("stop", { offset: "1", "stop-color": "#e69f00", "stop-opacity": "0" }, flare);
  const gA = sv("g", {}, svg);
  const gB = sv("g", { transform: PORTRAIT ? "translate(0 700)" : "translate(800 0)" }, svg);
  for (const g of [gA, gB]) forest(g);
  if (!PORTRAIT) sv("line", { x1: 800, y1: 40, x2: 800, y2: 640, stroke: "rgba(232,238,234,0.12)", "stroke-width": 2 }, svg);
  // Radar looks sideways: the beam comes in at a slant, and a double bounce sends it back
  // parallel to itself, towards the satellite.
  satellite(gA, 680, 60);
  satellite(gB, 680, 60);
  const labA = sv("text", { x: 32, y: 52, fill: "#e8eeea", "font-size": 34, "font-family": "Bahnschrift, Segoe UI, sans-serif", "font-weight": 600 }, gA);
  labA.textContent = t("film.short_waves");
  const subA = sv("text", { x: 32, y: 94, fill: "#a3b2ae", "font-size": 27 }, gA);
  subA.textContent = t("film.short_waves_do");
  const labB = sv("text", { x: 32, y: 52, fill: "#e8eeea", "font-size": 34, "font-family": "Bahnschrift, Segoe UI, sans-serif", "font-weight": 600 }, gB);
  labB.textContent = t("film.long_waves");
  const subB = sv("text", { x: 32, y: 94, fill: "#a3b2ae", "font-size": 27 }, gB);
  subB.textContent = t("film.long_waves_do");
  const pathB = [[694, 84], [470, 598], [409, 562], [630, 84]];
  const lenB = pathLength(pathB);
  const waveA = shortWave(gA);
  const flareB = sv("ellipse", { cx: 470, cy: 600, rx: 120, ry: 34, fill: "url(#flare)", opacity: 0 }, gB);
  const waveB = sv("path", { fill: "none", stroke: "#e8eeea", "stroke-width": 4, "stroke-linecap": "round" }, gB);
  const ret = sv("circle", { cx: 680, cy: 60, r: 40, fill: "none", stroke: "#e8eeea", "stroke-width": 3, opacity: 0 }, gB);

  // People ------------------------------------------------------------------------------
  const ppl = add("people");
  const pSplit = el("div", "split", ppl);
  const pCopy = el("div", "copy", pSplit);
  const pop = data.sylhet.exposure.population_near_hidden_flood;
  const pBig = el("div", "big", pCopy);
  const pLead = words(pCopy, "lead", t("film.people_title"));
  el("p", "label", pCopy, t("film.people_note"));
  const pVis = el("div", "visual dots", pSplit);
  const nDots = Math.round(pop / 1000);
  const cols = PORTRAIT ? 20 : 27;
  const rows = Math.ceil(nDots / cols);
  const dsvg = sv("svg", { viewBox: `0 0 ${cols * 32} ${rows * 32}` }, pVis);
  const dots = [];
  for (let i = 0; i < nDots; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    dots.push(sv("circle", { cx: c * 32 + 16, cy: r * 32 + 16, r: 10.5, fill: "#e8eeea" }, dsvg));
  }

  // Season: how long the water stayed ------------------------------------------------------
  const hp = data.sylhet.products.hydroperiod;
  const ssn = add("season");
  const snSplit = el("div", "split", ssn);
  const snCopy = el("div", "copy", snSplit);
  const snH = words(snCopy, "h1", t("film.season_title"));
  const snStat = el("div", "stat-row", snCopy);
  const snBig = el("div", "big", snStat);
  const snNum = el("span", "", snBig);
  el("small", "", snBig, t("film.days"));
  el("p", "lead", snStat, t("film.season_stat"));
  const snAny = el("p", "label", snCopy, t("film.season_any", { km2: fmtNumber(hp.flooded_any_km2, 0), first: fmtDate(data.sylhet.passes[0].date), last: fmtDate(data.sylhet.passes.at(-1).date) }));
  const snVis = el("div", "visual", snSplit);
  const snCol = el("div", "", snVis);
  const snFrame = el("div", "frame sylhet-frame", snCol);
  const snImg = el("img", "px", snFrame);
  snImg.src = data.images.hydro.src;
  el("div", "chip", snFrame, t("film.chip_season"));
  const snRamp = el("div", "ramp ramp-hydro", snCol);
  const snEnds = el("div", "ramp-ends", snCol);
  el("span", "", snEnds, t("film.ramp_days_lo"));
  el("span", "", snEnds, t("film.ramp_days_hi", { n: fmtNumber(hp.max_days, 0) }));
  snRamp.style.width = "100%";

  // The village card -------------------------------------------------------------------------
  const crd = add("card");
  const cdSplit = el("div", "split", crd);
  const cdCopy = el("div", "copy", cdSplit);
  const cdH = words(cdCopy, "h1", t("film.card_title"));
  el("p", "lead", cdCopy, t("film.card_lead"));
  const cdNot = el("div", "stat-line warn", cdCopy);
  el("i", "swatch", cdNot).style.background = "#f2c14e";
  cdNot.append(t("film.card_not"));
  const cdVis = el("div", "visual", cdSplit);
  const cdPhone = el("div", "phone", cdVis);
  cdPhone.append(data.card);

  // Places: everywhere it is mapped, and Limpopo ---------------------------------------------
  const plc = add("places");
  const plWrap = el("div", "places-wrap", plc);
  const plCopy = el("div", "places-copy", plWrap);
  const floodSites = data.manifest.sites.filter((s) => s.kind === "flood" && !s.synthetic);
  const plH = words(plCopy, "h1", t("film.places_title", { n: fmtNumber(floodSites.length, 0) }));
  const plLead = el("p", "lead", plCopy, t("film.places_lead", { cells: fmtNumber(data.beltCells, 0) }));
  const wm = data.world.meta;
  const plMap = el("div", "world", plWrap);
  plMap.style.aspectRatio = `${wm.width} / ${wm.height}`;
  const wImg = el("img", "", plMap);
  wImg.src = data.world.img.src;
  const wSvg = sv("svg", { viewBox: `0 0 ${wm.width} ${wm.height}` }, plMap);
  const toXY = ([lon, lat]) => [((lon + 180) / 360) * wm.width, ((wm.lat_top - lat) / (wm.lat_top - wm.lat_bottom)) * wm.height];
  const mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const pins = [
    ...floodSites.map((s) => ({ at: mid(s.bounds), colour: "#e69f00", r: 6 })),
    ...data.manifest.sites.filter((s) => s.kind === "fire").map((s) => ({ at: mid(s.bounds), colour: "#e0607e", r: 6 })),
    ...data.motionIndex.events.map((e) => ({ at: mid(e.bounds), colour: "#9b86e6", r: 6 })),
    ...data.glaciers.glaciers.map((g) => ({ at: mid(g.bounds), colour: "#a8d8ea", r: 4.5 })),
  ].sort((a, b) => a.at[0] - b.at[0]);
  const pinEls = pins.map((p) => {
    const [x, y] = toXY(p.at);
    return sv("circle", { cx: x.toFixed(1), cy: y.toFixed(1), r: p.r, fill: p.colour, stroke: "#0b1214", "stroke-width": 1.5, opacity: 0 }, wSvg);
  });
  const lp = data.limpopo;
  const [lpx, lpy] = toXY(lp.summary.site.center);
  const lpRing = sv("circle", { cx: lpx.toFixed(1), cy: lpy.toFixed(1), r: 18, fill: "none", stroke: "#e8eeea", "stroke-width": 2.5, opacity: 0 }, wSvg);
  const plKey = el("div", "key places-key", plWrap);
  swatch(plKey, "#e69f00", t("film.legend_flood"));
  swatch(plKey, "#e0607e", t("film.legend_fire"));
  swatch(plKey, "#9b86e6", t("film.legend_ground"));
  swatch(plKey, "#a8d8ea", t("film.legend_ice"));
  const lpBox = el("div", "limpopo", plWrap);
  el("p", "h2", lpBox, t("film.places_limpopo_title"));
  el("p", "label", lpBox, t("film.places_limpopo"));
  const lpMaps = el("div", "lp-maps", lpBox);
  [lp.before, lp.peak].forEach((p, i) => {
    const f = el("div", "frame lp-frame", lpMaps);
    const im = el("img", "px", f);
    im.src = lp.images[i].src;
    el("div", "chip", f, t("film.lp_chip", { date: fmtDate(p.date), km2: fmtNumber(p.open_water_km2, 0) }));
  });

  // Fire ----------------------------------------------------------------------------------
  const burn = data.fire.products.burn;
  // The growth starts at the last pass before anything burned: the passes before it are all 0.
  const burnFrom = Math.max(0, burn.by_pass.findIndex((p) => p.new_km2 > 0) - 1);
  const fireL = add("fire");
  const fSplit = el("div", "split", fireL);
  const fCopy = el("div", "copy", fSplit);
  const fH = words(fCopy, "h1", t("film.fire_title"));
  el("p", "lead", fCopy, t("film.fire_place", { name: data.fire.site.name }));
  const fStat = el("div", "stat-row", fCopy);
  const fBig = el("div", "big", fStat);
  const fNum = el("span", "", fBig);
  el("small", "", fBig, t("film.km2"));
  const fLine = el("div", "stat-line", fStat);
  el("i", "swatch", fLine).style.background = "var(--burn)";
  fLine.append(t("film.fire_stat"));
  const second = data.manifest.sites.find((s) => s.kind === "fire" && s.id !== data.fire.site.id);
  if (second) el("p", "label", fCopy, t("film.fire_second", { name: second.name }));
  const fVis = el("div", "visual fire-visual", fSplit);
  const fFrame = el("div", "frame fire-frame", fVis);
  data.burn.forEach((c) => fFrame.append(c));
  el("div", "chip", fFrame, t("film.chip_fire"));
  const passes = el("div", "passes", fVis);
  passes.style.width = PORTRAIT ? "610px" : "486px";
  const ticks = burn.by_pass.map(() => el("i", "", passes));
  const fDate = el("div", "fire-date", fVis);

  // Ground --------------------------------------------------------------------------------
  const gnd = add("ground");
  const gSplit = el("div", "split", gnd);
  const gCopy = el("div", "copy", gSplit);
  const gH = words(gCopy, "h1", t("film.ground_title"));
  const gStats = el("div", "stack", gCopy);
  const qStat = el("div", "stat-row", gStats);
  const qBig = el("div", "big", qStat);
  // The 1st percentile, said as "up to about", so rounded to 5 (README: 70 cm, 30 cm a year).
  const about = (v) => fmtNumber(Math.round(Math.abs(v) / 5) * 5, 0);
  qBig.textContent = about(data.quake.doc.headline.east_p01_cm);
  el("small", "", qBig, t("film.cm"));
  const mainQuake = data.quake.doc.quakes.reduce((a, b) => (b.mag > a.mag ? b : a));
  el("p", "lead", qStat, t("film.quake_stat", { date: fmtDate(mainQuake.utc.slice(0, 10)), m: fmtNumber(mainQuake.mag, 1) }));
  const sStat = el("div", "stat-row", gStats);
  const sBig = el("div", "big", sStat);
  sBig.textContent = about(data.sink.doc.headline.up_p01_cm_yr);
  el("small", "", sBig, t("film.cm_year"));
  el("p", "lead", sStat, t("film.sink_stat"));
  const gVis = el("div", "visual", gSplit);
  const gFrames = el("div", "stack", gVis);
  gFrames.style.width = "100%";
  const mkMotion = (m, chipKey, endsKeys, aspect) => {
    const box = el("div", "", gFrames);
    box.style.alignSelf = "center";
    box.style.justifySelf = "center";
    box.style.width = aspect < 1 ? (PORTRAIT ? "720px" : "560px") : "100%";
    const fr = el("div", "frame ground-frame", box);
    fr.style.aspectRatio = aspect;
    fr.append(m.canvas);
    el("div", "chip", fr, t(chipKey));
    const ramp = el("div", "ramp", box);
    const stops = Array.from({ length: 11 }, (_, i) => cssColour("vik", i / 10)).join(", ");
    ramp.style.background = `linear-gradient(90deg, ${stops})`;
    const ends = el("div", "ramp-ends", box);
    el("span", "", ends, t(endsKeys[0], { v: fmtNumber(Math.abs(m.lo), 0) }));
    el("span", "", ends, t(endsKeys[1], { v: fmtNumber(Math.abs(m.hi), 0) }));
    return box;
  };
  const qBox = mkMotion(data.quake, "film.chip_quake", ["film.ramp_west", "film.ramp_east"], data.quake.doc.grid.width / data.quake.doc.grid.height);
  const sBox = mkMotion(data.sink, "film.chip_sink", ["film.ramp_sinking", "film.ramp_rising"], data.sink.doc.grid.width / data.sink.doc.grid.height);

  // Ice --------------------------------------------------------------------------------------
  const gl = data.ice.g;
  const glList = data.glaciers.glaciers;
  const icL = add("ice");
  const icSplit = el("div", "split", icL);
  const icCopy = el("div", "copy", icSplit);
  const icH = words(icCopy, "h1", t("film.ice_title"));
  const icStat = el("div", "stat-row", icCopy);
  const icBig = el("div", "big", icStat);
  icBig.textContent = fmtNumber(Math.round(gl.max_m_yr / 365.25), 0);
  el("small", "", icBig, t("film.m_day"));
  // The map's own measure: the 99.5th percentile of the 2014-2024 composite (glaciers.py), not the
  // trunk's single fastest year, which the chart beside it shows.
  el("p", "lead", icStat, t("film.ice_stat", { name: gl.name, a: fmtYear(data.ice.years[0]), b: fmtYear(data.ice.years[1]) }));
  el("p", "label", icCopy, t("film.ice_lead", { n: fmtNumber(glList.length, 0), c: fmtNumber(new Set(glList.map((x) => x.country)).size, 0), y: fmtYear(gl.years[0]) }));
  const icVis = el("div", "visual", icSplit);
  const icCol = el("div", "ice-col", icVis);
  const icFrame = el("div", "frame", icCol);
  icFrame.style.aspectRatio = data.ice.aspect;
  icFrame.append(data.ice.canvas);
  el("div", "chip", icFrame, t("film.chip_ice"));
  const trunkSvg = trunkChart(el("div", "trunk", icCol), gl);

  // Proof ----------------------------------------------------------------------------------
  const prf = add("proof");
  const prWrap = el("div", "proof-wrap", prf);
  const prH = words(prWrap, "h1", t("film.proof_title"));
  const proofs = el("div", "proofs", prWrap);
  const gauge = data.sylhet.validation.gauge;
  const p1 = el("div", "proof", proofs);
  el("p", "h2", p1, t("film.proof_river"));
  const riverSvg = riverChart(el("div", "chart", p1), gauge);
  el("p", "label", p1, t("film.proof_river_note", { n: gauge.n, r: fmtNumber(gauge.r, 2) }));
  const p2 = el("div", "proof", proofs);
  el("p", "h2", p2, t("film.proof_fire"));
  const fireBars = bars(el("div", "chart", p2), [
    [t("film.bar_nisar"), burn.burned_km2, "var(--burn)"],
    [t("film.bar_modis"), burn.validation.ref_burned_km2, "#7e8c89"],
  ], (v) => t("film.km2_value", { v: fmtNumber(v, 0) }));
  el("p", "label", p2, t("film.proof_fire_note"));
  const st = data.sink.doc.gnss[0];
  const p3 = el("div", "proof", proofs);
  el("p", "h2", p3, t("film.proof_gps"));
  const gpsBars = bars(el("div", "chart", p3), [
    [t("film.bar_gps"), Math.abs(st.rate_u_cm_yr), "#7e8c89"],
    [t("film.bar_nisar"), Math.abs(st.nisar.rate_up_cm_yr), "var(--ground)"],
  ], (v) => t("film.cm_year_value", { v: fmtNumber(v, 1) }));
  el("p", "label", p3, t("film.proof_gps_note", { id: st.id }));

  // Limits -----------------------------------------------------------------------------------
  const lim = add("limits");
  const lmWrap = el("div", "proof-wrap centred", lim);
  const lmH = words(lmWrap, "h1", t("film.limits_title"));
  const lmList = el("div", "limits-list", lmWrap);
  const lmRows = [
    ["hatch", "film.limits_1"],
    ["burn", "film.limits_2"],
    ["drop", "film.limits_3"],
    ["late", "film.limits_4"],
  ].map(([cls, key]) => {
    const r = el("div", "limit", lmList);
    el("i", `limit-ico ${cls}`, r);
    el("p", "lead", r, t(key));
    return r;
  });

  // Audiences: the landing page's six, each with its question, three features and a real screen --
  const aud = add("audience");
  const auPanels = AUDIENCES.map((a, i) => {
    const panel = el("div", "split aud-panel", aud);
    const copy = el("div", "copy", panel);
    el("p", "eyebrow", copy, `${t("film.aud_title")} · ${fmtNumber(i + 1, 0)} / ${fmtNumber(AUDIENCES.length, 0)}`);
    el("p", "aud-who", copy, t(`landing.aud_${a}`));
    const q = words(copy, "h1 aud-q", t(`landing.aud_${a}_q`));
    const chips = el("div", "aud-chips", copy);
    const fs = [1, 2, 3].map((k) => el("span", "aud-chip", chips, t(`landing.aud_${a}_f${k}`)));
    const vis = el("div", "visual", panel);
    const fr = el("div", "frame shot", vis);
    const img = el("img", "", fr);
    img.src = data.shots[i].src;
    return { panel, copy, q, fs, fr, img };
  });
  // The 30-second cut has no time for six beats: all six screens at once, each with its audience.
  const auGrid = el("div", "proof-wrap aud-grid-wrap", aud);
  const auGH = words(auGrid, "h1", t("film.aud_title"));
  const auGrid6 = el("div", "aud-grid", auGrid);
  const auTiles = AUDIENCES.map((a, i) => {
    const tile = el("div", "aud-tile", auGrid6);
    const fr = el("div", "frame shot", tile);
    el("img", "", fr).src = data.shots[i].src;
    el("p", "aud-who", tile, t(`landing.aud_${a}`));
    return tile;
  });
  if (!SHORT) auGrid.remove();

  // Everything in it: the index wall, readable on a paused frame (docs/film/FEATURE_MAP.md §3) --
  const idx = add("index");
  const ixWrap = el("div", "proof-wrap", idx);
  const ixHead = el("div", "ix-head", ixWrap);
  const ixH = words(ixHead, "h1", t("film.ix_title"));
  el("p", "lead", ixHead, t("film.ix_lead", { n: fmtNumber(SOURCES.length, 0) }));
  const ixGrid = el("div", "ix-grid", ixWrap);
  const ixCols = INDEX.map(([group, items]) => {
    const col = el("div", "ix-col", ixGrid);
    el("p", "ix-g", col, t(`film.ix_g_${group}`));
    for (const k of items) el("p", "ix-i", col, t(`film.ix_${k}`, { notebooks: fmtNumber(data.notebookCount, 0), cells: fmtNumber(data.beltCells, 0) }));
    return col;
  });

  // Where it can go next ------------------------------------------------------------------------
  const nxt = add("next");
  const nxWrap = el("div", "proof-wrap centred", nxt);
  const nxH = words(nxWrap, "h1", t("film.next_title"));
  const nxGrid = el("div", "next-grid", nxWrap);
  const nxRows = NEXT.map(([k, status]) => {
    const r = el("div", "next-row", nxGrid);
    el("span", `status ${status}`, r, t(`film.st_${status}`));
    el("p", "h2", r, t(`film.next_${k}`));
    el("p", "label", r, t(`film.next_${k}d`, { cells: fmtNumber(data.beltCells, 0), notebooks: fmtNumber(data.notebookCount, 0) }));
    return r;
  });

  // Title ----------------------------------------------------------------------------------
  const ttl = add("title");
  const tWrap = el("div", "title-wrap", ttl);
  const mark = brandMark(tWrap, PORTRAIT ? 170 : 190, true);
  const tName = el("div", "name", tWrap, t("app.title"));
  const tTag = el("div", "tag", tWrap, t("film.title_tag"));
  const tCta = el("div", "cta", tWrap, t("film.title_cta"));
  const tMeta = el("div", "meta", tWrap);
  el("div", "", tMeta, t("film.title_event"));
  el("div", "", tMeta, t("film.title_data", { n: fmtNumber(SOURCES.length, 0) }));
  el("div", "ai", tMeta, t("film.title_ai"));

  // Corner mark ---------------------------------------------------------------------------
  const bug = el("div", "bug", stage);
  brandMark(bug, 36);
  el("span", "", bug, t("app.title"));
  el("div", "vignette", stage);

  // Where the Sylhet frame ends up, for the zoom from the pin into it.
  let frameAt = null;
  const measure = () => {
    const sr = stage.getBoundingClientRect();
    const k = sr.width / W;
    const prev = syl.style.opacity;
    syl.style.opacity = "0";
    frame.style.transform = "none";
    const fr = frame.getBoundingClientRect();
    frameAt = { x: (fr.left - sr.left + fr.width / 2) / k, y: (fr.top - sr.top + fr.height / 2) / k };
    syl.style.opacity = prev;
  };

  // ------------------------------------------------------------------------- seek(t)
  function seek(time) {
    const x = clamp(time, 0, duration);
    if (!frameAt) measure();

    // Opening: the water rises under the quote and stays through the toll, then drains away as
    // the map of that week comes in.
    const co = M.cold;
    const tl = M.toll;
    const bl = M.blind;
    const fA = shown(x, 0, (tl.d ? tl.b : co.b) + XF, 0.8, 0.6 + XF);
    setOpacity(flood, fA);
    if (fA > 0) {
      const rise = easeInOut(seg(x, 0.6, co.a + co.d * 0.85));
      const level = 400 - 400 * (PORTRAIT ? 0.62 : 0.78) * rise;
      const phase = x * 1.7;
      const crest = [];
      for (let px = 0; px <= W; px += 24) crest.push(`${px ? "L" : "M"}${px} ${(level + Math.sin(px / 140 + phase) * 7 + Math.sin(px / 61 - phase * 1.4) * 3).toFixed(1)}`);
      waterLine.setAttribute("d", crest.join(""));
      waterBody.setAttribute("d", `${crest.join("")}L${W} 400L0 400Z`);
    }
    const cA = shown(x, co.a, co.b, 0.5, 0.4);
    setOpacity(cold, cA);
    if (cA > 0) {
      setOpacity(cWhere, seg(x, co.a + 0.2, co.a + 0.8));
      showWords(cQuote, x - co.a - 0.6);
      setOpacity(cWho, seg(x, co.a + co.d * 0.55, co.a + co.d * 0.55 + 0.5));
    }
    const tA = tl.d ? shown(x, tl.a, tl.b, 0.4, 0.4) : 0;
    setOpacity(toll, tA);
    if (tA > 0) {
      const lt = x - tl.a;
      // The toll is a cited figure, not a result: it counts up once and holds.
      tlBig.textContent = t("film.toll_big", { v: fmtNumber(7.2 * expoOut(seg(lt, 0.1, 1.4)), 1) });
      showWords(tlLead, lt - 0.5);
      setOpacity(tlWarn, 1);
      showWords(tlWarn, lt - tl.d * 0.45);
      setOpacity(tlSrc, seg(lt, 0.8, 1.3));
    }
    const bA = shown(x, bl.a - XF, bl.b + XF, 0.4 + XF, 0.4 + XF);
    setOpacity(blind, bA);
    if (bA > 0) {
      const lt = x - bl.a;
      setOpacity(bCopy, shown(x, bl.a, bl.b, 0.3, 0.3));
      showWords(bH, lt - 0.15);
      // The 30-second cut has no time to read the Ratargul line; the title and source carry it.
      setOpacity(bLead, SHORT ? 0 : seg(lt, bl.d * 0.35, bl.d * 0.35 + 0.5));
      setOpacity(bSrc, seg(lt, 0.9, 1.4));
      bWave(lt);
      // Once the short wave has scattered, the water beneath shows faintly, unmapped.
      const q = seg(lt, 2.2, 2.9);
      bUnseen.setAttribute("opacity", (0.35 * q * (0.8 + 0.2 * Math.sin(lt * 3))).toFixed(2));
      bQ.setAttribute("opacity", q.toFixed(2));
    }

    // Globe: spin through the hook, then turn to Sylhet and fall towards it.
    const hk = M.hook;
    const zm = M.zoom;
    const gAlpha = shown(x, hk.a - XF, zm.b + 0.5, 0.8, 0.6);
    setOpacity(gcanvas, gAlpha);
    if (gAlpha > 0) {
      const zf = easeInOut(seg(x, zm.a, zm.b));
      const spin = seg(x, hk.a - XF, zm.a);
      const lon0 = zf > 0 ? lerp(58, SYLHET[0], zf) : lerp(-48, 58, spin);
      const lat0 = lerp(8, SYLHET[1], zf);
      const R1 = PORTRAIT ? 3300 : 3800;
      const R = G0.R * (R1 / G0.R) ** zf;
      const day = x < hk.b ? 12 * easeInOut(seg(x, hk.a + 0.3, hk.b - 0.5)) : lerp(12, 40, seg(x, zm.a, zm.b));
      const amber = easeOut(seg(x, hk.a + hk.d * 0.55, hk.a + hk.d * 0.55 + 0.9));
      const scanOff = seg(x, zm.a, zm.a + Math.min(0.6, zm.d * 0.4));
      drawGlobe(globe, { cx: lerp(G0.cx, W / 2, zf), cy: lerp(G0.cy, H / 2, zf), R, lon0, lat0, day, amber, scanOff });
      drawOrbit(gctx, { cx: G0.cx, cy: G0.cy, R: G0.R }, 1.1 + ((x - hk.a) / 4.6) * Math.PI * 2, 1 - seg(x, zm.a, zm.a + 0.5));
    }

    // Hook words and the globe's key.
    const hA = shown(x, hk.a, hk.b + 0.1, 0.3, 0.45);
    setOpacity(hook, hA);
    if (hA > 0) {
      showWords(hook1, x - hk.a - 0.3);
      showWords(hook2, x - hk.a - hk.d * 0.4);
      const dayN = Math.max(1, Math.min(12, Math.ceil(12 * easeInOut(seg(x, hk.a + 0.3, hk.b - 0.5)))));
      noteDay.textContent = t("film.globe_day", { n: fmtNumber(dayN, 0) });
      // One key leaves before the other arrives: words never dissolve into words (D-084).
      const amb = seg(x, hk.a + hk.d * 0.55, hk.a + hk.d * 0.55 + 0.6);
      setOpacity(noteScan, 1 - clamp(amb * 2));
      setOpacity(noteAmber, clamp(amb * 2 - 1));
    }

    // Pin on Sylhet as the zoom ends.
    const pinA = shown(x, zm.b - zm.d * 0.45, M.camera.a + 0.15, 0.3, 0.4);
    setOpacity(pin, pinA);
    if (pinA > 0) pinBox.style.transform = `translate(-50%, -50%) scale(${lerp(1.3, 1, easeOut(seg(x, zm.b - zm.d * 0.45, zm.b)))})`;

    // Sylhet frame: grows out of the pin, then camera, other radar, NISAR.
    const cam = M.camera;
    const cb = M.cband;
    const ni = M.nisar;
    const sA = shown(x, cam.a - 0.15, ni.b + XF, 0.4, 0.4 + XF);
    setOpacity(syl, sA);
    if (sA > 0) {
      const grow = easeInOut(seg(x, cam.a - 0.15, cam.a + Math.min(0.9, cam.d * 0.3)));
      const dx = (W / 2 - frameAt.x) * (1 - grow);
      const dy = (H / 2 - frameAt.y) * (1 - grow);
      frame.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${lerp(0.14, 1, grow).toFixed(4)})`;
      const toCb = easeInOut(seg(x, cb.a, cb.a + Math.min(0.7, cb.d * 0.3)));
      const wipeA = ni.a + Math.min(0.3, ni.d * 0.08);
      const wipeB = wipeA + Math.min(1.7, ni.d * 0.32);
      const wf = easeInOut(seg(x, wipeA, wipeB));
      setOpacity(imgPhoto, 1 - toCb);
      setOpacity(imgCb, toCb * (1 - seg(x, wipeB, wipeB + 0.6)));
      imgNi.style.clipPath = `inset(0 ${((1 - wf) * 100).toFixed(2)}% 0 0)`;
      setOpacity(imgNi, wf > 0 ? 1 : 0);
      wipe.style.left = `${(wf * 100).toFixed(2)}%`;
      setOpacity(wipe, wf > 0 && wf < 1 ? 1 : 0);
      setOpacity(chipPhoto, 1 - toCb);
      setOpacity(chipCb, toCb * (1 - seg(x, wipeA, wipeA + 0.4)));
      setOpacity(chipNi, seg(x, wipeA, wipeA + 0.4));
      setOpacity(keyCb, toCb * (1 - seg(x, wipeA, wipeA + 0.4)));
      setOpacity(keyNi, seg(x, wipeB - 0.4, wipeB));
      // Words for each phase.
      setOpacity(camCopy, shown(x, cam.a, cb.a + 0.1, 0.3, 0.3));
      showWords(camH, x - cam.a - 0.3);
      setOpacity(camL, seg(x, cam.a + 0.8, cam.a + 1.3));
      setOpacity(cbCopy, shown(x, cb.a, ni.a + 0.1, 0.3, 0.3));
      showWords(cbH, x - cb.a - 0.15);
      setOpacity(cbL, seg(x, cb.a + 0.8, cb.a + 1.3));
      setOpacity(niCopy, shown(x, ni.a, ni.b, 0.3, 0.4));
      showWords(niH, x - ni.a - 0.15);
      const cf = expoOut(seg(x, wipeA + 0.2, wipeB + 0.6));
      niNum.textContent = fmtNumber(data.pass.flooded_veg_km2 * cf, 1);
      setOpacity(niStat, seg(x, wipeA, wipeA + 0.4));
      setOpacity(niMissed, seg(x, wipeB, wipeB + 0.5));
    }

    // Physics: short waves scatter in the leaves; long waves reach the water and come back.
    const ph = M.physics;
    const phA = ph.d ? shown(x, ph.a - XF, ph.b + XF, 0.45 + XF, 0.4 + XF) : 0;
    setOpacity(phys, phA);
    if (phA > 0) {
      const lt = x - ph.a;
      setOpacity(pH, shown(x, ph.a, ph.b, 0.3, 0.3));
      showWords(pH, lt - 0.15);
      const v = WAVE_V;
      const phase = lt * 11;
      waveA(lt);
      const headB = v * (lt - 0.7);
      waveB.setAttribute("d", headB > 0 ? wavePath(pathB, 0, headB, 58, 13, phase * 0.55) : "");
      const hitB = 0.7 + Math.hypot(pathB[1][0] - pathB[0][0], pathB[1][1] - pathB[0][1]) / v;
      flareB.setAttribute("opacity", (easeOut(seg(lt, hitB, hitB + 0.35)) * (0.75 + 0.25 * Math.sin(lt * 5))).toFixed(2));
      const back = 0.7 + lenB / v;
      ret.setAttribute("opacity", (shown(lt, back, back + 1.1, 0.15, 0.8) * 0.9).toFixed(2));
      ret.setAttribute("r", (40 + 50 * seg(lt, back, back + 1.1)).toFixed(1));
    }

    // People.
    const pe = M.people;
    const peA = shown(x, pe.a - XF, pe.b + XF, 0.4 + XF, 0.4 + XF);
    setOpacity(ppl, peA);
    if (peA > 0) {
      const lt = x - pe.a;
      setOpacity(pCopy, shown(x, pe.a, pe.b, 0.3, 0.3));
      const cf = expoOut(seg(lt, 0.2, pe.d * 0.55));
      pBig.textContent = fmtApprox(pop * cf);
      showWords(pLead, lt - 0.5);
      dots.forEach((d, i) => {
        const at = 0.2 + (i / nDots) * pe.d * 0.5;
        d.setAttribute("opacity", (0.92 * easeOut(seg(lt, at, at + 0.25))).toFixed(2));
      });
    }

    // Season: the days-flooded map, its longest stretch counted up (a whole number of days, not a
    // date-tied total, so the count may pass through values on its way).
    const sn = M.season;
    const snA = sn.d ? shown(x, sn.a - XF, sn.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(ssn, snA);
    if (snA > 0) {
      const lt = x - sn.a;
      setOpacity(snCopy, shown(x, sn.a, sn.b, 0.3, 0.3));
      showWords(snH, lt - 0.15);
      snNum.textContent = fmtNumber(Math.round(hp.max_days * expoOut(seg(lt, 0.5, sn.d * 0.55))), 0);
      setOpacity(snAny, seg(lt, sn.d * 0.45, sn.d * 0.45 + 0.5));
      snFrame.style.transform = `scale(${lerp(1.03, 1, easeOut(seg(lt, 0, sn.d))).toFixed(4)})`;
    }

    // The village card rises like a phone screen.
    const cd = M.card;
    const cdA = cd.d ? shown(x, cd.a - XF, cd.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(crd, cdA);
    if (cdA > 0) {
      const lt = x - cd.a;
      setOpacity(cdCopy, shown(x, cd.a, cd.b, 0.3, 0.3));
      showWords(cdH, lt - 0.15);
      setOpacity(cdNot, seg(lt, cd.d * 0.5, cd.d * 0.5 + 0.5));
      const up = easeOut(seg(lt, 0, 1.1));
      cdPhone.style.transform = `translateY(${((1 - up) * 80).toFixed(1)}px)`;
    }

    // Places: pins sweep in west to east, then Limpopo.
    const pl = M.places;
    const plA = pl.d ? shown(x, pl.a - XF, pl.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(plc, plA);
    if (plA > 0) {
      const lt = x - pl.a;
      setOpacity(plCopy, shown(x, pl.a, pl.b, 0.3, 0.3));
      showWords(plH, lt - 0.15);
      setOpacity(plLead, seg(lt, 0.9, 1.4));
      pinEls.forEach((p, i) => {
        const at = 0.3 + (i / pinEls.length) * pl.d * 0.35;
        p.setAttribute("opacity", easeOut(seg(lt, at, at + 0.3)).toFixed(2));
      });
      setOpacity(plKey, seg(lt, pl.d * 0.3, pl.d * 0.3 + 0.4));
      const lpAt = pl.d * 0.45;
      lpRing.setAttribute("opacity", shown(lt, lpAt, pl.d, 0.3, 0.01).toFixed(2));
      lpRing.setAttribute("r", (18 + 10 * Math.sin(Math.max(0, lt - lpAt) * 4) ** 2).toFixed(1));
      setOpacity(lpBox, easeOut(seg(lt, lpAt + 0.2, lpAt + 0.7)));
    }

    // Fire, pass by pass.
    const fi = M.fire;
    const fiA = shown(x, fi.a - XF, fi.b + XF, 0.4 + XF, 0.4 + XF);
    setOpacity(fireL, fiA);
    if (fiA > 0) {
      const lt = x - fi.a;
      setOpacity(fCopy, shown(x, fi.a, fi.b, 0.3, 0.3));
      showWords(fH, lt - 0.15);
      const n = burn.by_pass.length;
      const f = lerp(burnFrom, n - 1, easeInOut(seg(lt, fi.d * 0.12, fi.d * 0.78)));
      const i = Math.min(n - 1, Math.floor(f));
      const frac = f - i;
      // The number and the date only ever show a real pass (no in-between totals): they step
      // halfway between passes, while the map dissolves into the next pass around that moment.
      const at = Math.min(n - 1, Math.round(f));
      const blend = clamp((frac - 0.35) / 0.3);
      data.burn.forEach((c, k) => setOpacity(c, k === i ? 1 : k === i + 1 ? blend : 0));
      fNum.textContent = fmtNumber(burn.by_pass[at].burned_km2, 0);
      ticks.forEach((tk, k) => {
        tk.style.background = k <= at ? (k === at ? "#ff8070" : "var(--burn)") : "rgba(232, 238, 234, 0.16)";
      });
      fDate.textContent = fmtDate(burn.by_pass[at].date);
    }

    // Ground: the earthquake, then the sinking city.
    const gr = M.ground;
    const grA = shown(x, gr.a - XF, gr.b + XF, 0.4 + XF, 0.4 + XF);
    setOpacity(gnd, grA);
    if (grA > 0) {
      const lt = x - gr.a;
      setOpacity(gCopy, shown(x, gr.a, gr.b, 0.3, 0.3));
      showWords(gH, lt - 0.15);
      // The earthquake leaves before the sinking city arrives: the two numbers never share the
      // screen, so no paused frame can pair 70 cm with "a year".
      const sw = gr.d * 0.48;
      const gone = easeInOut(seg(lt, sw, sw + 0.3));
      const come = easeInOut(seg(lt, sw + 0.3, sw + 0.6));
      setOpacity(qStat, seg(lt, 0.5, 0.9) * (1 - gone));
      setOpacity(qBox, seg(lt, 0.2, 0.7) * (1 - gone));
      setOpacity(sStat, come);
      setOpacity(sBox, come);
      qBox.style.transform = `scale(${lerp(1.04, 1, easeOut(seg(lt, 0.2, gr.d * 0.5))).toFixed(4)})`;
      sBox.style.transform = `scale(${lerp(1.04, 1, easeOut(seg(lt, gr.d * 0.48, gr.d))).toFixed(4)})`;
    }

    // Ice: the speed map, then forty years of the trunk's speed drawn year by year.
    const ic = M.ice;
    const icA = ic.d ? shown(x, ic.a - XF, ic.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(icL, icA);
    if (icA > 0) {
      const lt = x - ic.a;
      setOpacity(icCopy, shown(x, ic.a, ic.b, 0.3, 0.3));
      showWords(icH, lt - 0.15);
      setOpacity(icStat, seg(lt, 0.6, 1.1));
      icFrame.style.transform = `scale(${lerp(1.04, 1, easeOut(seg(lt, 0, ic.d))).toFixed(4)})`;
      trunkSvg(easeInOut(seg(lt, 0.8, ic.d * 0.8)));
    }

    // Proof.
    const pr = M.proof;
    const prA = pr.d ? shown(x, pr.a - XF, pr.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(prf, prA);
    if (prA > 0) {
      const lt = x - pr.a;
      setOpacity(prWrap, shown(x, pr.a, pr.b, 0.3, 0.3));
      showWords(prH, lt - 0.15);
      const step = pr.d * 0.16;
      [p1, p2, p3].forEach((p, i) => setOpacity(p, easeOut(seg(lt, 0.4 + i * step, 0.8 + i * step))));
      riverSvg(easeInOut(seg(lt, 0.5, 0.5 + pr.d * 0.45)));
      fireBars(easeOut(seg(lt, 0.4 + step, 0.4 + step + pr.d * 0.3)));
      gpsBars(easeOut(seg(lt, 0.4 + 2 * step, 0.4 + 2 * step + pr.d * 0.3)));
    }

    // Limits, one line at a time.
    const lm = M.limits;
    const lmA = lm.d ? shown(x, lm.a - XF, lm.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(lim, lmA);
    if (lmA > 0) {
      const lt = x - lm.a;
      setOpacity(lmWrap, shown(x, lm.a, lm.b, 0.3, 0.3));
      showWords(lmH, lt - 0.15);
      lmRows.forEach((r, i) => setOpacity(r, easeOut(seg(lt, 0.7 + i * 0.55, 1.1 + i * 0.55))));
    }

    // Audiences: one beat each. Screens dissolve into each other; words leave before new words
    // arrive (only pictures dissolve, D-084).
    const au = M.audience;
    const auA = au.d ? shown(x, au.a - XF, au.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(aud, auA);
    if (auA > 0 && SHORT) {
      const lt = x - au.a;
      auPanels.forEach((p) => setOpacity(p.panel, 0));
      showWords(auGH, lt - 0.1);
      auTiles.forEach((tile, i) => {
        const f = easeOut(seg(lt, 0.15 + i * 0.12, 0.6 + i * 0.12));
        setOpacity(tile, f);
        tile.style.transform = `translateY(${((1 - f) * 30).toFixed(1)}px) scale(${lerp(0.96, 1, f).toFixed(4)})`;
      });
    } else if (auA > 0) {
      const beat = au.d / AUDIENCES.length;
      auPanels.forEach((p, i) => {
        const a = au.a + i * beat;
        const b = a + beat;
        const lt = x - a;
        const vis = shown(x, a - (i ? 0.35 : 0), b + (i < AUDIENCES.length - 1 ? 0.35 : 0), i ? 0.35 : 0.4, i < AUDIENCES.length - 1 ? 0.01 : 0.4);
        setOpacity(p.panel, vis);
        if (vis <= 0) return;
        setOpacity(p.fr, 1);
        p.img.style.transform = `scale(${lerp(1.0, 1.07, seg(x, a - 0.35, b + 0.35)).toFixed(4)})`;
        setOpacity(p.copy, shown(x, a + 0.05, b - 0.05, 0.3, 0.25));
        showWords(p.q, lt - 0.2);
        p.fs.forEach((c, k) => setOpacity(c, easeOut(seg(lt, 1.3 + k * 0.3, 1.6 + k * 0.3))));
      });
    }

    // Everything in it: the columns arrive left to right and stay, so any paused frame reads.
    const ix = M.index;
    const ixA = ix.d ? shown(x, ix.a - XF, ix.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(idx, ixA);
    if (ixA > 0) {
      const lt = x - ix.a;
      setOpacity(ixWrap, shown(x, ix.a, ix.b, 0.3, 0.3));
      showWords(ixH, lt - 0.15);
      const [ix0, ixStep] = SHORT ? [0.2, 0.08] : [0.5, 0.22];
      ixCols.forEach((c, i) => setOpacity(c, easeOut(seg(lt, ix0 + i * ixStep, ix0 + 0.35 + i * ixStep))));
    }

    // Where it can go next.
    const nx = M.next;
    const nxA = nx.d ? shown(x, nx.a - XF, nx.b + XF, 0.4 + XF, 0.4 + XF) : 0;
    setOpacity(nxt, nxA);
    if (nxA > 0) {
      const lt = x - nx.a;
      setOpacity(nxWrap, shown(x, nx.a, nx.b, 0.3, 0.3));
      showWords(nxH, lt - 0.15);
      nxRows.forEach((r, i) => setOpacity(r, easeOut(seg(lt, 0.6 + i * 0.4, 1.0 + i * 0.4))));
    }

    // Title: the mark draws itself (canopy, L, signal), the echo lands, then the name.
    const ti = M.title;
    const tiA = shown(x, ti.a - XF, ti.b + 1, 0.5 + XF, 0.01);
    setOpacity(ttl, tiA);
    if (tiA > 0) {
      const lt = x - ti.a;
      mark.parts.forEach((p, i) => p.setAttribute("stroke-dasharray", `${easeInOut(seg(lt, 0.05 + i * 0.16, 0.55 + i * 0.16)).toFixed(3)} 1`));
      const echo = easeOut(seg(lt, 0.95, 1.25));
      mark.echo.setAttribute("r", (2 * echo).toFixed(2));
      setOpacity(tName, easeOut(seg(lt, 0.3, 0.9)));
      tName.style.transform = `translateY(${((1 - easeOut(seg(lt, 0.3, 0.9))) * 24).toFixed(1)}px)`;
      setOpacity(tTag, easeOut(seg(lt, 0.7, 1.2)));
      setOpacity(tCta, easeOut(seg(lt, 1.0, 1.5)));
      setOpacity(tMeta, easeOut(seg(lt, 1.2, 1.7)));
    }

    setOpacity(bug, shown(x, zm.b, ti.a, 0.5, 0.4) * 0.9);
  }

  return { seek, duration, marks: M };
}

// Flood area and river level on one time axis, in two panels (never two y-scales on one plot).
function riverChart(parent, gauge) {
  const w = 520;
  const h = 272;
  const svg = sv("svg", { viewBox: `0 0 ${w} ${h}` }, parent);
  const days = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
  const stage = gauge.stage_daily.map(([d, m]) => [days(d), m]);
  const flood = gauge.series.map((p) => [days(p.date), p.flooded_km2]);
  const x0 = Math.min(stage[0][0], flood[0][0]);
  const x1 = Math.max(stage.at(-1)[0], flood.at(-1)[0]);
  const X = (d) => 8 + ((d - x0) / (x1 - x0)) * (w - 16);
  const panel = (pts, top, hh, colour, dotsOn) => {
    const v = pts.map((p) => p[1]);
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    const Y = (y) => top + hh - ((y - lo) / (hi - lo || 1)) * hh;
    sv("line", { x1: 0, x2: w, y1: top + hh + 8, y2: top + hh + 8, stroke: "rgba(232,238,234,0.14)", "stroke-width": 1 }, svg);
    const line = sv("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(""), fill: "none", stroke: colour, "stroke-width": 3, "stroke-linejoin": "round", "stroke-linecap": "round", pathLength: 1 }, svg);
    const marks = dotsOn ? pts.map((p) => sv("circle", { cx: X(p[0]), cy: Y(p[1]), r: 6, fill: colour, stroke: "#0b1214", "stroke-width": 2 }, svg)) : [];
    return { line, marks, pts };
  };
  const top = panel(stage, 34, 70, "#8fa3ad", false);
  const bottom = panel(flood, 160, 70, "#2b8fd6", true);
  const lab = (text, y) => {
    const e = sv("text", { x: 0, y, fill: "#a3b2ae", "font-size": 20 }, svg);
    e.textContent = text;
  };
  lab(t("film.chart_river"), 18);
  lab(t("film.chart_flood"), 146);
  const day = (d) => fmtDate(new Date(d * 86400000).toISOString().slice(0, 10), "short");
  const d0 = sv("text", { x: 0, y: 268, fill: "#a3b2ae", "font-size": 20 }, svg);
  d0.textContent = day(x0);
  const d1 = sv("text", { x: w, y: 268, fill: "#a3b2ae", "font-size": 20, "text-anchor": "end" }, svg);
  d1.textContent = day(x1);
  return (f) => {
    for (const p of [top, bottom]) {
      p.line.setAttribute("stroke-dasharray", `${f.toFixed(3)} 1`);
      p.marks.forEach((m, i) => m.setAttribute("opacity", f >= (X(p.pts[i][0]) - 8) / (w - 16) ? "1" : "0"));
    }
  };
}

// The glacier's main-trunk speed, one point a year from the index (ITS_LIVE), on a zero baseline;
// gaps stay gaps. Returns draw(f), f the share of the line drawn.
function trunkChart(parent, g) {
  const w = 760;
  const h = 210;
  const svg = sv("svg", { viewBox: `0 0 ${w} ${h}` }, parent);
  const pts = g.years.map((y, i) => [y, g.trunk[i]]);
  const max = Math.max(...pts.filter((p) => p[1] !== null).map((p) => p[1]));
  const y0 = g.years[0];
  const y1 = g.years.at(-1);
  const X = (y) => 8 + ((y - y0) / (y1 - y0)) * (w - 16);
  const Y = (v) => 40 + (1 - v / max) * (h - 80);
  sv("line", { x1: 0, x2: w, y1: Y(0), y2: Y(0), stroke: "rgba(232,238,234,0.14)", "stroke-width": 1 }, svg);
  // One labelled gridline gives the scale: the largest multiple of 5,000 m a year under the top.
  const tick = Math.floor(max / 5000) * 5000;
  if (tick > 0) {
    sv("line", { x1: 0, x2: w, y1: Y(tick), y2: Y(tick), stroke: "rgba(232,238,234,0.1)", "stroke-width": 1, "stroke-dasharray": "4 6" }, svg);
    const tl = sv("text", { x: w, y: Y(tick) - 8, fill: "#a3b2ae", "font-size": 18, "text-anchor": "end" }, svg);
    tl.textContent = fmtNumber(tick, 0);
  }
  const runs = [];
  let run = [];
  for (const p of pts) {
    if (p[1] === null) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length) runs.push(run);
  const lines = runs.map((r) => ({
    r,
    el: sv("path", { d: r.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join(""), fill: "none", stroke: "#a8d8ea", "stroke-width": 3.5, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg),
  }));
  const lab = (text, x, y, anchor = "start") => {
    const e = sv("text", { x, y, fill: "#a3b2ae", "font-size": 20, "text-anchor": anchor }, svg);
    e.textContent = text;
  };
  // A dot for every measured year, so a year between two gaps still shows.
  const dots = pts.filter((p) => p[1] !== null).map((p) => ({ p, el: sv("circle", { cx: X(p[0]).toFixed(1), cy: Y(p[1]).toFixed(1), r: 4.5, fill: "#a8d8ea", opacity: 0 }, svg) }));
  lab(t("film.chart_trunk"), 0, 20);
  lab(fmtYear(y0), 0, h - 4);
  lab(fmtYear(y1), w, h - 4, "end");
  return (f) => {
    // Reveal year by year: a run shows up to the year the sweep has reached.
    const until = y0 + f * (y1 - y0);
    for (const { r, el: e } of lines) {
      const shown = r.filter((p) => p[0] <= until);
      e.setAttribute("d", shown.length > 1 ? shown.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)} ${Y(p[1]).toFixed(1)}`).join("") : "");
    }
    for (const d of dots) d.el.setAttribute("opacity", d.p[0] <= until ? "1" : "0");
  };
}

// Two bars from one baseline, values at their tips.
function bars(parent, rows, fmt) {
  const w = 520;
  const rowH = 74;
  const svg = sv("svg", { viewBox: `0 0 ${w} ${rows.length * rowH + 6}` }, parent);
  const max = Math.max(...rows.map((r) => r[1]));
  const items = rows.map(([name, v, colour], i) => {
    const y = i * rowH;
    const label = sv("text", { x: 0, y: y + 22, fill: "#c9d4d0", "font-size": 22 }, svg);
    label.textContent = name;
    const bar = sv("rect", { x: 0, y: y + 34, height: 22, rx: 4, fill: colour, width: 0 }, svg);
    const val = sv("text", { x: 0, y: y + 52, fill: "#e8eeea", "font-size": 22, "font-weight": 600 }, svg);
    val.textContent = fmt(v);
    return { bar, val, full: (v / max) * (w - 150) };
  });
  return (f) => {
    for (const it of items) {
      const bw = Math.max(0, it.full * f);
      it.bar.setAttribute("width", bw.toFixed(1));
      it.val.setAttribute("x", (bw + 12).toFixed(1));
      it.val.setAttribute("opacity", f > 0.05 ? "1" : "0");
    }
  };
}

// ---------------------------------------------------------------- score cues

// Moments the soundtrack (tools/film/score.py) lands on: each scene, each number as it
// settles, and every radar pass of the fire.
function cues(film, data) {
  const M = film.marks;
  const out = [];
  for (const [id] of SCENES) if (M[id].d > 0) out.push({ t: +M[id].a.toFixed(3), kind: "scene", id });
  // The opening: water rising under the quote, a low toll on the number, the turn to NISAR.
  out.push({ t: 0.6, kind: "rumble", d: +(M.cold.d * 0.85).toFixed(3) });
  if (M.toll.d) out.push({ t: +(M.toll.a + 1.4).toFixed(3), kind: "toll" });
  out.push({ t: +M.hook.a.toFixed(3), kind: "turn" });
  if (M.season.d) out.push({ t: +(M.season.a + M.season.d * 0.55).toFixed(3), kind: "ping", note: 1 });
  if (M.places.d) out.push({ t: +(M.places.a + M.places.d * 0.45).toFixed(3), kind: "ping", note: 3 });
  if (M.ice.d) out.push({ t: +(M.ice.a + 0.6).toFixed(3), kind: "ping", note: 2 });
  if (M.audience.d) for (let i = 1; i < AUDIENCES.length; i++) out.push({ t: +(M.audience.a + (i * M.audience.d) / AUDIENCES.length).toFixed(3), kind: "pass", note: i * 2, gain: 0.8 });
  const ni = M.nisar;
  out.push({ t: +(ni.a + Math.min(0.3, ni.d * 0.08)).toFixed(3), kind: "swell" });
  out.push({ t: +(ni.a + Math.min(0.3, ni.d * 0.08) + Math.min(1.7, ni.d * 0.32) + 0.6).toFixed(3), kind: "ping", note: 0 });
  if (M.people.d) out.push({ t: +(M.people.a + M.people.d * 0.55).toFixed(3), kind: "ping", note: 2 });
  const fi = M.fire;
  const n = data.fire.products.burn.by_pass.length;
  const from = Math.max(0, data.fire.products.burn.by_pass.findIndex((p) => p.new_km2 > 0) - 1);
  for (let i = from + 1; i < n; i++) {
    // The moment pass i is shown: halfway from the pass before (inverse of the easeInOut in seek).
    const target = (i - 0.5 - from) / (n - 1 - from);
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (easeInOut(mid) < target - 1e-6) lo = mid;
      else hi = mid;
    }
    const at = fi.a + fi.d * 0.12 + hi * fi.d * 0.66;
    out.push({ t: +at.toFixed(3), kind: "pass", note: i, gain: data.fire.products.burn.by_pass[i].new_km2 > 0 ? 1 : 0.35 });
  }
  out.push({ t: +(M.ground.a + 0.6).toFixed(3), kind: "ping", note: 4 });
  out.push({ t: +(M.ground.a + M.ground.d * 0.48 + 0.45).toFixed(3), kind: "ping", note: 3 });
  out.push({ t: +(M.title.a + 0.3).toFixed(3), kind: "hit" });
  return out;
}

// ---------------------------------------------------------------- start

function fit(stage) {
  const k = Math.min(innerWidth / W, innerHeight / H);
  stage.style.transform = `translate(${((innerWidth - W * k) / 2).toFixed(1)}px, ${((innerHeight - H * k) / 2).toFixed(1)}px) scale(${k})`;
}

function previewControls(film) {
  const bar = el("div", "preview", document.body);
  const play = el("button", "", bar, t("film.play"));
  play.type = "button";
  const range = el("input", "", bar);
  Object.assign(range, { type: "range", min: 0, max: film.duration, step: 1 / FPS, value: 0 });
  range.setAttribute("aria-label", t("film.scrub"));
  const out = el("output", "", bar);
  let playing = false;
  let t0 = 0;
  let from = 0;
  const show = (x) => {
    film.seek(x);
    range.value = String(x);
    out.textContent = `${x.toFixed(1)} / ${film.duration.toFixed(1)} s`;
  };
  const tick = (now) => {
    if (!playing) return;
    const x = from + (now - t0) / 1000;
    if (x >= film.duration) {
      playing = false;
      play.textContent = t("film.play");
      show(film.duration);
      return;
    }
    show(x);
    requestAnimationFrame(tick);
  };
  play.addEventListener("click", () => {
    playing = !playing;
    play.textContent = t(playing ? "film.pause" : "film.play");
    if (playing) {
      from = Number(range.value) >= film.duration ? 0 : Number(range.value);
      t0 = performance.now();
      requestAnimationFrame(tick);
    }
  });
  range.addEventListener("input", () => {
    playing = false;
    play.textContent = t("film.play");
    show(Number(range.value));
  });
  show(0);
}

async function main() {
  const lang = LANGUAGES.includes(params.get("lang")) ? params.get("lang") : "en";
  await loadLocale(lang);
  document.documentElement.lang = language();
  document.title = t("film.page_title");
  const stage = document.getElementById("stage");
  stage.dataset.aspect = PORTRAIT ? "portrait" : "landscape";
  if (!RENDER) {
    fit(stage);
    addEventListener("resize", () => fit(stage));
  }
  await document.fonts.ready;
  const data = await loadData();
  const film = buildFilm(stage, data);
  film.seek(0);
  window.film = {
    ready: true,
    fps: FPS,
    width: W,
    height: H,
    duration: film.duration,
    seek: film.seek,
    cues: () => cues(film, data),
    // The frame the page shows before the film plays, and to people who ask for less motion.
    posterTime: film.duration - 0.05,
    // The two motion maps, on the landing page's surface colour, with their colour ranges.
    maps: () =>
      Object.fromEntries(
        ["quake", "sink"].map((k) => {
          const src = data[k].canvas;
          const c = document.createElement("canvas");
          c.width = src.width;
          c.height = src.height;
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#101a1d";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(src, 0, 0);
          return [k, { url: c.toDataURL("image/jpeg", 0.9), lo: data[k].lo, hi: data[k].hi, width: c.width, height: c.height }];
        }),
      ),
  };
  if (!RENDER) previewControls(window.film);
}

if (typeof document !== "undefined") {
  main().catch((err) => {
    console.error(err);
    window.film = { ready: false, error: String(err) };
  });
}
