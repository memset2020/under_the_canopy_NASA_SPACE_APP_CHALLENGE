// Anywhere on Earth (F31, docs/03 §4.10): click outside the detailed maps to read what
// NASA's global products say about that 0.25° cell, and find the nearest detailed site.
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtApprox, fmtDate, fmtNumber, fmtYear } from "./i18n.js";
import { loadGlobal } from "./data.js";
import { factList, note } from "./readable.js";
import { monthName, pctileBand } from "./here.js";

export const id = "globe";
export const slot = "sidebar";

const LAYERS = ["bivariate", "likely", "wettest_month", "glwd_forested_pct", "wetland_ch4", "water_storage_cm", "groundwater_pctile", "rootzone_pctile", "nisar_passes", "forest_pct", "wetland_pct", "cygnss_range_pct", "canopy_height_m", "people", "off"];
// Same wheel as pipeline/canopy/global_layers.py MONTH_RGB (January … December).
const MONTH_RGB = ["rgb(76 110 219)", "rgb(62 143 217)", "rgb(47 176 184)", "rgb(63 191 127)", "rgb(140 198 63)", "rgb(214 200 58)",
  "rgb(242 163 58)", "rgb(233 116 74)", "rgb(217 80 95)", "rgb(192 74 142)", "rgb(145 80 184)", "rgb(106 91 208)"];
const EARTH_KM = 6371;
// Same 3 × 3 palette as pipeline/canopy/global_layers.py BIVARIATE_RGBA (forest rows × water columns).
const BIVARIATE = [
  ["rgb(30 40 44)", "rgb(58 79 99)", "rgb(59 119 168)"],
  ["rgb(61 90 76)", "rgb(122 122 60)", "rgb(201 143 30)"],
  ["rgb(63 107 82)", "rgb(176 138 42)", "rgb(230 159 0)"],
];

function bivariateKey(t) {
  // Rows from most forest (top) to least, so the amber corner sits top right.
  const cells = [];
  for (let f = 2; f >= 0; f -= 1) {
    for (let w = 0; w < 3; w += 1) cells.push(h("span", { class: "biv-cell", style: `background:${BIVARIATE[f][w]}` }));
  }
  return h(
    "div",
    { class: "biv-key", role: "img", "aria-label": t("globe.biv_aria") },
    h("span", { class: "biv-y", text: t("globe.biv_forest") }),
    h("div", { class: "biv-grid" }, cells),
    h("span", { class: "biv-x", text: t("globe.biv_water") }),
  );
}

function distanceKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(a));
}

const centre = ([w, s2, e, n]) => [(w + e) / 2, (s2 + n) / 2];
const inside = ([lon, lat], [w, s2, e, n]) => lon >= w && lon <= e && lat >= s2 && lat <= n;

// One plain sentence per fact; null values say why the product has nothing there.
export function describeCell(v, meta, t) {
  const facts = [];
  const minPasses = meta.min_passes_detailed;
  facts.push(t(`globe.likely_${v.likely ?? "none"}`));
  if (!v.nisar_passes) facts.push(t("globe.nisar_none"));
  else {
    facts.push(
      t(v.nisar_passes >= minPasses ? "globe.nisar_enough" : "globe.nisar_few", {
        n: v.nisar_passes,
        min: minPasses,
        first: fmtDate(v.nisar_first_day),
        last: fmtDate(v.nisar_last_day),
      }),
    );
  }
  if (v.forest_pct !== null) {
    facts.push(t("globe.cover", { forest: fmtNumber(v.forest_pct, 0), wetland: fmtNumber(v.wetland_pct ?? 0, 0) }));
  }
  facts.push(
    v.cygnss_max_pct === null
      ? t("globe.cygnss_none")
      : t("globe.cygnss", { max: fmtNumber(v.cygnss_max_pct, 0), range: fmtNumber(v.cygnss_range_pct ?? 0, 0), months: meta.cygnss_months }),
  );
  facts.push(
    v.canopy_height_m === null ? t("globe.height_none") : t("globe.height", { m: fmtNumber(v.canopy_height_m, 0) }),
  );
  if (v.wettest_month) facts.push(t("globe.peak_month", { month: monthName(v.wettest_month) }));
  if (v.water_storage_cm !== null && v.water_storage_cm !== undefined) {
    const month = meta.water_storage_month ? monthName(Number(meta.water_storage_month.slice(5, 7))) : "";
    facts.push(
      v.water_storage_cm === 0
        ? t("globe.storage_normal", { month })
        : t(v.water_storage_cm > 0 ? "globe.storage_wet" : "globe.storage_dry", { cm: fmtNumber(Math.abs(v.water_storage_cm), 0), month }),
    );
  }
  if (v.glwd_forested_pct !== null && v.glwd_forested_pct !== undefined) {
    facts.push(t("globe.glwd", { pct: fmtNumber(v.glwd_forested_pct, 0) }));
  }
  // WetCHARTs: the ensemble mean and its lowest and highest member; a model, never a measurement.
  const ch4 = meta.wetland_ch4;
  if (ch4 && v.wetland_ch4 !== null && v.wetland_ch4 !== undefined && v.wetland_ch4 >= 0.05) {
    const mg = (x) => (x < 0.05 ? fmtNumber(0, 0) : fmtNumber(x, x < 10 ? 1 : 0));
    facts.push(
      t("globe.ch4", {
        mg: mg(v.wetland_ch4),
        lo: mg(v.wetland_ch4_lo ?? v.wetland_ch4),
        hi: mg(v.wetland_ch4_hi ?? v.wetland_ch4),
        n: fmtNumber(ch4.members, 0),
        year: fmtYear(ch4.year),
      }),
    );
  }
  for (const [k, key] of [["groundwater_pctile", "globe.groundwater"], ["rootzone_pctile", "globe.rootzone"]]) {
    if (v[k] === null || v[k] === undefined) continue;
    facts.push(t(key, { band: t(`here.gw_${pctileBand(v[k])}`), p: fmtNumber(v[k], 0), week: fmtDate(meta.groundwater_week) }));
  }
  if (v.people !== null) facts.push(t("globe.people", { n: fmtApprox(v.people) }));
  return facts;
}

// Two scales on one picture (D-093): the 28 km screening cells say where to look; inside one, a
// detailed NISAR map (tens of metres) says what is flooded, water under the trees included.
function scaleFigure(t) {
  const cells = [];
  const tone = ["#2a3a32", "#3d4f3c", "#2a3a32", "#3d4f3c", "#9a7a1c", "#3d4f3c", "#2a3a32", "#3d4f3c", "#2a3a32"];
  for (let i = 0; i < 9; i++) cells.push(s("rect", { x: 8 + (i % 3) * 34, y: 10 + Math.floor(i / 3) * 34, width: 32, height: 32, fill: tone[i] }));
  // The detailed map: a fine pixel grid of open water (blue) and water under the trees (amber).
  const px = [];
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 14; c++) {
      const v = Math.sin(c * 0.9 + r * 0.6) + Math.cos(r * 1.3 - c * 0.4);
      px.push(s("rect", { x: 168 + c * 8, y: 22 + r * 8, width: 8, height: 8, fill: v > 0.9 ? "#0072b2" : v > 0.2 ? "#e69f00" : "#3b4448" }));
    }
  }
  return s(
    "svg",
    { class: "rd-figure globe-scale", viewBox: "0 0 300 114", role: "img", "aria-label": `${t("globe.fig_cell")} · ${t("globe.fig_detail")}` },
    cells,
    s("rect", { x: 76, y: 44, width: 32, height: 32, fill: "none", stroke: "#e8eeea", "stroke-width": 1.5 }),
    s("path", { d: "M108 44 L168 22 M108 76 L168 102", stroke: "#a3b2ae", "stroke-width": 1, "stroke-dasharray": "3 3", fill: "none" }),
    px,
    s("rect", { x: 168, y: 22, width: 112, height: 80, fill: "none", stroke: "#e8eeea", "stroke-width": 1.5 }),
  );
}

// The picture and its key: the labels wrap in any language, so they sit under it as text.
function scaleBlock(t) {
  return h(
    "figure",
    { class: "rd-figure-wrap" },
    scaleFigure(t),
    h(
      "figcaption",
      { class: "rd-fig-key" },
      h("span", {}, h("i", { class: "rd-key-cell", "aria-hidden": "true" }), t("globe.fig_cell")),
      h("span", {}, h("i", { class: "rd-key-detail", "aria-hidden": "true" }), t("globe.fig_detail")),
    ),
  );
}

export function init({ store, map, t, root, dock }) {
  const select = h(
    "select",
    { id: "globe-layer" },
    LAYERS.map((l) => h("option", { value: l, text: t(`globe.layer_${l}`) })),
  );
  const legend = h("p", { class: "muted small globe-legend" });
  const world = h("button", { type: "button", class: "btn btn-small", text: t("globe.world") });
  const title = h("h3", { class: "globe-cell-title" });
  const facts = h("ul", { class: "globe-facts" });
  const nearest = h("p", { class: "globe-nearest" });
  const open = h("button", { type: "button", class: "btn btn-small btn-primary", text: t("globe.open") });
  const result = h("div", { class: "globe-result", hidden: true, "aria-live": "polite" }, title, facts, nearest, open);
  root.append(
    h("h2", { text: t("globe.title") }),
    factList([["pointer", t("globe.help")]]),
    scaleBlock(t),
    result,
    note("limit", t("globe.caveat")),
  );
  root.hidden = true;
  // What the world map shows is the world's Layer, in the map panel (dock.js).
  dock.place(
    "layer",
    h("div", { class: "dock-field" }, h("label", { for: "globe-layer", class: "field-label", text: t("globe.layer_label") }), h("div", { class: "globe-controls" }, select, world), h("div", { class: "dock-key" }, legend)),
  );
  const worldBtn = document.querySelector(".world-btn");
  if (worldBtn) worldBtn.hidden = true;

  let globalData = null;
  let picked = null; // { lonLat, cell }
  let target = null; // site id offered by the "Open" button
  const img = h("img", { class: "overlay-global", alt: "", draggable: "false" });

  // Label widths for the collision test, measured once per name in the label's font (12 px).
  const ruler = document.createElement("canvas").getContext("2d");
  const widths = new Map();
  const labelWidth = (text) => {
    if (!widths.has(text)) {
      ruler.font = `12px ${getComputedStyle(document.body).fontFamily}`;
      widths.set(text, ruler.measureText(text).width);
    }
    return widths.get(text);
  };
  // Prepared sites name first, then rule-picked hotspots, then places analysed on this computer.
  const rank = (site) => (site.id.startsWith("here_") ? 2 : site.id.startsWith("hot_") ? 1 : 0);

  // Site boxes and the picked cell, drawn as SVG above the overlays.
  const svg = s("svg", { class: "vector-layer globe-layer", "aria-hidden": "true" });
  map.panes.top.prepend(svg); // site boxes are context: under annotations and labels
  map.onRender((m) => {
    const [w, hgt] = m.size();
    svg.setAttribute("width", w);
    svg.setAttribute("height", hgt);
    svg.replaceChildren();
    const sites = [...(store.get().manifest?.sites ?? [])].sort((a, b) => rank(a) - rank(b));
    const placed = []; // label boxes so far: a label that would overlap one is left out (the dot keeps its tooltip)
    const free = (b) => placed.every((p) => b.x1 < p.x0 || b.x0 > p.x1 || b.y1 < p.y0 || b.y0 > p.y1);
    for (const site of sites) {
      if (!site.bounds) continue;
      const [x0, y0] = m.project(site.bounds[0], site.bounds[3]);
      const [x1, y1] = m.project(site.bounds[2], site.bounds[1]);
      const big = x1 - x0 > 14;
      svg.append(
        big
          ? s("rect", { x: x0, y: y0, width: x1 - x0, height: y1 - y0, class: "site-box" })
          : s("circle", { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r: 6, class: "site-dot" }, s("title", {}, site.name)),
      );
      // Names only once zoomed in enough to keep them apart; the dot carries a tooltip.
      if (m.getZoom() >= 5 && (!big || m.getZoom() <= 6)) {
        const x = (x0 + x1) / 2 + 10;
        const y = (y0 + y1) / 2 + 4;
        const box = { x0: x - 3, x1: x + labelWidth(site.name) + 3, y0: y - 13, y1: y + 4 };
        if (free(box)) {
          placed.push(box);
          svg.append(s("text", { x, y, class: "site-label" }, site.name));
        }
      }
    }
    if (picked) {
      const [w0, s0, e0, n0] = picked.cell.bounds;
      const [x0, y0] = m.project(w0, n0);
      const [x1, y1] = m.project(e0, s0);
      svg.append(s("rect", { x: x0, y: y0, width: Math.max(x1 - x0, 4), height: Math.max(y1 - y0, 4), class: "globe-pick" }));
    }
  });

  function showLayer() {
    const id2 = select.value;
    const layer = globalData?.meta.layers.find((l) => l.id === id2);
    if (!layer?.png) {
      map.removeOverlay("global");
      legend.textContent = id2 === "off" ? "" : t("globe.no_layer");
      return;
    }
    img.src = globalData.url(layer.png);
    map.addOverlay("global", img, globalData.meta.png_bounds);
    map.panes.base.prepend(img); // under the detailed site layers
    const monthKey = () =>
      h(
        "div",
        { class: "month-key", role: "img", "aria-label": t("globe.month_aria") },
        MONTH_RGB.map((c, i) => h("span", { class: "month-cell", style: `background:${c}`, title: monthName(i + 1) }, monthName(i + 1, "narrow"))),
      );
    const storageKey = (pct = false) =>
      h(
        "div",
        { class: "storage-key" },
        h("div", { class: "ramp ramp-storage" }),
        h(
          "div",
          { class: "ramp-labels" },
          h("span", { text: pct ? "0" : "−50 cm" }),
          h("span", { text: pct ? "50" : "0" }),
          h("span", { text: pct ? "100" : "+50 cm" }),
        ),
      );
    // Log scale, one step per decade (pipeline/canopy/global_layers.py _colour_ch4).
    const ch4Key = () =>
      h(
        "div",
        { class: "ramp-key" },
        h("div", { class: "ramp ramp-ch4" }),
        h("div", { class: "ramp-labels" }, h("span", { text: fmtNumber(1, 0) }), h("span", { text: fmtNumber(10, 0) }), h("span", { text: `${fmtNumber(100, 0)}+` })),
      );
    const ch4 = globalData.meta.wetland_ch4;
    legend.replaceChildren(
      ...(id2 === "bivariate" ? [bivariateKey(t)] : []),
      ...(id2 === "wetland_ch4" ? [ch4Key()] : []),
      ...(id2 === "wettest_month" ? [monthKey()] : []),
      ...(id2 === "water_storage_cm" || id2.endsWith("_pctile") ? [storageKey(id2.endsWith("_pctile"))] : []),
      h("span", {
        text: t(`globe.legend_${id2}`, {
          min: globalData.meta.min_passes_detailed,
          month: globalData.meta.water_storage_month ? monthName(Number(globalData.meta.water_storage_month.slice(5, 7))) : "",
          week: globalData.meta.groundwater_week ? fmtDate(globalData.meta.groundwater_week) : "",
          year: ch4 ? fmtYear(ch4.year) : "",
          n: ch4 ? fmtNumber(ch4.members, 0) : "",
          moved: ch4?.extent_moved_pct === null || !ch4 ? "–" : fmtNumber(ch4.extent_moved_pct, 0),
        }),
      }),
    );
  }

  function pick(lonLat) {
    if (!globalData) return;
    const cell = globalData.cell(lonLat[0], lonLat[1]);
    picked = { lonLat, cell };
    store.set({ picked: { lon: lonLat[0], lat: lonLat[1], nisarPasses: cell.values.nisar_passes } });
    const [lon, lat] = lonLat;
    title.textContent = t("globe.cell_title", {
      lat: `${fmtNumber(Math.abs(lat), 2)}°${lat >= 0 ? "N" : "S"}`,
      lon: `${fmtNumber(Math.abs(lon), 2)}°${lon >= 0 ? "E" : "W"}`,
    });
    facts.replaceChildren(...describeCell(cell.values, globalData.meta, t).map((f) => h("li", { text: f })));
    const sites = (store.get().manifest?.sites ?? []).filter((x) => x.bounds && !x.synthetic);
    const near = sites
      .map((x) => ({ x, km: distanceKm(lonLat, centre(x.bounds)) }))
      .sort((a, b) => a.km - b.km)[0];
    target = near?.x.id ?? null;
    open.hidden = !near;
    nearest.textContent = near ? t("globe.nearest", { name: near.x.name, km: fmtNumber(near.km, 0) }) : "";
    result.hidden = false;
    map.refresh();
  }

  map.on("click", (lonLat) => {
    if (store.get().tool) return; // an analyst tool (tools.js) owns clicks while active
    if (store.get().mode === "motion" || store.get().mode === "ice") return; // those cards read their own clicks
    const st = store.get();
    if (st.site && inside(lonLat, st.site.summary.grid.bounds)) return; // the detailed map answers
    const hit = (st.manifest?.sites ?? []).find((x) => x.bounds && inside(lonLat, x.bounds));
    if (hit) {
      openSite(hit.id);
      return;
    }
    pick(lonLat);
    if (store.get().mode !== "world") store.set({ mode: "world" });
    map.setView(lonLat, map.getZoom()); // one place at a time: the crosshair follows the click
  });

  function openSite(siteId) {
    const sel = document.getElementById("site-select");
    if (!sel || ![...sel.options].some((o) => o.value === siteId)) return;
    sel.value = siteId;
    sel.dispatchEvent(new Event("change"));
  }

  open.addEventListener("click", () => target && openSite(target));
  world.addEventListener("click", () => map.setView([10, 15], 3));
  select.addEventListener("change", showLayer);

  watch(store, ["manifest"], async ({ manifest, dataBase }) => {
    if (!manifest?.global || globalData) return;
    try {
      globalData = await loadGlobal(dataBase, manifest);
    } catch (err) {
      console.warn("global layer unavailable", err);
      globalData = null;
    }
    root.hidden = !globalData;
    store.set({ global: globalData }); // shared with here.js (crosshair readout, In view)
    const worldBtn2 = document.querySelector(".world-btn");
    if (worldBtn2) worldBtn2.hidden = !globalData;
    if (globalData) showLayer();
  });
}
