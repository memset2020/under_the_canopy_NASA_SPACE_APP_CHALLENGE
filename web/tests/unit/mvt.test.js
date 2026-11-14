// The vector-tile decoder against a real NASA GIBS orbit-track tile (NISAR ascending,
// 5 Oct 2026, EPSG:4326 "2km" level 1, row 0, col 1), saved decompressed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeGeometry, decodeTile, tileToLonLat } from "../../src/mvt.js";

const bytes = readFileSync(new URL("./fixtures/orbit_nisar_asc_2026-10-05_1_0_1.mvt", import.meta.url));

test("decodes the GIBS orbit tile: 13 orbit lines and 323 one-minute points", () => {
  const [layer, ...rest] = decodeTile(bytes);
  assert.equal(rest.length, 0);
  assert.equal(layer.name, "OrbitTracks_NISAR_Ascending");
  assert.equal(layer.extent, 4096);
  const lines = layer.features.filter((f) => f.type === "line");
  const points = layer.features.filter((f) => f.type === "point");
  assert.equal(lines.length, 13);
  assert.equal(points.length, 323);
  const p = points.find((f) => f.props.id === "P7733");
  assert.equal(p.props.datetime, "2026-10-04T23:00:00+00:00");
  assert.equal(p.props.direction, "Ascending");
  assert.equal(p.props.hour, 23);
  assert.equal(p.paths.length, 1);
  assert.ok(lines.every((f) => f.paths.every((path) => path.length >= 2)));
});

test("coordinates map to lon/lat within the tile span plus its buffer", () => {
  const [layer] = decodeTile(bytes);
  const span = 144; // level 1 of the 2km set: col 1 covers 36°W to 108°E, row 0 90°N to 54°S
  const buffer = (1024 / 4096) * span; // GIBS tiles carry features up to ~20 % past the edge
  for (const f of layer.features) {
    for (const path of f.paths) {
      for (const pt of path) {
        const [lon, lat] = tileToLonLat(pt, { x: 1, y: 0, spanDeg: span, extent: layer.extent });
        assert.ok(lon > -36 - buffer && lon < 108 + buffer, `lon ${lon}`);
        assert.ok(lat < 90 + buffer && lat > -54 - buffer, `lat ${lat}`);
      }
    }
  }
});

test("one-minute points move at orbital ground speed (about 6.5 km/s at 747 km)", () => {
  const [layer] = decodeTile(bytes);
  const at = (id) => tileToLonLat(layer.features.find((f) => f.props.id === id).paths[0][0], { x: 1, y: 0, spanDeg: 144, extent: 4096 });
  const [a, b] = [at("P7733"), at("P7734")];
  const rad = Math.PI / 180;
  const d = 2 * 6371 * Math.asin(Math.sqrt(Math.sin(((b[1] - a[1]) * rad) / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(((b[0] - a[0]) * rad) / 2) ** 2));
  assert.ok(d / 60 > 6 && d / 60 < 7.2, `${(d / 60).toFixed(2)} km/s`);
});

test("geometry commands: MoveTo, LineTo with zigzag deltas, ClosePath", () => {
  // MoveTo(1) (2,2); LineTo(2) (+3,0) (0,+4); ClosePath
  const cmds = [9, 4, 4, 18, 6, 0, 0, 8, 15];
  assert.deepEqual(decodeGeometry(cmds), [[[2, 2], [5, 2], [5, 6], [2, 2]]]);
});
