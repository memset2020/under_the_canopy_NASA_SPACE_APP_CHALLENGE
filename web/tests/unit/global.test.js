import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGlobal } from "../../src/data.js";
import { describeCell } from "../../src/globe.js";
import { pctileBand, viewSummary, worldCh4TonnesYr } from "../../src/here.js";

// A 4 × 2 world at 90° cells: enough to check indexing and every encoding.
function fakeGlobal() {
  const layers = [
    { id: "likely", encoding: "class" },
    { id: "nisar_passes", encoding: "count" },
    { id: "nisar_first_day", encoding: "day" },
    { id: "nisar_last_day", encoding: "day" },
    { id: "forest_pct", encoding: "percent" },
    { id: "wetland_pct", encoding: "percent" },
    { id: "cygnss_max_pct", encoding: "percent" },
    { id: "cygnss_range_pct", encoding: "percent" },
    { id: "canopy_height_m", encoding: "half_m" },
    { id: "people", encoding: "log_people" },
  ];
  const meta = {
    grid: { res_deg: 90, width: 4, height: 2, bounds: [-180, -90, 180, 90] },
    binary: "global.bin", nodata: 255, nisar_window: { start: "2026-06-17", end: "2026-10-07" },
    min_passes_detailed: 6, cygnss_months: 12, layers,
  };
  const plane = 8;
  const bytes = new Uint8Array(layers.length * plane).fill(255);
  // cell row 1 (south), col 1 (-90…0 lon): a flooded forest
  const set = (k, v) => { bytes[k * plane + 1 * 4 + 1] = v; };
  [2, 7, 14, 100, 90, 4, 40, 30, 42, 100].forEach((v, k) => set(k, v));
  const files = { "data/manifest.json": null, "data/global/global.json": meta, "data/global/global.bin": bytes };
  const fetchFn = async (url) => ({
    ok: url in files,
    status: url in files ? 200 : 404,
    json: async () => files[url],
    arrayBuffer: async () => files[url].buffer,
  });
  return { fetchFn, manifest: { global: "global/global.json" } };
}

test("loadGlobal decodes every documented encoding at the right cell", async () => {
  const { fetchFn, manifest } = fakeGlobal();
  const g = await loadGlobal("data/", manifest, fetchFn);
  const v = g.cell(-60.3, -3.4).values;
  assert.equal(v.likely, 2);
  assert.equal(v.nisar_passes, 7);
  assert.equal(v.nisar_first_day, "2026-07-01");
  assert.equal(v.canopy_height_m, 21);
  assert.equal(v.people, 9999);
  assert.equal(g.cell(100, 45).values.forest_pct, null); // no data elsewhere
  assert.equal(g.url("likely.png"), "data/global/likely.png");
});

test("describeCell says enough passes and names the water sign", async () => {
  const { fetchFn, manifest } = fakeGlobal();
  const g = await loadGlobal("data/", manifest, fetchFn);
  const t = (key, p = {}) => `${key}${Object.keys(p).length ? JSON.stringify(p) : ""}`;
  const facts = describeCell(g.cell(-60.3, -3.4).values, g.meta, t);
  assert.ok(facts[0].startsWith("globe.likely_2"));
  assert.ok(facts[1].startsWith("globe.nisar_enough"));
  assert.ok(facts.some((f) => f.startsWith("globe.cygnss{")));
  assert.equal(await loadGlobal("data/", { global: null }, fetchFn), null);
});

test("percentile bands follow the US Drought Monitor classes, mirrored for wet", () => {
  const cases = [[0.2, "very_dry"], [10, "very_dry"], [10.5, "dry"], [30, "dry"], [30.5, "normal"], [69.9, "normal"], [70, "wet"], [89.9, "wet"], [90, "very_wet"], [100, "very_wet"]];
  for (const [p, band] of cases) assert.equal(pctileBand(p), band, `p = ${p}`);
});

// WetCHARTs planes (encoding log_mg): mean, lowest and highest member, in one 90° cell.
async function fakeCh4() {
  const layers = [
    { id: "likely", encoding: "class" },
    { id: "nisar_passes", encoding: "count" },
    { id: "wetland_ch4", encoding: "log_mg" },
    { id: "wetland_ch4_lo", encoding: "log_mg" },
    { id: "wetland_ch4_hi", encoding: "log_mg" },
  ];
  const meta = {
    grid: { res_deg: 90, width: 4, height: 2, bounds: [-180, -90, 180, 90] },
    binary: "global.bin", nodata: 255, nisar_window: { start: "2026-06-17", end: "2026-10-07" },
    min_passes_detailed: 6, cygnss_months: 12, layers,
    wetland_ch4: { year: 2021, members: 18, total_tg: 164.9, member_total_tg: [123, 206.8], extent_moved_pct: 49.2, q10_moved_pct: 22.7, version: "WetCHARTs v1.3.3" },
  };
  const q = (mg) => Math.round(Math.log10(mg + 1) * 80);
  const bytes = new Uint8Array(layers.length * 8).fill(255);
  [0, 0, q(100), q(40), q(250)].forEach((v, k) => { bytes[k * 8 + 5] = v; }); // row 1, col 1
  bytes[2 * 8 + 6] = q(0.01); // a dry neighbour that must not make a fact
  const files = { "data/global/global.json": meta, "data/global/global.bin": bytes };
  const fetchFn = async (url) => ({ ok: url in files, status: 200, json: async () => files[url], arrayBuffer: async () => files[url].buffer });
  return loadGlobal("data/", { global: "global/global.json" }, fetchFn);
}

test("log_mg decodes WetCHARTs methane within the 2.9 % step", async () => {
  const g = await fakeCh4();
  const v = g.cell(-60, -40).values;
  assert.ok(Math.abs(v.wetland_ch4 - 100) / 100 < 0.03);
  assert.ok(Math.abs(v.wetland_ch4_hi - 250) / 250 < 0.03);
  assert.equal(g.cell(100, 45).values.wetland_ch4, null);
});

test("describeCell gives methane with the ensemble range, never for dry cells", async () => {
  const g = await fakeCh4();
  const t = (key, p = {}) => `${key}${JSON.stringify(p)}`;
  const fact = describeCell(g.cell(-60, -40).values, g.meta, t).find((f) => f.startsWith("globe.ch4"));
  assert.ok(fact, "a methane fact");
  const p = JSON.parse(fact.slice("globe.ch4".length));
  assert.equal(p.n, "18");
  assert.equal(p.year, "2021");
  assert.equal(p.mg, "99"); // 100 mg encodes to q = 160, which decodes to 10² − 1
  assert.ok(Number(p.lo) < Number(p.mg) && Number(p.mg) < Number(p.hi));
  assert.ok(!describeCell(g.cell(60, -40).values, g.meta, t).some((f) => f.startsWith("globe.ch4")));
});

test("In view sums methane in tonnes a year and a world view holds all of it", async () => {
  const g = await fakeCh4();
  const world = worldCh4TonnesYr(g);
  const cellKm2 = (90 * 111.32) ** 2 * Math.cos((-45 * Math.PI) / 180);
  const expected = (10 ** (Math.round(Math.log10(101) * 80) / 80) - 1) * cellKm2 * 0.365 + (10 ** (Math.round(Math.log10(1.01) * 80) / 80) - 1) * cellKm2 * 0.365;
  assert.ok(Math.abs(world - expected) / expected < 1e-9);
  const one = viewSummary(g, [-89, -80, -1, -10]).ch4TonnesYr;
  assert.ok(one > 0.99 * world); // that cell holds nearly all of it
  assert.equal(viewSummary(g, [100, 10, 170, 80]).ch4TonnesYr, 0);
});
