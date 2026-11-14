// The flood pulse in the radar itself (F47): one ridge per pass, the distribution of HH over
// vegetated pixels. Under trees standing in water the double bounce makes HH bright, so the
// share right of the hidden-flood threshold (amber) grows and shrinks with the flood. Click a
// ridge to open that pass. Distributions use the stack's exact 0.25 dB steps, lightly smoothed.
import { h, s, srTable } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { VEG } from "./rules.js";
import { note } from "./readable.js";

export const id = "ridges";
export const slot = "sidebar";

const LO = -25;
const HI = 5;
const STEP = 0.5;
const NB = (HI - LO) / STEP;

// Share of vegetated pixels per 0.5 dB HH bin (3-bin moving average). Pure; unit-tested.
export function hhDistribution(hhQ, veg, layer) {
  const counts = new Float64Array(NB);
  let n = 0;
  for (let i = 0; i < hhQ.length; i += 1) {
    if (veg[i] !== VEG.YES || hhQ[i] === layer.nodata) continue;
    const db = hhQ[i] * layer.scale + layer.offset;
    const b = Math.floor((db - LO) / STEP);
    if (b < 0 || b >= NB) continue;
    counts[b] += 1;
    n += 1;
  }
  const out = new Float64Array(NB);
  for (let b = 0; b < NB; b += 1) {
    const l = counts[Math.max(0, b - 1)];
    const r = counts[Math.min(NB - 1, b + 1)];
    out[b] = n ? (l + 2 * counts[b] + r) / (4 * n) : 0;
  }
  return { share: out, n };
}

export function shareAbove(dist, thresholdDb) {
  let sum = 0;
  for (let b = 0; b < NB; b += 1) if (LO + (b + 0.5) * STEP > thresholdDb) sum += dist.share[b];
  return sum;
}

export function init({ store, t, root }) {
  const heading = h("h2", { text: t("ridges.title") });
  const lead = note("info", t("ridges.lead"));
  const svg = s("svg", { class: "ridges-svg", role: "img" });
  const table = h("div");
  root.append(heading, lead, svg, h("ul", { class: "legend-inline" }, h("li", {}, h("span", { class: "swatch swatch-hidden" }), t("ridges.key_bright")), h("li", {}, h("span", { class: "swatch swatch-ridge" }), t("ridges.key_rest"))), table);

  let cache = { key: null, dists: [] };

  function render(st) {
    const site = st.site;
    const s0 = site.summary;
    const thr = (st.scientist?.enabled ? st.scientist.thresholds : s0.thresholds).fv_hh_db;
    const key = st.siteId;
    if (cache.key !== key) {
      cache = { key, dists: s0.passes.map((_, p) => hhDistribution(site.passPlane("hh", p), site.staticPlane("veg"), site.layers.hh)) };
    }
    const dists = cache.dists;
    const P = dists.length;
    const W = 340;
    const M = { l: 62, r: 8, t: 10, b: 26 };
    const rowH = Math.max(14, Math.min(22, 220 / P));
    const H = M.t + rowH * (P - 1) + rowH * 2.2 + M.b;
    const x = (db) => M.l + ((db - LO) / (HI - LO)) * (W - M.l - M.r);
    const maxShare = Math.max(...dists.flatMap((d) => [...d.share]), 1e-9);
    const amp = rowH * 2.2; // ridges overlap their neighbours a little: that is the form
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.replaceChildren();
    for (const v of [-20, -10, 0]) {
      svg.append(
        s("line", { x1: x(v), x2: x(v), y1: M.t, y2: H - M.b, class: "grid" }),
        s("text", { x: x(v), y: H - 8, class: "tick", "text-anchor": "middle" }, `${fmtNumber(v, 0)} dB`),
      );
    }
    dists.forEach((d, p) => {
      const base = M.t + amp + rowH * p;
      const y = (v) => base - (v / maxShare) * amp;
      const pts = [...d.share].map((v, b) => [x(LO + (b + 0.5) * STEP), y(v)]);
      const area = (filter) => {
        const sel = pts.filter((_, b) => filter(LO + (b + 0.5) * STEP));
        if (sel.length < 2) return "";
        return `M${sel[0][0]},${base}L${sel.map(([a, c]) => `${a.toFixed(1)},${c.toFixed(1)}`).join("L")}L${sel.at(-1)[0]},${base}Z`;
      };
      const current = p === st.passIndex;
      const g = s("g", { class: `ridge${current ? " is-current" : ""}`, tabindex: "0", role: "button", "aria-label": t("ridges.ridge_aria", { date: fmtDate(s0.passes[p].date), pct: fmtNumber(100 * shareAbove(d, thr), 0) }) });
      g.append(
        // The whole row is the hit target, not just the painted ridge (dataviz: hit > mark).
        s("rect", { x: 0, y: base - rowH, width: W, height: rowH, class: "ridge-hit" }),
        s("path", { d: area(() => true), class: "ridge-fill" }),
        s("path", { d: area((db) => db > thr), class: "ridge-bright" }),
        s("path", { d: `M${pts.map(([a, c]) => `${a.toFixed(1)},${c.toFixed(1)}`).join("L")}`, class: "ridge-line" }),
        s("text", { x: M.l - 6, y: base + 4, class: "tick", "text-anchor": "end" }, fmtDate(s0.passes[p].date, "short")),
        s("title", {}, t("ridges.ridge_aria", { date: fmtDate(s0.passes[p].date), pct: fmtNumber(100 * shareAbove(d, thr), 0) })),
      );
      const open = () => store.set({ passIndex: p, playing: false });
      g.addEventListener("click", open);
      g.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
      svg.append(g);
    });
    svg.append(
      s("line", { x1: x(thr), x2: x(thr), y1: M.t, y2: H - M.b, class: "ridge-threshold" }),
      // Label on whichever side of the line has room.
      s("text", { x: x(thr) > W - 110 ? x(thr) - 4 : x(thr) + 4, y: M.t + 9, class: "tick", "text-anchor": x(thr) > W - 110 ? "end" : "start" }, t("ridges.threshold", { db: fmtNumber(thr, 2) })),
    );
    svg.setAttribute("aria-label", t("ridges.aria"));
    table.replaceChildren(
      srTable(
        t("ridges.title"),
        [t("chart.col_date"), t("ridges.col_bright")],
        dists.map((d, p) => [fmtDate(s0.passes[p].date), `${fmtNumber(100 * shareAbove(d, thr), 1)}%`]),
      ),
    );
  }

  watch(store, ["site", "passIndex", "scientist", "mode"], (st) => {
    root.hidden = !st.site;
    if (!root.hidden && st.mode === "evidence") render(st);
  });
}
