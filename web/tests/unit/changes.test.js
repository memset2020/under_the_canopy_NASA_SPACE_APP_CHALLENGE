import { test } from "node:test";
import assert from "node:assert/strict";
import { activeKind } from "../../src/changes.js";

test("the change switch follows the mode and the kind of site", () => {
  const site = (kind) => ({ summary: { site: { kind } } });
  assert.equal(activeKind({ mode: "site", site: site("flood") }), "water");
  assert.equal(activeKind({ mode: "evidence", site: site("fire") }), "fire");
  assert.equal(activeKind({ mode: "motion", site: site("fire") }), "ground");
  assert.equal(activeKind({ mode: "world", site: null }), "water");
  assert.equal(activeKind({ mode: "ice", site: site("flood") }), "ice"); // the glacier atlas is its own mode
  assert.equal(activeKind({ mode: "site", site: site("fire"), ice: true }), "fire"); // the smoke-and-ice card sits on its fire site
});
