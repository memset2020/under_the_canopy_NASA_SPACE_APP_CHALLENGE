"""Scene → classification → products → contract files for one site."""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import numpy as np

from . import SCHEMA_VERSION, exposure, png, products, raster, validate
from . import outlook as outlook_mod
from .classify import classify, is_flooded
from .config import DRY, EXPOSURE_BUFFER_M, FLOODED_VEG, OPEN_WATER, VEG_OTHER, VEG_YES, Thresholds
from .export import flood_geojson, roads_geojson, write_csv, write_json, write_stack
from .scene import Scene


def quantized_inputs(scene: Scene):
    """Quantise, then decode: the pipeline classifies exactly the values the
    browser will see, so scientist mode (F16) reproduces the map bit for bit."""
    q_hh = raster.quantize_db(scene.hh_db)
    q_hv = raster.quantize_db(scene.hv_db)
    q_sp = raster.quantize_spread(scene.spread_db)
    return (q_hh, q_hv, q_sp), (
        raster.dequantize_db(q_hh),
        raster.dequantize_db(q_hv),
        raster.dequantize_spread(q_sp),
    )


# JRC occurrence at or above this share of 1984–2021 counts as "usually water" (docs/10 D-059).
USUAL_WATER_PCT = 75
LEVEL_STEP_CM = 2.0
LEVEL_OFFSET_CM = -256.0  # uint8 1…255 → −254…+254 cm; 0 = not measured
COVER_BINS = (0, 20, 40, 60, 80, 101)


def quantize_level(dh_cm: np.ndarray) -> np.ndarray:
    q = np.zeros(dh_cm.shape, dtype=np.uint8)
    ok = np.isfinite(dh_cm)
    q[ok] = np.clip(np.round((dh_cm[ok] - LEVEL_OFFSET_CM) / LEVEL_STEP_CM), 1, 255).astype(
        np.uint8
    )
    return q


# GLWD v2 classes (1-33) grouped for the app's text; the full table is in docs/12 §10.
GLWD_GROUPS = {
    "0": "dryland",
    **{str(c): "open_water" for c in range(1, 8)},
    **{str(c): "forested_wetland" for c in (8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28)},
    **{str(c): "wetland" for c in (9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 30, 31, 32)},
    "33": "rice",
}
HAND_MAX_M = 15.0  # the map ramp ends here: higher ground is shown as clear
HAND_LOW_M = 5.0  # "low ground" for the terrain check: within reach of a flooding river
SOURCE_HAND = "ASF GLO-30 HAND (Copernicus DEM)"


def as_uint8(values: np.ndarray | None, shape, nodata: int = 255) -> np.ndarray:
    if values is None:
        return np.full(shape, nodata, dtype=np.uint8)
    out = np.full(shape, nodata, dtype=np.uint8)
    ok = np.isfinite(values)
    out[ok] = np.clip(np.round(values[ok]), 0, nodata - 1).astype(np.uint8)
    return out


def r_with_area(dates, flooded_km2, series, max_gap_days: int = 3):
    """Pearson r between flooded area and an observation series matched within ±3 days."""
    pairs = []
    for d, a in zip(dates, flooded_km2, strict=True):
        near = [(abs((sd - d).days), v) for sd, v in series if abs((sd - d).days) <= max_gap_days]
        if near:
            pairs.append((a, min(near)[1]))
    if len(pairs) < 3:
        return None, len(pairs)
    x, y = zip(*pairs, strict=True)
    r = validate.pearson(x, y)
    return (None if r is None else round(r, 3)), len(pairs)


def phase_to_level_cm(lc, cls_start, cls_end, sign: float):
    """Double-bounce InSAR: water-level change under flooded vegetation (docs/12 §3).

    Δh = sign · λ · Δφ / (4π · cos θ). Phase is referenced to coherent, stable dry ground in
    both passes (assumes no ground motion in 12 days); only coherent flooded vegetation in
    both passes is measured (Alsdorf et al. 2000; Wdowinski et al. 2004 (verify)).
    """
    from .config import DRY

    coh = lc.coherence
    ph = lc.phase_rad
    stable = (cls_start == DRY) & (cls_end == DRY) & (coh > 0.5) & np.isfinite(ph)
    flooded = (cls_start == FLOODED_VEG) & (cls_end == FLOODED_VEG)
    measured = flooded & (coh > 0.35) & np.isfinite(ph)
    if stable.sum() < 50 or measured.sum() < 20:
        return None, float(measured.sum() / max(flooded.sum(), 1))
    ref = float(np.median(ph[stable]))
    k = lc.wavelength_m / (4 * np.pi * np.cos(np.deg2rad(lc.incidence_deg))) * 100
    dh = np.full(ph.shape, np.nan)
    dh[measured] = sign * k * (ph[measured] - ref)
    return dh, float(measured.sum() / max(flooded.sum(), 1))


def level_diagnosis(lc, cls_start, cls_end) -> dict:
    """Why a pair has a level-change map or not, in counts the app can say (docs/10 D-081).

    The measurement needs phase over the box, coherent dry ground to reference it, and pixels
    that were water under the trees on both passes; any one missing leaves the map empty."""
    from .config import DRY

    ph = lc.phase_rad
    if ph is None:
        return {"phase_share": 0.0, "flooded_px": 0, "empty_reason": "no_phase"}
    fin = np.isfinite(ph)
    coh = lc.coherence
    flooded = (cls_start == FLOODED_VEG) & (cls_end == FLOODED_VEG) & fin
    stable = (cls_start == DRY) & (cls_end == DRY) & (coh > 0.5) & fin
    measured = flooded & (coh > 0.35)
    if fin.mean() < 0.05:
        reason = "no_phase"
    elif stable.sum() < 50:
        reason = "no_reference"
    elif measured.sum() < 20:
        reason = "too_few_flooded"
    else:
        reason = None
    return {
        "phase_share": round(float(fin.mean()), 3),
        "flooded_px": int(flooded.sum()),
        "empty_reason": reason,
    }


def insar_sign(scene: Scene, cls, day_index) -> tuple[float, dict]:
    """Pick the phase sign that makes radar level change agree with the river gauge.

    NISAR's GUNW sign convention is not stated in the product attributes (TODO(verify)),
    so an independent measurement decides, and the summary says so.
    """
    if scene.gauge is None:
        return 1.0, {"status": "no_gauge", "strong": None, "total": None, "r": None}
    stage = dict(scene.gauge.daily)
    xs, ys = [], []
    for lc in scene.level_changes:
        if lc.phase_rad is None or lc.start not in day_index or lc.end not in day_index:
            continue
        dh, _ = phase_to_level_cm(lc, cls[day_index[lc.start]], cls[day_index[lc.end]], 1.0)
        if dh is None or lc.start not in stage or lc.end not in stage:
            continue
        xs.append(float(np.nanmedian(dh)))
        ys.append(stage[lc.end] - stage[lc.start])
    # A sign can only be judged from real changes: at least 4 pairs whose median exceeds
    # the 2 cm noise floor (docs/10 D-041); otherwise say so instead of guessing.
    strong = [(x, y) for x, y in zip(xs, ys, strict=True) if abs(x) >= 2.0]
    r = validate.pearson(*zip(*strong, strict=True)) if len(strong) >= 4 else None
    if r is None:
        return 1.0, {"status": "undetermined", "strong": len(strong), "total": len(xs), "r": None}
    sign = 1.0 if r >= 0 else -1.0
    return sign, {"status": "gauge", "strong": len(strong), "total": len(xs), "r": round(abs(r), 2)}


def grdi_fields(scene: Scene, hidden, dx_m: float, dy_m: float) -> dict:
    """Population-weighted SEDAC deprivation near the hidden flood vs the whole site."""
    if scene.grdi is None or scene.exposure is None:
        return {"grdi_near_flood": None, "grdi_site": None}
    pop = scene.exposure.population
    grdi = scene.grdi
    ok = np.isfinite(grdi) & (pop > 0)

    def weighted(mask):
        m = mask & ok
        total = pop[m].sum()
        return round(float((grdi[m] * pop[m]).sum() / total), 1) if total > 0 else None

    near = exposure.dilate_m(hidden, EXPOSURE_BUFFER_M, dx_m, dy_m) if hidden.any() else hidden
    return {"grdi_near_flood": weighted(near), "grdi_site": weighted(np.ones_like(hidden))}


def calibration_summary(site: dict) -> dict | None:
    """Held-out scores from `cli.py calibrate --apply` (docs/10 D-044), or None."""
    cal = site.get("calibration")
    if not cal or "flooded_veg" not in cal:
        return None
    keep = ("applied", "held_out_before", "held_out_after", "rejected_code")
    return {
        c: {
            **{k.removesuffix("_code"): cal[c].get(k) for k in keep},
            "label_sources": list(cal[c].get("label_sources", [])),
        }
        for c in ("flooded_veg", "open_water")
    }


def build_site(scene: Scene, out_root: Path, t: Thresholds | None = None) -> dict:
    t = t or Thresholds()
    site = scene.site
    out = out_root / site["id"]
    h, w = scene.shape
    n = len(scene.dates)
    area = raster.pixel_area_km2(scene.bounds, h, w)
    dx_m, dy_m = raster.pixel_size_m(scene.bounds, h, w)
    warnings = list(scene.warnings)

    # Terrain gate (NASADEM): no hidden-flood claim on high ground. Applied to the veg layer
    # that is exported, so the browser's rules.js still reproduces the map exactly.
    veg = scene.veg.astype(np.uint8).copy()
    gated = np.zeros((h, w), dtype=bool)
    if scene.terrain_gate is not None:
        gated = scene.terrain_gate & (veg == VEG_YES)
        veg[gated] = VEG_OTHER

    (q_hh, q_hv, q_sp), (hh, hv, sp) = quantized_inputs(scene)
    cls, conf = classify(hh, hv, sp, veg, t)
    areas = products.pass_areas(cls, conf, area)
    hydro = products.hydroperiod_days(cls, conf, scene.dates)
    peak = products.peak_index(areas)
    cband = scene.cband if scene.cband is not None else np.zeros((n, h, w), dtype=np.uint8)

    usual_mask = (
        np.nan_to_num(scene.jrc_occurrence, nan=0.0) >= USUAL_WATER_PCT
        if scene.jrc_occurrence is not None
        else None
    )
    passes = []
    for i, d in enumerate(scene.dates):
        pid = f"p{i + 1:02d}"
        cdate = scene.cband_dates[i] if scene.cband_dates else None
        png.write_png(out / "passes" / f"{pid}_class.png", png.colour_classes(cls[i], conf[i]))
        hidden = None
        hidden_low = None
        cband_png = None
        if cdate is not None and np.any(cband[i] > 0):
            hidden = products.hidden_from_cband_km2(cls[i], conf[i], cband[i], area)
            hidden_low = products.hidden_low_conf_km2(cls[i], conf[i], cband[i], area)
            cband_png = f"passes/{pid}_cband.png"
            png.write_png(out / cband_png, png.colour_cband(cband[i]))
        else:
            cdate = None
            warnings.append({"code": "no_cband_match", "detail": f"{pid} {d.isoformat()}"})
        obs = scene.optical_obs[i] if scene.optical_obs else None
        passes_optical = {
            "optical_date": None,
            "optical_water_km2": None,
            "optical_clear_fraction": None,
        }
        if obs is not None:
            passes_optical = {
                "optical_date": obs.day.isoformat(),
                "optical_water_km2": round(float(((obs.water & obs.clear) * area).sum()), 3),
                "optical_clear_fraction": round(float(obs.clear.mean()), 3),
            }
        rtc_date = scene.rtc_dates[i] if scene.rtc_dates else None
        # v9: water this pass where water usually is (JRC occurrence ≥ USUAL_WATER_PCT).
        usual = None
        if usual_mask is not None:
            usual = round(float(((is_flooded(cls[i]) & usual_mask) * area).sum()), 3)
        passes.append(
            {
                "usual_water_km2": usual,
                "rtc_date": rtc_date.isoformat() if rtc_date else None,
                "id": pid,
                "date": d.isoformat(),
                "acquired_utc": (
                    scene.acquired[i].strftime("%Y-%m-%dT%H:%M:%SZ")
                    if scene.acquired and scene.acquired[i]
                    else None
                ),
                **areas[i],
                "hidden_from_cband_km2": hidden,
                "hidden_low_conf_km2": hidden_low,
                "cband_date": None if cdate is None else cdate.isoformat(),
                **passes_optical,
                "class_png": f"passes/{pid}_class.png",
                "cband_png": cband_png,
                # D-101: only where another track filled this pass's swath gap.
                **({"fill": scene.fill[i]} if scene.fill and scene.fill[i] else {}),
            }
        )

    max_days = int(hydro.max())
    png.write_png(out / "hydroperiod.png", png.colour_hydroperiod(hydro, max_days))
    season_days = int(round(products.pass_weights_days(scene.dates).sum()))

    # Water-level change ending at each pass (NISAR GUNW), 0 = not measured.
    q_level = np.zeros((n, h, w), dtype=np.uint8)
    level_entries = []
    day_index = {d: i for i, d in enumerate(scene.dates)}
    sign, sign_info = insar_sign(scene, cls, day_index)
    for lc in scene.level_changes:
        if (
            lc.dh_cm is None
            and lc.phase_rad is not None
            and lc.start in day_index
            and lc.end in day_index
        ):
            lc.dh_cm, lc.coherent_share = phase_to_level_cm(
                lc, cls[day_index[lc.start]], cls[day_index[lc.end]], sign
            )
        if lc.dh_cm is None:
            lc.dh_cm = np.full((h, w), np.nan)
        elif scene.synthetic:
            sign_info = {"status": "synthetic", "strong": None, "total": None, "r": None}
    vmax_level = max(
        [
            float(np.nanpercentile(np.abs(lc.dh_cm), 95))
            for lc in scene.level_changes
            if np.isfinite(lc.dh_cm).any()
        ]
        or [0.0]
    )
    for lc in scene.level_changes:
        dh = lc.dh_cm if lc.dh_cm is not None else np.full((h, w), np.nan)
        diag = (
            level_diagnosis(lc, cls[day_index[lc.start]], cls[day_index[lc.end]])
            if lc.start in day_index and lc.end in day_index and not scene.synthetic
            else {"phase_share": None, "flooded_px": None, "empty_reason": None}
        )
        rel = f"level/{lc.start.isoformat()}_{lc.end.isoformat()}.png"
        png.write_png(out / rel, png.colour_level_change(dh, max(vmax_level, 1.0)))
        if lc.end in day_index:
            q_level[day_index[lc.end]] = quantize_level(dh)
        v = dh[np.isfinite(dh)]
        level_entries.append(
            {
                "from": lc.start.isoformat(),
                "to": lc.end.isoformat(),
                "png": rel,
                "median_cm": round(float(np.median(v)), 1) if v.size else None,
                "p10_cm": round(float(np.percentile(v, 10)), 1) if v.size else None,
                "p90_cm": round(float(np.percentile(v, 90)), 1) if v.size else None,
                "n_px": int(v.size),
                "coherent_share": round(float(lc.coherent_share), 3),
                # Why the map is empty, when it is (D-081): no_phase, no_reference, too_few_flooded.
                **diag,
                # v10: structured, so the app can say it in words in every language.
                "sign_status": sign_info["status"],
                "sign_pairs_strong": sign_info["strong"],
                "sign_pairs_total": sign_info["total"],
                "sign_r": sign_info["r"],
                "scale_cm": round(max(vmax_level, 1.0), 1),
            }
        )
    if not scene.level_changes:
        warnings.append({"code": "no_level_change", "detail": ""})

    cover_u8 = as_uint8(scene.canopy_cover_pct, (h, w))
    height_u8 = as_uint8(scene.canopy_height_m, (h, w))
    q_vv = (
        raster.quantize_db(scene.rtc_vv_db)
        if scene.rtc_vv_db is not None
        else np.zeros((n, h, w), np.uint8)
    )
    q_vh = (
        raster.quantize_db(scene.rtc_vh_db)
        if scene.rtc_vh_db is not None
        else np.zeros((n, h, w), np.uint8)
    )
    planes = [q_hh, q_hv, q_sp, cband.astype(np.uint8), q_level, q_vv, q_vh]
    if scene.fill_mask is not None:  # D-101: last, so readers that skip it see v14 as before
        planes.append(scene.fill_mask.astype(np.uint8))
    write_stack(out / "stack.bin", planes)
    jrc_u8 = as_uint8(scene.jrc_occurrence, (h, w))
    # v11: HAND in 0.5 m steps up to 127 m (255 = no data).
    hand_u8 = as_uint8(None if scene.hand_m is None else scene.hand_m * 2, (h, w))
    glwd_u8 = (
        scene.glwd_class.astype(np.uint8)
        if scene.glwd_class is not None
        else np.full((h, w), 255, dtype=np.uint8)
    )
    # v13: burned forest (fire sites only), from the ungated vegetation: hilltop forest burns too.
    burn_doc, burn_pass = None, None
    if site.get("fire"):
        from . import burn as burn_mod

        burn_doc, burn_pass = burn_mod.summarise(
            scene, hh, hv, scene.veg, area, out, cls=cls, flooded_code=FLOODED_VEG
        )
    statics = [veg, hydro, cover_u8, height_u8, gated.astype(np.uint8), jrc_u8, hand_u8, glwd_u8]
    write_stack(out / "static.bin", statics + ([burn_pass] if burn_pass is not None else []))
    glwd = None
    if scene.glwd_class is not None and (scene.glwd_class != 255).any():
        from .global_layers import GLWD_FORESTED

        known = scene.glwd_class != 255
        forested = np.isin(scene.glwd_class, GLWD_FORESTED)
        wetland = known & (scene.glwd_class >= 8)  # any vegetated wetland class, rice included

        def pct(m, of):
            n_known = int((m & known).sum())
            return round(100 * float((m & of).sum()) / n_known, 1) if n_known >= 20 else None

        groups = {
            "hidden": cls[peak] == FLOODED_VEG,
            "dry_veg": (cls[peak] == DRY) & (veg == VEG_YES),
            "site": np.ones((h, w), dtype=bool),
        }
        # Independent of the radar: GLWD maps where wetlands usually are, not this pass.
        glwd = {"source": "GLWD v2.0 (Lehner et al. 2025)"}
        for k, m in groups.items():
            glwd[f"{k}_wetland_pct"] = pct(m, wetland)
            glwd[f"{k}_forested_pct"] = pct(m, forested)
    hand = None
    if scene.hand_m is not None and np.isfinite(scene.hand_m).any():
        png.write_png(out / "hand.png", png.colour_hand(scene.hand_m, HAND_MAX_M))
        ok = np.isfinite(scene.hand_m)
        # The physical check compares like with like: the DEM is a surface model that sees the
        # treetops, so forest is set against forest (water under trees vs dry vegetation).
        groups = {
            "hidden": cls[peak] == FLOODED_VEG,
            "dry_veg": (cls[peak] == DRY) & (veg == VEG_YES),
            "open_water": cls[peak] == OPEN_WATER,
        }

        def median_m(m):
            v = scene.hand_m[m & ok]
            return round(float(np.median(v)), 1) if v.size >= 20 else None

        def low_pct(m):
            n_ok = int((m & ok).sum())
            return (
                round(100 * float((m & ok & (scene.hand_m <= HAND_LOW_M)).sum()) / n_ok, 1)
                if n_ok >= 20
                else None
            )

        hand = {
            "png": "hand.png",
            "max_m": HAND_MAX_M,
            "low_m": HAND_LOW_M,
            "source": SOURCE_HAND,
            **{f"{k}_median_m": median_m(m) for k, m in groups.items()},
            **{f"{k}_low_pct": low_pct(m) for k, m in groups.items()},
        }

    canopy = None
    if scene.canopy_cover_pct is not None and np.isfinite(scene.canopy_cover_pct).any():
        png.write_png(out / "canopy_cover.png", png.colour_scalar(scene.canopy_cover_pct, 100.0))
        hmax = (
            float(np.nanpercentile(scene.canopy_height_m, 98))
            if scene.canopy_height_m is not None
            else 0
        )
        png.write_png(
            out / "canopy_height.png",
            png.colour_scalar(
                scene.canopy_height_m
                if scene.canopy_height_m is not None
                else np.full((h, w), np.nan),
                max(hmax, 1.0),
            ),
        )
        bins = []
        judged = (veg == VEG_YES) & (cls[peak] > 0)
        for lo, hi in zip(COVER_BINS[:-1], COVER_BINS[1:], strict=True):
            m = judged & (scene.canopy_cover_pct >= lo) & (scene.canopy_cover_pct < hi)
            k = int(m.sum())
            bins.append(
                {
                    "cover_from": lo,
                    "cover_to": min(hi, 100),
                    "pixels": k,
                    "hidden_share": round(float((cls[peak][m] == FLOODED_VEG).mean()), 3)
                    if k
                    else 0.0,
                    "low_conf_share": round(float((conf[peak][m] == 0).mean()), 3) if k else 0.0,
                }
            )
        canopy = {
            "height_max_m": round(max(hmax, 1.0), 1),
            "source": scene.canopy_source or "",
            "height_png": "canopy_height.png",
            "cover_png": "canopy_cover.png",
            "detection_by_cover": bins,
        }
    else:
        warnings.append({"code": "no_canopy", "detail": ""})

    terrain = None
    if scene.terrain_gate is not None:
        terrain = {
            "source": scene.terrain_source or "",
            "rule": scene.terrain_rule or "",
            "gated_km2": round(float((gated * area).sum()), 3),
        }

    reference_map = None
    if scene.reference_cls is not None:
        ref = scene.reference_cls
        ours = cls[peak].astype(int)
        judged = (ref > 0) & np.isin(ours, (DRY, OPEN_WATER, FLOODED_VEG))
        if judged.sum() >= 100:

            def recall(code):
                m = judged & (ref == code)
                return round(float((ours[m] == code).mean()), 3) if m.sum() >= 20 else None

            reference_map = {
                "name": scene.reference_name or "",
                "reference_period": scene.reference_period or "",
                "compared_pass": passes[peak]["id"],
                "agreement": round(float((ours[judged] == ref[judged]).mean()), 3),
                "recall_water": recall(OPEN_WATER),
                "recall_flooded_veg": recall(FLOODED_VEG),
                "n_px": int(judged.sum()),
            }

    swot = []
    flooded_series = [a["flooded_km2"] for a in areas]
    for feat in scene.swot:
        r, k = r_with_area(scene.dates, flooded_series, feat["series"])
        if k < validate.MIN_PASSES_FOR_R - 1:
            r = None  # too few matched overpasses for a meaningful correlation (as for the gauge)
        swot.append(
            {
                "id": str(feat["id"]),
                "name": feat["name"],
                "kind": feat["kind"],
                "series": [
                    {"date": d.isoformat(), "wse_m": round(v, 3)} for d, v in feat["series"]
                ],
                "r": r,
                "n": k,
            }
        )
    if not swot:
        warnings.append({"code": "no_swot", "detail": ""})
    icesat2 = []
    for feat in scene.icesat2:
        r, k = r_with_area(scene.dates, flooded_series, feat["series"])
        icesat2.append(
            {
                "id": str(feat["id"]),
                "name": feat["name"],
                "kind": feat["kind"],
                "series": [
                    {"date": d.isoformat(), "wse_m": round(v, 3)} for d, v in feat["series"]
                ],
                "r": r if k >= validate.MIN_PASSES_FOR_R - 1 else None,
                "n": k,
            }
        )
    # Calibration describes real radar at a real site; synthetic scenes never carry it.
    cal = None if scene.synthetic else site.get("calibration", {}).get("flooded_veg")
    if not scene.synthetic and (cal is None or cal.get("held_out_after") is None):
        warnings.append({"code": "hidden_flood_uncalibrated", "detail": "no local labels yet"})
    # Score of the rule actually in use: tuned if applied, otherwise the defaults.
    score = (
        (cal.get("held_out_after") if cal.get("applied") else cal.get("held_out_before"))
        if cal
        else None
    )
    if score is not None and score < 0.7:
        warnings.append(
            {"code": "hidden_flood_unvalidated", "detail": f"held-out balanced accuracy {score}"}
        )
    ctx = scene.context
    context = {
        "rain_daily": [[d.isoformat(), round(v, 2)] for d, v in ctx.rain_daily],
        "rain_source": ctx.rain_source,
        "inundation_daily": [[d.isoformat(), round(v, 4)] for d, v in ctx.inundation_daily],
        "inundation_source": ctx.inundation_source,
        "soil_moisture": [[d.isoformat(), round(v, 4)] for d, v in ctx.soil_moisture],
        "soil_moisture_source": ctx.soil_moisture_source,
        "water_storage_monthly": [
            [d.isoformat(), round(v, 2)] for d, v in ctx.water_storage_monthly
        ],
        "water_storage_source": ctx.water_storage_source,
    }

    optical = None
    if scene.optical_rgb is not None:
        png.write_png(out / "optical.png", scene.optical_rgb)
        img = scene.optical_rgb
        seen = img[..., 3] > 0 if img.shape[2] == 4 else np.ones(img.shape[:2], bool)
        cloud = scene.optical_cloud
        if cloud is None:  # synthetic: bright pixels stand in for cloud
            bright = img[..., :3].min(axis=2) > 225
            cloud = float(bright[seen].mean()) if seen.any() else 0.0
        optical = {
            "png": "optical.png",
            "date": scene.optical_date.isoformat() if scene.optical_date else None,
            "cloud_fraction": round(float(cloud), 3),
        }
    else:
        warnings.append({"code": "no_optical", "detail": ""})

    gauge = None
    if scene.gauge is not None:
        g = validate.gauge_validation(
            scene.dates, [a["flooded_km2"] for a in areas], scene.gauge.daily
        )
        lo = scene.dates[0] - timedelta(days=validate.MAX_LAG_DAYS)
        hi = scene.dates[-1] + timedelta(days=validate.MAX_LAG_DAYS)
        gauge = {
            "id": scene.gauge.id,
            "name": scene.gauge.name,
            "source": scene.gauge.source,
            "units": scene.gauge.units,
            "series": g["series"],
            "stage_daily": [
                [d.isoformat(), round(s, 3)] for d, s in scene.gauge.daily if lo <= d <= hi
            ],
            "r": g["r"],
            "n": g["n"],
            "best_lag_days": g["best_lag_days"],
            "r_best": g["r_best"],
        }
        if not g["enough_passes"]:
            warnings.append({"code": "few_passes_for_r", "detail": f"n={g['n']}"})
    else:
        warnings.append({"code": "no_gauge", "detail": ""})

    expo = None
    if scene.exposure is not None:
        flooded_peak = is_flooded(cls[peak])
        hidden_peak = cls[peak] == FLOODED_VEG
        total_road_km, per_road = exposure.roads_flooded_km(
            scene.exposure.roads, flooded_peak, scene.bounds
        )
        write_json(out / "roads.geojson", roads_geojson(per_road))
        expo = {
            "buffer_m": int(EXPOSURE_BUFFER_M),
            "population_near_hidden_flood": exposure.population_near(
                scene.exposure.population, hidden_peak, EXPOSURE_BUFFER_M, dx_m, dy_m
            ),
            "roads_flooded_km": total_road_km,
            **grdi_fields(scene, hidden_peak, dx_m, dy_m),
            "roads_geojson": "roads.geojson",
            "places": exposure.places_report(
                scene.exposure.places, flooded_peak, hydro, scene.bounds
            ),
        }
    else:
        warnings.append({"code": "no_exposure", "detail": ""})

    # F11 open data: areas per pass, the peak flood as GeoJSON, places.
    downloads = []
    write_csv(
        out / "export" / "areas.csv",
        [
            "pass_id",
            "date",
            "flooded_veg_km2",
            "open_water_km2",
            "flooded_km2",
            "hidden_from_cband_km2",
            "cband_date",
            "low_conf_fraction",
        ],
        [
            [
                p["id"],
                p["date"],
                p["flooded_veg_km2"],
                p["open_water_km2"],
                p["flooded_km2"],
                p["hidden_from_cband_km2"],
                p["cband_date"],
                p["low_conf_fraction"],
            ]
            for p in passes
        ],
    )
    downloads.append({"label_key": "download.areas_csv", "path": "export/areas.csv"})
    peak_id = passes[peak]["id"]
    write_json(
        out / "export" / f"flood_{peak_id}.geojson",
        flood_geojson(
            cls[peak],
            conf[peak],
            scene.bounds,
            {FLOODED_VEG: "flooded_vegetation", OPEN_WATER: "open_water"},
        ),
        compact=True,
    )
    downloads.append(
        {"label_key": "download.flood_geojson", "path": f"export/flood_{peak_id}.geojson"}
    )
    if expo is not None:
        write_csv(
            out / "export" / "places.csv",
            ["name", "lon", "lat", "population", "nearest_flood_m", "days_flooded"],
            [
                [
                    p["name"],
                    p["lon"],
                    p["lat"],
                    p["population"],
                    p["nearest_flood_m"],
                    p["days_flooded"],
                ]
                for p in expo["places"]
            ],
        )
        downloads.append({"label_key": "download.places_csv", "path": "export/places.csv"})

    west, south, east, north = scene.bounds
    summary = {
        "schema_version": SCHEMA_VERSION,
        "synthetic": bool(scene.synthetic),
        "site": {
            "id": site["id"],
            "name": site["name"],
            "country": site.get("country") or None,  # places analysed here have no country lookup
            "center": [round((west + east) / 2, 6), round((south + north) / 2, 6)],
            "zoom": int(site.get("zoom", 12)),
            "kind": site.get("kind", "flood"),  # v13: flood | fire
        },
        "grid": {
            "width": int(w),
            "height": int(h),
            "bounds": [west, south, east, north],
            "crs": "EPSG:4326",
            "pixel_size_m": round((dx_m + dy_m) / 2, 1),
        },
        "track": {"number": scene.track_number, "direction": scene.direction},
        "thresholds": t.to_dict(),
        "passes": passes,
        "peak_pass": passes[peak]["id"],
        "grid_stack": {
            "stack_file": "stack.bin",
            "static_file": "static.bin",
            "order": "layer, pass, row, col",
            "layers": [
                {"name": "hh", "scale": 0.25, "offset": -50, "nodata": 0},
                {"name": "hv", "scale": 0.25, "offset": -50, "nodata": 0},
                {"name": "hh_spread", "scale": 0.25, "offset": 0, "nodata": None},
                {"name": "cband", "codes": {"0": "no_data", "1": "not_water", "2": "water"}},
                {
                    "name": "level_cm",
                    "scale": LEVEL_STEP_CM,
                    "offset": LEVEL_OFFSET_CM,
                    "nodata": 0,
                },
                {"name": "vv", "scale": 0.25, "offset": -50, "nodata": 0},
                {"name": "vh", "scale": 0.25, "offset": -50, "nodata": 0},
                *(
                    [{"name": "fill", "codes": {"0": "own_track", "1": "other_track"}}]
                    if scene.fill_mask is not None
                    else []
                ),
            ],
            "static_layers": [
                {"name": "veg", "codes": {"0": "other", "1": "vegetation", "2": "built_up"}},
                {"name": "hydroperiod_days", "scale": 1, "offset": 0, "nodata": None},
                {"name": "canopy_cover_pct", "scale": 1, "offset": 0, "nodata": 255},
                {"name": "canopy_height_m", "scale": 1, "offset": 0, "nodata": 255},
                {"name": "terrain_gate", "codes": {"0": "floodable", "1": "high_ground"}},
                {"name": "jrc_occurrence", "scale": 1, "offset": 0, "nodata": 255},
                {"name": "hand_m", "scale": 0.5, "offset": 0, "nodata": 255},
                {"name": "glwd_class", "nodata": 255, "codes": GLWD_GROUPS},
                *(
                    [{"name": "burn_pass", "scale": 1, "offset": 0, "nodata": None}]
                    if burn_pass is not None
                    else []
                ),
            ],
        },
        "products": {
            "hydroperiod": {
                "png": "hydroperiod.png",
                "max_days": max_days,
                "season_days": season_days,
                "flooded_any_km2": round(float(((hydro > 0) * area).sum()), 3),
            },
            "optical": optical,
            "level_change": level_entries,
            "canopy": canopy,
            "terrain": terrain,
            "hand": hand,
            "glwd": glwd,
            "outlook": outlook_mod.outlook(passes, scene.river, float(area.sum()))
            if scene.river
            else None,
            "burn": burn_doc,
        },
        "context": context,
        "validation": {
            "gauge": gauge,
            "reference_map": reference_map,
            "swot": swot,
            "icesat2": icesat2,
            "calibration": None if scene.synthetic else calibration_summary(site),
        },
        "exposure": expo,
        "downloads": downloads,
        "warnings": warnings,
        "sources": scene.sources,
    }
    write_json(out / "summary.json", summary)
    return summary
