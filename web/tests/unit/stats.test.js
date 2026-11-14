// Change statistics (omnibus.js), trends (trend.js) and patch following (patches.js): docs/10 D-079.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DIR, chi2Sf, enlFromLogRatioVar, m2logR, pixelChanges, trigamma } from "../../src/omnibus.js";
import { mahonian, mannKendall, theilSen } from "../../src/trend.js";
import { components, followPatches } from "../../src/patches.js";

// Small deterministic PRNG and a gamma(m, 1/m) sampler (Marsaglia–Tsang), for simulated speckle.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) + 0.5) / 2 ** 32;
}
function gammaSampler(u) {
  const normal = () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
  return (m) => {
    const d = m - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = normal();
      const v = (1 + c * x) ** 3;
      if (v > 0 && Math.log(u()) < 0.5 * x * x + d - d * v + d * Math.log(v)) return (d * v) / m;
    }
  };
}

test("chi-square tail and trigamma match closed forms", () => {
  assert.ok(Math.abs(chi2Sf(2, 2) - Math.exp(-1)) < 1e-12);
  assert.ok(Math.abs(chi2Sf(9.21034, 2) - 0.01) < 1e-6); // the 1 % point of χ²₂
  assert.ok(Math.abs(chi2Sf(13.2767, 4) - 0.01) < 1e-5); // the 1 % point of χ²₄
  assert.equal(chi2Sf(0, 6), 1);
  assert.ok(Math.abs(trigamma(1) - Math.PI ** 2 / 6) < 1e-9);
  assert.ok(Math.abs(trigamma(0.5) - Math.PI ** 2 / 2) < 1e-9);
  // var(ln ratio) = 2ψ₁(m) inverts back to m.
  for (const m of [3, 13, 70]) assert.ok(Math.abs(enlFromLogRatioVar(2 * trigamma(m)) - m) / m < 1e-6);
});

test("omnibus statistic is zero for equal images and grows with the ratio", () => {
  assert.ok(m2logR(2, 1, 1, 1, 1, 10) < 1e-12);
  assert.ok(m2logR(2, 1, 1, 2, 2, 10) > m2logR(2, 1, 1, 1.5, 1.5, 10));
});

test("sequential test: false alarms near alpha, a step found at its pass with its direction", () => {
  const g = gammaSampler(rng(7));
  const m = 13;
  const k = 8;
  let alarms = 0;
  const N = 4000;
  for (let n = 0; n < N; n += 1) {
    const a = Array.from({ length: k }, () => 0.3 * g(m));
    const b = Array.from({ length: k }, () => 0.05 * g(m));
    if (pixelChanges(a, b, m).length) alarms += 1;
  }
  assert.ok(alarms / N < 0.02, `false alarm rate ${alarms / N}`);
  // HH up 6 dB and HV down 3 dB from pass 4: water arriving under trees (double bounce).
  let found = 0;
  for (let n = 0; n < 500; n += 1) {
    const a = Array.from({ length: k }, (_, p) => 0.3 * g(m) * (p >= 4 ? 10 ** 0.6 : 1));
    const b = Array.from({ length: k }, (_, p) => 0.05 * g(m) * (p >= 4 ? 10 ** -0.3 : 1));
    const ch = pixelChanges(a, b, m);
    if (ch.some(([p, d]) => p === 4 && d === DIR.HH_UP)) found += 1;
  }
  assert.ok(found / 500 > 0.8, `power ${found / 500}`);
});

test("Mann–Kendall exact p-values and Theil–Sen slope", () => {
  assert.deepEqual(mahonian(3), [1, 2, 2, 1]);
  assert.equal(mahonian(5).reduce((a, b) => a + b), 120);
  // A strictly increasing series of n: p = 2 / n!.
  assert.ok(Math.abs(mannKendall([1, 2, 3, 4, 5]).p - 2 / 120) < 1e-12);
  assert.ok(Math.abs(mannKendall([1, 2, 3, 4]).p - 2 / 24) < 1e-12); // n = 4 can never reach 0.05
  assert.equal(mannKendall([5, 4, 3, 2, 1, 0]).s, -15);
  const flat = mannKendall([3, 1, 4, 1, 5]);
  assert.equal(flat.exact, false); // a tie: normal approximation, said so
  assert.ok(flat.p > 0.2);
  assert.equal(theilSen([0, 1, 2, 3, 4], [0, 2, 4, 6, 100]), 2); // one outlier does not move it
});

test("patches are followed through passes: grew, merged, split, gone, unseen", () => {
  const W = 6;
  const H = 1;
  const area = new Float64Array(H).fill(1);
  const m = (s) => Uint8Array.from(s, (ch) => (ch === "#" ? 1 : 0));
  // Pass 0: two patches; 1: they merge; 2: the merged patch splits; 3: one half gone, one out of view.
  const masks = [m("##..##"), m("######"), m("##..##"), m("##....")];
  const seen = (p, i) => !(p === 3 && i >= 4);
  const { passes, tracks } = followPatches(masks, W, H, area, { seen });
  assert.equal(components(masks[0], W, H, area).comps.length, 2);
  assert.equal(passes[1].comps[0].event, "merged");
  assert.equal(passes[1].comps[0].parents.length, 2);
  assert.ok(passes[2].comps.every((c) => c.event === "split"));
  assert.equal(passes[2].comps.filter((c) => c.track === passes[1].comps[0].track).length, 1);
  const right = passes[2].comps.find((c) => c.c0 === 4);
  assert.equal(tracks[right.track - 1].end.why, "unseen");
  assert.ok(tracks.every((t) => t.area.length === 4));
});
