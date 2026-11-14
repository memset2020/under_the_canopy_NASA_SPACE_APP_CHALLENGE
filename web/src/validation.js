// F05 river-gauge validation: does the mapped flood rise and fall with the river?
import { h, s, scale, srTable, ticks } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { checkRow, fillCheck, setNote } from "./readable.js";

export const id = "validation";
export const slot = "sidebar";

const MIN_PASSES = 6; // docs/04 §7
const W = 340;
const H = 200;
const M = { l: 40, r: 10, t: 10, b: 34 };

function draw(svg, series, passIndex, t) {
  svg.replaceChildren();
  const pts = series.map((p, i) => ({ ...p, i })).filter((p) => p.stage_m !== null);
  const sx = pts.map((p) => p.stage_m);
  const sy = pts.map((p) => p.flooded_km2);
  const pad = (lo, hi) => [lo - (hi - lo) * 0.08, hi + (hi - lo) * 0.08];
  const [x0, x1] = pad(Math.min(...sx), Math.max(...sx));
  const [y0, y1] = pad(Math.min(...sy), Math.max(...sy));
  const x = scale([x0, x1], [M.l, W - M.r]);
  const y = scale([y0, y1], [H - M.b, M.t]);
  for (const v of ticks(y0, y1, 3)) {
    svg.append(
      s("line", { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), class: "grid" }),
      s("text", { x: M.l - 5, y: y(v) + 3, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)),
    );
  }
  for (const v of ticks(x0, x1, 4)) {
    svg.append(s("text", { x: x(v), y: H - M.b + 14, class: "tick", "text-anchor": "middle" }, fmtNumber(v, 1)));
  }
  svg.append(
    s("text", { x: (M.l + W - M.r) / 2, y: H - 4, class: "tick", "text-anchor": "middle" }, t("validation.axis_stage")),
  );
  // Least-squares line: a visual guide for the correlation, not a model.
  const n = pts.length;
  const mx = sx.reduce((a, b) => a + b, 0) / n;
  const my = sy.reduce((a, b) => a + b, 0) / n;
  const sxx = sx.reduce((a, v) => a + (v - mx) ** 2, 0);
  if (sxx > 0) {
    const k = sx.reduce((a, v, i) => a + (v - mx) * (sy[i] - my), 0) / sxx;
    svg.append(s("line", { x1: x(x0), y1: y(my + k * (x0 - mx)), x2: x(x1), y2: y(my + k * (x1 - mx)), class: "fit" }));
  }
  for (const p of pts) {
    svg.append(s("circle", { cx: x(p.stage_m), cy: y(p.flooded_km2), r: p.i === passIndex ? 5.5 : 3.5, class: p.i === passIndex ? "pt pt-now" : "pt" }));
  }
}

// Held-out score of the hidden-flood rule against independently mapped wetlands (D-044).
function calibrationText(cal, t) {
  const fv = cal?.flooded_veg;
  if (!fv || fv.held_out_after === null) return "";
  const pct = (v) => fmtNumber(v * 100, 0);
  const sources = fv.label_sources.join(", ");
  if (fv.applied) {
    return t("validation.calibration", { sources, score: pct(fv.held_out_after), before: pct(fv.held_out_before) });
  }
  const failed = t("validation.calibration_failed", { sources, score: pct(fv.held_out_before ?? fv.held_out_after) });
  return fv.rejected ? `${failed} ${t(`validation.calibration_rejected_${fv.rejected}`, { score: pct(fv.held_out_after) })}` : failed;
}

// The terrain check (ASF HAND): water under the trees against dry forest, both measured on the
// same treetop surface; within 1 m (two 0.5 m steps) counts as no difference.
export function handVerdict(hand) {
  if (!hand || hand.hidden_median_m === null || hand.dry_veg_median_m === null) return null;
  const d = hand.hidden_median_m - hand.dry_veg_median_m;
  return d < -1 ? "lower" : d > 1 ? "higher" : "same";
}

function handCheck(hand, t) {
  const v = handVerdict(hand);
  if (!v) return "";
  return t(`validation.hand_${v}`, {
    hidden: fmtNumber(hand.hidden_median_m, 1),
    dry: fmtNumber(hand.dry_veg_median_m, 1),
    water: hand.open_water_median_m === null ? "–" : fmtNumber(hand.open_water_median_m, 1),
  });
}

export function init({ store, t, root }) {
  const verdict = h("p", { class: "validation-verdict" });
  // The gauge's name and lag as a source, the "timing, not pixels" limit as a limit (D-093).
  const detail = h("p");
  const caveat = h("p");
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "scatter", role: "img" });
  const table = h("div");
  // The other checks as a checklist: each independent source, its status, what it found.
  const swot = checkRow("swot-line");
  const lidar = checkRow("lidar-line");
  const refLine = checkRow("ref-line");
  const calLine = checkRow("cal-line");
  const handLine = checkRow("hand-line");
  const glwdLine = checkRow("glwd-line");
  const checks = h("ul", { class: "rd-checks" }, swot, lidar, refLine, handLine, glwdLine, calLine);
  root.append(
    h("h2", { text: t("validation.title") }),
    verdict,
    svg,
    detail,
    caveat,
    h("h3", { class: "rd-sub", text: t("validation.more_checks") }),
    checks,
    table,
  );

  watch(store, ["site", "passIndex"], ({ site, passIndex }, _prev, changed) => {
    const gauge = site?.summary.validation.gauge;
    const sw = (site?.summary.validation.swot ?? [])[0];
    const ice = (site?.summary.validation.icesat2 ?? [])[0];
    fillCheck(
      lidar,
      !ice || ice.r === null ? "pending" : "done",
      t("validation.n_icesat2"),
      !site || site.summary.synthetic
        ? ""
        : !ice
          ? t("validation.icesat2_pending")
          : ice.r === null
            ? t(ice.n === 1 ? "validation.icesat2_one" : "validation.icesat2_few", { n: ice.n })
            : t("validation.icesat2", { r: fmtNumber(ice.r, 2), n: ice.n }),
    );
    const ref = site?.summary.validation.reference_map;
    const cal = site?.summary.validation.calibration;
    const hand = site?.summary.products.hand;
    root.hidden = !gauge && !sw && !ref && !cal && !hand && !site?.summary.products.glwd;
    // A terrain check that disagrees is a caution, as its own sentence says.
    fillCheck(handLine, handVerdict(hand) === "lower" ? "done" : "caution", t("validation.n_hand"), handCheck(hand, t));
    const gl = site?.summary.products.glwd;
    fillCheck(
      glwdLine,
      "done",
      t("validation.n_glwd"),
      gl && gl.hidden_wetland_pct !== null
        ? t("validation.glwd", { wet: fmtNumber(gl.hidden_wetland_pct, 0), forested: fmtNumber(gl.hidden_forested_pct ?? 0, 0), site: fmtNumber(gl.site_wetland_pct ?? 0, 0) })
        : "",
    );
    // A calibration that was not applied (it did worse on held-out blocks) is a caution.
    fillCheck(calLine, cal?.flooded_veg?.applied ? "done" : "caution", t("validation.n_cal"), calibrationText(cal, t));
    fillCheck(
      refLine,
      "done",
      t("validation.n_ref"),
      !ref
        ? ""
        : t("validation.reference", {
            name: ref.name,
            period: ref.reference_period,
            agree: fmtNumber(ref.agreement * 100, 0),
            fv: ref.recall_flooded_veg === null ? t("common.none") : `${fmtNumber(ref.recall_flooded_veg * 100, 0)}%`,
          }),
    );
    fillCheck(
      swot,
      !sw || sw.r === null ? "pending" : "done",
      t("validation.n_swot"),
      !sw ? "" : sw.r === null ? t("validation.swot_few", { n: sw.n }) : t("validation.swot", { r: fmtNumber(sw.r, 2), n: sw.n }),
    );
    if (!gauge) {
      verdict.textContent = t("warning.no_gauge");
      svg.hidden = true;
      setNote(detail, "source", "");
      setNote(caveat, "limit", "");
      return;
    }
    const enough = gauge.n >= MIN_PASSES && gauge.r !== null;
    svg.hidden = !enough;
    if (!enough) {
      verdict.textContent = t("validation.not_enough", { n: gauge.n, min: MIN_PASSES });
      setNote(detail, "source", "");
      setNote(caveat, "limit", "");
      return;
    }
    const strength = gauge.r >= 0.8 ? "strong" : gauge.r >= 0.5 ? "moderate" : "weak";
    verdict.textContent = t(`validation.verdict_${strength}`, { r: fmtNumber(gauge.r, 2), n: gauge.n });
    setNote(
      detail,
      "source",
      [
        t("validation.gauge", { name: gauge.name, source: gauge.source }),
        gauge.best_lag_days !== 0
          ? t("validation.lag", { days: Math.abs(gauge.best_lag_days), r: fmtNumber(gauge.r_best, 2), dir: t(gauge.best_lag_days > 0 ? "validation.after" : "validation.before") })
          : "",
      ].filter(Boolean).join(" "),
    );
    setNote(caveat, "limit", t("validation.caveat"));
    draw(svg, gauge.series, passIndex, t);
    svg.setAttribute("aria-label", t("validation.aria", { r: fmtNumber(gauge.r, 2), n: gauge.n }));
    if (changed.includes("site")) {
      table.replaceChildren(
        srTable(
          t("validation.title"),
          [t("chart.col_date"), t("validation.axis_stage"), t("validation.col_area")],
          gauge.series.map((p) => [fmtDate(p.date), fmtNumber(p.stage_m, 2), fmtNumber(p.flooded_km2)]),
        ),
      );
    }
  });
}
