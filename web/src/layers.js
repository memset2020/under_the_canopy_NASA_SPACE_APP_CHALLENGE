// Map layers and legend: per-pass flood map (F01), hydroperiod (F04),
// water-level change under the canopy (NISAR GUNW) and canopy structure (GEDI).
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { STATIC_VIEWS, hasDataOn, isStaticView, nearestWithData } from "./viewdata.js";

export const id = "layers";
export const slot = "map";

function overlayImage(className) {
  return h("img", { class: className, alt: "", draggable: "false", decoding: "async" });
}

export function levelFor(summary, passIndex) {
  const date = summary.passes[passIndex]?.date;
  return (summary.products.level_change ?? []).find((l) => l.to === date) ?? null;
}

// Radar views paint the real NISAR backscatter in the browser from stack.bin.
// Ranges are set from the 2026 sites (Sylhet, Atchafalaya, Janauacá medians): flooded forest
// HH ≈ −3 dB, HV ≈ −11 dB, gap ≈ 8 dB; dry forest HH ≈ −6, HV ≈ −12; open water HH ≈ −15.
const RADAR_RANGE = { hh: [-18, 0], hv: [-24, -8], gap: [4, 10] };
const byte = (v, [lo, hi]) => Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255)));

// Pass with the least mapped water: the change view's dry-season reference.
export function driestPass(summary) {
  let best = 0;
  summary.passes.forEach((p, i) => {
    if (p.flooded_km2 < summary.passes[best].flooded_km2) best = i;
  });
  return best;
}

// The change view's reference: on a fire site the last pass before the fire (v13), since there
// the least mapped water can come after it (burned forest reads as water under trees).
export function changeReference(summary) {
  const b = summary.products.burn;
  if (b?.baseline?.length) {
    const i = summary.passes.findIndex((p) => p.date === b.baseline.at(-1));
    if (i >= 0) return i;
  }
  return driestPass(summary);
}

export function paintRadar(site, passIndex, view, canvas) {
  const { width: W, height: H } = site;
  const L = site.layers;
  const hh = site.passPlane("hh", passIndex);
  const hv = site.passPlane("hv", passIndex);
  const ref = view === "change" ? site.passPlane("hh", changeReference(site.summary)) : null;
  const dbOf = (q, l) => q * l.scale + l.offset;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(W, H);
  const px = img.data;
  for (let i = 0; i < W * H; i += 1) {
    const q = hh[i];
    if (q === L.hh.nodata || hv[i] === L.hv.nodata || (ref && ref[i] === L.hh.nodata)) continue;
    const a = dbOf(q, L.hh);
    const o = i * 4;
    if (ref) {
      // Red = this pass, green and blue = the driest pass: brighter now is red, darker is cyan.
      const b = byte(dbOf(ref[i], L.hh), RADAR_RANGE.hh);
      px[o] = byte(a, RADAR_RANGE.hh);
      px[o + 1] = b;
      px[o + 2] = b;
    } else {
      const v = dbOf(hv[i], L.hv);
      px[o] = byte(a, RADAR_RANGE.hh);
      px[o + 1] = byte(v, RADAR_RANGE.hv);
      px[o + 2] = byte(a - v, RADAR_RANGE.gap);
    }
    px[o + 3] = 235;
  }
  ctx.putImageData(img, 0, 0);
}

// Pixels with no radar on this pass (outside the swath, or masked) get a light hatch: in the class
// PNG they are transparent like dry land, and an empty wedge reads as a map that failed to load.
// passIndex null hatches what no pass imaged, for the season views (Days flooded): there an
// unimaged wedge would otherwise read as dry for the whole season. Returns how many pixels were hatched.
export function paintNoRadar(site, passIndex, canvas) {
  const { width: W, height: H } = site;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!site.passPlane) return 0;
  const L = site.layers;
  const passes = passIndex === null ? site.summary.passes.map((_, k) => k) : [passIndex];
  const planes = passes.map((k) => [site.passPlane("hh", k), site.passPlane("hv", k)]);
  const seen = (i) => planes.some(([hh, hv]) => hh[i] !== L.hh.nodata && hv[i] !== L.hv.nodata);
  const img = ctx.createImageData(W, H);
  let n = 0;
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      const i = r * W + c;
      if (seen(i)) continue;
      n += 1;
      if ((r + c) % 6 < 2) img.data.set([205, 212, 214, 120], i * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  return n;
}

// D-101: where the site's own track had no radar and another track's pass filled in, the edge
// of that part is drawn dashed, so a mosaic of two looks is never read as one. passIndex null:
// filled on any pass (season views). Returns how many pixels were filled.
export function paintFill(site, passIndex, canvas) {
  const { width: W, height: H } = site;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!site.passPlane || !site.layers?.fill) return 0;
  const passes = passIndex === null ? site.summary.passes.map((_, k) => k) : [passIndex];
  const planes = passes.map((k) => site.passPlane("fill", k));
  const filled = new Uint8Array(W * H);
  let n = 0;
  for (let i = 0; i < W * H; i += 1) {
    if (planes.some((q) => q[i] === 1)) {
      filled[i] = 1;
      n += 1;
    }
  }
  const img = ctx.createImageData(W, H);
  const at = (r, c) => r >= 0 && r < H && c >= 0 && c < W && filled[r * W + c] === 1;
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      if (!at(r, c)) continue;
      const edge = !at(r - 1, c) || !at(r + 1, c) || !at(r, c - 1) || !at(r, c + 1);
      const inside = r > 0 && r < H - 1 && c > 0 && c < W - 1; // the box's own edge is not a seam
      if (edge && inside && (r + c) % 6 < 3) img.data.set([255, 255, 255, 230], (r * W + c) * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  return n;
}

// The legend line for a pass's fill, or for the season (which tracks and dates filled).
function fillNote(summary, passIndex, t) {
  const own = summary.track?.number;
  if (passIndex !== null) {
    const f = summary.passes[passIndex]?.fill;
    if (!f) return null;
    return t("legend.fill_pass", {
      track: f.track,
      own,
      date: fmtDate(f.date, "short"),
      days: fmtNumber(Math.abs(f.days_apart), 0),
      pct: fmtNumber(100 * f.share, 0),
    });
  }
  const fills = summary.passes.map((p) => p.fill).filter(Boolean);
  if (!fills.length) return null;
  const tracks = [...new Set(fills.map((f) => f.track))].join(", ");
  const most = Math.max(...fills.map((f) => Math.abs(f.days_apart)));
  return t("legend.fill_season", { tracks, own, n: fmtNumber(fills.length, 0), days: fmtNumber(most, 0) });
}

export function init({ store, map, t, root, dock }) {

  // A view opens on a pass it can show: Level change has no map on passes where no
  // interferogram ends (always the first), and opening on a blank map reads as a fault (D-081).
  function pickView(view) {
    const st = store.get();
    const s = st.site?.summary;
    if (s && !hasDataOn(s, view, st.passIndex)) {
      const k = nearestWithData(s, view, st.passIndex);
      if (k !== null) return store.set({ view, passIndex: k, playing: false });
    }
    store.set({ view });
  }
  const viewBtn = (view, key) =>
    h("button", { type: "button", class: "seg-btn", dataset: { view }, onclick: () => pickView(view) }, t(key));
  const toggle = h(
    "div",
    { class: "seg seg-wrap", role: "group", "aria-label": t("layers.view") },
    viewBtn("flood", "layers.view_flood"),
    viewBtn("hydroperiod", "layers.view_hydroperiod"),
    viewBtn("level", "layers.view_level"),
    viewBtn("canopy", "layers.view_canopy"),
    viewBtn("radar", "layers.view_radar"),
    viewBtn("change", "layers.view_change"),
    viewBtn("terrain", "layers.view_terrain"),
    viewBtn("burn", "layers.view_burn"),
  );
  const legend = h("div", { class: "legend dock-key" });
  // v9: outline of where water usually is (JRC occurrence ≥ 75 %), so the river reads as river.
  const usualCanvas = h("canvas", { class: "overlay-usual", "aria-hidden": "true" });
  const usualToggle = h("input", { type: "checkbox", id: "show-usual", checked: true });
  const usualRow = h("label", { class: "check usual-toggle", hidden: true }, usualToggle, t("legend.usual_toggle"));
  // F38: notes on the map can always be switched off, to see the data with nothing on top.
  const notesToggle = h("input", { type: "checkbox", id: "show-notes", checked: true });
  const notesRow = h("label", { class: "check notes-toggle" }, notesToggle, t("annotate.toggle"));
  notesToggle.addEventListener("change", () => store.set({ mapNotes: notesToggle.checked }));
  // The map panel (dock.js): the views and their key under Layer, the outline and notes On top.
  dock.place("layer", h("div", { class: "layers-card" }, toggle, legend), { only: true });
  dock.place("overlays", usualRow);
  dock.place("overlays", notesRow);
  usualToggle.addEventListener("change", () => {
    usualCanvas.hidden = !usualToggle.checked || store.get().view !== "flood";
  });

  function paintUsual(site) {
    const occ = site.layers && site.staticPlane && site.summary.grid_stack.static_layers.some((l) => l.name === "jrc_occurrence")
      ? site.staticPlane("jrc_occurrence")
      : null;
    usualRow.hidden = !occ;
    if (!occ) return false;
    const W = site.width;
    const H = site.height;
    usualCanvas.width = W;
    usualCanvas.height = H;
    const ctx = usualCanvas.getContext("2d");
    const img = ctx.createImageData(W, H);
    const usual = (i) => occ[i] !== 255 && occ[i] >= 75;
    for (let r = 0; r < H; r += 1) {
      for (let c = 0; c < W; c += 1) {
        const i = r * W + c;
        if (!usual(i)) continue;
        const edge = c === 0 || c === W - 1 || r === 0 || r === H - 1 ||
          !usual(i - 1) || !usual(i + 1) || !usual(i - W) || !usual(i + W);
        if (edge) img.data.set([255, 255, 255, 230], i * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    return true;
  }

  const classImg = overlayImage("overlay-class");
  const hydroImg = overlayImage("overlay-hydro");
  const levelImg = overlayImage("overlay-level");
  const canopyImg = overlayImage("overlay-canopy");
  const handImg = overlayImage("overlay-hand");
  const burnImg = overlayImage("overlay-burn");
  const radarCanvas = h("canvas", { class: "overlay-radar", "aria-hidden": "true" });
  const noRadarCanvas = h("canvas", { class: "overlay-nodata", "aria-hidden": "true" });
  const fillCanvas = h("canvas", { class: "overlay-fill", "aria-hidden": "true" });
  let preloaded = [];

  function floodLegend(summary) {
    const items = [
      h("li", {}, h("span", { class: "swatch swatch-hidden" }), t("legend.hidden_flood")),
      h("li", {}, h("span", { class: "swatch swatch-water" }), t("legend.open_water")),
      h("li", {}, h("span", { class: "swatch swatch-excluded" }), t("legend.excluded")),
      h("li", {}, h("span", { class: "swatch swatch-hatch" }), t("legend.low_confidence")),
    ];
    if (summary.products.terrain) {
      items.push(h("li", { class: "legend-note", text: t("legend.terrain_note") }));
    }
    const fl = summary.products.burn?.flood_lookalike;
    if (fl) items.push(h("li", { class: "legend-note legend-warn", text: t("legend.flood_fire_note", { pct: fmtNumber(fl.in_burned_pct, 0), date: fmtDate(fl.date, "short") }) }));
    return h("ul", { class: "legend-list" }, items);
  }

  function rampLegend(caption, rampClass, lo, hi, note) {
    return h(
      "div",
      { class: "legend-ramp" },
      h("p", { class: "legend-caption", text: caption }),
      h("div", { class: `ramp ${rampClass}`, role: "img", "aria-label": `${caption}: ${lo} – ${hi}` }),
      h("div", { class: "ramp-labels" }, h("span", { text: lo }), h("span", { text: hi })),
      note ? h("p", { class: "legend-caption legend-ramp-note", text: note }) : null,
    );
  }

  function hydroLegend(summary) {
    const hp = summary.products.hydroperiod;
    return rampLegend(
      t("legend.hydro_caption"),
      "ramp-hydro",
      t("legend.day_one"),
      t("legend.days", { n: hp.max_days }),
      t("legend.hydro_total", { km2: fmtNumber(hp.flooded_any_km2), season: hp.season_days }),
    );
  }

  function levelLegend(summary, passIndex) {
    const lv = levelFor(summary, passIndex);
    if (!lv || lv.median_cm === null) {
      // Nothing to draw on this pass: say why and offer the nearest pass that has a measurement.
      const k = nearestWithData(summary, "level", passIndex);
      const why = !lv
        ? t("legend.level_none")
        : t(`legend.level_empty_${lv.empty_reason ?? "other"}`, { from: fmtDate(lv.from, "short"), to: fmtDate(lv.to, "short"), n: fmtNumber(lv.flooded_px ?? 0, 0) });
      return h(
        "div",
        { class: "legend-empty" },
        h("p", { class: "legend-caption", text: why }),
        k === null ? null : h("button", { type: "button", class: "btn btn-small", onclick: () => store.set({ passIndex: k, playing: false }), text: t("legend.level_jump", { date: fmtDate(summary.passes[k].date) }) }),
      );
    }
    const s = fmtNumber(lv.scale_cm, 0);
    return rampLegend(
      t("legend.level_caption", { from: fmtDate(lv.from, "short"), to: fmtDate(lv.to, "short") }),
      "ramp-level",
      t("legend.level_fall", { cm: s }),
      t("legend.level_rise", { cm: s }),
      lv.median_cm === null
        ? t("legend.level_none")
        : `${t("legend.level_median", { cm: fmtNumber(lv.median_cm, 1) })} ${t("legend.level_extent", { km2: fmtNumber((lv.n_px * summary.grid.pixel_size_m ** 2) / 1e6, 1), share: fmtNumber((100 * lv.n_px) / (summary.grid.width * summary.grid.height), 1) })}${lv.sign_status === "gauge" ? "" : ` ${t("legend.level_unsigned")}`}`,
    );
  }

  function radarLegend() {
    return h(
      "div",
      { class: "legend-radar" },
      h("p", { class: "legend-caption", text: t("legend.radar_caption") }),
      h(
        "ul",
        { class: "legend-list" },
        h("li", {}, h("span", { class: "swatch", style: "background:rgb(228 206 222)" }), t("legend.radar_flooded")),
        h("li", {}, h("span", { class: "swatch", style: "background:rgb(170 200 95)" }), t("legend.radar_dry")),
        h("li", {}, h("span", { class: "swatch", style: "background:rgb(40 35 110)" }), t("legend.radar_water")),
      ),
      h("p", { class: "legend-note", text: t("legend.radar_note") }),
    );
  }

  function changeLegend(summary, passIndex) {
    const ref = changeReference(summary);
    if (ref === passIndex) return h("p", { class: "legend-caption", text: t("legend.change_same") });
    const fire = summary.products.burn ? "_fire" : "";
    return h(
      "div",
      { class: "legend-radar" },
      h("p", { class: "legend-caption", text: t(`legend.change_caption${fire}`, { ref: fmtDate(summary.passes[ref].date, "short") }) }),
      h(
        "ul",
        { class: "legend-list" },
        h("li", {}, h("span", { class: "swatch", style: "background:rgb(230 120 120)" }), t(`legend.change_brighter${fire}`)),
        h("li", {}, h("span", { class: "swatch", style: "background:rgb(60 170 175)" }), t(`legend.change_darker${fire}`)),
        h("li", {}, h("span", { class: "swatch", style: "background:rgb(150 150 150)" }), t("legend.change_same_px")),
      ),
    );
  }

  function terrainLegend(summary) {
    const hd = summary.products.hand;
    return rampLegend(t("legend.hand_caption"), "ramp-hand", "0 m", t("legend.metres_plus", { m: fmtNumber(hd.max_m, 0) }), t("legend.hand_note"));
  }

  // v13 fire sites: the first pass where HH over HV rose, dark red early to light red late
  // (pipeline/canopy/burn.py BURN_RAMP; amber stays reserved for water under the trees).
  function burnLegend(summary) {
    const b = summary.products.burn;
    const hit = b.by_pass.filter((p) => p.new_km2 > 0);
    return rampLegend(
      t("legend.burn_caption", { rise: fmtNumber(b.rise_db, 1) }),
      "ramp-burn",
      hit.length ? fmtDate(hit[0].date, "short") : "",
      hit.length ? fmtDate(hit.at(-1).date, "short") : "",
      t("legend.burn_note"),
    );
  }

  function canopyLegend(summary) {
    const c = summary.products.canopy;
    return rampLegend(t("legend.canopy_caption"), "ramp-canopy", "0 m",
      t("legend.metres", { m: fmtNumber(c.height_max_m, 0) }), t("legend.canopy_note"));
  }

  watch(store, ["site"], ({ site }) => {
    root.hidden = !site;
    for (const id2 of ["class", "hydro", "level", "canopy", "radar", "usual", "nodata", "fill", "hand", "burn"]) map.removeOverlay(id2);
    if (!site) return;
    const s = site.summary;
    const bounds = s.grid.bounds;
    hydroImg.src = site.url(s.products.hydroperiod.png);
    map.addOverlay("hydro", hydroImg, bounds);
    map.addOverlay("class", classImg, bounds);
    map.addOverlay("level", levelImg, bounds);
    map.addOverlay("radar", radarCanvas, bounds);
    map.addOverlay("nodata", noRadarCanvas, bounds);
    map.addOverlay("fill", fillCanvas, bounds);
    if (paintUsual(site)) map.addOverlay("usual", usualCanvas, bounds);
    if (s.products.canopy) {
      canopyImg.src = site.url(s.products.canopy.height_png);
      map.addOverlay("canopy", canopyImg, bounds);
    }
    if (s.products.hand) {
      handImg.src = site.url(s.products.hand.png);
      map.addOverlay("hand", handImg, bounds);
    }
    if (s.products.burn) {
      burnImg.src = site.url(s.products.burn.png);
      map.addOverlay("burn", burnImg, bounds);
    }
    toggle.querySelector('[data-view="burn"]').hidden = !s.products.burn;
    // Days flooded and water level mean nothing over a burn that reads as flood (D-076).
    for (const v of ["hydroperiod", "level"]) toggle.querySelector(`[data-view="${v}"]`).hidden = Boolean(s.products.burn);
    toggle.querySelector('[data-view="terrain"]').disabled = !s.products.hand;
    toggle.querySelector('[data-view="level"]').disabled = !(s.products.level_change ?? []).length;
    toggle.querySelector('[data-view="canopy"]').disabled = !s.products.canopy;
    // A view the site can't show falls back to the flood map.
    const view = store.get().view;
    if ((view === "level" && !(s.products.level_change ?? []).length) || (view === "canopy" && !s.products.canopy) || (view === "terrain" && !s.products.hand) || (view === "burn" && !s.products.burn) || (s.products.burn && (view === "hydroperiod" || view === "level"))) {
      store.set({ view: "flood" });
    } else if (s.products.burn && view === "flood") {
      store.set({ view: "burn" }); // a fire site opens on what it is about
    }
    // Preload every pass so play is smooth.
    preloaded = s.passes.map((p) => Object.assign(new Image(), { src: site.url(p.class_png) }));
  });

  watch(store, ["site", "passIndex", "view", "scientist"], ({ site, passIndex, view, scientist }) => {
    if (!site) return;
    const s = site.summary;
    const pass = s.passes[passIndex];
    classImg.src = site.url(pass.class_png);
    const lv = levelFor(s, passIndex);
    if (lv) levelImg.src = site.url(lv.png);
    // Scientist mode draws its own recomputed layer in place of the shipped PNG.
    classImg.hidden = view !== "flood" || Boolean(scientist?.enabled);
    hydroImg.hidden = view !== "hydroperiod";
    levelImg.hidden = view !== "level" || !lv;
    canopyImg.hidden = view !== "canopy";
    handImg.hidden = view !== "terrain";
    burnImg.hidden = view !== "burn";
    usualCanvas.hidden = view !== "flood" || !usualToggle.checked;
    const radar = view === "radar" || view === "change";
    radarCanvas.hidden = !radar;
    if (radar) paintRadar(site, passIndex, view, radarCanvas);
    const perPass = view === "flood" || radar;
    const season = view === "hydroperiod";
    const noRadar = perPass || season ? paintNoRadar(site, season ? null : passIndex, noRadarCanvas) : 0;
    noRadarCanvas.hidden = !noRadar;
    const filled = perPass || season ? paintFill(site, season ? null : passIndex, fillCanvas) : 0;
    fillCanvas.hidden = !filled;
    for (const b of toggle.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.view === view));
    }
    const legends = {
      flood: () => floodLegend(s),
      hydroperiod: () => hydroLegend(s),
      level: () => levelLegend(s, passIndex),
      canopy: () => (s.products.canopy ? canopyLegend(s) : floodLegend(s)),
      radar: () => radarLegend(),
      change: () => changeLegend(s, passIndex),
      terrain: () => (s.products.hand ? terrainLegend(s) : floodLegend(s)),
      burn: () => (s.products.burn ? burnLegend(s) : floodLegend(s)),
    };
    legend.replaceChildren((legends[view] ?? legends.flood)());
    if (isStaticView(view)) legend.append(h("p", { class: "legend-static", text: t(STATIC_VIEWS[view]) }));
    const fillText = filled ? fillNote(s, season ? null : passIndex, t) : null;
    if (fillText) legend.append(h("p", { class: "legend-fill" }, h("span", { class: "swatch swatch-fill" }), fillText));
    if (noRadar) {
      const pct = (100 * noRadar) / (site.width * site.height);
      legend.append(
        h("p", { class: "legend-nodata" }, h("span", { class: "swatch swatch-nodata" }), t(season ? "legend.no_radar_season" : "legend.no_radar", { pct: fmtNumber(pct, 0) })),
      );
    }
  });

  return { preloaded: () => preloaded };
}
