// What each map view can show on each pass (docs/10 D-081). Some views are one map for the whole
// season (terrain does not change in three months); level change exists only where a NISAR
// interferogram ends on that pass. The legend and the timeline both say so, so an empty or
// unchanging map is never a silent puzzle.

// Views that are the same on every pass, with the reason the legend gives.
export const STATIC_VIEWS = {
  hydroperiod: "legend.static_hydro",
  canopy: "legend.static_canopy",
  terrain: "legend.static_terrain",
  burn: "legend.static_burn",
};

export const isStaticView = (view) => Object.hasOwn(STATIC_VIEWS, view);

// Whether the view has anything to draw on pass i.
export function hasDataOn(summary, view, i) {
  if (view !== "level") return true;
  const date = summary.passes[i]?.date;
  // A pair that ends on this pass but measured nothing (median null) has nothing to draw.
  return (summary.products.level_change ?? []).some((l) => l.to === date && l.median_cm !== null);
}

// The pass nearest to i that has data for the view, or null when none has.
export function nearestWithData(summary, view, i) {
  let best = null;
  summary.passes.forEach((_, k) => {
    if (hasDataOn(summary, view, k) && (best === null || Math.abs(k - i) < Math.abs(best - i))) best = k;
  });
  return best;
}
