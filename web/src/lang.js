// F14 language picker. Switching reloads with ?lang= so every feature renders in the new
// language and the link stays shareable. Translations are AI drafts until a native
// speaker signs them off (docs/07 T-31), and the picker says so.
import { h } from "./svg.js";
import { LANGUAGES, language } from "./i18n.js";

export const id = "lang";
export const slot = "header";

export function init({ t, root }) {
  const select = h("select", { id: "lang-select", "aria-label": t("lang.label") });
  for (const code of LANGUAGES) {
    select.append(h("option", { value: code, text: t(`lang.name_${code}`) }));
  }
  select.value = language();
  root.append(select);
  if (language() !== "en") {
    root.append(h("span", { class: "lang-note", title: t("lang.review_note"), text: t("lang.draft") }));
  }
  select.addEventListener("change", () => {
    const q = new URLSearchParams(location.search);
    if (select.value === "en") q.delete("lang");
    else q.set("lang", select.value);
    location.search = q.toString();
  });
}
