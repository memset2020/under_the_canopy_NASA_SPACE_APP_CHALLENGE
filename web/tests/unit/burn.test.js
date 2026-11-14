import { test } from "node:test";
import assert from "node:assert/strict";
import { afterReference, burnSeries, dailyFire, daysBetween, fireStage } from "../../src/burn.js";

const doc = {
  baseline: ["2026-07-11"],
  by_pass: [
    { date: "2026-07-11", new_km2: 0, burned_km2: 0 },
    { date: "2026-07-23", new_km2: 1640, burned_km2: 1640 },
    { date: "2026-08-16", new_km2: 283, burned_km2: 1923 },
    { date: "2026-09-09", new_km2: 107, burned_km2: 2030 },
  ],
  validation: { product: "MCD64A1", ref_months: ["2026-06", "2026-07"] },
};

test("burn rows mark the baseline and the passes that found new burn", () => {
  const rows = burnSeries(doc);
  assert.deepEqual(rows.map((r) => [r.baseline, r.isNew]), [[true, false], [false, true], [false, true], [false, true]]);
});

test("burn first seen after the reference map's last month is counted apart", () => {
  assert.equal(afterReference(doc), 390);
  assert.equal(afterReference({ ...doc, validation: { ref_months: [] } }), 0);
  assert.equal(afterReference({ ...doc, validation: null }), 0);
});

test("a fire pixel is new between two radar passes, old before, hidden after", () => {
  // passes on day 12 and day 0 (counted from day0)
  assert.equal(fireStage(10, 12, 0), "new");
  assert.equal(fireStage(12, 12, 0), "new");
  assert.equal(fireStage(0, 12, 0), "old");
  assert.equal(fireStage(13, 12, 0), null);
  assert.equal(fireStage(3, 5, null), "new");
  assert.equal(daysBetween("2026-07-30", "2026-08-11"), 12);
});

test("daily fire is zero-filled between the first and last detection", () => {
  const rows = dailyFire({ first: "2026-08-08", last: "2026-08-11", by_day: [{ date: "2026-08-08", n: 5 }, { date: "2026-08-11", n: 2 }] });
  assert.deepEqual(rows.map((r) => r.n), [5, 0, 0, 2]);
});
