// F03 explain this pixel: verdict in plain words, the radar numbers behind it, and its season.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { CLASS, VEG, classifyPixel, verdict } from "./rules.js";

export const id = "explain";
export const slot = "sidebar";

const W = 340;
const H = 190;
const M = { l: 34, r: 8, t: 10, b: 34 };
const CLASS_NAME = {
  [CLASS.NODATA]: "nodata",
  [CLASS.DRY]: "dry",
  [CLASS.OPEN_WATER]: "water",
  [CLASS.FLOODED_VEG]: "hidden",
  [CLASS.EXCLUDED]: "excluded",
};

export function thresholdsFor(state) {
  const sci = state.scientist;
  return sci?.enabled && sci.thresholds ? sci.thresholds : state.site.summary.thresholds;
}

function reason(v, hh, hv, th, t) {
  const n = (x) => fmtNumber(x, 1);
  const params = { hh: n(hh), hv: n(hv), ratio: n(hh - hv), fv: n(th.fv_hh_db), ow: n(th.ow_hh_db) };
  return t(`explain.reason_${v}`, params);
}

function drawSeries(svg, px, results, passes, passIndex, th) {
  svg.replaceChildren();
  const vals = [...px.hh, ...px.hv, ...(px.vv ?? [])].filter((v) => v !== null);
  if (!vals.length) return;
  const lo = Math.min(...vals, th.ow_hv_db) - 2;
  const hi = Math.max(...vals.map((v) => v), th.fv_hh_db) + 3;
  const x = scale([0, passes.length - 1], [M.l, W - M.r]);
  const y = scale([lo, hi], [H - M.b, M.t]);

  for (const v of ticks(lo, hi, 4)) {
    svg.append(
      s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }),
      s("text", { x: M.l - 5, y: y(v) + 3, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)),
    );
  }
  // Speckle/heterogeneity band around HH: wide band = less trustworthy.
  const band = [];
  px.hh.forEach((v, i) => v !== null && band.push([x(i), y(v + px.spread[i])]));
  for (let i = px.hh.length - 1; i >= 0; i -= 1) {
    if (px.hh[i] !== null) band.push([x(i), y(px.hh[i] - px.spread[i])]);
  }
  if (band.length > 2) svg.append(s("path", { d: `M${band.join("L")}Z`, class: "spread-band" }));

  svg.append(
    s("line", { x1: M.l, x2: W - M.r, y1: y(th.fv_hh_db), y2: y(th.fv_hh_db), class: "thr thr-fv" }),
    s("line", { x1: M.l, x2: W - M.r, y1: y(th.ow_hh_db), y2: y(th.ow_hh_db), class: "thr thr-ow" }),
  );
  const line = (series, cls) => {
    let d = "";
    series.forEach((v, i) => {
      if (v === null) return;
      d += `${d && series[i - 1] !== null ? "L" : "M"}${x(i)},${y(v)}`;
    });
    svg.append(s("path", { d, class: cls }));
  };
  line(px.hv, "line-hv");
  line(px.hh, "line-hh");
  (px.vv ?? []).forEach((v, i) => {
    if (v !== null) svg.append(s("rect", { x: x(i) - 3, y: y(v) - 3, width: 6, height: 6, class: "dot-vv" }));
  });
  px.hh.forEach((v, i) => {
    if (v === null) return;
    svg.append(s("circle", { cx: x(i), cy: y(v), r: 3.2, class: `dot dot-${CLASS_NAME[results[i].cls]}${results[i].conf ? "" : " dot-low"}` }));
  });
  // C-band row: what Sentinel-1 said at each pass.
  const rowY = H - 12;
  px.cband.forEach((c, i) => {
    svg.append(s("rect", { x: x(i) - 4, y: rowY - 4, width: 8, height: 8, rx: 1.5, class: `cb cb-${c}` }));
  });
  svg.append(
    s("text", { x: M.l - 5, y: rowY + 3, class: "tick", "text-anchor": "end" }, "C"),
    s("line", { x1: x(passIndex), x2: x(passIndex), y1: M.t, y2: H - M.b + 4, class: "cursor" }),
  );
}

export function init({ store, map, t, root }) {
  const title = h("h2", { text: t("explain.title") });
  const empty = h("p", { class: "muted", text: t("explain.empty") });
  const verdictEl = h("p", { class: "verdict", "aria-live": "polite" });
  const reasonEl = h("p", { class: "verdict-reason" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "series-chart", role: "img" });
  const key = h(
    "ul",
    { class: "legend-inline" },
    h("li", {}, h("span", { class: "swatch swatch-line-hh" }), t("explain.key_hh")),
    h("li", {}, h("span", { class: "swatch swatch-line-hv" }), t("explain.key_hv")),
    h("li", {}, h("span", { class: "swatch swatch-band" }), t("explain.key_spread")),
    h("li", {}, h("span", { class: "swatch swatch-thr" }), t("explain.key_threshold")),
    h("li", {}, h("span", { class: "swatch swatch-cband" }), t("explain.key_cband")),
    h("li", { class: "key-vv" }, h("span", { class: "swatch swatch-vv" }), t("explain.key_vv")),
  );
  const facts = h("dl", { class: "facts" });
  const table = h("div");
  const close = h("button", { type: "button", class: "btn btn-small", text: t("explain.close") });
  const body = h("div", { class: "explain-body" }, verdictEl, reasonEl, svg, key, facts, table, close);
  root.append(title, empty, body);

  const marker = h("div", { class: "pixel-marker", "aria-hidden": "true" });
  map.panes.top.append(marker);
  map.onRender((m) => {
    const st = store.get();
    if (!st.site || !st.selected) {
      marker.hidden = true;
      return;
    }
    const [lon, lat] = st.site.gridToLonLat(st.selected.row, st.selected.col);
    const [px, py] = m.project(lon, lat);
    marker.hidden = false;
    marker.style.transform = `translate(${px}px, ${py}px)`;
  });

  map.on("click", ([lon, lat]) => {
    const site = store.get().site;
    if (!site || store.get().tool) return; // an analyst tool (tools.js) owns clicks while active
    const cell = site.lonLatToGrid(lon, lat);
    store.set({ selected: cell });
    if (!cell) empty.textContent = t("explain.outside");
    else if (store.get().mode === "site") root.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
  close.addEventListener("click", () => store.set({ selected: null }));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && store.get().selected && !document.querySelector("dialog[open]")) {
      store.set({ selected: null });
    }
  });

  watch(store, ["site", "selected", "passIndex", "scientist"], (state, _prev, changed) => {
    const { site, selected, passIndex } = state;
    root.hidden = !site;
    map.refresh();
    if (!site) return;
    if (changed.includes("site")) empty.textContent = t("explain.empty");
    body.hidden = !selected;
    empty.hidden = Boolean(selected);
    if (!selected) return;

    const th = thresholdsFor(state);
    const px = site.pixel(selected.row, selected.col);
    const passes = site.summary.passes;
    const results = passes.map((_, i) => classifyPixel(px.hh[i], px.hv[i], px.spread[i], px.veg, th));
    const now = results[passIndex];
    const v = verdict(now);
    verdictEl.textContent = t(`explain.verdict_${v}`);
    verdictEl.dataset.verdict = v;
    const hh = px.hh[passIndex];
    const hv = px.hv[passIndex];
    if (px.highGround && v === "dry") {
      reasonEl.textContent = t("explain.reason_high_ground");
    } else if (v === "uncertain") {
      reasonEl.textContent = t("explain.reason_uncertain", {
        leaning: t(`explain.leaning_${CLASS_NAME[now.cls]}`),
        spread: fmtNumber(px.spread[passIndex], 1),
      });
    } else if (!(px.highGround && v === "dry")) {
      reasonEl.textContent = hh === null ? t("explain.reason_nodata") : reason(v, hh, hv, th, t);
    }
    drawSeries(svg, px, results, passes, passIndex, th);
    key.querySelector(".key-vv").hidden = !(px.vv ?? []).some((v) => v !== null);
    const floodedPasses = results.filter((r) => r.cls === CLASS.OPEN_WATER || r.cls === CLASS.FLOODED_VEG).length;
    svg.setAttribute("aria-label", t("explain.series_aria", { n: floodedPasses, total: passes.length }));

    const cb = px.cband[passIndex];
    const [lon, lat] = site.gridToLonLat(selected.row, selected.col);
    const fact = (k, val) => [h("dt", { text: t(k) }), h("dd", { text: val })];
    facts.replaceChildren(
      ...fact("explain.fact_days", t("explain.days_value", { n: px.hydroperiodDays, season: site.summary.products.hydroperiod.season_days })),
      ...fact("explain.fact_cband", t(`explain.cband_${cb}`)),
      ...fact("explain.fact_cover", t(`explain.veg_${px.veg === VEG.YES ? "yes" : px.veg === VEG.BUILT_UP ? "built" : "other"}`)),
      ...(px.levelCm[passIndex] !== null && px.levelCm[passIndex] !== undefined
        ? fact("explain.fact_level", t(px.levelCm[passIndex] >= 0 ? "explain.level_rise" : "explain.level_fall", { cm: fmtNumber(Math.abs(px.levelCm[passIndex]), 0) }))
        : []),
      ...(px.canopyCoverPct !== null
        ? fact("explain.fact_canopy", t("explain.canopy_value", { cover: fmtNumber(px.canopyCoverPct, 0), height: fmtNumber(px.canopyHeightM, 0) }))
        : []),
      ...(px.highGround ? fact("explain.fact_terrain", t("explain.high_ground")) : []),
      ...(px.handM !== null && px.handM !== undefined ? fact("explain.fact_hand", t("explain.hand_value", { m: fmtNumber(px.handM, 1) })) : []),
      ...(px.glwdGroup ? fact("explain.fact_glwd", t(`explain.glwd_${px.glwdGroup}`)) : []),
      ...(px.jrcOccurrencePct !== null && px.jrcOccurrencePct !== undefined
        ? fact("explain.fact_usual", t("explain.usual_value", { pct: fmtNumber(px.jrcOccurrencePct, 0) }))
        : []),
      ...(px.vv?.[passIndex] !== null && px.vv?.[passIndex] !== undefined
        ? fact("explain.fact_cband_db", t("explain.cband_db", { vv: fmtNumber(px.vv[passIndex], 1), vh: fmtNumber(px.vh[passIndex], 1), date: fmtDate(site.summary.passes[passIndex].rtc_date) }))
        : []),
      // D-101: this cell's radar on this pass came from another track (outside its own swath).
      ...(site.layers.fill && site.passPlane("fill", passIndex)[selected.row * site.width + selected.col] === 1 && passes[passIndex].fill
        ? fact("explain.fact_track", t("explain.fill_value", { track: passes[passIndex].fill.track, date: fmtDate(passes[passIndex].fill.date), own: site.summary.track.number }))
        : []),
      ...fact("explain.fact_where", `${fmtNumber(lat, 4)}, ${fmtNumber(lon, 4)}`),
    );
    table.replaceChildren(
      srTable(
        t("explain.title"),
        [t("chart.col_date"), t("explain.key_hh"), t("explain.key_hv"), t("explain.col_verdict")],
        passes.map((p, i) => [
          fmtDate(p.date),
          fmtNumber(px.hh[i], 1),
          fmtNumber(px.hv[i], 1),
          t(`explain.verdict_${verdict(results[i])}`),
        ]),
      ),
    );
  });
}
