// Season at a glance: every pass's flood map as small multiples, one click to open a pass.
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { note } from "./readable.js";

export const id = "season";
export const slot = "sidebar";

export function init({ store, t, root }) {
  const grid = h("div", { class: "season-grid" });
  root.append(
    h("h2", { text: t("season.title") }),
    note("info", t("season.help")),
    grid,
  );

  watch(store, ["site"], ({ site }) => {
    root.hidden = !site || site.passCount < 2;
    if (!site) return;
    const passes = site.summary.passes;
    const top = Math.max(...passes.map((p) => p.flooded_km2), 1e-9);
    grid.replaceChildren(
      ...passes.map((p, i) =>
        h(
          "button",
          {
            type: "button",
            class: "season-cell",
            dataset: { index: String(i) },
            "aria-label": t("season.cell", {
              date: fmtDate(p.date),
              km2: fmtNumber(p.flooded_km2),
              hidden: fmtNumber(p.flooded_veg_km2),
            }),
            onclick: () => store.set({ passIndex: i, playing: false }),
          },
          h("img", { src: site.url(p.class_png), alt: "", loading: "lazy", decoding: "async" }),
          h("span", { class: "season-date", text: fmtDate(p.date, "short") }),
          h(
            "span",
            { class: "season-bar", "aria-hidden": "true" },
            h("span", { class: "seg-water", style: `width:${(100 * p.open_water_km2) / top}%` }),
            h("span", { class: "seg-hidden", style: `width:${(100 * p.flooded_veg_km2) / top}%` }),
          ),
          h("span", { class: "season-km2", text: t("compare.km2", { v: fmtNumber(p.flooded_km2, 0) }) }),
        ),
      ),
    );
  });

  watch(store, ["passIndex", "site"], ({ passIndex }) => {
    for (const b of grid.children) {
      const on = Number(b.dataset.index) === passIndex;
      b.classList.toggle("is-now", on);
      b.setAttribute("aria-pressed", String(on));
    }
  });
}
