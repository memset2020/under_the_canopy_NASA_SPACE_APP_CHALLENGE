import { test } from "node:test";
import assert from "node:assert/strict";
import { closestOnLine, haversineKm, incidenceDeg, nextPasses, passCountdown } from "../../src/orbitmath.js";

test("haversine: one degree of latitude is 111.2 km; Manaus to Sylhet is ~16,000 km", () => {
  assert.ok(Math.abs(haversineKm([0, 0], [0, 1]) - 111.19) < 0.05);
  const d = haversineKm([-60.02, -3.1], [91.87, 24.9]);
  assert.ok(d > 15500 && d < 16500, String(d));
});

test("closest point on a north-south track, and which side the place is on", () => {
  const line = [[10, -5], [10, 0], [10, 5]];
  const c = closestOnLine(line, [12, 1]);
  assert.ok(Math.abs(c.km - 2 * 111.32 * Math.cos((1 * Math.PI) / 180)) < 1);
  assert.ok(Math.abs(c.point[1] - 1) < 1e-9);
  assert.equal(c.east, true); // the place lies east of the track
});

test("incidence angle: NISAR's 242 km swath sits about 33-47° from the vertical", () => {
  const near = incidenceDeg(430);
  const far = incidenceDeg(672);
  assert.ok(near > 32 && near < 36, String(near));
  assert.ok(far > 44 && far < 49, String(far));
  assert.ok(incidenceDeg(0) === 0);
});

test("12-day repeat: next passes after today", () => {
  assert.deepEqual(nextPasses("2026-09-27", "2026-10-08"), ["2026-10-09", "2026-10-21", "2026-11-02"]);
  assert.deepEqual(nextPasses("2026-10-09", "2026-10-09", 1), ["2026-10-21"]); // a pass today is not "next"
});

test("passCountdown: the time of day comes from the granule, and a pass already gone rolls on", () => {
  const c = passCountdown("2026-09-27", Date.parse("2026-10-08T06:00:00Z"), "2026-09-27T12:00:00Z");
  assert.equal(c.targetIso, "2026-10-09");
  assert.equal(c.timeKnown, true);
  assert.deepEqual([c.days, c.hours, c.minutes], [1, 6, 0]);
  assert.equal(c.isToday, false);
  // Due today but its time has passed: the next repeat, 12 days on.
  const gone = passCountdown("2026-09-27", Date.parse("2026-10-09T13:00:00Z"), "2026-09-27T12:00:00Z");
  assert.equal(gone.targetIso, "2026-10-21");
  // Due later today.
  const later = passCountdown("2026-09-27", Date.parse("2026-10-09T10:30:00Z"), "2026-09-27T12:00:00Z");
  assert.equal(later.targetIso, "2026-10-09");
  assert.equal(later.isToday, true);
  assert.deepEqual([later.days, later.hours, later.minutes], [0, 1, 30]);
});

test("passCountdown: without a time stamp only the date is claimed", () => {
  const c = passCountdown("2026-09-27", Date.parse("2026-10-08T23:00:00Z"));
  assert.equal(c.timeKnown, false);
  assert.equal(c.targetIso, "2026-10-09");
  assert.equal(c.days, 1);
  const today = passCountdown("2026-09-27", Date.parse("2026-10-09T23:59:00Z"), "no time here");
  assert.equal(today.timeKnown, false);
  assert.equal(today.isToday, true); // a date-only pass today is not assumed to be over
  assert.equal(passCountdown(null), null);
});
