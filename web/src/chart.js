// Flooded area through the season: open water + hidden flood, and what C-band saw (F01).
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";

export const id = "chart";
export const slot = "sidebar";

const W = 340;
const H = 168;
const M = { l: 36, r: 8, t: 10, b: 24 };

function cbandSaw(p) {
  return p.hidden_from_cband_km2 === null ? null : p.flooded_km2 - p.hidden_from_cband_km2;
}

const day = (iso) => Date.parse(`${iso}T00:00:00Z`);

// Passes left out for bad calibration, from the summary warnings ("YYYY-MM-DD: …").
function droppedDates(summary) {
  return (summary.warnings ?? [])
    .filter((w) => w.code === "radiometry_outlier" && /^\d{4}-\d{2}-\d{2}/.test(w.detail ?? ""))
    .map((w) => w.detail.slice(0, 10));
}

function draw(svg, summary, passIndex, t) {
  const passes = summary.passes;
  svg.replaceChildren();
  // A real time axis: a 24-day gap must look twice as long as a 12-day one.
  const t0 = day(passes[0].date);
  const t1 = Math.max(day(passes.at(-1).date), t0 + 1);
  const x = (iso) => M.l + ((day(iso) - t0) / (t1 - t0)) * (W - M.l - M.r);
  const yMax = Math.max(...passes.flatMap((p) => [p.flooded_km2, p.optical_clear_fraction >= 0.05 ? (p.optical_water_km2 ?? 0) : 0]), 1);
  const y = scale([0, yMax * 1.08], [H - M.b, M.t]);

  for (const v of ticks(0, yMax, 3)) {
    svg.append(
      s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }),
      s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)),
    );
  }
  // Break the areas where passes are much further apart than usual (a missing or dropped pass).
  const gaps = passes.slice(1).map((p, i) => day(p.date) - day(passes[i].date));
  const typical = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
  const segments = [[passes[0]]];
  passes.slice(1).forEach((p, i) => {
    if (typical && gaps[i] > typical * 1.6) segments.push([]);
    segments.at(-1).push(p);
  });
  const area = (seg, top, bottom) => {
    if (seg.length === 1) {
      const p = seg[0];
      return `M${x(p.date) - 3},${y(top(p))}h6V${y(bottom(p))}h-6Z`;
    }
    const up = seg.map((p) => `${x(p.date)},${y(top(p))}`);
    const down = seg.map((p) => `${x(p.date)},${y(bottom(p))}`).reverse();
    return `M${up.join("L")}L${down.join("L")}Z`;
  };
  for (const seg of segments) {
    svg.append(
      s("path", { d: area(seg, (p) => p.open_water_km2, () => 0), class: "area-water" }),
      s("path", { d: area(seg, (p) => p.flooded_km2, (p) => p.open_water_km2), class: "area-hidden" }),
    );
  }
  for (const d of droppedDates(summary)) {
    if (day(d) < t0 || day(d) > t1) continue;
    svg.append(
      s("line", { x1: x(d), x2: x(d), y1: H - M.b, y2: H - M.b - 10, class: "dropped" }),
      s("circle", { cx: x(d), cy: H - M.b - 13, r: 3, class: "dropped" }, s("title", {}, t("chart.dropped", { date: fmtDate(d) }))),
    );
  }

  // What C-band saw: a diamond at each matched pass (C-band images are not every pass).
  passes.forEach((p) => {
    const v = cbandSaw(p);
    if (v === null) return;
    const cx = x(p.date);
    const cy = y(v);
    svg.append(s("path", { d: `M${cx},${cy - 4.5}L${cx + 4.5},${cy}L${cx},${cy + 4.5}L${cx - 4.5},${cy}Z`, class: "dot-cband" }));
  });

  // What optical saw: shown only with at least 5 % clear sky, faded by how cloudy it was.
  passes.forEach((p) => {
    if (p.optical_water_km2 === null || p.optical_water_km2 === undefined || !(p.optical_clear_fraction >= 0.05)) return;
    svg.append(
      s("rect", {
        x: x(p.date) - 3.5,
        y: y(p.optical_water_km2) - 3.5,
        width: 7,
        height: 7,
        class: "dot-optical",
        "fill-opacity": String(Math.max(0.3, p.optical_clear_fraction)),
      }),
    );
  });
  const now = passes[passIndex].date;
  svg.append(
    s("line", { x1: x(now), x2: x(now), y1: M.t, y2: H - M.b, class: "cursor" }),
    s("text", { x: M.l, y: H - 6, class: "tick" }, fmtDate(passes[0].date, "short")),
    s("text", { x: W - M.r, y: H - 6, class: "tick", "text-anchor": "end" }, fmtDate(passes.at(-1).date, "short")),
  );
  return x;
}

export function init({ store, t, root }) {
  const heading = h("h2", { text: t("chart.title") });
  const unit = h("p", { class: "chart-unit", text: t("chart.unit") });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "area-chart", role: "img" });
  const legend = h(
    "ul",
    { class: "legend-inline" },
    h("li", {}, h("span", { class: "swatch swatch-hidden" }), t("legend.hidden_flood")),
    h("li", {}, h("span", { class: "swatch swatch-water" }), t("legend.open_water")),
    h("li", {}, h("span", { class: "swatch swatch-cband-diamond" }), t("chart.cband_saw")),
    h("li", { class: "key-optical" }, h("span", { class: "swatch swatch-optical" }), t("chart.optical_saw")),
  );
  const table = h("div");
  root.append(heading, unit, svg, legend, table);
  let xScale = null;

  svg.addEventListener("click", (ev) => {
    const site = store.get().site;
    if (!site || !xScale) return;
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let best = 0;
    const passes = site.summary.passes;
    passes.forEach((p, i) => {
      if (Math.abs(xScale(p.date) - px) < Math.abs(xScale(passes[best].date) - px)) best = i;
    });
    store.set({ passIndex: best, playing: false });
  });

  watch(store, ["site", "passIndex"], ({ site, passIndex }, _prev, changed) => {
    root.hidden = !site;
    if (!site) return;
    const passes = site.summary.passes;
    xScale = draw(svg, site.summary, passIndex, t);
    legend.querySelector(".key-optical").hidden = !passes.some((p) => p.optical_water_km2 !== null && p.optical_water_km2 !== undefined);
    const peak = passes.find((p) => p.id === site.summary.peak_pass);
    svg.setAttribute(
      "aria-label",
      t("chart.summary", {
        start: fmtDate(passes[0].date),
        end: fmtDate(passes.at(-1).date),
        peak: fmtNumber(peak.flooded_km2),
        peak_date: fmtDate(peak.date),
      }),
    );
    if (changed.includes("site")) {
      table.replaceChildren(
        srTable(
          t("chart.title"),
          [t("chart.col_date"), t("legend.open_water"), t("legend.hidden_flood"), t("chart.cband_saw")],
          passes.map((p) => [
            fmtDate(p.date),
            fmtNumber(p.open_water_km2),
            fmtNumber(p.flooded_veg_km2),
            fmtNumber(cbandSaw(p)),
          ]),
        ),
      );
    }
  });
}
