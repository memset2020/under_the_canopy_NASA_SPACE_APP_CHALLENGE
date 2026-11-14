// Water level under the trees: NISAR interferograms (GUNW) between consecutive passes.
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { setLead, setNote } from "./readable.js";

export const id = "level";
export const slot = "sidebar";

const W = 340;
const H = 150;
const M = { l: 36, r: 8, t: 10, b: 22 };

function draw(svg, entries, currentTo) {
  svg.replaceChildren();
  const vals = entries.flatMap((e) => [e.p10_cm, e.p90_cm, e.median_cm]).filter((v) => v !== null);
  const lim = Math.max(5, ...vals.map(Math.abs)) * 1.1;
  const y = scale([-lim, lim], [H - M.b, M.t]);
  const bw = (W - M.l - M.r) / entries.length;
  for (const v of ticks(-lim, lim, 4)) {
    svg.append(
      s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: v === 0 ? "zero" : "grid" }),
      s("text", { x: M.l - 5, y: y(v) + 3, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)),
    );
  }
  entries.forEach((e, i) => {
    const cx = M.l + bw * (i + 0.5);
    if (e.median_cm === null) {
      svg.append(s("text", { x: cx, y: y(0) - 4, class: "tick", "text-anchor": "middle" }, "–"));
      return;
    }
    svg.append(
      s("line", { x1: cx, x2: cx, y1: y(e.p10_cm), y2: y(e.p90_cm), class: "whisker" }),
      s("rect", {
        x: cx - bw * 0.3, width: bw * 0.6,
        y: Math.min(y(0), y(e.median_cm)), height: Math.max(1, Math.abs(y(e.median_cm) - y(0))),
        class: `bar ${e.median_cm >= 0 ? "bar-rise" : "bar-fall"}${e.to === currentTo ? " is-now" : ""}`,
      }),
    );
  });
  svg.append(
    s("text", { x: M.l, y: H - 6, class: "tick" }, fmtDate(entries[0].to, "short")),
    s("text", { x: W - M.r, y: H - 6, class: "tick", "text-anchor": "end" }, fmtDate(entries.at(-1).to, "short")),
  );
}

export function init({ store, t, root }) {
  const lead = h("p", { class: "level-lead", "aria-live": "polite" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "level-chart", role: "img" });
  const note = h("p", { class: "muted small" });
  const table = h("div");
  root.append(h("h2", { text: t("level.title") }), lead, svg, note, table);

  watch(store, ["site", "passIndex"], ({ site, passIndex }, _p, changed) => {
    const entries = site?.summary.products.level_change ?? [];
    root.hidden = !entries.length;
    if (!entries.length) return;
    const date = site.summary.passes[passIndex].date;
    const now = entries.find((e) => e.to === date);
    const noise = now && now.median_cm !== null && Math.abs(now.median_cm) < Math.max(2, (now.p90_cm - now.p10_cm) / 4);
    if (noise) {
      setLead(lead, t("level.within_noise", {
        from: fmtDate(now.from),
        to: fmtDate(now.to),
        lo: fmtNumber(now.p10_cm, 0),
        hi: fmtNumber(now.p90_cm, 0),
      }));
    } else if (now && now.median_cm !== null) {
      setLead(lead, t(now.median_cm >= 0 ? "level.rose" : "level.fell", {
        cm: fmtNumber(Math.abs(now.median_cm), 1),
        from: fmtDate(now.from),
        to: fmtDate(now.to),
        share: fmtNumber(now.coherent_share * 100, 0),
      }));
    } else {
      setLead(lead, t("level.none_now", { date: fmtDate(date) }));
    }
    draw(svg, entries, date);
    svg.setAttribute("aria-label", t("level.aria", { n: entries.length }));
    const e0 = entries[0];
    setNote(note, "info", `${t("level.method")} ${t(`level.sign_${e0.sign_status}`, {
      strong: e0.sign_pairs_strong ?? 0,
      total: e0.sign_pairs_total ?? 0,
      r: e0.sign_r === null ? "" : fmtNumber(e0.sign_r, 2),
    })}`);
    if (changed.includes("site")) {
      table.replaceChildren(
        srTable(
          t("level.title"),
          [t("level.col_pair"), t("level.col_median"), t("level.col_range")],
          entries.map((e) => [
            `${fmtDate(e.from)} – ${fmtDate(e.to)}`,
            fmtNumber(e.median_cm, 1),
            e.p10_cm === null ? t("common.none") : `${fmtNumber(e.p10_cm, 1)} … ${fmtNumber(e.p90_cm, 1)}`,
          ]),
        ),
      );
    }
  });
}
