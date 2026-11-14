import { test } from "node:test";
import assert from "node:assert/strict";
import { hasDataOn, isStaticView, nearestWithData } from "../../src/viewdata.js";

const summary = {
  passes: [{ date: "2026-06-23" }, { date: "2026-07-05" }, { date: "2026-07-17" }, { date: "2026-08-10" }],
  products: { level_change: [{ from: "2026-07-05", to: "2026-07-17" }, { from: "2026-07-17", to: "2026-08-10" }] },
};

test("level change exists only on passes where an interferogram ends", () => {
  assert.deepEqual([0, 1, 2, 3].map((i) => hasDataOn(summary, "level", i)), [false, false, true, true]);
  assert.equal(hasDataOn(summary, "flood", 0), true);
});

test("an empty pass points to the nearest pass with data", () => {
  assert.equal(nearestWithData(summary, "level", 0), 2);
  assert.equal(nearestWithData(summary, "level", 3), 3);
  assert.equal(nearestWithData({ ...summary, products: {} }, "level", 0), null);
});

test("terrain, canopy and days flooded are the same on every pass", () => {
  assert.deepEqual(["terrain", "canopy", "hydroperiod", "flood", "radar", "change"].map(isStaticView), [true, true, true, false, false, false]);
});

test("a pair that measured nothing counts as no data", () => {
  const s2 = { ...summary, products: { level_change: [{ from: "2026-07-05", to: "2026-07-17", median_cm: null }, { from: "2026-07-17", to: "2026-08-10", median_cm: 1.2 }] } };
  assert.deepEqual([0, 1, 2, 3].map((i) => hasDataOn(s2, "level", i)), [false, false, false, true]);
});
