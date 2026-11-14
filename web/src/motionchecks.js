// Ground that moved: how we know (docs/10 D-082). Every check is independent of our own
// processing and every number is from the published event file:
// - earthquake: JPL's processing of the same NISAR pairs (the points USGS resampled for its
//   model) against ours; the USGS finite-fault model, forward modelled with Okada (1985), against
//   each geometry, kept apart for the geometries USGS used and any it did not (held out);
// - subsidence: GNSS stations (Nevada Geodetic Laboratory) against NISAR at the station, same
//   months where a station has them, an earlier year otherwise (labelled).
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { layerData } from "./motionmaps.js";
import { leadP, note } from "./readable.js";

export const id = "motionchecks";
export const slot = "sidebar";

// The held-out geometries: in the model's fit, not used by it.
export function heldOut(fit) {
  return Object.entries(fit ?? {}).filter(([k, v]) => v && v.used_by_model === false && /^\d{3}[AD]$/.test(k)).map(([k]) => k);
}

// Median residual of a geometry either side of a longitude (cells measured in both planes).
export function residualBySide(doc, view, key, lon0) {
  const r = layerData(doc, view, `resid:los_${key}:model_los_${key}`);
  if (!r) return null;
  const { width: W, bounds: [w, , e] } = doc.grid;
  const west = [];
  const east = [];
  for (let i = 0; i < r.values.length; i++) {
    const v = r.values[i];
    if (!Number.isFinite(v)) continue;
    const lon = w + (((i % W) + 0.5) * (e - w)) / W;
    (lon < lon0 ? west : east).push(v);
  }
  const med = (a) => {
    if (!a.length) return NaN;
    a.sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  return { west: med(west), east: med(east), nWest: west.length, nEast: east.length };
}

export function init({ store, map, t, root, dock }) {
  const heading = h("h2", { text: t("checks.title") });
  const body = h("div", { class: "checks-body" });
  const slipRow = h("label", { class: "check", hidden: true });
  const slip = h("input", { type: "checkbox", id: "motion-slip" });
  slipRow.append(slip, h("span", { text: t("checks.show_slip") }));
  root.append(heading, body);
  // The slip is drawn on the map: its switch goes On top in the map panel (dock.js).
  dock.place("overlays", slipRow);
  root.hidden = true;
  const svg = s("svg", { class: "vector-layer motion-layer", "aria-hidden": "true" });
  map.panes.top.prepend(svg); // under the profile and the fault lines
  const st = () => store.get();

  function geomLabel(doc, key) {
    const g = doc.geometries.find((x) => x.key === key);
    return g ? `${g.track} ${t(`orbits.dir_${g.direction}`)}` : key;
  }

  function render() {
    const b = st().motion;
    root.hidden = st().mode !== "motion" || !b;
    body.replaceChildren();
    if (!b) return;
    const { doc } = b;
    slipRow.hidden = !doc.model;
    if (doc.kind === "earthquake") quake(doc, b.view);
    else sinking(doc);
  }

  function quake(doc, view) {
    // 1. Our processing against JPL's, same pairs.
    const jpl = doc.geometries.filter((g) => g.jpl);
    if (jpl.length) {
      const corr = jpl.map((g) => g.jpl.corr);
      const rms = jpl.map((g) => g.jpl.rms_diff_cm);
      const slope = jpl.map((g) => g.jpl.slope);
      body.append(
        h("h3", { text: t("checks.jpl_title") }),
        leadP(t("checks.jpl_lead", {
            n: jpl.length,
            rmin: fmtNumber(Math.min(...corr), 3),
            rmax: fmtNumber(Math.max(...corr), 3),
            dmin: fmtNumber(Math.min(...rms), 1),
            dmax: fmtNumber(Math.max(...rms), 1),
            smin: fmtNumber((Math.min(...slope) - 1) * 100, 0),
            smax: fmtNumber((Math.max(...slope) - 1) * 100, 0),
          })),
        table(
          t("checks.jpl_title"),
          [t("motion.col_track"), t("checks.col_points"), "r", t("checks.col_rms"), t("checks.col_slope")],
          jpl.map((g) => [geomLabel(doc, g.key), fmtNumber(g.jpl.n, 0), fmtNumber(g.jpl.corr, 3), fmtNumber(g.jpl.rms_diff_cm, 1), fmtNumber(g.jpl.slope, 2)]),
        ),
      );
    }
    // 2. The USGS model against each geometry; the held-out one first.
    const m = doc.model;
    if (!m) return;
    const fit = m.fit ?? {};
    const keys = doc.geometries.map((g) => g.key).filter((k) => fit[k]);
    const held = heldOut(fit);
    const used = keys.filter((k) => !held.includes(k));
    body.append(
      h("h3", { text: t("checks.model_title") }),
      note("source", t("checks.model_lead", { label: m.label, mw: fmtNumber(m.mw, 2), data: m.used_data ?? "–" })),
    );
    if (used.length) {
      const r = used.map((k) => fit[k].corr);
      const e = used.map((k) => fit[k].rms_resid_cm);
      body.append(leadP(t("checks.model_used", { n: used.length, rmin: fmtNumber(Math.min(...r), 2), rmax: fmtNumber(Math.max(...r), 2), emin: fmtNumber(Math.min(...e), 1), emax: fmtNumber(Math.max(...e), 1) })));
    }
    const main = [...(doc.quakes ?? [])].sort((a, b) => b.mag - a.mag)[0];
    for (const k of held) {
      const f = fit[k];
      // The track the model never saw is the real test: set apart from the rest (D-093).
      const p = leadP(t("checks.model_held", { track: geomLabel(doc, k), r: fmtNumber(f.corr, 2), e: fmtNumber(f.rms_resid_cm, 1), obs: fmtNumber(f.rms_obs_cm, 1) }), "checks-held rd-callout");
      body.append(p);
      const side = main ? residualBySide(doc, view, k, main.lon) : null;
      if (side && side.nWest > 200 && side.nEast > 200) {
        body.append(leadP(t("checks.model_sides", { mag: fmtNumber(main.mag, 1), west: fmtNumber(side.west, 1), east: fmtNumber(side.east, 1) })));
      }
      const btn = h("button", { type: "button", class: "btn btn-small", text: t("checks.show_resid", { track: geomLabel(doc, k) }) });
      btn.addEventListener("click", () => store.set({ motionLayer: `resid:los_${k}:model_los_${k}`, motionDate: null, motionStyle: { ...st().motionStyle, fringe: null, range: "auto" } }));
      body.append(btn);
    }
    body.append(
      table(
        t("checks.model_title"),
        [t("motion.col_track"), t("checks.col_used"), "r", t("checks.col_resid")],
        keys.map((k) => [geomLabel(doc, k), fit[k].used_by_model ? t("checks.yes") : t("checks.no_held"), fmtNumber(fit[k].corr, 2), fmtNumber(fit[k].rms_resid_cm, 1)]),
      ),
      note("limit", t("checks.model_limits", { nu: fmtNumber(m.poisson, 2) })),
    );
  }

  function sinking(doc) {
    const list = doc.gnss ?? [];
    body.append(h("h3", { text: t("checks.gnss_title") }));
    if (!list.length) {
      body.append(note("limit", t("checks.gnss_none")));
      return;
    }
    const same = list.filter((g) => g.period === "same");
    for (const g of same) {
      const asc = doc.geometries.find((x) => x.direction === "ascending");
      body.append(
        leadP(t("checks.gnss_same", {
            id: g.id,
            start: fmtDate(g.start),
            end: fmtDate(g.end),
            gnss: fmtNumber(g.rate_u_cm_yr, 1),
            nisar: g.nisar.rate_up_cm_yr !== undefined ? fmtNumber(g.nisar.rate_up_cm_yr, 1) : "–",
            track: asc ? geomLabel(doc, asc.key) : "–",
            glos: asc ? fmtNumber(g.los_rate_cm_yr[asc.key], 1) : "–",
            nlos: asc && g.nisar.rate_los_cm_yr?.[asc.key] !== undefined ? fmtNumber(g.nisar.rate_los_cm_yr[asc.key], 1) : "–",
          })),
      );
      const btn = h("button", { type: "button", class: "btn btn-small", text: t("checks.gnss_show", { id: g.id }) });
      btn.addEventListener("click", () => {
        store.set({ motionPick: { lon: g.lon, lat: g.lat } });
        map.setView([g.lon, g.lat], Math.max(map.getZoom(), 12));
      });
      body.append(btn);
    }
    body.append(scatter(doc, list));
    const rows = [];
    for (const g of list) {
      for (const geo of doc.geometries) {
        rows.push([`${g.id} (${t(`checks.period_${g.period}`)})`, geomLabel(doc, geo.key), fmtNumber(g.los_rate_cm_yr[geo.key], 1), g.nisar.rate_los_cm_yr?.[geo.key] !== undefined ? fmtNumber(g.nisar.rate_los_cm_yr[geo.key], 1) : "–"]);
      }
    }
    body.append(
      note("info", t("checks.table_lead")),
      table(t("checks.gnss_title"), [t("checks.col_station"), t("motion.col_track"), t("checks.col_gnss_los"), t("checks.col_nisar_los")], rows),
      note("limit", t("checks.gnss_limits")),
    );
  }

  // GNSS vertical against NISAR vertical at each station, with the 1:1 line.
  function scatter(doc, list) {
    const pts = list.filter((g) => g.nisar.rate_up_cm_yr !== undefined);
    const W = 300;
    const H = 220;
    const M = { l: 44, r: 12, t: 12, b: 40 };
    const all = pts.flatMap((g) => [g.rate_u_cm_yr, g.nisar.rate_up_cm_yr]);
    const lo = Math.min(-5, ...all) - 2;
    const hi = Math.max(2, ...all) + 2;
    const x = scale([lo, hi], [M.l, W - M.r]);
    const y = scale([lo, hi], [H - M.b, M.t]);
    const out = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "area-chart checks-scatter", role: "img", "aria-label": t("checks.scatter_aria") });
    for (const v of ticks(lo, hi, 4)) {
      out.append(
        s("line", { x1: x(v), x2: x(v), y1: M.t, y2: H - M.b, class: "grid" }),
        s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }),
        s("text", { x: x(v), y: H - M.b + 14, class: "tick", "text-anchor": "middle" }, fmtNumber(v, 0)),
        s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)),
      );
    }
    out.append(s("line", { x1: x(lo), y1: y(lo), x2: x(hi), y2: y(hi), class: "checks-one" }));
    for (const g of pts) {
      const cx = x(g.rate_u_cm_yr);
      const cy = y(g.nisar.rate_up_cm_yr);
      out.append(
        s("circle", { cx, cy, r: 5, class: g.period === "same" ? "checks-pt" : "checks-pt earlier" }),
        s("text", { x: cx + 8, y: cy + 4, class: "tick" }, g.id),
      );
    }
    out.append(
      s("text", { x: (M.l + W - M.r) / 2, y: H - 6, class: "tick", "text-anchor": "middle" }, t("checks.x_gnss")),
      s("text", { x: 10, y: M.t, class: "tick", transform: `rotate(-90 10 ${M.t})`, "text-anchor": "end" }, t("checks.y_nisar")),
    );
    return h(
      "div",
      {},
      out,
      h("ul", { class: "motion-series-key" }, h("li", {}, h("span", { class: "swatch pt" }), t("checks.key_same")), h("li", {}, h("span", { class: "swatch pt earlier" }), t("checks.key_earlier")), h("li", {}, t("checks.key_one"))),
    );
  }

  function table(caption, headers, rows) {
    const wrap = h("div", { class: "checks-table-wrap" });
    wrap.append(
      h(
        "table",
        { class: "checks-table", "aria-label": caption },
        h("thead", {}, h("tr", {}, headers.map((x) => h("th", { scope: "col", text: x })))),
        h("tbody", {}, rows.map((r) => h("tr", {}, r.map((x) => h("td", { text: x }))))),
      ),
    );
    return wrap;
  }

  // Stations as triangles (the usual GNSS symbol), and the USGS slip patches when asked for.
  map.onRender((m) => {
    const [w, hgt] = m.size();
    svg.setAttribute("width", w);
    svg.setAttribute("height", hgt);
    svg.replaceChildren();
    const b = st().motion;
    if (!b || st().mode !== "motion") return;
    const { doc } = b;
    if (st().motionSlip && doc.model) {
      const peak = Math.max(...doc.model.patches.map((p) => p.slip_m), 0.01);
      for (const p of doc.model.patches) {
        if (p.slip_m < 0.05 * peak) continue;
        const d = `M${p.ring.map(([lon, lat]) => m.project(lon, lat).map((v) => v.toFixed(1)).join(",")).join("L")}Z`;
        svg.append(s("path", { d, class: "checks-patch", "fill-opacity": (0.1 + 0.6 * (p.slip_m / peak)).toFixed(2) }, s("title", {}, t("checks.patch_tip", { slip: fmtNumber(p.slip_m, 2) }))));
      }
    }
    for (const g of doc.gnss ?? []) {
      const [px, py] = m.project(g.lon, g.lat);
      svg.append(
        s("path", { d: `M${px},${py - 8}L${px + 7},${py + 5}L${px - 7},${py + 5}Z`, class: g.period === "same" ? "checks-station" : "checks-station earlier" }, s("title", {}, `${g.id} (${t(`checks.period_${g.period}`)})`)),
        s("text", { x: px + 9, y: py + 4, class: "checks-station-label" }, g.id),
      );
    }
  });

  slip.addEventListener("change", () => store.set({ motionSlip: slip.checked }));
  watch(store, ["motion", "mode"], () => {
    render();
    map.refresh();
  });
  watch(store, ["motionSlip"], () => map.refresh());
}

