import { test } from "node:test";
import assert from "node:assert/strict";
import { geoTiff } from "../../src/geotiff.js";

// A tiny TIFF reader for the tags the writer sets (little-endian, one IFD).
function readTags(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(dv.getUint16(0, true), 0x4949);
  assert.equal(dv.getUint16(2, true), 42);
  const ifd = dv.getUint32(4, true);
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const tags = {};
  for (let i = 0; i < dv.getUint16(ifd, true); i += 1) {
    const p = ifd + 2 + i * 12;
    const [tag, type, count] = [dv.getUint16(p, true), dv.getUint16(p + 2, true), dv.getUint32(p + 4, true)];
    const base = size[type] * count > 4 ? dv.getUint32(p + 8, true) : p + 8;
    const get = (k) => {
      const q = base + k * size[type];
      return type === 2 ? dv.getUint8(q) : type === 3 ? dv.getUint16(q, true) : type === 4 ? dv.getUint32(q, true) : dv.getFloat64(q, true);
    };
    const values = Array.from({ length: count }, (_, k) => get(k));
    tags[tag] = type === 2 ? String.fromCharCode(...values.slice(0, -1)) : values;
  }
  return tags;
}

test("a class GeoTIFF carries size, colour table, WGS 84 keys and the pixels", () => {
  const data = Uint8Array.from([0, 1, 2, 3, 4, 13]);
  const out = geoTiff({ width: 3, height: 2, bounds: [-61, -4, -58, -2], bands: [data], palette: [[0, 0, 0], [235, 235, 235], [0, 114, 178], [230, 159, 0]], nodata: 0, description: "classes: 3=water_under_vegetation, ünïcode" });
  const tags = readTags(out);
  assert.deepEqual([tags[256][0], tags[257][0], tags[258][0], tags[262][0], tags[277][0]], [3, 2, 8, 3, 1]);
  assert.deepEqual(tags[33550], [1, 1, 0]); // 1° per pixel both ways
  assert.deepEqual(tags[33922], [0, 0, 0, -61, -2, 0]); // north-west corner
  assert.deepEqual(tags[34735].slice(0, 4), [1, 1, 0, 4]);
  assert.ok(tags[34735].includes(4326));
  assert.equal(tags[42113], "0");
  assert.equal(tags[270], "classes: 3=water_under_vegetation, ?n?code"); // 7-bit ASCII only
  assert.equal(tags[320].length, 768);
  assert.deepEqual([tags[320][3], tags[320][256 + 3], tags[320][512 + 3]], [230 * 257, 159 * 257, 0]);
  const off = tags[273][0];
  assert.equal(off % 8, 0);
  assert.deepEqual(Array.from(out.subarray(off, off + 6)), Array.from(data));
  // Tags in ascending order, as TIFF requires.
  const ids = Object.keys(tags).map(Number);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
});

test("a two-band float GeoTIFF keeps both planes in order, NaN as no data", () => {
  const hh = Float32Array.from([-8.5, -12.25, NaN, -3]);
  const hv = Float32Array.from([-15, -22.5, NaN, -9.75]);
  const out = geoTiff({ width: 2, height: 2, bounds: [0, 0, 0.002, 0.002], bands: [hh, hv], nodata: "nan" });
  const tags = readTags(out);
  assert.deepEqual([tags[258], tags[277][0], tags[284][0], tags[339]], [[32, 32], 2, 2, [3, 3]]);
  assert.equal(tags[42113], "nan");
  const read = (offset) => new Float32Array(out.buffer.slice(out.byteOffset + offset, out.byteOffset + offset + 16));
  const [a, b] = tags[273];
  assert.equal(b - a, 16);
  assert.deepEqual(Array.from(read(a)).map((v) => (Number.isNaN(v) ? "nan" : v)), [-8.5, -12.25, "nan", -3]);
  assert.deepEqual(Array.from(read(b)).map((v) => (Number.isNaN(v) ? "nan" : v)), [-15, -22.5, "nan", -9.75]);
});
