// Analyst tools (F44): measure a distance or an area, read statistics inside a drawn area pass by
// pass, cut a cross-section through the radar, see the coordinates under the pointer (degrees and
// UTM) and a latitude/longitude grid. Everything is computed in the browser from the site's own
// stack with rules.js, so a drawn area adds up exactly like the map.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { CLASS, classifyGrid, decodeDb } from "./rules.js";
import { EARTH_KM, haversineKm } from "./orbitmath.js";
import { geoTiff } from "./geotiff.js";
import { note } from "./readable.js";

export const id = "tools";
export const slot = "sidebar";

const TOOLS = ["distance", "area", "profile"];
const CLASS_FILL = {
  [CLASS.OPEN_WATER]: "#0072b2",
  [CLASS.FLOODED_VEG]: "#e69f00",
  [CLASS.EXCLUDED]: "#787878",
  [CLASS.DRY]: "#33464d",
};
const HH_COLOUR = "#9085e9"; // validated pair on the dark surface (dataviz check, D-065)
const HV_COLOUR = "#199e70";
const RAD = Math.PI / 180;

// ---- Pure helpers (unit-tested) -------------------------------------------------------------

export function pathKm(pts) {
  let km = 0;
  for (let i = 1; i < pts.length; i += 1) km += haversineKm(pts[i - 1], pts[i]);
  return km;
}

// Area of a lon/lat polygon on a sphere (spherical-excess approximation used by geodesic tools;
// within 0.5 % of the ellipsoid for areas of a few thousand km²).
export function polygonAreaKm2(pts) {
  if (pts.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [l1, p1] = pts[i];
    const [l2, p2] = pts[(i + 1) % pts.length];
    sum += (l2 - l1) * RAD * (2 + Math.sin(p1 * RAD) + Math.sin(p2 * RAD));
  }
  return Math.abs((sum * EARTH_KM * EARTH_KM) / 2);
}

// WGS84 lon/lat to UTM (zone, hemisphere, easting, northing in metres), Krüger series to ~1 m.
export function utm(lon, lat) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const k0 = 0.9996;
  const zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + (n * n) / 4 + (n ** 4) / 64);
  const alpha = [(n / 2) - ((2 / 3) * n * n) + ((5 / 16) * n ** 3), ((13 / 48) * n * n) - ((3 / 5) * n ** 3), (61 / 240) * n ** 3];
  const phi = lat * RAD;
  const lam = (lon - lon0) * RAD;
  const e = Math.sqrt(f * (2 - f));
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam));
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let E = eta;
  let N = xi;
  alpha.forEach((al, j) => {
    const k = 2 * (j + 1);
    E += al * Math.cos(k * xi) * Math.sinh(k * eta);
    N += al * Math.sin(k * xi) * Math.cosh(k * eta);
  });
  const easting = 500000 + k0 * A * E;
  const northing = (lat < 0 ? 10000000 : 0) + k0 * A * N;
  return { zone, hemi: lat < 0 ? "S" : "N", easting, northing };
}

// 1 where a pixel centre of the site grid lies inside the polygon (even-odd scanline fill).
export function rasterizePolygon(poly, { width: W, height: H, bounds: [west, south, east, north] }) {
  const mask = new Uint8Array(W * H);
  const dLon = (east - west) / W;
  const dLat = (north - south) / H;
  for (let r = 0; r < H; r += 1) {
    const lat = north - (r + 0.5) * dLat;
    const xs = [];
    for (let i = 0; i < poly.length; i += 1) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      if ((y1 > lat) !== (y2 > lat)) xs.push(x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - west) / dLon - 0.5));
      const c1 = Math.min(W - 1, Math.floor((xs[k + 1] - west) / dLon - 0.5));
      for (let c = c0; c <= c1; c += 1) mask[r * W + c] = 1;
    }
  }
  return mask;
}

// Per-class km² inside a mask for one classified pass.
export function areasInMask(cls, mask, rowAreaKm2, W) {
  const out = { [CLASS.NODATA]: 0, [CLASS.DRY]: 0, [CLASS.OPEN_WATER]: 0, [CLASS.FLOODED_VEG]: 0, [CLASS.EXCLUDED]: 0 };
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) out[cls[i]] += rowAreaKm2[Math.floor(i / W)];
  return out;
}

// ---- The tool -----------------------------------------------------------------------------

export function init({ store, map, t, root }) {
  const heading = h("h2", { text: t("tools.title") });
  const lead = note("info", t("tools.lead"));
  const buttons = TOOLS.map((tool) =>
    h("button", { type: "button", class: "seg-btn", dataset: { tool }, "aria-pressed": "false", text: t(`tools.${tool}`) }),
  );
  const seg = h("div", { class: "seg seg-wrap", role: "group", "aria-label": t("tools.title") }, buttons);
  const finish = h("button", { type: "button", class: "btn btn-small btn-primary", text: t("tools.finish") });
  const undo = h("button", { type: "button", class: "btn btn-small", text: t("tools.undo") });
  const clearBtn = h("button", { type: "button", class: "btn btn-small", text: t("tools.clear") });
  const actions = h("div", { class: "tool-actions", hidden: true }, finish, undo, clearBtn);
  const hint = h("p", { class: "muted small tool-hint", "aria-live": "polite" });
  const result = h("div", { class: "tool-result", "aria-live": "polite" });
  const gridToggle = h("input", { type: "checkbox", id: "tool-graticule" });
  const gridRow = h("label", { class: "check", hidden: true }, gridToggle, t("tools.graticule"));
  // Export of the shown pass for GIS (classes and backscatter), built when asked for.
  const exportClasses = h("button", { type: "button", class: "btn btn-small", text: t("tools.export_classes") });
  const exportRadar = h("button", { type: "button", class: "btn btn-small", text: t("tools.export_radar") });
  const exportNote = h("p", { class: "muted small" });
  const exportBox = h(
    "div",
    { class: "tool-export", hidden: true },
    h("h3", { text: t("tools.export_title") }),
    h("p", { class: "tool-downloads" }, exportClasses, exportRadar),
    exportNote,
  );
  root.append(heading, lead, seg, actions, hint, result, gridRow, exportBox);

  // Drawing layer and the pointer readout, on the map.
  const layer = s("svg", { class: "vector-layer tool-layer", "aria-hidden": "true" });
  map.panes.top.append(layer);
  const stage = map.container.parentElement;
  const coords = h("div", { class: "coord-readout", hidden: true, "aria-hidden": "true" });
  stage.append(coords);

  let points = [];
  let done = false;
  let hoverSample = null; // [lon, lat] of the profile sample under the chart pointer

  const st = () => store.get();
  const thresholds = () => (st().scientist?.enabled ? st().scientist.thresholds : st().site?.summary.thresholds);

  function setTool(tool) {
    points = [];
    done = false;
    hoverSample = null;
    store.set({ tool: st().tool === tool ? null : tool });
  }
  for (const b of buttons) b.addEventListener("click", () => setTool(b.dataset.tool));
  finish.addEventListener("click", () => {
    if (points.length >= (st().tool === "area" ? 3 : 2)) {
      done = true;
      update();
    }
  });
  undo.addEventListener("click", () => {
    points.pop();
    done = false;
    update();
  });
  clearBtn.addEventListener("click", () => {
    points = [];
    done = false;
    update();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && st().tool && !document.querySelector("dialog[open]")) store.set({ tool: null });
  });

  map.on("click", (lonLat) => {
    const tool = st().tool;
    if (!tool) return;
    if (done) {
      points = [];
      done = false;
    }
    if (tool === "area" && points.length >= 3) {
      // Clicking the first point closes the polygon.
      const [x0, y0] = map.project(...points[0]);
      const [x1, y1] = map.project(...lonLat);
      if (Math.hypot(x1 - x0, y1 - y0) < 12) {
        done = true;
        update();
        return;
      }
    }
    points.push(lonLat);
    if (tool === "profile" && points.length === 2) done = true;
    update();
  });

  // Pointer coordinates (degrees and UTM) while the tools are open.
  map.container.addEventListener("pointermove", (ev) => {
    if (st().mode !== "tools") return;
    const r = map.container.getBoundingClientRect();
    const [lon, lat] = map.unproject(ev.clientX - r.left, ev.clientY - r.top);
    const u = utm(lon, lat);
    coords.textContent = `${fmtNumber(Math.abs(lat), 4)}° ${lat >= 0 ? "N" : "S"}, ${fmtNumber(Math.abs(lon), 4)}° ${lon >= 0 ? "E" : "W"}  ·  UTM ${u.zone}${u.hemi} ${Math.round(u.easting)} E ${Math.round(u.northing)} N`;
  });

  function drawLayer() {
    const [w, hgt] = map.size();
    layer.setAttribute("width", w);
    layer.setAttribute("height", hgt);
    layer.replaceChildren();
    if (!st().tool || !points.length) return;
    const xy = points.map((p) => map.project(...p));
    const closed = st().tool === "area" && done;
    const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join("") + (closed ? "Z" : "");
    layer.append(
      s("path", { d, class: closed ? "tool-shape tool-shape-closed" : "tool-shape" }),
      ...xy.map(([x, y]) => s("circle", { cx: x, cy: y, r: 4, class: "tool-vertex" })),
    );
    if (hoverSample) {
      const [x, y] = map.project(...hoverSample);
      layer.append(s("circle", { cx: x, cy: y, r: 6, class: "tool-hover" }));
    }
  }
  map.onRender(drawLayer);

  // Graticule: NASA GIBS's latitude/longitude lines in the labels pane.
  gridToggle.addEventListener("change", applyGrid);
  function applyGrid() {
    map.removeTileLayer("graticule");
    const g = st().gibs?.layers.find((l) => l.id === "Graticule_15m");
    gridRow.hidden = !g || !st().online;
    if (!g || !gridToggle.checked || st().mode !== "tools") return;
    map.setTileLayer("graticule", g.template, { maxZoom: g.max_zoom, opacity: 0.6, pane: "labels" });
  }

  // ---- Results ----
  function update() {
    drawLayer();
    const tool = st().tool;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.tool === tool));
    actions.hidden = !tool || tool === "profile";
    finish.disabled = done || points.length < (tool === "area" ? 3 : 2);
    hint.textContent = tool ? t(`tools.hint_${tool}`) : "";
    result.replaceChildren();
    if (!tool || !points.length) return;
    if (tool === "distance") {
      result.append(h("p", { class: "tool-figure", text: t("tools.distance_value", { km: fmtNumber(pathKm(points), pathKm(points) < 10 ? 2 : 1) }) }));
    } else if (tool === "area") {
      if (points.length < 3) return;
      result.append(h("p", { class: "tool-figure", text: t("tools.area_value", { km2: fmtNumber(polygonAreaKm2(points), 1) }) }));
      if (done && st().site) result.append(...areaStats());
    } else if (tool === "profile" && done) {
      result.append(...profile());
    }
  }

  // Classes (and confidence) of every pass, cached per site and threshold set.
  let classCache = { key: null, passes: [] };
  function classifiedFull(p) {
    const site = st().site;
    const key = `${st().siteId}|${JSON.stringify(thresholds())}`;
    if (classCache.key !== key) classCache = { key, passes: [] };
    if (!classCache.passes[p]) {
      const L = site.layers;
      classCache.passes[p] = classifyGrid(
        { hhQ: site.passPlane("hh", p), hvQ: site.passPlane("hv", p), spQ: site.passPlane("hh_spread", p), veg: site.staticPlane("veg") },
        { hh: L.hh, hv: L.hv, hh_spread: L.hh_spread },
        thresholds(),
      );
    }
    return classCache.passes[p];
  }
  const classified = (p) => classifiedFull(p).cls;

  // The map's colours; low-confidence pixels are coded 10 + class in a lighter shade.
  const EXPORT_PALETTE = [[0, 0, 0], [235, 235, 235], [0, 114, 178], [230, 159, 0], [128, 128, 128]];
  EXPORT_PALETTE[11] = [205, 205, 205];
  EXPORT_PALETTE[12] = [110, 160, 196];
  EXPORT_PALETTE[13] = [242, 201, 112];

  function exportMeta() {
    const site = st().site;
    const s0 = site.summary;
    const pass = s0.passes[st().passIndex];
    const tag = s0.synthetic ? "_SYNTHETIC" : "";
    // A technical key for GIS metadata, like the CSV headers (TIFF text is 7-bit ASCII).
    const head = `Under the Canopy, ${st().siteId}, NISAR pass ${pass.date}${s0.synthetic ? ", SYNTHETIC DATA, not real radar" : ""}`;
    return { site, s0, pass, p: st().passIndex, name: (kind) => `${st().siteId}_${pass.date}_${kind}${tag}.tif`, head };
  }

  function save(name, bytes) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/tiff" }));
    const a = h("a", { href: url, download: name, hidden: true });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  exportClasses.addEventListener("click", () => {
    const { site, s0, p, name, head } = exportMeta();
    const { cls, conf } = classifiedFull(p);
    const codes = Uint8Array.from(cls, (c, i) => (conf[i] === 0 && c !== CLASS.NODATA && c !== CLASS.EXCLUDED ? c + 10 : c));
    const th = thresholds();
    const description = `${head}. Classes: 0 no radar, 1 dry, 2 open water, 3 water under vegetation (hidden flood), 4 built-up (not assessed); 11-13 the same, low confidence. Thresholds dB: ${Object.entries(th).map(([k, v]) => `${k}=${v}`).join(" ")}`;
    save(name("classes"), geoTiff({ width: site.width, height: site.height, bounds: s0.grid.bounds, bands: [codes], palette: EXPORT_PALETTE, nodata: 0, description }));
  });

  exportRadar.addEventListener("click", () => {
    const { site, s0, p, name, head } = exportMeta();
    const L = site.layers;
    const db = (layerName) => Float32Array.from(site.passPlane(layerName, p), (q) => decodeDb(q, L[layerName]) ?? NaN);
    const description = `${head}. Band 1 HH, band 2 HV: RTC gamma0 backscatter in dB from NISAR L2 GCOV, on the app's site grid in ${L.hh.scale} dB steps; NaN no data.`;
    save(name("hh_hv_db"), geoTiff({ width: site.width, height: site.height, bounds: s0.grid.bounds, bands: [db("hh"), db("hv")], nodata: "nan", description }));
  });

  function updateExport() {
    const site = st().site;
    exportBox.hidden = !site;
    if (!site) return;
    const [, south, , north] = site.summary.grid.bounds;
    exportNote.textContent = t("tools.export_note", {
      date: fmtDate(site.summary.passes[st().passIndex].date),
      w: site.width,
      h: site.height,
      m: fmtNumber(((north - south) / site.height) * 111320, 0), // cell height; a degree of latitude ≈ 111 km
    });
  }

  function areaStats() {
    const site = st().site;
    const s0 = site.summary;
    const mask = rasterizePolygon(points, { width: site.width, height: site.height, bounds: s0.grid.bounds });
    if (!mask.some(Boolean)) return [h("p", { class: "muted small", text: t("tools.area_outside") })];
    const rows = s0.passes.map((p, i) => ({ date: p.date, a: areasInMask(classified(i), mask, site.rowAreaKm2, site.width) }));
    const peak = rows.reduce((b, r) => (r.a[CLASS.FLOODED_VEG] > b.a[CLASS.FLOODED_VEG] ? r : b), rows[0]);
    const lead2 = h("p", {
      text: t("tools.area_peak", { km2: fmtNumber(peak.a[CLASS.FLOODED_VEG], 2), date: fmtDate(peak.date), water: fmtNumber(peak.a[CLASS.OPEN_WATER], 2) }),
    });
    const chart = stackedColumns(rows);
    const csv = ["date,open_water_km2,hidden_flood_km2,dry_km2,built_up_km2,no_radar_km2"]
      .concat(rows.map((r) => [r.date, r.a[CLASS.OPEN_WATER], r.a[CLASS.FLOODED_VEG], r.a[CLASS.DRY], r.a[CLASS.EXCLUDED], r.a[CLASS.NODATA]].map((v) => (typeof v === "number" ? v.toFixed(4) : v)).join(",")))
      .join("\n");
    const geo = {
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [[...points, points[0]]] },
      properties: { site: st().siteId, thresholds: thresholds(), passes: rows.map((r) => ({ date: r.date, open_water_km2: r.a[CLASS.OPEN_WATER], hidden_flood_km2: r.a[CLASS.FLOODED_VEG], no_radar_km2: r.a[CLASS.NODATA] })) },
    };
    const dl = h(
      "p",
      { class: "tool-downloads" },
      download(t("tools.download_csv"), `${st().siteId}_area.csv`, csv, "text/csv"),
      download(t("tools.download_geojson"), `${st().siteId}_area.geojson`, JSON.stringify(geo), "application/geo+json"),
    );
    const table = srTable(
      t("tools.area_table"),
      [t("chart.col_date"), t("legend.open_water"), t("legend.hidden_flood")],
      rows.map((r) => [fmtDate(r.date), fmtNumber(r.a[CLASS.OPEN_WATER], 2), fmtNumber(r.a[CLASS.FLOODED_VEG], 2)]),
    );
    return [lead2, chart, legendRow(), dl, table];
  }

  function legendRow() {
    return h(
      "ul",
      { class: "legend-inline" },
      h("li", {}, h("span", { class: "swatch swatch-hidden" }), t("legend.hidden_flood")),
      h("li", {}, h("span", { class: "swatch swatch-water" }), t("legend.open_water")),
    );
  }

  function download(label, name, text, type) {
    const a = h("a", { class: "btn btn-small", text: label, download: name });
    a.href = URL.createObjectURL(new Blob([text], { type }));
    return a;
  }

  // Columns per pass: open water at the base, hidden flood above, a 2 px surface gap between.
  function stackedColumns(rows) {
    const W = 340;
    const H = 150;
    const M = { l: 40, r: 8, t: 10, b: 24 };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "area-chart tool-chart", role: "img", "aria-label": t("tools.area_table") });
    const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
    const t0 = day(rows[0].date);
    const t1 = Math.max(day(rows.at(-1).date), t0 + 1);
    const x = (iso) => M.l + 10 + ((day(iso) - t0) / (t1 - t0)) * (W - M.l - M.r - 20);
    const yMax = Math.max(...rows.map((r) => r.a[CLASS.OPEN_WATER] + r.a[CLASS.FLOODED_VEG]), 0.01);
    const y = scale([0, yMax * 1.1], [H - M.b, M.t]);
    for (const v of ticks(0, yMax, 3)) {
      svg.append(
        s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }),
        s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, v === 0 || v >= 10 ? 0 : v < 1 ? 2 : 1)),
      );
    }
    const bw = Math.min(18, ((W - M.l - M.r) / rows.length) * 0.6);
    for (const r of rows) {
      const cx = x(r.date);
      const ow = r.a[CLASS.OPEN_WATER];
      const fv = r.a[CLASS.FLOODED_VEG];
      const base = y(0);
      const owTop = y(ow);
      const fvTop = y(ow + fv);
      const g = s("g", { class: "tool-col", tabindex: "0" }, s("title", {}, t("tools.col_tip", { date: fmtDate(r.date), water: fmtNumber(ow, 2), hidden: fmtNumber(fv, 2) })));
      if (ow > 0) g.append(s("rect", { x: cx - bw / 2, y: owTop, width: bw, height: Math.max(0, base - owTop), fill: CLASS_FILL[CLASS.OPEN_WATER] }));
      if (fv > 0) g.append(s("rect", { x: cx - bw / 2, y: fvTop, width: bw, height: Math.max(0, owTop - fvTop - 2), rx: 2, fill: CLASS_FILL[CLASS.FLOODED_VEG] }));
      svg.append(g);
    }
    svg.append(
      s("text", { x: M.l, y: H - 6, class: "tick" }, fmtDate(rows[0].date, "short")),
      s("text", { x: W - M.r, y: H - 6, class: "tick", "text-anchor": "end" }, fmtDate(rows.at(-1).date, "short")),
    );
    return svg;
  }

  // Cross-section of the current pass along the drawn line.
  function profile() {
    const site = st().site;
    if (!site) return [h("p", { class: "muted small", text: t("tools.profile_needs_site") })];
    const [a, b] = points;
    const n = 180;
    const total = haversineKm(a, b);
    const L = site.layers;
    const p = st().passIndex;
    const cls = classified(p);
    const hhQ = site.passPlane("hh", p);
    const hvQ = site.passPlane("hv", p);
    const staticNames = site.summary.grid_stack.static_layers.map((l) => l.name);
    const height = staticNames.includes("canopy_height_m") ? site.staticPlane("canopy_height_m") : null;
    const hand = staticNames.includes("hand_m") ? site.staticPlane("hand_m") : null;
    const samples = [];
    for (let k = 0; k <= n; k += 1) {
      const f = k / n;
      const ll = [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
      const cell = site.lonLatToGrid(...ll);
      const i = cell ? cell.row * site.width + cell.col : -1;
      samples.push({
        km: f * total,
        ll,
        hh: i >= 0 ? decodeDb(hhQ[i], L.hh) : null,
        hv: i >= 0 ? decodeDb(hvQ[i], L.hv) : null,
        cls: i >= 0 ? cls[i] : null,
        height: i >= 0 && height && height[i] !== 255 ? height[i] : null,
        hand: i >= 0 && hand && hand[i] !== 255 ? hand[i] * 0.5 : null,
      });
    }
    if (!samples.some((x) => x.cls !== null)) return [h("p", { class: "muted small", text: t("tools.area_outside") })];
    const W = 340;
    const M = { l: 40, r: 8 };
    const x = scale([0, total], [M.l, W - M.r]);
    const top = { y0: 8, y1: 118 };
    const strip = { y0: 124, y1: 136 };
    const low = { y0: 144, y1: 196 };
    const H = 220;
    const dbs = samples.flatMap((v) => [v.hh, v.hv]).filter((v) => v !== null);
    const lo = Math.floor(Math.min(...dbs, -25) / 5) * 5;
    const hi = Math.ceil(Math.max(...dbs, 0) / 5) * 5;
    const y = scale([lo, hi], [top.y1, top.y0]);
    // With HAND the lower panel is the forest itself: the DEM surface (treetops over forest, as the
    // X-band DEM sees them), the ground estimated as that surface minus GEDI's canopy height, and
    // the trees between. Without HAND, canopy height alone.
    const surface = (v) => (v.hand === null ? null : v.hand);
    const ground = (v) => (v.hand === null ? null : Math.max(0, v.hand - (v.height ?? 0)));
    const hMax = Math.max(5, ...samples.map((v) => (hand ? surface(v) ?? 0 : v.height ?? 0)));
    const yh = scale([0, hMax * 1.1], [low.y1, low.y0]);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "area-chart tool-chart profile-chart", role: "img", "aria-label": t("tools.profile_aria", { km: fmtNumber(total, 1) }) });
    for (const v of ticks(lo, hi, 3)) {
      svg.append(
        s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }),
        s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)),
      );
    }
    svg.append(s("text", { x: M.l - 6, y: top.y0 - 0, class: "tick", "text-anchor": "end" }, "dB"));
    const line = (key) => {
      let d = "";
      let pen = false;
      for (const v of samples) {
        if (v[key] === null) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${x(v.km).toFixed(1)},${y(v[key]).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    svg.append(
      s("path", { d: line("hh"), class: "profile-line", stroke: HH_COLOUR }),
      s("path", { d: line("hv"), class: "profile-line", stroke: HV_COLOUR }),
    );
    // Class strip: the map's own colours; no radar left empty with a hairline.
    const step = (W - M.l - M.r) / n;
    samples.forEach((v) => {
      if (v.cls === null || v.cls === CLASS.NODATA) return;
      svg.append(s("rect", { x: x(v.km) - step / 2, y: strip.y0, width: step + 0.3, height: strip.y1 - strip.y0, fill: CLASS_FILL[v.cls] }));
    });
    svg.append(s("line", { x1: M.l, x2: W - M.r, y1: strip.y1 + 0.5, y2: strip.y1 + 0.5, class: "grid" }));
    // The lower panel has its own scale (never a second axis on the same plot).
    const band = (top, bottom) => {
      let d = "";
      const pts = samples.filter((v) => top(v) !== null);
      if (pts.length < 2) return "";
      d = `M${x(pts[0].km).toFixed(1)},${yh(top(pts[0])).toFixed(1)}`;
      for (const v of pts) d += `L${x(v.km).toFixed(1)},${yh(top(v)).toFixed(1)}`;
      for (const v of [...pts].reverse()) d += `L${x(v.km).toFixed(1)},${yh(bottom(v)).toFixed(1)}`;
      return `${d}Z`;
    };
    if (hand) {
      svg.append(
        s("path", { d: band(ground, () => 0), class: "profile-ground" }),
        s("path", { d: band(surface, ground), class: "profile-canopy" }),
      );
    } else if (height) {
      svg.append(s("path", { d: band((v) => v.height ?? 0, () => 0), class: "profile-canopy" }));
    }
    if (hand || height) {
      svg.append(
        s("text", { x: M.l - 6, y: low.y0 + 8, class: "tick", "text-anchor": "end" }, `${fmtNumber(hMax, 0)} m`),
        s("text", { x: M.l - 6, y: low.y1, class: "tick", "text-anchor": "end" }, "0"),
      );
    }
    svg.append(
      s("text", { x: M.l, y: H - 6, class: "tick" }, "0 km"),
      s("text", { x: W - M.r, y: H - 6, class: "tick", "text-anchor": "end" }, `${fmtNumber(total, 1)} km`),
    );
    const cursor = s("line", { x1: 0, x2: 0, y1: top.y0, y2: low.y1, class: "cursor", visibility: "hidden" });
    svg.append(cursor);
    const tip = h("p", { class: "profile-tip", "aria-live": "polite", text: t("tools.profile_hover") });
    const name = (c) => (c === null || c === CLASS.NODATA ? t("tools.no_radar") : t(`tools.class_${c}`));
    svg.addEventListener("pointermove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const k = Math.max(0, Math.min(n, Math.round(((px - M.l) / (W - M.l - M.r)) * n)));
      const v = samples[k];
      cursor.setAttribute("x1", x(v.km));
      cursor.setAttribute("x2", x(v.km));
      cursor.setAttribute("visibility", "visible");
      tip.textContent = t("tools.profile_tip", {
        km: fmtNumber(v.km, 2),
        hh: v.hh === null ? "–" : fmtNumber(v.hh, 1),
        hv: v.hv === null ? "–" : fmtNumber(v.hv, 1),
        cls: name(v.cls),
        height: v.height === null ? "–" : fmtNumber(v.height, 0),
        hand: v.hand === null ? "–" : fmtNumber(v.hand, 1),
      });
      hoverSample = v.ll;
      drawLayer();
    });
    svg.addEventListener("pointerleave", () => {
      cursor.setAttribute("visibility", "hidden");
      hoverSample = null;
      drawLayer();
    });
    const key = h(
      "ul",
      { class: "legend-inline" },
      h("li", {}, h("span", { class: "line-key", style: `background:${HH_COLOUR}` }), "HH"),
      h("li", {}, h("span", { class: "line-key", style: `background:${HV_COLOUR}` }), "HV"),
      h("li", {}, h("span", { class: "swatch swatch-hidden" }), t("legend.hidden_flood")),
      h("li", {}, h("span", { class: "swatch swatch-water" }), t("legend.open_water")),
      ...(hand ? [h("li", {}, h("span", { class: "swatch swatch-ground" }), t("tools.ground_est"))] : []),
      ...(height ? [h("li", {}, h("span", { class: "swatch swatch-canopy" }), t(hand ? "tools.trees" : "tools.canopy_height"))] : []),
    );
    const lead3 = h("p", { class: "muted small", text: t("tools.profile_lead", { date: fmtDate(site.summary.passes[p].date) }) });
    const rows = samples.filter((_, k) => k % 15 === 0).map((v) => [fmtNumber(v.km, 2), v.hh === null ? "–" : fmtNumber(v.hh, 1), v.hv === null ? "–" : fmtNumber(v.hv, 1), name(v.cls)]);
    return [lead3, svg, tip, key, srTable(t("tools.profile_table"), ["km", "HH (dB)", "HV (dB)", t("tools.class")], rows)];
  }

  watch(store, ["tool", "mode", "site", "passIndex", "scientist", "gibs", "online"], (state, _prev, changed) => {
    root.hidden = state.mode !== "tools";
    coords.hidden = state.mode !== "tools";
    if (state.mode !== "tools" && state.tool) {
      store.set({ tool: null });
      return;
    }
    if (changed.includes("site")) {
      points = [];
      done = false;
    }
    document.body.classList.toggle("is-drawing", Boolean(state.tool));
    applyGrid();
    update();
    updateExport();
  });
}
