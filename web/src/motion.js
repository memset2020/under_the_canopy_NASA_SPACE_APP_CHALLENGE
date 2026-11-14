// Ground that moved (F57, docs/14, docs/10 D-082): NISAR GUNW motion for an earthquake and a
// sinking city, built in the pipeline (canopy/motion.py). Every map is drawn here from the
// planes of motion.bin: a perceptually uniform colour scale with its histogram and the measured
// noise in the legend, fringes at any interval, relief under the colour, small multiples on one
// scale, the season frame by frame, and the values and time series at a clicked point (with a
// GNSS station's own series when the point is at one). Profiles and checks are their own cards
// (motionprofile.js, motionchecks.js); they share the loaded event through the store.
// Positive = toward the satellite (line of sight), up, or east.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { createModeBar } from "./modebar.js";
import { isTemporal, mwOf, shownLayer, splitPair, stepsOf, targetOf } from "./motionsteps.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import {
  autoRange,
  canFringe,
  cellsNear,
  cssColour,
  fitLine,
  hillshade,
  histogram,
  isSigned,
  layerData,
  medianAt,
  paint,
  paintHatch,
  planeIndex,
  planeValues,
  readBinary,
  toCanvas,
} from "./motionmaps.js";
import { factRow, setLead, setNote } from "./readable.js";
import { showNotebook } from "./notebook.js";

export const id = "motion";
export const slot = "sidebar";

export const MOTION_SCHEMA = 15;
const FRINGE_CHOICES = [null, "half", 5, 10, 20, 50]; // null = continuous; "half" = λ/2
const DAY = 86400000;

// ---------------------------------------------------------------- pure helpers (tested)

// Value (in the plane's unit) of plane k at flat index i, or null for no data.
export function planeValue(view, doc, k, i) {
  const q = view[k * doc.grid.width * doc.grid.height + i];
  return q === doc.nodata ? null : q * (doc.planes[k].scale ?? doc.scale_cm);
}

function geomParams(doc, key) {
  const g = doc.geometries.find((x) => x.key === key);
  return { track: g?.track ?? key, dir: g?.direction ?? "" };
}

// The layers a viewer can pick, in groups, most telling first. Ids are plane ids, residuals
// "resid:<data>:<model>", or "cum:<geometry>" (a geometry's total to the date on the slider).
export function layerChoices(doc) {
  const out = [];
  const share = (key) => doc.geometries.find((g) => g.key === key)?.measured_pct ?? 0;
  const byKind = (k) => doc.planes.filter((p) => p.kind === k).sort((a, b) => share(b.geometry) - share(a.geometry));
  const has = (pid) => planeIndex(doc, pid) >= 0;
  const push = (group, pid, key, geometry = null) => out.push({ id: pid, group, key, geometry, params: geometry ? geomParams(doc, geometry) : {} });
  if (doc.kind === "earthquake") {
    for (const p of [...byKind("east"), ...byKind("up")]) push("motion.group_motion", p.id, `motion.layer_${p.kind}`);
    for (const p of byKind("los")) push("motion.group_motion", p.id, "motion.layer_los", p.geometry);
    if (has("model_east")) {
      push("motion.group_model", "model_east", "motion.layer_model_east");
      push("motion.group_model", "model_up", "motion.layer_model_up");
    }
    for (const p of byKind("model_los")) push("motion.group_model", p.id, "motion.layer_model_los", p.geometry);
    if (has("model_east")) {
      push("motion.group_resid", "resid:east:model_east", "motion.layer_resid_east");
      push("motion.group_resid", "resid:up:model_up", "motion.layer_resid_up");
    }
    for (const p of byKind("model_los")) push("motion.group_resid", `resid:los_${p.geometry}:${p.id}`, "motion.layer_resid_los", p.geometry);
  } else {
    for (const p of [...byKind("rate_up"), ...byKind("rate_east")]) push("motion.group_speed", p.id, `motion.layer_${p.kind}`);
    for (const p of byKind("rate_los")) push("motion.group_speed", p.id, "motion.layer_rate_los", p.geometry);
    if (splitPair(doc)) {
      // Totals split from the two tracks date by date (motionsteps.js, D-091).
      push("motion.group_total", "total:up", "motion.layer_total_up");
      push("motion.group_total", "total:east", "motion.layer_total_east");
    }
    const geoms = [...new Set(byKind("cum").map((p) => p.geometry))];
    for (const g of geoms) push("motion.group_total", `cum:${g}`, "motion.layer_total", g);
    for (const p of byKind("sigma")) {
      const of = doc.planes.find((q) => q.id === p.of);
      push("motion.group_error", p.id, of?.geometry ? "motion.layer_sigma_los" : `motion.layer_sigma_${of?.kind.replace("rate_", "")}`, of?.geometry ?? null);
    }
  }
  for (const p of byKind("coherence")) push("motion.group_quality", p.id, "motion.layer_coherence", p.geometry);
  return out;
}

// The dated planes of a geometry's time series, in order.
export function datedPlanes(doc, geometry) {
  return doc.planes.filter((p) => p.kind === "cum" && p.geometry === geometry).sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The plane id a choice shows (a "cum:" choice resolves to the date on the slider).
// The 12-days-before-the-quake map of a layer (motion schema 15, D-090), or null.
export function beforeOf(doc, choiceId) {
  const id = choiceId === "east" ? "before_east" : choiceId === "up" ? "before_up" : choiceId.startsWith("los_") ? `before_${choiceId}` : null;
  return id && planeIndex(doc, id) >= 0 ? id : null;
}

// Whether a choice steps through time in the bar under the map: a series of dates, or before
// and across the quake.
export function hasSteps(doc, choiceId) {
  return Boolean(choiceId) && (choiceId.startsWith("cum:") || Boolean(beforeOf(doc, choiceId)));
}

export function resolveLayer(doc, choiceId, dateIdx) {
  if (!choiceId.startsWith("cum:")) return dateIdx === 0 && beforeOf(doc, choiceId) ? beforeOf(doc, choiceId) : choiceId;
  const ps = datedPlanes(doc, choiceId.slice(4));
  if (!ps.length) return null;
  const k = dateIdx === null || dateIdx === undefined ? ps.length - 1 : Math.max(0, Math.min(ps.length - 1, dateIdx));
  return ps[k].id;
}

// Cumulative line-of-sight motion at cells, per geometry, in date order (median of the cells).
export function seriesAt(doc, view, cells) {
  const out = new Map();
  doc.planes.forEach((p, k) => {
    if (p.kind !== "cum") return;
    if (!out.has(p.geometry)) out.set(p.geometry, []);
    const v = medianAt(planeValues(doc, view, k), cells);
    out.get(p.geometry).push({ date: p.date, cm: Number.isFinite(v) ? v : null });
  });
  for (const pts of out.values()) pts.sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

// Words for the two ends of a layer's colour scale.
export function scaleWords(kind) {
  if (/east/.test(kind)) return ["motion.west", "motion.east"];
  if (/up$/.test(kind)) return ["motion.down", "motion.up"];
  if (kind === "coherence") return ["motion.coh_low", "motion.coh_high"];
  if (kind === "sigma") return ["motion.sigma_low", "motion.sigma_high"];
  return ["motion.away", "motion.toward"];
}

// The group of a choice, and its siblings: small multiples show the group on one scale.
export function siblings(doc, choiceId) {
  const all = layerChoices(doc);
  const me = all.find((c) => c.id === choiceId);
  if (!me) return [];
  if (me.group === "motion.group_total") return me.geometry ? datedPlanes(doc, me.geometry).map((p, k) => ({ id: p.id, date: p.date, dateIdx: k })) : [];
  return all.filter((c) => c.group === me.group).map((c) => ({ id: c.id, choice: c }));
}

const unitWord = (t, unit) => (unit === "cm/yr" ? t("motion.cm_yr") : unit === "1" ? "" : unit);

// ---------------------------------------------------------------- the card

export function init({ store, map, t, root, dock }) {
  const heading = h("h2", { text: t("motion.title") });
  const lead = h("p", { class: "motion-lead" });
  const notebookLine = h("p", { class: "notebook-line", hidden: true }); // this event's notebook in Colab (D-098)
  const eventSel = h("select", { id: "motion-event" });
  const layerSel = h("select", { id: "motion-layer" });
  const styleSel = h("select", { id: "motion-style" });
  const rangeSel = h("select", { id: "motion-range" });
  const relief = h("input", { type: "checkbox", id: "motion-relief", checked: true });
  const legend = h("div", { class: "motion-legend" });
  const multiples = h("div", { class: "motion-multiples" });
  const point = h("div", { class: "motion-point", "aria-live": "polite" });
  const facts = h("ul", { class: "motion-facts rd-facts" });
  const note = h("p", { class: "muted small" });
  const ground = h("p", { class: "muted small" }); // GRACE-DA groundwater under a sinking city
  const table = h("div");
  root.append(
    heading,
    lead,
    notebookLine,
    h("h3", { text: t("motion.multiples") }),
    multiples,
    point,
    h("h3", { text: t("motion.geometries") }),
    facts,
    ground,
    note,
    table,
  );
  root.hidden = true;
  // The event is Ground's place: it stands in the header where the site list stands for a site.
  document.getElementById("site-select")?.after(h("label", { for: "motion-event", class: "sr-only", text: t("motion.event") }), eventSel);
  // What the map shows and how, in the map panel (dock.js): the layer with its key, then the drawing.
  dock.place("layer", h("div", { class: "dock-field" }, h("label", { class: "field" }, h("span", { text: t("motion.layer") }), layerSel), legend));
  dock.place(
    "display",
    h(
      "div",
      { class: "dock-field" },
      h(
        "div",
        { class: "motion-controls" },
        h("label", { class: "field" }, h("span", { text: t("motion.style") }), styleSel),
        h("label", { class: "field" }, h("span", { text: t("motion.range") }), rangeSel),
      ),
      h("label", { class: "check" }, relief, h("span", { text: t("motion.relief") })),
    ),
  );

  const canvas = h("canvas", { class: "overlay-motion", "aria-hidden": "true" });
  const hatch = h("canvas", { class: "overlay-motion-ref", "aria-hidden": "true" });
  const svg = s("svg", { class: "vector-layer motion-layer", "aria-hidden": "true" });
  map.panes.top.append(svg);

  let index = null;
  let shade = null; // hillshade of the event's heights
  let sea = null; // cells with no height above sea level (drawn clear when unmeasured)
  let ref = null; // the stable reference cells (hatched)
  let loading = false;

  const st = () => store.get();
  const bundle = () => st().motion;

  // ------------------------------------------------------------ loading

  async function loadEvent(entry) {
    const res = await fetch(`${st().dataBase}motion/${entry.path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    if (doc.schema_version !== MOTION_SCHEMA) throw new Error(`motion schema ${doc.schema_version}, expected ${MOTION_SCHEMA}`);
    const base = `${st().dataBase}motion/${entry.path.replace(/motion\.json$/, "")}`;
    const buf = await readBinary(base + doc.binary);
    if (buf.byteLength !== doc.planes.length * doc.grid.width * doc.grid.height * 2) throw new Error("motion binary has the wrong size");
    const view = new Int16Array(buf); // little-endian, as written by the pipeline
    // The rupture in time (USGS model frames, D-091), when the event has them.
    let rupture = null;
    if (doc.rupture) {
      const rb = await readBinary(base + doc.rupture.file);
      const { width: w2, height: h2 } = doc.rupture.grid;
      if (rb.byteLength === doc.rupture.times_s.length * 3 * w2 * h2 * 2) rupture = new Int16Array(rb);
      else console.error("motion: rupture frames have the wrong size");
    }
    const { width: W, height: H } = doc.grid;
    const kd = planeIndex(doc, "dem");
    shade = sea = ref = null;
    if (kd >= 0) {
      const dem = planeValues(doc, view, kd);
      shade = hillshade(dem, W, H, doc.grid.res_m);
      sea = Uint8Array.from(dem, (z) => (Number.isFinite(z) && z <= 0 ? 1 : 0));
      if (doc.reference.min_height_m !== undefined && doc.reference.min_height_m !== null) {
        ref = Uint8Array.from(dem, (z) => (z >= doc.reference.min_height_m ? 1 : 0));
      }
    }
    if (!ref) ref = boxMask(doc, doc.reference.bbox);
    const hp = paintHatch(ref, W, H);
    toCanvas(hp.rgba, hp.width, hp.height, hatch);
    const choices = layerChoices(doc);
    store.set({
      motion: { doc, view, id: doc.id, rupture },
      motionLayer: choices[0]?.id ?? null,
      motionDate: null,
      motionStyle: { fringe: null, range: "auto", relief: relief.checked },
      motionPick: null,
      motionProfile: doc.profiles?.[0] ? { ...doc.profiles[0] } : null,
    });
    if (st().mode === "motion") map.fitBounds(doc.grid.bounds);
  }

  function boxMask(doc, box) {
    const { width: W, height: H, bounds: [w, so, e, n] } = doc.grid;
    const out = new Uint8Array(W * H);
    for (let r = 0; r < H; r++) {
      const lat = n - ((r + 0.5) * (n - so)) / H;
      if (lat < box[1] || lat > box[3]) continue;
      for (let c = 0; c < W; c++) {
        const lon = w + ((c + 0.5) * (e - w)) / W;
        if (lon >= box[0] && lon <= box[2]) out[r * W + c] = 1;
      }
    }
    return out;
  }

  // ------------------------------------------------------------ the shown layer

  function current() {
    const b = bundle();
    if (!b || !st().motionLayer) return null;
    const choice = st().motionLayer;
    const temporal = isTemporal(b.doc, choice);
    const layer = temporal ? shownLayer(b, choice, st().motionDate) : layerData(b.doc, b.view, choice);
    if (!layer) return null;
    // Steps share one scale (the last step's: the last date, or the measured map across the
    // quake), so frames compare.
    const scaleLayer = temporal ? shownLayer(b, choice, null) : layer;
    const style = st().motionStyle ?? {};
    const fr = canFringe(layer) ? style.fringe : null;
    const fringe_cm = fr === "half" ? b.doc.half_wavelength_cm : fr;
    const range = style.range === "auto" || style.range === undefined ? autoRange(scaleLayer) : isSigned(layer.kind) ? [-style.range, style.range] : [0, style.range];
    return { layer, scaleLayer, lo: range[0], hi: range[1], fringe_cm, relief: style.relief !== false };
  }

  function draw() {
    const b = bundle();
    const cur = current();
    if (!b || !cur || st().mode !== "motion") {
      map.removeOverlay("motion");
      map.removeOverlay("motion-ref");
      return;
    }
    const { width: W, height: H } = b.doc.grid;
    const rgba = paint(cur.layer, W, H, { lo: cur.lo, hi: cur.hi, fringe_cm: cur.fringe_cm, shade: cur.relief ? shade : null, sea });
    toCanvas(rgba, W, H, canvas);
    map.addOverlay("motion", canvas, b.doc.grid.bounds);
    map.addOverlay("motion-ref", hatch, b.doc.grid.bounds);
    renderLegend(cur);
    renderMultiples(cur);
    renderTime();
    renderPoint();
    map.refresh();
  }

  function choiceLabel(c) {
    return t(c.key, { ...c.params, dir: c.params.dir ? t(`orbits.dir_${c.params.dir}`) : "" });
  }

  function fillSelectors() {
    const b = bundle();
    if (!b) return;
    const groups = new Map();
    for (const c of layerChoices(b.doc)) {
      if (!groups.has(c.group)) groups.set(c.group, h("optgroup", { label: t(c.group) }));
      groups.get(c.group).append(h("option", { value: c.id, text: choiceLabel(c) }));
    }
    layerSel.replaceChildren(...groups.values());
    layerSel.value = st().motionLayer ?? "";
    renderFacts();
    renderLead();
  }

  function fillStyle(cur) {
    const fringes = canFringe(cur.layer);
    const unit = unitWord(t, cur.layer.unit);
    styleSel.replaceChildren(
      ...FRINGE_CHOICES.filter((f) => f === null || fringes).map((f) =>
        h("option", {
          value: f === null ? "" : String(f),
          text: f === null ? t("motion.style_continuous") : f === "half" ? t("motion.style_half", { cm: fmtNumber(bundle().doc.half_wavelength_cm, 1) }) : t("motion.style_every", { cm: fmtNumber(f, 0) }),
        }),
      ),
    );
    const sf = st().motionStyle?.fringe;
    styleSel.value = sf === null || sf === undefined || !fringes ? "" : String(sf);
    styleSel.disabled = !fringes;
    const auto = autoRange(cur.scaleLayer ?? cur.layer); // the shared scale of a stepped layer
    const m = Math.max(Math.abs(auto[0]), Math.abs(auto[1]));
    const fixed = cur.layer.kind === "coherence" ? [] : [0.25, 0.5, 2, 4].map((f) => +(m * f).toPrecision(2));
    rangeSel.replaceChildren(
      h("option", { value: "auto", text: t("motion.range_auto", { v: `${isSigned(cur.layer.kind) ? "±" : "0–"}${fmtNumber(m, m < 10 ? 1 : 0)}`, unit }) }),
      ...fixed.map((v) => h("option", { value: String(v), text: `${isSigned(cur.layer.kind) ? "±" : "0–"}${fmtNumber(v, v < 10 ? 1 : 0)} ${unit}` })),
    );
    const r = st().motionStyle?.range;
    rangeSel.value = r === "auto" || r === undefined || !fixed.includes(r) ? "auto" : String(r);
    rangeSel.disabled = Boolean(cur.fringe_cm) || !fixed.length;
  }

  // ------------------------------------------------------------ legend

  function renderLegend(cur) {
    fillStyle(cur);
    const { layer, lo, hi, fringe_cm } = cur;
    const W = 320;
    const svgL = s("svg", { viewBox: `0 0 ${W} 86`, class: "motion-key", role: "img" });
    const M = { l: 12, r: 12 };
    const x = scale([lo, hi], [M.l, W - M.r]);
    const unit = unitWord(t, layer.unit);
    if (fringe_cm) {
      const steps = 64;
      for (let k = 0; k < steps; k++) {
        svgL.append(s("rect", { x: M.l + ((W - M.l - M.r) * k) / steps, y: 30, width: (W - M.l - M.r) / steps + 0.5, height: 14, fill: cssColour("romaO", k / steps) }));
      }
      svgL.append(
        s("text", { x: M.l, y: 60, class: "tick" }, "0"),
        s("text", { x: W - M.r, y: 60, class: "tick", "text-anchor": "end" }, `${fmtNumber(fringe_cm, Number.isInteger(fringe_cm) ? 0 : 1)} ${unit}`),
      );
      svgL.setAttribute("aria-label", t("motion.fringe_key", { cm: fmtNumber(fringe_cm, 1) }));
      legend.replaceChildren(svgL, h("p", { class: "muted small", text: t("motion.fringe_key", { cm: fmtNumber(fringe_cm, Number.isInteger(fringe_cm) ? 0 : 1) }) }));
      return;
    }
    const signed = isSigned(layer.kind);
    const mapName = signed ? "vik" : "batlow";
    const hist = histogram(layer.values, lo, hi, 48);
    const peak = Math.max(1, ...hist.counts);
    const bw = (W - M.l - M.r) / 48;
    // Noise band first, under the bars: values inside it cannot be told from no motion.
    const noise = layer.noise;
    if (signed && Number.isFinite(noise) && noise > 0 && 2 * noise < hi) {
      svgL.append(
        s("rect", { x: x(-2 * noise), y: 0, width: x(2 * noise) - x(-2 * noise), height: 44, class: "motion-noise" }),
        s("text", { x: x(0), y: 9, class: "tick", "text-anchor": "middle" }, t("motion.noise_band", { v: fmtNumber(2 * noise, 1) })),
      );
    }
    hist.counts.forEach((c, k) => {
      const hh = Math.sqrt(c / peak) * 18; // square root: the tails stay visible next to the peak
      svgL.append(s("rect", { x: M.l + k * bw + 0.5, y: 30 - hh, width: Math.max(0.5, bw - 1), height: hh, fill: cssColour(mapName, (k + 0.5) / 48) }));
    });
    for (let k = 0; k < 64; k++) {
      svgL.append(s("rect", { x: M.l + ((W - M.l - M.r) * k) / 64, y: 31, width: (W - M.l - M.r) / 64 + 0.5, height: 12, fill: cssColour(mapName, (k + 0.5) / 64) }));
    }
    // Arrow ends when values run past the scale, with their share.
    const pct = (n) => (hist.n ? (100 * n) / hist.n : 0);
    if (pct(hist.below) >= 0.1) svgL.append(s("path", { d: `M${M.l - 1},31 L${M.l - 9},37 L${M.l - 1},43 Z`, fill: cssColour(mapName, 0) }));
    if (pct(hist.above) >= 0.1) svgL.append(s("path", { d: `M${W - M.r + 1},31 L${W - M.r + 9},37 L${W - M.r + 1},43 Z`, fill: cssColour(mapName, 1) }));
    for (const v of ticks(lo, hi, 4)) {
      svgL.append(s("line", { x1: x(v), x2: x(v), y1: 43, y2: 47, class: "grid" }), s("text", { x: x(v), y: 60, class: "tick", "text-anchor": "middle" }, fmtNumber(v, Math.abs(hi - lo) < 4 ? 1 : 0)));
    }
    const [negW, posW] = scaleWords(layer.kind === "resid" ? layer.base : layer.kind);
    svgL.append(
      s("text", { x: M.l, y: 78, class: "tick" }, signed ? t(negW) : t("motion.low")),
      s("text", { x: W / 2, y: 78, class: "tick", "text-anchor": "middle" }, unit),
      s("text", { x: W - M.r, y: 78, class: "tick", "text-anchor": "end" }, signed ? t(posW) : t("motion.high")),
    );
    svgL.setAttribute("aria-label", t("motion.key_aria", { lo: fmtNumber(lo, 1), hi: fmtNumber(hi, 1), unit }));
    const notes = [];
    const beyond = pct(hist.below) + pct(hist.above);
    if (beyond >= 0.1) notes.push(t("motion.key_beyond", { pct: fmtNumber(beyond, beyond < 1 ? 1 : 0) }));
    notes.push(t(keyNote(layer)));
    if (shade) notes.push(t("motion.key_relief"));
    legend.replaceChildren(svgL, h("p", { class: "muted small", text: notes.join(" ") }));
  }

  function keyNote(layer) {
    if (layer.kind === "coherence") return "motion.key_coherence";
    if (layer.kind === "sigma") return "motion.key_sigma";
    if (layer.kind === "resid") return "motion.key_resid";
    if (layer.kind.startsWith("model")) return "motion.key_model";
    if (layer.kind.startsWith("rate")) return "motion.key_rate";
    return "motion.key_motion";
  }

  // ------------------------------------------------------------ small multiples and time

  let multiplesKey = "";
  function renderMultiples(cur) {
    const b = bundle();
    const sibs = siblings(b.doc, st().motionLayer);
    const key = `${b.doc.id}|${st().motionLayer}|${cur.lo}|${cur.hi}|${cur.fringe_cm}|${cur.relief}`;
    if (key !== multiplesKey) {
      multiplesKey = key;
      const { width: W, height: H } = b.doc.grid;
      multiples.replaceChildren(
        ...sibs.map((sb) => {
          const layer = layerData(b.doc, b.view, resolveLayer(b.doc, sb.id, null));
          const thumb = toCanvas(paint(layer, W, H, { lo: cur.lo, hi: cur.hi, fringe_cm: canFringe(layer) ? cur.fringe_cm : null, shade: cur.relief ? shade : null, sea }), W, H);
          const label = sb.date ? fmtDate(sb.date, "short") : choiceLabel(sb.choice);
          const btn = h("button", { type: "button", class: "motion-thumb", "data-id": sb.id, title: label }, thumb, h("span", { text: sb.date ? label : shortLabel(sb.choice) }));
          btn.addEventListener("click", () => {
            stopPlay();
            if (sb.date) store.set({ motionDate: sb.dateIdx });
            else store.set({ motionLayer: sb.id, motionStyle: { ...st().motionStyle, range: "auto" } });
          });
          return btn;
        }),
      );
    }
    const shown = resolveLayer(b.doc, st().motionLayer, st().motionDate);
    for (const el of multiples.children) el.setAttribute("aria-pressed", String(el.dataset.id === shown || el.dataset.id === st().motionLayer));
    multiples.dataset.count = String(sibs.length);
  }

  function shortLabel(c) {
    if (c.geometry) return `${geomParams(bundle().doc, c.geometry).track} ${t(`orbits.dir_${geomParams(bundle().doc, c.geometry).dir}`)}`;
    return t(`${c.key}_short`);
  }

  // The season frame by frame, in the bar under the map where every mode keeps its play
  // control (modebar.js, D-089). Each date's bar: how far the fastest-sinking 5 % of the
  // measured ground had moved by then (5th percentile of the total, toward the satellite +).
  const bar = createModeBar({ t, ariaLabel: t("motion.time_aria") });
  document.getElementById("slot-map-bottom")?.append(bar.el);
  // A layer that does not change in time plays its event's main motion: the bar switches to it.
  bar.onChange((k) => {
    const b = bundle();
    if (!b) return;
    const choice = st().motionLayer;
    if (isTemporal(b.doc, choice)) store.set({ motionDate: k });
    else store.set({ motionLayer: targetOf(b.doc, choice), motionDate: k, motionStyle: { ...st().motionStyle, range: "auto" } });
  });
  const stopPlay = () => bar.stop();
  let barKey = "";
  let shownStep = null; // the step on the map (for the rupture drawn on the fault)

  function renderTime() {
    const b = bundle();
    const on = Boolean(b) && st().mode === "motion";
    // The bar takes height from the map: frame the event again when it comes or goes.
    if (bar.show(on) && b && on) requestAnimationFrame(() => map.fitBounds(b.doc.grid.bounds));
    shownStep = null;
    if (!on) return;
    const choice = st().motionLayer ?? "";
    const target = targetOf(b.doc, choice);
    const steps = stepsOf(b, target);
    if (!steps.length) return bar.show(false);
    const temporal = isTemporal(b.doc, choice);
    const last = steps.length - 1;
    const idx = temporal ? Math.min(last, st().motionDate ?? last) : last;
    const key = `${b.doc.id}|${target}|${temporal}`;
    if (key !== barKey) {
      barKey = key;
      bar.setSteps(stepLabels(b, target, steps, temporal), idx);
    } else bar.setIndex(idx);
    shownStep = temporal ? steps[idx] : null;
  }

  // Words for each step; a layer that does not move in time says what Play will show.
  function stepLabels(b, target, steps, temporal) {
    const { doc } = b;
    const g = target.startsWith("los_") ? doc.geometries.find((x) => x.key === target.slice(4)) : null;
    const gs = g ? [g] : doc.geometries.filter((x) => x.control);
    const span = (pick) => ({ start: fmtDate(gs.map((x) => pick(x)[0]).sort()[0]), end: fmtDate(gs.map((x) => pick(x)[1]).sort().at(-1)) });
    const first = steps.find((x) => x.date)?.date;
    const playsWhat = temporal ? "" : `${t("motion.plays", { layer: choiceLabel(layerChoices(doc).find((c) => c.id === target) ?? { key: "motion.layer_east", params: {} }) })} `;
    return steps.map((st0) => {
      let label;
      let short;
      let caption;
      if (st0.type === "before") {
        label = t("motion.step_before");
        short = t("motion.step_before_short");
        caption = t("motion.step_before_cap", span((x) => [x.control?.start ?? x.start, x.control?.end ?? x.start]));
      } else if (st0.type === "across") {
        label = t("motion.step_across");
        short = t("motion.step_across_short");
        caption = t("motion.step_across_cap", span((x) => [x.start, x.end]));
      } else if (st0.type === "model") {
        label = t("motion.step_rupture", { s: fmtNumber(st0.time_s, 0) });
        short = `${fmtNumber(st0.time_s, 0)} s`;
        const mw = mwOf(st0.cumulative_nm);
        caption = st0.time_s === 0 ? t("motion.step_rupture_start") : t("motion.step_rupture_cap", { mw: mw === null ? "–" : fmtNumber(mw, 1) });
      } else {
        label = fmtDate(st0.date);
        short = fmtDate(st0.date, "short");
        caption = t("motion.time_label", { start: fmtDate(first), date: fmtDate(st0.date) });
      }
      return { label, short, caption: playsWhat + caption, height: st0.height, kind: st0.type };
    });
  }

  // ------------------------------------------------------------ text

  function renderLead() {
    const { doc } = bundle();
    const hl = doc.headline;
    if (doc.kind === "earthquake") {
      const q = [...doc.quakes].sort((a, b) => b.mag - a.mag)[0];
      setLead(lead, hl.east_p01_cm !== undefined
        ? t("motion.lead_quake", { mag: fmtNumber(q.mag, 1), date: fmtDate(doc.quakes[0].utc.slice(0, 10)), west: fmtNumber(Math.abs(hl.east_p01_cm), 0), east: fmtNumber(hl.east_p99_cm, 0), n: doc.geometries.length })
        : t("motion.lead_quake_los", { mag: fmtNumber(q.mag, 1), n: doc.geometries.length }));
    } else {
      setLead(lead, hl.up_p01_cm_yr !== undefined
        ? t("motion.lead_sinking", {
            rate: fmtNumber(Math.abs(hl.up_p01_cm_yr), 0),
            km2: fmtNumber(hl.sinking_10cm_yr_km2, 0),
            km2_2: fmtNumber(hl.sinking_20cm_yr_km2, 0),
            sigma: fmtNumber(hl.sigma_up_median_cm_yr, 1),
            start: fmtDate(doc.geometries[0].start),
            end: fmtDate(doc.geometries[0].end),
          })
        : t("motion.lead_sinking_los"));
    }
  }

  function renderFacts() {
    const { doc } = bundle();
    facts.replaceChildren(
      // One radar geometry per row (readable.js, D-093).
      ...doc.geometries.map((g) =>
        factRow("satellite", t(doc.kind === "earthquake" ? "motion.geom_quake" : "motion.geom_chain", {
            track: g.track,
            dir: t(`orbits.dir_${g.direction}`),
            start: fmtDate(g.start),
            end: fmtDate(g.end),
            angle: fmtNumber(g.incidence_deg, 0),
            coh: g.coherence_median === null ? "–" : fmtNumber(g.coherence_median, 2),
            pct: fmtNumber(g.measured_pct, 0),
            noise: g.control?.noise_cm ? fmtNumber(g.control.noise_cm, 1) : "–",
            spread: g.stable_rate_spread_cm_yr !== undefined ? fmtNumber(g.stable_rate_spread_cm_yr, 1) : "–",
            n: g.pairs ?? (g.dates ? g.dates.length - 1 : 1),
          })),
      ),
    );
    setNote(note, "limit", t(doc.kind === "earthquake" ? "motion.note_quake" : "motion.note_sinking", { ref: doc.reference.label, coh: fmtNumber(doc.min_coherence, 1) }));
    renderGround();
    table.replaceChildren(
      srTable(
        t("motion.geometries"),
        [t("motion.col_track"), t("chart.col_date"), t("motion.col_angle"), t("motion.col_coherence")],
        doc.geometries.map((g) => [`${g.track} ${t(`orbits.dir_${g.direction}`)}`, `${fmtDate(g.start)} – ${fmtDate(g.end)}`, `${fmtNumber(g.incidence_deg, 0)}°`, g.coherence_median === null ? "–" : fmtNumber(g.coherence_median, 2)]),
      ),
    );
  }

  // Context, not cause: the world grid's GRACE-DA groundwater percentile at the event's centre.
  function renderGround() {
    setNote(ground, "info", "");
    const g = st().global;
    const b = bundle();
    if (!b || b.doc.kind !== "subsidence" || !g) return;
    const [w, so, e, n] = b.doc.grid.bounds;
    const p = g.cell((w + e) / 2, (so + n) / 2).values.groundwater_pctile;
    if (p === null || p === undefined) return;
    setNote(ground, "info", t("motion.groundwater", { p: fmtNumber(p, 0), week: fmtDate(g.meta.groundwater_week) }));
  }

  // ------------------------------------------------------------ a point

  function renderPoint() {
    point.replaceChildren();
    const b = bundle();
    const pick = st().motionPick;
    if (!b) return;
    if (!pick) {
      point.append(h("p", { class: "muted small", text: t("motion.click") }));
      return;
    }
    const { doc, view } = b;
    const cells = cellsNear(doc.grid, pick.lon, pick.lat, doc.grid.res_m * 1.5);
    const rows = [];
    const sigmaOf = (pid) => {
      const k = doc.planes.findIndex((p) => p.kind === "sigma" && p.of === pid);
      return k >= 0 ? medianAt(planeValues(doc, view, k), cells) : NaN;
    };
    const wanted = doc.kind === "earthquake" ? ["east", "up", "los"] : ["rate_up", "rate_east", "rate_los"];
    for (const kind of wanted) {
      for (const p of doc.planes.filter((q) => q.kind === kind)) {
        const k = planeIndex(doc, p.id);
        const v = medianAt(planeValues(doc, view, k), cells);
        const label = p.geometry ? t("motion.at_geom", { track: geomParams(doc, p.geometry).track, dir: t(`orbits.dir_${geomParams(doc, p.geometry).dir}`) }) : t(`motion.layer_${p.kind}_short`);
        if (!Number.isFinite(v)) {
          rows.push(h("li", { text: t("motion.at_none", { label }) }));
          continue;
        }
        const [neg, pos] = scaleWords(p.kind);
        const sig = p.kind.startsWith("rate") ? sigmaOf(p.id) : p.noise;
        const parts = { label, cm: fmtNumber(Math.abs(v), 1), dir: t(v >= 0 ? pos : neg), unit: unitWord(t, p.unit), pm: Number.isFinite(sig) ? fmtNumber(sig, 1) : "–" };
        let text = t("motion.at_value", parts);
        const mk = planeIndex(doc, `model_${p.kind === "los" ? `los_${p.geometry}` : p.kind}`);
        if (mk >= 0) {
          const m = medianAt(planeValues(doc, view, mk), cells);
          if (Number.isFinite(m)) text += ` ${t("motion.at_model", { model: fmtNumber(m, 1), resid: fmtNumber(v - m, 1) })}`;
        }
        if (Number.isFinite(sig) && Math.abs(v) < 2 * sig) text += ` ${t("motion.at_within")}`;
        rows.push(h("li", { text }));
      }
    }
    const lat = `${fmtNumber(Math.abs(pick.lat), 3)}°${pick.lat >= 0 ? "N" : "S"}`;
    const lon = `${fmtNumber(Math.abs(pick.lon), 3)}°${pick.lon >= 0 ? "E" : "W"}`;
    point.append(h("h3", { text: t("motion.at_title", { lat, lon }) }), h("p", { class: "muted small", text: t("motion.at_cells", { m: fmtNumber(doc.grid.res_m * 1.5, 0) }) }), h("ul", { class: "motion-values" }, rows));
    if (doc.kind === "subsidence") point.append(seriesChart(seriesAt(doc, view, cells), stationAt(pick)));
  }

  // A GNSS station with a series over the radar's window within 500 m of the point.
  function stationAt(pick) {
    const list = bundle()?.doc.gnss ?? [];
    for (const g of list) {
      if (g.period !== "same" || !g.series) continue;
      const dx = (g.lon - pick.lon) * 111320 * Math.cos((pick.lat * Math.PI) / 180);
      const dy = (g.lat - pick.lat) * 110574;
      if (Math.hypot(dx, dy) <= 500) return g;
    }
    return null;
  }

  // One line per geometry on one axis (cm toward the satellite) with its fitted speed; a GNSS
  // station's daily positions projected on each line of sight, from the same first date.
  function seriesChart(series, station) {
    const { doc } = bundle();
    const W = 340;
    const H = 190;
    const M = { l: 40, r: 12, t: 12, b: 26 };
    const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
    const wrap = h("div", { class: "motion-series" });
    const all = [...series.values()].flat().filter((d) => d.cm !== null);
    if (!all.length) {
      wrap.append(h("p", { class: "muted small", text: t("motion.series_none") }));
      return wrap;
    }
    const gnssLines = new Map();
    if (station) {
      for (const g of doc.geometries) {
        const pts = series.get(g.key);
        if (!pts?.length) continue;
        const [le, ln, lu] = g.los_enu;
        const t0 = pts[0].date;
        const base = station.series.filter((r) => Math.abs(day(r[0]) - day(t0)) <= 3 * DAY);
        if (!base.length) continue;
        const b0 = base.reduce((a, r) => a + le * r[1] + ln * r[2] + lu * r[3], 0) / base.length;
        gnssLines.set(g.key, station.series.filter((r) => r[0] >= t0).map((r) => ({ date: r[0], cm: le * r[1] + ln * r[2] + lu * r[3] - b0 })));
      }
    }
    const every = [...all, ...[...gnssLines.values()].flat()];
    const t0 = Math.min(...every.map((d) => day(d.date)));
    const t1 = Math.max(...every.map((d) => day(d.date)), t0 + DAY);
    const lo = Math.min(0, ...every.map((d) => d.cm));
    const hi = Math.max(0, ...every.map((d) => d.cm));
    const x = scale([t0, t1], [M.l, W - M.r]);
    const y = scale([lo - 0.5, hi + 0.5], [H - M.b, M.t]);
    const svgc = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "area-chart motion-chart", role: "img", "aria-label": t("motion.series_aria") });
    for (const v of ticks(lo, hi, 4)) {
      svgc.append(s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)));
    }
    const colours = ["#e8eeea", "#f08a4b"];
    const rows = [];
    const keyItems = [];
    [...series.entries()].forEach(([key, pts], k) => {
      const col = colours[k % 2];
      const gl = gnssLines.get(key);
      if (gl) {
        for (const d of gl) svgc.append(s("circle", { cx: x(day(d.date)).toFixed(1), cy: y(d.cm).toFixed(1), r: 1.4, fill: col, opacity: 0.35 }));
      }
      const good = pts.filter((d) => d.cm !== null);
      if (good.length < 2) return;
      const fit = fitLine(good.map((d) => (day(d.date) - t0) / DAY), good.map((d) => d.cm));
      if (fit) {
        const xa = (day(good[0].date) - t0) / DAY;
        const xb = (day(good.at(-1).date) - t0) / DAY;
        svgc.append(s("line", { x1: x(t0 + xa * DAY), y1: y(fit.intercept + fit.slope * xa), x2: x(t0 + xb * DAY), y2: y(fit.intercept + fit.slope * xb), stroke: col, "stroke-width": 1.5, "stroke-dasharray": "5 3", opacity: 0.8 }));
      }
      svgc.append(s("path", { d: `M${good.map((d) => `${x(day(d.date)).toFixed(1)},${y(d.cm).toFixed(1)}`).join("L")}`, class: "motion-line", stroke: col }));
      for (const d of good) svgc.append(s("circle", { cx: x(day(d.date)).toFixed(1), cy: y(d.cm).toFixed(1), r: 3, fill: col, stroke: "#0b1214", "stroke-width": 1 }));
      const g = geomParams(doc, key);
      const speed = fit ? fit.slope * 365.25 : NaN;
      keyItems.push(h("li", {}, h("span", { class: "swatch", style: `background:${col}` }), t("motion.series_key", { track: g.track, dir: t(`orbits.dir_${g.dir}`), v: fmtNumber(speed, 1) })));
      for (const d of good) rows.push([`${g.track}`, fmtDate(d.date), fmtNumber(d.cm, 1)]);
    });
    svgc.append(
      s("text", { x: M.l, y: H - 6, class: "tick" }, fmtDate(new Date(t0).toISOString().slice(0, 10), "short")),
      s("text", { x: W - M.r, y: H - 6, class: "tick", "text-anchor": "end" }, fmtDate(new Date(t1).toISOString().slice(0, 10), "short")),
    );
    if (station) keyItems.push(h("li", {}, h("span", { class: "swatch dots" }), t("motion.series_gnss", { id: station.id })));
    wrap.append(h("p", { class: "muted small", text: t("motion.series_lead") }), svgc, h("ul", { class: "motion-series-key" }, keyItems), srTable(t("motion.series_aria"), [t("motion.col_track"), t("chart.col_date"), "cm"], rows));
    return wrap;
  }

  // ------------------------------------------------------------ map vectors

  map.onRender((m) => {
    const [w, hgt] = m.size();
    svg.setAttribute("width", w);
    svg.setAttribute("height", hgt);
    svg.replaceChildren();
    const b = bundle();
    if (!b || st().mode !== "motion") return;
    const { doc } = b;
    const path = (ring, close) => `M${ring.map(([lon, lat]) => m.project(lon, lat).map((v) => v.toFixed(1)).join(",")).join("L")}${close ? "Z" : ""}`;
    for (const ring of doc.fault ?? []) svg.append(s("path", { d: path(ring, true), class: "motion-fault" }));
    for (const line of doc.model?.trace ?? []) svg.append(s("path", { d: path(line, false), class: "motion-trace" }));
    for (const q of doc.quakes ?? []) {
      const [qx, qy] = m.project(q.lon, q.lat);
      const r = 4 + (q.mag - 6) * 4;
      const star = Array.from({ length: 10 }, (_, k) => {
        const a = (Math.PI / 5) * k - Math.PI / 2;
        const rr = k % 2 ? r * 0.45 : r;
        return `${(qx + rr * Math.cos(a)).toFixed(1)},${(qy + rr * Math.sin(a)).toFixed(1)}`;
      }).join(" ");
      svg.append(s("polygon", { points: star, class: "motion-quake" }, s("title", {}, t("motion.quake_tip", { mag: fmtNumber(q.mag, 1), place: q.place, utc: q.utc.slice(11, 16) }))));
    }
    // During the rupture frames, the subfaults slipping at that moment light up (orange) and
    // those that have finished are outlined: the rupture running along the fault (D-091).
    if (shownStep?.type === "model" && doc.model?.patches) {
      const tt = shownStep.time_s;
      for (const p of doc.model.patches) {
        if (!(p.slip_m > 0.05) || tt < p.trup_s) continue;
        const slipping = tt < p.trup_s + p.rise_s;
        svg.append(s("path", { d: path(p.ring, true), class: slipping ? "rupture-patch is-slipping" : "rupture-patch" }));
      }
    }
    const pick = st().motionPick;
    if (pick) {
      const [px, py] = m.project(pick.lon, pick.lat);
      svg.append(s("circle", { cx: px, cy: py, r: 6, class: "motion-pick" }));
    }
  });

  map.on("click", ([lon, lat]) => {
    const b = bundle();
    if (st().mode !== "motion" || !b || st().tool || st().motionDraw) return;
    const [w, so, e, n] = b.doc.grid.bounds;
    const inside = lon >= w && lon <= e && lat >= so && lat <= n;
    store.set({ motionPick: inside ? { lon, lat } : null });
  });

  // ------------------------------------------------------------ controls

  eventSel.addEventListener("change", async () => {
    const entry = index.events.find((e) => e.id === eventSel.value);
    // The event on screen already: a reload would reset the layer and the bar mid-play.
    if (!entry || bundle()?.id === entry.id) return;
    stopPlay();
    try {
      await loadEvent(entry);
    } catch (err) {
      console.error("motion event did not load", err);
    }
  });
  layerSel.addEventListener("change", () => {
    stopPlay();
    store.set({ motionLayer: layerSel.value, motionDate: null, motionStyle: { ...st().motionStyle, range: "auto" } });
  });
  styleSel.addEventListener("change", () => {
    const v = styleSel.value;
    store.set({ motionStyle: { ...st().motionStyle, fringe: v === "" ? null : v === "half" ? "half" : Number(v) } });
  });
  rangeSel.addEventListener("change", () => {
    const v = rangeSel.value;
    store.set({ motionStyle: { ...st().motionStyle, range: v === "auto" ? "auto" : Number(v) } });
  });
  relief.addEventListener("change", () => store.set({ motionStyle: { ...st().motionStyle, relief: relief.checked } }));

  watch(store, ["motion"], () => {
    multiplesKey = "";
    if (bundle()) fillSelectors();
  });
  watch(store, ["motion", "motionLayer", "motionDate", "motionStyle", "motionPick"], () => {
    if (bundle()) layerSel.value = st().motionLayer ?? "";
    draw();
  });
  watch(store, ["global"], () => renderGround());
  watch(store, ["motion"], ({ motion, dataBase }) => {
    if (motion?.id) showNotebook(notebookLine, dataBase, "ground", motion.id, t);
  });
  watch(store, ["manifest", "mode"], async ({ manifest, mode, dataBase }) => {
    if (manifest?.motion && !index) {
      try {
        const res = await fetch(`${dataBase}${manifest.motion}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        index = await res.json();
        eventSel.replaceChildren(...index.events.map((e) => h("option", { value: e.id, text: e.name })));
      } catch (err) {
        console.error("motion index did not load", err);
        index = { events: [] };
      }
    }
    // The event (a few MB to unzip, relief to compute) loads only when Ground mode opens, so the
    // other modes start as fast as before.
    if (mode === "motion" && index?.events.length && !bundle() && !loading) {
      loading = true;
      try {
        await loadEvent(index.events.find((e) => e.id === eventSel.value) ?? index.events[0]);
      } catch (err) {
        console.error("motion event did not load", err);
      } finally {
        loading = false;
      }
    }
    const now = st().mode;
    root.hidden = now !== "motion" || !bundle();
    if (now !== "motion") bar.show(false);
    if (now === "motion" && bundle()) map.fitBounds(bundle().doc.grid.bounds);
    draw();
  });
}
