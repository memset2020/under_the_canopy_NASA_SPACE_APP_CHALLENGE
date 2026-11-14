// Change statistics for the radar time series, in the browser (docs/10 D-079).
// Sequential omnibus likelihood-ratio test for a series of multilook SAR intensities (Conradsen,
// Nielsen & Skriver 2016, IEEE TGRS 54(5):3007; as run on Sentinel-1 by Canty et al. 2020, Remote
// Sensing 12(1):46), diagonal dual-pol case (HH, HV). Per pixel it says at which passes the
// backscatter changed beyond speckle, in which direction, with a stated false-alarm rate.

// Significance level of every test (Canty et al. use 0.01 for change maps).
export const ALPHA = 0.01;

// ψ₁, by recurrence up to 6 then the asymptotic series; |error| < 1e-9 for x > 0.
export function trigamma(x) {
  let r = 0;
  while (x < 6) {
    r += 1 / (x * x);
    x += 1;
  }
  const f = 1 / (x * x);
  return r + 1 / x + f / 2 + (f / x) * (1 / 6 - f * (1 / 30 - f * (1 / 42 - f / 30)));
}

// For gamma speckle with m looks, var(ln I₁ − ln I₂) = 2ψ₁(m); solve for m (bisection in log m).
export function enlFromLogRatioVar(v) {
  let lo = 0.2;
  let hi = 1e5;
  for (let k = 0; k < 80; k += 1) {
    const mid = Math.sqrt(lo * hi);
    if (2 * trigamma(mid) > v) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

// Upper tail of χ² with an even number of degrees of freedom (every test here has df = 2k):
// P(χ²₂ₖ > x) = e^(−x/2) Σᵢ<ₖ (x/2)ⁱ / i!.
export function chi2Sf(x, df) {
  if (!(x > 0)) return 1;
  const h = x / 2;
  let term = 1;
  let sum = 1;
  for (let i = 1; i < df / 2; i += 1) {
    term *= h / i;
    sum += term;
  }
  return Math.min(1, Math.exp(-h) * sum);
}

// Decoded linear intensity for every quantised byte of a layer (0 = nodata → NaN).
function linearTable(layer) {
  return Float64Array.from({ length: 256 }, (_, q) =>
    q === layer.nodata ? NaN : 10 ** ((q * layer.scale + layer.offset) / 10),
  );
}

const quantileSorted = (a, q) => a[Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))))];

// Equivalent number of looks of the speckle, from the same pixel on consecutive passes: in the
// log-ratio the landscape's texture cancels and only speckle and real change remain. The scene-wide
// median is removed (calibration, moisture), the central 90 % is kept (real change sits in the
// tails) and its variance rescaled by 0.6230, the variance of a unit normal kept within ±1.645.
// The trimmed variance is used, not the MAD: the stack is quantised to 0.25 dB and the MAD jumps
// between a few values. Real change left in the centre makes this a lower bound, so the tests err
// toward missing change, not inventing it. Returns { m, lo, hi, pairs }.
export function estimateEnl(site, stride = 1) {
  const n = site.width * site.height;
  const ms = [];
  for (const band of ["hh", "hv"]) {
    const L = site.layers[band];
    const lin = linearTable(L);
    for (let p = 1; p < site.passCount; p += 1) {
      const a = site.passPlane(band, p);
      const b = site.passPlane(band, p - 1);
      const d = [];
      for (let i = 0; i < n; i += stride) {
        if (a[i] !== L.nodata && b[i] !== L.nodata) d.push(Math.log(lin[a[i]] / lin[b[i]]));
      }
      if (d.length < 200) continue;
      d.sort((x, y) => x - y);
      const lo = quantileSorted(d, 0.05);
      const hi = quantileSorted(d, 0.95);
      let s1 = 0;
      let s2 = 0;
      let k = 0;
      for (const v of d) {
        if (v < lo || v > hi) continue;
        s1 += v;
        s2 += v * v;
        k += 1;
      }
      const varT = (s2 - (s1 * s1) / k) / (k - 1);
      if (varT > 0) ms.push(enlFromLogRatioVar(varT / 0.623));
    }
  }
  if (!ms.length) return null;
  ms.sort((x, y) => x - y);
  return { m: quantileSorted(ms, 0.5), lo: ms[0], hi: ms.at(-1), pairs: ms.length };
}

// −2 ln R_j for the j-th image (1-based, j ≥ 2) of a series, from the running sums of the first
// j − 1 images (sa, sb) and image j (a, b): Conradsen et al. 2016 eq. (10a), p = 2 diagonal.
export function m2logR(j, sa, sb, a, b, m) {
  const k = 2 * (j * Math.log(j) - (j - 1) * Math.log(j - 1));
  const v = k + (j - 1) * (Math.log(sa) + Math.log(sb)) + Math.log(a) + Math.log(b) - j * (Math.log(sa + a) + Math.log(sb + b));
  return Math.max(0, -2 * m * v);
}

// Direction of a change (Canty et al. 2020): 1 both channels up (positive definite), 2 both down
// (negative definite); the indefinite case is split by channel, since HH up with HV down or flat
// is the double bounce of water arriving under trees: 3 HH up and HV down, 4 HH down and HV up.
export const DIR = Object.freeze({ UP: 1, DOWN: 2, HH_UP: 3, HH_DOWN: 4 });
const direction = (da, db) => (da > 0 && db > 0 ? 1 : da < 0 && db < 0 ? 2 : da > 0 ? 3 : 4);
// True when HH went up in a change code.
export const hhUp = (d) => d === DIR.UP || d === DIR.HH_UP;

// Sequential omnibus test on one pixel: a, b are linear HH and HV per pass. Starting at the first
// pass, the omnibus Q over the rest of the series must be significant, and the first significant
// R_j marks a change; the series restarts at that pass. Returns [[pass, direction], ...].
export function pixelChanges(a, b, m, alpha = ALPHA) {
  const k = a.length;
  const out = [];
  let l = 0;
  const r = new Float64Array(k + 1); // r[j], j = 2 … k
  while (l < k - 1) {
    let sa = a[l];
    let sb = b[l];
    let q = 0;
    for (let j = 2; j <= k - l; j += 1) {
      r[j] = m2logR(j, sa, sb, a[l + j - 1], b[l + j - 1], m);
      q += r[j];
      sa += a[l + j - 1];
      sb += b[l + j - 1];
    }
    if (chi2Sf(q, 2 * (k - l - 1)) >= alpha) break;
    let hit = 0;
    for (let j = 2; j <= k - l; j += 1) {
      if (chi2Sf(r[j], 2) < alpha) {
        hit = j;
        break;
      }
    }
    if (!hit) break;
    const at = l + hit - 1;
    let ma = 0;
    let mb = 0;
    for (let i = l; i < at; i += 1) {
      ma += a[i];
      mb += b[i];
    }
    out.push([at, direction(a[at] - ma / (at - l), b[at] - mb / (at - l))]);
    l = at;
  }
  return out;
}

// Change codes for the whole stack: Uint8Array(passCount × W × H), plane p holds the direction of
// a change detected at pass p (0 none). Pixels with nodata on any pass are left out: the test
// needs the full series. Pass indices follow the site's passes.
export function changeStack(site, m, alpha = ALPHA) {
  const n = site.width * site.height;
  const P = site.passCount;
  const out = new Uint8Array(P * n);
  const La = site.layers.hh;
  const Lb = site.layers.hv;
  const ta = linearTable(La);
  const tb = linearTable(Lb);
  const pa = Array.from({ length: P }, (_, p) => site.passPlane("hh", p));
  const pb = Array.from({ length: P }, (_, p) => site.passPlane("hv", p));
  const a = new Float64Array(P);
  const b = new Float64Array(P);
  for (let i = 0; i < n; i += 1) {
    let ok = true;
    for (let p = 0; p < P && ok; p += 1) {
      a[p] = ta[pa[p][i]];
      b[p] = tb[pb[p][i]];
      ok = Number.isFinite(a[p]) && Number.isFinite(b[p]);
    }
    if (!ok) continue;
    for (const [p, d] of pixelChanges(a, b, m, alpha)) out[p * n + i] = d;
  }
  return out;
}

// Two passes only (the change view against its reference): −2 ln R₂ ~ χ²₂. Codes as above,
// Uint8Array(W × H).
export function pairChange(site, ref, cur, m, alpha = ALPHA) {
  const n = site.width * site.height;
  const out = new Uint8Array(n);
  const La = site.layers.hh;
  const Lb = site.layers.hv;
  const ta = linearTable(La);
  const tb = linearTable(Lb);
  const a0 = site.passPlane("hh", ref);
  const b0 = site.passPlane("hv", ref);
  const a1 = site.passPlane("hh", cur);
  const b1 = site.passPlane("hv", cur);
  for (let i = 0; i < n; i += 1) {
    const x0 = ta[a0[i]];
    const y0 = tb[b0[i]];
    const x1 = ta[a1[i]];
    const y1 = tb[b1[i]];
    if (!(x0 > 0 && y0 > 0 && x1 > 0 && y1 > 0)) continue;
    if (chi2Sf(m2logR(2, x0, y0, x1, y1, m), 2) < alpha) out[i] = direction(x1 - x0, y1 - y0);
  }
  return out;
}
