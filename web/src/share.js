// F19 share: copy a link that reopens this exact view (site, pass, view, comparison, spot).
import { h, icon } from "./svg.js";

export const id = "share";
export const slot = "header";

export function init({ store, t, root }) {
  const label = h("span", { class: "btn-label", text: t("share.copy") });
  const btn = h("button", { type: "button", class: "btn icon-label-btn link-btn", title: t("share.copy") }, icon("link"), label);
  const live = h("span", { class: "sr-only", "aria-live": "polite" });
  root.append(btn, live);
  let reset = 0;

  btn.addEventListener("click", async () => {
    const url = location.href;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      // Clipboard can be blocked (insecure origin, permissions): show the link instead.
      window.prompt(t("share.manual"), url);
    }
    const msg = t(ok ? "share.copied" : "share.shown");
    // The label shows for a moment even where it is folded away, so the result is seen.
    label.textContent = msg;
    btn.classList.add("is-flash");
    live.textContent = msg;
    clearTimeout(reset);
    reset = setTimeout(() => {
      label.textContent = t("share.copy");
      btn.classList.remove("is-flash");
    }, 2200);
  });

  store.subscribe(() => {
    btn.disabled = !store.get().site;
  });
}
