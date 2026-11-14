// The map panel (dock.js, docs/10 D-092): which map a mode shows, which controls go with which
// map, and what each section's heading says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECTIONS, foldedByDefault, mapOf, mapsOf, summarise } from "../../src/dock.js";

const t = (key, p = {}) => `${key}${p.n === undefined ? "" : `:${p.n}`}`;

test("the sections are always in the same order", () => {
  assert.deepEqual(SECTIONS, ["layer", "display", "overlays", "compare", "basemap"]);
});

test("a site's findings, evidence and tools share its map; the others are maps of their own", () => {
  for (const m of ["site", "evidence", "tools"]) assert.equal(mapOf(m), "site");
  for (const m of ["world", "motion", "ice"]) assert.equal(mapOf(m), m);
  assert.equal(mapsOf("site evidence"), "site");
  assert.equal(mapsOf("site world"), "site world");
  assert.equal(mapsOf(undefined), "site");
});

test("the panel opens folded only where the map would be too narrow beside it", () => {
  assert.equal(foldedByDefault(1440), false);
  assert.equal(foldedByDefault(1280), false); // a laptop keeps the panel open: it sits beside the map
  assert.equal(foldedByDefault(1024), true);
  assert.equal(foldedByDefault(390), true);
});

test("a heading names the current choice", () => {
  assert.equal(summarise("layer", [{ kind: "pressed", text: "Each pass" }], t), "Each pass");
  assert.equal(summarise("layer", [{ kind: "select", value: "east", text: "East–west" }], t), "East–west");
  assert.equal(summarise("basemap", [{ kind: "select", value: "auto", text: "Map: automatic" }], t), "Map: automatic");
  assert.equal(summarise("compare", [{ kind: "pressed", text: "C-band" }], t), "C-band");
  // Display names the drawing (the first list), not a pressed toggle such as the flow animation.
  assert.equal(summarise("display", [{ kind: "pressed", text: "Stop the flow" }], t), "");
  assert.equal(summarise("display", [{ kind: "select", value: "", text: "Colour scale" }, { kind: "check", checked: true }], t), "Colour scale");
});

test("On top counts what is switched on, lists set to nothing do not count", () => {
  const c = [
    { kind: "check", checked: true },
    { kind: "check", checked: false },
    { kind: "select", value: "", text: "None" },
    { kind: "select", value: "off", text: "Nothing" },
    { kind: "select", value: "MODIS_Flood", text: "Flood" },
  ];
  assert.equal(summarise("overlays", c, t), "dock.n_on:2");
  assert.equal(summarise("overlays", [{ kind: "check", checked: false }], t), "dock.none_on");
});
