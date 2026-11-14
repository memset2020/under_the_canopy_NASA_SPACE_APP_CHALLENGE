// Radar feature space (F45): every pixel of the pass placed by what NISAR measured, HH against
// the HH−HV gap (the two numbers the rules use), with the rule boundaries drawn on top. Drag a
// box to light those pixels up on the map; the spot picked on the map is ringed here. The
// boundaries follow scientist mode's sliders, so moving a threshold moves its line.
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtNumber } from "./i18n.js";
import { CLASS, classifyGrid } from "./rules.js";
import { note } from "./readable.js";

export const id = "space";
export const slot = "sidebar";

const X = [-30, 5]; // HH, dB
const Y = [-2, 16]; // HH − HV, dB
const BIN = 0.25; // the stack's quantisation step, so every bin is exact
const NX = (X[1] - X[0]) / BIN;
const NY = (Y[1] - Y[0]) / BIN;
const CLASS_RGB = {
  [CLASS.OPEN_WATER]: [0, 114, 178],
  [CLASS.FLOODED_VEG]: [230, 159, 0],
  [CLASS.EXCLUDED]: [120, 120, 120],
  [CLASS.DRY]: [232, 238, 234],
};

// Counts per (HH, gap) bin and the class most of a bin's pixels got. Pure; unit-tested.
export function binPixels(hhDb, hvDb, cls) {
  const counts = new Uint32Array(NX * NY);
  const byClass = new Uint32Array(NX * NY * 5);
  for (let i = 0; i < hhDb.length; i += 1) {
    const hh = hhDb[i];
    const hv = hvDb[i];
    if (hh === null || hv === null) continue;
    const bx = Math.floor((hh - X[0]) / BIN);
    const by = Math.floor((hh - hv - Y[0]) / BIN);
    if (bx < 0 || bx >= NX || by < 0 || by >= NY) continue;
    const k = by * NX + bx;
    counts[k] += 1;
    byClass[k * 5 + cls[i]] += 1;
  }
  const major = new Uint8Array(NX * NY);
  for (let k = 0; k < counts.length; k += 1) {
    let best = 0;
    for (let c = 1; c < 5; c += 1) if (byClass[k * 5 + c] > byClass[k * 5 + best]) best = c;
    major[k] = best;
  }
  return { counts, major };
}

export function init({ store, map, t, root }) {
  const W = 340;
  const H = 210;
  const M = { l: 40, r: 8, t: 8, b: 36 };
  const PW = W - M.l - M.r;
  const PH = H - M.t - M.b;
  const sx = (v) => M.l + ((v - X[0]) / (X[1] - X[0])) * PW;
  const sy = (v) => M.t + PH - ((v - Y[0]) / (Y[1] - Y[0])) * PH;
  const inv = (px, py) => [X[0] + ((px - M.l) / PW) * (X[1] - X[0]), Y[0] + ((M.t + PH - py) / PH) * (Y[1] - Y[0])];

  const heading = h("h2", { text: t("space.title") });
  const lead = note("info", t("space.lead"));
  const byClass = h("input", { type: "checkbox", id: "space-by-class", checked: true });
  const canvas = h("canvas", { width: NX, height: NY, class: "space-canvas", "aria-hidden": "true" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "space-svg", role: "img" });
  const wrap = h("div", { class: "space-wrap" }, canvas, svg);
  const readout = h("p", { class: "space-readout", "aria-live": "polite" });
  const clearSel = h("button", { type: "button", class: "btn btn-small", text: t("space.clear"), hidden: true });
  const key = h(
    "ul",
    { class: "legend-inline" },
    h("li", {}, h("span", { class: "swatch swatch-hidden" }), t("legend.hidden_flood")),
    h("li", {}, h("span", { class: "swatch swatch-water" }), t("legend.open_water")),
    h("li", {}, h("span", { class: "swatch swatch-dry" }), t("space.dry")),
  );
  root.append(heading, lead, h("label", { class: "check" }, byClass, t("space.by_class")), wrap, key, readout, clearSel, note("limit", t("space.note")));

  // Highlight of brushed pixels on the map, above the class layer.
  const brushCanvas = h("canvas", { class: "overlay-brush", "aria-hidden": "true" });
  let sel = null; // { x0, x1, y0, y1 } in dB
  let data = null; // { hh, hv, cls, bins }

  const thresholds = () => {
    const st = store.get();
    return st.scientist?.enabled ? st.scientist.thresholds : st.site?.summary.thresholds;
  };

  function compute() {
    const st = store.get();
    const site = st.site;
    if (!site) return null;
    const p = st.passIndex;
    const L = site.layers;
    const hhQ = site.passPlane("hh", p);
    const hvQ = site.passPlane("hv", p);
    const n = hhQ.length;
    const hh = new Array(n);
    const hv = new Array(n);
    for (let i = 0; i < n; i += 1) {
      hh[i] = hhQ[i] === L.hh.nodata ? null : hhQ[i] * L.hh.scale + L.hh.offset;
      hv[i] = hvQ[i] === L.hv.nodata ? null : hvQ[i] * L.hv.scale + L.hv.offset;
    }
    const { cls } = classifyGrid({ hhQ, hvQ, spQ: site.passPlane("hh_spread", p), veg: site.staticPlane("veg") }, { hh: L.hh, hv: L.hv, hh_spread: L.hh_spread }, thresholds());
    return { hh, hv, cls, bins: binPixels(hh, hv, cls) };
  }

  function paintDensity() {
    const ctx = canvas.getContext("2d");
    const img = ctx.createImageData(NX, NY);
    const { counts, major } = data.bins;
    let max = 1;
    for (const c of counts) max = Math.max(max, c);
    const lmax = Math.log1p(max);
    for (let by = 0; by < NY; by += 1) {
      for (let bx = 0; bx < NX; bx += 1) {
        const k = by * NX + bx;
        if (!counts[k]) continue;
        const o = ((NY - 1 - by) * NX + bx) * 4; // row 0 of the canvas is the top (largest gap)
        const rgb = byClass.checked ? CLASS_RGB[major[k]] ?? CLASS_RGB[CLASS.DRY] : CLASS_RGB[CLASS.DRY];
        img.data[o] = rgb[0];
        img.data[o + 1] = rgb[1];
        img.data[o + 2] = rgb[2];
        img.data[o + 3] = Math.round(40 + 215 * (Math.log1p(counts[k]) / lmax)); // log density: one pixel still shows
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawAxes() {
    svg.replaceChildren();
    const thr = thresholds();
    for (const v of [-30, -20, -10, 0]) {
      svg.append(
        s("line", { x1: sx(v), x2: sx(v), y1: M.t, y2: M.t + PH, class: "grid" }),
        s("text", { x: sx(v), y: M.t + PH + 14, class: "tick", "text-anchor": "middle" }, fmtNumber(v, 0)),
      );
    }
    for (const v of [0, 5, 10, 15]) {
      svg.append(
        s("line", { x1: M.l, x2: M.l + PW, y1: sy(v), y2: sy(v), class: "grid" }),
        s("text", { x: M.l - 6, y: sy(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)),
      );
    }
    svg.append(
      s("text", { x: M.l + PW / 2, y: H - 3, class: "tick", "text-anchor": "middle" }, t("space.x_axis")),
      s("text", { x: 10, y: M.t + PH / 2, class: "tick", "text-anchor": "middle", transform: `rotate(-90 10 ${M.t + PH / 2})` }, t("space.y_axis")),
    );
    if (!thr) return;
    const clampX = (v) => Math.max(X[0], Math.min(X[1], v));
    const clampY = (v) => Math.max(Y[0], Math.min(Y[1], v));
    // Water under the trees (vegetated pixels): HH above fv_hh and the gap above fv_ratio.
    const fx = sx(clampX(thr.fv_hh_db));
    const fy = sy(clampY(thr.fv_ratio_db));
    svg.append(s("path", { d: `M${fx},${M.t}V${fy}H${M.l + PW}`, class: "space-rule space-rule-hidden" }));
    // Each label sits inside its own region, clear of the data's densest corner.
    svg.append(s("text", { x: M.l + PW - 4, y: Math.min(M.t + PH - 4, fy + 14), class: "space-rule-label", "text-anchor": "end" }, t("space.rule_hidden")));
    // Open water: HH below ow_hh and HV below ow_hv, i.e. the gap above HH − ow_hv (a diagonal).
    const ox = sx(clampX(thr.ow_hh_db));
    const yAt = (hh) => sy(clampY(hh - thr.ow_hv_db));
    svg.append(s("path", { d: `M${sx(X[0])},${yAt(X[0])}L${ox},${yAt(thr.ow_hh_db)}V${M.t}`, class: "space-rule space-rule-water" }));
    svg.append(s("text", { x: M.l + 4, y: sy(12), class: "space-rule-label" }, t("space.rule_water")));
    // The spot picked on the map ("This spot").
    const st = store.get();
    if (st.selected && data) {
      const i = st.selected.row * st.site.width + st.selected.col;
      if (data.hh[i] !== null && data.hv[i] !== null) {
        svg.append(s("circle", { cx: sx(data.hh[i]), cy: sy(data.hh[i] - data.hv[i]), r: 6, class: "space-spot" }));
      }
    }
    if (sel) {
      svg.append(s("rect", { x: sx(sel.x0), y: sy(sel.y1), width: sx(sel.x1) - sx(sel.x0), height: sy(sel.y0) - sy(sel.y1), class: "space-brush" }));
    }
  }

  function summarise() {
    let total = 0;
    const per = [0, 0, 0, 0, 0];
    for (let i = 0; i < data.cls.length; i += 1) {
      if (data.hh[i] === null || data.hv[i] === null) continue;
      total += 1;
      per[data.cls[i]] += 1;
    }
    svg.setAttribute("aria-label", t("space.aria", { n: fmtNumber(total, 0), hidden: fmtNumber((100 * per[CLASS.FLOODED_VEG]) / Math.max(total, 1), 0), water: fmtNumber((100 * per[CLASS.OPEN_WATER]) / Math.max(total, 1), 0) }));
  }

  function paintBrush() {
    const st = store.get();
    const site = st.site;
    if (!site || !data) return;
    brushCanvas.width = site.width;
    brushCanvas.height = site.height;
    const ctx = brushCanvas.getContext("2d");
    const img = ctx.createImageData(site.width, site.height);
    let km2 = 0;
    const per = [0, 0, 0, 0, 0];
    if (sel) {
      for (let i = 0; i < data.hh.length; i += 1) {
        const hh = data.hh[i];
        const hv = data.hv[i];
        if (hh === null || hv === null) continue;
        const gap = hh - hv;
        if (hh < sel.x0 || hh > sel.x1 || gap < sel.y0 || gap > sel.y1) continue;
        img.data.set([255, 255, 255, 235], i * 4);
        const a = site.rowAreaKm2[Math.floor(i / site.width)];
        km2 += a;
        per[data.cls[i]] += a;
      }
    }
    ctx.putImageData(img, 0, 0);
    brushCanvas.hidden = !sel;
    clearSel.hidden = !sel;
    readout.textContent = sel
      ? t("space.selected", { km2: fmtNumber(km2, 2), hidden: fmtNumber(per[CLASS.FLOODED_VEG], 2), water: fmtNumber(per[CLASS.OPEN_WATER], 2) })
      : t("space.hint");
  }

  // Brushing: drag a box on the plot.
  let drag = null;
  const toPlot = (ev) => {
    const r = svg.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * W, ((ev.clientY - r.top) / r.height) * H];
  };
  svg.addEventListener("pointerdown", (ev) => {
    if (!data) return;
    svg.setPointerCapture(ev.pointerId);
    drag = inv(...toPlot(ev));
  });
  svg.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const [x, y] = inv(...toPlot(ev));
    sel = { x0: Math.min(drag[0], x), x1: Math.max(drag[0], x), y0: Math.min(drag[1], y), y1: Math.max(drag[1], y) };
    drawAxes();
  });
  svg.addEventListener("pointerup", () => {
    if (!drag) return;
    drag = null;
    if (sel && (sel.x1 - sel.x0 < BIN || sel.y1 - sel.y0 < BIN)) sel = null; // a click, not a box
    drawAxes();
    paintBrush();
  });
  clearSel.addEventListener("click", () => {
    sel = null;
    drawAxes();
    paintBrush();
  });
  byClass.addEventListener("change", () => data && paintDensity());

  watch(store, ["site", "passIndex", "scientist", "selected", "mode"], (st, _prev, changed) => {
    root.hidden = !st.site;
    if (!st.site) {
      map.removeOverlay("brush");
      return;
    }
    if (changed.includes("site")) {
      sel = null;
      map.removeOverlay("brush");
      map.addOverlay("brush", brushCanvas, st.site.summary.grid.bounds);
    }
    if (changed.some((k) => k === "site" || k === "passIndex" || k === "scientist")) {
      if (st.mode !== "tools" && data && !changed.includes("site")) {
        data = null; // recompute lazily when Tools mode opens
      } else {
        data = compute();
        paintDensity();
        summarise();
        paintBrush();
      }
    }
    if (st.mode === "tools" && !data) {
      data = compute();
      paintDensity();
      summarise();
      paintBrush();
    }
    brushCanvas.hidden = !sel || st.mode !== "tools";
    drawAxes();
  });
}
