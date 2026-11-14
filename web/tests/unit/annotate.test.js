import { test } from "node:test";
import assert from "node:assert/strict";
import { blockMask, interiorPoint, largestPatch, nearestOnRect, outlinePath, patchBox, placeLabel, quantile } from "../../src/annotate.js";

test("largestPatch picks the biggest 4-connected blob by area", () => {
  // 5 × 4 grid: a 3-pixel blob top-left, a 4-pixel blob bottom-right, a diagonal non-neighbour.
  const W = 5;
  const H = 4;
  const m = new Uint8Array([
    1, 1, 0, 0, 0,
    1, 0, 0, 0, 1,
    0, 0, 0, 1, 1,
    0, 0, 0, 1, 1,
  ]);
  const p = largestPatch(m, W, H, new Float64Array(H).fill(0.5));
  assert.equal(p.size, 5);
  assert.equal(p.area, 2.5);
  assert.deepEqual([p.r0, p.r1, p.c0, p.c1], [1, 3, 3, 4]);
  assert.deepEqual([...p.pixels].sort((a, b) => a - b), [9, 13, 14, 18, 19]);
  assert.equal(largestPatch(new Uint8Array(W * H), W, H, new Float64Array(H).fill(1)), null);
});

test("the outline traces the outer edge only, holes filled", () => {
  // A 3 × 3 ring with a hole in the middle: the outline is the 3 × 3 square, 12 unit edges.
  const W = 5;
  const m = new Uint8Array(25);
  for (const i of [6, 7, 8, 11, 13, 16, 17, 18]) m[i] = 1;
  const p = largestPatch(m, W, 5, new Float64Array(5).fill(1));
  const d = outlinePath(patchBox(p, W));
  assert.equal(d, "M1 1h3M1 4h3M1 1v3M4 1v3");
});

test("the anchor sits inside the patch, in its most solid part", () => {
  // An L: a thin arm (1 px) and a solid 5 × 5 block; the centroid falls outside the L,
  // the anchor must be the block's centre.
  const W = 12;
  const H = 12;
  const m = new Uint8Array(W * H);
  for (let c = 0; c < 12; c += 1) m[c] = 1; // thin top arm
  for (let r = 0; r < 12; r += 1) m[r * W] = 1; // thin left arm
  for (let r = 6; r < 11; r += 1) for (let c = 6; c < 11; c += 1) m[r * W + c] = 1;
  for (let r = 1; r < 7; r += 1) m[r * W + 8] = 1; // joins the block to the top arm
  const p = largestPatch(m, W, H, new Float64Array(H).fill(1));
  const [r, c] = interiorPoint(p, W, 2);
  assert.equal(m[r * W + c], 1);
  assert.deepEqual([r, c], [8, 8]);
});

test("labels avoid map controls and prefer the margin off the data", () => {
  const view = { w: 800, h: 600 };
  const site = { x: 200, y: 100, w: 400, h: 400 };
  const control = { x: 0, y: 0, w: 190, h: 600 };
  const r = placeLabel({ anchor: [220, 300], w: 160, h: 40, view, site, obstacles: [control] });
  const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  assert.ok(!hit(r, control), "on a control");
  assert.ok(!hit(r, site), "on the data");
  assert.ok(r.x >= 8 && r.y >= 8 && r.x + r.w <= 792 && r.y + r.h <= 592, "off screen");
  const [lx, ly] = nearestOnRect(r, 220, 300);
  assert.ok(Math.hypot(lx - 220, ly - 300) < 260, "leader too long");
});

test("blockMask keeps blocks whose measured median passes, and quantile is nearest-rank", () => {
  const W = 4;
  const H = 2;
  // Left 2 × 2 block: two measured values (half the block), median 5; right block: one value (a quarter), 9.
  const v = [5, 0, 0, 9, 5, 0, 0, 0];
  const ok = (i) => v[i] !== 0;
  assert.deepEqual([...blockMask(ok, (i) => v[i], W, H, 2, (m) => m >= 4)], [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.deepEqual([...blockMask(ok, (i) => v[i], W, H, 2, (m) => m >= 6)], [0, 0, 1, 1, 0, 0, 1, 1]);
  assert.equal(quantile([3, 1, 2, 4], 0.5), 2);
  assert.ok(Number.isNaN(quantile([], 0.5)));
});

test("leaders and labels: segment–rectangle test, block grouping, fixed trend window", async () => {
  const { areaTrend, blockShare, segmentHitsRect } = await import("../../src/annotate.js");
  const r = { x: 10, y: 10, w: 10, h: 10 };
  assert.equal(segmentHitsRect([0, 0, 30, 30], r), true);
  assert.equal(segmentHitsRect([0, 0, 30, 0], r), false);
  assert.equal(segmentHitsRect([15, 15, 16, 16], r), true); // inside
  // 4 × 2 grid, 2 × 2 blocks: the left block has 1 of 4 set (a quarter), the right none.
  assert.deepEqual([...blockShare(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 0]), 4, 2, 2, 0.25)], [1, 1, 0, 0, 1, 1, 0, 0]);
  // Ten passes falling 1 km² every 12 days: the window is the last six up to the shown pass.
  const passes = Array.from({ length: 10 }, (_, k) => ({ date: new Date(Date.UTC(2026, 5, 1 + 12 * k)).toISOString().slice(0, 10), flooded_veg_km2: 50 - k }));
  const tr = areaTrend(passes, 9);
  assert.equal(tr.n, 6);
  assert.ok(Math.abs(tr.perDay + 1 / 12) < 1e-9);
  assert.ok(Math.abs(tr.p - 2 / 720) < 1e-12 && tr.exact);
  assert.equal(areaTrend(passes, 3).p, undefined); // four passes: too few to claim a trend
});
