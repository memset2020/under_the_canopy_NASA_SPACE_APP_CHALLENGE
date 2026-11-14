// Ground that moved (motion.js, motionmaps.js, motionprofile.js, motionchecks.js): the pure
// parts, on inputs with known answers (docs/10 D-082).
import { test } from "node:test";
import assert from "node:assert/strict";
import { datedPlanes, layerChoices, planeValue, resolveLayer, scaleWords, seriesAt, siblings } from "../../src/motion.js";
import { autoRange, cellsNear, crossingKm, fitLine, hillshade, histogram, layerData, lut, niceCeil, paint, paintHatch, quantile, swathProfile } from "../../src/motionmaps.js";
import { modelOf } from "../../src/motionprofile.js";
import { heldOut, residualBySide } from "../../src/motionchecks.js";

// A 2 × 2 grid as canopy/motion.py writes it (int16, millimetres unless a plane has a scale).
function quake() {
  const doc = {
    kind: "earthquake",
    grid: { width: 2, height: 2, bounds: [0, 0, 2, 2], res_m: 1000 },
    nodata: -32768,
    scale_cm: 0.1,
    geometries: [{ key: "162A", track: 162, direction: "ascending", measured_pct: 57 }, { key: "126D", track: 126, direction: "descending", measured_pct: 39 }],
    planes: [
      { id: "los_126D", kind: "los", geometry: "126D", unit: "cm" },
      { id: "los_162A", kind: "los", geometry: "162A", unit: "cm" },
      { id: "east", kind: "east", geometry: null, unit: "cm" },
      { id: "up", kind: "up", geometry: null, unit: "cm" },
      { id: "coh_162A", kind: "coherence", geometry: "162A", unit: "1", scale: 0.001 },
      { id: "model_los_126D", kind: "model_los", geometry: "126D", unit: "cm" },
      { id: "model_los_162A", kind: "model_los", geometry: "162A", unit: "cm" },
      { id: "model_east", kind: "model_east", geometry: null, unit: "cm" },
      { id: "model_up", kind: "model_up", geometry: null, unit: "cm" },
    ],
  };
  const view = Int16Array.from([
    123, -4560, -32768, 0, // los_126D
    1, 2, 3, 4, // los_162A
    600, 0, 0, 0, // east
    -10, 0, 0, 0, // up
    500, 1000, -32768, 250, // coherence × 1000
    100, -4000, 0, 0, // model_los_126D
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  return { doc, view };
}

function sinking() {
  const dates = ["2026-05-10", "2026-05-22", "2026-06-03"];
  const doc = {
    kind: "subsidence",
    grid: { width: 2, height: 1, bounds: [0, 0, 2, 1], res_m: 100 },
    nodata: -32768,
    scale_cm: 0.1,
    geometries: [{ key: "019A", track: 19, direction: "ascending", measured_pct: 80 }],
    planes: [
      { id: "rate_up", kind: "rate_up", geometry: null, unit: "cm/yr" },
      { id: "rate_019A", kind: "rate_los", geometry: "019A", unit: "cm/yr" },
      { id: "sigma_rate_019A", kind: "sigma", geometry: "019A", of: "rate_019A", unit: "cm/yr" },
      { id: "sigma_rate_up", kind: "sigma", geometry: null, of: "rate_up", unit: "cm/yr" },
      ...dates.map((d) => ({ id: `cum_019A_${d}`, kind: "cum", geometry: "019A", date: d, unit: "cm" })),
    ],
  };
  const view = Int16Array.from([-250, 10, -200, 0, 20, 30, 15, 20, 0, 0, -8, -32768, -16, -32768]);
  return { doc, view };
}

test("plane values decode millimetres, a plane's own scale, and keep no data as null", () => {
  const { doc, view } = quake();
  assert.equal(planeValue(view, doc, 0, 0), 12.3);
  assert.equal(planeValue(view, doc, 0, 1), -456);
  assert.equal(planeValue(view, doc, 0, 2), null);
  assert.equal(planeValue(view, doc, 4, 1), 1); // coherence 1000 × 0.001
});

test("an earthquake offers motion, then the model, then radar minus model, then quality", () => {
  const c = layerChoices(quake().doc);
  assert.deepEqual([...new Set(c.map((x) => x.group))], ["motion.group_motion", "motion.group_model", "motion.group_resid", "motion.group_quality"]);
  assert.deepEqual(c.filter((x) => x.group === "motion.group_motion").map((x) => x.id), ["east", "up", "los_162A", "los_126D"]); // most measured first
  assert.ok(c.some((x) => x.id === "resid:los_126D:model_los_126D"));
});

test("a residual is radar minus model, cell by cell, with no data kept out", () => {
  const { doc, view } = quake();
  const r = layerData(doc, view, "resid:los_126D:model_los_126D");
  assert.equal(r.kind, "resid");
  assert.equal(r.base, "los");
  assert.ok(Math.abs(r.values[0] - (12.3 - 10)) < 1e-4);
  assert.ok(Math.abs(r.values[1] - (-456 + 400)) < 1e-3);
  assert.ok(Number.isNaN(r.values[2]));
  assert.equal(modelOf(doc, "los_126D"), "model_los_126D");
  assert.equal(modelOf(doc, "east"), "model_east");
  assert.equal(modelOf(doc, "coh_162A"), null);
});

test("a subsidence time series resolves to the date on the slider and shares one group", () => {
  const { doc, view } = sinking();
  const c = layerChoices(doc);
  assert.deepEqual(c.map((x) => x.id), ["rate_up", "rate_019A", "cum:019A", "sigma_rate_019A", "sigma_rate_up"]);
  assert.equal(c.find((x) => x.id === "sigma_rate_up").key, "motion.layer_sigma_up");
  assert.equal(resolveLayer(doc, "cum:019A", null), "cum_019A_2026-06-03"); // the last date by default
  assert.equal(resolveLayer(doc, "cum:019A", 0), "cum_019A_2026-05-10");
  assert.equal(resolveLayer(doc, "rate_up", 1), "rate_up");
  assert.equal(datedPlanes(doc, "019A").length, 3);
  assert.deepEqual(siblings(doc, "cum:019A").map((x) => x.dateIdx), [0, 1, 2]);
  const series = seriesAt(doc, view, [0]).get("019A");
  assert.deepEqual(series.map((d) => Math.round(d.cm * 1e4) / 1e4), [0, -0.8, -1.6]);
  assert.deepEqual(seriesAt(doc, view, [1]).get("019A").map((d) => d.cm), [0, null, null]);
});

test("scale words name both ends", () => {
  assert.deepEqual(scaleWords("east"), ["motion.west", "motion.east"]);
  assert.deepEqual(scaleWords("rate_up"), ["motion.down", "motion.up"]);
  assert.deepEqual(scaleWords("model_up"), ["motion.down", "motion.up"]);
  assert.deepEqual(scaleWords("los"), ["motion.away", "motion.toward"]);
  assert.deepEqual(scaleWords("coherence"), ["motion.coh_low", "motion.coh_high"]);
});

test("colour scales: round ends at the 99th percentile, symmetric when signed", () => {
  assert.equal(niceCeil(67.3), 80);
  assert.equal(niceCeil(2.2), 2.5);
  assert.equal(niceCeil(0.031), 0.04);
  const values = Float32Array.from({ length: 1000 }, (_, i) => (i - 500) / 10); // −50 … 49.9
  assert.deepEqual(autoRange({ kind: "east", values }), [-50, 50]);
  assert.deepEqual(autoRange({ kind: "sigma", values: Float32Array.from([1, 2, 3, NaN]) }), [0, 3]);
  assert.deepEqual(autoRange({ kind: "coherence", values }), [0, 1]);
  assert.equal(quantile([3, 1, 2, NaN], 0.5), 2);
  const hist = histogram([-10, -1, 0, 1, 10, NaN], -2, 2, 4);
  assert.deepEqual([hist.below, hist.above, hist.n], [1, 1, 5]);
  assert.equal(hist.counts.reduce((a, b) => a + b, 0), 3);
});

test("the colour tables are Crameri's: vik light in the middle, romaO closing on itself", () => {
  const vik = lut("vik");
  assert.ok(vik[128 * 3] > 200 && vik[128 * 3 + 1] > 200); // near white at zero
  const romaO = lut("romaO");
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(romaO[c] - romaO[255 * 3 + c]) <= 2); // cyclic
});

test("painting: colour where measured, grey relief where not, clear at sea; fringes cycle", () => {
  const layer = { kind: "los", values: Float32Array.from([10, NaN, NaN, 22.1]) };
  const rgba = paint(layer, 2, 2, { lo: -20, hi: 20, fringe_cm: null, shade: Float32Array.from([1, 0.5, 0.5, 1]), sea: Uint8Array.from([0, 0, 1, 0]) });
  assert.equal(rgba[3], 242);
  assert.equal(rgba[7], 150); // not measured: relief
  assert.equal(rgba[11], 0); // sea: clear
  const fr = paint({ kind: "los", values: Float32Array.from([0, 12.1, 6.05, 24.2]) }, 4, 1, { lo: 0, hi: 1, fringe_cm: 12.1, shade: null, sea: null });
  assert.deepEqual([...fr.slice(0, 3)], [...fr.slice(4, 7)]); // one full cycle per interval
  const hatch = paintHatch(Uint8Array.from([1, 0]), 2, 1, 3);
  assert.equal(hatch.width, 6);
  assert.ok([...hatch.rgba].filter((_, i) => i % 4 === 3 && i / 4 % 6 >= 3).every((a) => a === 0)); // only in the mask
});

test("a hillshade lights slopes facing the north-west sun and darkens the others", () => {
  const W = 5;
  const westUp = Float32Array.from({ length: 25 }, (_, i) => -(i % W) * 100); // faces east
  const eastUp = Float32Array.from({ length: 25 }, (_, i) => (i % W) * 100); // faces west
  assert.ok(hillshade(eastUp, W, 5, 100)[12] > hillshade(westUp, W, 5, 100)[12]);
  const flat = hillshade(new Float32Array(25), W, 5, 100)[12];
  assert.ok(Math.abs(flat - Math.cos(Math.PI / 4)) < 1e-6); // the sun 45° up
});

test("a swath profile bins the cells near the line and finds where it crosses a fault", () => {
  const W = 100;
  const H = 100;
  const grid = { width: W, height: H, bounds: [0, 0, 1, 1], res_m: 1000 };
  // A step of 10 at longitude 0.5 (a fault running north-south), plus a cell of noise.
  const values = Float32Array.from({ length: W * H }, (_, i) => ((i % W) + 0.5) / W < 0.5 ? -5 : 5);
  const res = swathProfile(values, grid, [0.1, 0.5], [0.9, 0.5], 2, 4);
  assert.ok(Math.abs(res.lengthKm - 0.8 * 111.32 * Math.cos((0.5 * Math.PI) / 180)) < 0.01);
  assert.equal(res.bins[0].med, -5);
  assert.equal(res.bins.at(-1).med, 5);
  const d = crossingKm([0.1, 0.5], [0.9, 0.5], [[0.5, 0], [0.5, 1]]);
  assert.ok(Math.abs(d - res.lengthKm / 2) < 0.01);
  assert.equal(crossingKm([0.1, 0.5], [0.4, 0.5], [[0.5, 0], [0.5, 1]]), null);
});

test("cells near a point and a fitted line", () => {
  const grid = { width: 10, height: 10, bounds: [0, 0, 0.01, 0.01] }; // ~111 m cells
  const cells = cellsNear(grid, 0.005, 0.005, 120);
  assert.ok(cells.length >= 4 && cells.length <= 9);
  const f = fitLine([0, 1, 2, 3], [1, 3, 5, NaN]);
  assert.ok(Math.abs(f.slope - 2) < 1e-12 && Math.abs(f.intercept - 1) < 1e-12);
  assert.equal(fitLine([1], [1]), null);
});

test("checks: the held-out tracks, and the residual either side of a longitude", () => {
  assert.deepEqual(heldOut({ "054D": { used_by_model: true }, "126D": { used_by_model: false }, east: { corr: 0.9 } }), ["126D"]);
  const { doc, view } = quake();
  const side = residualBySide(doc, view, "126D", 1);
  assert.ok(Math.abs(side.west - 2.3) < 1e-3 && Math.abs(side.east - -28) < 1e-3);
});

test("a quake layer with a map from before the quake steps before and across it", async () => {
  const { beforeOf, hasSteps } = await import("../../src/motion.js");
  const doc = { planes: [{ id: "east", kind: "east" }, { id: "before_east", kind: "before_east" }, { id: "los_162A", kind: "los" }, { id: "cum_019A_2026-05-10", kind: "cum", geometry: "019A", date: "2026-05-10" }] };
  assert.equal(beforeOf(doc, "east"), "before_east");
  assert.equal(beforeOf(doc, "los_162A"), null); // no before map published for it here
  assert.equal(hasSteps(doc, "east"), true);
  assert.equal(hasSteps(doc, "los_162A"), false);
  assert.equal(hasSteps(doc, "cum:019A"), true);
  assert.equal(resolveLayer(doc, "east", 0), "before_east");
  assert.equal(resolveLayer(doc, "east", null), "east"); // opens across the quake
  assert.equal(resolveLayer(doc, "east", 1), "east");
});
