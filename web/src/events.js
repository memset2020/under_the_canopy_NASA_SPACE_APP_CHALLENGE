// Floods reported now (F48): a dated snapshot of GDACS flood events (UN / EC JRC, mostly GloFAS),
// written at build time (pipeline/canopy/events.py), shown in World mode. Rings are neutral and
// sized by alert level; red alerts are filled. Amber stays reserved for water under the trees.
import { h, s } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate } from "./i18n.js";
import { chips, note as noteRow } from "./readable.js";

export const id = "events";
export const slot = "sidebar";

const RADIUS = { Green: 4, Orange: 7, Red: 10 };
const LIST_MAX = 8;

export function init({ store, map, t, root, dock }) {
  const heading = h("h2", { text: t("events.title") });
  const lead = h("div", { class: "events-lead" });
  const show = h("input", { type: "checkbox", id: "events-show", checked: true });
  const list = h("ol", { class: "events-list" });
  const note = h("div");
  root.append(heading, lead, list, note);
  dock.place("overlays", h("label", { class: "check" }, show, t("events.show_map")));
  root.hidden = true;

  const layer = s("svg", { class: "vector-layer events-layer", "aria-hidden": "true" });
  map.panes.top.append(layer);
  let doc = null;

  function draw() {
    const [w, hgt] = map.size();
    layer.setAttribute("width", w);
    layer.setAttribute("height", hgt);
    layer.replaceChildren();
    if (!doc || !show.checked || store.get().mode !== "world") return;
    // Least severe first so the red ones are drawn on top.
    for (const e of [...doc.events].reverse()) {
      const [x, y] = map.project(e.lon, e.lat);
      if (x < -20 || y < -20 || x > w + 20 || y > hgt + 20) continue;
      layer.append(
        s(
          "circle",
          { cx: x, cy: y, r: RADIUS[e.alert] ?? 4, class: `event-ring event-${e.alert.toLowerCase()}` },
          s("title", {}, `${e.name}: ${t(`events.alert_${e.alert.toLowerCase()}`)}, ${fmtDate(e.from)} – ${fmtDate(e.to)}`),
        ),
      );
    }
  }
  map.onRender(draw);
  show.addEventListener("change", draw);

  function render() {
    const counts = { Red: 0, Orange: 0, Green: 0 };
    for (const e of doc.events) counts[e.alert] = (counts[e.alert] ?? 0) + 1;
    // The counts as the rings' own colours, then what the rings mean (D-093).
    lead.replaceChildren(
      chips([
        [`${counts.Red} ${t("events.alert_red")}`, "rd-chip-red"],
        [`${counts.Orange} ${t("events.alert_orange")}`, "rd-chip-orange"],
        [`${counts.Green} ${t("events.alert_green")}`, "rd-chip-green"],
      ]),
      h("p", { class: "rd-lead", text: t("events.lead_count", { n: doc.events.length, days: doc.window_days }) }),
    );
    list.replaceChildren(
      ...doc.events.slice(0, LIST_MAX).map((e) => {
        const btn = h("button", { type: "button", class: "event-item" },
          h("span", { class: `event-dot event-${e.alert.toLowerCase()}`, "aria-hidden": "true" }),
          h("span", { class: "event-name", text: e.name }),
          h("span", { class: "event-meta", text: `${t(`events.alert_${e.alert.toLowerCase()}`)} · ${fmtDate(e.to, "short")}` }),
        );
        btn.addEventListener("click", () => map.setView([e.lon, e.lat], 6));
        return h("li", {}, btn);
      }),
    );
    // The list is dated by its own latest event, so the file carries no build time.
    const latest = doc.events.reduce((d, e) => (e.to > d ? e.to : d), "");
    note.replaceChildren(...(latest ? [noteRow("source", t("events.note", { date: fmtDate(latest) }))] : []));
  }

  watch(store, ["manifest", "mode"], async ({ manifest, dataBase, mode }) => {
    if (manifest?.events && !doc) {
      try {
        const res = await fetch(`${dataBase}${manifest.events}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        doc = await res.json();
        render();
      } catch (err) {
        console.error("events.json did not load", err);
      }
    }
    root.hidden = !doc || mode !== "world";
    draw();
  });
}
