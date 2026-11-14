// Downwind ice (docs/15): on a fire site with an icefield downwind, what NASA satellites recorded
// over the ice in the same season, against the years before: fire upwind (VIIRS fire pixels),
// smoke over the ice (VIIRS Deep Blue aerosol), how dark the ice was (VIIRS albedo), and whether
// NISAR's ice offsets resolve the glaciers' speed (checked against ITS_LIVE). Built in the
// pipeline (canopy/ice.py); this module only draws. Co-occurrence, never cause.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";

export const id = "ice";
export const slot = "sidebar";
export const ICE_SCHEMA = 1;

const DAY = 86400000;

// ---------------------------------------------------------------- pure helpers (tested)

// Great-circle distance (km) between the centres of two [w, s, e, n] boxes.
export function centreDistanceKm(a, b) {
  const c = (box) => [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2].map((v) => (v * Math.PI) / 180);
  const [l1, p1] = c(a);
  const [l2, p2] = c(b);
  const x = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

// Compass direction (8 points) from box a to box b, as an i18n key suffix.
export function bearing8(a, b) {
  const rad = (v) => (v * Math.PI) / 180;
  const [l1, p1] = [rad((a[0] + a[2]) / 2), rad((a[1] + a[3]) / 2)];
  const [l2, p2] = [rad((b[0] + b[2]) / 2), rad((b[1] + b[3]) / 2)];
  const y = Math.sin(l2 - l1) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
  const deg = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return ["n", "ne", "e", "se", "s", "sw", "w", "nw"][Math.round(deg / 45) % 8];
}

// The icefield whose fire_site is this site, if any.
export function iceFor(index, siteId) {
  return index?.events?.find((e) => e.fire_site === siteId) ?? null;
}

// Runs of consecutive non-null points, so a line breaks where a day was not measured.
export function segments(points) {
  const out = [];
  let cur = [];
  for (const p of points) {
    if (p.y === null || p.y === undefined) {
      if (cur.length) out.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Does NISAR resolve a glacier here? Only where its windows agree on most of the glacier (half
// its cells or more), its speed stands clear of the rock noise (twice it), and it falls inside
// ITS_LIVE's spread over the summer (middle half of pairs, or ±30 % without one). Returns the
// ranges the card quotes.
export function speedVerdict(sp) {
  const both = sp.glaciers.filter((g) => g.itslive_m_yr !== null && g.nisar_m_yr !== null);
  const noise = sp.best_pair?.rock_noise_m_yr ?? sp.rock_noise_median_m_yr ?? 0;
  const inSpread = (g) => {
    const [lo, hi] = g.itslive_iqr_m_yr ?? [0.7 * g.itslive_m_yr, 1.3 * g.itslive_m_yr];
    return g.nisar_m_yr >= lo && g.nisar_m_yr <= hi;
  };
  const resolved = both.filter((g) => (g.nisar_agree_pct ?? 0) >= 50 && g.nisar_m_yr >= 2 * noise && inSpread(g));
  const range = (vals) => (vals.length ? [Math.min(...vals), Math.max(...vals)] : null);
  return {
    resolved: resolved.map((g) => g.name),
    nisar: range(both.map((g) => g.nisar_m_yr)),
    itslive: range(sp.glaciers.map((g) => g.itslive_m_yr).filter((v) => v !== null)),
    error: range(sp.glaciers.map((g) => g.itslive_error_m_yr).filter((v) => v !== null && v !== undefined)),
    pairs: Math.max(0, ...sp.glaciers.map((g) => g.itslive_pairs ?? 0)),
  };
}

// ---------------------------------------------------------------- drawing

const W = 340;
const M = { l: 40, r: 10, t: 16, b: 6 };

function panel(svg, y0, height, label) {
  svg.append(s("text", { x: M.l, y: y0 + 11, class: "tick ice-panel-label" }, label));
  return [y0 + M.t, y0 + height];
}

function dayX(days) {
  const t0 = Date.parse(`${days[0].date}T00:00:00Z`);
  const t1 = Date.parse(`${days.at(-1).date}T00:00:00Z`) + DAY;
  const x = scale([t0, t1], [M.l, W - M.r]);
  return (iso) => x(Date.parse(`${iso}T00:00:00Z`));
}

function linePath(pts, x, y) {
  return segments(pts)
    .map((seg) => `M${seg.map((p) => `${x(p.date).toFixed(1)},${y(p.y).toFixed(1)}`).join("L")}`)
    .join("");
}

function bandPath(days, x, y) {
  const pts = days.filter((d) => d.base_lo !== null && d.base_hi !== null);
  if (pts.length < 2) return "";
  const top = pts.map((d) => `${x(d.date).toFixed(1)},${y(d.base_hi).toFixed(1)}`);
  const bot = pts.reverse().map((d) => `${x(d.date).toFixed(1)},${y(d.base_lo).toFixed(1)}`);
  return `M${top.join("L")}L${bot.join("L")}Z`;
}

// A season series (2026 line over the other years' range and median) in rows [y0, y1].
function seasonPanel(svg, series, x, [y0, y1], { lo, hi, digits, tip, threshold, dots = false }) {
  const y = scale([lo, hi], [y1, y0]);
  for (const v of ticks(lo, hi, 2)) {
    svg.append(s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: M.l - 5, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, digits)));
  }
  svg.append(s("path", { d: bandPath([...series.days], x, y), class: "ice-band" }));
  svg.append(s("path", { d: linePath(series.days.map((d) => ({ date: d.date, y: d.base_median })), x, y), class: "ice-median" }));
  if (threshold !== undefined) svg.append(s("line", { x1: M.l, x2: W - M.r, y1: y(threshold), y2: y(threshold), class: "ice-threshold" }));
  // Sparse series (smoke: about one day in four) as dots; dense ones (albedo) as a line.
  if (dots) {
    for (const d of series.days) if (d.value !== null) svg.append(s("circle", { cx: x(d.date), cy: y(Math.min(d.value, hi)), r: 2.6, class: "ice-dot-day" }));
  } else {
    svg.append(s("path", { d: linePath(series.days.map((d) => ({ date: d.date, y: d.value === null ? null : Math.min(d.value, hi) })), x, y), class: "ice-line" }));
  }
  for (const d of series.days) {
    if (d.value === null) continue;
    svg.append(s("circle", { cx: x(d.date), cy: y(Math.min(d.value, hi)), r: 6, class: "ice-hit" }, s("title", {}, tip(d))));
  }
}

export function init({ store, map, t, root }) {
  const heading = h("h2", { text: t("ice.title") });
  const lead = h("p", { class: "ice-lead" });
  const measured = h("p", { class: "muted small" });
  const svg = s("svg", { class: "area-chart ice-chart", role: "img" });
  const key = h(
    "p",
    { class: "ice-key muted small" },
    h("span", { class: "ice-key-line" }),
    h("span", { text: "" }),
    h("span", { class: "ice-key-band" }),
    h("span", { text: "" }),
  );
  const read = h("p");
  const strip = s("svg", { class: "ice-strip", role: "img" });
  const stripNote = h("p", { class: "muted small" });
  const speedHead = h("h3", { text: t("ice.speed_title") });
  const speedLead = h("p");
  const speedTable = h("div");
  const limits = h("p", { class: "muted small", text: t("ice.limits") });
  const show = h("button", { type: "button", class: "btn", text: t("ice.show") });
  const table = h("div");
  root.append(heading, lead, measured, svg, key, read, strip, stripNote, speedHead, speedLead, speedTable, show, limits, table);
  root.hidden = true;

  let index = null;
  let doc = null;
  let outlines = null;

  // Glacier outlines on the map wherever the icefield is in view.
  const layer = s("svg", { class: "vector-layer", "aria-hidden": "true" });
  map.panes.base.append(layer);
  map.onRender((m) => {
    const [w, hgt] = m.size();
    layer.setAttribute("width", w);
    layer.setAttribute("height", hgt);
    layer.replaceChildren();
    if (!outlines || root.hidden) return;
    for (const f of outlines.features) {
      const d = f.geometry.coordinates.map((ring) => `M${ring.map(([lon, lat]) => m.project(lon, lat).map((v) => v.toFixed(1)).join(",")).join("L")}Z`).join("");
      layer.append(s("path", { d, class: "glacier-outline" }));
    }
  });
  show.addEventListener("click", () => {
    if (doc) map.fitBounds(doc.bounds);
  });

  function chart(d) {
    svg.replaceChildren();
    const ref = d.albedo ?? d.smoke;
    svg.style.display = ref ? "" : "none"; // SVG elements have no `hidden` property
    key.hidden = !ref;
    if (!ref) return;
    const x = dayX(ref.days);
    let y0 = 0;
    // 1. Fire upwind: confident VIIRS fire pixels a day.
    if (d.fire?.days.length) {
      const [a, b] = panel(svg, y0, 64, t("ice.panel_fire", { where: d.fire.label }));
      const top = Math.max(1, ...d.fire.days.map((r) => r.n));
      const y = scale([0, top], [b, a]);
      const bw = Math.max(1, (W - M.l - M.r) / ref.days.length - 0.5);
      svg.append(s("text", { x: M.l - 5, y: a + 8, class: "tick", "text-anchor": "end" }, fmtNumber(top, 0)));
      for (const r of d.fire.days) {
        svg.append(s("rect", { x: x(r.date), y: y(r.n), width: bw, height: b - y(r.n), class: "fire-bar" }, s("title", {}, t("ice.tip_fire", { date: fmtDate(r.date), n: fmtNumber(r.n, 0) }))));
      }
      svg.append(s("line", { x1: M.l, x2: W - M.r, y1: b, y2: b, class: "grid" }));
      y0 = b + 6;
    }
    // 2. Smoke over the ice: aerosol optical depth, clipped at 1.5 so one plume does not flatten the rest.
    if (d.smoke) {
      const band = panel(svg, y0, 86, t("ice.panel_smoke"));
      seasonPanel(svg, d.smoke, x, band, {
        lo: 0,
        hi: 1.5,
        digits: 1,
        threshold: d.smoke.smoky_aod,
        dots: true,
        tip: (p) => t("ice.tip_smoke", { date: fmtDate(p.date), v: fmtNumber(p.value, 2), base: p.base_median === null ? "–" : fmtNumber(p.base_median, 2) }),
      });
      y0 = band[1] + 6;
    }
    // 3. How bright the ice is: shortwave albedo.
    if (d.albedo) {
      const vals = d.albedo.days.flatMap((p) => [p.value, p.base_lo, p.base_hi]).filter((v) => v !== null);
      const lo = Math.max(0, Math.floor((Math.min(...vals) - 0.02) * 20) / 20);
      const hi = Math.min(1, Math.ceil((Math.max(...vals) + 0.02) * 20) / 20);
      const band = panel(svg, y0, 96, t("ice.panel_albedo"));
      seasonPanel(svg, d.albedo, x, band, {
        lo,
        hi,
        digits: 2,
        tip: (p) => t("ice.tip_albedo", { date: fmtDate(p.date), v: fmtNumber(p.value, 2), base: p.base_median === null ? "–" : fmtNumber(p.base_median, 2) }),
      });
      y0 = band[1];
    }
    // Late-summer window shaded on every panel, and the fire-site's season dates on the axis.
    const [w0, w1] = ref.window.map((md) => `${d.year}-${md}`);
    svg.prepend(s("rect", { x: x(w0), y: 0, width: x(w1) - x(w0), height: y0, class: "ice-window" }));
    svg.append(
      s("text", { x: M.l, y: y0 + 14, class: "tick" }, fmtDate(ref.days[0].date, "short")),
      s("text", { x: W - M.r, y: y0 + 14, class: "tick", "text-anchor": "end" }, fmtDate(ref.days.at(-1).date, "short")),
    );
    svg.setAttribute("viewBox", `0 0 ${W} ${y0 + 20}`);
    svg.setAttribute("aria-label", t("ice.chart_label", { year: d.year }));
    key.children[1].textContent = t("ice.key_year", { year: d.year });
    key.children[3].textContent = t("ice.key_band", { first: d.baseline_years[0], last: d.baseline_years.at(-1) });
  }

  // Late-summer albedo of every year as dots on one line; the year in focus filled.
  function yearStrip(a, year) {
    strip.replaceChildren();
    const ys = a.years.filter((p) => p.value !== null);
    if (ys.length < 3) {
      strip.style.display = "none";
      return;
    }
    strip.style.display = "";
    const H = 46;
    const lo = Math.min(...ys.map((p) => p.value));
    const hi = Math.max(...ys.map((p) => p.value));
    const pad = Math.max(0.01, (hi - lo) * 0.1);
    const x = scale([lo - pad, hi + pad], [M.l, W - M.r]);
    strip.setAttribute("viewBox", `0 0 ${W} ${H}`);
    strip.append(s("line", { x1: M.l, x2: W - M.r, y1: 22, y2: 22, class: "grid" }));
    strip.append(s("text", { x: M.l, y: 42, class: "tick" }, t("ice.strip_darker")), s("text", { x: W - M.r, y: 42, class: "tick", "text-anchor": "end" }, t("ice.strip_brighter")));
    for (const p of ys) {
      const me = p.year === year;
      strip.append(s("circle", { cx: x(p.value), cy: 22, r: me ? 6 : 4, class: me ? "ice-dot ice-dot-year" : "ice-dot" }, s("title", {}, t("ice.tip_year", { year: p.year, v: fmtNumber(p.value, 3) }))));
      if (me) strip.append(s("text", { x: x(p.value), y: 10, class: "tick", "text-anchor": "middle" }, String(p.year)));
    }
    strip.setAttribute("aria-label", stripNote.textContent);
  }

  function speed(sp) {
    speedHead.hidden = !sp;
    speedLead.hidden = !sp;
    speedTable.replaceChildren();
    if (!sp) return;
    const v = speedVerdict(sp);
    const n0 = (x) => fmtNumber(x, 0);
    const parts = [
      t(v.resolved.length ? "ice.speed_some" : "ice.speed_none", { list: v.resolved.join(", ") }),
      t("ice.speed_test", {
        pairs: n0(sp.pairs),
        noise: sp.rock_noise_median_m_yr === null ? "–" : n0(sp.rock_noise_median_m_yr),
        agree: sp.ice_agree_median_pct === null ? "–" : n0(sp.ice_agree_median_pct),
        best: sp.ice_agree_max_pct === null ? "–" : n0(sp.ice_agree_max_pct),
      }),
    ];
    if (v.nisar && v.itslive) parts.push(t("ice.speed_compare", { nlo: n0(v.nisar[0]), nhi: n0(v.nisar[1]), ilo: n0(v.itslive[0]), ihi: n0(v.itslive[1]), noise: n0(sp.best_pair?.rock_noise_m_yr ?? sp.rock_noise_median_m_yr ?? 0) }));
    if (!v.resolved.length) parts.push(t("ice.speed_why"));
    if (v.error) parts.push(t("ice.speed_itslive_error", { lo: n0(v.error[0]), hi: n0(v.error[1]), n: n0(v.pairs) }));
    speedLead.textContent = parts.join(" ");
    const rows = sp.glaciers.filter((g) => g.itslive_m_yr !== null || g.nisar_m_yr !== null);
    if (!rows.length) return;
    const dash = (v, d = 0) => (v === null || v === undefined ? "–" : fmtNumber(v, d));
    speedTable.append(
      h(
        "table",
        { class: "burn-sweep ice-speed" },
        h("caption", { class: "muted small", text: t("ice.speed_caption", { track: sp.best_pair?.track ?? "", start: sp.best_pair ? fmtDate(sp.best_pair.start, "short") : "", end: sp.best_pair ? fmtDate(sp.best_pair.end, "short") : "" }) }),
        h("thead", {}, h("tr", {}, h("th", { text: t("ice.col_glacier") }), h("th", { text: t("ice.col_itslive") }), h("th", { text: t("ice.col_nisar") }), h("th", { text: t("ice.col_agree") }))),
        h(
          "tbody",
          {},
          rows.map((g) =>
            h(
              "tr",
              {},
              h("td", { text: g.name }),
              h("td", { text: g.itslive_error_m_yr ? `${dash(g.itslive_m_yr)} ± ${dash(g.itslive_error_m_yr)}` : dash(g.itslive_m_yr) }),
              h("td", { text: dash(g.nisar_m_yr) }),
              h("td", { text: g.nisar_agree_pct === null ? "–" : `${dash(g.nisar_agree_pct)}%` }),
            ),
          ),
        ),
      ),
    );
  }

  function render(d, site) {
    const dist = centreDistanceKm(site.summary.grid.bounds, d.bounds);
    lead.textContent = t("ice.lead", {
      name: d.name,
      km: fmtNumber(Math.round(dist / 10) * 10, 0),
      dir: t(`ice.dir_${bearing8(site.summary.grid.bounds, d.bounds)}`),
      area: fmtNumber(d.glaciers.area_km2, 0),
      n: fmtNumber(d.glaciers.n, 0),
    });
    const m = d.measured?.athabasca_albedo;
    measured.textContent = m ? t("ice.measured", { a: fmtNumber(m["2015"], 2), b: fmtNumber(m["2018"], 2) }) : "";
    measured.hidden = !m;
    chart(d);
    const parts = [];
    if (d.fire?.days.length) {
      const peak = d.fire.days.reduce((a, b) => (b.n > a.n ? b : a));
      parts.push(t("ice.read_fire", { where: d.fire.label, n: fmtNumber(d.fire.n, 0), date: fmtDate(peak.date), max: fmtNumber(peak.n, 0) }));
    }
    if (d.smoke?.max) {
      const sm = d.smoke;
      const top = sm.years.filter((y) => y.year !== d.year).sort((x, y) => y.value - x.value).slice(0, 3);
      parts.push(
        t("ice.read_smoke", { n: fmtNumber(sm.smoky_days, 0), measured: fmtNumber(sm.measured_days, 0), max: fmtNumber(sm.max.aod, 1), date: fmtDate(sm.max.date) }),
        sm.value !== null && sm.base_median !== null
          ? t("ice.read_smoke_years", { year: d.year, pct: fmtNumber(sm.value, 0), base: fmtNumber(sm.base_median, 0), list: top.map((y) => t("ice.year_pct", { year: y.year, pct: fmtNumber(y.value, 0) })).join(", ") })
          : "",
      );
    }
    const a = d.albedo;
    if (a && a.value !== null) {
      const [w0, w1] = a.window.map((md) => fmtDate(`${d.year}-${md}`, "short"));
      parts.push(t("ice.read_albedo", { from: w0, to: w1, year: d.year, v: fmtNumber(a.value, 2), base: fmtNumber(a.base_median, 2), rank: fmtNumber(a.rank_low, 0), n: fmtNumber(a.n_years, 0) }));
      stripNote.textContent = t("ice.strip_note", { from: w0, to: w1, cells: fmtNumber(a.cells, 0) });
      yearStrip(a, d.year);
    } else {
      strip.style.display = "none";
      stripNote.textContent = "";
    }
    read.textContent = parts.filter(Boolean).join(" ");
    speed(d.speed);
    const rows = (a ?? d.smoke)?.days ?? [];
    table.replaceChildren(
      srTable(t("ice.title"), [t("chart.col_date"), t("ice.col_aod"), t("ice.col_albedo")], rows.map((r, i) => [fmtDate(r.date), d.smoke?.days[i]?.value ?? "–", a?.days[i]?.value ?? "–"])),
    );
  }

  async function load(manifest, dataBase, site) {
    doc = null;
    outlines = null;
    root.hidden = true;
    if (!manifest?.ice || !site) return;
    try {
      if (!index) index = await (await fetch(`${dataBase}${manifest.ice}`)).json();
      const entry = iceFor(index, site.summary.site.id);
      if (!entry) {
        if (store.get().ice) store.set({ ice: false }); // no icefield downwind of this site
        return;
      }
      const base = `${dataBase}${manifest.ice.replace(/index\.json$/, "")}${entry.path.replace(/ice\.json$/, "")}`;
      const d = await (await fetch(`${base}ice.json`)).json();
      if (d.schema_version !== ICE_SCHEMA || store.get().site !== site) return;
      doc = d;
      outlines = await (await fetch(`${base}${d.glaciers.geojson}`)).json();
      root.hidden = false;
      render(d, site);
      if (store.get().ice) focus();
    } catch (err) {
      console.error("ice: data did not load", err);
      root.hidden = true; // the card is optional; the fire card above still stands
    }
    map.refresh();
  }

  // The header's Ice choice: frame the icefield and bring its card to the top of the sidebar.
  function focus() {
    if (!doc) return;
    map.fitBounds(doc.bounds);
    requestAnimationFrame(() => root.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  watch(store, ["site", "manifest"], ({ site, manifest, dataBase }) => load(manifest, dataBase, site));
  watch(store, ["ice"], ({ ice }) => {
    if (ice) focus();
  });
}
