// Trend of a short series (passes of one season): Mann–Kendall test with an exact p-value and the
// Theil–Sen slope (docs/10 D-079). With 5–14 passes the normal approximation is poor, so without
// ties the null distribution of S is enumerated exactly (it is the distribution of inversions of a
// random permutation, the Mahonian numbers); with ties the tie-corrected normal approximation with
// continuity correction is used and the result says so. Serial correlation is not modelled.

// Number of permutations of n items with exactly k inversions, k = 0 … n(n−1)/2.
export function mahonian(n) {
  let row = [1];
  for (let i = 2; i <= n; i += 1) {
    const next = new Array(row.length + i - 1).fill(0);
    // Adding item i inserts 0 … i−1 new inversions; a sliding window sum over the previous row.
    let win = 0;
    for (let k = 0; k < next.length; k += 1) {
      if (k < row.length) win += row[k];
      if (k - i >= 0) win -= row[k - i];
      next[k] = win;
    }
    row = next;
  }
  return row;
}

const normSf = (z) => {
  // Upper tail of the standard normal (Abramowitz & Stegun 7.1.26 via erfc; |error| < 1.5e-7).
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
};

// Mann–Kendall on y in time order: { n, s, p (two-sided), exact }.
export function mannKendall(y) {
  const n = y.length;
  let s = 0;
  let ties = false;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const d = Math.sign(y[j] - y[i]);
      s += d;
      if (d === 0) ties = true;
    }
  }
  if (n < 3) return { n, s, p: 1, exact: true };
  if (!ties && n <= 20) {
    // S = N − 2·inversions with N = n(n−1)/2; P(|S| ≥ |s|) from the inversion counts.
    const counts = mahonian(n);
    const N = (n * (n - 1)) / 2;
    let total = 0;
    let tail = 0;
    counts.forEach((c, inv) => {
      total += c;
      if (Math.abs(N - 2 * inv) >= Math.abs(s)) tail += c;
    });
    return { n, s, p: Math.min(1, tail / total), exact: true };
  }
  const groups = new Map();
  for (const v of y) groups.set(v, (groups.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of groups.values()) tieTerm += t * (t - 1) * (2 * t + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  const z = s === 0 ? 0 : (s - Math.sign(s)) / Math.sqrt(varS);
  return { n, s, p: Math.min(1, 2 * normSf(Math.abs(z))), exact: false };
}

// Theil–Sen slope: the median of all pairwise slopes (y per unit of x).
export function theilSen(x, y) {
  const slopes = [];
  for (let i = 0; i < x.length; i += 1) {
    for (let j = i + 1; j < x.length; j += 1) if (x[j] !== x[i]) slopes.push((y[j] - y[i]) / (x[j] - x[i]));
  }
  if (!slopes.length) return NaN;
  slopes.sort((a, b) => a - b);
  const h = slopes.length >> 1;
  return slopes.length % 2 ? slopes[h] : (slopes[h - 1] + slopes[h]) / 2;
}
