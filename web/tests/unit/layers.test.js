import { test } from "node:test";
import assert from "node:assert/strict";
import { changeReference, driestPass } from "../../src/layers.js";

const passes = [
  { date: "2026-06-17", flooded_km2: 122 },
  { date: "2026-06-29", flooded_km2: 34 },
  { date: "2026-07-11", flooded_km2: 150 },
  { date: "2026-07-23", flooded_km2: 20 },
];

test("a flood site's change view compares with its driest pass", () => {
  const summary = { passes, products: { burn: null } };
  assert.equal(driestPass(summary), 3);
  assert.equal(changeReference(summary), 3);
});

test("a fire site's change view compares with the last pass before the fire", () => {
  const summary = { passes, products: { burn: { baseline: ["2026-06-17", "2026-06-29", "2026-07-11"] } } };
  assert.equal(changeReference(summary), 2);
});
