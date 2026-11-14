// Detailed belt (F37, docs/03 §4.12): NISAR maps for flooded-forest cells of the global grid,
// built at $0 by `cli.py belt`. Zoomed in, each mapped cell shows its peak-pass classes or
// days flooded; the card reports how much of the belt is mapped and the picked cell's numbers.
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { note, strongNumbers } from "./readable.js";

export const id = "belt";
export const slot = "sidebar";

const MIN_ZOOM = 7; // below this a 28 km cell is a few pixels: the global grid says enough

const intersects = ([w, s, e, n], [w2, s2, e2, n2]) => w < e2 && e > w2 && s < n2 && n > s2;
const inside = ([lon, lat], [w, s, e, n]) => lon >= w && lon <= e && lat >= s && lat <= n;

export function init({ store, map, t, root, dock }) {
  const count = h("p", { class: "belt-count" });
  const show = h(
    "select",
    { id: "belt-show" },
    h("option", { value: "peak", text: t("belt.show_peak") }),
    h("option", { value: "days", text: t("belt.show_days") }),
    h("option", { value: "off", text: t("belt.show_off") }),
  );
  const zoomHint = h("p", { class: "muted small" });
  const picked = h("p", { class: "belt-picked", "aria-live": "polite" });
  root.append(
    h("h2", { text: t("belt.title") }),
    count,
    zoomHint,
    picked,
    // The grey stripe is a picture of what it explains (D-093).
    h("p", { class: "rd-note rd-key" }, h("span", { class: "rd-swatch swatch-nodata", "aria-hidden": "true" }), h("span", { text: t("belt.no_radar") })),
    note("limit", t("belt.caveat")),
  );
  root.hidden = true;
  dock.place("overlays", h("div", { class: "dock-field" }, h("label", { for: "belt-show", class: "field-label", text: t("belt.show_dock") }), show));

  let index = null;
  let base = "";
  const shown = new Set();

  function sync(m) {
    if (!index) return;
    // Only on the World map, where this card and its switch are: drawn around a site, its coarser
    // cells looked like the site's own map spilling past its box, with nothing to explain or hide them.
    const mode = store.get().mode === "world" ? show.value : "off";
    const zoomed = m.getZoom() >= MIN_ZOOM;
    zoomHint.textContent = zoomed ? "" : t("belt.zoom_in");
    const [w, hgt] = m.size();
    const [west, north] = m.unproject(0, 0);
    const [east, south] = m.unproject(w, hgt);
    const view = [west, south, east, north];
    const want = new Set();
    if (mode !== "off" && zoomed) {
      for (const c of index.cells) if (intersects(c.bounds, view)) want.add(c.id);
    }
    for (const id2 of shown) {
      if (!want.has(id2)) {
        m.removeOverlay(`belt-${id2}`);
        shown.delete(id2);
      }
    }
    for (const c of index.cells) {
      if (!want.has(c.id) || shown.has(c.id)) continue;
      const img = h("img", { class: "overlay-belt", alt: "", draggable: "false", decoding: "async" });
      img.src = base + (mode === "days" ? c.days_png : c.peak_png);
      m.addOverlay(`belt-${c.id}`, img, c.bounds);
      m.panes.base.prepend(img); // under any loaded site
      shown.add(c.id);
    }
  }

  show.addEventListener("change", () => {
    for (const id2 of [...shown]) {
      map.removeOverlay(`belt-${id2}`);
      shown.delete(id2);
    }
    sync(map);
  });
  map.on("move", sync);
  watch(store, ["mode"], () => sync(map));

  watch(store, ["manifest"], async ({ manifest, dataBase }) => {
    if (!manifest?.belt || index) return;
    try {
      const res = await fetch(`${dataBase}${manifest.belt}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      index = await res.json();
    } catch (err) {
      console.warn("belt unavailable", err);
      return;
    }
    base = `${dataBase}${manifest.belt.replace(/[^/]*$/, "")}`;
    root.hidden = index.cells.length === 0;
    count.replaceChildren(...strongNumbers(t("belt.count", { n: index.cells.length })));
    sync(map);
  });

  watch(store, ["picked"], ({ picked: p }) => {
    if (!index || !p) return;
    const c = index.cells.find((x) => inside([p.lon, p.lat], x.bounds));
    picked.textContent = c
      ? t("belt.cell", {
          date: fmtDate(c.peak_date),
          flooded: fmtNumber(c.peak_flooded_km2),
          hidden: fmtNumber(c.peak_hidden_km2),
          n: c.passes,
          first: fmtDate(c.first, "short"),
          last: fmtDate(c.last, "short"),
        })
      : t("belt.cell_none");
  });
}
