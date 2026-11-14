// Ground that moved: a profile across the map (docs/10 D-082). The standard reading of a
// deformation map: every measured cell within a swath either side of a line, by distance along
// it, with the median and the middle half (25th-75th percentile) per bin; for an earthquake, the
// USGS model along the same line and where the line crosses the modelled fault; the terrain
// under it in a strip of its own (no second y-axis). Lines A and B come from the pipeline; a
// viewer can draw their own with two clicks.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtNumber } from "./i18n.js";
import { crossingKm, planeIndex, planeValues, swathProfile } from "./motionmaps.js";
import { scaleWords } from "./motion.js";
import { shownLayer } from "./motionsteps.js";
import { note, setNote } from "./readable.js";

export const id = "motionprofile";
export const slot = "sidebar";

// The model counterpart of a shown layer id, if any.
export function modelOf(doc, pid) {
  if (!pid) return null;
  const cand = pid === "east" ? "model_east" : pid === "up" ? "model_up" : pid.startsWith("los_") ? `model_${pid}` : null;
  return cand && planeIndex(doc, cand) >= 0 ? cand : null;
}

export function init({ store, map, t, root }) {
  const heading = h("h2", { text: t("profile.title") });
  const lead = note("info", t("profile.lead"));
  const sel = h("select", { id: "profile-select" });
  const drawBtn = h("button", { type: "button", class: "btn btn-small", text: t("profile.draw") });
  const chart = h("div", { class: "profile-chart", "aria-live": "polite" });
  const caption = h("p", { class: "muted small" });
  root.append(heading, lead, h("div", { class: "motion-controls" }, h("label", { class: "field" }, h("span", { text: t("profile.line") }), sel), drawBtn), chart, caption);
  root.hidden = true;
  const svg = s("svg", { class: "vector-layer motion-layer", "aria-hidden": "true" });
  map.panes.top.append(svg);
  let first = null; // the first click while drawing

  const st = () => store.get();

  function fillSelect() {
    const b = st().motion;
    if (!b) return;
    const opts = (b.doc.profiles ?? []).map((p) => h("option", { value: p.id, text: t("profile.named", { id: p.id }) }));
    if (st().motionProfile?.id === "custom") opts.push(h("option", { value: "custom", text: t("profile.custom") }));
    sel.replaceChildren(...opts);
    sel.value = st().motionProfile?.id ?? "";
  }

  function render() {
    const b = st().motion;
    const prof = st().motionProfile;
    chart.replaceChildren();
    setNote(caption, "info", "");
    root.hidden = st().mode !== "motion" || !b;
    if (!b || !prof || !st().motionLayer) {
      if (b) chart.append(note("limit", t("profile.none")));
      return;
    }
    const { doc, view } = b;
    // The layer on the map, whatever step of the bar under it is shown (motionsteps.js).
    const layer = shownLayer(b, st().motionLayer, st().motionDate);
    if (!layer) return;
    const pid = layer.id;
    const res = swathProfile(layer.values, doc.grid, prof.a, prof.b, prof.half_width_km);
    if (!res || res.points.length < 10) {
      chart.append(note("info", t("profile.empty")));
      return;
    }
    const mid = modelOf(doc, pid);
    const model = mid ? swathProfile(planeValues(doc, view, planeIndex(doc, mid)), doc.grid, prof.a, prof.b, prof.half_width_km, res.bin) : null;
    const kd = planeIndex(doc, "dem");
    const terrain = kd >= 0 ? swathProfile(planeValues(doc, view, kd), doc.grid, prof.a, prof.b, prof.half_width_km, res.bin) : null;
    const fault = (doc.model?.trace ?? []).map((line) => crossingKm(prof.a, prof.b, line)).filter((d) => d !== null);
    chart.append(drawChart(layer, res, model, terrain, fault, prof));
    setNote(caption, "info", t("profile.caption", {
      len: fmtNumber(res.lengthKm, 0),
      w: fmtNumber(prof.half_width_km * 2, 0),
      bin: fmtNumber(res.bin, 1),
      n: fmtNumber(res.points.length, 0),
    }));
  }

  function drawChart(layer, res, model, terrain, fault, prof) {
    const W = 340;
    const H = 200;
    const TH = terrain ? 46 : 0;
    const M = { l: 42, r: 12, t: 12, b: 28 };
    const unit = layer.unit === "cm/yr" ? t("motion.cm_yr") : layer.unit === "1" ? "" : layer.unit;
    const vals = res.bins.flatMap((b) => [b.p25, b.p75]).filter(Number.isFinite);
    const pv = res.points.map((p) => p[1]);
    // The y range covers the middle half of every bin and most single cells, not the outliers.
    const sorted = [...pv].sort((a, b) => a - b);
    const q = (p) => sorted[Math.floor((sorted.length - 1) * p)];
    let lo = Math.min(q(0.01), ...vals, 0);
    let hi = Math.max(q(0.99), ...vals, 0);
    if (model) {
      const mv = model.bins.map((b) => b.med).filter(Number.isFinite);
      lo = Math.min(lo, ...mv);
      hi = Math.max(hi, ...mv);
    }
    const pad = (hi - lo) * 0.06 || 1;
    lo -= pad;
    hi += pad;
    const x = scale([0, res.lengthKm], [M.l, W - M.r]);
    const y = scale([lo, hi], [H - M.b, M.t]);
    const out = s("svg", { viewBox: `0 0 ${W} ${H + TH}`, class: "area-chart profile-svg", role: "img", "aria-label": t("profile.aria", { id: prof.id }) });
    if (Number.isFinite(layer.noise) && layer.noise > 0) {
      out.append(s("rect", { x: M.l, width: W - M.l - M.r, y: y(2 * layer.noise), height: Math.max(0, y(-2 * layer.noise) - y(2 * layer.noise)), class: "motion-noise" }));
    }
    for (const v of ticks(lo, hi, 4)) {
      out.append(s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: v === 0 ? "grid zero" : "grid" }), s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, Math.abs(hi - lo) < 5 ? 1 : 0)));
    }
    // Every cell, faint; at most 2,500 drawn (a regular subsample) to keep the chart light.
    const step = Math.max(1, Math.ceil(res.points.length / 2500));
    const dots = [];
    for (let k = 0; k < res.points.length; k += step) {
      const [d, v] = res.points[k];
      if (v < lo || v > hi) continue;
      dots.push(`M${x(d).toFixed(1)},${y(v).toFixed(1)}h0.01`);
    }
    out.append(s("path", { d: dots.join(""), class: "profile-dots" }));
    const good = res.bins.filter((b) => Number.isFinite(b.med));
    // Runs of consecutive bins, so a gap in the data stays a gap in the band.
    const runs = [];
    let run = [];
    res.bins.forEach((b) => {
      if (Number.isFinite(b.med)) run.push(b);
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    });
    if (run.length) runs.push(run);
    for (const r of runs) {
      const top = r.map((b) => `${x(b.s).toFixed(1)},${y(b.p75).toFixed(1)}`);
      const bot = [...r].reverse().map((b) => `${x(b.s).toFixed(1)},${y(b.p25).toFixed(1)}`);
      out.append(s("path", { d: `M${top.join("L")}L${bot.join("L")}Z`, class: "profile-band" }));
      out.append(s("path", { d: `M${r.map((b) => `${x(b.s).toFixed(1)},${y(b.med).toFixed(1)}`).join("L")}`, class: "profile-median" }));
    }
    if (model) {
      const mb = model.bins.filter((b) => Number.isFinite(b.med));
      if (mb.length > 1) out.append(s("path", { d: `M${mb.map((b) => `${x(b.s).toFixed(1)},${y(b.med).toFixed(1)}`).join("L")}`, class: "profile-model" }));
    }
    for (const d of fault) {
      out.append(s("line", { x1: x(d), x2: x(d), y1: M.t, y2: H - M.b, class: "profile-fault" }), s("text", { x: x(d) + 3, y: M.t + 10, class: "tick" }, t("profile.fault")));
    }
    const [neg, pos] = scaleWords(layer.kind === "resid" ? layer.base : layer.kind);
    out.append(
      s("text", { x: M.l, y: H - 8, class: "tick" }, prof.id === "custom" ? "1" : prof.id),
      s("text", { x: W - M.r, y: H - 8, class: "tick", "text-anchor": "end" }, prof.id === "custom" ? "2" : `${prof.id}′`),
      s("text", { x: (M.l + W - M.r) / 2, y: H - 8, class: "tick", "text-anchor": "middle" }, t("profile.x_axis", { len: fmtNumber(res.lengthKm, 0) })),
      s("text", { x: 4, y: M.t + 2, class: "tick", transform: `rotate(-90 4 ${M.t + 2})`, "text-anchor": "end", dy: "0.8em" }, `${unit} · + ${t(pos)}`),
    );
    if (terrain) {
      const tb = terrain.bins.filter((b) => Number.isFinite(b.med));
      if (tb.length > 1) {
        const zlo = Math.min(...tb.map((b) => b.med));
        const zhi = Math.max(...tb.map((b) => b.med), zlo + 1);
        const z = scale([zlo, zhi], [H + TH - 4, H + 8]);
        out.append(
          s("path", { d: `M${x(tb[0].s).toFixed(1)},${H + TH - 4}L${tb.map((b) => `${x(b.s).toFixed(1)},${z(b.med).toFixed(1)}`).join("L")}L${x(tb.at(-1).s).toFixed(1)},${H + TH - 4}Z`, class: "profile-terrain" }),
          s("text", { x: M.l - 6, y: H + 18, class: "tick", "text-anchor": "end" }, fmtNumber(zhi, 0)),
          s("text", { x: M.l - 6, y: H + TH - 4, class: "tick", "text-anchor": "end" }, fmtNumber(zlo, 0)),
          s("text", { x: W - M.r, y: H + 18, class: "tick", "text-anchor": "end" }, t("profile.terrain")),
        );
      }
    }
    const key = h(
      "ul",
      { class: "motion-series-key" },
      h("li", {}, h("span", { class: "swatch line" }), t("profile.key_median")),
      h("li", {}, h("span", { class: "swatch band" }), t("profile.key_band")),
      model ? h("li", {}, h("span", { class: "swatch model" }), t("profile.key_model")) : null,
      Number.isFinite(layer.noise) && layer.noise > 0 ? h("li", {}, h("span", { class: "swatch noise" }), t("profile.key_noise", { v: fmtNumber(2 * layer.noise, 1) })) : null,
      h("li", {}, t("profile.key_sign", { neg: t(neg), pos: t(pos) })),
    );
    const table = srTable(
      t("profile.aria", { id: prof.id }),
      [t("profile.col_km"), t("profile.col_median"), t("profile.col_p25"), t("profile.col_p75")],
      good.map((b) => [fmtNumber(b.s, 1), fmtNumber(b.med, 1), fmtNumber(b.p25, 1), fmtNumber(b.p75, 1)]),
    );
    return h("div", {}, out, key, table);
  }

  // The line and its swath on the map, with its end labels.
  map.onRender((m) => {
    const [w, hgt] = m.size();
    svg.setAttribute("width", w);
    svg.setAttribute("height", hgt);
    svg.replaceChildren();
    const b = st().motion;
    const prof = st().motionProfile;
    if (!b || st().mode !== "motion") return;
    if (first) {
      const [fx, fy] = m.project(first[0], first[1]);
      svg.append(s("circle", { cx: fx, cy: fy, r: 5, class: "profile-end" }));
    }
    if (!prof) return;
    const [ax, ay] = m.project(prof.a[0], prof.a[1]);
    const [bx, by] = m.project(prof.b[0], prof.b[1]);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    // Half width in pixels: km → degrees of latitude → pixels at this zoom.
    const [, py0] = m.project(prof.a[0], prof.a[1]);
    const [, py1] = m.project(prof.a[0], prof.a[1] + prof.half_width_km / 110.574);
    const hw = Math.abs(py1 - py0);
    const nx = (-(by - ay) / len) * hw;
    const ny = ((bx - ax) / len) * hw;
    svg.append(
      s("path", { d: `M${ax + nx},${ay + ny}L${bx + nx},${by + ny}L${bx - nx},${by - ny}L${ax - nx},${ay - ny}Z`, class: "profile-swath" }),
      s("line", { x1: ax, y1: ay, x2: bx, y2: by, class: "profile-line" }),
      s("text", { x: ax, y: ay, class: "profile-label", dy: "-0.6em", "text-anchor": "middle" }, prof.id === "custom" ? "1" : prof.id),
      s("text", { x: bx, y: by, class: "profile-label", dy: "-0.6em", "text-anchor": "middle" }, prof.id === "custom" ? "2" : `${prof.id}′`),
    );
  });

  map.on("click", ([lon, lat]) => {
    if (st().mode !== "motion" || !st().motionDraw) return;
    if (!first) {
      first = [lon, lat];
      map.refresh();
      return;
    }
    const b = st().motion;
    const half = b.doc.kind === "earthquake" ? 3 : 1;
    store.set({ motionProfile: { id: "custom", a: first, b: [lon, lat], half_width_km: half }, motionDraw: false });
    first = null;
  });

  drawBtn.addEventListener("click", () => {
    const on = !st().motionDraw;
    first = null;
    store.set({ motionDraw: on });
  });
  sel.addEventListener("change", () => {
    const p = st().motion?.doc.profiles?.find((x) => x.id === sel.value);
    if (p) store.set({ motionProfile: { ...p } });
  });

  watch(store, ["motionDraw"], ({ motionDraw }) => {
    drawBtn.textContent = motionDraw ? t("profile.drawing") : t("profile.draw");
    drawBtn.setAttribute("aria-pressed", String(Boolean(motionDraw)));
    map.container.classList.toggle("map-drawing", Boolean(motionDraw));
  });
  watch(store, ["motion", "motionProfile"], fillSelect);
  watch(store, ["motion", "motionLayer", "motionDate", "motionProfile", "mode"], () => {
    render();
    map.refresh();
  });
}
