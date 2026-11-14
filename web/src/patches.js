// Patches of one class followed through the passes (docs/10 D-079), after the graph-based flood
// analysis of Debusscher & Van Coillie (Remote Sensing 2019, 11(16):1883): patches are delineated
// on each pass and linked to the next pass by spatial overlap, so each one keeps an identity and a
// history (born, grew, shrank, merged, split, gone) and a label can follow it while the timeline plays.

// 4-connected components of mask with at least minPx pixels.
// Returns { labels: Int32Array (0 = none, k = comps[k − 1]), comps: [{ size, area, r0, r1, c0, c1, sumR, sumC }] }.
export function components(mask, W, H, rowArea, minPx = 1) {
  const labels = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const comps = [];
  const small = [];
  for (let start = 0; start < W * H; start += 1) {
    if (!mask[start] || labels[start]) continue;
    const id = comps.length + small.length + 1;
    const c = { id, size: 0, area: 0, r0: H, r1: 0, c0: W, c1: 0, sumR: 0, sumC: 0 };
    let top = 0;
    stack[top++] = start;
    labels[start] = id;
    while (top) {
      const i = stack[--top];
      const r = (i / W) | 0;
      const col = i - r * W;
      c.size += 1;
      c.area += rowArea[r];
      c.sumR += r;
      c.sumC += col;
      if (r < c.r0) c.r0 = r;
      if (r > c.r1) c.r1 = r;
      if (col < c.c0) c.c0 = col;
      if (col > c.c1) c.c1 = col;
      if (col > 0 && mask[i - 1] && !labels[i - 1]) (labels[i - 1] = id), (stack[top++] = i - 1);
      if (col < W - 1 && mask[i + 1] && !labels[i + 1]) (labels[i + 1] = id), (stack[top++] = i + 1);
      if (r > 0 && mask[i - W] && !labels[i - W]) (labels[i - W] = id), (stack[top++] = i - W);
      if (r < H - 1 && mask[i + W] && !labels[i + W]) (labels[i + W] = id), (stack[top++] = i + W);
    }
    (c.size >= minPx ? comps : small).push(c);
  }
  // Renumber: kept components 1 … n, the rest 0.
  const map = new Int32Array(comps.length + small.length + 1);
  comps.forEach((c, k) => {
    map[c.id] = k + 1;
    delete c.id;
  });
  for (let i = 0; i < labels.length; i += 1) if (labels[i]) labels[i] = map[labels[i]];
  return { labels, comps };
}

// Pixel indices of component k (1-based) in a label image.
export function pixelsOf(labels, k, size) {
  const out = new Int32Array(size);
  let n = 0;
  for (let i = 0; i < labels.length && n < size; i += 1) if (labels[i] === k) out[n++] = i;
  return out;
}

// Follow patches through masks[0 … P−1]. Two patches on consecutive passes are linked when they
// share at least minShare of the smaller one's pixels. A patch continues the linked parent it
// shares most with (largest patches choose first); several parents make a merge, one parent with
// several children a split, and a patch with no parent is new. seen(p, i) says whether pixel i had
// radar on pass p: a patch that ends because the next pass did not see it is "unseen", not "gone".
// Returns { passes: [{ labels, comps }], tracks: [{ id, first, last, area: Float64Array(P) }] } where
// each comp gains { track, parents: [{ track, shared }], event, prevArea }.
export function followPatches(masks, W, H, rowArea, { minPx = 1, minShare = 0.1, seen = () => true } = {}) {
  const P = masks.length;
  const passes = [];
  const tracks = [];
  const newTrack = (p) => {
    const t = { id: tracks.length + 1, first: p, last: p, area: new Float64Array(P).fill(NaN), end: null };
    tracks.push(t);
    return t;
  };
  for (let p = 0; p < P; p += 1) {
    const cur = components(masks[p], W, H, rowArea, minPx);
    passes.push(cur);
    if (p === 0) {
      for (const c of cur.comps) Object.assign(c, { track: newTrack(0).id, parents: [], event: "new", prevArea: null });
    } else {
      const prev = passes[p - 1];
      // Shared pixel counts per (previous, current) pair.
      const K = cur.comps.length + 1;
      const shared = new Map();
      // Per previous patch: pixels the current pass did not see (for "unseen" below).
      const blind = new Int32Array(prev.comps.length + 1);
      for (let i = 0; i < W * H; i += 1) {
        const a = prev.labels[i];
        if (!a) continue;
        const b = cur.labels[i];
        if (b) shared.set(a * K + b, (shared.get(a * K + b) ?? 0) + 1);
        else if (!seen(p, i)) blind[a] += 1;
      }
      const links = [];
      for (const [key, n] of shared) {
        const a = Math.floor(key / K);
        const b = key % K;
        if (n >= minShare * Math.min(prev.comps[a - 1].size, cur.comps[b - 1].size)) links.push({ a, b, n });
      }
      const parentsOf = new Map();
      const childrenOf = new Map();
      for (const l of links) {
        if (!parentsOf.has(l.b)) parentsOf.set(l.b, []);
        parentsOf.get(l.b).push(l);
        childrenOf.set(l.a, (childrenOf.get(l.a) ?? 0) + 1);
      }
      const claimed = new Set();
      const order = cur.comps.map((c, k) => k + 1).sort((x, y) => cur.comps[y - 1].size - cur.comps[x - 1].size);
      for (const b of order) {
        const c = cur.comps[b - 1];
        const ps = (parentsOf.get(b) ?? []).sort((x, y) => y.n - x.n);
        c.parents = ps.map((l) => ({ track: prev.comps[l.a - 1].track, shared: l.n }));
        const heir = ps.find((l) => !claimed.has(prev.comps[l.a - 1].track));
        if (heir) {
          c.track = prev.comps[heir.a - 1].track;
          claimed.add(c.track);
        } else {
          c.track = newTrack(p).id;
        }
        c.prevArea = ps.length ? ps.reduce((s, l) => s + prev.comps[l.a - 1].area, 0) : null;
        if (!ps.length) c.event = "new";
        else if (ps.length > 1) c.event = "merged";
        else if (childrenOf.get(ps[0].a) > 1) c.event = "split";
        else c.event = c.area > 1.1 * c.prevArea ? "grew" : c.area < 0.9 * c.prevArea ? "shrank" : "steady";
      }
      // Tracks that stopped here: gone, or out of the radar's view on this pass.
      prev.comps.forEach((pc, k) => {
        if (claimed.has(pc.track)) return;
        tracks[pc.track - 1].end = { pass: p, why: blind[k + 1] > pc.size / 2 ? "unseen" : "gone" };
      });
    }
    for (const c of cur.comps) {
      const t = tracks[c.track - 1];
      t.area[p] = c.area;
      t.last = p;
    }
  }
  return { passes, tracks };
}
