// Why L-band sees it: hidden-flood detection against GEDI canopy cover.
import { h, s, scale, srTable } from "./svg.js";
import { watch } from "./state.js";
import { fmtNumber } from "./i18n.js";
import { setLead, setNote } from "./readable.js";

export const id = "canopy";
export const slot = "sidebar";

const W = 340;
const H = 150;
const M = { l: 34, r: 8, t: 12, b: 30 };

export function init({ store, t, root }) {
  const lead = h("p", { class: "canopy-lead" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "canopy-chart", role: "img" });
  const note = h("p", { class: "muted small" });
  const table = h("div");
  root.append(h("h2", { text: t("canopy.title") }), lead, svg, note, table);

  watch(store, ["site"], ({ site }) => {
    const c = site?.summary.products.canopy;
    const bins = (c?.detection_by_cover ?? []).filter((b) => b.pixels > 0);
    root.hidden = !bins.length;
    if (!bins.length) return;
    svg.replaceChildren();
    const y = scale([0, 1], [H - M.b, M.t]);
    const bw = (W - M.l - M.r) / bins.length;
    for (const v of [0, 0.5, 1]) {
      svg.append(
        s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }),
        s("text", { x: M.l - 5, y: y(v) + 3, class: "tick", "text-anchor": "end" }, `${fmtNumber(v * 100, 0)}%`),
      );
    }
    bins.forEach((b, i) => {
      const x = M.l + bw * i + bw * 0.15;
      svg.append(
        s("rect", { x, width: bw * 0.7, y: y(b.hidden_share), height: H - M.b - y(b.hidden_share), class: "bar-hidden" }),
        s("rect", { x: x + bw * 0.25, width: bw * 0.2, y: y(b.low_conf_share), height: H - M.b - y(b.low_conf_share), class: "bar-lowconf" }),
        s("text", { x: x + bw * 0.35, y: H - M.b + 13, class: "tick", "text-anchor": "middle" }, `${b.cover_from}–${b.cover_to}%`),
      );
    });
    svg.append(s("text", { x: (M.l + W - M.r) / 2, y: H - 2, class: "tick", "text-anchor": "middle" }, t("canopy.axis")));
    const dense = bins.filter((b) => b.cover_from >= 60);
    const best = dense.length ? dense.reduce((a, b) => (b.hidden_share > a.hidden_share ? b : a)) : null;
    setLead(lead, best
      ? t("canopy.lead", { share: fmtNumber(best.hidden_share * 100, 0), from: best.cover_from, to: best.cover_to })
      : t("canopy.lead_sparse"));
    setNote(note, "source", `${t("canopy.note")} ${c.source}.`);
    svg.setAttribute("aria-label", t("canopy.aria"));
    table.replaceChildren(
      srTable(t("canopy.title"), [t("canopy.axis"), t("canopy.col_hidden"), t("canopy.col_low"), t("canopy.col_px")],
        bins.map((b) => [`${b.cover_from}–${b.cover_to}%`, fmtNumber(b.hidden_share * 100, 0), fmtNumber(b.low_conf_share * 100, 0), String(b.pixels)])),
    );
  });
}
