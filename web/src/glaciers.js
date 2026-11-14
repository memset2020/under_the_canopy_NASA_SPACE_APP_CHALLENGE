// Glacier atlas (F61, docs/16, docs/10 D-086): how the world's glaciers flow and how that changed,
// from NASA data. Ice mode. Built in the pipeline (canopy/glaciers.py); this module draws:
// the atlas (every glacier as a tile with its speed history), and for the glacier picked: its
// flow on the map (ITS_LIVE 2014-2024 speed in a log ice ramp with particles drifting along the
// measured flow), how it changed (trend, season, year by year 1985-2024), speed along the
// glacier through the years (a time-distance diagram), the trunk's speed against speeds others
// published, the region's mass from GRACE / GRACE-FO, and NISAR's coverage. Speeds are m/yr.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtNumber, fmtYear } from "./i18n.js";
import {
  cellAt,
  decodePlanes,
  extendFlow,
  fillSurface,
  SURFACE_COLOURS,
  humanSpeed,
  iceLut,
  logScale,
  logTicks,
  monthOfDay,
  paintPlane,
  perDay,
  rampColour,
  respawn,
  seedCells,
  speedRange,
  stepParticles,
  trendRange,
  trunkChange,
} from "./glaciermaps.js";
import { hillshade, readBinary, toCanvas } from "./motionmaps.js";
import { createModeBar } from "./modebar.js";
import { checkRow, fillCheck, leadP, more, note, setLead, setNote, tiles } from "./readable.js";
import { showNotebook } from "./notebook.js";
import { sourceFlags } from "./sourceflags.js";
import { SOURCES } from "./sources-registry.js";

export const id = "glaciers";
export const slot = "sidebar";
export const GLACIER_SCHEMA = 1;

export const LAYERS = ["speed", "trend", "season", "year"];
export const DEFAULT_GLACIER = "jakobshavn";
const RELIEF = "ASTER_GDEM_Greyscale_Shaded_Relief";
// Region order and the RGI first-order regions each ITS_LIVE mosaic stands for.
export const REGION_ORDER = ["05A", "19A", "01A", "02A", "06A", "07A", "09A", "11A", "14A", "17A", "18A"];

// ---------------------------------------------------------------- pure helpers (tested)

// Index entries grouped by region, in REGION_ORDER.
export function byRegion(items) {
  const groups = new Map(REGION_ORDER.map((r) => [r, []]));
  for (const it of items) {
    if (!groups.has(it.region)) groups.set(it.region, []);
    groups.get(it.region).push(it);
  }
  return [...groups].filter(([, list]) => list.length);
}

// Sparkline path of a series (nulls break the line) in a w × h box, scaled to its own maximum.
export function sparkPath(values, w, h, pad = 2) {
  const vals = values.filter((v) => v !== null && v !== undefined);
  if (vals.length < 2) return "";
  const top = Math.max(...vals);
  const x = (i) => pad + (i / Math.max(1, values.length - 1)) * (w - 2 * pad);
  const y = (v) => h - pad - (v / top) * (h - 2 * pad);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

// Least-squares slope of y over x (nulls skipped); null with fewer than 3 points.
export function slope(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => y !== null && y !== undefined && Number.isFinite(y));
  if (pts.length < 3) return null;
  const mx = pts.reduce((a, [x]) => a + x, 0) / pts.length;
  const my = pts.reduce((a, [, y]) => a + y, 0) / pts.length;
  const sxx = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
  return sxx ? pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / sxx : null;
}

// A speed as text: "10.6 km a year" or "740 m a year".
export function speedText(t, mYr) {
  const hs = humanSpeed(mYr);
  if (!hs) return "–";
  return t(`glaciers.unit_${hs[1]}`, { v: fmtNumber(hs[0], hs[2]) });
}

// ---------------------------------------------------------------- feature

export function init({ store, map, t, root, dock }) {
  root.hidden = true;
  let index = null;
  let doc = null;
  let planes = null;
  let relief = null; // hillshade of the glacier's box
  let layer = "speed";
  let yearIdx = 0;
  let animate = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  let loadToken = 0;

  // ---------------- DOM: atlas
  const atlasHead = h("h2", { text: t("glaciers.title") });
  const atlasLead = h("p", { class: "glacier-lead" });
  const atlasGrid = h("div", { class: "atlas-grid", role: "list" });
  const atlas = h("div", { class: "glacier-atlas" }, atlasHead, atlasLead, atlasGrid);

  // ---------------- DOM: one glacier
  const name = h("h2", { class: "glacier-name" });
  const chips = h("p", { class: "glacier-chips" });
  const big = h("p", { class: "glacier-big" });
  const story = h("p", { class: "glacier-story" });
  const segBtns = LAYERS.map((k) => h("button", { type: "button", class: "seg-btn", dataset: { layer: k }, "aria-pressed": "false", text: t(`glaciers.layer_${k}`) }));
  const seg = h("div", { class: "seg glacier-layers", role: "group", "aria-label": t("glaciers.layers_label") }, segBtns);
  const legend = s("svg", { class: "glacier-legend", role: "img" });
  const legendNote = h("p", { class: "muted small glacier-legend-note" });
  const surfaceKey = h("ul", { class: "motion-series-key glacier-surface-key" });
  // Year by year plays in the bar under the map, where every mode keeps its play control
  // (modebar.js, D-089); each year's bar is the glacier's trunk speed that year.
  const bar = createModeBar({ t, ariaLabel: t("glaciers.year_slider"), stepMs: 600 });
  document.getElementById("slot-map-bottom")?.append(bar.el);
  const flowBtn = h("button", { type: "button", class: "btn small", "aria-pressed": String(animate) });
  const fitBtn = h("button", { type: "button", class: "btn small", text: t("glaciers.frame") });
  const tools = h("div", { class: "glacier-tools" }, flowBtn, fitBtn);
  const readout = h("p", { class: "glacier-readout small", "aria-live": "polite" });

  const hovHead = h("h3", { text: t("glaciers.hov_title") });
  const hovLead = h("p", { class: "small" });
  const hovCanvas = h("canvas", { class: "hov-canvas", "aria-hidden": "true" });
  const hovSvg = s("svg", { class: "hov-axes", role: "img" });
  const hovBox = h("div", { class: "hov-box" }, hovCanvas, hovSvg);
  const hovRead = h("p", { class: "muted small hov-read", "aria-live": "polite" });

  const histHead = h("h3", { text: t("glaciers.hist_title") });
  const histSvg = s("svg", { class: "area-chart glacier-hist", role: "img" });
  const checksList = h("ul", { class: "glacier-checks" });

  const graceHead = h("h3", { text: t("glaciers.grace_title") });
  const graceSvg = s("svg", { class: "area-chart glacier-grace", role: "img" });
  const graceRead = h("div", { class: "small" });

  const nisarHead = h("h3", { text: t("glaciers.nisar_title") });
  const nisarRead = h("div", { class: "glacier-nisar-stats" });
  const nisarSvg = s("svg", { class: "area-chart glacier-nisar", role: "img" });
  const nisarTest = h("p", { class: "small" });
  const link = h("button", { type: "button", class: "btn small", hidden: true, text: t("glaciers.link_ice") });

  const sources = h("div", { class: "glacier-sources" });
  const notebookLine = h("p", { class: "notebook-line", hidden: true }); // this glacier's notebook in Colab (D-098)
  const table = h("div");

  const card = h(
    "div",
    { class: "glacier-card" },
    name, chips, notebookLine, big, story, readout,
    hovHead, hovLead, hovBox, hovRead,
    histHead, histSvg, checksList,
    graceHead, graceSvg, graceRead,
    nisarHead, nisarRead, nisarSvg, nisarTest, link,
    sources, table,
  );
  root.append(card, atlas);
  // The map panel (dock.js): the four views with their key under Layer; the flow animation and
  // the whole-glacier frame under Display.
  dock.place("layer", h("div", { class: "dock-field" }, seg, h("div", { class: "dock-key" }, legend, legendNote, surfaceKey)), { also: card });
  dock.place("display", tools, { also: card });

  // ---------------- map layers
  const overlay = h("canvas", { class: "overlay-glacier", "aria-hidden": "true" });
  const particles = h("canvas", { class: "glacier-particles", "aria-hidden": "true" });
  const vec = s("svg", { class: "vector-layer glacier-vectors", "aria-hidden": "true" });
  map.panes.top.append(particles, vec);
  let field = null;
  let parts = [];
  let yearsPerFrame = 0;
  let raf = 0;
  let lastView = "";
  let hoverKm = null;

  const active = () => store.get().mode === "ice";

  function setRelief(on) {
    const g = store.get().gibs?.layers?.find((l) => l.id === RELIEF);
    if (on && g && store.get().online) map.setTileLayer("glacier-relief", g.template, { maxZoom: g.max_zoom, opacity: 0.5, pane: "live" });
    else map.removeTileLayer("glacier-relief");
  }

  // ---------------- atlas
  function renderAtlas() {
    atlasGrid.replaceChildren();
    if (!index) return;
    const n = index.glaciers.length;
    const regions = new Set(index.glaciers.map((g) => g.region)).size;
    atlasLead.textContent = t("glaciers.atlas_lead", { n: fmtNumber(n, 0), regions: fmtNumber(regions, 0) });
    for (const [region, list] of byRegion(index.glaciers)) {
      atlasGrid.append(h("p", { class: "atlas-region", text: t(`glaciers.region_${region}`) }));
      for (const g of list) {
        const ch = trunkChange(g.years, g.trunk);
        const up = ch && ch.change !== null ? ch.change > 0.1 : null;
        const down = ch && ch.change !== null ? ch.change < -0.1 : null;
        const tile = h(
          "button",
          { type: "button", class: "atlas-tile", role: "listitem", dataset: { id: g.id, trend: up ? "up" : down ? "down" : "flat" }, "aria-pressed": "false" },
          h("span", { class: "atlas-name", text: g.name }),
          s("svg", { class: "atlas-spark", viewBox: "0 0 100 28", preserveAspectRatio: "none", "aria-hidden": "true" }, s("path", { d: sparkPath(g.trunk, 100, 28) })),
          h("span", { class: "atlas-meta" }, h("span", { text: speedText(t, g.max_m_yr) }), ch && ch.change !== null ? h("span", { class: "atlas-change", text: t("glaciers.tile_change", { pct: `${ch.change > 0 ? "+" : ""}${fmtNumber(100 * ch.change, 0)}`, from: ch.from }) }) : h("span")),
        );
        tile.title = t("glaciers.tile_title", { name: g.name, speed: speedText(t, g.max_m_yr) });
        tile.addEventListener("click", () => store.set({ glacier: g.id }));
        atlasGrid.append(tile);
      }
    }
    markTiles();
  }

  function markTiles() {
    for (const b of atlasGrid.querySelectorAll(".atlas-tile")) b.setAttribute("aria-pressed", String(b.dataset.id === store.get().glacier));
  }

  // ---------------- the header list (the same place and look as the site list)
  // Ice mode hides the site list; this one stands in for it, grouped by region like the atlas.
  const pickerSel = h("select", { id: "glacier-select", "aria-label": t("glaciers.pick") });
  document.getElementById("site-select")?.after(pickerSel);
  pickerSel.addEventListener("change", () => store.set({ glacier: pickerSel.value }));
  // The header squeezes the list on mid-size screens: the full name on hover.
  const nameTip = () => (pickerSel.title = pickerSel.selectedOptions[0]?.textContent ?? "");

  function fillPicker() {
    if (!index) return;
    pickerSel.replaceChildren(
      ...byRegion(index.glaciers).map(([region, list]) =>
        h("optgroup", { label: t(`glaciers.region_${region}`) }, list.map((g) => h("option", { value: g.id, text: g.name }))),
      ),
    );
    pickerSel.value = store.get().glacier ?? DEFAULT_GLACIER;
    nameTip();
  }

  // ---------------- load
  async function loadIndex() {
    const { manifest, dataBase } = store.get();
    if (!manifest?.glaciers || index) return;
    try {
      const d = await (await fetch(`${dataBase}${manifest.glaciers}`)).json();
      if (d.schema_version !== GLACIER_SCHEMA) throw new Error(`glacier schema ${d.schema_version}`);
      index = d;
      renderAtlas();
      fillPicker();
      if (active()) open(store.get().glacier ?? DEFAULT_GLACIER);
    } catch (err) {
      console.error("glaciers: atlas did not load", err);
    }
  }

  async function open(gid) {
    if (!index) return;
    const entry = index.glaciers.find((g) => g.id === gid) ?? index.glaciers.find((g) => g.id === DEFAULT_GLACIER) ?? index.glaciers[0];
    if (!entry) return;
    if (store.get().glacier !== entry.id) {
      store.set({ glacier: entry.id });
      return; // the watch comes back here
    }
    if (doc?.id === entry.id) {
      frame();
      return;
    }
    const token = ++loadToken;
    const { dataBase, manifest } = store.get();
    const base = `${dataBase}${manifest.glaciers.replace(/index\.json$/, "")}${entry.path.replace(/glacier\.json$/, "")}`;
    try {
      const d = await (await fetch(`${base}glacier.json`)).json();
      if (d.schema_version !== GLACIER_SCHEMA) throw new Error(`glacier schema ${d.schema_version}`);
      const buf = await readBinary(`${base}glacier.bin.gz`);
      if (token !== loadToken) return;
      doc = d;
      planes = decodePlanes(d, buf);
      // Terrain for the map (Copernicus GLO-90 heights, D-087): rock reads as mountains, not a flat fill.
      relief = planes.dem ? hillshade(planes.dem, doc.grid.width, doc.grid.height, doc.grid.cell_m) : null;
      yearIdx = Math.max(0, d.annual_grid.years.length - 1);
      setBarSteps();
      buildField();
      card.hidden = false;
      render();
      frame();
      const q = new URLSearchParams(location.search);
      q.set("glacier", d.id);
      history.replaceState(null, "", `${location.pathname}?${q}`);
    } catch (err) {
      console.error(`glaciers: ${gid} did not load`, err);
    }
  }

  function frame() {
    if (!doc) return;
    map.fitBounds(doc.bounds);
    // Keep the glacier clear of the sidebar edge on wide screens.
    requestAnimationFrame(() => {
      calibrate();
      resetParticles();
    });
  }

  function setBarSteps() {
    const years = doc.annual_grid.years;
    const byYear = new Map((doc.history?.years ?? []).map((y, i) => [y, doc.history.trunk?.[i]?.v ?? null]));
    const vals = years.map((y) => byYear.get(y) ?? null);
    const top = Math.max(1e-9, ...vals.filter((v) => v !== null));
    bar.setSteps(
      years.map((y, i) => ({
        label: fmtYear(y),
        short: fmtYear(y),
        caption: vals[i] === null ? t("glaciers.bar_none") : t("glaciers.bar_trunk", { v: speedText(t, vals[i]) }),
        height: vals[i] === null ? 0.04 : vals[i] / top,
      })),
      yearIdx,
    );
  }

  // ---------------- particles
  function buildField() {
    const { width, height } = doc.grid;
    // The flow over the whole box: measured on the ice, carried on across gaps and past the
    // front until a shore or the box edge (extendFlow, D-087).
    const ext = extendFlow(planes.east, planes.north, planes.surface ?? null, width, height, doc.grid.cell_m);
    const vmax = doc.stats.max_m_yr ?? 100;
    field = { east: ext.east, north: ext.north, drawn: ext.drawn, width, height, seeds: seedCells(ext.east, ext.north, Math.max(2, 0.004 * vmax)) };
    const nParts = Math.min(5000, Math.max(400, Math.round(field.seeds.length * 0.2)));
    parts = Array.from({ length: nParts }, () => ({ x: 0, y: 0, age: 0 }));
  }

  // Years of flow one frame shows: the fastest ice crosses ~1.4 screen pixels a frame at the
  // framed zoom (fixed per glacier, so the legend can say how much time a second shows).
  function calibrate() {
    if (!doc) return;
    const [w, s0, e, n] = doc.bounds;
    const [x0] = map.project(w, n);
    const [x1] = map.project(e, s0);
    const pxPerCell = (x1 - x0) / doc.grid.width;
    const cellsPerYear = 1 / doc.grid.cell_m;
    const vmax = doc.stats.max_m_yr ?? 100;
    yearsPerFrame = 1.4 / Math.max(1e-9, vmax * cellsPerYear * pxPerCell);
    renderLegendNote();
  }

  function resetParticles() {
    if (!field) return;
    for (const p of parts) respawn(p, field.seeds, field.width);
    const ctx = particles.getContext("2d");
    ctx.clearRect(0, 0, particles.width, particles.height);
  }

  function particlesOn() {
    return active() && animate && doc && (layer === "speed" || layer === "trend") && !root.hidden;
  }

  function tick() {
    raf = 0;
    if (!particlesOn()) {
      particles.getContext("2d").clearRect(0, 0, particles.width, particles.height);
      return;
    }
    const ctx = particles.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const [W, H] = map.size();
    if (particles.width !== Math.round(W * dpr) || particles.height !== Math.round(H * dpr)) {
      particles.width = Math.round(W * dpr);
      particles.height = Math.round(H * dpr);
      particles.style.width = `${W}px`;
      particles.style.height = `${H}px`;
    }
    const [w, s0, e, n] = doc.bounds;
    const [x0, y0] = map.project(w, n);
    const [x1, y1] = map.project(e, s0);
    const view = `${x0.toFixed(1)},${y0.toFixed(1)},${x1.toFixed(1)}`;
    // Fade the trails; a moved map starts them afresh so they do not smear.
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = view === lastView ? "rgba(0,0,0,0.9)" : "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, particles.width, particles.height);
    lastView = view;
    ctx.globalCompositeOperation = "source-over";
    const sx = ((x1 - x0) / doc.grid.width) * dpr;
    const sy = ((y1 - y0) / doc.grid.height) * dpr;
    const segs = stepParticles(parts, field, { cellsPerYear: 1 / doc.grid.cell_m, yearsPerFrame, maxAge: 90 });
    ctx.lineWidth = 1.15 * dpr;
    ctx.lineCap = "round";
    // Measured flow in white; flow carried on past the measurement in a softer ice blue.
    const styles = layer === "trend" ? ["rgba(20,24,28,0.75)", "rgba(20,24,28,0.4)"] : ["rgba(255,255,255,0.82)", "rgba(160,205,235,0.6)"];
    for (const kind of [0, 1]) {
      ctx.strokeStyle = styles[kind];
      ctx.beginPath();
      for (let i = 0, s = 0; i < segs.length; i += 5, s++) {
        if ((segs.kinds[s] ?? 0) !== kind) continue;
        ctx.moveTo(x0 * dpr + segs[i] * sx, y0 * dpr + segs[i + 1] * sy);
        ctx.lineTo(x0 * dpr + segs[i + 2] * sx, y0 * dpr + segs[i + 3] * sy);
      }
      ctx.stroke();
    }
    raf = requestAnimationFrame(tick);
  }

  function startParticles() {
    if (!raf && particlesOn()) raf = requestAnimationFrame(tick);
  }

  // ---------------- map drawing
  function paintMap() {
    if (!doc || !planes) {
      map.removeOverlay("glacier");
      return;
    }
    const range = speedRange(doc.stats);
    let rgba;
    let w = doc.grid.width;
    let hh = doc.grid.height;
    if (layer === "speed") rgba = paintPlane(planes.speed, "speed", range);
    else if (layer === "trend") rgba = paintPlane(planes.trend, "trend", trendRange(doc.stats));
    else if (layer === "season") rgba = paintPlane(planes.phase, "phase");
    else {
      w = doc.annual_grid.width;
      hh = doc.annual_grid.height;
      rgba = paintPlane(planes.annual[yearIdx] ?? new Float32Array(w * hh), "speed", range);
    }
    fillSurface(rgba, w, hh, planes.surface ?? null, doc.grid.width, doc.grid.height, undefined, relief);
    toCanvas(rgba, w, hh, overlay);
    if (active()) map.addOverlay("glacier", overlay, doc.bounds, "base");
  }

  function drawVectors(m) {
    const [W, H] = m.size();
    vec.setAttribute("width", W);
    vec.setAttribute("height", H);
    vec.replaceChildren();
    if (!active() || !index) return;
    // Every glacier as a dot, so the atlas reads on the world map too.
    for (const g of index.glaciers) {
      const [w, s0, e, n] = g.bounds;
      const [x, y] = m.project((w + e) / 2, (s0 + n) / 2);
      if (x < -20 || y < -20 || x > W + 20 || y > H + 20) continue;
      const me = g.id === doc?.id;
      const dot = s("circle", { cx: x, cy: y, r: me ? 7 : 5, class: me ? "glacier-dot is-on" : "glacier-dot" }, s("title", {}, g.name));
      dot.addEventListener("click", () => store.set({ glacier: g.id }));
      vec.append(dot);
    }
    if (!doc) return;
    const fl = doc.flowline;
    const pts = fl.lon.map((lon, i) => m.project(lon, fl.lat[i]));
    vec.append(s("path", { d: `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}`, class: "glacier-flowline" }));
    // Distance ticks every 10 km (5 on short lines), from the front.
    const step = fl.km.at(-1) > 40 ? 10 : 5;
    for (let k = step; k < fl.km.at(-1); k += step) {
      const i = fl.km.findIndex((v) => v >= k + fl.front_km);
      if (i < 0) break;
      const [x, y] = pts[i];
      vec.append(s("circle", { cx: x, cy: y, r: 2.4, class: "glacier-tick" }), s("text", { x: x + 6, y: y - 4, class: "glacier-tick-label" }, t("glaciers.km", { v: fmtNumber(k, 0) })));
    }
    const fi = fl.km.findIndex((v) => v >= fl.front_km);
    if (fi >= 0) {
      const [x, y] = pts[fi];
      vec.append(s("circle", { cx: x, cy: y, r: 5, class: "glacier-front" }), s("text", { x: x + 8, y: y + 14, class: "glacier-tick-label" }, t("glaciers.front_label")));
    }
    if (hoverKm !== null) {
      const i = fl.km.findIndex((v) => v >= hoverKm);
      if (i >= 0) vec.append(s("circle", { cx: pts[i][0], cy: pts[i][1], r: 6, class: "glacier-hover" }));
    }
  }

  map.onRender((m) => {
    drawVectors(m);
    if (particlesOn()) startParticles();
  });

  map.on("click", (lonLat) => {
    if (!active() || !doc || !planes) return;
    const [lon, lat] = lonLat;
    const year = layer === "year";
    const i = year ? cellAt(doc, lon, lat, doc.annual_grid.width, doc.annual_grid.height) : cellAt(doc, lon, lat);
    if (i === null) {
      readout.textContent = "";
      return;
    }
    const v = year ? planes.annual[yearIdx]?.[i] : planes.speed[i];
    if (!Number.isFinite(v)) {
      readout.textContent = t("glaciers.read_none");
      return;
    }
    const parts2 = [t(year ? "glaciers.read_year" : "glaciers.read_speed", { v: speedText(t, v), day: fmtNumber(perDay(v), perDay(v) < 1 ? 2 : 1), year: doc.annual_grid.years[yearIdx] })];
    if (!year) {
      const tr = planes.trend[i];
      if (Number.isFinite(tr)) parts2.push(t("glaciers.read_trend", { v: `${tr > 0 ? "+" : ""}${fmtNumber(tr, Math.abs(tr) < 10 ? 1 : 0)}` }));
      const ph = planes.phase[i];
      if (Number.isFinite(ph)) parts2.push(t("glaciers.read_phase", { month: t(`glaciers.month_${monthOfDay(ph) + 1}`) }));
      const er = planes.error?.[i];
      if (Number.isFinite(er)) parts2.push(t("glaciers.read_error", { v: fmtNumber(er, 0) }));
    }
    readout.textContent = parts2.join(" ");
  });

  // ---------------- legend
  function renderLegend() {
    legend.replaceChildren();
    const W = 320;
    const x0 = 8;
    const x1 = W - 8;
    const n = 64;
    const kind = layer === "trend" ? "trend" : layer === "season" ? "season" : "speed";
    for (let k = 0; k < n; k++) {
      const f = k / (n - 1);
      const col = kind === "speed" ? rampColour("ice", f) : rampColour(kind === "trend" ? "vik" : "romaO", f);
      legend.append(s("rect", { x: x0 + (k * (x1 - x0)) / n, y: 4, width: (x1 - x0) / n + 0.6, height: 12, fill: col }));
    }
    const lab = (x, text, anchor = "middle") => legend.append(s("line", { x1: x, x2: x, y1: 16, y2: 20, class: "tick-line" }), s("text", { x, y: 32, class: "tick", "text-anchor": anchor }, text));
    if (kind === "speed") {
      const [lo, hi] = speedRange(doc.stats);
      const sc = logScale(lo, hi);
      const tk = logTicks(sc.lo, sc.hi, 5);
      tk.forEach((v, i) => lab(x0 + sc.f(v) * (x1 - x0), fmtNumber(v, 0), i === 0 ? "start" : i === tk.length - 1 ? "end" : "middle"));
      legend.setAttribute("aria-label", t("glaciers.legend_speed", { lo: fmtNumber(sc.lo, 0), hi: fmtNumber(sc.hi, 0) }));
    } else if (kind === "trend") {
      const r = trendRange(doc.stats);
      lab(x0, `−${fmtNumber(r, r < 10 ? 1 : 0)}`, "start");
      lab((x0 + x1) / 2, "0");
      lab(x1, `+${fmtNumber(r, r < 10 ? 1 : 0)}`, "end");
      legend.setAttribute("aria-label", t("glaciers.legend_trend", { r: fmtNumber(r, 1) }));
    } else {
      for (const m of [0, 3, 6, 9]) lab(x0 + ((m + 0.5) / 12) * (x1 - x0), t(`glaciers.month_${m + 1}`));
      legend.setAttribute("aria-label", t("glaciers.legend_season"));
    }
    legend.setAttribute("viewBox", `0 0 ${W} 36`);
    renderLegendNote();
  }

  function renderLegendNote() {
    if (!doc) return;
    const daysPerSecond = yearsPerFrame * 60 * 365.25;
    const anim = animate && (layer === "speed" || layer === "trend") && daysPerSecond > 0
      ? t("glaciers.legend_anim", { days: fmtNumber(daysPerSecond, daysPerSecond < 10 ? 1 : 0) })
      : "";
    const base = {
      speed: t("glaciers.legend_speed_note", { a: doc.source.static_years[0], b: doc.source.static_years[1] }),
      trend: t("glaciers.legend_trend_note", { a: doc.source.static_years[0], b: doc.source.static_years[1] }),
      season: t("glaciers.legend_season_note", { pct: fmtNumber(100 * doc.stats.seasonal_share, 0) }),
      year: t("glaciers.legend_year_note"),
    }[layer];
    legendNote.textContent = [base, anim].filter(Boolean).join(" ");
    renderSurfaceKey();
  }

  // What the greys inside the box are, with their share of it: nothing in the box is left blank.
  function renderSurfaceKey() {
    const share = doc.stats.surface_share;
    surfaceKey.replaceChildren();
    if (!share) return;
    const rgb = (c) => `rgb(${c.join(" ")})`;
    const item = (col, key, pct) => h("li", {}, h("span", { class: "swatch", style: `background:${rgb(col)}` }), t(key, { pct: fmtNumber(100 * pct, pct < 0.01 ? 1 : 0) }));
    // On the speed map only ice the mosaic missed is grey; other layers leave more ice without a value.
    if (layer !== "speed" || share.ice_gap >= 0.001) surfaceKey.append(item(SURFACE_COLOURS[2], layer === "speed" ? "glaciers.surface_ice_gap" : "glaciers.surface_ice_novalue", share.ice_gap));
    if ((share.floating ?? 0) >= 0.001) surfaceKey.append(h("li", {}, h("span", { class: "swatch", style: "background:linear-gradient(90deg, rgb(28 60 110), rgb(190 225 245))" }), t("glaciers.surface_floating", { pct: fmtNumber(100 * share.floating, share.floating < 0.01 ? 1 : 0) })));
    if (share.rock >= 0.001) surfaceKey.append(item(SURFACE_COLOURS[3], "glaciers.surface_rock", share.rock));
    if (share.nodata >= 0.001) surfaceKey.append(item(SURFACE_COLOURS[4], "glaciers.surface_nodata", share.nodata));
    if ((layer === "speed" || layer === "trend") && animate) {
      surfaceKey.append(h("li", {}, h("span", { class: "swatch", style: "background:rgb(160 205 235)" }), t("glaciers.flow_carried", { km: 6 })));
    }
  }

  // ---------------- time-distance diagram (speed along the flowline, year by year)
  function renderHov() {
    const hist = doc.history;
    const fl = doc.flowline;
    const ny = hist.years.length;
    const nx = fl.km.length;
    hovBox.hidden = !ny;
    if (!ny) return;
    const range = speedRange(doc.stats);
    const sc = logScale(range[0], range[1]);
    const L = iceLut();
    const rgba = new Uint8ClampedArray(nx * ny * 4);
    hist.speed.forEach((row, yi) => {
      row.forEach((v, xi) => {
        const o = (yi * nx + xi) * 4;
        if (v === null) {
          // Not measured that year: faint hatch-grey so a gap never reads as slow ice.
          const g = (xi + yi) % 2 ? 46 : 38;
          rgba.set([g, g + 4, g + 8, 255], o);
          return;
        }
        const j = Math.round(sc.f(v) * 255) * 3;
        rgba.set([L[j], L[j + 1], L[j + 2], 255], o);
      });
    });
    toCanvas(rgba, nx, ny, hovCanvas);
    // Axes: km from the front along x, years down y.
    const W = 340;
    const H = 230;
    const M = { l: 38, r: 8, t: 8, b: 30 };
    hovSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    hovSvg.replaceChildren();
    const kmMax = fl.km.at(-1);
    const x = scale([0, kmMax], [M.l, W - M.r]);
    const y = scale([0, ny], [M.t, H - M.b]);
    hovCanvas.style.left = `${(M.l / W) * 100}%`;
    hovCanvas.style.width = `${((W - M.l - M.r) / W) * 100}%`;
    hovCanvas.style.top = `${(M.t / H) * 100}%`;
    hovCanvas.style.height = `${((H - M.t - M.b) / H) * 100}%`;
    for (const k of ticks(0, kmMax - fl.front_km, 4)) {
      const xx = x(k + fl.front_km);
      hovSvg.append(s("line", { x1: xx, x2: xx, y1: H - M.b, y2: H - M.b + 4, class: "tick-line" }), s("text", { x: xx, y: H - M.b + 15, class: "tick", "text-anchor": "middle" }, fmtNumber(k, 0)));
    }
    hovSvg.append(s("text", { x: W - M.r, y: H - 3, class: "tick", "text-anchor": "end" }, t("glaciers.hov_x")));
    for (const [i, yr] of hist.years.entries()) {
      if (yr % 5 !== 0) continue;
      hovSvg.append(s("text", { x: M.l - 5, y: y(i + 0.5) + 4, class: "tick", "text-anchor": "end" }, fmtYear(yr)));
    }
    if (fl.front_km > 0) {
      const xf = x(fl.front_km);
      hovSvg.append(s("line", { x1: xf, x2: xf, y1: M.t, y2: H - M.b, class: "hov-front" }));
    }
    // The year on the map, marked.
    const ym = y(yearIdx + 0.5);
    hovSvg.append(s("path", { d: `M${M.l - 1},${ym}h-5l-3,-4v8l3,-4`, class: "hov-year" }));
    hovSvg.append(s("line", { x1: M.l, x2: W - M.r, y1: ym, y2: ym, class: "hov-year-line" }));
    const hit = s("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, class: "hov-hit" });
    hovSvg.append(hit);
    const pick = (ev) => {
      const r = hovSvg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const py = ((ev.clientY - r.top) / r.height) * H;
      const km = Math.max(0, Math.min(kmMax, ((px - M.l) / (W - M.l - M.r)) * kmMax));
      const yi = Math.max(0, Math.min(ny - 1, Math.floor(((py - M.t) / (H - M.t - M.b)) * ny)));
      const xi = Math.max(0, Math.min(nx - 1, Math.round((km / kmMax) * (nx - 1))));
      return { km, yi, xi };
    };
    hit.addEventListener("pointermove", (ev) => {
      const { km, yi, xi } = pick(ev);
      const v = hist.speed[yi][xi];
      hovRead.textContent = t(v === null ? "glaciers.hov_read_none" : "glaciers.hov_read", { year: hist.years[yi], km: fmtNumber(km - fl.front_km, 1), v: speedText(t, v) });
      hoverKm = km;
      map.refresh();
    });
    hit.addEventListener("pointerleave", () => {
      hoverKm = null;
      map.refresh();
    });
    hit.addEventListener("click", (ev) => {
      const { yi } = pick(ev);
      setYear(yi);
      setLayer("year");
    });
    hovSvg.setAttribute("aria-label", t("glaciers.hov_label", { name: doc.name, a: hist.years[0], b: hist.years.at(-1) }));
  }

  // ---------------- trunk speed through the years, with published speeds
  function renderHistory() {
    const hist = doc.history;
    histSvg.replaceChildren();
    const rows = hist.years.map((yr, i) => ({ yr, t: hist.trunk[i] })).filter((r) => r.t);
    histSvg.style.display = rows.length >= 2 ? "" : "none";
    const W = 340;
    const H = 170;
    const M = { l: 44, r: 10, t: 12, b: 22 };
    const pubs = doc.checks.filter((c) => c.published_m_yr);
    const vals = rows.flatMap((r) => [r.t.v + (r.t.err ?? 0)]).concat(pubs.map((c) => c.published_m_yr));
    const top = Math.max(1, ...vals) * 1.08;
    const x = scale([hist.years[0], hist.years.at(-1)], [M.l, W - M.r]);
    const y = scale([0, top], [H - M.b, M.t]);
    for (const v of ticks(0, top, 3)) {
      histSvg.append(s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: M.l - 5, y: y(v) + 4, class: "tick", "text-anchor": "end" }, v >= 1000 ? `${fmtNumber(v / 1000, v % 1000 ? 1 : 0)}k` : fmtNumber(v, 0)));
    }
    for (const yr of [hist.years[0], 2000, hist.years.at(-1)]) {
      histSvg.append(s("text", { x: x(yr), y: H - 5, class: "tick", "text-anchor": yr === hist.years[0] ? "start" : yr === hist.years.at(-1) ? "end" : "middle" }, fmtYear(yr)));
    }
    // ITS_LIVE's error as a band, the trunk speed as a line broken where a year was not measured.
    const segsOf = (arr) => {
      const out = [];
      let cur = [];
      for (const r of arr) {
        if (cur.length && r.yr !== cur.at(-1).yr + 1) {
          out.push(cur);
          cur = [];
        }
        cur.push(r);
      }
      if (cur.length) out.push(cur);
      return out;
    };
    for (const seg of segsOf(rows)) {
      const band = seg.filter((r) => r.t.err !== null);
      if (band.length >= 2) {
        const up = band.map((r) => `${x(r.yr).toFixed(1)},${y(r.t.v + r.t.err).toFixed(1)}`);
        const dn = band.slice().reverse().map((r) => `${x(r.yr).toFixed(1)},${y(Math.max(0, r.t.v - r.t.err)).toFixed(1)}`);
        histSvg.append(s("path", { d: `M${up.join("L")}L${dn.join("L")}Z`, class: "glacier-band" }));
      }
      histSvg.append(s("path", { d: `M${seg.map((r) => `${x(r.yr).toFixed(1)},${y(r.t.v).toFixed(1)}`).join("L")}`, class: "glacier-line" }));
    }
    for (const r of rows) {
      histSvg.append(s("circle", { cx: x(r.yr), cy: y(r.t.v), r: 2.2, class: "glacier-pt" }, s("title", {}, t("glaciers.hist_tip", { year: r.yr, v: speedText(t, r.t.v), err: r.t.err === null ? "–" : fmtNumber(r.t.err, 0) }))));
    }
    // Speeds others measured, where they measured them (front or trunk), as diamonds.
    for (const c of pubs) {
      const cx = x(c.year);
      const cy = y(c.published_m_yr);
      histSvg.append(s("path", { d: `M${cx},${cy - 6}l6,6l-6,6l-6,-6z`, class: "glacier-pub" }, s("title", {}, t("glaciers.pub_tip", { v: speedText(t, c.published_m_yr), year: c.year, source: c.source }))));
    }
    // The year on the map.
    const yr = hist.years[yearIdx];
    if (yr !== undefined) histSvg.append(s("line", { x1: x(yr), x2: x(yr), y1: M.t, y2: H - M.b, class: "hov-year-line" }));
    histSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    histSvg.setAttribute("aria-label", t("glaciers.hist_label", { name: doc.name }));

    checksList.replaceChildren();
    for (const c of doc.checks) {
      let text;
      if (c.published_m_yr) {
        text = c.itslive_m_yr === null || c.itslive_m_yr === undefined
          ? t("glaciers.check_speed_none", { what: c.what, v: speedText(t, c.published_m_yr), year: c.year })
          : t("glaciers.check_speed", { what: c.what, v: speedText(t, c.published_m_yr), year: c.year, its: speedText(t, c.itslive_m_yr), its_year: c.itslive_year, where: t(`glaciers.where_${c.where ?? "front"}`) });
      } else {
        text = c.change_pct === undefined
          ? t("glaciers.check_trend_none", { what: c.what })
          : t("glaciers.check_trend", { what: c.what, from: c.itslive_from, to: c.itslive_to, a: speedText(t, c.itslive_from_m_yr), b: speedText(t, c.itslive_to_m_yr), pct: `${c.change_pct > 0 ? "+" : ""}${fmtNumber(c.change_pct, 0)}` });
      }
      const verdict = c.agrees === undefined ? "none" : c.agrees ? "yes" : "no";
      checksList.append(
        h(
          "li",
          { dataset: { agrees: verdict } },
          h("span", { class: "check-mark", text: t(`glaciers.check_${verdict}`) }),
          h("span", { text: `${text} ` }),
          h("span", { class: "muted", text: c.source }),
        ),
      );
    }
    checksList.hidden = !doc.checks.length;
  }

  // ---------------- GRACE / GRACE-FO mass of the region
  function renderGrace() {
    const g = doc.grace;
    graceHead.hidden = !g;
    graceSvg.style.display = g ? "" : "none";
    graceRead.hidden = !g;
    graceSvg.replaceChildren();
    if (!g) return;
    const W = 340;
    const H = 150;
    const M = { l: 44, r: 10, t: 10, b: 22 };
    const tYear = (m) => Number(m.slice(0, 4)) + (Number(m.slice(5, 7)) - 0.5) / 12;
    const xs = g.months.map(tYear);
    const lo = Math.min(0, ...g.gt);
    const hi = Math.max(0, ...g.gt);
    const x = scale([xs[0], xs.at(-1)], [M.l, W - M.r]);
    const y = scale([lo, hi], [H - M.b, M.t]);
    for (const v of ticks(lo, hi, 3)) {
      graceSvg.append(s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: v === 0 ? "grid zero" : "grid" }), s("text", { x: M.l - 5, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)));
    }
    for (const yr of [2005, 2015, 2025]) {
      if (yr >= xs[0] && yr <= xs.at(-1)) graceSvg.append(s("text", { x: x(yr), y: H - 5, class: "tick", "text-anchor": "middle" }, fmtYear(yr)));
    }
    // GRACE ended in Oct 2017 and GRACE-FO began in Jun 2018: the gap breaks the line.
    let d = "";
    xs.forEach((xv, i) => {
      const gap = i > 0 && xv - xs[i - 1] > 0.25;
      d += `${i === 0 || gap ? "M" : "L"}${x(xv).toFixed(1)},${y(g.gt[i]).toFixed(1)}`;
    });
    graceSvg.append(s("path", { d, class: "grace-line" }));
    const sl = slope(xs, g.gt);
    if (sl !== null) {
      const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
      const my = g.gt.reduce((a, b) => a + b, 0) / g.gt.length;
      graceSvg.append(s("line", { x1: x(xs[0]), x2: x(xs.at(-1)), y1: y(my + sl * (xs[0] - mx)), y2: y(my + sl * (xs.at(-1) - mx)), class: "grace-trend" }));
    }
    graceSvg.append(s("text", { x: M.l + 4, y: M.t + 10, class: "tick" }, t("glaciers.grace_axis")));
    graceSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    graceSvg.setAttribute("aria-label", t("glaciers.grace_label", { region: g.region }));
    const parts2 = [t("glaciers.grace_read", { region: g.region, trend: fmtNumber(g.trend_gt_yr, 0), from: g.months[0].slice(0, 4), to: g.months.at(-1).slice(0, 4) })];
    const p = g.published;
    if (p && g.trend_2002_2019_gt_yr !== null) {
      parts2.push(t("glaciers.grace_check", { ours: fmtNumber(g.trend_2002_2019_gt_yr, 0), pub: fmtNumber(p.gt_yr, 1), err: fmtNumber(p.err, 0), source: p.source }));
    }
    // The finding, the check against the published estimate, the limit, each marked (D-093).
    graceRead.replaceChildren(
      leadP(parts2[0]),
      ...(parts2[1] ? [h("ul", { class: "rd-checks" }, (() => {
        const li = checkRow("");
        fillCheck(li, "done", t("glaciers.n_published"), parts2[1]);
        return li;
      })())] : []),
      note("limit", t("glaciers.grace_limits")),
    );
  }

  function renderNisar() {
    const n = doc.nisar ?? {};
    const goff = n.GOFF?.n ?? 0;
    const gunw = n.GUNW?.n ?? 0;
    const gcov = n.GCOV?.n ?? 0;
    const latest = [n.GOFF?.latest, n.GUNW?.latest, n.GCOV?.latest].filter(Boolean).sort().at(-1);
    nisarRead.replaceChildren();
    if (goff + gunw + gcov > 0) {
      const tileGrid = tiles([
        [fmtNumber(goff, 0), t("glaciers.tile_goff")],
        [fmtNumber(gunw, 0), t("glaciers.tile_gunw")],
        [fmtNumber(gcov, 0), t("glaciers.tile_gcov")],
      ]);
      tileGrid.classList.add("rd-tiles-3");
      nisarRead.append(
        tileGrid,
        h("p", { class: "rd-caption muted", text: t("glaciers.nisar_latest", { latest: latest ?? "–" }) }),
      );
    } else {
      nisarRead.append(h("p", { class: "small muted", text: t("glaciers.nisar_none") }));
    }
    link.hidden = !doc.links?.ice;
    nisarSvg.replaceChildren();
    const test = doc.nisar_test;
    nisarSvg.style.display = test ? "" : "none";
    if (!test) {
      setNote(nisarTest, "info", t("glaciers.nisar_untested"));
      return;
    }
    // NISAR's speed against ITS_LIVE's in four bands of ITS_LIVE speed (slowest to fastest ice),
    // best pair: a dumbbell per band, with the share of cells where NISAR's windows agree.
    const b = test.best;
    const bands = b.bands.filter((x) => x.cells > 0);
    const W = 340;
    const rowH = 30;
    const M = { l: 92, r: 14, t: 18, b: 22 };
    const H = M.t + rowH * bands.length + M.b;
    const top = Math.max(1, ...bands.flatMap((x) => [x.nisar_m_yr ?? 0, x.itslive_m_yr ?? 0, x.to_m_yr])) * 1.05;
    const x = scale([0, top], [M.l, W - M.r]);
    for (const v of ticks(0, top, 3)) {
      nisarSvg.append(s("line", { x1: x(v), x2: x(v), y1: M.t - 4, y2: H - M.b, class: "grid" }), s("text", { x: x(v), y: H - 6, class: "tick", "text-anchor": "middle" }, v >= 1000 ? `${fmtNumber(v / 1000, 0)}k` : fmtNumber(v, 0)));
    }
    nisarSvg.append(s("text", { x: M.l, y: 11, class: "tick" }, t("glaciers.nisar_axis")));
    bands.forEach((band, i) => {
      const yy = M.t + rowH * i + rowH / 2;
      nisarSvg.append(s("text", { x: M.l - 6, y: yy - 2, class: "tick", "text-anchor": "end" }, t("glaciers.nisar_band", { a: fmtNumber(band.from_m_yr, 0), b: fmtNumber(band.to_m_yr, 0) })));
      nisarSvg.append(s("text", { x: M.l - 6, y: yy + 10, class: "tick muted-tick", "text-anchor": "end" }, t("glaciers.nisar_agree", { pct: fmtNumber(band.agree_pct, 0) })));
      if (band.nisar_m_yr === null || band.itslive_m_yr === null) {
        nisarSvg.append(s("text", { x: M.l + 4, y: yy + 4, class: "tick" }, t("glaciers.nisar_band_none")));
        return;
      }
      nisarSvg.append(
        s("line", { x1: x(band.itslive_m_yr), x2: x(band.nisar_m_yr), y1: yy, y2: yy, class: "nisar-link" }),
        s("circle", { cx: x(band.itslive_m_yr), cy: yy, r: 5, class: "nisar-its" }, s("title", {}, `ITS_LIVE ${speedText(t, band.itslive_m_yr)}`)),
        s("circle", { cx: x(band.nisar_m_yr), cy: yy, r: 5, class: "nisar-nis" }, s("title", {}, `NISAR ${speedText(t, band.nisar_m_yr)}`)),
      );
    });
    nisarSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    nisarSvg.setAttribute("aria-label", t("glaciers.nisar_chart_label"));
    setLead(nisarTest, t("glaciers.nisar_test", {
      n: fmtNumber(test.pairs.length, 0),
      track: b.track,
      start: b.start,
      end: b.end,
      agree: fmtNumber(b.ice_agree_pct, 0),
      r: b.r === null ? "–" : fmtNumber(b.r, 2),
      ratio: b.ratio_median === null ? "–" : fmtNumber(b.ratio_median, 2),
      noise: b.rock_noise_m_yr === null ? "–" : fmtNumber(b.rock_noise_m_yr, 0),
    }));
    nisarTest.className = "small";
  }

  // ---------------- the card
  function render() {
    name.textContent = doc.name;
    chips.replaceChildren(
      h("span", { class: "chip", text: t(`glaciers.kind_${doc.kind}`) }),
      h("span", { class: "chip", text: t(`glaciers.region_${doc.region}`) }),
    );
    const top = doc.stats.max_m_yr;
    big.replaceChildren(
      h("strong", { text: speedText(t, top) }),
      h("span", { text: t("glaciers.big_sub", { day: fmtNumber(perDay(top), perDay(top) < 1 ? 2 : perDay(top) < 10 ? 1 : 0), a: doc.source.static_years[0], b: doc.source.static_years[1] }) }),
    );
    const ch = trunkChange(doc.history.years, doc.history.trunk.map((r) => (r ? r.v : null)));
    const kindLine = t(`glaciers.kind_desc_${doc.kind}`);
    // What kind of glacier, then how its speed changed, numbers in bold (D-093).
    setLead(story, ch && ch.change !== null
      ? `${kindLine} ${t("glaciers.story_change", { from: ch.from, to: ch.to, a: speedText(t, ch.v0), b: speedText(t, ch.v1), pct: `${ch.change > 0 ? "+" : ""}${fmtNumber(100 * ch.change, 0)}` })}`
      : kindLine);
    setNote(hovLead, "info", t("glaciers.hov_lead", { km: fmtNumber(doc.flowline.km.at(-1) - doc.flowline.front_km, 0) }));
    // The glacier's sources as flags to the sources page (D-110); the file's own citation for its
    // speeds stays in words, since that citation is per glacier.
    const caveatNote = note("limit", t("glaciers.src_gaps_note"));
    sources.replaceChildren(
      more(
        t("glaciers.sources_toggle"),
        h("p", { class: "rd-src-role", text: `${doc.source.name}: ${doc.source.cite}` }),
        sourceFlags(SOURCES.filter((x) => x.used.includes("ice")), t),
        caveatNote,
      ),
    );
    renderNisar();
    renderGrace();
    table.replaceChildren(
      srTable(
        t("glaciers.hist_title"),
        [t("glaciers.col_year"), t("glaciers.col_trunk"), t("glaciers.col_error")],
        doc.history.years.map((yr, i) => [String(yr), doc.history.trunk[i]?.v ?? "–", doc.history.trunk[i]?.err ?? "–"]),
      ),
    );
    setLayer(layer, true);
    markTiles();
  }

  function setYear(i) {
    if (!doc) return;
    yearIdx = Math.max(0, Math.min(doc.annual_grid.years.length - 1, i));
    bar.setIndex(yearIdx);
    if (layer === "year") paintMap();
    renderHov();
    renderHistory();
  }

  function setLayer(k, force = false) {
    if (!doc || (k === layer && !force)) return;
    layer = k;
    for (const b of segBtns) b.setAttribute("aria-pressed", String(b.dataset.layer === k));
    // The bar takes height from the map: frame the glacier again when it comes or goes.
    if (bar.show(k === "year" && active())) requestAnimationFrame(frame);
    flowBtn.hidden = !(k === "speed" || k === "trend");
    flowBtn.textContent = t(animate ? "glaciers.flow_pause" : "glaciers.flow_play");
    flowBtn.setAttribute("aria-pressed", String(animate));
    if (k !== "year") stopPlay();
    paintMap();
    renderLegend();
    setYear(yearIdx);
    resetParticles();
    startParticles();
  }

  function stopPlay() {
    bar.stop();
  }

  for (const b of segBtns) b.addEventListener("click", () => setLayer(b.dataset.layer));
  bar.onChange((i) => setYear(i));
  flowBtn.addEventListener("click", () => {
    animate = !animate;
    setLayer(layer, true);
  });
  fitBtn.addEventListener("click", frame);
  link.addEventListener("click", async () => {
    // The Columbia Icefield also has the fire chapter's smoke-and-soot card (ice.js, docs/15).
    const { manifest, dataBase } = store.get();
    try {
      const ice = await (await fetch(`${dataBase}${manifest.ice}`)).json();
      const ev = ice.events.find((e) => e.id === doc.links.ice);
      const sel = document.getElementById("site-select");
      if (!ev || !sel) return;
      store.set({ ice: true, mode: "site" });
      sel.value = ev.fire_site;
      sel.dispatchEvent(new Event("change"));
    } catch (err) {
      console.error("glaciers: fire chapter did not open", err);
    }
  });

  // ---------------- store
  if (!("glacier" in store.get())) {
    const q = new URLSearchParams(location.search).get("glacier");
    store.set({ glacier: q && /^[a-z0-9_]+$/.test(q) ? q : null });
  }
  card.hidden = true;
  watch(store, ["manifest"], () => loadIndex());
  watch(store, ["glacier"], ({ glacier, dataBase }) => {
    if (glacier) showNotebook(notebookLine, dataBase, "ice", glacier, t);
  });
  watch(store, ["gibs", "online", "mode"], () => setRelief(active()));
  watch(store, ["mode"], ({ mode }) => {
    const on = mode === "ice";
    root.hidden = !on || !index;
    if (!on) {
      bar.show(false);
      map.removeOverlay("glacier");
      particles.getContext("2d").clearRect(0, 0, particles.width, particles.height);
      map.refresh();
      return;
    }
    root.hidden = false;
    if (index) open(store.get().glacier ?? DEFAULT_GLACIER);
    map.refresh();
  });
  watch(store, ["glacier"], ({ glacier, mode }) => {
    markTiles();
    if (glacier && pickerSel.value !== glacier) pickerSel.value = glacier;
    nameTip();
    if (mode === "ice" && glacier) open(glacier);
  });
}
