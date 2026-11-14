import { test } from "node:test";
import assert from "node:assert/strict";
import { bearing8, centreDistanceKm, iceFor, segments, speedVerdict } from "../../src/ice.js";

const fire = [-120.15, 49.42, -119.55, 49.78];
const icefield = [-117.55, 52.05, -117.05, 52.3];

test("the icefield is about 330 km north-east of the Bald Range fire box", () => {
  const km = centreDistanceKm(fire, icefield);
  assert.ok(km > 300 && km < 360, String(km));
  assert.equal(bearing8(fire, icefield), "ne");
  assert.equal(centreDistanceKm(fire, fire), 0);
});

test("an icefield is linked to its fire site only", () => {
  const index = { events: [{ id: "columbia_icefield", fire_site: "bald_range" }] };
  assert.equal(iceFor(index, "bald_range").id, "columbia_icefield");
  assert.equal(iceFor(index, "sylhet"), null);
  assert.equal(iceFor(null, "bald_range"), null);
});

test("a line breaks where a day was not measured", () => {
  const pts = [1, null, 2, 3, undefined, 4].map((y, i) => ({ date: String(i), y }));
  assert.deepEqual(segments(pts).map((s) => s.map((p) => p.y)), [[1], [2, 3], [4]]);
});

test("NISAR resolves a glacier only near ITS_LIVE's speed and clear of the rock noise", () => {
  const sp = {
    best_pair: { rock_noise_m_yr: 5 },
    glaciers: [
      { name: "A", itslive_m_yr: 47, itslive_error_m_yr: 28, itslive_pairs: 13, nisar_m_yr: 12, nisar_agree_pct: 60 },
      { name: "B", itslive_m_yr: 50, itslive_iqr_m_yr: [40, 60], itslive_error_m_yr: 30, itslive_pairs: 12, nisar_m_yr: 45, nisar_agree_pct: 70 },
      { name: "C", itslive_m_yr: 8, itslive_pairs: 3, nisar_m_yr: 7, nisar_agree_pct: 90 },
      { name: "D", itslive_m_yr: 47, itslive_iqr_m_yr: [35, 53], itslive_pairs: 12, nisar_m_yr: 40, nisar_agree_pct: 23 },
    ],
  };
  const v = speedVerdict(sp);
  // A is too slow, C inside the rock noise, D measured on too little of the glacier.
  assert.deepEqual(v.resolved, ["B"]);
  assert.deepEqual(v.nisar, [7, 45]);
  assert.deepEqual(v.error, [28, 30]);
  assert.equal(v.pairs, 13);
});
