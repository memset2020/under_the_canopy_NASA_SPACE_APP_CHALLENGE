// Is this a wet year? (F39): GRACE/GRACE-FO basin water storage against the same month in 2004–2023.
import { h, s, scale, srTable } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { setLead, setNote } from "./readable.js";

export const id = "basin";
export const slot = "sidebar";

const W = 340;
const H = 150;
const M = { l: 34, r: 8, t: 10, b: 24 };

export function init({ store, t, root }) {
  const lead = h("p", { class: "basin-lead" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "basin-chart", role: "img" });
  const note = h("p", { class: "muted small" });
  const table = h("div");
  root.append(h("h2", { text: t("basin.title") }), lead, svg, note, table);

  watch(store, ["site", "passIndex"], ({ site, passIndex }) => {
    const rows = site?.summary.context.water_storage_monthly ?? [];
    root.hidden = rows.length < 3;
    if (root.hidden) return;
    const passes = site.summary.passes;
    const passDate = passes[passIndex].date;
    // Month of the pass, or the latest month before it (GRACE is monthly and lags).
    let k = rows.length - 1;
    for (let i = 0; i < rows.length; i += 1) if (rows[i][0] <= passDate) k = i;
    const [month, cm] = rows[k];
    setLead(
      lead,
      Math.abs(cm) < 0.5
        ? t("basin.normal", { month: fmtDate(month, "month") })
        : t(cm > 0 ? "basin.wetter" : "basin.drier", { cm: fmtNumber(Math.abs(cm), 0), month: fmtDate(month, "month") }),
    );
    setNote(note, "source", t("basin.note", { source: site.summary.context.water_storage_source }));

    svg.replaceChildren();
    const vals = rows.map((r) => r[1]);
    const lim = Math.max(10, ...vals.map(Math.abs));
    const y = scale([-lim, lim], [H - M.b, M.t]);
    const bw = (W - M.l - M.r) / rows.length;
    const first = passes[0].date;
    const last = passes.at(-1).date;
    svg.append(
      s("line", { x1: M.l, x2: W - M.r, y1: y(0), y2: y(0), class: "zero" }),
      s("text", { x: M.l - 4, y: y(lim) + 4, class: "tick", "text-anchor": "end" }, `+${fmtNumber(lim, 0)}`),
      s("text", { x: M.l - 4, y: y(-lim) + 4, class: "tick", "text-anchor": "end" }, `−${fmtNumber(lim, 0)}`),
    );
    rows.forEach(([d, v], i) => {
      const inSeason = d >= first.slice(0, 7) && d <= last;
      svg.append(
        s("rect", {
          x: M.l + i * bw + 1,
          y: Math.min(y(0), y(v)),
          width: Math.max(1, bw - 2),
          height: Math.abs(y(v) - y(0)),
          class: `bar ${v >= 0 ? "bar-wet" : "bar-dry"}${i === k ? " is-now" : ""}${inSeason ? " in-season" : ""}`,
        }),
      );
    });
    svg.append(
      s("text", { x: M.l, y: H - 6, class: "tick" }, fmtDate(rows[0][0], "month")),
      s("text", { x: W - M.r, y: H - 6, class: "tick", "text-anchor": "end" }, fmtDate(rows.at(-1)[0], "month")),
    );
    svg.setAttribute("aria-label", lead.textContent);
    table.replaceChildren(
      srTable(t("basin.title"), [t("chart.col_date"), t("basin.col_cm")], rows.map(([d, v]) => [fmtDate(d, "month"), fmtNumber(v, 1)])),
    );
  });
}
