// What drove it: daily rainfall (GPM IMERG), daily L-band water share (CYGNSS) and
// soil moisture (NISAR SME2), on the same season axis as the radar passes.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { setLead, setNote } from "./readable.js";

export const id = "drivers";
export const slot = "sidebar";

const W = 340;
const H = 170;
const M = { l: 34, r: 34, t: 10, b: 22 };
const day = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;

function draw(svg, ctx, passes, passIndex) {
  svg.replaceChildren();
  const all = [...ctx.rain_daily, ...ctx.inundation_daily, ...ctx.soil_moisture].map((r) => day(r[0]));
  const x0 = Math.min(...all, day(passes[0].date));
  const x1 = Math.max(...all, day(passes.at(-1).date));
  const x = scale([x0, x1], [M.l, W - M.r]);
  const rainMax = Math.max(10, ...ctx.rain_daily.map((r) => r[1]));
  const yr = scale([0, rainMax], [H - M.b, M.t]);
  const yf = scale([0, 1], [H - M.b, M.t]);
  for (const v of ticks(0, rainMax, 3)) {
    svg.append(
      s("line", { x1: M.l, x2: W - M.r, y1: yr(v), y2: yr(v), class: "grid" }),
      s("text", { x: M.l - 5, y: yr(v) + 3, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)),
    );
  }
  if (ctx.inundation_daily.length || ctx.soil_moisture.length) {
    for (const v of [0, 0.5, 1]) {
      svg.append(s("text", { x: W - M.r + 5, y: yf(v) + 3, class: "tick" }, `${fmtNumber(v * 100, 0)}%`));
    }
  }
  const bw = Math.max(1, (W - M.l - M.r) / Math.max(x1 - x0, 1) - 0.5);
  for (const [d, mm] of ctx.rain_daily) {
    if (mm <= 0) continue;
    svg.append(s("rect", { x: x(day(d)) - bw / 2, width: bw, y: yr(mm), height: H - M.b - yr(mm), class: "rain" }));
  }
  if (ctx.inundation_daily.length) {
    const d = ctx.inundation_daily.map(([dd, v], i) => `${i ? "L" : "M"}${x(day(dd))},${yf(v)}`).join("");
    svg.append(s("path", { d, class: "line-cygnss" }));
  }
  for (const [d, v] of ctx.soil_moisture) {
    svg.append(s("circle", { cx: x(day(d)), cy: yf(v), r: 3, class: "dot-soil" }));
  }
  passes.forEach((p, i) => {
    svg.append(s("line", { x1: x(day(p.date)), x2: x(day(p.date)), y1: H - M.b, y2: H - M.b + 4, class: i === passIndex ? "pass-tick is-now" : "pass-tick" }));
  });
  svg.append(
    s("line", { x1: x(day(passes[passIndex].date)), x2: x(day(passes[passIndex].date)), y1: M.t, y2: H - M.b, class: "cursor" }),
    s("text", { x: M.l, y: H - 4, class: "tick" }, fmtDate(new Date(x0 * 86400000).toISOString().slice(0, 10), "short")),
    s("text", { x: W - M.r, y: H - 4, class: "tick", "text-anchor": "end" }, fmtDate(new Date(x1 * 86400000).toISOString().slice(0, 10), "short")),
  );
}

export function init({ store, t, root }) {
  const lead = h("p", { class: "drivers-lead" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "drivers-chart", role: "img" });
  const key = h("ul", { class: "legend-inline" });
  const sources = h("p", { class: "muted small" });
  const table = h("div");
  root.append(h("h2", { text: t("drivers.title") }), lead, svg, key, sources, table);

  watch(store, ["site", "passIndex"], ({ site, passIndex }, _p, changed) => {
    const ctx = site?.summary.context;
    const has = ctx && (ctx.rain_daily.length || ctx.inundation_daily.length || ctx.soil_moisture.length);
    root.hidden = !has;
    if (!has) return;
    const passes = site.summary.passes;
    draw(svg, ctx, passes, passIndex);
    if (changed.includes("site")) {
      const total = ctx.rain_daily.reduce((a, r) => a + r[1], 0);
      const wettest = ctx.rain_daily.reduce((a, r) => (r[1] > a[1] ? r : a), ["", -1]);
      setLead(lead, ctx.rain_daily.length
        ? t("drivers.lead", { mm: fmtNumber(total, 0), days: ctx.rain_daily.length, max: fmtNumber(wettest[1], 0), date: fmtDate(wettest[0]) })
        : t("drivers.lead_no_rain"));
      key.replaceChildren(
        ctx.rain_daily.length ? h("li", {}, h("span", { class: "swatch swatch-rain" }), t("drivers.key_rain")) : null,
        ctx.inundation_daily.length ? h("li", {}, h("span", { class: "swatch swatch-cygnss" }), t("drivers.key_cygnss")) : null,
        ctx.soil_moisture.length ? h("li", {}, h("span", { class: "swatch swatch-soil" }), t("drivers.key_soil")) : null,
      );
      setNote(sources, "source", [ctx.rain_source, ctx.inundation_source, ctx.soil_moisture_source].filter(Boolean).join(" · "));
      svg.setAttribute("aria-label", t("drivers.aria"));
      table.replaceChildren(
        srTable(t("drivers.title"), [t("chart.col_date"), t("drivers.key_rain")], ctx.rain_daily.map(([d, v]) => [fmtDate(d), fmtNumber(v, 1)])),
      );
    }
  });
}
