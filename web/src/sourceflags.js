// Source flags (D-110): where a card or the "How we know" guide used to list its sources in full,
// it now shows one small pennant per umbrella (coloured as on the sources page, with how many
// sources it holds) linking to that section, and a link to every source. The list lives once.
import { h, s } from "./svg.js";
import { fmtNumber, language } from "./i18n.js";
import { byUmbrella, entryForSource, sourcesHref } from "./sources-registry.js";

export function pennant(colour) {
  return s(
    "svg",
    { class: "flag-pennant", width: 12, height: 14, viewBox: "0 0 12 14", "aria-hidden": "true" },
    s("path", { d: "M1.5 1v12", stroke: "currentColor", "stroke-width": 1.4, "stroke-linecap": "round" }),
    s("path", { d: "M2.2 1.6h8.3l-2.4 3 2.4 3H2.2z", fill: colour }),
  );
}

// entries: registry entries (or summary sources, mapped through entryForSource).
export function sourceFlags(entries, t, { title = true } = {}) {
  const list = [...new Set(entries.map((e) => (e && e.umbrella ? e : e && entryForSource(e))).filter(Boolean))];
  const lang = language();
  const groups = byUmbrella(list);
  return h(
    "div",
    { class: "source-flags" },
    title ? h("p", { class: "source-flags-title", text: t("sources.flags_title", { n: list.length }) }) : null,
    h(
      "ul",
      { class: "source-flags-list" },
      groups.map(({ umbrella, list: l }) =>
        h(
          "li",
          {},
          h(
            "a",
            { href: sourcesHref(`u-${umbrella.id}`, lang), target: "_blank", rel: "noopener", title: l.map((e) => e.name).join(" · ") },
            pennant(umbrella.colour),
            h("span", { text: t(`sources.u_${umbrella.id}`) }),
            h("b", { text: fmtNumber(l.length, 0) }),
          ),
        ),
      ),
    ),
    h("a", { class: "source-flags-all", href: sourcesHref("top", lang), target: "_blank", rel: "noopener", text: t("sources.see_all") }),
  );
}
