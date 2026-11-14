// Satellites behind the map: NASA GIBS ground tracks (vector tiles) for NISAR and the missions
// this project compares against. On a site, the orbit that imaged the pass is found by the
// granule's own time stamp (GIBS's predicted times run 2-5 min early, docs/10 D-066), and the
// card says how far to the side the radar looked from and at what angle. Tiles only (D-054).
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber, language } from "./i18n.js";
import { decodeTile, tileToLonLat, tilesFor } from "./mvt.js";
import { EARTH_KM, NISAR_ALT_KM, NISAR_REPEAT_DAYS, closestOnLine, incidenceDeg, nextPasses } from "./orbitmath.js";
import { localSolarHours, nightRing, sunElevationDeg, terminator } from "./sun.js";
import { note, tiles } from "./readable.js";

export const id = "orbits";
export const slot = "sidebar";

const NISAR_COLOUR = "#e8eeea"; // --text: the hero track
const CONTEXT_COLOUR = "rgba(232, 238, 234, 0.45)"; // the same day's other NISAR orbits
const OTHER_COLOUR = "#d95926"; // categorical slot 2 (dark), validated against the map surface
const MAX_CACHE = 240;
// GIBS's minute points are 2-5 min early (40 granules, Jun-Jul 2026): the imaging orbit is the one
// with points in this window around the granule time, never more than one orbit (~100 min each).
const MATCH_BEFORE_MS = 12 * 60000;
const MATCH_AFTER_MS = 6 * 60000;

const DAY_MS = 86400000;
const NIGHT_FILL = "rgba(2, 6, 16, 0.42)"; // without the night lights
const NIGHT_FILL_LIGHTS = "rgba(2, 6, 16, 0.2)"; // over the Black Marble: a little darker still
const NIGHT_LAYER = "VIIRS_Black_Marble";
const TERMINATOR_COLOUR = "rgba(232, 238, 234, 0.85)"; // dashed, so it never reads as a track

// Hours as HH:MM in the page language's digits (a solar time, not a clock in a time zone).
function hhmm(hours) {
  const m = Math.round(hours * 60) % 1440;
  const two = new Intl.NumberFormat(language(), { minimumIntegerDigits: 2, useGrouping: false });
  return `${two.format(Math.floor(m / 60))}:${two.format(m % 60)}`;
}
const todayIso = () => new Date().toISOString().slice(0, 10);
const shiftIso = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// The 4326 tile level whose tiles are about a third of the view wide (at most the deepest).
export function levelFor(levels, viewSpanDeg) {
  let best = 0;
  levels.forEach((lv, i) => {
    if (lv.span_deg >= viewSpanDeg / 3) best = i;
  });
  return best;
}

export { tilesFor }; // lives in mvt.js, shared with the active-fire layer (activefire.js)

const inRange = (dates, iso) => dates.some(([a, b]) => iso >= a && iso <= b);

// Side-looking radar in one picture: the satellite 747 km up, the ground track straight under
// it, and the 242 km strip it images off to one side (NISAR's swath, docs/04).
function lookFigure(t) {
  const sx = 70;
  return s(
    "svg",
    { class: "rd-figure orbit-look", viewBox: "0 0 300 150", role: "img", "aria-label": t("orbits.fig_alt") },
    s("path", { d: "M0 122 Q150 112 300 122 L300 150 L0 150 Z", fill: "#1f2c2a" }),
    s("path", { d: `M${sx - 18} 12 h36 M${sx} 12 v6`, stroke: "#a3b2ae", "stroke-width": 2 }),
    s("rect", { x: sx - 7, y: 14, width: 14, height: 9, rx: 2, fill: "#e8eeea" }),
    s("path", { d: `M${sx} 24 L${sx} 118`, stroke: "#a3b2ae", "stroke-width": 1.2, "stroke-dasharray": "4 4" }),
    s("path", { d: `M${sx + 4} 24 L150 117 L282 120 Z`, fill: "rgb(230 159 0 / 0.16)", stroke: "#e69f00", "stroke-width": 1 }),
    s("path", { d: "M150 120 L282 122", stroke: "#e69f00", "stroke-width": 4, "stroke-linecap": "round" }),
    s("circle", { cx: sx, cy: 118, r: 3, fill: "#a3b2ae" }),
    s("text", { x: sx + 24, y: 22, class: "rd-fig-label" }, t("orbits.fig_sat")),
    s("text", { x: sx - 8, y: 70, class: "rd-fig-label", "text-anchor": "end" }, t("orbits.fig_alt_short")),
    s("text", { x: sx, y: 140, class: "rd-fig-label", "text-anchor": "middle" }, t("orbits.fig_track")),
    s("text", { x: 216, y: 140, class: "rd-fig-label rd-fig-accent", "text-anchor": "middle" }, t("orbits.fig_swath")),
  );
}

export function init({ store, map, t, root, dock }) {
  const title = h("h2", { text: t("orbits.title") });
  // How NISAR looks, drawn (D-093): the track under it, the strip it images beside it.
  const lead = h("figure", { class: "rd-figure-wrap" }, lookFigure(t), h("figcaption", { class: "rd-caption", text: t("orbits.lead") }));
  const showNisar = h("input", { type: "checkbox", id: "orbit-nisar" });
  const other = h(
    "select",
    { id: "orbit-other", "aria-label": t("orbits.compare") },
    h("option", { value: "", text: t("orbits.none") }),
  );
  const crossing = h("p", { class: "orbit-crossing", "aria-live": "polite" });
  const geometry = s("svg", { class: "orbit-geometry", viewBox: "0 0 340 200", role: "img" });
  const geoWrap = h("div", { class: "orbit-geometry-wrap", hidden: true }, geometry); // SVG has no .hidden
  const sunLine = h("p", { class: "orbit-sun" });
  const next = h("p", { class: "orbit-next" });
  const facts = h(
    "div",
    { class: "orbit-facts" },
    h("h3", { class: "rd-sub", text: t("orbits.spec_title") }),
    tiles([
      [t("orbits.v_alt"), t("orbits.k_alt")],
      [t("orbits.v_repeat"), t("orbits.k_repeat")],
      [t("orbits.v_swath"), t("orbits.k_swath")],
      [t("orbits.v_wave"), t("orbits.k_wave")],
      [t("orbits.v_antenna"), t("orbits.k_antenna")],
      [t("orbits.v_times"), t("orbits.k_times")],
      [t("orbits.v_orbit"), t("orbits.k_orbit")],
      [t("orbits.v_launch"), t("orbits.k_launch")],
    ]),
    note("limit", t("orbits.geom_note")),
  );
  root.append(
    title,
    lead,
    crossing,
    geoWrap,
    sunLine,
    next,
    facts,
  );
  root.hidden = true;
  // The tracks are drawn on the map: their switches go On top in the map panel (dock.js).
  dock.place("overlays", h("label", { class: "check" }, showNisar, t("orbits.show_nisar")));
  dock.place("overlays", h("label", { class: "field" }, h("span", { text: t("orbits.compare_track") }), other));

  const canvas = h("canvas", { class: "orbit-canvas", "aria-hidden": "true" });
  map.panes.labels.append(canvas);
  const cache = new Map();
  let drawn = []; // [{ colour, width, lines: [[[lon, lat], ...]] }]
  let sun = null; // { ms, world }: the day-night line at the pass's time stamp, or now in World mode
  let nightEl = null; // NASA Black Marble city lights, clipped to the night side (World mode)

  // Under every NASA layer and the world grid, over any basemap; none when the basemap is the
  // Black Marble already or the catalogue lacks it.
  function setNightLights(on) {
    const layer = on && document.body.dataset.basemap !== "night" ? store.get().gibs?.layers.find((l) => l.id === NIGHT_LAYER) : null;
    if (!layer) {
      if (nightEl) map.removeTileLayer("night-lights");
      nightEl = null;
      return;
    }
    if (nightEl) return;
    const time = layer.dates?.length ? layer.dates.at(-1)[1] : ""; // dated 2012 and 2016: the last one
    nightEl = map.setTileLayer("night-lights", layer.template.replace("{time}", time), { maxZoom: layer.max_zoom, opacity: 1, pane: "live" });
    nightEl.className = "map-night-lights";
    map.panes.live.prepend(nightEl);
  }

  function fetchTile(template, date, z, x, y) {
    const key = `${template}|${date}|${z}/${y}/${x}`;
    if (!cache.has(key)) {
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      const url = template.replace("{time}", date).replace("{z}", z).replace("{y}", y).replace("{x}", x);
      cache.set(
        key,
        fetch(url)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((buf) => (buf ? decodeTile(buf) : []))
          .catch(() => []),
      );
    }
    return cache.get(key);
  }

  // Lines and timed points of one leg of one mission over a box, at a level, for some dates.
  async function track(leg, levels, levelIndex, dates, box) {
    const level = levels[levelIndex];
    const lines = [];
    const timed = [];
    for (const date of dates.filter((d) => inRange(leg.dates, d))) {
      const parts = await Promise.all(tilesFor(level, box).map(({ x, y }) => fetchTile(leg.template, date, levelIndex, x, y).then((layers) => ({ x, y, layers }))));
      for (const { x, y, layers } of parts) {
        for (const layer of layers) {
          const geo = { x, y, spanDeg: level.span_deg, extent: layer.extent };
          for (const f of layer.features) {
            if (f.type === "line") for (const path of f.paths) lines.push(path.map((pt) => tileToLonLat(pt, geo)));
            else if (f.type === "point" && f.props.datetime) timed.push({ lonLat: tileToLonLat(f.paths[0][0], geo), ms: Date.parse(f.props.datetime) });
          }
        }
      }
    }
    return { lines, timed };
  }

  function viewBox() {
    const [w, hgt] = map.size();
    const [west, north] = map.unproject(0, 0);
    const [east, south] = map.unproject(w, hgt);
    return [west, south, east, north];
  }

  // The imaging orbit as a line through GIBS's minute points near the granule time.
  function imagingPath(timed, acquiredMs) {
    const pts = [...new Map(timed.filter((p) => p.ms >= acquiredMs - MATCH_BEFORE_MS && p.ms <= acquiredMs + MATCH_AFTER_MS).map((p) => [p.ms, p])).values()];
    return pts.sort((a, b) => a.ms - b.ms).map((p) => p.lonLat);
  }

  let token = 0;
  async function refresh() {
    const st = store.get();
    const orbits = st.gibs?.orbits ?? [];
    root.hidden = !st.online || !orbits.length || !(st.mode === "site" || st.mode === "world");
    if (root.hidden) {
      drawn = [];
      sun = null;
      setNightLights(false);
      draw();
      return;
    }
    if (other.options.length === 1) {
      for (const o of orbits.filter((x) => x.key !== "nisar")) other.append(h("option", { value: o.key, text: `${o.mission}: ${t(`orbits.role_${o.key}`)}` }));
    }
    const site = st.mode === "site" ? st.site : null;
    const pass = site ? site.summary.passes[st.passIndex] : null;
    title.textContent = t(site ? "orbits.title" : "orbits.title_world");
    const nisar = orbits.find((o) => o.key === "nisar");
    const cmp = orbits.find((o) => o.key === other.value);
    const my = ++token;
    const box = viewBox();
    const spanDeg = Math.min(360, box[2] - box[0]);
    const results = [];
    let world = null;
    let imaging = null;
    if (showNisar.checked && nisar) {
      const lvl = levelFor(nisar.levels, spanDeg);
      if (pass) {
        // GIBS files a late-evening pass under the next day too, so read both days.
        const dir = site.summary.track?.direction;
        const leg = nisar[dir] ?? nisar.ascending;
        // Around the site too: the imaging orbit flies ~400-750 km to the side, off a site-scale view.
        const [w, so, e, n] = site.summary.grid.bounds;
        const around = [Math.min(box[0], w - 10), Math.min(box[1], so - 10), Math.max(box[2], e + 10), Math.max(box[3], n + 10)];
        const tr = await track(leg, nisar.levels, levelFor(nisar.levels, Math.min(360, around[2] - around[0])), [pass.date, shiftIso(pass.date, 1)], around);
        results.push({ colour: CONTEXT_COLOUR, width: 1.25, lines: tr.lines });
        imaging = await imagingGeometry(site, pass, nisar, leg);
        if (imaging?.path.length > 1) results.push({ colour: NISAR_COLOUR, width: 2.5, lines: [imaging.path] });
      } else {
        // NISAR's 12-day exact repeat: today it flies the ground path of 12 days ago (GIBS has
        // not published today yet). Only the path is claimed, not the times.
        for (const leg of [nisar.ascending, nisar.descending].filter(Boolean)) {
          const date = pathDate(leg);
          if (!date) continue;
          const tr = await track(leg, nisar.levels, lvl, [date.date], box);
          results.push({ colour: NISAR_COLOUR, width: 1.75, lines: tr.lines });
          world = date;
        }
      }
    }
    if (cmp) {
      const lvl = levelFor(cmp.levels, spanDeg);
      for (const leg of [cmp.ascending, cmp.descending].filter(Boolean)) {
        const date = pass && inRange(leg.dates, pass.date) ? pass.date : leg.dates.at(-1)?.[1];
        if (!date) continue;
        const tr = await track(leg, cmp.levels, lvl, [date], box);
        results.push({ colour: OTHER_COLOUR, width: 1.5, lines: tr.lines });
      }
    }
    if (my !== token) return; // a newer refresh is on its way
    drawn = results;
    // The sun goes with the track: a dawn-dusk orbit is best read against the day-night line.
    sun = !showNisar.checked ? null : site ? (pass?.acquired_utc ? { ms: Date.parse(pass.acquired_utc), world: false } : null) : { ms: Date.now(), world: true };
    setNightLights(Boolean(sun?.world));
    draw();
    describe(site, world, imaging);
  }

  function pathDate(leg) {
    const today = todayIso();
    if (inRange(leg.dates, today)) return { date: today, repeat: false };
    const back = shiftIso(today, -NISAR_REPEAT_DAYS);
    if (inRange(leg.dates, back)) return { date: back, repeat: true };
    const last = leg.dates.at(-1)?.[1];
    return last ? { date: last, repeat: false } : null;
  }

  // Where the radar looked from: closest approach of the imaging orbit to the site (fine tiles).
  async function imagingGeometry(site, pass, nisar, leg) {
    if (!pass.acquired_utc) return null; // contract v11; older builds only draw the tracks
    const [w, so, e, n] = site.summary.grid.bounds;
    const c = [(w + e) / 2, (so + n) / 2];
    const acquiredMs = Date.parse(pass.acquired_utc);
    const day = new Date(acquiredMs).toISOString().slice(0, 10);
    const fine = await track(leg, nisar.levels, nisar.levels.length - 1, [day, shiftIso(day, 1)], [c[0] - 13, c[1] - 13, c[0] + 13, c[1] + 13]);
    const path = imagingPath(fine.timed, acquiredMs);
    if (path.length < 2) return null;
    const hit = closestOnLine(path, c);
    if (!hit) return null;
    return { path, km: hit.km, east: hit.east, angle: incidenceDeg(hit.km), acquired: pass.acquired_utc };
  }

  function describeSun(site) {
    sunLine.textContent = "";
    if (!sun) return;
    if (sun.world) {
      sunLine.textContent = t(nightEl ? "orbits.night_now_lights" : "orbits.night_now", { time: hhmm(((sun.ms / 3600000) % 24 + 24) % 24) });
      return;
    }
    const [w, so, e, n] = site.summary.grid.bounds;
    const c = [(w + e) / 2, (so + n) / 2];
    const el = sunElevationDeg(sun.ms, c);
    sunLine.textContent = t(el < 0 ? "orbits.sun_below" : "orbits.sun_above", {
      time: hhmm(localSolarHours(sun.ms, c[0])),
      deg: fmtNumber(Math.abs(el), 0),
    });
  }

  function describe(site, world, imaging) {
    next.textContent = "";
    crossing.textContent = "";
    describeSun(site);
    if (!site) {
      if (showNisar.checked && world) {
        crossing.textContent = world.repeat
          ? t("orbits.world_repeat", { date: fmtDate(world.date), days: NISAR_REPEAT_DAYS })
          : t("orbits.world_note", { date: fmtDate(world.date) });
      }
      return;
    }
    const s = site.summary;
    next.textContent = t("orbits.next", {
      dates: nextPasses(s.passes.at(-1).date, todayIso()).map((d) => fmtDate(d)).join(", "),
      track: s.track.number,
      dir: t(`orbits.dir_${s.track.direction}`),
    });
    geoWrap.hidden = !(showNisar.checked && imaging);
    if (showNisar.checked && imaging) drawGeometry(imaging);
    if (showNisar.checked && imaging) {
      crossing.textContent = t("orbits.crossing", {
        date: fmtDate(imaging.acquired.slice(0, 10)),
        time: imaging.acquired.slice(11, 19),
        km: fmtNumber(imaging.km, 0),
        side: t(imaging.east ? "orbits.side_west" : "orbits.side_east"),
        angle: fmtNumber(imaging.angle, 0),
      });
    }
  }

  // To scale, one km scale for both axes: the satellite, the Earth's curve and the beam to this
  // place, mirrored so the satellite sits on the side it flew. No swath is drawn: its position
  // would come from the brochure, not this pass (the granule metadata is the authority).
  function drawGeometry(im) {
    const W = 340;
    const H = 200;
    const k = 0.2; // px per km
    const base = 178; // ground level at the nadir
    const flip = im.east ? 1 : -1; // place east of the track: satellite on the left
    const x0 = W / 2 - flip * ((im.km * k) / 2 + 10);
    const gx = (d) => x0 + flip * d * k; // ground distance d from nadir to x
    const gy = (d) => base + ((d * d) / (2 * EARTH_KM)) * k; // the curve drops d²/2R
    const sat = [x0, base - NISAR_ALT_KM * k];
    geometry.replaceChildren();
    let arc = "";
    for (let d = -150; d <= im.km + 120; d += 10) arc += `${arc ? "L" : "M"}${gx(d).toFixed(1)},${gy(d).toFixed(1)}`;
    geometry.append(
      s("path", { d: `${arc}L${gx(im.km + 120)},${H}L${gx(-150)},${H}Z`, class: "geo-earth" }),
      s("line", { x1: sat[0], y1: sat[1], x2: x0, y2: base, class: "geo-nadir" }),
      s("line", { x1: sat[0], y1: sat[1], x2: gx(im.km), y2: gy(im.km), class: "geo-beam" }),
      s("rect", { x: sat[0] - 5, y: sat[1] - 4, width: 10, height: 8, rx: 1.5, class: "geo-sat" }),
      s("line", { x1: sat[0] - 13, y1: sat[1], x2: sat[0] + 13, y2: sat[1], class: "geo-panel" }),
      s("circle", { cx: gx(im.km), cy: gy(im.km), r: 4, class: "geo-site" }),
      // Labels sit clear of their marks: above the satellite, outside the place, under the ground line.
      s("text", { x: sat[0], y: sat[1] - 12, class: "tick", "text-anchor": "middle" }, t("orbits.geo_sat", { km: NISAR_ALT_KM })),
      s("text", { x: gx(im.km) + flip * 9, y: gy(im.km) - 8, class: "tick", "text-anchor": flip > 0 ? "start" : "end" }, t("orbits.geo_here")),
      s("text", { x: (x0 + gx(im.km)) / 2, y: base + 17, class: "tick geo-ground-label", "text-anchor": "middle" }, t("orbits.geo_ground", { km: fmtNumber(im.km, 0) })),
      s("text", { x: (sat[0] + gx(im.km)) / 2 + flip * 8, y: (sat[1] + gy(im.km)) / 2, class: "tick", "text-anchor": flip > 0 ? "start" : "end" }, t("orbits.geo_angle", { angle: fmtNumber(im.angle, 0) })),
    );
    geometry.setAttribute("aria-label", t("orbits.geo_aria", { km: fmtNumber(im.km, 0), angle: fmtNumber(im.angle, 0) }));
  }

  function draw() {
    const [w, hgt] = map.size();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    ctx.lineJoin = ctx.lineCap = "round";
    if (sun) drawSun(ctx);
    for (const tr of drawn) {
      for (const [width, colour] of [
        [tr.width + 3, "rgba(8, 14, 16, 0.7)"], // a dark halo keeps the line legible on any basemap
        [tr.width, tr.colour],
      ]) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = width;
        for (const line of tr.lines) {
          ctx.beginPath();
          line.forEach(([lon, lat], i) => {
            const [x, y] = map.project(lon, lat);
            if (i === 0 || Math.abs(lon - line[i - 1][0]) > 180) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }
      }
    }
  }

  // Night side (World mode only: over a site it would dim the flood map) and the dashed line.
  function drawSun(ctx) {
    const path = (pts) => {
      ctx.beginPath();
      pts.forEach(([lon, lat], i) => {
        const [x, y] = map.project(lon, lat);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    };
    if (sun.world) {
      const ring = nightRing(sun.ms, 2);
      path(ring);
      ctx.fillStyle = nightEl ? NIGHT_FILL_LIGHTS : NIGHT_FILL;
      ctx.fill();
      if (nightEl) {
        const d = ring.map(([lon, lat], i) => `${i ? "L" : "M"}${map.project(lon, lat).map((v) => v.toFixed(1)).join(",")}`).join("");
        nightEl.style.clipPath = `path("${d}Z")`;
      }
    }
    const line = terminator(sun.ms, 1);
    ctx.setLineDash([7, 5]);
    for (const [width, colour] of [[4, "rgba(8, 14, 16, 0.6)"], [1.5, TERMINATOR_COLOUR]]) {
      path(line);
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  // Night moves 15° an hour: World mode redraws it every minute while it is shown.
  setInterval(() => {
    if (!sun?.world || root.hidden) return;
    sun = { ms: Date.now(), world: true };
    draw();
    describeSun(null);
  }, 60000);

  let moveTimer = 0;
  map.onRender(() => {
    draw();
    clearTimeout(moveTimer);
    moveTimer = setTimeout(refresh, 300); // new tiles after the map settles
  });
  // The checkbox mirrors store.showOrbit, so the story can turn the track on (one copy of state).
  showNisar.addEventListener("change", () => store.set({ showOrbit: showNisar.checked }));
  other.addEventListener("change", refresh);
  watch(store, ["gibs", "mode", "site", "passIndex", "online", "showOrbit"], (st) => {
    showNisar.checked = Boolean(st.showOrbit);
    refresh();
  });
}
