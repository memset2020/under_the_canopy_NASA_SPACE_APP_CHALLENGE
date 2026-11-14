// F02 hidden-flood reveal: photo → C-band → NISAR, with a swipe on the map and a counter.
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtDate, fmtNumber } from "./i18n.js";
import { setFacts, setLead, strongNumbers } from "./readable.js";

export const id = "compare";
export const slot = "sidebar";

const COUNT_MS = 700;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function nearestMatchedPass(passes, from) {
  let best = -1;
  passes.forEach((p, i) => {
    if (p.hidden_from_cband_km2 === null) return;
    if (best < 0 || Math.abs(i - from) < Math.abs(best - from)) best = i;
  });
  return best;
}

export function init({ store, map, t, root, dock }) {
  const modes = [
    { mode: "optical", key: "compare.mode_optical" },
    { mode: "cband", key: "compare.mode_cband" },
    { mode: "off", key: "compare.mode_nisar" },
  ];
  const seg = h(
    "div",
    { class: "seg seg-wide", role: "group", "aria-label": t("compare.modes") },
    modes.map(({ mode, key }) =>
      h("button", { type: "button", class: "seg-btn", dataset: { mode }, onclick: () => store.set({ compare: mode }) }, t(key)),
    ),
  );
  const hiddenNum = h("span", { class: "reveal-number" });
  const sentence = h("p", { class: "reveal-sentence", "aria-live": "polite" });
  // Each comparison on its own row (readable.js, D-093): NISAR and C-band, the camera, the usual river.
  const detail = h("ul", { class: "reveal-detail rd-facts" });
  const jump = h("button", { type: "button", class: "btn", hidden: true });
  // Detection ladder: how much water each kind of satellite saw on this pass.
  // The NISAR bar splits into what C-band also saw (blue) and what only L-band found (amber).
  // The sentence below says the same in words for screen readers.
  const stats = h("div", { class: "ladder", hidden: true, "aria-hidden": "true" });
  root.append(
    h("h2", { text: t("compare.title") }),
    h("div", { class: "reveal" }, hiddenNum, sentence),
    stats,
    detail,
    jump,
  );
  // The lens is a map choice: it lives in the map panel's Compare section (dock.js).
  const controls = h("div", { class: "compare-controls" }, h("p", { class: "dock-hint", text: t("compare.modes") }), seg);
  dock.place("compare", controls);
  const rung = (label, value, parts) =>
    h(
      "div",
      { class: "rung" },
      h("span", { class: "rung-label", text: label }),
      h("span", { class: "rung-bar" }, parts.map(([cls, pct]) => h("span", { class: cls, style: `width:${pct}%` }))),
      h("span", { class: "rung-value", text: value }),
    );

  // Map side: the comparison image in the clipped "compare" pane.
  const leftImg = h("img", { class: "overlay-compare", alt: "", draggable: "false" });
  const handle = h(
    "div",
    {
      class: "swipe",
      role: "slider",
      tabindex: "0",
      "aria-label": t("compare.handle"),
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      dataset: { mapControl: "" },
    },
    h("span", { class: "swipe-tag swipe-tag-left" }),
    h("span", { class: "swipe-grip", "aria-hidden": "true" }),
    h("span", { class: "swipe-tag swipe-tag-right", text: t("compare.tag_nisar") }),
  );
  map.container.parentElement.append(handle);
  // Lens: a round window that follows the pointer (pointer convenience; the swipe stays
  // the keyboard control).
  const ringLabel = h("span", { class: "lens-label" });
  const ring = h("div", { class: "lens-ring", "aria-hidden": "true", hidden: true }, ringLabel);
  map.container.parentElement.append(ring);
  const lensBtn = h("button", { type: "button", class: "btn btn-small lens-toggle", "aria-pressed": "false", text: t("compare.lens") });
  controls.append(lensBtn);
  let split = 0.5;
  let counter = 0;
  let lens = false;
  let hasLeft = false;
  let lensAt = null;
  const LENS_R = 110;

  // The NISAR layers under the comparison are cut away where the comparison shows, so both
  // sides sit on the same basemap (a dark backdrop on one side exaggerated the difference).
  const underneath = () => map.panes.base.querySelectorAll(".overlay-class, .overlay-radar, .overlay-usual, .overlay-scientist, .overlay-nodata");

  function cutUnderneath(fn) {
    for (const el of underneath()) {
      const left = parseFloat(el.style.left) || 0;
      const top = parseFloat(el.style.top) || 0;
      fn(el, left, top);
    }
  }

  function placeHandle() {
    const [w, hgt] = map.size();
    handle.hidden = !hasLeft || lens;
    ring.hidden = !hasLeft || !lens;
    if (!hasLeft) {
      cutUnderneath((el) => {
        el.style.clipPath = "";
        el.style.maskImage = el.style.webkitMaskImage = "";
      });
      return;
    }
    if (lens) {
      const [x, y] = lensAt ?? [w / 2, hgt / 2];
      map.panes.compare.style.clipPath = `circle(${LENS_R}px at ${x}px ${y}px)`;
      Object.assign(ring.style, { left: `${x - LENS_R}px`, top: `${y - LENS_R}px`, width: `${2 * LENS_R}px`, height: `${2 * LENS_R}px` });
      cutUnderneath((el, left, top) => {
        el.style.clipPath = "";
        const hole = `radial-gradient(circle ${LENS_R}px at ${x - left}px ${y - top}px, transparent ${LENS_R - 1}px, #000 ${LENS_R}px)`;
        el.style.maskImage = el.style.webkitMaskImage = hole;
      });
      return;
    }
    const x = Math.round(split * w);
    handle.style.left = `${x}px`;
    handle.setAttribute("aria-valuenow", String(Math.round(split * 100)));
    map.panes.compare.style.clipPath = `inset(0 ${w - x}px 0 0)`;
    cutUnderneath((el, left) => {
      el.style.maskImage = el.style.webkitMaskImage = "";
      el.style.clipPath = `inset(0 0 0 ${Math.max(0, x - left)}px)`;
    });
  }
  map.on("move", placeHandle);
  map.container.addEventListener("pointermove", (ev) => {
    if (!lens) return;
    const r = map.container.getBoundingClientRect();
    lensAt = [ev.clientX - r.left, ev.clientY - r.top];
    placeHandle();
  });
  lensBtn.addEventListener("click", () => {
    lens = !lens;
    lensBtn.setAttribute("aria-pressed", String(lens));
    placeHandle();
  });

  function dragTo(clientX) {
    const r = map.container.getBoundingClientRect();
    split = Math.min(0.98, Math.max(0.02, (clientX - r.left) / r.width));
    placeHandle();
  }
  handle.addEventListener("pointerdown", (ev) => {
    handle.setPointerCapture(ev.pointerId);
    const move = (e) => dragTo(e.clientX);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    ev.stopPropagation();
  });
  handle.addEventListener("keydown", (ev) => {
    const d = { ArrowLeft: -0.05, ArrowRight: 0.05, Home: -1, End: 1 }[ev.key];
    if (d === undefined) return;
    ev.preventDefault();
    split = Math.min(0.98, Math.max(0.02, split + d));
    placeHandle();
  });

  function countUp(from, to) {
    cancelAnimationFrame(counter);
    if (reducedMotion() || from === to) {
      hiddenNum.textContent = fmtNumber(to);
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / COUNT_MS);
      hiddenNum.textContent = fmtNumber(from + (to - from) * (1 - (1 - k) ** 3));
      if (k < 1) counter = requestAnimationFrame(step);
    };
    counter = requestAnimationFrame(step);
  }

  let lastShown = null;
  watch(store, ["site", "passIndex", "compare"], ({ site, passIndex, compare }, _prev, changed) => {
    root.hidden = !site;
    if (!site) return;
    const s = site.summary;
    const pass = s.passes[passIndex];
    const optical = s.products.optical;
    for (const b of seg.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(b.dataset.mode === compare));
      if (b.dataset.mode === "optical") b.disabled = !optical;
    }

    // Map: the left side of the swipe shows the photo or the C-band map.
    const mode = compare === "optical" && !optical ? "off" : compare;
    const leftSrc = mode === "optical" ? optical.png : mode === "cband" ? pass.cband_png : null;
    if (leftSrc) {
      leftImg.src = site.url(leftSrc);
      map.addOverlay("compare", leftImg, s.grid.bounds, "compare");
      handle.querySelector(".swipe-tag-left").textContent = t(
        mode === "optical" ? "compare.tag_optical" : "compare.tag_cband",
      );
      ringLabel.textContent = t(mode === "optical" ? "compare.tag_optical" : "compare.tag_cband");
    } else {
      map.removeOverlay("compare");
    }
    hasLeft = Boolean(leftSrc);
    lensBtn.hidden = !hasLeft;
    placeHandle();

    // Counter: what C-band missed on this pass.
    const hidden = pass.hidden_from_cband_km2;
    jump.hidden = true;
    if (hidden === null) {
      hiddenNum.textContent = "";
      hiddenNum.hidden = true;
      setLead(sentence, t("compare.no_cband", { date: fmtDate(pass.date) }));
      const j = nearestMatchedPass(s.passes, passIndex);
      if (j >= 0) {
        jump.hidden = false;
        jump.textContent = t("compare.jump", { date: fmtDate(s.passes[j].date) });
        jump.onclick = () => store.set({ passIndex: j, playing: false });
      }
      detail.replaceChildren();
      stats.hidden = true;
      lastShown = null;
      return;
    }
    const cbandSaw = pass.flooded_km2 - hidden;
    const from = changed.includes("compare") && mode === "off" ? 0 : (lastShown ?? hidden);
    countUp(store.get().playing ? hidden : from, hidden);
    lastShown = hidden;
    hiddenNum.hidden = false;
    setLead(sentence, t("compare.sentence", { date: fmtDate(pass.date) }));
    const low = pass.hidden_low_conf_km2;
    if (low !== null && low !== undefined && low >= 0.05) {
      sentence.append(" ", ...strongNumbers(t("compare.low_conf", { km2: fmtNumber(low) })));
    }
    const km2 = (v) => t("compare.km2", { v: fmtNumber(v) });
    const hasOptical = pass.optical_water_km2 !== null && pass.optical_water_km2 !== undefined;
    const top = Math.max(pass.flooded_km2, hasOptical ? pass.optical_water_km2 : 0, 1e-9);
    const pct = (v) => (100 * Math.max(v, 0)) / top;
    const rungs = [];
    if (hasOptical) {
      const blind = pass.optical_clear_fraction < 0.05;
      rungs.push(
        rung(
          t("compare.stat_optical", { date: fmtDate(pass.optical_date, "short") }),
          blind ? t("compare.stat_cloud") : km2(pass.optical_water_km2),
          [[blind ? "seg-cloud" : "seg-optical", blind ? 100 : pct(pass.optical_water_km2)]],
        ),
      );
    }
    rungs.push(
      rung(t("compare.stat_cband", { date: fmtDate(pass.cband_date, "short") }), km2(cbandSaw), [["seg-cband", pct(cbandSaw)]]),
      rung(t("compare.stat_nisar"), km2(pass.flooded_km2), [["seg-water", pct(cbandSaw)], ["seg-hidden", pct(hidden)]]),
    );
    stats.replaceChildren(...rungs);
    stats.hidden = false;
    const rows = [
      ["satellite", t("compare.detail", {
        nisar: fmtNumber(pass.flooded_km2),
        cband: fmtNumber(cbandSaw),
        share: fmtNumber((100 * hidden) / Math.max(pass.flooded_km2, 1e-9), 0),
        cdate: fmtDate(pass.cband_date),
      })],
    ];
    let opticalText = "";
    if (pass.optical_water_km2 !== null && pass.optical_water_km2 !== undefined) {
      // Under ~5 % clear sky the optical water area is meaningless, not zero.
      const blind = pass.optical_clear_fraction < 0.05;
      opticalText = t(blind ? "compare.optical_blind" : "compare.optical_saw", {
        km2: fmtNumber(pass.optical_water_km2),
        clear: fmtNumber(pass.optical_clear_fraction * 100, 0),
        date: fmtDate(pass.optical_date),
      });
    }
    const prevOptical = passIndex > 0 ? s.passes[passIndex - 1].optical_date : null;
    if (pass.optical_date && pass.optical_date === prevOptical) {
      opticalText += ` ${t("compare.optical_same", { date: fmtDate(pass.optical_date) })}`;
    }
    if (pass.optical_clear_fraction >= 0.05 && pass.optical_water_km2 > pass.flooded_km2 * 1.15) {
      opticalText += ` ${t("compare.optical_more")}`;
    }
    if (mode === "optical") {
      opticalText += ` ${t("compare.optical_note", {
        date: fmtDate(optical.date),
        cloud: fmtNumber(optical.cloud_fraction * 100, 0),
      })}`;
    }
    if (opticalText) rows.push(["cloud", opticalText.trim()]);
    if (pass.usual_water_km2 !== null && pass.usual_water_km2 !== undefined) {
      rows.push(["water", t("compare.usual", { km2: fmtNumber(pass.usual_water_km2) })]);
    }
    setFacts(detail, rows);
  });
}
