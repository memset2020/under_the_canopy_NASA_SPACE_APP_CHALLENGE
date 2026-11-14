// "How we know" (F06, reworked in D-110): a field guide in four chapters, one per change the app
// shows (water, fire, ground, ice), each told in the same five beats: the question, what the
// radar physically does (drawn), the rule made visible, how it was checked (with this site's own
// results where the data has them), and where it can be wrong. Each chapter ends with flags to
// the sources it rests on, on the sources page, instead of a list. Opens on the chapter of the
// mode in use.
import { h, s, icon } from "./svg.js";
import { watch } from "./state.js";
import { fmtNumber } from "./i18n.js";
import { SOURCES } from "./sources-registry.js";
import { sourceFlags } from "./sourceflags.js";
import { icon as rdIcon } from "./readable.js";

export const id = "physics";
export const slot = "header";

const CHAPTERS = ["water", "fire", "ground", "ice"];

function tree(x, ground, height = 78, burnt = false) {
  return s(
    "g",
    { class: burnt ? "tree burnt" : "tree" },
    s("rect", { x: x - 3, y: ground - height, width: 6, height, class: "trunk" }),
    ...(burnt
      ? [s("path", { d: `M${x} ${ground - height + 6} l-14 -10 M${x} ${ground - height + 16} l13 -9 M${x} ${ground - height + 26} l-10 -6`, class: "snag" })]
      : [
          s("ellipse", { cx: x, cy: ground - height, rx: 22, ry: 16, class: "crown" }),
          s("ellipse", { cx: x - 12, cy: ground - height + 10, rx: 14, ry: 10, class: "crown" }),
          s("ellipse", { cx: x + 13, cy: ground - height + 9, rx: 14, ry: 10, class: "crown" }),
        ]),
  );
}

// One panel of the water diagram. kind: "dry" | "flooded" | "water".
function panel(kind, t, ox) {
  const ground = 150;
  const g = s("g", { transform: `translate(${ox} 0)`, class: `panel panel-${kind}` });
  g.append(s("rect", { x: 0, y: 0, width: 200, height: 190, class: "sky" }));
  g.append(s("path", { d: "M8 22 l16 -8 l4 8 l-16 8z", class: "sat" }));
  if (kind === "water") {
    g.append(s("rect", { x: 0, y: ground, width: 200, height: 40, class: "water" }));
  } else {
    g.append(s("rect", { x: 0, y: ground, width: 200, height: 40, class: kind === "flooded" ? "water" : "soil" }));
    g.append(tree(80, ground), tree(140, ground, 70));
  }
  if (kind === "dry") {
    g.append(s("path", { d: "M26 24 L72 70", class: "ray ray-l" }));
    for (const d of ["M72 70 l-14 -10", "M72 70 l12 -14", "M72 70 l-4 16", "M72 70 l16 6"]) g.append(s("path", { d, class: "ray ray-scatter" }));
    g.append(s("path", { d: "M68 64 L30 30", class: "ray ray-return ray-weak" }));
  } else if (kind === "flooded") {
    g.append(s("path", { d: "M26 24 L66 150 L77 112 L30 28", class: "ray ray-l ray-double" }));
    g.append(s("path", { d: "M34 18 L122 66", class: "ray ray-c" }));
    for (const d of ["M122 66 l-10 -8", "M122 66 l10 -6", "M122 66 l2 12"]) g.append(s("path", { d, class: "ray ray-c-scatter" }));
  } else {
    g.append(s("path", { d: "M26 24 L100 150 L174 24", class: "ray ray-l ray-away" }));
  }
  g.append(s("text", { x: 100, y: 182, class: "panel-label", "text-anchor": "middle" }, t(`physics.panel_${kind}`)));
  return g;
}

export function diagram(t) {
  const svg = s("svg", { viewBox: "0 0 620 190", class: "physics-diagram", role: "img", "aria-label": t("physics.diagram_aria") });
  svg.append(panel("dry", t, 0), panel("flooded", t, 210), panel("water", t, 420));
  return svg;
}

// Why C-band misses it, to scale: a 5.6 cm wave meets leaves its own size and scatters; a 24 cm
// wave passes them.
function wavelengths(t) {
  const svg = s("svg", { viewBox: "0 0 620 170", class: "guide-svg", role: "img", "aria-label": t("guide.w_waves_aria") });
  const wave = (y, lam, amp, x0, x1, cls) => {
    let d = `M${x0} ${y}`;
    for (let x = x0; x <= x1; x += 2) d += `L${x} ${(y + amp * Math.sin(((x - x0) / lam) * 2 * Math.PI)).toFixed(1)}`;
    return s("path", { d, class: cls });
  };
  // The canopy: a band of leaves (each about 5 cm long at the waves' scale) that both waves meet.
  svg.append(s("rect", { x: 300, y: 26, width: 92, height: 118, rx: 10, class: "canopy-band" }));
  for (let i = 0; i < 18; i++) {
    const cx = 312 + (i % 3) * 32 + ((Math.floor(i / 3) % 2) * 14);
    const cy = 38 + Math.floor(i / 3) * 19;
    svg.append(s("ellipse", { cx, cy, rx: 9, ry: 4, class: "leaf", transform: `rotate(${((i * 47) % 70) - 35} ${cx} ${cy})` }));
  }
  svg.append(wave(58, 22, 7, 40, 300, "w-c"), s("path", { d: "M302 58 l-16 -16 M302 58 l-14 14 M302 58 l-4 20", class: "w-c-scatter" }));
  svg.append(wave(114, 94, 13, 40, 590, "w-l"));
  svg.append(
    s("text", { x: 40, y: 30, class: "guide-lab c" }, t("guide.w_c")),
    s("text", { x: 40, y: 160, class: "guide-lab l" }, t("guide.w_l")),
    s("text", { x: 404, y: 44, class: "guide-lab" }, `← ${t("guide.w_leaves")}`),
  );
  return svg;
}

// The rule made visible: HH across, HV up, the three regions the site's thresholds draw, the
// low-confidence margins, and the three typical echoes (dry, flooded, water) placed on it.
function decisionChart(th, t) {
  const W = 420;
  const H = 300;
  const M = { l: 46, r: 12, t: 12, b: 40 };
  const x = (db) => M.l + ((db + 30) / 35) * (W - M.l - M.r); // HH −30…5 dB
  const y = (db) => H - M.b - ((db + 34) / 30) * (H - M.t - M.b); // HV −34…−4 dB
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "guide-svg decision", role: "img", "aria-label": t("guide.w_chart_aria") });
  // Flooded vegetation: HH above fv_hh and more than fv_ratio dB above HV (below the line HV = HH − ratio).
  const fvPts = [[th.fv_hh_db, -34], [5, -34], [5, Math.min(-4, 5 - th.fv_ratio_db)], [th.fv_hh_db, th.fv_hh_db - th.fv_ratio_db]];
  svg.append(s("path", { d: `M${fvPts.map(([a, b]) => `${x(a)} ${y(b)}`).join("L")}Z`, class: "reg reg-flooded" }));
  svg.append(s("rect", { x: x(-30), y: y(th.ow_hv_db), width: x(th.ow_hh_db) - x(-30), height: y(-34) - y(th.ow_hv_db), class: "reg reg-water" }));
  // Margins: the low-confidence bands either side of each threshold.
  const m = th.margin_db;
  svg.append(
    s("rect", { x: x(th.ow_hh_db - m), y: y(-4), width: x(th.ow_hh_db + m) - x(th.ow_hh_db - m), height: y(-34) - y(-4), class: "band" }),
    s("rect", { x: x(th.fv_hh_db - m), y: y(-4), width: x(th.fv_hh_db + m) - x(th.fv_hh_db - m), height: y(-34) - y(-4), class: "band" }),
  );
  for (const v of [-30, -20, -10, 0]) svg.append(s("text", { x: x(v), y: H - M.b + 16, class: "tick", "text-anchor": "middle" }, fmtNumber(v, 0)));
  for (const v of [-30, -20, -10]) svg.append(s("text", { x: M.l - 6, y: y(v) + 4, class: "tick", "text-anchor": "end" }, fmtNumber(v, 0)));
  svg.append(
    s("text", { x: (W + M.l) / 2, y: H - 6, class: "axis", "text-anchor": "middle" }, t("guide.w_axis_hh")),
    s("text", { x: 12, y: (H - M.b) / 2, class: "axis", transform: `rotate(-90 12 ${(H - M.b) / 2})`, "text-anchor": "middle" }, t("guide.w_axis_hv")),
    s("text", { x: x(4), y: y(-31), class: "reg-lab flooded", "text-anchor": "end" }, t("guide.w_reg_flooded")),
    s("text", { x: x(-29), y: y(-31), class: "reg-lab water" }, t("guide.w_reg_water")),
    s("text", { x: x(-16), y: y(-7), class: "reg-lab dry" }, t("guide.w_reg_dry")),
  );
  // The typical echoes from the panels above.
  for (const [k, hh, hv] of [["dry", -8, -13], ["flooded", -2, -10.5], ["water", -19, -25]]) {
    const left = k === "flooded";
    svg.append(s("circle", { cx: x(hh), cy: y(hv), r: 7, class: `pt pt-${k}` }), s("text", { x: x(hh) + (left ? -11 : 11), y: y(hv) + 4, class: "pt-lab", "text-anchor": left ? "end" : "start" }, t(`physics.panel_${k}`)));
  }
  return svg;
}

// Fire: before and after a fire, the canopy's volume echo (HV) falls while the trunks and the
// ground keep answering in HH, so HH − HV rises; the map calls it burned past the rise threshold.
function fireDiagram(t, riseDb) {
  const svg = s("svg", { viewBox: "0 0 620 200", class: "guide-svg", role: "img", "aria-label": t("guide.f_aria") });
  const scene = (ox, burnt, label) => {
    const g = s("g", { transform: `translate(${ox} 0)` });
    g.append(s("rect", { x: 0, y: 0, width: 190, height: 170, class: "sky" }), s("rect", { x: 0, y: 140, width: 190, height: 30, class: burnt ? "ash" : "soil" }));
    g.append(tree(70, 140, 80, burnt), tree(130, 140, 70, burnt));
    g.append(s("path", { d: "M8 20 l16 -8 l4 8 l-16 8z", class: "sat" }), s("path", { d: burnt ? "M26 22 L64 138 L70 104 L30 26" : "M26 22 L66 66", class: burnt ? "ray ray-l ray-double" : "ray ray-l" }));
    if (!burnt) for (const d of ["M66 66 l-12 -10", "M66 66 l12 -12", "M66 66 l-2 14"]) g.append(s("path", { d, class: "ray ray-scatter" }));
    g.append(s("text", { x: 95, y: 190, class: "panel-label", "text-anchor": "middle" }, label));
    return g;
  };
  svg.append(scene(0, false, t("guide.f_before")), scene(205, true, t("guide.f_after")));
  // The gauge: HH − HV before and after, with the rise that counts as burned.
  const g = s("g", { transform: "translate(420 10)" });
  const base = 120;
  g.append(s("line", { x1: 0, x2: 180, y1: base, y2: base, class: "axis-line" }));
  g.append(s("rect", { x: 30, y: base - 50, width: 40, height: 50, class: "bar-before" }), s("rect", { x: 110, y: base - 50 - riseDb * 26, width: 40, height: 50 + riseDb * 26, class: "bar-after" }));
  g.append(s("path", { d: `M100 ${base - 50} h60 M160 ${base - 50} v${-riseDb * 26}`, class: "rise" }));
  g.append(
    s("text", { x: 50, y: base + 16, class: "tick", "text-anchor": "middle" }, t("guide.f_before")),
    s("text", { x: 130, y: base + 16, class: "tick", "text-anchor": "middle" }, t("guide.f_after")),
    s("text", { x: 90, y: base - 70 - riseDb * 26, class: "guide-lab f", "text-anchor": "middle" }, t("guide.f_rise", { db: fmtNumber(riseDb, 1) })),
    s("text", { x: 90, y: 168, class: "axis", "text-anchor": "middle" }, t("guide.f_axis")),
  );
  svg.append(g);
  return svg;
}

// Ground: two passes 12 days apart; the ground moved, the path to the radar changed, and every
// 12 cm of change in the round trip turns the phase once round: a fringe.
function groundDiagram(t) {
  const svg = s("svg", { viewBox: "0 0 620 200", class: "guide-svg", role: "img", "aria-label": t("guide.g_aria") });
  svg.append(s("path", { d: "M10 150 Q160 150 230 150 T420 160 T610 150", class: "terrain" }), s("path", { d: "M10 160 Q160 160 230 160 T420 176 T610 160", class: "terrain moved" }));
  svg.append(s("path", { d: "M70 20 l18 -9 l5 9 l-18 9z", class: "sat" }), s("path", { d: "M110 30 l18 -9 l5 9 l-18 9z", class: "sat sat-2" }));
  svg.append(s("path", { d: "M84 26 L330 154", class: "ray ray-l" }), s("path", { d: "M124 34 L330 170", class: "ray ray-l ray-2" }));
  // Fringes: a colour cycle every half wavelength (about 12 cm of line-of-sight motion).
  for (let i = 0; i < 6; i++) svg.append(s("rect", { x: 440 + i * 26, y: 20, width: 26, height: 22, fill: `hsl(${i * 60} 70% 55%)`, opacity: 0.85 }));
  svg.append(
    s("text", { x: 518, y: 60, class: "guide-lab", "text-anchor": "middle" }, t("guide.g_fringe")),
    s("text", { x: 40, y: 14, class: "guide-lab" }, t("guide.g_pass1")),
    s("text", { x: 142, y: 22, class: "guide-lab" }, t("guide.g_pass2")),
    s("text", { x: 430, y: 196, class: "guide-lab g", "text-anchor": "middle" }, t("guide.g_moved")),
  );
  return svg;
}

// Ice: the same crevasses in two images a while apart; their shift over the time between is the
// speed of the ice.
function iceDiagram(t) {
  const svg = s("svg", { viewBox: "0 0 620 190", class: "guide-svg", role: "img", "aria-label": t("guide.i_aria") });
  const CREV = [[40, 30], [90, 70], [140, 40], [60, 100], [150, 95], [110, 118]];
  const field = (ox, shift, label) => {
    const g = s("g", { transform: `translate(${ox} 10)` });
    g.append(s("rect", { x: 0, y: 0, width: 200, height: 140, rx: 8, class: "ice" }));
    for (const [cx, cy] of CREV) {
      if (shift) g.append(s("path", { d: `M${cx - 12} ${cy - 6} q12 8 24 0`, class: "crevasse ghost" }), s("path", { d: `M${cx + 14} ${cy - 2} h${shift - 26}`, class: "drift" }));
      g.append(s("path", { d: `M${cx + shift - 12} ${cy - 6} q12 8 24 0 M${cx + shift - 8} ${cy + 4} q8 6 16 0`, class: "crevasse" }));
    }
    g.append(s("text", { x: 100, y: 164, class: "panel-label", "text-anchor": "middle" }, label));
    return g;
  };
  svg.append(field(20, 0, t("guide.i_t1")), field(400, 30, t("guide.i_t2")));
  svg.append(s("path", { d: "M250 80 h110", class: "arrow" }), s("path", { d: "M352 73 l9 7 l-9 7", class: "arrow" }));
  svg.append(s("text", { x: 310, y: 64, class: "guide-lab i", "text-anchor": "middle" }, t("guide.i_shift")));
  return svg;
}

const beat = (n, title, ...body) =>
  h("li", { class: "beat" }, h("span", { class: "beat-n", text: String(n), "aria-hidden": "true" }), h("div", { class: "beat-body" }, h("h3", { text: title }), ...body));
const checkCard = (ok, title, text) => h("li", { class: `check-card ${ok ? "ok" : "warn"}` }, rdIcon(ok ? "check" : "alert"), h("div", {}, h("b", { text: title }), h("span", { text })));
const limits = (keys, t) => h("ul", { class: "limit-cards" }, ...keys.map((k) => h("li", { text: t(k) })));

export function init({ store, t, root }) {
  const open = h("button", { type: "button", class: "btn icon-label-btn physics-open", title: t("physics.open") }, icon("info"), h("span", { class: "btn-label", text: t("physics.open") }));
  const close = h("button", { type: "button", class: "btn", text: t("common.close") });
  const tabs = h("div", { class: "guide-tabs", role: "tablist", "aria-label": t("guide.chapters") });
  const body = h("div", { class: "guide-body" });
  const dialog = h(
    "dialog",
    { class: "physics-dialog guide", "aria-labelledby": "physics-title" },
    h("div", { class: "dialog-inner" }, h("div", { class: "dialog-head" }, h("div", {}, h("p", { class: "guide-kicker", text: t("guide.kicker") }), h("h2", { id: "physics-title", text: t("physics.open") })), close), tabs, body),
  );
  root.append(open, dialog);
  let chapter = "water";

  const used = (u) => SOURCES.filter((x) => x.used.includes(u));

  function water(st) {
    const site = st.site;
    const th = st.scientist?.enabled ? st.scientist.thresholds : site?.summary.thresholds;
    const v = site?.summary.validation ?? {};
    const checks = [];
    if (v.gauge) checks.push(checkCard(v.gauge.r >= 0.6, t("guide.w_c_gauge"), t("guide.w_c_gauge_d", { name: v.gauge.name, r: fmtNumber(v.gauge.r, 2), n: fmtNumber(v.gauge.n, 0) })));
    if (v.swot?.[0]?.series?.length) checks.push(checkCard(true, t("guide.w_c_swot"), t("guide.w_c_swot_d", { n: fmtNumber(v.swot[0].series.length, 0) })));
    const cal = v.calibration?.flooded_veg;
    if (cal?.held_out_after) checks.push(checkCard(cal.held_out_after >= 0.7, t("guide.w_c_cal"), t("guide.w_c_cal_d", { pct: fmtNumber(100 * cal.held_out_after, 0) })));
    checks.push(checkCard(true, t("guide.w_c_cband"), t("guide.w_c_cband_d")));
    return [
      beat(1, t("guide.q"), h("p", { class: "guide-q", text: t("guide.w_q") }), h("p", { text: t("physics.lede") })),
      beat(2, t("guide.physics"), diagram(t), h("div", { class: "sig-grid" }, ...["dry", "flooded", "water"].map((k) => h("div", { class: `sig sig-${k}` }, h("h4", { text: t(`physics.sig_${k}_title`) }), h("p", { text: t(`physics.sig_${k}`) })))), h("h4", { class: "guide-sub", text: t("physics.cband_title") }), wavelengths(t), h("p", { text: t("physics.cband") })),
      beat(
        3,
        t("guide.rule"),
        th ? decisionChart(th, t) : null,
        th
          ? h(
              "ul",
              { class: "rule-chips" },
              h("li", { class: "water", text: t("physics.rule_water", { hh: fmtNumber(th.ow_hh_db, 2), hv: fmtNumber(th.ow_hv_db, 2) }) }),
              h("li", { class: "flooded", text: t("physics.rule_flooded", { hh: fmtNumber(th.fv_hh_db, 2), ratio: fmtNumber(th.fv_ratio_db, 2) }) }),
              h("li", { text: t("physics.rule_built") }),
              h("li", { class: "band", text: t("physics.rule_low", { margin: fmtNumber(th.margin_db, 2), spread: fmtNumber(th.max_spread_db, 2) }) }),
            )
          : h("p", { class: "muted", text: t("guide.w_pick_site") }),
        h("p", { class: "muted", text: t("physics.confidence") }),
      ),
      beat(4, t("guide.checks"), h("ul", { class: "check-cards" }, ...checks)),
      beat(5, t("guide.limits"), limits([1, 2, 3, 4, 5, 6, 7, 8].map((i) => `physics.limit_${i}`), t)),
      sourceFlags(site?.summary.sources?.length ? site.summary.sources : used("water"), t),
    ];
  }

  function fire(st) {
    const burn = st.site?.summary.products?.burn;
    const rise = burn?.rise_db ?? 1;
    const vn = (burn?.checks ?? []).find((c) => c.dates);
    const checks = [checkCard(true, t("guide.f_c_ref"), t("guide.f_c_ref_d"))];
    if (vn) checks.push(checkCard(true, t("guide.f_c_dates"), t("guide.f_c_dates_d", { pct: fmtNumber(vn.dates.within_pct, 0), lag: fmtNumber(vn.dates.median_lag_days, 0) })));
    checks.push(checkCard(true, t("guide.f_c_held"), t("guide.f_c_held_d")));
    return [
      beat(1, t("guide.q"), h("p", { class: "guide-q", text: t("guide.f_q") })),
      beat(2, t("guide.physics"), fireDiagram(t, rise), h("p", { text: t("guide.f_phys") })),
      beat(3, t("guide.rule"), h("ul", { class: "rule-chips" }, h("li", { class: "fire", text: t("guide.f_rule", { db: fmtNumber(rise, 1) }) }), h("li", { text: t("guide.f_rule2") }))),
      beat(4, t("guide.checks"), h("ul", { class: "check-cards" }, ...checks)),
      beat(5, t("guide.limits"), limits(["burn.note", "physics.limit_8", "guide.f_lim3"], t)),
      sourceFlags(used("fire"), t),
    ];
  }

  function ground() {
    return [
      beat(1, t("guide.q"), h("p", { class: "guide-q", text: t("guide.g_q") })),
      beat(2, t("guide.physics"), groundDiagram(t), h("p", { text: t("guide.g_phys") })),
      beat(3, t("guide.rule"), h("ul", { class: "rule-chips" }, h("li", { class: "ground", text: t("guide.g_rule1") }), h("li", { text: t("guide.g_rule2") }))),
      beat(4, t("guide.checks"), h("ul", { class: "check-cards" }, checkCard(true, t("guide.g_c_jpl"), t("guide.g_c_jpl_d")), checkCard(true, t("guide.g_c_usgs"), t("guide.g_c_usgs_d")), checkCard(true, t("guide.g_c_gnss"), t("guide.g_c_gnss_d")))),
      beat(5, t("guide.limits"), limits(["guide.g_lim1", "guide.g_lim2", "guide.g_lim3"], t)),
      sourceFlags(used("ground"), t),
    ];
  }

  function ice() {
    return [
      beat(1, t("guide.q"), h("p", { class: "guide-q", text: t("guide.i_q") })),
      beat(2, t("guide.physics"), iceDiagram(t), h("p", { text: t("guide.i_phys") })),
      beat(3, t("guide.rule"), h("ul", { class: "rule-chips" }, h("li", { class: "ice", text: t("guide.i_rule1") }), h("li", { text: t("guide.i_rule2") }))),
      beat(4, t("guide.checks"), h("ul", { class: "check-cards" }, checkCard(true, t("guide.i_c_pub"), t("guide.i_c_pub_d")), checkCard(false, t("guide.i_c_nisar"), t("guide.i_c_nisar_d")))),
      beat(5, t("guide.limits"), limits(["guide.i_lim1", "guide.i_lim2"], t)),
      sourceFlags(used("ice"), t),
    ];
  }

  const RENDER = { water, fire, ground, ice };
  function render() {
    const st = store.get();
    tabs.replaceChildren(
      ...CHAPTERS.map((c) => {
        const b = h("button", { type: "button", role: "tab", "aria-selected": String(c === chapter), tabIndex: c === chapter ? 0 : -1, dataset: { chapter: c } }, h("span", { class: "guide-tab-n", text: t(`guide.ch_${c}`) }), h("span", { class: "guide-tab-q", text: t(`guide.ch_${c}_q`) }));
        b.addEventListener("click", () => {
          chapter = c;
          render();
        });
        return b;
      }),
    );
    body.replaceChildren(h("ol", { class: "beats", dataset: { chapter } }, ...RENDER[chapter](st)));
    body.scrollTop = 0;
  }
  // The chapter of the mode in use: a fire site opens on fire, Ground on ground, Ice on ice.
  const chapterOf = (st) => (st.mode === "motion" ? "ground" : st.mode === "ice" ? "ice" : st.site?.summary.site?.kind === "fire" ? "fire" : "water");
  tabs.addEventListener("keydown", (ev) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[ev.key];
    if (!step) return;
    chapter = CHAPTERS[(CHAPTERS.indexOf(chapter) + step + CHAPTERS.length) % CHAPTERS.length];
    render();
    tabs.querySelector('[aria-selected="true"]')?.focus();
  });

  open.addEventListener("click", () => {
    chapter = chapterOf(store.get());
    render();
    dialog.showModal();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) dialog.close();
  });
  watch(store, ["site", "scientist", "mode"], () => {
    if (dialog.open) render();
  });
}
