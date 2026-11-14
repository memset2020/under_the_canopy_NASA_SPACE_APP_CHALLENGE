// What changed (F59, docs/14): the surface changes this app tracks, one switch in the header.
// Water under the trees and burned forest are sites (site.kind in the manifest); ice is the
// glacier atlas, its own mode (glaciers.js, docs/16); ground motion is its own mode (motion.js).
// The switch only selects; each feature does its job.
import { h } from "./svg.js";
import { watch } from "./state.js";

export const id = "changes";
export const slot = "header";

export const KINDS = ["water", "fire", "ice", "ground"];
// The fire the switch opens first: the one the burn rule was tuned and checked on most fully
// (products.burn.tuned_site); other fire sites are in the site list.
export const FIRE_DEFAULT = "thunder_bay_36";

// Which part of the switch is on for a state of the app.
export function activeKind({ mode, site }) {
  if (mode === "motion") return "ground";
  if (mode === "ice") return "ice";
  return site?.summary.site.kind === "fire" ? "fire" : "water";
}

export function init({ store, t, root }) {
  const buttons = KINDS.map((k) =>
    h("button", { type: "button", class: "seg-btn", dataset: { kind: k }, "aria-pressed": "false", "aria-label": t(`changes.${k}_full`), title: t(`changes.${k}_full`), text: t(`changes.${k}`) }),
  );
  root.append(h("div", { class: "seg changes-switch", role: "group", "aria-label": t("changes.label") }, buttons));
  root.hidden = true;

  function openSite(siteId) {
    const sel = document.getElementById("site-select");
    if (!sel || !siteId) return;
    sel.value = siteId;
    sel.dispatchEvent(new Event("change")); // main.js loads it in Site mode
  }

  for (const b of buttons) {
    b.addEventListener("click", () => {
      const { manifest, site } = store.get();
      const kind = b.dataset.kind;
      if (kind === "ground") {
        store.set({ mode: "motion", ice: false });
        return;
      }
      if (kind === "ice") {
        store.set({ mode: "ice", ice: false });
        return;
      }
      store.set({ ice: false });
      if (store.get().mode === "ice") store.set({ mode: "site" });
      const sites = manifest?.sites ?? [];
      const isKind = (s) => ((s.kind ?? "flood") === "fire") === (kind === "fire");
      if (site && isKind({ kind: site.summary.site.kind })) {
        store.set({ mode: "site" });
        return;
      }
      const first = kind === "water" ? manifest.default_site : FIRE_DEFAULT;
      const preferred = sites.find((s) => s.id === first && isKind(s));
      openSite((preferred ?? sites.find(isKind))?.id);
    });
  }

  watch(store, ["manifest", "mode", "site", "ice"], (st) => {
    const sites = st.manifest?.sites ?? [];
    buttons[1].hidden = !sites.some((s) => s.kind === "fire");
    buttons[2].hidden = !st.manifest?.glaciers;
    buttons[3].hidden = !st.manifest?.motion;
    root.hidden = buttons[1].hidden && buttons[2].hidden && buttons[3].hidden;
    const on = activeKind(st);
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.kind === on));
    // A fire site hides the cards that count flood (styles/main.css): burned forest reads as
    // water under trees to the flood rule (docs/10 D-076).
    document.body.dataset.change = on;
    document.body.dataset.ice = String(Boolean(st.ice)); // the fire chapter's smoke-and-ice card
  });
}
