// F09 guided story: the demo path (docs/02 §8) as three chapters the viewer steps through.
// Every number comes from the loaded summary; steps without data are skipped.
import { h } from "./svg.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { nextPasses } from "./orbitmath.js";

export const id = "story";
export const slot = "header";

const AUTO_MS = 9000;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function peakIndex(s) {
  return Math.max(0, s.passes.findIndex((p) => p.id === s.peak_pass));
}

// Steps return null when the data they need is missing.
// A box of ±dxKm, ±dyKm around the centre of [w, s, e, n].
function aroundKm([w, so, e, n], dxKm, dyKm) {
  const cx = (w + e) / 2;
  const cy = (so + n) / 2;
  const dLon = dxKm / (111.32 * Math.cos((cy * Math.PI) / 180));
  const dLat = dyKm / 110.57;
  return [cx - dLon, Math.max(-85, cy - dLat), cx + dLon, Math.min(85, cy + dLat)];
}

// How NISAR saw it: the to-scale geometry needs GIBS tracks (online) and v11 time stamps.
// The view widens to about 850 km either side: the nadir is 300-760 km beside the site (D-066).
function orbitStep(s, { online, t, view }) {
  if (!online || !s.passes.some((p) => p.acquired_utc) || !s.track?.direction) return null;
  return {
    chapter: 3,
    key: "story.orbit",
    params: {
      track: s.track.number,
      dir: t(`orbits.dir_${s.track.direction}`),
      next: fmtDate(nextPasses(s.passes.at(-1).date, new Date().toISOString().slice(0, 10), 1)[0]),
    },
    state: { compare: "off", view, selected: null, showOrbit: true },
    bounds: aroundKm(s.grid.bounds, 850, 450),
    focus: "orbits",
  };
}

// A fire site (v13) tells its own story: smoke for the camera, an echo changed for the radar,
// an independent check, and the caution that burned forest reads like flooded forest.
function fireSteps(s, opts) {
  const b = s.products.burn;
  const hitI = s.passes.map((p, i) => [i, b.by_pass[i]]).filter(([, r]) => r && r.new_km2 > 0).map(([i]) => i);
  const first = hitI.length ? hitI[0] : s.passes.length - 1;
  const last = s.passes.length - 1;
  const clear = s.passes[first].optical_clear_fraction;
  const v = b.validation;
  // Out of sample: the east half where the threshold was chosen, the whole box elsewhere.
  const ho = b.tuned_site === s.site.id ? v?.held_out : v;
  const af = b.active_fire;
  const fl = b.flood_lookalike;
  const lookI = fl ? s.passes.findIndex((p) => p.date === fl.date) : -1;
  return [
    {
      chapter: 1,
      key: clear === null ? "story.fire_intro" : "story.fire_intro_clear",
      params: {
        place: s.site.name,
        span: af?.first ? opts.t("story.fire_span", { from: fmtDate(af.first), to: fmtDate(af.last) }) : "",
        date: fmtDate(s.passes[first].date),
        clear: clear === null ? "" : fmtNumber(clear * 100, 0),
      },
      state: { compare: "off", view: "radar", passIndex: first, selected: null },
    },
    {
      chapter: 2,
      key: "story.fire_burn",
      params: { km2: fmtNumber(b.burned_km2, 0), first: fmtDate(s.passes[first].date), last: fmtDate(s.passes[hitI.at(-1) ?? last].date), rise: fmtNumber(b.rise_db, 1) },
      state: { compare: "off", view: "burn", passIndex: last, selected: null },
      focus: "burn",
    },
    ho && ho.f1 !== null && {
      chapter: 3,
      key: b.tuned_site === s.site.id ? "story.fire_check" : "story.fire_check_other",
      params: { ref: opts.t(`burn.ref_${v.product}`), short: opts.t(`burn.ref_short_${v.product}`), f1: fmtNumber(ho.f1, 2), recall: fmtNumber(ho.recall * 100, 0), precision: fmtNumber(ho.precision * 100, 0) },
      state: { compare: "off", view: "burn", selected: null },
      focus: "burn",
    },
    lookI >= 0 && {
      chapter: 3,
      key: "story.fire_lookalike",
      params: { date: fmtDate(fl.date), km2: fmtNumber(fl.km2, 0), pct: fmtNumber(fl.in_burned_pct, 0) },
      state: { compare: "off", view: "flood", passIndex: lookI, selected: null },
      focus: "burn",
    },
    orbitStep(s, { ...opts, view: "burn" }),
  ].filter(Boolean);
}

function buildSteps(site, { online = false, t = (k) => k } = {}) {
  const s = site.summary;
  if (s.products.burn) return fireSteps(s, { online, t });
  const peakI = peakIndex(s);
  const peak = s.passes[peakI];
  // Prefer the peak, else the nearest pass that has a C-band match.
  let matchI = peakI;
  if (peak.hidden_from_cband_km2 === null) {
    const m = s.passes.map((p, i) => [i, p]).filter(([, p]) => p.hidden_from_cband_km2 !== null);
    if (m.length) matchI = m.sort((a, b) => Math.abs(a[0] - peakI) - Math.abs(b[0] - peakI))[0][0];
  }
  const match = s.passes[matchI];
  const expo = s.exposure;
  const nearest = expo?.places
    .filter((p) => p.nearest_flood_m !== null)
    .sort((a, b) => a.nearest_flood_m - b.nearest_flood_m)[0];
  const gauge = s.validation.gauge;
  const steps = [
    s.products.optical && {
      chapter: 1,
      key: "story.optical",
      params: {
        date: fmtDate(peak.date),
        photo: fmtDate(s.products.optical.date),
        cloud: fmtNumber(s.products.optical.cloud_fraction * 100, 0),
      },
      state: { compare: "optical", view: "flood", passIndex: peakI, selected: null },
    },
    match.cband_date && {
      chapter: 1,
      key: "story.cband",
      params: { date: fmtDate(match.cband_date), km2: fmtNumber(match.flooded_km2 - match.hidden_from_cband_km2) },
      state: { compare: "cband", view: "flood", passIndex: matchI, selected: null },
    },
    {
      chapter: 1,
      key: match.hidden_from_cband_km2 !== null ? "story.nisar" : "story.nisar_no_cband",
      params: {
        date: fmtDate(match.date),
        km2: fmtNumber(match.flooded_km2),
        hidden: fmtNumber(match.hidden_from_cband_km2 ?? 0),
      },
      // "Drag the divider to compare" needs the divider: keep the C-band swipe on here.
      state: {
        compare: match.hidden_from_cband_km2 !== null ? "cband" : "off",
        view: "flood",
        passIndex: matchI,
        selected: null,
      },
    },
    {
      chapter: 2,
      key: "story.hydro",
      params: { km2: fmtNumber(s.products.hydroperiod.flooded_any_km2), max: s.products.hydroperiod.max_days, season: s.products.hydroperiod.season_days },
      state: { compare: "off", view: "hydroperiod", selected: null },
    },
    nearest && {
      chapter: 2,
      key: "story.people",
      params: {
        n: fmtNumber(expo.population_near_hidden_flood, 0),
        place: nearest.name,
        m: fmtNumber(nearest.nearest_flood_m, 0),
        days: nearest.days_flooded,
      },
      state: { compare: "off", view: "flood", passIndex: peakI, selected: site.lonLatToGrid(nearest.lon, nearest.lat) },
      center: [nearest.lon, nearest.lat],
    },
    gauge && gauge.r !== null && {
      chapter: 3,
      key: "story.gauge",
      params: { r: fmtNumber(gauge.r, 2), n: gauge.n, lag: Math.abs(gauge.best_lag_days) },
      state: { compare: "off", view: "flood", selected: null },
      focus: "validation",
    },
    orbitStep(s, { online, t, view: "flood" }),
    {
      chapter: 3,
      key: "story.limits",
      params: {},
      state: { compare: "off", view: "flood", selected: null },
      focus: "physics",
    },
  ];
  return steps.filter(Boolean);
}

export function init({ store, map, t, root }) {
  const open = h("button", { type: "button", class: "btn btn-primary story-open", text: t("story.open") });
  const chapter = h("p", { class: "story-chapter" });
  const text = h("p", { class: "story-text", "aria-live": "polite" });
  const progress = h("div", { class: "story-progress", "aria-hidden": "true" });
  const back = h("button", { type: "button", class: "btn btn-small", text: t("story.back") });
  const next = h("button", { type: "button", class: "btn btn-small btn-primary", text: t("story.next") });
  const auto = h("button", { type: "button", class: "btn btn-small", "aria-pressed": "false", text: t("story.auto") });
  const close = h("button", { type: "button", class: "icon-btn story-close", "aria-label": t("story.close") }, "×");
  const card = h(
    "div",
    { class: "story-card", role: "region", "aria-label": t("story.region"), hidden: true, dataset: { mapControl: "" } },
    h("div", { class: "story-head" }, chapter, close),
    text,
    progress,
    h("div", { class: "story-actions" }, back, auto, next),
  );
  root.append(open);
  map.container.parentElement.append(card);

  let steps = [];
  let index = 0;
  let timer = 0;

  function show(i) {
    index = Math.max(0, Math.min(steps.length - 1, i));
    const st = steps[index];
    chapter.textContent = t(`story.chapter_${st.chapter}`);
    text.textContent = t(st.key, st.params);
    progress.replaceChildren(
      ...steps.map((_, k) => h("span", { class: k === index ? "dot is-on" : k < index ? "dot is-done" : "dot" })),
    );
    back.disabled = index === 0;
    next.textContent = t(index === steps.length - 1 ? "story.finish" : "story.next");
    store.set({ playing: false, ...st.state });
    if (st.center) map.setView(st.center, Math.max(map.getZoom(), 13));
    else map.fitBounds(st.bounds ?? store.get().site.summary.grid.bounds);
    if (st.focus) {
      const card = document.querySelector(`section.feature[data-feature="${st.focus}"]`); // the card, not its map-panel controls
      // A card the viewer collapsed (cards.js) opens through its own button, which keeps that choice.
      if (card?.classList.contains("is-collapsed")) card.querySelector(":scope > .card-toggle")?.click();
      card?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
    }
  }

  function stopAuto() {
    clearInterval(timer);
    timer = 0;
    auto.setAttribute("aria-pressed", "false");
  }

  function start() {
    const site = store.get().site;
    if (!site) return;
    steps = buildSteps(site, { online: store.get().online, t });
    card.hidden = false;
    document.body.classList.add("is-story");
    show(0);
    next.focus();
  }

  function end() {
    stopAuto();
    card.hidden = true;
    document.body.classList.remove("is-story");
    open.focus();
  }

  open.addEventListener("click", start);
  close.addEventListener("click", end);
  back.addEventListener("click", () => {
    stopAuto();
    show(index - 1);
  });
  next.addEventListener("click", () => {
    if (index === steps.length - 1) return end();
    show(index + 1);
  });
  auto.addEventListener("click", () => {
    if (timer) return stopAuto();
    auto.setAttribute("aria-pressed", "true");
    timer = setInterval(() => (index === steps.length - 1 ? stopAuto() : show(index + 1)), AUTO_MS);
  });
  card.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      end();
    }
  });
  store.subscribe((_s, _p, changed) => {
    if (changed.includes("site") && !card.hidden) end();
  });
}
