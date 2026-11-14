// D-103 to D-106: the creative layers compute only from published numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { areaDays, climateOf, methaneLedger, tonnes } from "../../src/methane.js";
import { waltzScore } from "../../src/waltz.js";
import { cellTruth, scoreRound } from "../../src/play.js";
import { placesForCard } from "../../src/floodcard.js";

const summary = (id) => JSON.parse(readFileSync(new URL(`../../data/${id}/summary.json`, import.meta.url)));

test("area × days by trapezoids, and gaps are never filled", () => {
  const passes = [
    { date: "2026-06-01", v: 10 },
    { date: "2026-06-13", v: 20 },
    { date: "2026-06-25", v: null },
  ];
  const r = areaDays(passes, (p) => p.v);
  assert.equal(r.km2Days, 180); // (10 + 20) / 2 × 12
  assert.equal(r.days, 12);
  assert.equal(tonnes(1, 1000), 1); // 1 km² × 1 g m⁻² = 1 t
});

test("methane ledger: a range from published rates, by climate, on real sites", () => {
  const s = summary("sylhet");
  assert.equal(climateOf(s), "tropical");
  assert.equal(climateOf(summary("everglades")), "temperate");
  const m = methaneLedger(s);
  assert.ok(m.total.lo < m.total.mid && m.total.mid < m.total.hi);
  assert.ok(m.missed.mid < m.total.mid && m.missedShare > 0 && m.missedShare < 1);
  assert.equal(methaneLedger(summary("thunder_bay_36")), null); // a fire site has no ledger
});

test("the waltz: one bar a pass, higher notes for more water, clashes where C-band missed", () => {
  const s = summary("janauaca");
  const bars = waltzScore(s);
  assert.equal(bars.length, s.passes.length);
  const most = s.passes.reduce((a, p, i) => (p.flooded_veg_km2 > s.passes[a].flooded_veg_km2 ? i : a), 0);
  assert.equal(Math.max(...bars.map((b) => b.melody)), bars[most].melody);
  for (const [i, b] of bars.entries()) {
    const p = s.passes[i];
    if (p.hidden_from_cband_km2 === null) assert.equal(b.clash, false);
  }
});

test("the game scores from the class image's amber pixels, tolerant of alpha rounding", () => {
  const w = 4;
  const h = 4;
  const rgba = new Uint8ClampedArray(w * h * 4);
  rgba.set([229, 158, 0, 235], 0); // top-left pixel: amber as a browser reads it back
  const truth = cellTruth(rgba, w, h, 2);
  assert.equal(truth[0], 0.25);
  assert.equal(truth[1], 0);
  const sc = scoreRound([0, 1], truth);
  assert.equal(sc.hits, 1);
  assert.equal(sc.wetCells, 1);
});

test("the flood card names settlements nearest the water first", () => {
  const p = placesForCard([
    { name: "far", nearest_flood_m: 900, days_flooded: 50 },
    { name: "near", nearest_flood_m: 20, days_flooded: 10 },
    { name: "none", nearest_flood_m: null },
  ]);
  assert.deepEqual(p.map((x) => x.name), ["near", "far"]);
});

test("every source a published summary lists has an entry on the sources page", async () => {
  const { entryForSource, SOURCES, UMBRELLAS } = await import("../../src/sources-registry.js");
  const { readdirSync, existsSync } = await import("node:fs");
  const dir = new URL("../../data/", import.meta.url);
  const missing = [];
  for (const id of readdirSync(dir)) {
    const f = new URL(`${id}/summary.json`, dir);
    if (!existsSync(f)) continue;
    for (const src of JSON.parse(readFileSync(f)).sources ?? []) if (!entryForSource(src)) missing.push(`${id}: ${src.id}`);
  }
  assert.deepEqual(missing, []);
  const ids = SOURCES.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, "source ids are unique (they are page anchors)");
  for (const x of SOURCES) assert.ok(UMBRELLAS.some((u) => u.id === x.umbrella), x.id);
});
