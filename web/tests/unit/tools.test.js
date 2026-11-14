import { test } from "node:test";
import assert from "node:assert/strict";
import { CLASS } from "../../src/rules.js";
import { areasInMask, pathKm, polygonAreaKm2, rasterizePolygon, utm } from "../../src/tools.js";

test("path length: 1° of the equator is 111.2 km", () => {
  assert.ok(Math.abs(pathKm([[0, 0], [1, 0]]) - 111.19) < 0.05);
  assert.equal(pathKm([[0, 0]]), 0);
});

test("spherical polygon area: a 1° box on the equator is ~12,360 km², any vertex order", () => {
  const box = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const a = polygonAreaKm2(box);
  assert.ok(Math.abs(a - 12364) < 15, String(a));
  assert.ok(Math.abs(polygonAreaKm2([...box].reverse()) - a) < 1e-6);
  assert.equal(polygonAreaKm2([[0, 0], [1, 1]]), 0);
});

test("UTM: central meridian gives 500 000 m E; 45°N on it is k0 × the WGS84 meridian arc", () => {
  const u = utm(-63, 45); // zone 20 central meridian
  assert.equal(u.zone, 20);
  assert.equal(u.hemi, "N");
  assert.ok(Math.abs(u.easting - 500000) < 1e-6);
  assert.ok(Math.abs(u.northing - 0.9996 * 4984944.38) < 0.5, String(u.northing));
  const east = utm(-61, -3.4); // both in zone 20 (-66° to -60°), 2° either side of -63°
  const west = utm(-65, -3.4);
  assert.ok(Math.abs(east.easting - 500000 - (500000 - west.easting)) < 1e-3); // symmetric about the meridian
  assert.ok(east.northing > 9600000 && east.northing < 10000000); // southern hemisphere false northing
});

test("polygon rasterisation and per-class areas", () => {
  const grid = { width: 10, height: 10, bounds: [0, 0, 1, 1] };
  const mask = rasterizePolygon([[0, 0], [0.5, 0], [0.5, 1], [0, 1]], grid);
  assert.equal(mask.reduce((s, v) => s + v, 0), 50); // left half: 5 columns × 10 rows
  const cls = new Uint8Array(100).fill(CLASS.DRY);
  cls[0] = CLASS.FLOODED_VEG;
  cls[9] = CLASS.FLOODED_VEG; // outside the polygon (column 9)
  const rowArea = new Float64Array(10).fill(2);
  const a = areasInMask(cls, mask, rowArea, 10);
  assert.equal(a[CLASS.FLOODED_VEG], 2);
  assert.equal(a[CLASS.DRY], 98);
});

test("feature-space bins: exact 0.25 dB bins, majority class per bin, nodata skipped", async () => {
  const { binPixels } = await import("../../src/space.js");
  const { counts, major } = binPixels([-5, -5, -5, -20, null], [-13, -13, -12.9, -26, -10], [3, 3, 1, 2, 0]);
  const NX = 140;
  const kHidden = Math.floor((8 + 2) / 0.25) * NX + Math.floor((-5 + 30) / 0.25); // HH -5, gap 8
  assert.equal(counts[kHidden], 2);
  assert.equal(major[kHidden], 3);
  assert.equal(counts.reduce((s, v) => s + v, 0), 4);
});

test("flows: transition areas and the three stages", async () => {
  const { transitions, stages } = await import("../../src/flows.js");
  const a = Uint8Array.from([3, 3, 1, 2]);
  const b = Uint8Array.from([1, 3, 1, 2]);
  const m = transitions(a, b, Float64Array.from([1, 2]), 2); // rows of 2 px: areas 1 and 2 km²
  assert.equal(m[3][1], 1); // pixel 0: hidden -> dry, row 0
  assert.equal(m[3][3], 1); // pixel 1: stayed hidden, row 0
  assert.equal(m[1][1], 2);
  assert.equal(m[2][2], 2);
  const passes = ["p1", "p2", "p3", "p4", "p5"].map((id) => ({ id }));
  assert.deepEqual(stages({ passes, peak_pass: "p2" }), [0, 1, 4]);
  assert.deepEqual(stages({ passes, peak_pass: "p1" }), [0, 2, 4]); // peak at an end: use the middle
  assert.deepEqual(stages({ passes: passes.slice(0, 2), peak_pass: "p1" }), [0, 1]);
});

test("ridges: HH share per bin over vegetated pixels, and the share above a threshold", async () => {
  const { hhDistribution, shareAbove } = await import("../../src/ridges.js");
  const layer = { scale: 0.25, offset: -50, nodata: 0 };
  const q = (db) => Math.round((db + 50) / 0.25);
  const hhQ = Uint8Array.from([q(-12), q(-12), q(-3), q(-3), 0, q(-3)]);
  const veg = Uint8Array.from([1, 1, 1, 1, 1, 0]); // the last bright pixel is not vegetated
  const d = hhDistribution(hhQ, veg, layer);
  assert.equal(d.n, 4);
  assert.ok(Math.abs(d.share.reduce((s, v) => s + v, 0) - 1) < 1e-9);
  assert.ok(Math.abs(shareAbove(d, -6) - 0.5) < 1e-9);
});
