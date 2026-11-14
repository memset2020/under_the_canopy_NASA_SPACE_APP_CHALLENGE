// Basemap choice: dark streets (OpenStreetMap) or a NASA basemap from GIBS (Blue Marble relief,
// Blue Marble true colour, Black Marble night lights). "Automatic" shows streets on a site map
// and the Blue Marble when looking at the whole planet. Tiles only; nothing loads offline.
import { h } from "./svg.js";
import { watch } from "./state.js";

export const id = "basemap";
export const slot = "map";

const CHOICES = ["auto", "streets", "relief", "truecolour", "night", "none"];
const GIBS_ID = {
  relief: "BlueMarble_ShadedRelief_Bathymetry",
  truecolour: "BlueMarble_NextGeneration",
  night: "VIIRS_Black_Marble",
};
const KEY = "utc.basemap";

function remembered() {
  try {
    const v = localStorage.getItem(KEY);
    return CHOICES.includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

function remember(v) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // private window or blocked storage: the choice simply isn't kept
  }
}

// What a choice means in a mode: "streets", "none" or a GIBS layer key.
export function resolveBasemap(choice, mode) {
  if (choice === "auto") return mode === "world" ? "relief" : "streets";
  return choice;
}

export function init({ store, map, t, root, dock }) {
  root.hidden = true; // the control lives in the map panel, not in a card
  const select = h(
    "select",
    { id: "basemap-select", "aria-label": t("basemap.label") },
    CHOICES.map((c) => h("option", { value: c, text: t(`basemap.${c}`) })),
  );
  const ctl = h("label", { class: "basemap-ctl" }, h("span", { class: "visually-hidden", text: t("basemap.label") }), select);
  dock.place("basemap", ctl, { maps: "site world motion ice", follow: false });
  select.value = remembered();

  let shown = null;
  function apply() {
    const { gibs, mode, online } = store.get();
    ctl.hidden = !online || !map.hasStreets();
    if (ctl.hidden) return;
    const want = resolveBasemap(select.value, mode);
    const layer = GIBS_ID[want] ? gibs?.layers.find((l) => l.id === GIBS_ID[want]) : null;
    const key = layer ? layer.id : want;
    if (key === shown) return;
    shown = key;
    map.removeTileLayer("basemap");
    if (layer) {
      // Black Marble is dated (2012, 2016): use its last year; the Blue Marbles are static.
      const time = layer.dates?.length ? layer.dates.at(-1)[1] : "";
      map.setTileLayer("basemap", layer.template.replace("{time}", time), { maxZoom: layer.max_zoom, opacity: 1, pane: "tiles" });
      map.setStreets(false);
      map.setAttribution(t("basemap.attribution_nasa", { name: t(`basemap.${want}`) }));
    } else {
      // Streets, none, or a NASA choice before the catalogue has loaded (fall back to streets).
      map.setStreets(want !== "none");
      map.setAttribution(want === "none" ? "" : t("map.attribution"));
      if (GIBS_ID[want]) shown = null; // try again once the catalogue arrives
    }
    document.body.dataset.basemap = layer ? want : want === "none" ? "none" : "streets";
  }

  select.addEventListener("change", () => {
    remember(select.value);
    shown = null;
    apply();
  });
  watch(store, ["gibs", "mode", "online"], apply);
}
