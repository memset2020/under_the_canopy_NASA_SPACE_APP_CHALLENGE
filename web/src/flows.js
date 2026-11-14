// Where the water went (F46): every pixel followed from the first pass to the peak and on to the
// last, as an alluvial diagram. Ribbons are areas (km²) and take the colour of the class they
// left; the table below carries every number. Classes come from rules.js on the site's stack,
// so the flows add up to the map exactly.
import { h, s, srTable } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { CLASS, classifyGrid } from "./rules.js";
import { note, setLead } from "./readable.js";

export const id = "flows";
export const slot = "sidebar";

// Top to bottom; the two water classes lead, the rest is context.
const ORDER = [CLASS.FLOODED_VEG, CLASS.OPEN_WATER, CLASS.DRY, CLASS.EXCLUDED, CLASS.NODATA];
const FILL = {
  [CLASS.FLOODED_VEG]: "#e69f00",
  [CLASS.OPEN_WATER]: "#0072b2",
  [CLASS.DRY]: "#5d6f6a",
  [CLASS.EXCLUDED]: "#787878",
  [CLASS.NODATA]: "#2c3f47",
};
const KEY = {
  [CLASS.FLOODED_VEG]: "hidden",
  [CLASS.OPEN_WATER]: "water",
  [CLASS.DRY]: "dry",
  [CLASS.EXCLUDED]: "built",
  [CLASS.NODATA]: "nodata",
};

// km² moving from each class at one pass to each class at another. Pure; unit-tested.
export function transitions(a, b, rowAreaKm2, W) {
  const m = Array.from({ length: 5 }, () => new Float64Array(5));
  for (let i = 0; i < a.length; i += 1) m[a[i]][b[i]] += rowAreaKm2[Math.floor(i / W)];
  return m;
}

// The three stages: first, peak, last (or first, middle, last when the peak is an end).
export function stages(summary) {
  const n = summary.passes.length;
  let peak = Math.max(0, summary.passes.findIndex((p) => p.id === summary.peak_pass));
  if (peak === 0 || peak === n - 1) peak = Math.floor((n - 1) / 2);
  return n >= 3 ? [0, peak, n - 1] : [0, n - 1];
}

export function init({ store, t, root }) {
  const heading = h("h2", { text: t("flows.title") });
  const lead = h("p", { class: "flows-lead" });
  const svg = s("svg", { class: "flows-svg", role: "img" });
  const tip = h("p", { class: "flows-tip muted small", "aria-live": "polite", text: t("flows.hover") });
  const table = h("div");
  root.append(heading, lead, svg, tip, note("info", t("flows.note")), table);

  const name = (c) => t(`flows.class_${KEY[c]}`);

  function render(site, thresholds) {
    const s0 = site.summary;
    const idx = stages(s0);
    const L = site.layers;
    const cls = idx.map((p) =>
      classifyGrid(
        { hhQ: site.passPlane("hh", p), hvQ: site.passPlane("hv", p), spQ: site.passPlane("hh_spread", p), veg: site.staticPlane("veg") },
        { hh: L.hh, hv: L.hv, hh_spread: L.hh_spread },
        thresholds,
      ).cls,
    );
    const mats = idx.slice(1).map((_, k) => transitions(cls[k], cls[k + 1], site.rowAreaKm2, site.width));
    const totals = idx.map((_, k) => {
      const out = new Float64Array(5);
      if (k < mats.length) mats[k].forEach((row, c) => (out[c] = row.reduce((x, y) => x + y, 0)));
      else mats[k - 1].forEach((row) => row.forEach((v, c) => (out[c] += v)));
      return out;
    });
    const all = totals[0].reduce((x, y) => x + y, 0);

    // Layout: columns of stacked nodes with a 2 px surface gap; ribbons as cubic bands.
    const W = 340;
    const H = 240;
    const top = 26;
    const bottom = H - 8;
    const nodeW = 12;
    const colX = idx.map((_, k) => 46 + (k * (W - 46 - 70 - nodeW)) / (idx.length - 1));
    const gap = 2;
    const usable = bottom - top - gap * (ORDER.length - 1);
    const scaleY = usable / all;
    const nodes = totals.map((tot) => {
      let y = top;
      const out = {};
      for (const c of ORDER) {
        const hgt = tot[c] * scaleY;
        out[c] = { y, h: hgt, outY: y, inY: y };
        y += hgt + (hgt > 0 ? gap : 0);
      }
      return out;
    });
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren();
    idx.forEach((p, k) => {
      svg.append(s("text", { x: colX[k] + nodeW / 2, y: 14, class: "tick", "text-anchor": "middle" }, fmtDate(s0.passes[p].date, "short")));
    });
    // Ribbons first (under the nodes), biggest first so small ones stay on top.
    const ribbons = [];
    mats.forEach((m, k) => {
      for (const a of ORDER) {
        for (const b of ORDER) {
          const v = m[a][b];
          if (v <= all * 0.003) continue; // under 0.3 % of the box: in the table, not drawn
          ribbons.push({ k, a, b, v });
        }
      }
    });
    for (const r of ribbons) {
      const from = nodes[r.k][r.a];
      const to = nodes[r.k + 1][r.b];
      const hgt = r.v * scaleY;
      const x0 = colX[r.k] + nodeW;
      const x1 = colX[r.k + 1];
      const y0 = from.outY;
      const y1 = to.inY;
      from.outY += hgt;
      to.inY += hgt;
      const mx = (x0 + x1) / 2;
      const d = `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}V${y1 + hgt}C${mx},${y1 + hgt} ${mx},${y0 + hgt} ${x0},${y0 + hgt}Z`;
      const text = t("flows.tip", {
        km2: fmtNumber(r.v, r.v < 1 ? 2 : 1),
        from: name(r.a),
        to: name(r.b),
        d0: fmtDate(s0.passes[idx[r.k]].date),
        d1: fmtDate(s0.passes[idx[r.k + 1]].date),
      });
      const path = s("path", { d, class: "flows-ribbon", fill: FILL[r.a], tabindex: "0" }, s("title", {}, text));
      const show = () => {
        tip.textContent = text;
        path.classList.add("is-hot");
      };
      const hide = () => path.classList.remove("is-hot");
      path.addEventListener("pointerenter", show);
      path.addEventListener("focus", show);
      path.addEventListener("pointerleave", hide);
      path.addEventListener("blur", hide);
      svg.append(path);
    }
    nodes.forEach((col, k) => {
      for (const c of ORDER) {
        const n = col[c];
        if (n.h <= 0) continue;
        svg.append(s("rect", { x: colX[k], y: n.y, width: nodeW, height: n.h, rx: 2, fill: FILL[c] }));
        // Direct labels on the outer columns only, and only where they fit.
        if ((k === 0 || k === nodes.length - 1) && n.h >= 11) {
          const right = k === nodes.length - 1;
          svg.append(
            s(
              "text",
              { x: right ? colX[k] + nodeW + 5 : colX[k] - 5, y: n.y + n.h / 2 + 4, class: "tick", "text-anchor": right ? "start" : "end" },
              `${fmtNumber(totals[k][c], totals[k][c] < 10 ? 1 : 0)}`,
            ),
          );
        }
      }
    });
    svg.setAttribute("aria-label", t("flows.aria"));

    // Headline: what became of the water under the trees at the peak.
    const k = idx.length === 3 ? 1 : 0;
    const peakHidden = totals[k][CLASS.FLOODED_VEG];
    const after = mats[k] ?? mats[k - 1];
    const toDry = after[CLASS.FLOODED_VEG][CLASS.DRY];
    const stay = after[CLASS.FLOODED_VEG][CLASS.FLOODED_VEG];
    const toWater = after[CLASS.FLOODED_VEG][CLASS.OPEN_WATER];
    setLead(lead, t("flows.lead", {
      km2: fmtNumber(peakHidden, 1),
      date: fmtDate(s0.passes[idx[k]].date),
      end: fmtDate(s0.passes[idx.at(-1)].date),
      dry: fmtNumber(toDry, 1),
      still: fmtNumber(stay, 1),
      water: fmtNumber(toWater, 1),
    }));

    const rows = [];
    mats.forEach((m, kk) => {
      for (const a of ORDER) for (const b of ORDER) if (m[a][b] > 0.005) rows.push([`${fmtDate(s0.passes[idx[kk]].date)} → ${fmtDate(s0.passes[idx[kk + 1]].date)}`, name(a), name(b), fmtNumber(m[a][b], 2)]);
    });
    table.replaceChildren(srTable(t("flows.title"), [t("flows.col_period"), t("flows.col_from"), t("flows.col_to"), "km²"], rows));
  }

  let shown = null;
  watch(store, ["site", "scientist", "mode"], (st) => {
    root.hidden = !st.site || st.site.summary.passes.length < 2;
    if (root.hidden || st.mode !== "evidence") return; // computed when Evidence mode opens
    const thr = st.scientist?.enabled ? st.scientist.thresholds : st.site.summary.thresholds;
    const key = `${st.siteId}|${JSON.stringify(thr)}`;
    if (key === shown) return;
    shown = key;
    render(st.site, thr);
  });
}
