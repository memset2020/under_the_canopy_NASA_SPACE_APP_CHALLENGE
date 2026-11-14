"""Burned forest through the smoke (contract v13, docs/14): where NISAR's HH over HV rose.

At L-band, HV is mostly the volume echo of needles and branches; HH also carries the ground and
the trunk-ground double bounce. Where a forest burns, the volume goes and more of the radar reaches
the trunks and the ground, so HH over HV (HH - HV in dB) rises and keeps rising for weeks as the
dead trees dry and drop what is left. The ratio is used, not HV alone, because rain and soil or
canopy moisture move both channels together: over Thunder Bay 36 they moved HV of the whole forest
by up to 0.8 dB from pass to pass, more than the fire's own HV loss (docs/10 D-076).

A forest pixel counts as burned when its ratio is RISE_DB above its pre-fire median on a pass and,
averaged over that pass and every later one, stays at least that high: one bright pass alone is not
trusted. The last pass, with nothing after it, needs RISE_DB + LAST_PASS_EXTRA_DB. A burned pixel
is dated by the first pass whose rise passed ONSET_DB, since the signal grows after the fire.

Checked against NASA's monthly 500 m burned-area maps, resampled onto the site grid: MODIS MCD64A1
and VIIRS VNP64A1 (same grid and format; VIIRS reaches later months, contract v14). RISE_DB was
chosen on the west half of the Thunder Bay box and is reported on the east half it never saw; the
threshold is swept so the sensitivity of the answer is shown, not hidden.
"""

from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path

import numpy as np

# Best F1 against MODIS on the west half of Thunder Bay 36 (0.86 at 0.9 and at 1.0 dB; the higher,
# more precise one is used). About twice the autumn drift of unburned forest there (0.5 dB).
RISE_DB = 1.0
# The site RISE_DB was chosen on; every other fire site is a test the threshold never saw.
TUNED_SITE = "thunder_bay_36"
# Five times the pass-to-pass scatter of the ratio before the fire (0.07-0.11 dB).
ONSET_DB = 0.5
LAST_PASS_EXTRA_DB = 0.5
MIN_BASELINE = 2
SWEEP_DB = (0.5, 0.75, 1.0, 1.25, 1.5, 2.0)
# The burn map is made on a grid finer than the site's (docs/10 D-088): 55 m cells, from the
# same radar reads (37 m was tried: F1 0.75 against MODIS, speckle eats real burn). Burned
# patches smaller than MIN_PATCH_KM2 (the map notes' minimum, D-079) are speckle, not fire: at
# 55 m they were 21,396 of 21,919 patches, and dropping them raised F1 against MODIS from 0.82
# to 0.85 with the same recall.
FINE_PIXEL_M = 55.0
MIN_PATCH_KM2 = 0.05

# MODIS sinusoidal grid (MCD64A1 user guide): 2400 × 2400 cells of 463.3 m per 10° tile.
MODIS_R = 6371007.181
MODIS_TILE_M = 1111950.5197665
MODIS_X0, MODIS_Y0 = -20015109.354, 10007554.677


def ratio_change(
    hh_db: np.ndarray, hv_db: np.ndarray, dates: list[date], before: date
) -> tuple[np.ndarray, list[int]]:
    """HH - HV of every pass minus its median over the passes on or before `before` (dB)."""
    pre = [k for k, d in enumerate(dates) if d <= before]
    if len(pre) < MIN_BASELINE:
        raise ValueError(f"only {len(pre)} pre-fire pass(es); {MIN_BASELINE} needed")
    ratio = hh_db - hv_db
    with np.errstate(invalid="ignore"):
        base = np.nanmedian(ratio[pre], axis=0)
    return ratio - base[None], pre


def first_rise(delta: np.ndarray, forest: np.ndarray, start: int, rise_db: float = RISE_DB):
    """Index of the first pass from `start` on where a forest pixel's ratio rose by rise_db and,
    averaged over that pass and the later measured ones, stays up; -1 if never. A pass with no
    later measurement needs rise_db + LAST_PASS_EXTRA_DB."""
    fin = np.isfinite(delta)
    vals = np.where(fin, delta, 0.0)
    after_sum = np.cumsum(vals[::-1], axis=0)[::-1]
    after_n = np.cumsum(fin[::-1], axis=0)[::-1]
    first = np.full(delta.shape[1:], -1, dtype=int)
    for k in range(start, delta.shape[0]):
        with np.errstate(invalid="ignore", divide="ignore"):
            mean_after = after_sum[k] / after_n[k]
            up = fin[k] & (delta[k] >= rise_db)
            lasting = np.where(
                after_n[k] >= 2, mean_after >= rise_db, delta[k] >= rise_db + LAST_PASS_EXTRA_DB
            )
        new = up & lasting & forest & (first < 0)
        first[new] = k
    return first


def burn_dates(
    delta: np.ndarray,
    forest: np.ndarray,
    start: int,
    rise_db: float = RISE_DB,
    onset_db: float = ONSET_DB,
) -> np.ndarray:
    """First burned pass: burned by `first_rise` at rise_db, dated by the first pass from which
    the rise passed onset_db and lasted (never later than the pass that confirmed it); -1 if not."""
    confirmed = first_rise(delta, forest, start, rise_db)
    onset = first_rise(delta, forest & (confirmed >= 0), start, onset_db)
    return np.where((onset >= 0) & (onset <= confirmed), onset, confirmed)


def modis_cells(lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, ...]:
    """MODIS sinusoidal tile (h, v) and in-tile row and column for each lon/lat."""
    phi = np.deg2rad(lat)
    x = MODIS_R * np.deg2rad(lon) * np.cos(phi)
    y = MODIS_R * phi
    fx = (x - MODIS_X0) / MODIS_TILE_M
    fy = (MODIS_Y0 - y) / MODIS_TILE_M
    h, v = np.floor(fx).astype(int), np.floor(fy).astype(int)
    col = np.clip(((fx - h) * 2400).astype(int), 0, 2399)
    row = np.clip(((fy - v) * 2400).astype(int), 0, 2399)
    return h, v, row, col


# Monthly 500 m burned-area products on the MODIS sinusoidal grid, same "Burn Date" layer.
# MCD64A1 (Giglio et al. 2018) is the reference the rule was tuned on; VNP64A1 is its VIIRS
# continuation and is published sooner for recent months (docs/15 §2).
BURNED_AREA = {
    "MCD64A1": ("061", "NASA MODIS MCD64A1 v061 burned area (500 m, monthly)"),
    "VNP64A1": ("002", "NASA VIIRS VNP64A1 v002 burned area (500 m, monthly)"),
}


def modis_months(files: list[Path]) -> list[str]:
    """The months of MCD64A1 / VNP64A1 files ('YYYY-MM'), from their AYYYYDDD start day."""
    out = set()
    for f in files:
        tag = f.name.split(".")[1]  # e.g. A2026182
        d = date(int(tag[1:5]), 1, 1) + timedelta(days=int(tag[5:8]) - 1)
        out.add(f"{d.year}-{d.month:02d}")
    return sorted(out)


def modis_burn_on_grid(files: list[Path], lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """MCD64A1 / VNP64A1 burn day of year at each grid cell (nearest MODIS cell): >0 burned that
    day, 0 not burned, NaN unmapped, water or outside the files. Later months overwrite earlier
    zeros, never an earlier burn date."""
    from pyhdf.SD import SD, SDC  # pyright: ignore[reportMissingImports]

    h, v, row, col = modis_cells(lon, lat)
    out = np.full(lon.shape, np.nan)
    for f in sorted(files):
        tile = f.name.split(".")[2]  # e.g. h12v03
        th, tv = int(tile[1:3]), int(tile[4:6])
        sel = (h == th) & (v == tv)
        if not sel.any():
            continue
        bd = SD(str(f), SDC.READ).select("Burn Date")[:, :].astype(float)
        vals = bd[row[sel], col[sel]]
        vals[vals < 0] = np.nan  # -1 unmapped, -2 water
        cur = out[sel]
        take = np.isnan(cur) | ((cur == 0) & (vals > 0))
        cur[take] = vals[take]
        out[sel] = cur
    return out


def agreement(burned: np.ndarray, reference: np.ndarray, forest: np.ndarray) -> dict:
    """Precision, recall and F1 of NISAR burned forest against a reference map (forest cells
    where the reference has data)."""
    ok = forest & np.isfinite(reference)
    ref = ok & (reference > 0)
    got = ok & burned
    tp = int((got & ref).sum())
    fp = int((got & ~ref).sum())
    fn = int((ref & ~got).sum())
    prec = tp / (tp + fp) if tp + fp else None
    rec = tp / (tp + fn) if tp + fn else None
    f1 = 2 * prec * rec / (prec + rec) if prec and rec else None
    rnd = lambda v: None if v is None else round(v, 3)  # noqa: E731
    return {"precision": rnd(prec), "recall": rnd(rec), "f1": rnd(f1), "cells": int(ok.sum())}


def date_agreement(first: np.ndarray, modis_doy: np.ndarray, dates: list[date], year: int) -> dict:
    """For cells both call burned: does MODIS's burn day fall between NISAR's last pass before
    detection and the detecting pass (within one 12-day step either side)?"""
    both = (first > 0) & np.isfinite(modis_doy) & (modis_doy > 0)
    if not both.any():
        return {"cells": 0, "within_pct": None, "median_lag_days": None}
    d0 = date(year, 1, 1)
    burn = np.array([(d0 + timedelta(days=int(v) - 1)).toordinal() for v in modis_doy[both]])
    k = first[both]
    hi = np.array([dates[i].toordinal() for i in k])
    lo = np.array([dates[i - 1].toordinal() for i in k])
    within = (burn > lo - 12) & (burn <= hi + 12)
    return {
        "cells": int(both.sum()),
        "within_pct": round(float(within.mean() * 100), 1),
        "median_lag_days": float(np.median(hi - burn)),
    }


def fetch_burned_area(
    site: dict, start: date, end: date, out: Path, product: str = "MCD64A1", log=print
) -> list[Path]:
    """Monthly burned-area tiles (MCD64A1 or VNP64A1) over the site between start and end."""
    from . import nasa_access as na

    ea = na._earthaccess()
    na.login()
    grans = ea.search_data(
        short_name=product,
        version=BURNED_AREA[product][0],
        bounding_box=tuple(site["bbox"]),
        temporal=(start.isoformat(), end.isoformat()),
        count=50,
    )
    out.mkdir(parents=True, exist_ok=True)
    todo = [g for g in grans if not (out / f"{g['umm']['GranuleUR']}.hdf").is_file()]
    if todo:
        ea.download(todo, str(out))
    files = sorted(out.glob(f"{product}*.hdf"))
    log(f"  burned area: {len(files)} {product} tile-months")
    return files


def fetch_mcd64a1(site: dict, start: date, end: date, out: Path, log=print) -> list[Path]:
    return fetch_burned_area(site, start, end, out, "MCD64A1", log)


def load_refs(raw: Path, lon: np.ndarray, lat: np.ndarray) -> list[dict]:
    """Every fetched burned-area product on the site grid: product, source, doy, months."""
    refs = []
    for product, (_, source) in BURNED_AREA.items():
        files = sorted((raw / "nasa" / product.lower()).glob(f"{product}*.hdf"))
        if files:
            refs.append(
                {
                    "product": product,
                    "source": source,
                    "doy": modis_burn_on_grid(files, lon, lat),
                    "months": modis_months(files),
                }
            )
    return refs


BURN_RAMP = [
    (92, 14, 32),
    (168, 32, 46),
    (222, 84, 72),
    (247, 160, 140),
]  # first burned: early → late


def colour_progression(first: np.ndarray, n_passes: int) -> np.ndarray:
    """First burned pass as a dark-to-light red sequence (amber stays reserved for water under
    trees); clear where nothing burned."""
    from . import png

    out = np.zeros((*first.shape, 4), dtype=np.uint8)
    ok = first >= 0
    lo, hi = (int(first[ok].min()), int(first[ok].max())) if ok.any() else (0, 1)
    t = (first[ok] - lo) / max(hi - lo, 1)
    out[ok, :3] = png._ramp(BURN_RAMP, t).round().astype(np.uint8)
    out[ok, 3] = 220
    return out


def patches_at_least(mask: np.ndarray, min_px: int) -> np.ndarray:
    """`mask` with its 8-connected patches smaller than min_px cells removed."""
    from collections import deque

    mask = np.asarray(mask, dtype=bool)
    if min_px <= 1 or not mask.any():
        return mask.copy()
    h, w = mask.shape
    flat = mask.ravel()
    seen = np.zeros(flat.size, dtype=bool)
    keep = np.zeros(flat.size, dtype=bool)
    for start in np.flatnonzero(flat):
        if seen[start]:
            continue
        seen[start] = True
        patch = [start]
        q = deque([start])
        while q:
            i = q.popleft()
            r, c = divmod(int(i), w)
            for dr in (-1, 0, 1):
                rr = r + dr
                if rr < 0 or rr >= h:
                    continue
                for dc in (-1, 0, 1):
                    cc = c + dc
                    if 0 <= cc < w:
                        j = rr * w + cc
                        if flat[j] and not seen[j]:
                            seen[j] = True
                            patch.append(j)
                            q.append(j)
        if len(patch) >= min_px:
            keep[patch] = True
    return keep.reshape(h, w)


def to_grid(first: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    """A fine burn map on a coarser grid of the same box: a coarse cell is burned when at least
    half of the fine cells whose centres fall in it are, dated by the earliest of them."""
    hf, wf = first.shape
    h, w = shape
    rows = ((np.arange(hf) + 0.5) * h / hf).astype(int)
    cols = ((np.arange(wf) + 0.5) * w / wf).astype(int)
    idx = (rows[:, None] * w + cols[None, :]).ravel()
    burned = (first >= 0).ravel()
    n = np.bincount(idx, minlength=h * w)
    b = np.bincount(idx, weights=burned, minlength=h * w)
    big = np.iinfo(np.int32).max
    earliest = np.full(h * w, big, dtype=np.int64)
    np.minimum.at(earliest, idx[burned], first.ravel()[burned])
    out = np.where((n > 0) & (2 * b >= n) & (earliest < big), earliest, -1)
    return out.reshape(h, w).astype(first.dtype)


def east_half(shape: tuple[int, int]) -> np.ndarray:
    """The half of the grid RISE_DB was not chosen on (columns from the middle east)."""
    out = np.zeros(shape, dtype=bool)
    out[:, shape[1] // 2 :] = True
    return out


def flood_lookalike(
    cls: np.ndarray, first: np.ndarray, area: np.ndarray, start: int, flooded_code: int
) -> dict | None:
    """Burned forest brightens in HH as flooded forest does (the canopy that hid the ground is
    gone), so the flood rule reads fire as water under trees. The post-fire pass where it found
    the most, how much it found before the fire, and the share inside NISAR's burned forest."""
    if start >= cls.shape[0]:
        return None
    fv = cls == flooded_code
    km2 = (fv * area[None]).sum(axis=(1, 2))
    k = start + int(np.argmax(km2[start:]))
    if km2[k] <= 0:
        return None
    inside = float(((fv[k] & (first >= 0) & (first <= k)) * area).sum())
    return {
        "before_km2": round(float(km2[:start].max()), 1),
        "pass_index": k,
        "km2": round(float(km2[k]), 1),
        "in_burned_pct": round(100 * inside / float(km2[k]), 1),
    }


def summarise(
    scene,
    hh_db: np.ndarray,
    hv_db: np.ndarray,
    veg: np.ndarray,
    area: np.ndarray,
    out: Path,
    cls: np.ndarray | None = None,
    flooded_code: int | None = None,
) -> tuple[dict, np.ndarray]:
    """products.burn and the static burn_pass layer (0 none, k = first burned at pass k)."""
    from . import active_fire, png

    fire = scene.site["fire"]
    before = date.fromisoformat(fire["before"])
    site_shape, site_area = veg.shape, area  # area may be one value per row
    canopy = scene.canopy_height_m
    refs_all = scene.burn_refs
    fine = getattr(scene, "burn_fine", None)
    if fine is not None:
        # The burn map on its finer grid (D-088); the site's layers get it back via to_grid.
        hh_db, hv_db, veg, area = fine["hh_db"], fine["hv_db"], fine["veg"], fine["area"]
        canopy, refs_all = fine["canopy_height_m"], fine["refs"]
    delta, pre = ratio_change(hh_db, hv_db, scene.dates, before)
    forest = forest_mask(veg, canopy)
    min_px = max(1, int(round(MIN_PATCH_KM2 / float(np.median(area)))))

    def cleaned(f: np.ndarray) -> np.ndarray:
        return np.where(patches_at_least(f >= 0, min_px), f, -1)

    first = cleaned(burn_dates(delta, forest, start=len(pre)))
    png.write_png(out / "burn.png", colour_progression(first, len(scene.dates)))
    by_pass, total = [], 0.0
    for k, d in enumerate(scene.dates):
        new = float(((first == k) * area).sum())
        total += new
        by_pass.append(
            {"date": d.isoformat(), "new_km2": round(new, 2), "burned_km2": round(total, 2)}
        )
    # v14: one check per burned-area product fetched; the site's reference (MCD64A1 unless the
    # site names another) is `validation`, the rest go in `checks`.
    want = fire.get("reference", "MCD64A1")
    # A map whose last month ends before the fire started cannot score it (MODIS stops at July
    # for an August fire), so it is left out rather than shown as a near-zero score.
    refs = [
        r
        for r in refs_all
        if np.isfinite(r["doy"]).any() and r["months"] and r["months"][-1] >= fire["before"][:7]
    ]
    refs.sort(key=lambda r: r["product"] != want)
    east = east_half(forest.shape)
    checks = []
    for r in refs:
        ref = r["doy"]
        sweep = []
        for rise in SWEEP_DB:
            f_r = cleaned(first_rise(delta, forest, start=len(pre), rise_db=rise))
            sweep.append({"rise_db": rise, **agreement(f_r >= 0, ref, forest)})
        checks.append(
            {
                "product": r["product"],
                "source": r["source"],
                "ref_months": r["months"],
                "ref_burned_km2": round(
                    float(((forest & (np.nan_to_num(ref) > 0)) * area).sum()), 1
                ),
                **agreement(first >= 0, ref, forest),
                "held_out": {"half": "east", **agreement(first >= 0, ref, forest & east)},
                "dates": date_agreement(first, ref, scene.dates, scene.dates[0].year),
                "sweep": sweep,
            }
        )
    validation = checks[0] if checks else None
    doc = {
        "png": "burn.png",
        "rise_db": RISE_DB,
        "tuned_site": TUNED_SITE,
        "onset_db": ONSET_DB,
        "last_pass_rise_db": RISE_DB + LAST_PASS_EXTRA_DB,
        "grid": {
            "width": int(first.shape[1]),
            "height": int(first.shape[0]),
            "pixel_m": round(float(np.sqrt(np.median(area))) * 1000, 1),
        },
        "min_patch_km2": MIN_PATCH_KM2,
        "baseline": [scene.dates[k].isoformat() for k in pre],
        "forest_km2": round(float((forest * area).sum()), 1),
        "burned_km2": round(total, 1),
        "by_pass": by_pass,
        "fire": {k: fire.get(k) for k in ("name", "reported_ha", "reported_source")},
        "validation": validation,
        "checks": checks[1:],
        "active_fire": active_fire.summarise(
            scene.active_fire, scene.dates, first, scene.bounds, out
        ),
        "flood_lookalike": None,
    }
    first_site = first if first.shape == site_shape else to_grid(first, site_shape)
    if cls is not None and flooded_code is not None:
        look = flood_lookalike(cls, first_site, site_area, len(pre), flooded_code)
        if look:
            when = scene.dates[look.pop("pass_index")].isoformat()
            doc["flood_lookalike"] = {"date": when, **look}
    burn_pass = np.where(first_site >= 0, first_site + 1, 0).astype(np.uint8)
    return doc, burn_pass


def forest_mask(veg: np.ndarray, canopy_height_m: np.ndarray | None, veg_forest_code: int = 1):
    """Forest for the burn rule: vegetated (WorldCover tree or shrub codes as in docs/04 §4.1)
    and, where GEDI measured, at least 5 m tall."""
    forest = veg == veg_forest_code
    if canopy_height_m is not None:
        forest &= ~(np.isfinite(canopy_height_m) & (canopy_height_m < 5))
    return forest
