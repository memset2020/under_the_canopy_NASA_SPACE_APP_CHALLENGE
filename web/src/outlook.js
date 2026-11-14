// The next two weeks (F49, experimental): the hidden flood of each pass fitted on the main river's
// flow (GEOGloWS, ECMWF river model), then carried along the river's 15-day ensemble forecast.
// Two panels on one date axis (never a second y-axis): water under the trees, and the river.
// Projections are dashed with a 25-75 % band; days outside the season's range of flows are not
// projected at all. Computed in the pipeline (canopy/outlook.py); this module only draws.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { note as noteEl, setLead, setNote } from "./readable.js";

export const id = "outlook";
export const slot = "sidebar";

const W = 340;
const M = { l: 44, r: 10 };
const day = (iso) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);

export function init({ store, t, root }) {
  const heading = h("h2", { text: t("outlook.title") });
  const lead = h("p", { class: "outlook-lead" });
  const svg = s("svg", { class: "area-chart outlook-svg", role: "img" });
  const fitLine = h("p", { class: "muted small" });
  const key = h(
    "ul",
    { class: "legend-inline" },
    h("li", {}, h("span", { class: "swatch swatch-hidden" }), t("outlook.key_passes")),
    h("li", {}, h("span", { class: "line-key line-key-dashed" }), t("outlook.key_projection")),
    h("li", {}, h("span", { class: "line-key", style: "background:#a3b2ae" }), t("outlook.key_river")),
  );
  const note = noteEl("source", t("outlook.note"));
  const table = h("div");
  root.append(heading, lead, svg, key, fitLine, note, table);

  function render(summary) {
    const o = summary.products.outlook;
    const past = o.past.filter((p) => p[2] !== null);
    const fc = o.forecast;
    const flows = o.flows;
    const t0 = day(summary.passes[0].date);
    const t1 = Math.max(day(fc.at(-1)?.date ?? summary.passes.at(-1).date), t0 + 86400000);
    const x = (iso) => M.l + ((day(iso) - t0) / (t1 - t0)) * (W - M.l - M.r);
    const top = { y0: 12, y1: 132 };
    const low = { y0: 160, y1: 226 };
    const H = 250;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren();

    // Panel 1: water under the trees (km²).
    const yMax = Math.max(1, ...past.map((p) => p[2]), ...fc.filter((d) => d.y_hi !== null).map((d) => d.y_hi));
    const y = scale([0, yMax * 1.1], [top.y1, top.y0]);
    for (const v of ticks(0, yMax, 3)) {
      svg.append(
        s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }),
        s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, v < 10 ? 1 : 0)),
      );
    }
    svg.append(s("text", { x: M.l, y: top.y0 - 2, class: "tick" }, t("outlook.y_hidden")));
    const runs = [];
    let run = [];
    for (const d of fc) {
      if (d.y50 === null) {
        if (run.length) runs.push(run);
        run = [];
      } else run.push(d);
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      const band = `M${r.map((d) => `${x(d.date).toFixed(1)},${y(d.y_hi).toFixed(1)}`).join("L")}L${[...r].reverse().map((d) => `${x(d.date).toFixed(1)},${y(d.y_lo).toFixed(1)}`).join("L")}Z`;
      svg.append(
        s("path", { d: band, class: "outlook-band" }),
        s("path", { d: `M${r.map((d) => `${x(d.date).toFixed(1)},${y(d.y50).toFixed(1)}`).join("L")}`, class: "outlook-median" }),
      );
    }
    for (const [d, , v] of past) {
      svg.append(s("circle", { cx: x(d), cy: y(v), r: 4, class: "outlook-pass" }, s("title", {}, t("outlook.pass_tip", { date: fmtDate(d), km2: fmtNumber(v, 1) }))));
    }

    // Panel 2: the river (m³/s), this season and the forecast median with its 25-75 % band.
    const qs = [...flows.map((f) => f[1]), ...fc.map((d) => d.q75)].filter((v) => v > 0);
    const qMax = Math.max(1, ...qs);
    const yq = scale([0, qMax * 1.1], [low.y1, low.y0]);
    svg.append(
      s("text", { x: M.l, y: low.y0 - 4, class: "tick" }, t("outlook.y_river")),
      s("text", { x: M.l - 6, y: yq(qMax) + 4, class: "tick", "text-anchor": "end" }, qMax >= 10000 ? `${fmtNumber(qMax / 1000, 0)}k` : fmtNumber(qMax, 0)),
      s("text", { x: M.l - 6, y: low.y1, class: "tick", "text-anchor": "end" }, "0"),
      s("line", { x1: M.l, x2: W - M.r, y1: low.y1, y2: low.y1, class: "grid" }),
    );
    const seen = flows.filter((f) => day(f[0]) >= t0);
    if (seen.length > 1) svg.append(s("path", { d: `M${seen.map((f) => `${x(f[0]).toFixed(1)},${yq(f[1]).toFixed(1)}`).join("L")}`, class: "outlook-river" }));
    if (fc.length > 1) {
      svg.append(
        s("path", { d: `M${fc.map((d) => `${x(d.date).toFixed(1)},${yq(d.q75).toFixed(1)}`).join("L")}L${[...fc].reverse().map((d) => `${x(d.date).toFixed(1)},${yq(d.q25).toFixed(1)}`).join("L")}Z`, class: "outlook-river-band" }),
        s("path", { d: `M${fc.map((d) => `${x(d.date).toFixed(1)},${yq(d.q50).toFixed(1)}`).join("L")}`, class: "outlook-river-fc" }),
      );
    }
    // Today: where the forecast starts.
    if (fc.length) {
      const xt = x(fc[0].date);
      svg.append(
        s("line", { x1: xt, x2: xt, y1: top.y0, y2: low.y1, class: "outlook-today" }),
        s("text", { x: xt > W - 70 ? xt - 3 : xt + 3, y: H - 6, class: "tick", "text-anchor": xt > W - 70 ? "end" : "start" }, t("outlook.today")),
      );
    }
    svg.append(s("text", { x: M.l, y: H - 6, class: "tick" }, fmtDate(summary.passes[0].date, "short")));

    const last = [...fc].reverse().find((d) => d.y50 !== null);
    const f = o.fit;
    if (o.usable && last) {
      // Under 0.1 km² the honest word is "almost none", not "about 0.0 km²".
      setLead(
        lead,
        last.y_hi < 0.1
          ? t("outlook.lead_none", { date: fmtDate(last.date) })
          : t("outlook.lead", { km2: fmtNumber(last.y50, 1), date: fmtDate(last.date), lo: fmtNumber(last.y_lo, 1), hi: fmtNumber(last.y_hi, 1) }),
      );
    } else if (o.usable) {
      setLead(lead, t("outlook.beyond"));
    } else {
      // v12 says why; a strong relation the wrong way round gets its own words.
      setLead(lead, t(o.withheld === "inverse" ? "outlook.inverse" : "outlook.unusable", { n: f.n, r: f.r === null ? "–" : fmtNumber(f.r, 2) }));
    }
    setNote(fitLine, "info", f.r === null ? "" : t("outlook.fit", { n: f.n, r: fmtNumber(f.r, 2), rmse: fmtNumber(f.rmse_km2 ?? 0, 1), q: fmtNumber(o.river_mean_cms, 0), k: o.reaches_checked ?? "?", id: o.river_id }));
    svg.setAttribute("aria-label", lead.textContent);
    table.replaceChildren(
      srTable(
        t("outlook.title"),
        [t("chart.col_date"), t("outlook.col_river"), t("outlook.col_hidden")],
        [
          ...past.map(([d, q, v]) => [fmtDate(d), q === null ? "–" : fmtNumber(q, 0), fmtNumber(v, 1)]),
          ...fc.map((d) => [fmtDate(d.date), `${fmtNumber(d.q50, 0)} (${fmtNumber(d.q25, 0)}–${fmtNumber(d.q75, 0)})`, d.y50 === null ? t("outlook.not_projected") : `${fmtNumber(d.y50, 1)} (${fmtNumber(d.y_lo, 1)}–${fmtNumber(d.y_hi, 1)})`]),
        ],
      ),
    );
  }

  watch(store, ["site"], ({ site }) => {
    const o = site?.summary.products.outlook;
    root.hidden = !o || site.summary.synthetic;
    if (!root.hidden) render(site.summary);
  });
}
