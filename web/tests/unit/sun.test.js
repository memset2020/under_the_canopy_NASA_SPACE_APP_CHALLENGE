import { test } from "node:test";
import assert from "node:assert/strict";
import { localSolarHours, nightRing, solarPosition, sunElevationDeg, terminator } from "../../src/sun.js";

const at = (iso) => Date.parse(iso);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

test("declination is zero at the 2026 equinoxes and the obliquity at the solstices", () => {
  // 2026 equinox and solstice instants (USNO); a tolerance of 0.05° is about 3 h of motion at an equinox.
  near(solarPosition(at("2026-03-20T14:46:00Z")).declDeg, 0, 0.05, "March equinox");
  near(solarPosition(at("2026-09-23T00:05:00Z")).declDeg, 0, 0.05, "September equinox");
  near(solarPosition(at("2026-06-21T08:24:00Z")).declDeg, 23.44, 0.05, "June solstice");
  near(solarPosition(at("2026-12-21T20:50:00Z")).declDeg, -23.44, 0.05, "December solstice");
});

test("the equation of time puts the noon Sun east of Greenwich in February, west in November", () => {
  const feb = solarPosition(at("2026-02-11T12:00:00Z"));
  near(feb.eqTimeMin, -14.2, 0.3, "Feb 11 equation of time");
  near(feb.subsolar[0], 3.55, 0.1, "Feb 11 subsolar longitude");
  near(solarPosition(at("2026-11-03T12:00:00Z")).eqTimeMin, 16.4, 0.3, "Nov 3 equation of time");
  near(localSolarHours(at("2026-02-11T12:00:00Z"), 0), 12 + feb.eqTimeMin / 60, 1e-9, "Greenwich solar time");
});

test("the Sun is overhead at the subsolar point and the terminator sits at zero height", () => {
  const ms = at("2026-07-05T22:16:32Z"); // a Janauacá pass, from the granule's own time stamp
  const { subsolar } = solarPosition(ms);
  near(sunElevationDeg(ms, subsolar), 90, 1e-6, "subsolar point");
  near(sunElevationDeg(ms, [subsolar[0] + 180, -subsolar[1]]), -90, 1e-6, "antisolar point");
  for (const [lon, lat] of terminator(ms, 10)) {
    if (Math.abs(lat) < 85) near(sunElevationDeg(ms, [lon, lat]), 0, 1e-6, `terminator at ${lon}`);
  }
  // NISAR's dawn-dusk orbit: Janauacá (60.3°W, 3.4°S) was imaged just after sunset.
  near(localSolarHours(ms, -60.3), 18.18, 0.02, "local solar time");
  near(sunElevationDeg(ms, [-60.3, -3.4]), -3.8, 0.1, "sun height at the site");
});

function insideRing(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

test("the night ring holds the antisolar point and not the subsolar point, in both seasons", () => {
  for (const iso of ["2026-07-05T22:16:32Z", "2026-12-01T03:00:00Z"]) {
    const ms = at(iso);
    const ring = nightRing(ms, 2);
    const [lon, lat] = solarPosition(ms).subsolar;
    const anti = [lon > 0 ? lon - 180 : lon + 180, -lat];
    assert.ok(insideRing(ring, anti), `${iso}: antisolar point in the night ring`);
    assert.ok(!insideRing(ring, [lon, lat]), `${iso}: subsolar point outside it`);
  }
});
