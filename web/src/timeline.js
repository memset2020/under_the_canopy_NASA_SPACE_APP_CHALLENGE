// Pass slider, step buttons and play (F01).
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate } from "./i18n.js";
import { hasDataOn, isStaticView } from "./viewdata.js";

export const id = "timeline";
export const slot = "map-bottom";

const STEP_MS = 900;

export function init({ store, t, root }) {
  const prev = h("button", { type: "button", class: "icon-btn", "aria-label": t("timeline.prev") }, "‹");
  const next = h("button", { type: "button", class: "icon-btn", "aria-label": t("timeline.next") }, "›");
  const play = h("button", { type: "button", class: "play-btn", "aria-pressed": "false" });
  const range = h("input", { type: "range", min: "0", step: "1", "aria-label": t("timeline.pass") });
  const date = h("output", { class: "timeline-date", "aria-live": "polite" });
  const ends = h("div", { class: "timeline-ends", "aria-hidden": "true" });
  // Flooded area per pass, stacked like the map: water under the trees on top of open water.
  // Pointer shortcut only; the range input is the keyboard and screen-reader control.
  const bars = h("div", { class: "timeline-bars", "aria-hidden": "true" });
  const caption = h("p", { class: "timeline-caption" });
  const staticNote = h("p", { class: "timeline-static", hidden: true, text: t("timeline.static") });
  root.classList.add("timeline");
  root.append(
    h("div", { class: "timeline-controls" }, prev, play, next),
    h("div", { class: "timeline-track" }, bars, range, ends),
    h("div", { class: "timeline-now" }, date, caption, staticNote),
  );
  bars.addEventListener("click", (ev) => {
    const bar = ev.target.closest(".tbar");
    if (bar) store.set({ passIndex: Number(bar.dataset.index), playing: false });
  });

  let timer = 0;
  const count = () => store.get().site?.passCount ?? 0;
  const go = (i) => store.set({ passIndex: (i + count()) % count() });

  prev.addEventListener("click", () => go(store.get().passIndex - 1));
  next.addEventListener("click", () => go(store.get().passIndex + 1));
  range.addEventListener("input", () => store.set({ passIndex: Number(range.value), playing: false }));
  play.addEventListener("click", () => store.set({ playing: !store.get().playing }));

  watch(store, ["site"], ({ site }) => {
    root.hidden = !site || site.passCount < 2;
    if (!site) return;
    const passes = site.summary.passes;
    range.max = String(passes.length - 1);
    // A fire site's bars are its burned forest so far: there the flood rule reads burn as water (D-076).
    const burn = site.summary.products.burn;
    const top = burn
      ? Math.max(...burn.by_pass.map((r) => r.burned_km2), 1e-9)
      : Math.max(...passes.map((p) => p.flooded_km2), 1e-9);
    bars.replaceChildren(
      ...passes.map((p, i) =>
        h(
          "div",
          { class: "tbar", dataset: { index: String(i) }, title: fmtDate(p.date) },
          ...(burn
            ? [h("span", { class: "tbar-burn", style: `height:${(100 * (burn.by_pass[i]?.burned_km2 ?? 0)) / top}%` })]
            : [
                h("span", { class: "tbar-hidden", style: `height:${(100 * p.flooded_veg_km2) / top}%` }),
                h("span", { class: "tbar-water", style: `height:${(100 * p.open_water_km2) / top}%` }),
              ]),
        ),
      ),
    );
    ends.replaceChildren(
      h("span", { text: fmtDate(passes[0].date, "short") }),
      h("span", { text: fmtDate(passes.at(-1).date, "short") }),
    );
  });

  watch(store, ["passIndex", "site"], ({ site, passIndex }) => {
    if (!site) return;
    const p = site.summary.passes[passIndex];
    range.value = String(passIndex);
    range.setAttribute("aria-valuetext", fmtDate(p.date));
    date.value = fmtDate(p.date);
    caption.textContent = t("timeline.caption", { n: passIndex + 1, total: site.passCount });
    for (const b of bars.children) b.classList.toggle("is-now", Number(b.dataset.index) === passIndex);
  });

  // The bars say which passes this view can show, and whether it changes with the pass at all.
  watch(store, ["site", "view"], ({ site, view }) => {
    if (!site) return;
    const still = isStaticView(view);
    root.classList.toggle("is-static", still);
    staticNote.hidden = !still;
    for (const b of bars.children) {
      const has = hasDataOn(site.summary, view, Number(b.dataset.index));
      b.classList.toggle("tbar-empty", !has);
      b.title = has ? fmtDate(site.summary.passes[Number(b.dataset.index)].date) : t("timeline.no_data", { date: fmtDate(site.summary.passes[Number(b.dataset.index)].date) });
    }
  });

  watch(store, ["playing"], ({ playing }) => {
    clearInterval(timer);
    play.setAttribute("aria-pressed", String(Boolean(playing)));
    play.setAttribute("aria-label", t(playing ? "timeline.pause" : "timeline.play"));
    play.textContent = playing ? "❚❚" : "▶";
    if (playing) timer = setInterval(() => go(store.get().passIndex + 1), STEP_MS);
  });
}
