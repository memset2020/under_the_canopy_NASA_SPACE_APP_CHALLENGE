// The methane ledger (D-103): water under the trees, pass by pass, carried through the season as
// area × days, times methane emission rates measured in flooded forests elsewhere. Wetlands are the
// largest single source in the global methane budget and its largest uncertainty (Saunois et al.
// 2025, ESSD 17, 1873), and how long they stay flooded is a key input; flooded forest is the part
// cameras and C-band radar miss. This is an estimate of scale, from published rates, not a
// measurement: the card says so and shows the range, never one number alone.
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { setNote } from "./readable.js";

export const id = "methane";
export const slot = "sidebar";

// Emission rates, mg CH₄ per m² of flooded forest per day: [low, central, high].
// Tropical: Amazon floodplain flooded forest, 126 ± 20 during rising water (Bartlett et al. 1990,
// JGR 95, 16773) and 192 ± 27 (Bartlett et al. 1988, JGR 93, 1571); low and high are the means
// minus and plus one standard error, central their mean.
// Subtropical and temperate forested swamp: cypress swamps of the south-eastern US, 4.6 to 68
// (Harriss and Sebacher 1981); central 56, diffusion from the water of Big Cypress swamps (Ward et
// al. 2020, Front. Earth Sci. 8:573357), a lower bound for the total.
export const FLUX_MG_M2_D = {
  tropical: [106, 159, 219],
  temperate: [4.6, 56, 68],
};
// Sylhet (25° N) is monsoon-tropical flooded forest; the Everglades (26° N) is the Big Cypress
// setting of the temperate rates. The line between them sits at 25.5°.
export const TROPICAL_MAX_LAT = 25.5;
// IPCC AR6 WG1 Table 7.15: 100-year global warming potential of non-fossil methane.
export const GWP100_CH4 = 27.0;

const DAY_MS = 86400000;
const days = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS;

export function climateOf(summary) {
  const [, south, , north] = summary.grid.bounds;
  return Math.abs((south + north) / 2) <= TROPICAL_MAX_LAT ? "tropical" : "temperate";
}

// km² × days between passes (trapezoids), for a per-pass value; intervals where either end is null
// are left out and counted separately, so a gap is never filled by assumption.
export function areaDays(passes, value) {
  let total = 0;
  let covered = 0;
  for (let i = 1; i < passes.length; i += 1) {
    const a = value(passes[i - 1]);
    const b = value(passes[i]);
    const d = days(passes[i - 1].date, passes[i].date);
    if (a === null || a === undefined || b === null || b === undefined) continue;
    total += ((a + b) / 2) * d;
    covered += d;
  }
  return { km2Days: total, days: covered };
}

// tonnes of CH₄ for km² × days at a rate in mg m⁻² d⁻¹: 1 km² = 1e6 m², 1 t = 1e9 mg.
export const tonnes = (km2Days, mg) => (km2Days * mg) / 1000;

export function methaneLedger(summary) {
  const passes = summary.passes;
  if (!passes || passes.length < 2 || summary.site?.kind === "fire") return null;
  // A replay of a disaster from early mission data is not a flood season to count (D-107).
  if (summary.warnings?.some((w) => w.code === "early_mission_data")) return null;
  const climate = climateOf(summary);
  const [lo, mid, hi] = FLUX_MG_M2_D[climate];
  const all = areaDays(passes, (p) => p.flooded_veg_km2);
  // The share of the water under the trees that C-band missed, on the passes it can be compared
  // with (a C-band image within 6 days), carried to the season: stated as such on the card.
  const cmp = passes.filter((p) => p.hidden_from_cband_km2 !== null && p.hidden_from_cband_km2 !== undefined && p.flooded_veg_km2 > 0);
  const veg = cmp.reduce((a, p) => a + p.flooded_veg_km2, 0);
  const share = veg > 0 ? Math.min(1, cmp.reduce((a, p) => a + p.hidden_from_cband_km2, 0) / veg) : null;
  const season = days(passes[0].date, passes.at(-1).date);
  const t = (kd) => kd && { lo: tonnes(kd, lo), mid: tonnes(kd, mid), hi: tonnes(kd, hi) };
  return {
    climate,
    flux: [lo, mid, hi],
    first: passes[0].date,
    last: passes.at(-1).date,
    seasonDays: season,
    km2Days: all.km2Days,
    total: t(all.km2Days),
    missed: share === null ? null : t(all.km2Days * share),
    missedShare: share,
    comparedPasses: cmp.length,
  };
}

const fmtT = (v) => fmtNumber(v, v < 10 ? 1 : 0);

export function init({ store, t, root }) {
  const heading = h("h2", { text: t("methane.title") });
  const big = h("p", { class: "methane-big" });
  const lead = h("p", { class: "methane-lead" });
  const bar = s("svg", { class: "methane-bar", viewBox: "0 0 320 46", role: "img" });
  const missedLine = h("p", { class: "methane-missed" });
  const limit = h("p");
  const note = h("p");
  root.append(heading, big, lead, bar, missedLine, limit, note);

  function render(summary) {
    const m = methaneLedger(summary);
    root.hidden = !m || m.km2Days <= 0;
    if (root.hidden) return;
    big.replaceChildren(
      h("strong", { text: `${fmtT(m.total.lo)}–${fmtT(m.total.hi)}` }),
      h("span", { text: ` ${t("methane.unit")}` }),
    );
    lead.textContent = t("methane.lead", {
      first: fmtDate(m.first, "short"),
      last: fmtDate(m.last, "short"),
      days: fmtNumber(m.seasonDays, 0),
      mid: fmtT(m.total.mid),
      co2: fmtNumber(m.total.mid * GWP100_CH4, 0),
    });
    // One bar for the season's estimate (low to high), the part C-band missed in amber.
    const x = (v) => 8 + (v / m.total.hi) * 304;
    bar.replaceChildren(
      s("rect", { x: 8, y: 10, width: 304, height: 14, rx: 3, class: "methane-track" }),
      s("rect", { x: x(m.total.lo), y: 10, width: x(m.total.hi) - x(m.total.lo), height: 14, rx: 3, class: "methane-range" }),
      ...(m.missed ? [s("rect", { x: 8, y: 10, width: x(m.missed.mid) - 8, height: 14, rx: 3, class: "methane-hidden" })] : []),
      s("line", { x1: x(m.total.mid), x2: x(m.total.mid), y1: 6, y2: 28, class: "methane-mid" }),
      s("text", { x: 8, y: 42, class: "tick" }, "0"),
      s("text", { x: 312, y: 42, class: "tick", "text-anchor": "end" }, `${fmtT(m.total.hi)} t`),
    );
    bar.setAttribute("aria-label", t("methane.bar_aria", { lo: fmtT(m.total.lo), hi: fmtT(m.total.hi) }));
    missedLine.hidden = !m.missed;
    if (m.missed) {
      missedLine.replaceChildren(
        h("span", { class: "swatch swatch-hidden" }),
        h("span", {
          text: t("methane.missed", {
            lo: fmtT(m.missed.lo),
            hi: fmtT(m.missed.hi),
            pct: fmtNumber(100 * (m.missedShare ?? 0), 0),
            n: fmtNumber(m.comparedPasses, 0),
          }),
        }),
      );
    }
    setNote(limit, "limit", t("methane.limit"));
    setNote(note, "source", t(`methane.note_${m.climate}`, { lo: fmtNumber(m.flux[0], 1), mid: fmtNumber(m.flux[1], 0), hi: fmtNumber(m.flux[2], 0) }));
  }

  watch(store, ["site"], ({ site }) => {
    root.hidden = !site;
    if (site) render(site.summary);
  });
}
