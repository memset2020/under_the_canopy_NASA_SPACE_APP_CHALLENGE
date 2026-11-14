import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CLASS, VEG, classifyGrid, classifyPixel, validThresholds, verdict } from "../../src/rules.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/rules_fixture.json", import.meta.url), "utf8"),
);
const layers = {
  hh: { scale: 0.25, offset: -50, nodata: 0 },
  hv: { scale: 0.25, offset: -50, nodata: 0 },
  hh_spread: { scale: 0.25, offset: 0, nodata: null },
};
const T = fixture.sets[0].thresholds;

test("rules.js matches classify.py on every fixture pixel and threshold set", () => {
  const input = {
    hhQ: Uint8Array.from(fixture.hh_q),
    hvQ: Uint8Array.from(fixture.hv_q),
    spQ: Uint8Array.from(fixture.sp_q),
    veg: Uint8Array.from(fixture.veg),
  };
  for (const set of fixture.sets) {
    const { cls, conf } = classifyGrid(input, layers, set.thresholds);
    let mismatches = 0;
    for (let i = 0; i < cls.length; i += 1) {
      if (cls[i] !== set.cls[i] || conf[i] !== set.conf[i]) mismatches += 1;
    }
    assert.equal(mismatches, 0, `thresholds ${JSON.stringify(set.thresholds)}`);
  }
});

test("physics cases", () => {
  assert.equal(classifyPixel(-2, -12, 0.5, VEG.YES, T).cls, CLASS.FLOODED_VEG);
  assert.equal(classifyPixel(-21, -27, 0.5, VEG.OTHER, T).cls, CLASS.OPEN_WATER);
  assert.equal(classifyPixel(2, -10, 0.5, VEG.BUILT_UP, T).cls, CLASS.EXCLUDED);
  assert.equal(classifyPixel(null, -10, 0.5, VEG.YES, T).cls, CLASS.NODATA);
});

test("verdicts", () => {
  assert.equal(verdict({ cls: CLASS.FLOODED_VEG, conf: 1 }), "hidden_flood");
  assert.equal(verdict({ cls: CLASS.FLOODED_VEG, conf: 0 }), "uncertain");
  assert.equal(verdict({ cls: CLASS.DRY, conf: 1 }), "dry");
  assert.equal(verdict({ cls: CLASS.EXCLUDED, conf: 1 }), "excluded");
  assert.equal(verdict({ cls: CLASS.NODATA, conf: 1 }), "nodata");
});

test("thresholds must be quarter-dB multiples", () => {
  assert.ok(validThresholds(T));
  assert.ok(!validThresholds({ ...T, fv_hh_db: -5.1 }));
});
