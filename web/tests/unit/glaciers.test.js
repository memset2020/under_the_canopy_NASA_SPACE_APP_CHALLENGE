// Glacier atlas helpers (glaciermaps.js, glaciers.js): colour, scales, decoding, particles.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cellAt,
  decodePlanes,
  extendFlow,
  flowAt,
  fromOklab,
  humanSpeed,
  iceLut,
  logScale,
  logTicks,
  monthOfDay,
  paintPlane,
  seedCells,
  speedRange,
  stepParticles,
  toOklab,
  trendRange,
  trunkChange,
} from "../../src/glaciermaps.js";
import { byRegion, slope, sparkPath } from "../../src/glaciers.js";

test("OKLab round-trips sRGB", () => {
  for (const rgb of [[0, 0, 0], [255, 255, 255], [13, 27, 58], [143, 205, 230]]) {
    const back = fromOklab(toOklab(rgb));
    back.forEach((c, i) => assert.ok(Math.abs(c - rgb[i]) <= 1, `${rgb} -> ${back}`));
  }
});

test("the ice ramp gets lighter all the way (readable in greyscale)", () => {
  const L = iceLut();
  let prev = -1;
  for (let i = 0; i < 256; i += 5) {
    const l = toOklab([L[i * 3], L[i * 3 + 1], L[i * 3 + 2]])[0];
    assert.ok(l > prev, `lightness falls at ${i}`);
    prev = l;
  }
});

test("log scale and its ticks", () => {
  const sc = logScale(10, 10000);
  assert.equal(sc.f(10), 0);
  assert.equal(sc.f(10000), 1);
  assert.ok(Math.abs(sc.f(100) - 1 / 3) < 1e-9);
  assert.ok(Math.abs(sc.inv(0.5) - 316.227766) < 1e-3);
  assert.deepEqual(logTicks(10, 10000), [10, 100, 1000, 10000]);
  assert.deepEqual(logTicks(5, 200, 6), [5, 10, 20, 50, 100, 200]);
  assert.deepEqual(logTicks(5, 200), [10, 100]); // more than five thin to the powers of ten
});

test("speed and trend ranges round out to readable ends", () => {
  assert.deepEqual(speedRange({ p02_m_yr: 3.4, max_m_yr: 10636 }), [2, 20000]);
  assert.deepEqual(speedRange({ p02_m_yr: 0.2, max_m_yr: 71 }), [2, 100]);
  assert.equal(trendRange({ trend_p02: -1.7, trend_p98: 0.7 }), 2);
  assert.equal(trendRange({ trend_p02: -30, trend_p98: 410 }), 500);
});

test("decodePlanes reads uint16 and int16 planes and the annual stack", () => {
  const doc = {
    grid: { width: 2, height: 1 },
    planes: [
      { id: "speed", scale: 0.1, signed: false },
      { id: "east", scale: 1, signed: true },
    ],
    annual_grid: { width: 1, height: 1, years: [2000, 2001], scale: 1 },
  };
  const u = new Uint16Array([123, 65535, 65536 - 5, 32768, 7, 65535]);
  const p = decodePlanes(doc, u.buffer);
  assert.ok(Math.abs(p.speed[0] - 12.3) < 1e-4);
  assert.ok(Number.isNaN(p.speed[1]));
  assert.equal(p.east[0], -5);
  assert.ok(Number.isNaN(p.east[1])); // -32768 = no data
  assert.equal(p.annual[0][0], 7);
  assert.ok(Number.isNaN(p.annual[1][0]));
});

test("paintPlane leaves unmeasured cells clear", () => {
  const rgba = paintPlane(new Float32Array([NaN, 1000]), "speed", [10, 10000]);
  assert.equal(rgba[3], 0);
  assert.equal(rgba[7], 235);
});

test("particles drift with the flow and respawn off the ice", () => {
  // 3 x 1 grid flowing east at 100 m/yr; cells of 100 m.
  const east = new Float32Array([100, 100, NaN]);
  const north = new Float32Array([0, 0, NaN]);
  const field = { east, north, width: 3, height: 1, seeds: seedCells(east, north, 1) };
  assert.deepEqual([...field.seeds], [0, 1]);
  assert.deepEqual(flowAt(east, north, 3, 1, 1.0, 0.5), [100, 0]);
  const p = { x: 1.0, y: 0.5, age: 0 };
  const segs = stepParticles([p], field, { cellsPerYear: 1 / 100, yearsPerFrame: 0.5, maxAge: 10, rand: () => 0 });
  assert.deepEqual(segs, [1, 0.5, 1.5, 0.5, 100]);
  // Past the measured cells, it starts again on a seed cell.
  p.x = 2.9;
  stepParticles([p], field, { cellsPerYear: 0.01, yearsPerFrame: 0.5, maxAge: 10, rand: () => 0 });
  assert.equal(p.x, 0);
});

test("readouts", () => {
  assert.deepEqual(humanSpeed(10636), [10.636, "km_yr", 0]);
  assert.deepEqual(humanSpeed(2500), [2.5, "km_yr", 1]);
  assert.deepEqual(humanSpeed(71), [71, "m_yr", 0]);
  assert.equal(humanSpeed(null), null);
  assert.equal(monthOfDay(1), 0);
  assert.equal(monthOfDay(200), 6);
  const doc = { bounds: [0, 0, 10, 10], grid: { width: 10, height: 10 } };
  assert.equal(cellAt(doc, 0.5, 9.9), 0);
  assert.equal(cellAt(doc, 11, 5), null);
  assert.deepEqual(trunkChange([1, 2, 3], [null, 100, 150]), { from: 2, to: 3, v0: 100, v1: 150, change: 0.5 });
});

test("atlas helpers", () => {
  const groups = byRegion([{ id: "a", region: "17A" }, { id: "b", region: "05A" }, { id: "c", region: "99Z" }]);
  assert.deepEqual(groups.map(([r]) => r), ["05A", "17A", "99Z"]);
  assert.equal(sparkPath([1, null, 2, 4], 10, 10, 0), "M0.0,7.5M6.7,5.0L10.0,0.0");
  assert.equal(slope([1, 2, 3], [2, 4, 6]), 2);
  assert.equal(slope([1, 2], [1, 2]), null);
});

test("the flow covers the whole box: across ice gaps, past the front fading over water, never on rock", () => {
  // One row: ice, ice, gap in the ice, ice front, water, water, water, rock, water.
  const surface = Uint8Array.from([1, 1, 2, 1, 4, 4, 4, 3, 4]);
  const east = Float32Array.from([100, 100, NaN, 100, NaN, NaN, NaN, NaN, NaN]);
  const north = Float32Array.from([0, 0, NaN, 0, NaN, NaN, NaN, NaN, NaN]);
  const f = extendFlow(east, north, surface, 9, 1, 1000, 6);
  assert.equal(f.drawn[0], 0);
  assert.equal(f.drawn[2], 1); // the gap is filled
  assert.ok(f.east[2] > 90);
  assert.ok(f.east[4] > f.east[5] && f.east[5] > f.east[6] && f.east[6] > 0); // fading with distance
  assert.ok(Number.isNaN(f.east[7])); // rock stays still
  assert.ok(Number.isNaN(f.east[8])); // water cut off by rock gets nothing
  const segs = stepParticles([{ x: 4.5, y: 0.5, age: 0 }], { ...f, width: 9, height: 1, seeds: Uint32Array.from([0]) }, { cellsPerYear: 0.001, yearsPerFrame: 1, maxAge: 10, rand: () => 0 });
  assert.deepEqual(segs.kinds, [1]); // a particle over the water is drawn as carried on
});
