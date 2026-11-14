// A minimal GeoTIFF writer (tools.js): uncompressed, one strip per band, a WGS 84 lat/lon grid
// (EPSG:4326, pixel is area), and a colour table for a single uint8 band. Enough for QGIS, ArcGIS
// and GDAL to place the file; no dependency (CLAUDE.md rule 6). Little-endian ("II"), like the
// typed arrays it copies from on every platform the app runs on.

const TYPE = { ASCII: 2, SHORT: 3, LONG: 4, DOUBLE: 12 };
const BYTES = { 2: 1, 3: 2, 4: 4, 12: 8 };

// TIFF ASCII is 7-bit: anything else becomes "?" (descriptions are technical keys, like CSV headers).
const ascii = (text) => [...`${text}\0`].map((c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63));

// TIFF colour map: 256 reds, then greens, then blues, 16 bits each.
function colourMap(palette) {
  const out = new Array(768).fill(0);
  palette.forEach(([r, g, b], i) => {
    out[i] = r * 257;
    out[256 + i] = g * 257;
    out[512 + i] = b * 257;
  });
  return out;
}

function put(dv, type, at, v) {
  if (type === TYPE.ASCII) dv.setUint8(at, v);
  else if (type === TYPE.SHORT) dv.setUint16(at, v, true);
  else if (type === TYPE.LONG) dv.setUint32(at, v, true);
  else dv.setFloat64(at, v, true);
}

const align8 = (n) => n + ((8 - (n % 8)) % 8);

// bands: Uint8Arrays (8-bit unsigned) or Float32Arrays (32-bit float), each width × height, row 0
// at the north edge. palette: [[r, g, b], ...] by value, for one uint8 band. nodata: GDAL_NODATA.
export function geoTiff({ width: W, height: H, bounds: [west, south, east, north], bands, palette = null, nodata = null, description = "" }) {
  const float = bands[0] instanceof Float32Array;
  const n = bands.length;
  const bits = float ? 32 : 8;
  const planeBytes = W * H * (bits / 8);
  const entries = [
    [256, TYPE.LONG, [W]],
    [257, TYPE.LONG, [H]],
    [258, TYPE.SHORT, new Array(n).fill(bits)],
    [259, TYPE.SHORT, [1]], // no compression
    [262, TYPE.SHORT, [palette ? 3 : 1]], // palette colour, or grey with 0 = black
    ...(description ? [[270, TYPE.ASCII, ascii(description)]] : []),
    [273, TYPE.LONG, new Array(n).fill(0)], // strip offsets, known once the layout is
    [277, TYPE.SHORT, [n]],
    [278, TYPE.LONG, [H]],
    [279, TYPE.LONG, new Array(n).fill(planeBytes)],
    [284, TYPE.SHORT, [n > 1 ? 2 : 1]], // whole bands one after another
    ...(palette ? [[320, TYPE.SHORT, colourMap(palette)]] : []),
    [339, TYPE.SHORT, new Array(n).fill(float ? 3 : 1)], // IEEE float, or unsigned integer
    [33550, TYPE.DOUBLE, [(east - west) / W, (north - south) / H, 0]], // ModelPixelScale
    [33922, TYPE.DOUBLE, [0, 0, 0, west, north, 0]], // ModelTiepoint: pixel (0, 0) at the north-west corner
    // GeoKeys: version 1.1.0, 4 keys: geographic model, pixel is area, WGS 84, degrees.
    [34735, TYPE.SHORT, [1, 1, 0, 4, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326, 2054, 0, 1, 9102]],
    ...(nodata !== null ? [[42113, TYPE.ASCII, ascii(String(nodata))]] : []),
  ];
  // Header (8 bytes), the one IFD, values too big for an entry (8-byte aligned), then the bands.
  let cursor = 8 + 2 + entries.length * 12 + 4;
  const at = entries.map(([, type, values]) => {
    const size = BYTES[type] * values.length;
    if (size <= 4) return null;
    cursor = align8(cursor);
    const where = cursor;
    cursor += size;
    return where;
  });
  const dataAt = align8(cursor);
  entries.find((e) => e[0] === 273)[2] = bands.map((_, i) => dataAt + i * planeBytes);

  const buf = new ArrayBuffer(dataAt + n * planeBytes);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true); // "II"
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, values], i) => {
    const p = 10 + i * 12;
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, values.length, true);
    const base = at[i] ?? p + 8;
    values.forEach((v, k) => put(dv, type, base + k * BYTES[type], v));
    if (at[i] !== null) dv.setUint32(p + 8, at[i], true);
  });
  dv.setUint32(10 + entries.length * 12, 0, true); // no further IFD
  bands.forEach((b, i) => new Uint8Array(buf, dataAt + i * planeBytes, planeBytes).set(new Uint8Array(b.buffer, b.byteOffset, planeBytes)));
  return new Uint8Array(buf);
}
