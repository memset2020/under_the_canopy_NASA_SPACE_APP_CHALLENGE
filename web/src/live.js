// NASA live layers (F35, docs/03 §4.11): daily global imagery from NASA GIBS for any place
// and date, drawn as map tiles. The layer catalogue is a static file (gibs.json); the only
// network use is the tiles and legend images themselves (docs/10 D-054).
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate } from "./i18n.js";

export const id = "live";
export const slot = "sidebar";

const GROUPS = ["radar", "water", "fire", "weather", "imagery", "context"];
const toDay = (iso) => Date.parse(`${iso}T00:00:00Z`);
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);

// The available date nearest to `iso` (ranges are [start, end, period]; daily only).
export function snapDate(layer, iso) {
  if (!layer.dates.length) return null;
  const want = toDay(iso);
  let best = null;
  for (const [a, b] of layer.dates) {
    const lo = toDay(a);
    const hi = toDay(b);
    const d = want < lo ? lo : want > hi ? hi : want;
    if (best === null || Math.abs(d - want) < Math.abs(best - want)) best = d;
  }
  return toIso(best);
}

// The n available days nearest `iso`, furthest first so the nearest is drawn on top. Looking both
// ways matters: a July radar pass on a layer that starts on 10 Aug snaps to 10 Aug, and counting
// back from there found one day of swaths (a third of the coverage) instead of a full cycle.
export function compositeDays(layer, iso, n) {
  if (!layer.dates.length || !iso) return [iso];
  const want = toDay(iso);
  const days = [];
  const DAY = 86400000;
  for (let k = 0; days.length < n && k <= 4 * n; k += 1) {
    for (const d of k === 0 ? [want] : [want - k * DAY, want + k * DAY]) {
      if (days.length < n && snapDate(layer, toIso(d)) === toIso(d)) days.push(toIso(d));
    }
  }
  return days.length ? days.reverse() : [iso];
}

export function tileUrl(layer, iso) {
  return layer.template.replace("{time}", iso ?? "");
}

export function init({ store, map, t, root, dock }) {
  const select = h("select", { id: "live-layer" });
  const date = h("input", { type: "date", id: "live-date" });
  const follow = h("input", { type: "checkbox", id: "live-follow", checked: true });
  const opacity = h("input", { type: "range", id: "live-opacity", min: "0.2", max: "1", step: "0.05", value: "0.85" });
  const fill = h("input", { type: "checkbox", id: "live-fill", checked: true });
  const fillRow = h("label", { class: "check", hidden: true }, fill, h("span", { class: "live-fill-text" }));
  const note = h("p", { class: "live-note", "aria-live": "polite" });
  const labelsOn = h("input", { type: "checkbox", id: "live-labels", checked: true });
  const labelsRow = h("label", { class: "check" }, labelsOn, t("live.labels"));
  const legend = h("img", { class: "live-legend", alt: "", hidden: true, loading: "lazy" });
  const controls = h(
    "div",
    { class: "live-controls", hidden: true },
    h("div", { class: "live-row" }, h("label", { for: "live-date", class: "field-label", text: t("live.date") }), date),
    h("label", { class: "check" }, follow, t("live.follow")),
    fillRow,
    h("div", { class: "live-row" }, h("label", { for: "live-opacity", class: "field-label", text: t("live.opacity") }), opacity),
    note,
    h("p", { class: "muted small", text: t("live.patchy") }),
    legend,
  );
  // NASA's own layers draw on the map: the whole control goes On top in the map panel (dock.js).
  dock.place(
    "overlays",
    h(
      "div",
      { class: "dock-group live-group" },
      h("h4", { class: "dock-group-title", text: t("live.title") }),
      h("p", { class: "muted small", text: t("live.help") }),
      h("label", { for: "live-layer", class: "field-label", text: t("live.layer") }),
      select,
      labelsRow,
      controls,
      h("p", { class: "muted small", text: t("live.attribution") }),
    ),
    { only: true },
  );
  root.hidden = true;

  let catalogue = null;
  let shownIds = [];

  function clearTiles() {
    for (const id2 of shownIds) map.removeTileLayer(id2);
    shownIds = [];
    document.body.classList.remove("has-live"); // CSS fades the world grid while a NASA layer shows
  }

  const daysFor = (layer, iso) => compositeDays(layer, iso, fill.checked ? (layer.composite_days ?? 1) : 1);
  const current = () => catalogue?.layers.find((l) => l.id === select.value) ?? null;

  function wantedDate(layer) {
    const st = store.get();
    if (follow.checked && st.mode !== "world" && st.site) {
      return st.site.summary.passes[st.passIndex].date;
    }
    return date.value || layer.default_date;
  }

  function apply() {
    const layer = current();
    controls.hidden = !layer;
    clearTiles();
    if (!layer) {
      note.textContent = "";
      return;
    }
    const timed = layer.dates.length > 0 && layer.default_date !== null;
    date.disabled = !timed;
    let iso = null;
    if (timed) {
      const want = wantedDate(layer);
      iso = snapDate(layer, want);
      date.min = layer.dates[0][0];
      date.max = layer.dates.at(-1)[1];
      date.value = iso;
      note.textContent =
        iso === want
          ? t("live.showing", { title: layer.title, date: fmtDate(iso) })
          : t("live.nearest", { title: layer.title, want: fmtDate(want), date: fmtDate(iso) });
    } else {
      note.textContent = t("live.static", { title: layer.title });
    }
    const composite = (layer.composite_days ?? 1) > 1;
    fillRow.hidden = !composite;
    fillRow.querySelector(".live-fill-text").textContent = t("live.fill", { n: layer.composite_days ?? 1 });
    const days = timed ? daysFor(layer, iso) : [null];
    document.body.classList.add("has-live");
    days.forEach((d, k) => {
      const id2 = `live-${k}`;
      map.setTileLayer(id2, tileUrl(layer, d), { maxZoom: layer.max_zoom, opacity: Number(opacity.value) });
      shownIds.push(id2);
    });
    if (composite && fill.checked && days.length > 1) {
      const span = [...days].sort();
      note.textContent += ` ${t("live.composite", { from: fmtDate(span[0], "short"), to: fmtDate(span.at(-1), "short"), n: days.length })}`;
    }
    legend.hidden = !layer.legend;
    if (layer.legend) {
      legend.src = layer.legend;
      legend.alt = t("live.legend_alt", { title: layer.title });
    }
  }

  select.addEventListener("change", apply);

  // Place names, roads and borders from GIBS, above every layer: readable on the dark basemap
  // and in Latin script everywhere (the OSM basemap labels each place in its own script).
  function applyLabels() {
    for (const l of catalogue?.layers ?? []) map.removeTileLayer(`ref-${l.id}`);
    if (!labelsOn.checked || !catalogue) return;
    for (const l of catalogue.layers.filter((x) => x.group === "reference")) {
      map.setTileLayer(`ref-${l.id}`, tileUrl(l, null), { maxZoom: l.max_zoom, opacity: 0.95, pane: "labels" });
    }
  }
  labelsOn.addEventListener("change", applyLabels);
  date.addEventListener("change", () => {
    follow.checked = false;
    apply();
  });
  follow.addEventListener("change", apply);
  opacity.addEventListener("input", () => {
    for (const id2 of shownIds) map.setTileOpacity(id2, Number(opacity.value));
  });
  fill.addEventListener("change", apply);

  watch(store, ["manifest"], async ({ manifest, dataBase, online }) => {
    if (!manifest?.gibs || catalogue || !online) return;
    try {
      const res = await fetch(`${dataBase}${manifest.gibs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      catalogue = await res.json();
      store.set({ gibs: catalogue }); // basemaps, orbit tracks and the graticule read it too
    } catch (err) {
      console.warn("NASA live layers unavailable", err);
      return;
    }
    select.replaceChildren(
      h("option", { value: "", text: t("live.none") }),
      ...GROUPS.map((g) =>
        h(
          "optgroup",
          { label: t(`live.group_${g}`) },
          catalogue.layers.filter((l) => l.group === g).map((l) => h("option", { value: l.id, text: l.role })),
        ),
      ),
    );
    root.hidden = false;
    applyLabels();
  });

  watch(store, ["passIndex", "site", "mode"], () => {
    if (catalogue && current() && follow.checked) apply();
  });
}

