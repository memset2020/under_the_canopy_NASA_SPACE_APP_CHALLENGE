import { test } from "node:test";
import assert from "node:assert/strict";
import { compositeDays } from "../../src/live.js";

const nisar = { dates: [["2026-08-10", "2026-10-05", "P1D"]] };

test("a pass before the layer starts composites forwards, nearest day on top", () => {
  const days = compositeDays(nisar, "2026-08-10", 12);
  assert.equal(days.length, 12);
  assert.deepEqual([days[0], days.at(-1)], ["2026-08-21", "2026-08-10"]);
});

test("in the middle of the record it takes the nearest days both sides", () => {
  const days = compositeDays(nisar, "2026-09-15", 3);
  assert.deepEqual([...days].sort(), ["2026-09-14", "2026-09-15", "2026-09-16"]);
  assert.equal(days.at(-1), "2026-09-15");
});

test("at the end of the record it composites backwards", () => {
  const days = compositeDays(nisar, "2026-10-05", 12);
  assert.deepEqual([...days].sort()[0], "2026-09-24");
});

test("static layers and single days pass through", () => {
  assert.deepEqual(compositeDays({ dates: [] }, null, 12), [null]);
  assert.deepEqual(compositeDays(nisar, "2026-09-01", 1), ["2026-09-01"]);
});
