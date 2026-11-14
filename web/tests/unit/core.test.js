import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore, watch } from "../../src/state.js";
import { createBundle } from "../../src/data.js";
import { lonLatToWorld, worldToLonLat } from "../../src/map.js";
import { ticks } from "../../src/svg.js";

function tinySummary() {
  return {
    schema_version: 2,
    grid: { width: 2, height: 2, bounds: [10, 0, 10.02, 0.02] },
    passes: [{ id: "p01" }, { id: "p02" }],
    grid_stack: {
      layers: [
        { name: "hh", scale: 0.25, offset: -50, nodata: 0 },
        { name: "hv", scale: 0.25, offset: -50, nodata: 0 },
        { name: "hh_spread", scale: 0.25, offset: 0, nodata: null },
        { name: "cband", codes: {} },
      ],
      static_layers: [{ name: "veg", codes: {} }, { name: "hydroperiod_days", scale: 1, offset: 0, nodata: null }],
    },
  };
}

test("store notifies only on change and watch filters keys", () => {
  const store = createStore({ a: 1, b: 1 });
  const calls = [];
  watch(store, ["a"], (s) => calls.push(s.a));
  store.set({ b: 2 });
  store.set({ a: 1 });
  store.set({ a: 5 });
  assert.deepEqual(calls, [1, 5]);
});

test("bundle decodes the stack in layer, pass, row, col order", () => {
  const P = 2;
  const plane = 4;
  const stack = new Uint8Array(4 * P * plane);
  // hh, pass 1, row 1, col 0 → index ((0*2+1)*2+1)*2+0 = 6
  stack[6] = 192; // -2 dB
  stack[(1 * P + 1) * plane + 2] = 0; // hv nodata at same pixel
  const statics = Uint8Array.from([1, 1, 1, 1, 0, 0, 12, 0]);
  const b = createBundle(tinySummary(), stack, statics);
  const px = b.pixel(1, 0);
  assert.equal(px.hh[1], -2);
  assert.equal(px.hv[1], null);
  assert.equal(px.hydroperiodDays, 12);
  assert.deepEqual(b.lonLatToGrid(10.001, 0.019), { row: 0, col: 0 });
  assert.equal(b.lonLatToGrid(11, 0), null);
});

test("bundle rejects a stack of the wrong size", () => {
  assert.throws(() => createBundle(tinySummary(), new Uint8Array(3), new Uint8Array(8)), /stack\.bin/);
});

test("mercator round trip", () => {
  const [x, y] = lonLatToWorld(-91.7, 30.24, 12);
  const [lon, lat] = worldToLonLat(x, y, 12);
  assert.ok(Math.abs(lon + 91.7) < 1e-9 && Math.abs(lat - 30.24) < 1e-9);
});

test("ticks are round numbers", () => {
  assert.deepEqual(ticks(0, 140, 3), [0, 50, 100]);
});
