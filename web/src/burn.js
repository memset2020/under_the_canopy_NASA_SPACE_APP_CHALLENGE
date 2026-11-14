// Burned forest, seen through the smoke (F58, docs/14): on a fire site, where NISAR's HH over HV
// rose and stayed up (the canopy's volume echo lost, the trunks and ground left), pass by pass, and
// how that agrees with NASA's burned-area maps (MODIS MCD64A1, VIIRS VNP64A1). Computed in the
// pipeline (canopy/burn.py, active_fire.py); this module only draws: the area burned by date, the
// agreement and its dependence on the threshold, the VIIRS fire detections between radar passes
// (chart and map points), and how clear the camera's view was on the same passes.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { checkRow, fillCheck, note as noteEl, setLead, setNote, shareBar } from "./readable.js";

export const id = "burn";
export const slot = "sidebar";

// Burned forest NISAR first saw after the last month of the reference map (km²): that map does
// not cover that time yet, so it is scored against nothing newer than that month.
export function afterReference(burnDoc) {
  const last = burnDoc.validation?.ref_months?.at(-1);
  if (!last) return 0;
  return burnDoc.by_pass.filter((p) => p.date.slice(0, 7) > last).reduce((sum, p) => sum + p.new_km2, 0);
}

// The pass rows a chart needs: date, cumulative km², and whether the pass is pre-fire baseline.
export function burnSeries(burnDoc) {
  const base = new Set(burnDoc.baseline);
  return burnDoc.by_pass.map((p) => ({ date: p.date, km2: p.burned_km2, isNew: p.new_km2 > 0, baseline: base.has(p.date) }));
}

// A fire pixel's place in the timeline: "new" if VIIRS saw it after the previous radar pass and
// up to the selected one, "old" if before, null if after the selected pass (not drawn yet).
// Days are counted from the points file's day0, like its `d` column.
export function fireStage(d, passDay, prevDay) {
  if (d > passDay) return null;
  return prevDay === null || d > prevDay ? "new" : "old";
}

// Whole days from iso date a to iso date b.
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// A share in %, whole numbers except just under 100 (99.5 must not read as 100).
export function pctText(v) {
  return fmtNumber(v, v >= 99.5 && v < 100 ? 1 : 0);
}

// Days in [first, last] with their detection counts, zero-filled so gaps (cloud, no fire) show.
export function dailyFire(af) {
  const n = new Map(af.by_day.map((d) => [d.date, d.n]));
  const out = [];
  const end = Date.parse(`${af.last}T00:00:00Z`);
  for (let d = Date.parse(`${af.first}T00:00:00Z`); d <= end; d += 86400000) {
    const iso = new Date(d).toISOString().slice(0, 10);
    out.push({ date: iso, n: n.get(iso) ?? 0 });
  }
  return out;
}

export function init({ store, map, t, root, dock }) {
  const heading = h("h2", { text: t("burn.title") });
  const lead = h("p", { class: "burn-lead" });
  const svg = s("svg", { class: "area-chart", role: "img" });
  // The finding, then its share of the forest as a bar (readable.js, D-093).
  const shareWrap = h("div");
  // Every check against an independent burned-area map as a checklist row.
  const check = checkRow("burn-check-main");
  const held = checkRow("burn-check-held");
  const monthsLine = h("p");
  const sweepWrap = h("div");
  const lookalike = h("p", { class: "burn-lookalike" });
  const smoke = h("p");
  const note = noteEl("limit", t("burn.note"));
  const table = h("div");
  const others = h("div", { class: "burn-checks" });
  const checks = h("ul", { class: "rd-checks" }, check, held);
  // VIIRS active fire: what the fire did between two radar passes.
  const afHead = h("h3", { text: t("burn.af_title") });
  const afLead = h("p");
  const afSvg = s("svg", { class: "area-chart fire-chart", role: "img" });
  const afDates = h("p");
  // Off by default: the burn map is the view; the detections are a layer to ask for (D-088).
  const afToggle = h("input", { type: "checkbox", id: "show-fire", checked: store.get().layers.fire === true });
  const afLabel = h("label", { class: "check" }, afToggle, t("burn.af_show"));
  const afNote = noteEl("info", t("burn.af_note"));
  const afTable = h("div");
  const afBox = h("div", { class: "burn-af" }, afHead, afLead, afSvg, afDates, afNote, afTable);
  // The fire points are a map layer: the switch goes On top in the map panel (dock.js).
  dock.place("overlays", afLabel);
  root.append(
    heading,
    lead,
    shareWrap,
    svg,
    h("h3", { class: "rd-sub", text: t("burn.checks_title") }),
    checks,
    others,
    monthsLine,
    sweepWrap,
    lookalike,
    afBox,
    smoke,
    note,
    table,
  );
  root.hidden = true;
  afToggle.addEventListener("change", () => store.set({ layers: { ...store.get().layers, fire: afToggle.checked } }));

  // Fire pixels drawn on a canvas over the map (thousands of points), re-projected on every move.
  const canvas = h("canvas", { class: "vector-layer fire-layer", "aria-hidden": "true" });
  map.panes.base.append(canvas);
  let fireData = null;
  map.onRender((m) => {
    const st = store.get();
    const [w, hgt] = m.size();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    const b = st.site?.summary.products.burn;
    if (!b?.active_fire || !fireData || st.view !== "burn" || st.layers.fire !== true) return;
    const passes = b.by_pass;
    const i = Math.min(st.passIndex ?? passes.length - 1, passes.length - 1);
    const passDay = daysBetween(fireData.day0, passes[i].date);
    const prev = i > 0 ? daysBetween(fireData.day0, passes[i - 1].date) : null;
    const [ox, oy] = fireData.origin;
    const step = fireData.step_deg;
    // Only the detections since the last radar pass, as small solid points with a dark rim:
    // translucent 375 m discs piled into a yellow sheet over the burn map (D-088).
    // No rim: at the fire's peak thousands of rims merged into a dark mesh over the burn.
    const r = 1.3;
    g.fillStyle = "rgba(255, 214, 90, 0.9)";
    g.beginPath();
    for (let k = 0; k < fireData.d.length; k++) {
      if (fireStage(fireData.d[k], passDay, prev) !== "new") continue;
      const [x, y] = m.project(ox + fireData.x[k] * step, oy + fireData.y[k] * step);
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, 2 * Math.PI);
    }
    g.fill();
  });

  function fireChart(b) {
    const af = b.active_fire;
    const rows = dailyFire(af);
    const W = 340;
    const H = 130;
    const M = { l: 54, r: 12, t: 14, b: 26 };
    const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
    const x0 = day(rows[0].date);
    const x1 = day(rows.at(-1).date) + 86400000;
    const x = scale([x0, x1], [M.l, W - M.r]);
    const top = Math.max(1, ...rows.map((r) => r.n));
    const y = scale([0, top * 1.1], [H - M.b, M.t]);
    const bw = Math.max(1, (W - M.l - M.r) / rows.length - 1);
    afSvg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    afSvg.replaceChildren();
    for (const v of ticks(0, top, 2)) {
      afSvg.append(s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)));
    }
    afSvg.append(s("text", { x: M.l, y: M.t - 4, class: "tick" }, t("burn.af_y")));
    // NISAR's passes inside the window, as thin lines: the radar's view of the same days.
    for (const p of b.by_pass) {
      const px = day(p.date);
      if (px < x0 || px >= x1) continue;
      afSvg.append(s("line", { x1: x(px), x2: x(px), y1: M.t, y2: H - M.b, class: "fire-pass" }, s("title", {}, t("burn.af_tip_pass", { date: fmtDate(p.date) }))));
    }
    for (const r of rows) {
      if (!r.n) continue;
      afSvg.append(s("rect", { x: x(day(r.date)), y: y(r.n), width: bw, height: H - M.b - y(r.n), class: "fire-bar" }, s("title", {}, t("burn.af_tip_day", { date: fmtDate(r.date), n: fmtNumber(r.n, 0) }))));
    }
    afSvg.append(
      s("text", { x: M.l, y: H - 6, class: "tick" }, fmtDate(rows[0].date, "short")),
      s("text", { x: W - M.r, y: H - 6, class: "tick", "text-anchor": "end" }, fmtDate(rows.at(-1).date, "short")),
    );
    afSvg.setAttribute("aria-label", afLead.textContent);
    afTable.replaceChildren(srTable(t("burn.af_title"), [t("chart.col_date"), t("burn.af_col_n")], af.by_day.map((d) => [fmtDate(d.date), fmtNumber(d.n, 0)])));
  }

  function renderFire(site) {
    const b = site.summary.products.burn;
    const af = b.active_fire;
    afBox.hidden = !af || !af.n;
    fireData = null;
    if (afBox.hidden) return;
    setLead(afLead, t("burn.af_lead", { n: fmtNumber(af.n, 0), first: fmtDate(af.first), last: fmtDate(af.last), sensors: af.sensors.join(", "), frp: fmtNumber(af.frp_max_mw, 0) }));
    fireChart(b);
    const dc = af.dates;
    setLead(
      afDates,
      dc && dc.cells
        ? t("burn.af_dates", { cells: fmtNumber(dc.cells, 0), within: pctText(dc.within_pct), before: pctText(dc.before_pct), lead: fmtNumber(dc.median_lead_days, 0) })
        : t("burn.af_dates_none"),
    );
    fetch(site.url(af.points))
      .then((res) => (res.ok ? res.json() : null))
      .then((gj) => {
        if (store.get().site === site) {
          fireData = gj;
          map.refresh();
        }
      })
      .catch(() => {
        fireData = null; // the points are optional; the chart above still stands
      });
  }

  function chart(b) {
    const rows = burnSeries(b);
    const W = 340;
    const H = 160;
    const M = { l: 44, r: 12, t: 14, b: 26 };
    const day = (iso) => Date.parse(`${iso}T00:00:00Z`);
    const x = scale([day(rows[0].date), Math.max(day(rows.at(-1).date), day(rows[0].date) + 1)], [M.l, W - M.r]);
    const top = Math.max(1, ...rows.map((r) => r.km2));
    const y = scale([0, top * 1.1], [H - M.b, M.t]);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren();
    for (const v of ticks(0, top, 3)) {
      svg.append(s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)));
    }
    svg.append(s("text", { x: M.l, y: M.t - 4, class: "tick" }, t("burn.y_km2")));
    svg.append(s("path", { d: `M${rows.map((r) => `${x(day(r.date)).toFixed(1)},${y(r.km2).toFixed(1)}`).join("L")}`, class: "burn-line", fill: "none", stroke: "rgb(222 84 72)", "stroke-width": 2 }));
    for (const r of rows) {
      svg.append(
        s("circle", { cx: x(day(r.date)), cy: y(r.km2), r: r.isNew ? 4.5 : 3, class: r.baseline ? "burn-base" : "burn-pass", fill: r.baseline ? "#a3b2ae" : "rgb(222 84 72)" },
          s("title", {}, t(r.baseline ? "burn.tip_base" : "burn.tip_pass", { date: fmtDate(r.date), km2: fmtNumber(r.km2, 0) }))),
      );
    }
    svg.append(
      s("text", { x: M.l, y: H - 6, class: "tick" }, fmtDate(rows[0].date, "short")),
      s("text", { x: W - M.r, y: H - 6, class: "tick", "text-anchor": "end" }, fmtDate(rows.at(-1).date, "short")),
    );
    svg.setAttribute("aria-label", lead.textContent);
    table.replaceChildren(srTable(t("burn.title"), [t("chart.col_date"), t("burn.col_km2")], rows.map((r) => [fmtDate(r.date), fmtNumber(r.km2, 1)])));
  }

  function render(site) {
    const sm = site.summary;
    const b = sm.products.burn;
    const hit = b.by_pass.filter((p) => p.new_km2 > 0);
    setLead(
      lead,
      hit.length
        ? t("burn.lead", { km2: fmtNumber(b.burned_km2, 0), forest: fmtNumber(b.forest_km2, 0), first: fmtDate(hit[0].date), last: fmtDate(hit.at(-1).date), rise: fmtNumber(b.rise_db, 1), name: b.fire.name ?? "" })
        : t("burn.lead_none", { rise: fmtNumber(b.rise_db, 1) }),
    );
    shareWrap.replaceChildren(
      ...(hit.length && b.forest_km2 > 0
        ? [shareBar(b.burned_km2, b.forest_km2, t("burn.bar_burned", { km2: fmtNumber(b.burned_km2, 0) }), t("burn.bar_forest", { km2: fmtNumber(b.forest_km2, 0) }), "rd-share-burn")]
        : []),
    );
    chart(b);
    const v = b.validation;
    const fScore = (f1) => (f1 !== null && f1 !== undefined && f1 >= 0.7 ? "done" : "caution");
    fillCheck(check, v ? fScore(v.f1) : "pending", v ? t(`burn.ref_${v.product}`) : t("burn.n_check"), v
      ? t("burn.check", {
          ref: t(`burn.ref_${v.product}`),
          short: t(`burn.ref_short_${v.product}`),
          ref_km2: fmtNumber(v.ref_burned_km2, 0),
          recall: v.recall === null ? "–" : fmtNumber(v.recall * 100, 0),
          precision: v.precision === null ? "–" : fmtNumber(v.precision * 100, 0),
          f1: v.f1 === null ? "–" : fmtNumber(v.f1, 2),
          within: v.dates?.within_pct === null || v.dates?.within_pct === undefined ? "–" : fmtNumber(v.dates.within_pct, 0),
        })
      : t("burn.check_none"));
    const ho = v?.held_out;
    // Where the threshold was chosen decides which score is out of sample: the east half there,
    // the whole box anywhere else.
    const tunedHere = b.tuned_site === site.summary.site.id;
    fillCheck(
      held,
      !tunedHere && v ? "done" : fScore(ho?.f1),
      t("burn.n_held"),
      !tunedHere && v
        ? t("burn.held_out_other", { rise: fmtNumber(b.rise_db, 1), tuned: t("burn.tuned_name") })
        : ho && ho.f1 !== null
          ? t("burn.held_out", { rise: fmtNumber(b.rise_db, 1), f1: fmtNumber(ho.f1, 2), recall: fmtNumber(ho.recall * 100, 0), precision: fmtNumber(ho.precision * 100, 0) })
          : "",
    );
    const fl = b.flood_lookalike;
    setNote(lookalike, "limit", fl ? t("burn.lookalike", { date: fmtDate(fl.date), km2: fmtNumber(fl.km2, 0), before: fmtNumber(fl.before_km2, 0), pct: fmtNumber(fl.in_burned_pct, 0) }) : "");
    const months = v?.ref_months ?? [];
    const later = afterReference(b);
    const monthList = (ms) => ms.map((m) => fmtDate(`${m}-01`, "month")).join(", ");
    setNote(monthsLine, "info", months.length
      ? t(later > 0 ? "burn.ref_months_later" : "burn.ref_months", { short: t(`burn.ref_short_${v.product}`), list: monthList(months), km2: fmtNumber(later, 0) })
      : "");
    // The same check against the other burned-area maps (v14): a second opinion, not a new score.
    for (const li of checks.querySelectorAll(".burn-check-other")) li.remove();
    for (const c of b.checks ?? []) {
      const li = checkRow("burn-check-other");
      fillCheck(li, fScore(c.f1), t(`burn.ref_${c.product}`), t("burn.other_check", {
        ref: t(`burn.ref_${c.product}`),
        list: monthList(c.ref_months),
        ref_km2: fmtNumber(c.ref_burned_km2, 0),
        f1: c.f1 === null ? "–" : fmtNumber(c.f1, 2),
        recall: c.recall === null ? "–" : fmtNumber(c.recall * 100, 0),
        precision: c.precision === null ? "–" : fmtNumber(c.precision * 100, 0),
      }));
      checks.append(li);
    }
    others.hidden = true;
    sweepWrap.replaceChildren();
    if (v?.sweep?.length) {
      const tableEl = h(
        "table",
        { class: "burn-sweep" },
        h("caption", { class: "muted small", text: t("burn.sweep_caption") }),
        h("thead", {}, h("tr", {}, h("th", { text: t("burn.col_rise") }), h("th", { text: "F1" }), h("th", { text: t("burn.col_recall") }), h("th", { text: t("burn.col_precision") }))),
        h(
          "tbody",
          {},
          v.sweep.map((r) =>
            h(
              "tr",
              { class: r.rise_db === b.rise_db ? "is-used" : "" },
              h("td", { text: `${fmtNumber(r.rise_db, 2)} dB` }),
              h("td", { text: r.f1 === null ? "–" : fmtNumber(r.f1, 2) }),
              h("td", { text: r.recall === null ? "–" : `${fmtNumber(r.recall * 100, 0)}%` }),
              h("td", { text: r.precision === null ? "–" : `${fmtNumber(r.precision * 100, 0)}%` }),
            ),
          ),
        ),
      );
      sweepWrap.append(tableEl);
    }
    // The camera's view on the passes that saw the fire: radar needs no clear sky.
    const during = sm.passes.filter((p) => hit.some((x) => x.date === p.date) && p.optical_clear_fraction !== null);
    setNote(smoke, "info", during.length
      ? t("burn.smoke", { list: during.map((p) => t("burn.smoke_item", { date: fmtDate(p.date, "short"), pct: fmtNumber(p.optical_clear_fraction * 100, 0) })).join(", ") })
      : "");
    renderFire(site);
  }

  watch(store, ["site"], ({ site }) => {
    const b = site?.summary.products.burn;
    root.hidden = !b;
    if (b) render(site);
    else fireData = null;
    map.refresh();
  });
  watch(store, ["view", "passIndex", "layers"], () => map.refresh());
}
