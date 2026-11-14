// What's here, anywhere (F41): a crosshair readout of the global cell under the map centre,
// an "In view" summary of everything visible, and a way back when you leave a site's map.
// Works for every place on Earth from the static 0.25° grid; no network calls.
import { factRow, note } from "./readable.js";
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtApprox, fmtNumber, fmtYear } from "./i18n.js";

export const id = "here";
export const slot = "sidebar";

const KM_PER_DEG = 111.32;
const SUMMARY_MS = 250;

const inside = ([lon, lat], [w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n;
const intersects = ([w, s, e, n], [w2, s2, e2, n2]) => w < e2 && e > w2 && s < n2 && n > s2;

export function monthName(m, style = "long") {
  if (!m) return null;
  return new Intl.DateTimeFormat(document.documentElement.lang || "en", { month: style, timeZone: "UTC" }).format(
    new Date(Date.UTC(2026, m - 1, 15)),
  );
}

// Plain words for a GRACE-DA percentile, at the US Drought Monitor's percentile classes
// (≤ 30 abnormally dry, ≤ 10 severe drought), mirrored on the wet side.
export function pctileBand(p) {
  if (p <= 10) return "very_dry";
  if (p <= 30) return "dry";
  if (p < 70) return "normal";
  if (p < 90) return "wet";
  return "very_wet";
}

// Area-weighted sums over the visible cells of the global grid.
export function viewSummary(g, [west, south, east, north]) {
  const { width: W, height: H, res_deg: res } = g.meta.grid;
  const nod = g.meta.nodata;
  const likely = g.plane("likely");
  const passes = g.plane("nisar_passes");
  const water = g.plane("water_pct");
  const people = g.plane("people");
  const storage = g.plane("water_storage_cm");
  const ch4 = g.plane("wetland_ch4");
  // 256 decoded values once, so a world view does not decode a million cells one by one.
  const ch4Mg = ch4 ? Float64Array.from({ length: 256 }, (_, q) => (q === nod ? 0 : g.decode(q, "log_mg"))) : null;
  const r0 = Math.max(0, Math.floor((90 - Math.min(north, 85)) / res));
  const r1 = Math.min(H - 1, Math.floor((90 - Math.max(south, -85)) / res));
  const span = Math.min(360, east - west);
  const c0 = Math.floor((((west + 180) % 360) + 360) % 360 / res);
  const nCols = Math.min(W, Math.ceil(span / res) + 1);
  const out = { land: 0, covered: 0, likelyKm2: 0, likelyPeople: 0, storageSum: 0, storageArea: 0, ch4TonnesYr: 0 };
  for (let r = r0; r <= r1; r += 1) {
    const lat = 90 - (r + 0.5) * res;
    const cellKm2 = (res * KM_PER_DEG) ** 2 * Math.cos((lat * Math.PI) / 180);
    for (let k = 0; k < nCols; k += 1) {
      const i = r * W + ((c0 + k) % W);
      if (water && (water[i] === nod || water[i] >= 99)) continue; // ocean and big lakes
      out.land += cellKm2;
      if (passes[i] !== nod && passes[i] >= g.meta.min_passes_detailed) out.covered += cellKm2;
      if (likely[i] === 2) {
        out.likelyKm2 += cellKm2;
        if (people && people[i] !== nod) out.likelyPeople += g.decode(people[i], "log_people");
      }
      // mg m⁻² d⁻¹ × km² → tonnes a year: × 1e6 m² × 365 d / 1e9 mg per tonne.
      if (ch4) out.ch4TonnesYr += ch4Mg[ch4[i]] * cellKm2 * 0.365;
      if (storage && storage[i] !== nod) {
        out.storageSum += g.decode(storage[i], "signed_cm") * cellKm2;
        out.storageArea += cellKm2;
      }
    }
  }
  return out;
}

// The same sum over the whole grid, once per grid: the share "of the world's" uses the same
// cells and the same land mask, so a world view reads 100 %.
const worldCh4 = new WeakMap();
export function worldCh4TonnesYr(g) {
  if (!worldCh4.has(g)) worldCh4.set(g, viewSummary(g, [-180, -85, 180, 85]).ch4TonnesYr);
  return worldCh4.get(g);
}

export function init({ store, map, t, root }) {
  const stage = map.container.parentElement;

  // Crosshair and its readout, on the map.
  const reticle = h("div", { class: "reticle", "aria-hidden": "true" });
  const readout = h("section", { class: "readout", "aria-label": t("here.readout"), hidden: true });
  const readTitle = h("p", { class: "readout-title" });
  const readGrid = h("dl", { class: "readout-grid" });
  readout.append(readTitle, readGrid);
  const away = h("div", { class: "away-chip", hidden: true, dataset: { mapControl: "" } });
  const awayText = h("span");
  const toWorld = h("button", { type: "button", class: "btn btn-small btn-primary", text: t("here.to_world") });
  const back = h("button", { type: "button", class: "btn btn-small", text: t("here.back") });
  away.append(awayText, toWorld, back);
  const gridNote = h("p", { class: "grid-note", text: t("here.grid_note") });
  // Map controls: zoom buttons (pointer and touch users without a wheel) and a scale bar,
  // since the headline numbers are areas in km².
  const zoomIn = h("button", { type: "button", "aria-label": t("map.zoom_in"), text: "+" });
  const zoomOut = h("button", { type: "button", "aria-label": t("map.zoom_out"), text: "−" });
  const ctl = h("div", { class: "map-ctl", dataset: { mapControl: "" } }, zoomIn, zoomOut);
  const scaleBar = h("div", { class: "scale-bar", "aria-hidden": "true" }, h("b"), h("span"));
  zoomIn.addEventListener("click", () => map.zoomIn());
  zoomOut.addEventListener("click", () => map.zoomOut());
  stage.append(reticle, readout, away, gridNote, ctl, scaleBar);

  function updateScale(m) {
    const lat = m.getCenter()[1];
    const mPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** m.getZoom();
    const target = mPerPx * 110; // about 110 px
    const p10 = 10 ** Math.floor(Math.log10(target));
    const nice = [1, 2, 5, 10].map((k) => k * p10).filter((v) => v <= target).pop();
    scaleBar.querySelector("span").style.width = `${Math.round(nice / mPerPx)}px`;
    scaleBar.querySelector("b").textContent = nice >= 1000 ? `${fmtNumber(nice / 1000, 0)} km` : `${fmtNumber(nice, 0)} m`;
  }

  // "In view" card, in the sidebar (World mode).
  // One fact per row (readable.js, D-093): forest with water, NISAR's reach, water storage, methane.
  const summary = h("ul", { class: "here-summary rd-facts", "aria-live": "polite" });
  root.append(h("h2", { text: t("here.title") }), summary, note("info", t("here.caveat")));
  root.hidden = true;

  let timer = 0;
  const g = () => store.get().global;

  function view(m) {
    const [w, hgt] = m.size();
    const [west, north] = m.unproject(0, 0);
    const [east, south] = m.unproject(w, hgt);
    return [west, south, east, north];
  }

  // Label over value, kept together so the grid reads item by item.
  function item(label, value) {
    return [h("div", { class: "readout-item" }, h("dt", { text: label }), h("dd", { text: value }))];
  }

  function updateReadout(m) {
    const st = store.get();
    const grid = g();
    const centre = m.getCenter();
    const inSite = st.site && inside(centre, st.site.summary.grid.bounds);
    const show = Boolean(grid) && !inSite && (st.mode === "world" || st.mode === "site");
    readout.hidden = !show;
    reticle.hidden = !show;
    document.body.classList.toggle("has-readout", show); // phone layout (CSS)
    if (!show) return;
    const v = grid.cell(centre[0], centre[1]).values;
    const [lon, lat] = centre;
    readTitle.textContent = t("here.at", {
      lat: `${fmtNumber(Math.abs(lat), 2)}°${lat >= 0 ? "N" : "S"}`,
      lon: `${fmtNumber(Math.abs(lon), 2)}°${lon >= 0 ? "E" : "W"}`,
    });
    const rows = [
      ...item(t("here.k_screen"), t(`here.likely_${v.likely ?? "none"}`)),
      ...item(
        t("here.k_nisar"),
        v.nisar_passes
          ? t(v.nisar_passes >= grid.meta.min_passes_detailed ? "here.passes_ok" : "here.passes_few", { n: v.nisar_passes })
          : t("here.none"),
      ),
      ...item(t("here.k_forest"), v.forest_pct === null ? t("here.none") : `${fmtNumber(v.forest_pct, 0)}%`),
      ...item(t("here.k_peak"), monthName(v.wettest_month) ?? t("here.none")),
      ...item(
        t("here.k_storage"),
        v.water_storage_cm === null || v.water_storage_cm === undefined
          ? t("here.none")
          : `${v.water_storage_cm > 0 ? "+" : v.water_storage_cm < 0 ? "−" : ""}${fmtNumber(Math.abs(v.water_storage_cm), 0)} cm`,
      ),
      ...item(
        t("here.k_ground"),
        v.groundwater_pctile === null || v.groundwater_pctile === undefined ? t("here.none") : t(`here.gw_${pctileBand(v.groundwater_pctile)}`),
      ),
      ...item(t("here.k_people"), v.people === null ? t("here.none") : fmtApprox(v.people)),
    ];
    readGrid.replaceChildren(...rows);
  }

  function updateAway(m) {
    const st = store.get();
    const site = st.site;
    const gone = st.mode === "site" && site && !intersects(site.summary.grid.bounds, view(m));
    away.hidden = !gone;
    document.body.classList.toggle("is-away", Boolean(gone));
    if (gone) awayText.textContent = t("here.away", { site: site.summary.site.name });
  }

  function updateSummary(m) {
    const grid = g();
    root.hidden = !grid;
    if (!grid) return;
    const s = viewSummary(grid, view(m));
    if (s.land < 1) {
      summary.replaceChildren(factRow("water", t("here.sea")));
      return;
    }
    const parts = [
      ["forest", t("here.sum_likely", { km2: fmtApprox(s.likelyKm2), people: fmtApprox(s.likelyPeople) })],
      ["satellite", t("here.sum_nisar", { pct: fmtNumber((100 * s.covered) / s.land, 0) })],
    ];
    if (s.storageArea > 0) {
      const cm = s.storageSum / s.storageArea;
      const month = grid.meta.water_storage_month ? monthName(Number(grid.meta.water_storage_month.slice(5, 7))) : "";
      parts.push([
        "drop",
        Math.abs(cm) < 0.5
          ? t("here.sum_normal", { month })
          : t(cm > 0 ? "here.sum_wetter" : "here.sum_drier", { cm: fmtNumber(Math.abs(cm), 0), month }),
      ]);
    }
    const ch4 = grid.meta.wetland_ch4;
    const world = ch4 ? worldCh4TonnesYr(grid) : 0;
    const share = world > 0 ? (100 * s.ch4TonnesYr) / world : 0;
    if (share >= 0.05) {
      const p = { pct: fmtNumber(Math.min(share, 100), share < 1 ? 1 : 0), year: fmtYear(ch4.year) };
      parts.push([
        "gas",
        s.ch4TonnesYr >= 1e6
          ? t("here.sum_ch4_mt", { ...p, mt: fmtNumber(s.ch4TonnesYr / 1e6, s.ch4TonnesYr < 1e7 ? 1 : 0) })
          : t("here.sum_ch4", { ...p, t: fmtApprox(s.ch4TonnesYr) }),
      ]);
    }
    summary.replaceChildren(...parts.map(([i, text]) => factRow(i, text)));
  }

  map.on("move", (m) => {
    // The world grid shows in every mode once zoomed out past a single site (CSS reads this).
    document.body.classList.toggle("is-regional", m.getZoom() <= 9);
    updateScale(m);
    updateReadout(m);
    updateAway(m);
    clearTimeout(timer);
    timer = setTimeout(() => updateSummary(m), SUMMARY_MS);
  });

  toWorld.addEventListener("click", () => store.set({ mode: "world" }));
  back.addEventListener("click", () => {
    const site = store.get().site;
    if (site) map.fitBounds(site.summary.grid.bounds);
  });

  watch(store, ["global", "mode", "site"], () => {
    updateReadout(map);
    updateAway(map);
    updateSummary(map);
  });
}
