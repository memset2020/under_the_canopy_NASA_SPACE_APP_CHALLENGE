"""Per-site threshold calibration from labelled pixels (task D-04, docs/04 §4.3).

Labels come from two places:
- `auto_labels_lc07`: NASA's LBA-ECO L-band wetland map (Amazon sites only);
- a labels file exported from the app's label mode (pipeline/config/labels/<site>.json).

Thresholds are searched on 0.25 dB steps (they must stay exactly representable for
rules.js parity, docs/10 D-009) and scored on a spatial hold-out: labels are split by
32-pixel blocks in a checkerboard, so neighbouring pixels never sit on both sides.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np

from . import products, raster, validate
from .classify import classify
from .config import PIPELINE_DIR, VEG_OTHER, VEG_YES, Thresholds

LABELS_DIR = PIPELINE_DIR / "config" / "labels"
REPORT_DIR = PIPELINE_DIR / "config" / "calibration"
CLASSES = ("flooded_veg", "open_water", "dry_veg", "dry_open", "built")
BLOCK = 32
MAX_PER_CLASS_PASS = 1500


def _features(scene):
    """Decoded quantised values, exactly what the classifier and the browser see."""
    hh = raster.dequantize_db(raster.quantize_db(scene.hh_db))
    hv = raster.dequantize_db(raster.quantize_db(scene.hv_db))
    sp = raster.dequantize_spread(raster.quantize_spread(scene.spread_db))
    veg = scene.veg.astype(np.uint8).copy()
    if scene.terrain_gate is not None:
        veg[scene.terrain_gate & (veg == VEG_YES)] = VEG_OTHER
    return hh, hv, sp, veg


def auto_labels_lc07(scene, codes: np.ndarray, high_passes: list[int], rng) -> list[tuple]:
    """(pass, row, col, label) from LBA-ECO LC-07 class codes (low digit × 10 + high digit)."""
    labels = []
    n = len(scene.dates)
    c = codes.astype(int)
    rules = [
        (c == 99, range(n), "flooded_veg"),  # flooded forest at low and high water
        (np.isin(c, (77, 89)), high_passes, "flooded_veg"),  # flooded only at high water
        ((c == 1) & (scene.veg == VEG_YES), range(n), "dry_veg"),  # terra firme forest
        (c == 11, range(n), "open_water"),
    ]
    for mask, passes, label in rules:
        rows, cols = np.nonzero(mask)
        for p in passes:
            take = rng.permutation(rows.size)[:MAX_PER_CLASS_PASS]
            labels += [(p, int(rows[k]), int(cols[k]), label) for k in take]
    return labels


def auto_labels_optical(scene, rng) -> list[tuple]:
    """Open-water vs dry open land from OPERA DSWx-HLS on cloud-free pixels.

    Only outside vegetation: a camera cannot see water under a canopy, so optical 'not
    water' under trees would be a wrong 'dry' label.
    """
    labels = []
    for p, obs in enumerate(scene.optical_obs or []):
        if obs is None:
            continue
        open_land = obs.clear & (scene.veg != VEG_YES)
        for mask, label in (
            (obs.water & open_land, "open_water"),
            (~obs.water & open_land, "dry_open"),
        ):
            rows, cols = np.nonzero(mask)
            take = rng.permutation(rows.size)[:MAX_PER_CLASS_PASS]
            labels += [(p, int(rows[k]), int(cols[k]), label) for k in take]
    return labels


# A tuned component is kept only if it is good and clearly better on held-out blocks.
MIN_HELD_OUT_BA = 0.70
MIN_GAIN = 0.03
# Search ranges (dB). A best value on a range edge means the search did not converge
# (the labels want a threshold outside physical bounds), so it is never applied.
SEARCH = {
    "fv_hh_db": (-10.0, 0.0),
    "fv_ratio_db": (2.0, 12.0),
    "ow_hh_db": (-24.0, -8.0),
    "ow_hv_db": (-30.0, -14.0),
}


def accepted(report: dict) -> tuple[dict, dict]:
    """(thresholds to apply, per-component decision) following the rule above."""
    base, tuned = report["defaults"], report["tuned"]
    out = dict(base)
    decision = {}
    for comp, keys in (
        ("open_water", ("ow_hh_db", "ow_hv_db")),
        ("flooded_veg", ("fv_hh_db", "fv_ratio_db")),
    ):
        before = report["held_out_before"][comp]["balanced_accuracy"]
        after = report["held_out_after"][comp]["balanced_accuracy"]
        edge = [k for k in keys if tuned[k] in SEARCH[k]]
        ok = (
            after is not None
            and after >= MIN_HELD_OUT_BA
            and (before is None or after - before >= MIN_GAIN)
            and not edge
        )
        if ok:
            for k in keys:
                out[k] = tuned[k]
        decision[comp] = {"applied": bool(ok), "held_out_before": before, "held_out_after": after}
        decision[comp]["in_effect"] = {k: out[k] for k in keys}
        if edge:
            decision[comp]["rejected"] = f"at search edge: {', '.join(edge)}"
            decision[comp]["rejected_code"] = "search_edge"
    return out, decision


# Labels from maps are static: they say where wetlands are, not when they flood. The river
# gauge is the independent check on timing, so a tuned rule may not make it much worse.
MAX_GAUGE_R_DROP = 0.10
COMPONENT_KEYS = {
    "open_water": ("ow_hh_db", "ow_hv_db"),
    "flooded_veg": ("fv_hh_db", "fv_ratio_db"),
}


def gauge_r(scene, t: Thresholds) -> float | None:
    """Pearson r between flooded area per pass and river stage, as the build reports it."""
    if scene.gauge is None:
        return None
    hh, hv, sp, veg = _features(scene)
    cls, conf = classify(hh, hv, sp, veg, t)
    h, w = veg.shape
    areas = products.pass_areas(cls, conf, raster.pixel_area_km2(scene.bounds, h, w))
    g = validate.gauge_validation(scene.dates, [a["flooded_km2"] for a in areas], scene.gauge.daily)
    return g["r"]


def timing_check(scene, chosen: dict, decision: dict) -> tuple[dict, dict]:
    """Revert any applied component that lowers gauge r by more than MAX_GAUGE_R_DROP."""
    base = asdict(Thresholds())
    r0 = gauge_r(scene, Thresholds(**base))
    if r0 is None:
        return chosen, decision
    out = dict(chosen)
    for comp, keys in COMPONENT_KEYS.items():
        if not decision[comp]["applied"]:
            continue
        r1 = gauge_r(scene, Thresholds(**{**base, **{k: chosen[k] for k in keys}}))
        decision[comp]["gauge_r_before"] = _r(r0)
        decision[comp]["gauge_r_after"] = _r(r1)
        if r1 is not None and r1 < r0 - MAX_GAUGE_R_DROP:
            for k in keys:
                out[k] = base[k]
            decision[comp]["applied"] = False
            decision[comp]["rejected"] = f"lowers gauge r from {r0:.2f} to {r1:.2f}"
            decision[comp]["rejected_code"] = "gauge_timing"
            decision[comp]["in_effect"] = {k: base[k] for k in keys}
    return out, decision


def load_labels(site_id: str, scene) -> list[tuple]:
    """Labels exported by the app: [{pass_id, row, col, label}]."""
    f = LABELS_DIR / f"{site_id}.json"
    if not f.is_file():
        return []
    ids = {f"p{i + 1:02d}": i for i in range(len(scene.dates))}
    out = []
    for rec in json.loads(f.read_text(encoding="utf-8"))["labels"]:
        if rec["label"] in CLASSES and rec["pass_id"] in ids:
            out.append((ids[rec["pass_id"]], int(rec["row"]), int(rec["col"]), rec["label"]))
    return out


def _split(labels):
    test = [((r // BLOCK) + (c // BLOCK)) % 2 == 1 for _, r, c, _ in labels]
    return np.array(test)


def _balanced(pred, truth):
    pos, neg = truth, ~truth
    if pos.sum() == 0 or neg.sum() == 0:
        return float("nan"), float("nan"), float("nan")
    tpr = float((pred & pos).sum() / pos.sum())
    tnr = float((~pred & neg).sum() / neg.sum())
    return (tpr + tnr) / 2, tpr, tnr


def _search(predict, mask, truth, grid_a, grid_b, default) -> tuple[float, float, float]:
    """Best balanced accuracy on the training labels; ties go to the threshold pair closest
    to the literature defaults, which keeps the result conservative."""
    best = (-1.0, float(default[0]), float(default[1]))
    for a in grid_a:
        for b in grid_b:
            score = _balanced(predict(a, b)[mask], truth[mask])[0]
            if not np.isfinite(score):
                continue
            closer = abs(a - default[0]) + abs(b - default[1]) < abs(best[1] - default[0]) + abs(
                best[2] - default[1]
            )
            if score > best[0] + 1e-9 or (abs(score - best[0]) <= 1e-9 and closer):
                best = (float(score), float(a), float(b))
    return best


def _grid(lo, hi):
    return np.arange(lo, hi + 1e-9, 0.25)


def calibrate(scene, labels: list[tuple], base: Thresholds | None = None) -> dict:
    """Search flood and open-water thresholds; report before/after on held-out blocks."""
    base = base or Thresholds()
    hh, hv, sp, veg = _features(scene)
    p_, r_, c_, lab = (np.array(x) for x in zip(*labels, strict=True))
    H = hh[p_, r_, c_]
    V = hv[p_, r_, c_]
    G = H - V
    VG = veg[r_, c_]
    ok = np.isfinite(H) & np.isfinite(V)
    test = _split(labels) & ok
    train = ~_split(labels) & ok

    # Flooded vegetation vs dry vegetation, only where the veg gate allows a claim.
    fv_set = np.isin(lab, ("flooded_veg", "dry_veg")) & (VG == VEG_YES)
    truth_fv = lab == "flooded_veg"

    def fv_pred(t_hh, t_gap):
        return (H > t_hh) & (G > t_gap)

    def ow_pred(t_hh, t_hv):
        return (H < t_hh) & (V < t_hv)

    truth_ow = lab == "open_water"
    ow_set = np.ones(lab.shape, dtype=bool)
    best = _search(
        fv_pred,
        train & fv_set,
        truth_fv,
        _grid(*SEARCH["fv_hh_db"]),
        _grid(*SEARCH["fv_ratio_db"]),
        (base.fv_hh_db, base.fv_ratio_db),
    )
    best_ow = (-1.0, base.ow_hh_db, base.ow_hv_db)
    if truth_ow.any() and (~truth_ow).any():
        best_ow = _search(
            ow_pred,
            train & ow_set,
            truth_ow,
            _grid(*SEARCH["ow_hh_db"]),
            _grid(*SEARCH["ow_hv_db"]),
            (base.ow_hh_db, base.ow_hv_db),
        )

    tuned = Thresholds(
        ow_hh_db=best_ow[1],
        ow_hv_db=best_ow[2],
        fv_hh_db=best[1],
        fv_ratio_db=best[2],
        margin_db=base.margin_db,
        max_spread_db=base.max_spread_db,
    )

    def evaluate(t: Thresholds) -> dict:
        m_fv = test & fv_set
        m_ow = test & ow_set
        b_fv = _balanced(fv_pred(t.fv_hh_db, t.fv_ratio_db)[m_fv], truth_fv[m_fv])
        b_ow = _balanced(ow_pred(t.ow_hh_db, t.ow_hv_db)[m_ow], truth_ow[m_ow])
        return {
            "flooded_veg": {
                "balanced_accuracy": _r(b_fv[0]),
                "recall": _r(b_fv[1]),
                "specificity": _r(b_fv[2]),
            },
            "open_water": {
                "balanced_accuracy": _r(b_ow[0]),
                "recall": _r(b_ow[1]),
                "specificity": _r(b_ow[2]),
            },
        }

    counts = {k: int((lab[ok] == k).sum()) for k in CLASSES if (lab[ok] == k).any()}
    return {
        "labels": counts,
        "held_out_share": round(float(test.sum() / max(ok.sum(), 1)), 2),
        "defaults": asdict(base),
        "tuned": asdict(tuned),
        "held_out_before": evaluate(base),
        "held_out_after": evaluate(tuned),
        "seasonal_signal": seasonal_check(scene, labels, hh, hv),
    }


def seasonal_check(scene, labels, hh, hv) -> dict | None:
    """Does the per-pixel change in HH−HV between wettest and driest pass separate the classes?

    Answers docs/10 results: if this separates flooded from dry vegetation much better than
    absolute thresholds, a change rule is worth adding to classify.py and rules.js.
    """
    gap = hh - hv
    with np.errstate(invalid="ignore"):
        season_med = np.nanmedian(gap, axis=(1, 2))
    if not np.isfinite(season_med).any():
        return None
    wet, dry = int(np.nanargmax(season_med)), int(np.nanargmin(season_med))
    if wet == dry:
        return None
    pix = {(r, c): lab for p, r, c, lab in labels if p == wet and lab in ("flooded_veg", "dry_veg")}
    if not pix:
        return None
    rr, cc = (np.array(x) for x in zip(*pix, strict=True))
    lab = np.array(list(pix.values()))
    delta = gap[wet, rr, cc] - gap[dry, rr, cc]
    ok = np.isfinite(delta)
    pos, neg = delta[ok & (lab == "flooded_veg")], delta[ok & (lab == "dry_veg")]
    if pos.size < 10 or neg.size < 10:
        return None
    # AUC by rank comparison (Mann–Whitney), vectorised over a sample.
    rng = np.random.default_rng(0)
    a = rng.choice(pos, min(pos.size, 2000), replace=False)
    b = rng.choice(neg, min(neg.size, 2000), replace=False)
    auc = float((a[:, None] > b[None, :]).mean() + 0.5 * (a[:, None] == b[None, :]).mean())
    return {
        "wet_pass": scene.dates[wet].isoformat(),
        "dry_pass": scene.dates[dry].isoformat(),
        "median_change_flooded_db": _r(float(np.median(pos))),
        "median_change_dry_db": _r(float(np.median(neg))),
        "auc": _r(auc),
    }


def _r(v):
    return None if v is None or not np.isfinite(v) else round(float(v), 3)


def write_report(site_id: str, report: dict) -> Path:
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORT_DIR / f"{site_id}.json"
    path.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    return path
