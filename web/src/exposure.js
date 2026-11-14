// F08 community exposure + place search: who lives next to the hidden flood?
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtApprox, fmtDate, fmtNumber } from "./i18n.js";
import { setFacts } from "./readable.js";

export const id = "exposure";
const MAJOR_ROADS = new Set(["motorway", "trunk", "primary", "secondary", "tertiary"]);

export const slot = "sidebar";

function normalise(text) {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

export function init({ store, map, t, root, dock }) {
  // People, roads and deprivation, one fact per row (readable.js, D-093).
  const people = h("ul", { class: "exposure-people rd-facts" });
  const listId = "place-options";
  const input = h("input", { type: "search", id: "place-search", list: listId, autocomplete: "off", placeholder: t("exposure.search_placeholder") });
  const options = h("datalist", { id: listId });
  const result = h("div", { class: "place-result", "aria-live": "polite" });
  const showLayer = h("input", { type: "checkbox", id: "show-roads", checked: store.get().layers.roads });
  root.append(
    h("h2", { text: t("exposure.title") }),
    people,
    h("label", { for: "place-search", class: "field-label", text: t("exposure.search_label") }),
    h("div", { class: "search-row" }, input, options),
    result,
  );
  dock.place("overlays", h("label", { class: "check" }, showLayer, t("exposure.show_layer")));

  // Roads and places drawn as SVG over the map, re-projected on every move.
  const svg = s("svg", { class: "vector-layer", "aria-hidden": "true" });
  map.panes.base.append(svg);
  let roadsData = null;
  let selectedPlace = null;

  map.onRender((m) => {
    const st = store.get();
    const expo = st.site?.summary.exposure;
    const [w, hgt] = m.size();
    svg.setAttribute("width", w);
    svg.setAttribute("height", hgt);
    svg.replaceChildren();
    if (!expo || !st.layers.roads || st.view !== "flood") return;
    for (const f of roadsData?.features ?? []) {
      const flooded = f.properties.flooded_km > 0;
      // Village lanes and tracks are counted in the numbers but drawn only where flooded,
      // so dense road networks (Sylhet) never hide the flood map.
      if (!flooded && !MAJOR_ROADS.has(f.properties.highway)) continue;
      const d = f.geometry.coordinates.map(([lon, lat], i) => `${i ? "L" : "M"}${m.project(lon, lat).join(",")}`).join("");
      svg.append(s("path", { d, class: flooded ? "road road-flooded" : "road" }));
    }
    for (const p of expo.places) {
      const [x, y] = m.project(p.lon, p.lat);
      const g = s("g", { class: p === selectedPlace ? "place place-selected" : "place" });
      g.append(s("circle", { cx: x, cy: y, r: p === selectedPlace ? 6 : 4 }));
      if (m.getZoom() >= 12) g.append(s("text", { x: x + 8, y: y + 4 }, p.name));
      svg.append(g);
    }
  });

  function describe(place) {
    const s2 = store.get().site.summary;
    const peak = s2.passes.find((p) => p.id === s2.peak_pass);
    if (place.nearest_flood_m === null) return t("exposure.place_dry", { name: place.name });
    const near = place.nearest_flood_m <= s2.exposure.buffer_m;
    return t(near ? "exposure.place_near" : "exposure.place_far", {
      name: place.name,
      m: fmtNumber(place.nearest_flood_m, 0),
      days: place.days_flooded,
      date: fmtDate(peak.date),
    });
  }

  function choose(place) {
    selectedPlace = place;
    if (!place) {
      result.replaceChildren();
      map.refresh();
      return;
    }
    result.replaceChildren(h("p", { text: describe(place) }));
    map.setView([place.lon, place.lat], Math.max(map.getZoom(), 13));
    const site = store.get().site;
    const cell = site.lonLatToGrid(place.lon, place.lat);
    if (cell) store.set({ selected: cell });
  }

  input.addEventListener("change", () => {
    const places = store.get().site?.summary.exposure?.places ?? [];
    const q = normalise(input.value);
    if (!q) return choose(null);
    const hit = places.find((p) => normalise(p.name) === q) ?? places.find((p) => normalise(p.name).includes(q));
    if (hit) {
      input.value = hit.name;
      choose(hit);
    } else {
      selectedPlace = null;
      result.replaceChildren(h("p", { class: "muted", text: t("exposure.no_match", { q: input.value }) }));
    }
  });
  showLayer.addEventListener("change", () => store.set({ layers: { ...store.get().layers, roads: showLayer.checked } }));

  watch(store, ["site"], async ({ site }) => {
    const expo = site?.summary.exposure;
    root.hidden = !expo;
    roadsData = null;
    selectedPlace = null;
    input.value = "";
    result.replaceChildren();
    if (!expo) return map.refresh();
    const peak = site.summary.passes.find((p) => p.id === site.summary.peak_pass);
    const rows = [
      ["people", t("exposure.people", { n: fmtApprox(expo.population_near_hidden_flood), km: fmtNumber(expo.buffer_m / 1000, 0), date: fmtDate(peak.date) })],
      ["road", t("exposure.roads", { km: fmtNumber(expo.roads_flooded_km) })],
    ];
    if (expo.grdi_near_flood !== null && expo.grdi_near_flood !== undefined && expo.grdi_site !== null) {
      const diff = expo.grdi_near_flood - expo.grdi_site;
      rows.push([
        "chart",
        t(Math.abs(diff) < 2 ? "exposure.grdi_same" : diff > 0 ? "exposure.grdi_more" : "exposure.grdi_less", {
          near: fmtNumber(expo.grdi_near_flood, 0),
          site: fmtNumber(expo.grdi_site, 0),
        }),
      ]);
    }
    setFacts(people, rows);
    options.replaceChildren(...expo.places.map((p) => h("option", { value: p.name })));
    if (expo.roads_geojson) {
      try {
        const res = await fetch(site.url(expo.roads_geojson));
        if (res.ok && store.get().site === site) roadsData = await res.json();
      } catch {
        roadsData = null; // roads are optional; the numbers above still stand
      }
    }
    map.refresh();
  });
  watch(store, ["layers", "view"], () => map.refresh());
}
