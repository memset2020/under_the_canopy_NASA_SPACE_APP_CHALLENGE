// A small Mapbox Vector Tile (v2) decoder: enough for NASA GIBS orbit tracks (lines and
// points with properties). Pure functions, no DOM; the spec is protobuf + zigzag commands.

function reader(bytes) {
  let pos = 0;
  const varint = () => {
    let v = 0;
    let mult = 1;
    for (;;) {
      const b = bytes[pos++];
      v += (b & 0x7f) * mult; // arithmetic, not bit shifts: values can exceed 32 bits
      if (b < 0x80) return v;
      mult *= 128;
    }
  };
  return {
    get pos() {
      return pos;
    },
    done: () => pos >= bytes.length,
    varint,
    // One field: [number, wireType, value]. Length-delimited values come back as a subarray.
    field() {
      const key = varint();
      const num = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === 0) return [num, wire, varint()];
      if (wire === 2) {
        const n = varint();
        const v = bytes.subarray(pos, pos + n);
        pos += n;
        return [num, wire, v];
      }
      if (wire === 1) {
        const v = new DataView(bytes.buffer, bytes.byteOffset + pos, 8).getFloat64(0, true);
        pos += 8;
        return [num, wire, v];
      }
      if (wire === 5) {
        const v = new DataView(bytes.buffer, bytes.byteOffset + pos, 4).getFloat32(0, true);
        pos += 4;
        return [num, wire, v];
      }
      throw new Error(`mvt: unsupported wire type ${wire}`);
    },
  };
}

const utf8 = new TextDecoder();

function packed(bytes) {
  const r = reader(bytes);
  const out = [];
  while (!r.done()) out.push(r.varint());
  return out;
}

const zigzag = (n) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function value(bytes) {
  const r = reader(bytes);
  let v = null;
  while (!r.done()) {
    const [num, , x] = r.field();
    if (num === 1) v = utf8.decode(x);
    else if (num === 2 || num === 3) v = x; // float, double
    else if (num === 4 || num === 5) v = x; // int64, uint64 (as plain numbers)
    else if (num === 6) v = zigzag(x); // sint64
    else if (num === 7) v = Boolean(x);
  }
  return v;
}

// Geometry commands to arrays of [x, y] paths in tile units (0..extent).
export function decodeGeometry(cmds) {
  const paths = [];
  let path = null;
  let x = 0;
  let y = 0;
  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i++];
    const id = c & 7;
    const count = c >> 3;
    if (id === 7) {
      if (path && path.length) path.push(path[0].slice()); // ClosePath
      continue;
    }
    for (let k = 0; k < count; k += 1) {
      x += zigzag(cmds[i++]);
      y += zigzag(cmds[i++]);
      if (id === 1) {
        path = [[x, y]];
        paths.push(path);
      } else if (id === 2 && path) {
        path.push([x, y]);
      }
    }
  }
  return paths;
}

const TYPES = { 1: "point", 2: "line", 3: "polygon" };

// Decode a whole tile: [{ name, extent, features: [{ type, props, paths }] }].
export function decodeTile(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const tile = reader(bytes);
  const layers = [];
  while (!tile.done()) {
    const [num, , layerBytes] = tile.field();
    if (num !== 3) continue;
    const lr = reader(layerBytes);
    const layer = { name: "", extent: 4096, features: [] };
    const keys = [];
    const values = [];
    const raw = [];
    while (!lr.done()) {
      const [n, , v] = lr.field();
      if (n === 1) layer.name = utf8.decode(v);
      else if (n === 2) raw.push(v);
      else if (n === 3) keys.push(utf8.decode(v));
      else if (n === 4) values.push(value(v));
      else if (n === 5) layer.extent = v;
    }
    for (const fb of raw) {
      const fr = reader(fb);
      const feature = { type: "unknown", props: {}, paths: [] };
      while (!fr.done()) {
        const [n, , v] = fr.field();
        if (n === 2) {
          const tags = packed(v);
          for (let k = 0; k + 1 < tags.length; k += 2) feature.props[keys[tags[k]]] = values[tags[k + 1]];
        } else if (n === 3) feature.type = TYPES[v] ?? "unknown";
        else if (n === 4) feature.paths = decodeGeometry(packed(v));
      }
      layer.features.push(feature);
    }
    layers.push(layer);
  }
  return layers;
}

// Tile units to lon/lat for a geographic (EPSG:4326) tile whose top-left is (-180, 90).
// Tiles of a GIBS EPSG:4326 level ({ cols, rows, span_deg }, top-left -180°, 90°) that touch a
// lon/lat box.
export function tilesFor(level, [west, south, east, north]) {
  const span = level.span_deg;
  const x0 = Math.max(0, Math.floor((Math.max(west, -180) + 180) / span));
  const x1 = Math.min(level.cols - 1, Math.floor((Math.min(east, 180) + 180) / span));
  const y0 = Math.max(0, Math.floor((90 - Math.min(north, 90)) / span));
  const y1 = Math.min(level.rows - 1, Math.floor((90 - Math.max(south, -90)) / span));
  const out = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) out.push({ x, y });
  return out;
}

export function tileToLonLat([tx, ty], { x, y, spanDeg, extent }) {
  return [-180 + (x + tx / extent) * spanDeg, 90 - (y + ty / extent) * spanDeg];
}
