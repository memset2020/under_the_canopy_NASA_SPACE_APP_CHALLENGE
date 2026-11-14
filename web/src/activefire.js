// Active fires anywhere on Earth (docs/10 D-138): NASA's near-real-time fire detections from VIIRS
// (375 m; Suomi NPP, NOAA-20, NOAA-21) and MODIS (1 km; Terra and Aqua), as NASA LANCE FIRMS
// publishes them. GIBS serves them as vector tiles, so the browser asks for tiles only (no API, no
// key, CLAUDE.md rule 5) and only for the days and the part of the world on screen. A coarse tile
// holds every point a fine one does (checked over Thunder Bay 36, 15 Jul 2026: 10,785 in the box
// at three levels), so the count in view is exact at any zoom.
// Colour and size both carry fire radiative power (FRP), in four classes: one orange hue, dark to
// bright on the dark map, validated as an ordinal ramp (dataviz checks; dim end 3.8:1 on the map).
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { decodeTile, tileToLonLat, tilesFor } from "./mvt.js";

export const id = "activefire";
export const slot = "sidebar";

// FRP class edges in MW. Most detections are small (< 5 MW); a crown fire front reaches hundreds.
export const FRP_EDGES = [5, 25, 100];
const COLOURS = ["#c4501f", "#e8732e", "#f7a24a", "#ffd38a"];
const RADII = [1.6, 2.3, 3.2, 4.4];
export const WINDOWS = [1, 3, 7];
// Tiles × days asked for at once. Peak-season tiles are 0.6-2.5 MB compressed. Over a site the
// budget fits a whole radar-pass window (12 days, 24 across a skipped pass) in one or two tiles.
export const TILE_BUDGET = 24;
// A view wider than this many degrees covers so much of the planet that each day costs megabytes
// whatever the tile level, so it draws at most WIDE_MAX_DAYS days (the note says so).
export const WIDE_DEG = 90;
export const WIDE_MAX_DAYS = 3;
const MAX_PASS_DAYS = 31;
const NISAR_REPEAT_DAYS = 12;
const MAX_CACHE = 48;
const DAY_MS = 86400000;
const HIT_PX = 8;

const SATELLITES = { N: "Suomi NPP", N20: "NOAA-20", N21: "NOAA-21", T: "Terra", A: "Aqua", Terra: "Terra", Aqua: "Aqua" };

export function frpClass(frp) {
  const v = Number(frp);
  if (!Number.isFinite(v)) return 0;
  let k = 0;
  while (k < FRP_EDGES.length && v >= FRP_EDGES[k]) k += 1;
  return k;
}

export const satelliteName = (code) => SATELLITES[code] ?? String(code ?? "");

const toDay = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
export const inRange = (dates, iso) => dates.some(([a, b]) => iso >= a && iso <= b);

// The days of a window ending on `endIso`, oldest first, keeping only days the layer has.
export function windowDates(layer, endIso, n) {
  const out = [];
  for (let k = n - 1; k >= 0; k -= 1) {
    const iso = toIso(toDay(endIso) - k * DAY_MS);
    if (inRange(layer.dates, iso)) out.push(iso);
  }
  return out;
}

// The date the layer has nearest to `iso` (its ranges are daily).
export function snapDay(layer, iso) {
  if (!layer.dates.length) return null;
  const want = toDay(iso);
  let best = null;
  for (const [a, b] of layer.dates) {
    const d = Math.min(Math.max(want, toDay(a)), toDay(b));
    if (best === null || Math.abs(d - want) < Math.abs(best - want)) best = d;
  }
  return toIso(best);
}

// The last full day: GIBS lists today while today's later passes are still to come.
export function lastFullDay(layer, todayIso) {
  const last = layer.dates.at(-1)[1];
  return last >= todayIso ? toIso(toDay(todayIso) - DAY_MS) : last;
}

// The days since the previous radar pass, ending on this one: what burned between two NISAR looks
// (the burn card's window, D-088). Before the first pass, one repeat cycle.
export function passWindow(passes, i) {
  const end = passes[i].date;
  const start = i > 0 ? toDay(passes[i - 1].date) + DAY_MS : toDay(end) - (NISAR_REPEAT_DAYS - 1) * DAY_MS;
  return { end, days: Math.min(MAX_PASS_DAYS, Math.round((toDay(end) - start) / DAY_MS) + 1) };
}

// Which level and how many days to draw: the deepest level whose tiles over the view, times the
// days, fit the budget; when even the coarsest does not, the newest days that fit. A wide view
// draws at most WIDE_MAX_DAYS.
export function plan(levels, box, nDays, budget = TILE_BUDGET) {
  const days = box[2] - box[0] > WIDE_DEG ? Math.min(nDays, WIDE_MAX_DAYS) : nDays;
  for (let i = levels.length - 1; i >= 0; i -= 1) {
    const n = tilesFor(levels[i], box).length;
    if (n * days <= budget) return { level: i, days, trimmed: days < nDays };
  }
  const n = Math.max(1, tilesFor(levels[0], box).length);
  const fit = Math.min(days, Math.max(1, Math.floor(budget / n)));
  return { level: 0, days: fit, trimmed: fit < nDays };
}

// Fire points of one decoded tile, as plain records. FIRMS columns travel as properties; the
// geometry is the fallback for a layer without them.
export function pointsOf(layers, geo) {
  const out = [];
  for (const layer of layers) {
    for (const f of layer.features) {
      if (f.type !== "point" || !f.paths[0]?.[0]) continue;
      const p = f.props;
      const [lon, lat] = Number.isFinite(p.LONGITUDE) && Number.isFinite(p.LATITUDE) ? [p.LONGITUDE, p.LATITUDE] : tileToLonLat(f.paths[0][0], { ...geo, extent: layer.extent });
      const frp = Number(p.FRP);
      out.push({
        lon,
        lat,
        frp: Number.isFinite(frp) ? frp : null,
        cls: frpClass(frp),
        date: p.ACQ_DATE ?? null,
        time: p.ACQ_TIME ?? null,
        sat: p.SATELLITE ?? null,
        conf: p.CONFIDENCE ?? null,
        night: p.DAYNIGHT === "N",
      });
    }
  }
  return out;
}

// One record per detection: a point near a tile edge can come in two tiles.
export function dedupe(points) {
  const seen = new Set();
  return points.filter((p) => {
    const k = `${p.lon.toFixed(5)},${p.lat.toFixed(5)},${p.date},${p.time},${p.sat}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function summarise(points) {
  const s = { n: points.length, night: 0, maxFrp: null, byClass: [0, 0, 0, 0] };
  for (const p of points) {
    if (p.night) s.night += 1;
    s.byClass[p.cls] += 1;
    if (p.frp !== null && (s.maxFrp === null || p.frp > s.maxFrp)) s.maxFrp = p.frp;
  }
  return s;
}

const inBox = (p, [w, s, e, n]) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;

export function init({ store, map, t, root, dock }) {
  const show = h("input", { type: "checkbox", id: "fires-show" });
  const sensor = h("select", { id: "fires-sensor" });
  // "pass": since the previous radar pass, offered (and chosen) while the date follows a site's pass.
  const passOption = h("option", { value: "pass", text: t("fires.window_pass") });
  const windowSel = h(
    "select",
    { id: "fires-window" },
    passOption,
    ...WINDOWS.map((n) => h("option", { value: String(n), text: t(n === 1 ? "fires.window_1" : "fires.window_n", { n }) })),
  );
  const date = h("input", { type: "date", id: "fires-date" });
  const follow = h("input", { type: "checkbox", id: "fires-follow", checked: true });
  const status = h("p", { class: "fires-status", "aria-live": "polite" });
  const legend = h(
    "ul",
    { class: "fires-legend", "aria-label": t("fires.legend") },
    ...COLOURS.map((c, k) =>
      h(
        "li",
        {},
        h("span", { class: "fires-swatch", style: `--sw:${c}; --r:${RADII[k] * 2}px`, "aria-hidden": "true" }),
        h("span", { text: t(`fires.class_${k}`) }),
      ),
    ),
  );
  const controls = h(
    "div",
    { class: "fires-controls", hidden: true },
    h("div", { class: "live-row" }, h("label", { for: "fires-sensor", class: "field-label", text: t("fires.sensor") }), sensor),
    h("div", { class: "live-row" }, h("label", { for: "fires-date", class: "field-label", text: t("fires.date") }), date),
    h("label", { class: "check" }, follow, t("fires.follow")),
    h("div", { class: "live-row" }, h("label", { for: "fires-window", class: "field-label", text: t("fires.window") }), windowSel),
    status,
    h("p", { class: "field-label", text: t("fires.legend") }),
    legend,
    h("p", { class: "muted small", text: t("fires.note") }),
  );
  const group = h(
    "div",
    { class: "dock-group fires-group" },
    h("h4", { class: "dock-group-title", text: t("fires.title") }),
    h("p", { class: "muted small", text: t("fires.help") }),
    h("label", { class: "check" }, show, t("fires.show")),
    controls,
    h("p", { class: "muted small", text: t("fires.attribution") }),
  );
  // The dock shows the control while this card's root is visible (dock.js `follow`); with
  // `only`, the root itself never shows in the sidebar.
  dock.place("overlays", group, { only: true });
  root.hidden = true;

  const canvas = h("canvas", { class: "fires-canvas", "aria-hidden": "true" });
  map.panes.labels.append(canvas);
  const tip = h("div", { class: "fires-tip", role: "tooltip", hidden: true });
  map.container.append(tip);

  const cache = new Map();
  let points = []; // the detections drawn, deduplicated, for every tile asked for
  let token = 0;

  const layers = () => store.get().gibs?.fires ?? [];
  const current = () => layers().find((l) => l.key === sensor.value) ?? layers()[0] ?? null;

  function viewBox() {
    const [w, hgt] = map.size();
    const [west, north] = map.unproject(0, 0);
    const [east, south] = map.unproject(w, hgt);
    return [west, Math.max(-90, south), east, Math.min(90, north)];
  }

  function fetchTile(layer, day, z, x, y) {
    const key = `${layer.key}|${day}|${z}/${y}/${x}`;
    if (!cache.has(key)) {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      const url = layer.template.replace("{time}", day).replace("{z}", z).replace("{y}", y).replace("{x}", x);
      const geo = { x, y, spanDeg: layer.levels[z].span_deg };
      cache.set(
        key,
        fetch(url)
          .then((r) => {
            if (r.status === 404) return []; // GIBS answers 404 for a tile with no fire
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer().then((buf) => pointsOf(decodeTile(buf), geo));
          })
          .catch((err) => {
            cache.delete(key); // a failed tile is asked for again next time
            throw err;
          }),
      );
    }
    return cache.get(key);
  }

  const followsPass = () => {
    const st = store.get();
    return follow.checked && st.mode !== "world" && Boolean(st.site);
  };

  // The window's end date and length: the radar pass and the days since the previous one, or the
  // chosen date (by default the last full day) and the chosen number of days.
  function wanted(layer) {
    const st = store.get();
    passOption.disabled = !followsPass();
    if (windowSel.value === "pass" && !followsPass()) windowSel.value = "1";
    if (followsPass()) {
      const passes = st.site.summary.passes;
      if (windowSel.value === "pass") return passWindow(passes, st.passIndex);
      return { end: passes[st.passIndex].date, days: Number(windowSel.value) };
    }
    return { end: date.value || lastFullDay(layer, new Date().toISOString().slice(0, 10)), days: Number(windowSel.value) };
  }

  async function refresh() {
    const layer = current();
    const on = show.checked && layer && store.get().online;
    controls.hidden = !show.checked;
    const mine = ++token;
    if (!on) {
      points = [];
      draw();
      return;
    }
    const w = wanted(layer);
    const end = snapDay(layer, w.end);
    date.min = layer.dates[0][0];
    date.max = layer.dates.at(-1)[1];
    date.value = end;
    const box = viewBox();
    const p = plan(layer.levels, box, w.days);
    const days = windowDates(layer, end, p.days);
    status.textContent = t("fires.loading");
    const tiles = tilesFor(layer.levels[p.level], box);
    let failed = 0;
    const parts = await Promise.all(days.flatMap((d) => tiles.map(({ x, y }) => fetchTile(layer, d, p.level, x, y).catch(() => ((failed += 1), [])))));
    if (mine !== token) return; // a newer request has started
    points = dedupe(parts.flat()).sort((a, b) => a.cls - b.cls); // strongest drawn last, on top
    draw();
    describe(layer, days, p, failed);
  }

  function describe(layer, days, p, failed) {
    const box = viewBox();
    const s = summarise(points.filter((pt) => inBox(pt, box)));
    const parts = [];
    if (failed) parts.push(t("fires.failed"));
    parts.push(
      s.n
        ? t("fires.count", {
            n: fmtNumber(s.n, 0),
            sensor: layer.sensor,
            from: fmtDate(days[0]),
            to: fmtDate(days.at(-1)),
            day: fmtNumber(s.n - s.night, 0),
            night: fmtNumber(s.night, 0),
            frp: fmtNumber(s.maxFrp ?? 0, 0),
          })
        : t("fires.none", { sensor: layer.sensor, from: fmtDate(days[0] ?? date.value), to: fmtDate(days.at(-1) ?? date.value) }),
    );
    if (p.trimmed) parts.push(t("fires.trimmed", { n: p.days }));
    status.textContent = parts.join(" ");
  }

  function draw() {
    const [w, hgt] = map.size();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    if (!points.length) return;
    // One path per class: thousands of points in four fills, smallest class first.
    for (let k = 0; k < COLOURS.length; k += 1) {
      const r = RADII[k];
      g.fillStyle = COLOURS[k];
      g.beginPath();
      for (const p of points) {
        if (p.cls !== k) continue;
        const [x, y] = map.project(p.lon, p.lat);
        if (x < -r || y < -r || x > w + r || y > hgt + r) continue;
        g.moveTo(x + r, y);
        g.arc(x, y, r, 0, 2 * Math.PI);
      }
      g.fill();
    }
  }

  // Hover: the nearest detection under the pointer, with what FIRMS says about it.
  let hoverFrame = 0;
  map.container.addEventListener("pointermove", (ev) => {
    if (!points.length) return;
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      const r = map.container.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      let best = null;
      let bestD = HIT_PX * HIT_PX;
      for (const p of points) {
        const [x, y] = map.project(p.lon, p.lat);
        const d = (x - mx) ** 2 + (y - my) ** 2;
        if (d <= bestD) {
          bestD = d;
          best = p;
        }
      }
      if (!best) {
        tip.hidden = true;
        return;
      }
      const time = best.time ? `${String(best.time).padStart(4, "0").replace(/^(\d\d):?(\d\d)$/, "$1:$2")}` : "";
      tip.textContent = t("fires.tip", {
        date: best.date ? fmtDate(best.date) : "",
        time,
        sat: satelliteName(best.sat),
        frp: best.frp === null ? "?" : fmtNumber(best.frp, 1),
        conf: String(best.conf ?? "?"),
        dn: t(best.night ? "fires.night" : "fires.day"),
      });
      tip.hidden = false;
      tip.style.left = `${Math.min(mx + 12, r.width - tip.offsetWidth - 4)}px`;
      tip.style.top = `${Math.max(4, my - tip.offsetHeight - 10)}px`;
    });
  });
  map.container.addEventListener("pointerleave", () => {
    tip.hidden = true;
  });

  let moveTimer = 0;
  map.onRender(() => {
    draw();
    if (!show.checked) return;
    tip.hidden = true;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(refresh, 350); // new tiles once the map settles
  });

  show.addEventListener("change", refresh);
  sensor.addEventListener("change", refresh);
  windowSel.addEventListener("change", refresh);
  follow.addEventListener("change", () => {
    if (follow.checked && store.get().site && store.get().mode !== "world") windowSel.value = "pass";
    refresh();
  });
  date.addEventListener("change", () => {
    follow.checked = false;
    refresh();
  });

  watch(store, ["gibs", "online"], ({ gibs, online }) => {
    const list = gibs?.fires ?? [];
    root.hidden = !list.length || !online; // no catalogue, or offline (?basemap=off): no control
    if (list.length && !sensor.options.length) sensor.replaceChildren(...list.map((l) => h("option", { value: l.key, text: l.sensor })));
    refresh();
  });
  watch(store, ["site", "passIndex", "mode"], () => {
    if (show.checked && follow.checked) refresh();
  });
}
