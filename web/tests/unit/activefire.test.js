// Active fires from NASA FIRMS via GIBS vector tiles (docs/10 D-138): the pure parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dedupe, frpClass, lastFullDay, passWindow, plan, pointsOf, satelliteName, snapDay, summarise, windowDates } from "../../src/activefire.js";

// The GIBS 500m geographic grid (levels 0-2), as gibs.json carries it.
const LEVELS = [
  { cols: 2, rows: 1, span_deg: 288 },
  { cols: 3, rows: 2, span_deg: 144 },
  { cols: 5, rows: 3, span_deg: 72 },
  { cols: 10, rows: 5, span_deg: 36 },
  { cols: 20, rows: 10, span_deg: 18 },
  { cols: 40, rows: 20, span_deg: 9 },
  { cols: 80, rows: 40, span_deg: 4.5 },
  { cols: 160, rows: 80, span_deg: 2.25 },
];
const LAYER = { dates: [["2025-12-23", "2026-11-12", "P1D"]], levels: LEVELS };

test("fire radiative power falls into four classes", () => {
  assert.deepEqual([0, 4.9, 5, 24.9, 25, 99, 100, 2500].map(frpClass), [0, 0, 1, 1, 2, 2, 3, 3]);
  assert.equal(frpClass(null), 0);
  assert.equal(frpClass("abc"), 0);
});

test("a window ends on the date and keeps only days the layer has", () => {
  assert.deepEqual(windowDates(LAYER, "2026-07-15", 3), ["2026-07-13", "2026-07-14", "2026-07-15"]);
  assert.deepEqual(windowDates(LAYER, "2025-12-24", 3), ["2025-12-23", "2025-12-24"]);
  assert.equal(snapDay(LAYER, "2027-01-05"), "2026-11-12");
  assert.equal(snapDay(LAYER, "2026-07-15"), "2026-07-15");
});

test("a site view uses the finest tiles that fit; a wide view draws at most three days", () => {
  const site = plan(LEVELS, [-89.6, 50.05, -88.8, 50.95], 12);
  assert.deepEqual(site, { level: 7, days: 12, trimmed: false }); // one 2.25° tile × a pass window
  const across = plan(LEVELS, [-90.5, 49.5, -88.0, 51.5], 24); // 4 fine tiles: one coarser instead
  assert.equal(across.trimmed, false);
  assert.ok(across.level < 7);
  assert.deepEqual(plan(LEVELS, [-180, -85, 180, 85], 1), { level: 2, days: 1, trimmed: false }); // 15 tiles
  assert.deepEqual(plan(LEVELS, [-180, -85, 180, 85], 7), { level: 1, days: 3, trimmed: true }); // 6 × 3
});

test("the radar-pass window runs from the day after the previous pass to this one", () => {
  const passes = [{ date: "2026-07-11" }, { date: "2026-07-23" }, { date: "2026-08-16" }];
  assert.deepEqual(passWindow(passes, 1), { end: "2026-07-23", days: 12 });
  assert.deepEqual(passWindow(passes, 2), { end: "2026-08-16", days: 24 }); // a skipped pass
  assert.deepEqual(passWindow(passes, 0), { end: "2026-07-11", days: 12 }); // one repeat cycle
});

test("the default date is the last full day, not today's half-processed one", () => {
  assert.equal(lastFullDay(LAYER, "2026-11-12"), "2026-11-11");
  assert.equal(lastFullDay(LAYER, "2026-11-20"), "2026-11-12");
});

test("points come from FIRMS properties, deduplicated across tiles, summarised", () => {
  const layer = {
    extent: 4096,
    features: [
      { type: "point", props: { LATITUDE: 50.1, LONGITUDE: -89.1, FRP: 3.9, ACQ_DATE: "2026-07-15", ACQ_TIME: "08:39", SATELLITE: "N20", CONFIDENCE: "nominal", DAYNIGHT: "N" }, paths: [[[788, 3516]]] },
      { type: "point", props: { LATITUDE: 50.2, LONGITUDE: -89.0, FRP: 140, ACQ_DATE: "2026-07-15", ACQ_TIME: "18:05", SATELLITE: "N20", CONFIDENCE: "high", DAYNIGHT: "D" }, paths: [[[800, 3500]]] },
      { type: "line", props: {}, paths: [[[0, 0], [1, 1]]] },
    ],
  };
  const a = pointsOf([layer], { x: 16, y: 8, spanDeg: 4.5 });
  assert.equal(a.length, 2);
  assert.deepEqual([a[0].cls, a[1].cls], [0, 3]);
  assert.equal(a[0].night, true);
  const both = dedupe([...a, ...pointsOf([layer], { x: 16, y: 8, spanDeg: 4.5 })]);
  assert.equal(both.length, 2);
  assert.deepEqual(summarise(both), { n: 2, night: 1, maxFrp: 140, byClass: [1, 0, 0, 1] });
});

test("a point without FIRMS coordinates is placed from its tile geometry", () => {
  const [p] = pointsOf([{ extent: 4096, features: [{ type: "point", props: { FRP: 10 }, paths: [[[2048, 2048]]] }] }], { x: 1, y: 0, spanDeg: 144 });
  assert.equal(p.lon, -180 + 1.5 * 144);
  assert.equal(p.lat, 90 - 0.5 * 144);
  assert.equal(p.cls, 1);
});

test("satellite codes read as names", () => {
  assert.equal(satelliteName("N20"), "NOAA-20");
  assert.equal(satelliteName("N"), "Suomi NPP");
  assert.equal(satelliteName("A"), "Aqua");
  assert.equal(satelliteName("X9"), "X9");
});
