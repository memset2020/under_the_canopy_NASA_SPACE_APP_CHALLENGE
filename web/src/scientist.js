// F16 scientist mode: move the thresholds and watch the map reclassify in the browser.
// Uses rules.js on the same quantised stack the pipeline classified, so the defaults
// reproduce the shipped map exactly.
import { h } from "./svg.js";
import { watch } from "./state.js";
import { fmtNumber } from "./i18n.js";
import { CLASS, THRESHOLD_KEYS, classifyGrid } from "./rules.js";
import { note } from "./readable.js";

export const id = "scientist";
export const slot = "sidebar";

// Mirrors pipeline/canopy/config.py PALETTE_RGBA (docs/06 tokens).
const PALETTE = {
  [CLASS.OPEN_WATER]: [0, 114, 178, 220],
  [CLASS.FLOODED_VEG]: [230, 159, 0, 235],
  [CLASS.EXCLUDED]: [120, 120, 120, 110],
};
const RANGES = {
  ow_hh_db: [-26, -10],
  ow_hv_db: [-32, -14],
  fv_hh_db: [-12, 2],
  fv_ratio_db: [2, 14],
  margin_db: [0, 3],
  max_spread_db: [1, 8],
};

export function init({ store, map, t, root }) {
  const toggle = h("button", { type: "button", class: "btn", "aria-pressed": "false", text: t("scientist.toggle") });
  const intro = h("p", { class: "muted small", text: t("scientist.intro") });
  const sliders = h("div", { class: "sliders" });
  const readout = h("p", { class: "scientist-readout", "aria-live": "polite" });
  const reset = h("button", { type: "button", class: "btn btn-small", text: t("scientist.reset") });
  const panel = h("div", { class: "scientist-panel", hidden: true }, sliders, readout, reset, note("info", t("scientist.note")));
  root.append(h("h2", { text: t("scientist.title") }), intro, toggle, panel);

  const canvas = h("canvas", { class: "overlay-scientist" });
  const inputs = {};
  for (const key of THRESHOLD_KEYS) {
    const [lo, hi] = RANGES[key];
    const out = h("output", { for: `thr-${key}` });
    const input = h("input", { type: "range", id: `thr-${key}`, min: lo, max: hi, step: "0.25" });
    input.addEventListener("input", () => {
      const sci = store.get().scientist;
      store.set({ scientist: { ...sci, thresholds: { ...sci.thresholds, [key]: Number(input.value) } } });
    });
    inputs[key] = { input, out };
    sliders.append(
      h("div", { class: "slider-row" }, h("label", { for: `thr-${key}`, text: t(`scientist.${key}`) }), out, input),
    );
  }

  toggle.addEventListener("click", () => {
    const sci = store.get().scientist;
    store.set({ scientist: { ...sci, enabled: !sci.enabled }, view: "flood" });
  });
  reset.addEventListener("click", () => {
    const sci = store.get().scientist;
    store.set({ scientist: { ...sci, thresholds: { ...store.get().site.summary.thresholds } } });
  });

  let frame = 0;
  function render() {
    frame = 0;
    const { site, passIndex, scientist } = store.get();
    if (!site || !scientist.enabled) return;
    const W = site.width;
    const H = site.height;
    canvas.width = W;
    canvas.height = H;
    const L = site.layers;
    const { cls, conf } = classifyGrid(
      {
        hhQ: site.passPlane("hh", passIndex),
        hvQ: site.passPlane("hv", passIndex),
        spQ: site.passPlane("hh_spread", passIndex),
        veg: site.staticPlane("veg"),
      },
      { hh: L.hh, hv: L.hv, hh_spread: L.hh_spread },
      scientist.thresholds,
    );
    const ctx2d = canvas.getContext("2d");
    const img = ctx2d.createImageData(W, H);
    for (let i = 0; i < cls.length; i += 1) {
      const rgba = PALETTE[cls[i]];
      if (!rgba) continue;
      const r = Math.floor(i / W);
      const c = i % W;
      if (conf[i] === 0 && (r + c) % 4 < 2) continue; // same hatch as the shipped PNGs
      img.data.set(rgba, i * 4);
    }
    ctx2d.putImageData(img, 0, 0);

    const fv = site.areaKm2((i) => cls[i] === CLASS.FLOODED_VEG);
    const ow = site.areaKm2((i) => cls[i] === CLASS.OPEN_WATER);
    const shipped = site.summary.passes[passIndex];
    // Compare at the published precision (0.001 km²) so identical classes read +0.0.
    const diffKm2 = Math.round(fv * 1000) / 1000 - shipped.flooded_veg_km2;
    const sign = diffKm2 < -0.05 ? "−" : "+";
    readout.textContent = t("scientist.readout", {
      fv: fmtNumber(fv),
      ow: fmtNumber(ow),
      fv0: fmtNumber(shipped.flooded_veg_km2),
      diff: `${sign}${fmtNumber(Math.abs(diffKm2))}`,
    });
  }

  watch(store, ["site", "scientist", "passIndex"], ({ site, scientist }) => {
    root.hidden = !site;
    const on = Boolean(site && scientist.enabled);
    toggle.setAttribute("aria-pressed", String(on));
    toggle.textContent = t(on ? "scientist.toggle_off" : "scientist.toggle");
    panel.hidden = !on;
    document.body.classList.toggle("is-scientist", on);
    if (!on) {
      map.removeOverlay("scientist");
      return;
    }
    if (!canvas.isConnected) map.addOverlay("scientist", canvas, site.summary.grid.bounds);
    for (const key of THRESHOLD_KEYS) {
      inputs[key].input.value = String(scientist.thresholds[key]);
      inputs[key].out.value = fmtNumber(scientist.thresholds[key], 2);
    }
    if (!frame) frame = requestAnimationFrame(render);
  });
  watch(store, ["site"], ({ site }) => {
    if (site && store.get().scientist.enabled) map.addOverlay("scientist", canvas, site.summary.grid.bounds);
  });
}
