"""Ground that moved (contract v13, docs/14): line-of-sight motion from NISAR GUNW interferograms.

Two kinds of event (config/motion.json):
- earthquake: each geometry (track and direction) with a 12-day pair spanning the event is mapped
  on its own; where ascending and descending geometries overlap, the motion is split into east
  and up (north is left out: these orbits barely see it);
- subsidence: consecutive 12-day pairs of a geometry are summed into a time series and a rate is
  fitted per pixel; ascending and descending rates give vertical and east rates.

Each pair is the product's unwrapped HH phase minus its own ionosphere phase screen, kept where
coherence >= MIN_COHERENCE and inside the largest connected component of each frame (pixels in
other components carry an unknown multiple of 2π). The frames of one pair are joined by their
median difference where they overlap, then referenced to the event's stable-ground box.
Troposphere and solid-earth tides are not removed yet (the product carries model screens for
both), so a few centimetres of long-wavelength error remain; a pre-event pair measures it.

Sign: positive = toward the satellite. NISAR phase grows with range (ISCE3 forms reference ×
conj(secondary)), and Mexico City's sinking lakebed confirms it (docs/10 D-074).

Checks shipped with each event (docs/10 D-082): for an earthquake, the surface motion predicted
by the USGS finite-fault model (Okada 1985, canopy/okada.py) per geometry, with the fit on the
geometries USGS used and on any it did not (held out), and the agreement with JPL's own processing
of the same NISAR pairs (the points USGS resampled); for subsidence, GNSS stations (NGL) projected
on each line of sight. Every plane says its unit and, where measured, its noise (1σ).
"""

from __future__ import annotations

import gzip
import json
import time
from datetime import date, datetime
from pathlib import Path

import numpy as np

from . import config, geo, io_gcov

GUNW = "NISAR_L2_GUNW_PROVISIONAL_V1"
LAYER = "/science/LSAR/GUNW/grids/frequencyA/unwrappedInterferogram/"
RADAR_GRID = "/science/LSAR/GUNW/metadata/radarGrid/"
MIN_COHERENCE = 0.3
MIN_OVERLAP_PX = 200  # frames that share fewer grid cells cannot be tied together
# Two frames of one pair should differ by a constant where they overlap; a larger spread left
# after removing it (≈ 3 cm of line of sight) means they cannot be tied (Venezuela 162 A: a
# swath-edge strip of the second frame jumped 7-44 cm from its neighbours).
MAX_TIE_SPREAD_RAD = 1.5
JOIN_VERSION = 2  # pair files written by an older join are read again
READ_VERSION = 2  # 2: the product's mask applied (swath edges and water out); older files re-read
MIN_REFERENCE_PX = 30
MIN_RATE_POINTS = 5
MIN_MEASURED_SHARE = 0.05  # a geometry that measures less of the grid adds noise, not a view
PHASE_TO_TOWARD = -1.0  # module docstring; docs/10 D-074
NODATA_I16 = -32768
SCALE_CM = 0.1  # binary planes in millimetres unless a plane gives its own `scale`
BINARY = "motion.bin.gz"  # int16 little-endian planes, gzip
# Motion files are versioned on their own from 14 on (D-082); 15 adds the before_* planes (D-090).
MOTION_SCHEMA = 15
YEAR_DAYS = 365.25
EVENTS_FILE = config.PIPELINE_DIR / "config" / "motion.json"


def load_events() -> list[dict]:
    return json.loads(EVENTS_FILE.read_text(encoding="utf-8"))["events"]


def get_event(event_id: str) -> dict:
    for e in load_events():
        if e["id"] == event_id:
            return e
    raise SystemExit(f"unknown motion event {event_id!r} (pipeline/config/motion.json)")


# ---------------------------------------------------------------- grid and names


def grid_shape(event: dict) -> tuple[int, int]:
    """Rows and columns of the event's lon/lat grid at about res_m."""
    w, s, e, n = event["bbox"]
    lat0 = np.deg2rad((s + n) / 2)
    width = int(round((e - w) * 111_320 * np.cos(lat0) / event["res_m"]))
    height = int(round((n - s) * 110_574 / event["res_m"]))
    return height, width


def grid_lonlat(event: dict) -> tuple[np.ndarray, np.ndarray]:
    """Cell-centre longitude and latitude, shape (H, W), row 0 at the north edge."""
    h, w = grid_shape(event)
    west, south, east, north = event["bbox"]
    lon = west + (np.arange(w) + 0.5) * (east - west) / w
    lat = north - (np.arange(h) + 0.5) * (north - south) / h
    return np.meshgrid(lon, lat)


def parse_gunw(name: str) -> dict | None:
    """Track, direction, frame and the two acquisition days from a GUNW granule name."""
    p = name.split("_")
    if len(p) < 15 or p[3] != "GUNW":
        return None
    try:
        return {
            "track": int(p[5]),
            "direction": "ascending" if p[6] == "A" else "descending",
            "frame": p[7],
            "start": datetime.strptime(p[11][:8], "%Y%m%d").date(),
            "end": datetime.strptime(p[13][:8], "%Y%m%d").date(),
            "version": p[-1],
            "name": name,
        }
    except ValueError:
        return None


def geom_key(track: int, direction: str) -> str:
    return f"{track:03d}{direction[0].upper()}"


# ---------------------------------------------------------------- pure processing


def main_component(phase, coherence, components, min_coherence: float = MIN_COHERENCE):
    """Phase kept only where it is coherent and in the largest connected component."""
    cc = np.asarray(components)
    ok = np.isfinite(phase) & (cc > 0) & (cc != 65535) & (np.asarray(coherence) >= min_coherence)
    if not ok.any():
        return np.full(np.shape(phase), np.nan)
    vals, counts = np.unique(cc[ok], return_counts=True)
    return np.where(ok & (cc == vals[np.argmax(counts)]), phase, np.nan)


def mask_valid(mask) -> np.ndarray:
    """Usable cells by the GUNW `mask` layer (spec D-102272 Rev E): decimal digits for the water
    flag and the reference and secondary sub-swath; a zero sub-swath digit is an invalid sample,
    255 is fill. The provisional products also set bit 24 on most cells; their low 24 bits follow
    the same code (TODO(verify) against a later spec revision). The Venezuela
    swath-edge strip that jumped 7-44 cm from its neighbours is code 0."""
    m = np.asarray(mask).astype(np.int64)
    low = m & 0xFFFFFF
    water = (low // 100) % 10 == 1
    return (m != 255) & ~water & ((low // 10) % 10 > 0) & (low % 10 > 0)


def bilinear(xs, ys, z, x, y):
    """Bilinear interpolation of a regular grid z[y, x] at points (x, y); clamped at the edges."""
    xs = np.asarray(xs, dtype=float)
    ys = np.asarray(ys, dtype=float)
    z = np.asarray(z, dtype=float)
    if xs[0] > xs[-1]:
        xs, z = xs[::-1], z[:, ::-1]
    if ys[0] > ys[-1]:
        ys, z = ys[::-1], z[::-1, :]
    fx = np.clip(np.interp(x, xs, np.arange(xs.size)), 0, xs.size - 1.000001)
    fy = np.clip(np.interp(y, ys, np.arange(ys.size)), 0, ys.size - 1.000001)
    i0, j0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = fx - i0, fy - j0
    return (
        z[j0, i0] * (1 - tx) * (1 - ty)
        + z[j0, i0 + 1] * tx * (1 - ty)
        + z[j0 + 1, i0] * (1 - tx) * ty
        + z[j0 + 1, i0 + 1] * tx * ty
    )


def join_frames(frames: list[dict]) -> tuple[dict, list]:
    """One pair from its frames on a shared grid: the frame with most data first, each other
    frame shifted by its median difference over the cells both cover, then used where the
    first has nothing. A frame is left out when it overlaps too little or when the overlap does
    not agree on one offset (spread above MAX_TIE_SPREAD_RAD). `out["frame"]` says which frame
    each cell came from (-1 none); the second value lists each frame's offset (None = left out)."""
    frames = sorted(frames, key=lambda f: -int(np.isfinite(f["phase"]).sum()))
    out = {
        k: np.array(v, dtype=float, copy=True)
        for k, v in frames[0].items()
        if isinstance(v, np.ndarray)
    }
    out["frame"] = np.where(np.isfinite(out["phase"]), 0.0, -1.0)
    offsets: list = [0.0]
    for idx, fr in enumerate(frames[1:], start=1):
        both = np.isfinite(out["phase"]) & np.isfinite(fr["phase"])
        if both.sum() < MIN_OVERLAP_PX:
            offsets.append(None)
            continue
        diff = fr["phase"][both] - out["phase"][both]
        off = float(np.median(diff))
        if 1.4826 * float(np.median(np.abs(diff - off))) > MAX_TIE_SPREAD_RAD:
            offsets.append(None)
            continue
        add = np.isfinite(fr["phase"]) & ~np.isfinite(out["phase"])
        out["phase"][add] = fr["phase"][add] - off
        for k in out:
            if k not in ("phase", "frame") and k in fr:
                out[k][add] = fr[k][add]
        out["frame"][add] = idx
        offsets.append(off)
    return out, offsets


def box_median(values, lon, lat, box, min_px: int = MIN_REFERENCE_PX) -> float | None:
    inside = (
        (lon >= box[0]) & (lon <= box[2]) & (lat >= box[1]) & (lat <= box[3]) & np.isfinite(values)
    )
    return float(np.median(values[inside])) if inside.sum() >= min_px else None


def phase_to_cm(phase, wavelength_m: float):
    """Unwrapped phase (rad) → line-of-sight motion in cm, positive toward the satellite."""
    return PHASE_TO_TOWARD * wavelength_m / (4 * np.pi) * np.asarray(phase, dtype=float) * 100


def robust_std(values) -> float | None:
    v = np.asarray(values, dtype=float)
    v = v[np.isfinite(v)]
    if v.size < 50:
        return None
    return float(1.4826 * np.median(np.abs(v - np.median(v))))


def decompose(los: list, east: list, up: list, min_det: float = 0.02):
    """Per-pixel east and up motion from LOS maps of several geometries (least squares; north,
    which near-polar orbits barely see, is left out). NaN where fewer than two geometries see the
    pixel or their geometries are too alike to separate east from up."""
    ls, es, us = np.stack(los), np.stack(east), np.stack(up)
    ok = np.isfinite(ls) & np.isfinite(es) & np.isfinite(us)
    w = ok.astype(float)
    l0, e0, u0 = np.where(ok, ls, 0), np.where(ok, es, 0), np.where(ok, us, 0)
    see = (w * e0 * e0).sum(0)
    seu = (w * e0 * u0).sum(0)
    suu = (w * u0 * u0).sum(0)
    sel = (w * e0 * l0).sum(0)
    sul = (w * u0 * l0).sum(0)
    det = see * suu - seu * seu
    good = (ok.sum(0) >= 2) & (det > min_det)
    with np.errstate(invalid="ignore", divide="ignore"):
        de = np.where(good, (suu * sel - seu * sul) / det, np.nan)
        du = np.where(good, (see * sul - seu * sel) / det, np.nan)
    return de, du


def height_slope(phase, dem, mask, min_cells: int = 500, min_relief_m: float = 100.0):
    """Least-squares slope of phase against terrain height (rad per m) over the `mask` cells, or
    None with too few cells or too little relief. Phase that rises or falls with height in a pair
    is mostly water vapour layered over the terrain (a stratified troposphere), not ground."""
    ok = np.asarray(mask) & np.isfinite(phase) & np.isfinite(dem)
    if ok.sum() < min_cells or np.ptp(dem[ok]) < min_relief_m:
        return None
    slope, _ = np.polyfit(dem[ok], phase[ok], 1)
    return float(slope)


def consecutive_chain(pairs: list[dict]) -> list[dict]:
    """The longest run of pairs where each starts on the day the previous one ended."""
    by_start: dict[date, list[dict]] = {}
    for p in pairs:
        by_start.setdefault(p["start"], []).append(p)
    best: list[dict] = []
    for first in sorted(pairs, key=lambda p: p["start"]):
        run, cur = [first], first
        while cur["end"] in by_start:
            cur = min(by_start[cur["end"]], key=lambda p: (p["end"] - p["start"]).days)
            run.append(cur)
        if (run[-1]["end"] - run[0]["start"]).days > (
            (best[-1]["end"] - best[0]["start"]).days if best else -1
        ):
            best = run
    return best


def cumulative(los_maps: list[np.ndarray]) -> np.ndarray:
    """Running sum of consecutive pair maps; a pixel missing in one pair stays missing after it
    (its offset across the gap is unknown). Shape (len + 1, H, W), starting at 0."""
    out = np.zeros((len(los_maps) + 1, *los_maps[0].shape))
    for k, m in enumerate(los_maps):
        out[k + 1] = out[k] + m  # NaN propagates
    out[0][~np.isfinite(out[1])] = np.nan
    return out


def linear_rate(days, series, min_points: int = MIN_RATE_POINTS):
    """Least-squares slope per pixel (units per day) over the finite points of a series."""
    t = np.asarray(days, dtype=float)[:, None, None]
    m = np.isfinite(series)
    y = np.where(m, series, 0.0)
    n = m.sum(0)
    st, sy = (m * t).sum(0), y.sum(0)
    stt, sty = (m * t * t).sum(0), (y * t).sum(0)
    den = n * stt - st * st
    with np.errstate(invalid="ignore", divide="ignore"):
        slope = (n * sty - st * sy) / den
    return np.where((n >= min_points) & (den > 0), slope, np.nan)


# ---------------------------------------------------------------- checks and errors


def rate_sigma(days, series, min_points: int = MIN_RATE_POINTS):
    """Standard error of the per-pixel least-squares slope (units per day), from the scatter of
    the points about the line. The atmosphere of a 12-day pair cancels in the running sum except
    at its two ends, so each date of the series carries its own independent weather and the
    ordinary formula applies (unwrapping errors, which would accumulate, are not covered)."""
    t = np.asarray(days, dtype=float)[:, None, None]
    m = np.isfinite(series)
    n = m.sum(0)
    with np.errstate(invalid="ignore", divide="ignore"):
        tm = (m * t).sum(0) / n
        ym = np.where(m, series, 0.0).sum(0) / n
        dt = np.where(m, t - tm, 0.0)
        dy = np.where(m, series - ym, 0.0)
        stt = (dt * dt).sum(0)
        slope = (dt * dy).sum(0) / stt
        res = np.where(m, dy - slope * dt, 0.0)
        se = np.sqrt((res * res).sum(0) / (n - 2) / stt)
    return np.where((n >= min_points) & (stt > 0), se, np.nan)


def decompose_sigma(sigmas: list, east: list, up: list, min_det: float = 0.02):
    """1σ of the east and up of `decompose` from each geometry's 1σ, propagated through the same
    least-squares solution (geometries independent)."""
    ss, es, us = np.stack(sigmas), np.stack(east), np.stack(up)
    ok = np.isfinite(ss) & np.isfinite(es) & np.isfinite(us)
    e0, u0 = np.where(ok, es, 0), np.where(ok, us, 0)
    w = ok.astype(float)
    see, seu, suu = (w * e0 * e0).sum(0), (w * e0 * u0).sum(0), (w * u0 * u0).sum(0)
    det = see * suu - seu * seu
    good = (ok.sum(0) >= 2) & (det > min_det)
    with np.errstate(invalid="ignore", divide="ignore"):
        me = w * (suu * e0 - seu * u0) / det  # d(east)/d(los_k)
        mu = w * (see * u0 - seu * e0) / det
        s0 = np.where(ok, ss, 0)
        se = np.sqrt((me * me * s0 * s0).sum(0))
        su = np.sqrt((mu * mu * s0 * s0).sum(0))
    return np.where(good, se, np.nan), np.where(good, su, np.nan)


def fit_stats(obs, model) -> dict | None:
    """How a model map fits a data map over the cells both have: correlation, root mean square
    of each and of the residual, and the residual's median and robust spread (cm)."""
    ok = np.isfinite(obs) & np.isfinite(model)
    if ok.sum() < 50:
        return None
    o, m = obs[ok], model[ok]
    r = o - m
    return {
        "n": int(ok.sum()),
        "corr": round(float(np.corrcoef(o, m)[0, 1]), 3),
        "rms_obs_cm": round(float(np.sqrt(np.mean(o * o))), 2),
        "rms_model_cm": round(float(np.sqrt(np.mean(m * m))), 2),
        "rms_resid_cm": round(float(np.sqrt(np.mean(r * r))), 2),
        "median_resid_cm": round(float(np.median(r)), 2),
        "robust_resid_cm": round(float(1.4826 * np.median(np.abs(r - np.median(r)))), 2),
    }


def compare_points(plane, bounds, lon, lat, values, min_cells: int = 3) -> dict | None:
    """Our map against another processing's points (lon, lat, value in cm, same sign): the
    median of our 3 × 3 cells at each point, a constant offset removed (the references differ),
    then correlation, the root mean square of the difference and the slope ours vs theirs."""
    h, w = plane.shape
    west, south, east, north = bounds
    r = np.floor((north - np.asarray(lat)) / (north - south) * h).astype(int)
    c = np.floor((np.asarray(lon) - west) / (east - west) * w).astype(int)
    ours = np.full(len(r), np.nan)
    for k in np.where((r >= 0) & (r < h) & (c >= 0) & (c < w))[0]:
        blk = plane[max(r[k] - 1, 0) : r[k] + 2, max(c[k] - 1, 0) : c[k] + 2]
        if np.isfinite(blk).sum() >= min_cells:
            ours[k] = np.nanmedian(blk)
    ok = np.isfinite(ours) & np.isfinite(values)
    if ok.sum() < 30:
        return None
    x, y = np.asarray(values)[ok], ours[ok]
    off = float(np.median(y - x))
    d = y - x - off
    return {
        "n": int(ok.sum()),
        "corr": round(float(np.corrcoef(x, y)[0, 1]), 3),
        "offset_cm": round(off, 2),
        "rms_diff_cm": round(float(np.sqrt(np.mean(d * d))), 2),
        "slope": round(float(np.polyfit(x, y, 1)[0]), 3),
    }


def profile_ends(p: dict) -> tuple[list[float], list[float]]:
    """A profile from its config: explicit ends, or a centre, an azimuth and a half length."""
    if "a" in p:
        return p["a"], p["b"]
    lon0, lat0 = p["centre"]
    az = np.radians(p["azimuth_deg"])
    dlat = p["half_km"] / 110.574
    dlon = p["half_km"] / (111.320 * np.cos(np.radians(lat0)))
    a = [round(lon0 - dlon * np.sin(az), 4), round(lat0 - dlat * np.cos(az), 4)]
    b = [round(lon0 + dlon * np.sin(az), 4), round(lat0 + dlat * np.cos(az), 4)]
    return a, b


def to_i16(values_cm) -> np.ndarray:
    v = np.asarray(values_cm, dtype=float) / SCALE_CM
    out = np.full(v.shape, NODATA_I16, dtype=np.int16)
    ok = np.isfinite(v)
    out[ok] = np.clip(np.rint(v[ok]), -32767, 32767).astype(np.int16)
    return out


# ---------------------------------------------------------------- network: read pairs


CMR_GRANULES = "https://cmr.earthdata.nasa.gov/search/granules.json"


def cmr_granules(short_name: str, bbox, period) -> list[dict]:
    """Every granule over a box and period, straight from CMR with paging. (earthaccess's search
    left out the Venezuela pairs spanning the quake, although CMR lists them.)"""
    import urllib.parse
    import urllib.request

    q = urllib.parse.urlencode(
        {
            "short_name": short_name,
            "bounding_box": ",".join(str(v) for v in bbox),
            "temporal": f"{period[0]}T00:00:00Z,{period[1]}T23:59:59Z",
            "page_size": 2000,
        }
    )
    out: list[dict] = []
    after = None
    while True:
        headers = {"CMR-Search-After": after} if after else {}
        req = urllib.request.Request(f"{CMR_GRANULES}?{q}", headers=headers)
        with urllib.request.urlopen(req, timeout=120) as r:  # noqa: S310 - fixed NASA host
            entries = json.loads(r.read().decode("utf-8"))["feed"]["entry"]
            after = r.headers.get("CMR-Search-After")
        out += entries
        if not entries or not after:
            return out


def data_url(entry: dict) -> str | None:
    """The HTTPS link to a granule's HDF5 file (not its QA statistics)."""
    for link in entry.get("links", []):
        href = link.get("href", "")
        if href.startswith("https://") and href.endswith(".h5") and "QA_STATS" not in href:
            return href
    return None


def find_pairs(event: dict) -> dict[tuple, dict[str, tuple]]:
    """{(track, direction, start, end): {frame: (info, url)}} over the event box."""
    found: dict[tuple, dict[str, tuple]] = {}
    for entry in cmr_granules(GUNW, event["bbox"], event["search"]):
        info = parse_gunw(entry["title"])
        url = data_url(entry)
        if info is None or url is None:
            continue
        key = (info["track"], info["direction"], info["start"], info["end"])
        prev = found.setdefault(key, {}).get(info["frame"])
        if prev is None or info["version"] > prev[0]["version"]:
            found[key][info["frame"]] = (info, url)
    return found


def wanted_pairs(event: dict, keys: list[tuple]) -> list[tuple]:
    """Which pairs an event needs: for an earthquake the shortest pair spanning it and the last
    pair before it, per geometry; for subsidence the longest consecutive chain of the best
    ascending and the best descending geometry."""
    by_geom: dict[tuple, list[dict]] = {}
    for k in keys:
        by_geom.setdefault(k[:2], []).append({"key": k, "start": k[2], "end": k[3]})
    out = []
    if event["kind"] == "earthquake":
        day = date.fromisoformat(event["event_utc"][:10])
        for ps in by_geom.values():
            across = [p for p in ps if p["start"] < day < p["end"]]
            before = [p for p in ps if p["end"] < day]
            if across:
                out.append(min(across, key=lambda p: (p["end"] - p["start"]).days)["key"])
                if before:
                    out.append(max(before, key=lambda p: p["end"])["key"])
        return out
    best: dict[str, list[dict]] = {}
    for (_track, direction), ps in by_geom.items():
        ch = consecutive_chain(ps)
        span = (ch[-1]["end"] - ch[0]["start"]).days if ch else 0
        cur = best.get(direction)
        if ch and (cur is None or span > (cur[-1]["end"] - cur[0]["start"]).days):
            best[direction] = ch
    return [p["key"] for ch in best.values() for p in ch]


def read_frame(url: str, event: dict) -> dict | None:
    """One frame of one pair on the event grid: phase (ionosphere-corrected, main component),
    coherence, and the east and north parts of the line-of-sight unit vector. The remote file and
    its block cache are closed afterwards: left open, a run of 30 frames ran out of memory."""
    import h5py

    from . import nasa_access as na

    na.login()
    fobj = na._earthaccess().open([url])[0]
    try:
        with h5py.File(fobj, "r") as f:
            return _read_frame(f, event)
    finally:
        fobj.close()


def _read_frame(f, event: dict) -> dict | None:
    bounds = tuple(event["bbox"])
    x, y = f[LAYER + "xCoordinates"][()], f[LAYER + "yCoordinates"][()]
    epsg = int(np.asarray(f[LAYER + "projection"][()]).ravel()[0])
    if not (32601 <= epsg <= 32660 or 32701 <= epsg <= 32760):
        raise ValueError(f"GUNW grid EPSG {epsg} is not UTM")  # TODO(verify): polar grids
    xmin, ymin, xmax, ymax = geo.bounds_in_crs(bounds, epsg)
    cs, rs = io_gcov._slice_for(x, xmin, xmax), io_gcov._slice_for(y, ymin, ymax)
    if cs.stop <= cs.start or rs.stop <= rs.start:
        return None
    ph = f[LAYER + "HH/unwrappedPhase"][rs, cs].astype(np.float64)
    iono = f[LAYER + "HH/ionospherePhaseScreen"][rs, cs].astype(np.float64)
    coh = f[LAYER + "HH/coherenceMagnitude"][rs, cs].astype(np.float64)
    cc = f[LAYER + "HH/connectedComponents"][rs, cs]
    usable = mask_valid(f[LAYER + "mask"][rs, cs]) & np.isfinite(iono)  # no screen: dropped
    corrected = np.where(usable, ph - iono, np.nan)
    phase = main_component(corrected, coh, cc)
    h, w = grid_shape(event)
    xx, yy = np.meshgrid(x[cs], y[rs])
    lon, lat = geo.utm_to_lonlat(xx, yy, epsg)
    acc = geo.Accumulator(h, w, 2)
    acc.add(geo.target_index(lon, lat, bounds, h, w), [phase, coh])
    # Line-of-sight unit vector (target to sensor, ENU) from the radar-grid cube, at the level
    # nearest the event's typical ground height; it changes by hundredths over a frame.
    hs = np.asarray(f[RADAR_GRID + "heightAboveEllipsoid"][()], dtype=float)
    k = int(np.argmin(np.abs(hs - event.get("height_m", 0))))
    gx, gy = f[RADAR_GRID + "xCoordinates"][()], f[RADAR_GRID + "yCoordinates"][()]
    glon, glat = grid_lonlat(event)
    px, py = geo.lonlat_to_utm(glon, glat, epsg)
    e = bilinear(gx, gy, f[RADAR_GRID + "losUnitVectorX"][k], px, py)
    n = bilinear(gx, gy, f[RADAR_GRID + "losUnitVectorY"][k], px, py)
    lam = 299_792_458.0 / float(f["/science/LSAR/GUNW/grids/frequencyA/centerFrequency"][()])
    return {
        "phase": acc.mean(0),
        "coherence": acc.mean(1),
        "e": e,
        "n": n,
        "wavelength_m": lam,
        "kept_share": float(np.isfinite(phase).sum() / max(np.isfinite(ph).sum(), 1)),
    }


def fetch(event: dict, raw: Path | None = None, log=print) -> list[Path]:
    """Read every pair the event needs into raw/motion/<id>/pair_<geom>_<start>_<end>.npz."""
    from . import nasa_access as na

    raw = raw or config.RAW_DIR / "motion" / event["id"]
    raw.mkdir(parents=True, exist_ok=True)
    na.login()
    found = find_pairs(event)
    keys = wanted_pairs(event, sorted(found))
    log(f"{event['id']}: {len(found)} pairs found, {len(keys)} needed")
    # Heights for every event: the relief under the maps, the profiles' terrain line, and the
    # height fit of the troposphere where an event asks for it.
    if not (raw / "nasadem.npz").is_file():
        from . import nasa_inputs

        h, w = grid_shape(event)
        nasa_inputs.fetch_dem(event, raw, h, w, config.RAW_DIR / "_cache" / "nasadem", log=log)
    saved = []
    for key in keys:
        track, direction, d1, d2 = key
        target = raw / f"pair_{geom_key(track, direction)}_{d1}_{d2}.npz"
        if target.is_file():
            z = np.load(target)
            current = int(z["join_version"]) if "join_version" in z else 1
            read = int(z["read_version"]) if "read_version" in z else 1
        # Kept unless built from fewer frames than the archive has, or joined by an older rule
        # (a single frame needs no join).
        if (
            target.is_file()
            and int(z["frames"]) >= len(found[key])
            and (current >= JOIN_VERSION or len(found[key]) == 1)
            and read >= READ_VERSION
        ):
            saved.append(target)
            continue
        frames = []
        tag = f"{geom_key(track, direction)} {d1}→{d2}"
        for frame, (_info, url) in sorted(found[key].items()):
            fr = None
            for attempt in range(3):
                try:
                    fr = read_frame(url, event)
                    break
                except Exception as exc:  # noqa: BLE001 - signed URLs expire; the archive times out
                    log(f"  {tag} frame {frame}: {type(exc).__name__} (attempt {attempt + 1})")
                    time.sleep(5 * (attempt + 1))
            if fr is not None:
                frames.append(fr)
        if not frames:
            continue
        joined, offsets = join_frames(frames)
        np.savez_compressed(
            target,
            phase=joined["phase"].astype(np.float32),
            coherence=joined["coherence"].astype(np.float32),
            e=joined["e"].astype(np.float32),
            n=joined["n"].astype(np.float32),
            wavelength_m=frames[0]["wavelength_m"],
            track=track,
            direction=direction,
            start=d1.isoformat(),
            end=d2.isoformat(),
            frames=len(frames),
            frames_tied=sum(o is not None for o in offsets),
            frame=joined["frame"].astype(np.int8),
            join_version=JOIN_VERSION,
            read_version=READ_VERSION,
            kept_share=float(np.mean([f["kept_share"] for f in frames])),
        )
        valid = float(np.isfinite(joined["phase"]).mean() * 100)
        log(f"  {tag}: {len(frames)} frame(s), {valid:.0f} % of the grid measured")
        saved.append(target)
    return saved


def fetch_rupture(event: dict, raw: Path, log=print) -> Path | None:
    """The USGS ShakeMap rupture outline of the event's largest quake (public domain), via the
    USGS event API; skipped when already on disk or when the event has none."""
    import urllib.request

    if not event.get("fault_file") or not event.get("quakes"):
        return None
    target = raw / event["fault_file"]
    if target.is_file():
        return target
    main = max(event["quakes"], key=lambda q: q["mag"])
    api = f"https://earthquake.usgs.gov/fdsnws/event/1/query?eventid={main['id']}&format=geojson"
    with urllib.request.urlopen(api, timeout=60) as r:  # noqa: S310 - fixed USGS host
        products = json.loads(r.read().decode("utf-8"))["properties"]["products"]
    url = products["shakemap"][0]["contents"]["download/rupture.json"]["url"]
    raw.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as r:  # noqa: S310
        target.write_bytes(r.read())
    log(f"  rupture outline: {url}")
    return target


def fetch_finite_fault(event: dict, raw: Path, log=print) -> list[Path]:
    """The USGS finite-fault product of the event's largest quake (public domain): the slip model
    (.fsp) and the radar points it was fitted to (resampled_interferograms.zip, which holds JPL's
    processing of NISAR pairs). Skipped without a `model` entry or when already on disk."""
    import io
    import urllib.request
    import zipfile

    cfg = event.get("model")
    if not cfg or not event.get("quakes") or (raw / cfg["file"]).is_file():
        return []
    main = max(event["quakes"], key=lambda q: q["mag"])
    api = f"https://earthquake.usgs.gov/fdsnws/event/1/query?eventid={main['id']}&format=geojson"
    with urllib.request.urlopen(api, timeout=60) as r:  # noqa: S310 - fixed USGS host
        product = json.loads(r.read().decode("utf-8"))["properties"]["products"]["finite-fault"][0]
    contents = product["contents"]
    raw.mkdir(parents=True, exist_ok=True)
    saved = []
    with urllib.request.urlopen(contents[cfg["file"]]["url"], timeout=60) as r:  # noqa: S310
        (raw / cfg["file"]).write_bytes(r.read())
        saved.append(raw / cfg["file"])
    if "resampled_interferograms.zip" in contents:
        url = contents["resampled_interferograms.zip"]["url"]
        with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310
            z = zipfile.ZipFile(io.BytesIO(r.read()))
        for name in z.namelist():
            if name.startswith("nisar_t") and name.endswith(".txt") and "/" not in name:
                (raw / name).write_bytes(z.read(name))
                saved.append(raw / name)
    log(f"  USGS finite fault: {len(saved)} files (version {product['properties'].get('version')})")
    return saved


def load_pairs(raw: Path) -> list[dict]:
    out = []
    for f in sorted(raw.glob("pair_*.npz")):
        z = np.load(f)
        e, n = z["e"].astype(float), z["n"].astype(float)
        out.append(
            {
                "track": int(z["track"]),
                "direction": str(z["direction"]),
                "start": date.fromisoformat(str(z["start"])),
                "end": date.fromisoformat(str(z["end"])),
                "phase": z["phase"].astype(float),
                "coherence": z["coherence"].astype(float),
                "e": e,
                "n": n,
                "u": np.sqrt(np.clip(1 - e * e - n * n, 0, 1)),
                "wavelength_m": float(z["wavelength_m"]),
                "frames": int(z["frames"]),
                "frames_tied": int(z["frames_tied"]),
            }
        )
    return out


# ---------------------------------------------------------------- build (offline)


def referenced_cm(pair: dict, event: dict, lon, lat, ref_mask=None) -> tuple[np.ndarray, bool]:
    """A pair's LOS motion (cm) relative to stable ground: the cells of `ref_mask` when given
    (e.g. every cell above a height), else the event's reference box; the whole-map median if
    neither is measured in this geometry (flagged: then the reference may itself have moved)."""
    if ref_mask is not None:
        ok = ref_mask & np.isfinite(pair["phase"])
        ref = float(np.median(pair["phase"][ok])) if ok.sum() >= MIN_REFERENCE_PX else None
    else:
        ref = box_median(pair["phase"], lon, lat, event["reference"]["bbox"])
    fallback = ref is None
    if fallback:
        ref = float(np.nanmedian(pair["phase"])) if np.isfinite(pair["phase"]).any() else 0.0
    return phase_to_cm(pair["phase"] - ref, pair["wavelength_m"]), fallback


def _geom_meta(pair: dict, los: np.ndarray) -> dict:
    ok = np.isfinite(los)
    e = float(np.nanmedian(np.where(ok, pair["e"], np.nan)))
    n = float(np.nanmedian(np.where(ok, pair["n"], np.nan)))
    u = float(np.sqrt(max(0.0, 1 - e * e - n * n)))
    return {
        "key": geom_key(pair["track"], pair["direction"]),
        "track": pair["track"],
        "direction": pair["direction"],
        "los_enu": [round(e, 3), round(n, 3), round(u, 3)],
        "incidence_deg": round(float(np.degrees(np.arccos(u))), 1),
        "measured_pct": round(float(ok.mean() * 100), 1),
        "coherence_median": round(float(np.nanmedian(np.where(ok, pair["coherence"], np.nan))), 2)
        if ok.any()
        else None,
    }


def _noise(values, mask=None) -> float | None:
    v = values if mask is None else np.where(mask, values, np.nan)
    s = robust_std(v)
    return round(s, 2) if s is not None else None


def _reference_mask(event: dict, lon, lat, dem) -> np.ndarray:
    """The stable ground every map is referenced to: cells above a height, or the box."""
    if dem is not None and event["reference"].get("min_height_m") is not None:
        return np.isfinite(dem) & (dem >= event["reference"]["min_height_m"])
    b = event["reference"]["bbox"]
    return (lon >= b[0]) & (lon <= b[2]) & (lat >= b[1]) & (lat <= b[3])


def _jpl_points(raw: Path, track: int, start: date, end: date) -> np.ndarray | None:
    """JPL's processing of the same pair, as resampled by USGS for its fault model:
    lon, lat, LOS (m) per point. Their LOS grows with range (positive = away from the
    satellite): on all three files it anti-correlates with ours at r < -0.98 (D-082)."""
    name = f"nisar_t{track}_{start:%Y%m%d}_{end:%Y%m%d}"
    for f in sorted(raw.glob(f"{name}*.txt")):
        return np.loadtxt(f)
    return None


def build(event: dict, raw: Path | None = None, out_root: Path | None = None, log=print) -> dict:
    """Write web/data/motion/<id>/: motion.json and motion.bin (int16 planes). The browser draws
    every map from the planes (colour scale, fringes and profiles are chosen there)."""

    raw = raw or config.RAW_DIR / "motion" / event["id"]
    out = (out_root or config.WEB_DATA_DIR) / "motion" / event["id"]
    pairs = load_pairs(raw)
    for stale in out.glob("*.png") if out.is_dir() else []:
        stale.unlink()  # the maps are drawn in the browser since motion schema 14
    out.mkdir(parents=True, exist_ok=True)
    if not pairs:
        raise SystemExit(
            f"{event['id']}: no pairs in {raw}; run cli.py motion --fetch {event['id']}"
        )
    h, w = grid_shape(event)
    lon, lat = grid_lonlat(event)
    half_cm = pairs[0]["wavelength_m"] / 2 * 100
    planes: list[tuple[dict, np.ndarray]] = []
    geometries: list[dict] = []
    headline: dict = {}
    extra: dict = {}
    dem = None
    if (raw / "nasadem.npz").is_file():
        dem = np.load(raw / "nasadem.npz")["dem"].astype(float)
    ref_area = _reference_mask(event, lon, lat, dem)

    def add_plane(meta: dict, values: np.ndarray, unit: str = "cm", **more):
        meta = dict(meta, unit=unit, **{k: v for k, v in more.items() if v is not None})
        planes.append((meta, np.asarray(values, dtype=float)))

    if dem is not None:
        add_plane({"id": "dem", "kind": "dem", "geometry": None}, dem, "m", scale=1.0)

    if event["kind"] == "earthquake":
        _build_quake(
            event, raw, pairs, lon, lat, ref_area, geometries, headline, extra, add_plane, log, out
        )
    else:
        _build_sinking(
            event, raw, pairs, lon, lat, dem, ref_area, geometries, headline, extra, add_plane, log
        )

    out.mkdir(parents=True, exist_ok=True)
    blob = (
        np.stack([to_i16(v / m.get("scale", SCALE_CM) * SCALE_CM) for m, v in planes])
        if planes
        else np.zeros((0, h, w), np.int16)
    )
    # Gzip, which the browser undoes natively (DecompressionStream): 17.7 MB → 6.9 MB at
    # Mexico City, most of it the clear cells of the time series. mtime 0 keeps rebuilds equal.
    for stale in (out / "motion.bin",):
        stale.unlink(missing_ok=True)
    (out / BINARY).write_bytes(gzip.compress(blob.astype("<i2").tobytes(), 9, mtime=0))
    profiles = []
    for p in event.get("profiles", []):
        a, b = profile_ends(p)
        profiles.append({"id": p["id"], "a": a, "b": b, "half_width_km": p["half_width_km"]})
    doc = {
        "schema_version": MOTION_SCHEMA,
        "id": event["id"],
        "name": event["name"],
        "kind": event["kind"],
        "country": event["country"],
        "grid": {"width": w, "height": h, "bounds": list(event["bbox"]), "res_m": event["res_m"]},
        "sign": "positive = toward the satellite (line of sight); up and east for the split",
        "wavelength_m": round(pairs[0]["wavelength_m"], 4),
        "half_wavelength_cm": round(half_cm, 2),
        "min_coherence": MIN_COHERENCE,
        "reference": event["reference"],
        "binary": BINARY,
        "scale_cm": SCALE_CM,
        "nodata": NODATA_I16,
        "planes": [m for m, _ in planes],
        "geometries": geometries,
        "headline": headline,
        "profiles": profiles,
        "quakes": event.get("quakes", []),
        "fault": fault_outline(raw / event["fault_file"]) if event.get("fault_file") else None,
        "source": "NISAR L2 GUNW provisional (NASA/ISRO via ASF DAAC), HH unwrapped phase",
        **extra,
    }
    (out / "motion.json").write_text(json.dumps(doc, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"{event['id']}: {len(planes)} planes, {len(geometries)} geometries → {out}")
    return doc


def _build_quake(
    event, raw, pairs, lon, lat, ref_area, geometries, headline, extra, add_plane, log, out=None
):
    """Per geometry the pair spanning the quake, its control pair before it, the east/up split,
    the USGS model per geometry and JPL's points as checks."""
    from . import okada

    day = date.fromisoformat(event["event_utc"][:10])
    across_maps, east_parts, up_parts, control_maps = [], [], [], []
    by_geom: dict[str, list[dict]] = {}
    used: list[dict] = []
    for p in pairs:
        by_geom.setdefault(geom_key(p["track"], p["direction"]), []).append(p)
    for key, ps in sorted(by_geom.items()):
        across = [p for p in ps if p["start"] < day < p["end"]]
        if not across:
            continue
        pa = min(across, key=lambda p: (p["end"] - p["start"]).days)
        if np.isfinite(pa["phase"]).mean() < MIN_MEASURED_SHARE:
            log(f"  {key}: measures under {MIN_MEASURED_SHARE:.0%} of the grid, left out")
            continue
        los, fallback = referenced_cm(pa, event, lon, lat)
        meta = _geom_meta(pa, los)
        meta.update(
            start=pa["start"].isoformat(),
            end=pa["end"].isoformat(),
            reference_fallback=fallback,
            frames=pa["frames"],
            frames_tied=pa["frames_tied"],
        )
        before = [p for p in ps if p["end"] < day]
        lb = np.full(los.shape, np.nan)
        if before:
            pb = max(before, key=lambda p: p["end"])
            lb, _ = referenced_cm(pb, event, lon, lat)
            meta["control"] = {
                "start": pb["start"].isoformat(),
                "end": pb["end"].isoformat(),
                "noise_cm": _noise(lb),
            }
        vals = los[np.isfinite(los)]
        meta["p01_cm"], meta["p99_cm"] = (
            (round(float(np.percentile(vals, 1)), 1), round(float(np.percentile(vals, 99)), 1))
            if vals.size
            else (None, None)
        )
        jpl = _jpl_points(raw, pa["track"], pa["start"], pa["end"])
        if jpl is not None:
            # Their sign is away from the satellite (see _jpl_points): negate to ours.
            meta["jpl"] = compare_points(los, event["bbox"], jpl[:, 0], jpl[:, 1], -jpl[:, 2] * 100)
        geometries.append(meta)
        noise = meta.get("control", {}).get("noise_cm")
        add_plane({"id": f"los_{key}", "kind": "los", "geometry": key}, los, noise=noise)
        if np.isfinite(lb).any():
            # The control pair, 12 days before the quake: what the same track sees with no quake
            # in it (the noise floor), for the before/after step in the browser (D-090).
            add_plane({"id": f"before_los_{key}", "kind": "before_los", "geometry": key}, lb)
        add_plane(
            {"id": f"coh_{key}", "kind": "coherence", "geometry": key},
            pa["coherence"],
            "1",
            scale=0.001,
        )
        across_maps.append(los)
        control_maps.append(lb)
        east_parts.append(pa["e"])
        up_parts.append(pa["u"])
        used.append(pa)
    split = {g["direction"] for g in geometries} >= {"ascending", "descending"}
    if split:
        de, du = decompose(across_maps, east_parts, up_parts)
        ce, cu = decompose(control_maps, east_parts, up_parts)  # the same split before the quake
        add_plane({"id": "east", "kind": "east", "geometry": None}, de, noise=_noise(ce))
        add_plane({"id": "up", "kind": "up", "geometry": None}, du, noise=_noise(cu))
        add_plane({"id": "before_east", "kind": "before_east", "geometry": None}, ce)
        add_plane({"id": "before_up", "kind": "before_up", "geometry": None}, cu)
        for name, arr in (("east", de), ("up", du)):
            v = arr[np.isfinite(arr)]
            if v.size:
                headline[f"{name}_p01_cm"] = round(float(np.percentile(v, 1)), 1)
                headline[f"{name}_p99_cm"] = round(float(np.percentile(v, 99)), 1)
                headline[f"{name}_pct"] = round(float(np.isfinite(arr).mean() * 100), 1)

    model_cfg = event.get("model")
    fsp = raw / model_cfg["file"] if model_cfg else None
    if fsp is None or not fsp.is_file():
        return
    text = fsp.read_text(encoding="utf-8", errors="replace")
    patches = okada.parse_fsp(text)
    log(f"  USGS model: {len(patches)} subfaults, forward model on the grid (Okada 1985)")
    me, mn, mu = (v * 100 for v in okada.patches_enu(patches, lon, lat))

    def referenced(model, data):
        ok = ref_area & np.isfinite(data) & np.isfinite(model)
        return model - (float(np.median(model[ok])) if ok.sum() >= MIN_REFERENCE_PX else 0.0)

    fit = {}
    for meta, pa, los in zip(geometries, used, across_maps, strict=True):
        model_los = referenced(me * pa["e"] + mn * pa["n"] + mu * pa["u"], los)
        add_plane(
            {"id": f"model_los_{meta['key']}", "kind": "model_los", "geometry": meta["key"]},
            model_los,
        )
        stats = fit_stats(los, model_los) or {}
        stats["used_by_model"] = meta["key"] in model_cfg.get("used_geometries", [])
        fit[meta["key"]] = stats
    if split:
        add_plane({"id": "model_east", "kind": "model_east", "geometry": None}, referenced(me, de))
        add_plane({"id": "model_up", "kind": "model_up", "geometry": None}, referenced(mu, du))
        fit["east"] = fit_stats(de, referenced(me, de))
        fit["up"] = fit_stats(du, referenced(mu, du))
    extra["model"] = {
        "label": model_cfg["label"],
        "url": model_cfg.get("url"),
        "used_data": model_cfg.get("used_data"),
        **okada.fsp_header(text),
        "poisson": 0.25,
        "fit": fit,
        "patches": [
            {
                "ring": okada.patch_outline(p),
                "slip_m": round(p["slip_m"], 3),
                "rake": round(p["rake"], 1),
                "trup_s": round(p.get("trup_s", 0.0), 2),
                "rise_s": round(p.get("rise_s", 0.0), 2),
            }
            for p in patches
        ],
        "trace": okada.top_trace(patches),
    }
    if out is not None and all("trup_s" in p for p in patches):
        extra["rupture"] = _rupture_frames(event, patches, out, log)


RUPTURE_STEP_S = 5.0


def _rupture_frames(event: dict, patches: list[dict], out: Path, log) -> dict:
    """The rupture in time (D-091): the USGS model's surface displacement every RUPTURE_STEP_S
    seconds from the first subfault's rupture until the last has finished slipping, on a grid at
    half the map's resolution (the field is smooth), with the moment released in each step (the
    source-time function). Written to rupture.bin.gz: int16 frames x (east, north, up), mm."""
    from . import okada

    h, w = grid_shape(event)
    h2, w2 = (h + 1) // 2, (w + 1) // 2
    west, south, east_, north = event["bbox"]
    lon = west + (np.arange(w2) + 0.5) * (east_ - west) / w2
    lat = north - (np.arange(h2) + 0.5) * (north - south) / h2
    glon, glat = np.meshgrid(lon, lat)
    end = max(p["trup_s"] + p["rise_s"] for p in patches if p["slip_m"] > 0)
    times = np.arange(0.0, np.ceil(end / RUPTURE_STEP_S) * RUPTURE_STEP_S + 0.1, RUPTURE_STEP_S)
    log(f"  rupture: {len(times)} frames over {times[-1]:.0f} s on {w2} x {h2}")
    frames, released = okada.rupture_frames(patches, glon, glat, times)
    blob = np.stack([to_i16(f * 100) for f in frames.reshape(-1, h2, w2)])
    (out / "rupture.bin.gz").write_bytes(gzip.compress(blob.astype("<i2").tobytes(), 9, mtime=0))
    return {
        "file": "rupture.bin.gz",
        "grid": {"width": w2, "height": h2},
        "components": ["east", "north", "up"],
        "scale_cm": SCALE_CM,
        "times_s": [round(float(t), 1) for t in times],
        "moment_released_nm": [float(f"{m:.4g}") for m in released],
        # Time zero is the model's hypocentre time (the M7.2's origin).
        "start_utc": event["quakes"][0]["utc"] if event.get("quakes") else None,
        "slip_function": "cosine ramp over each subfault's rise time, from its rupture time",
    }


def _build_sinking(
    event, raw, pairs, lon, lat, dem, ref_area, geometries, headline, extra, add_plane, log
):
    """Per geometry a consecutive chain summed into a time series, a rate (cm/yr) and its
    standard error; ascending and descending rates give up and east; GNSS stations as checks."""

    hills = None
    dem_filled = None
    if dem is not None and event.get("tropo_fit_min_height_m") is not None:
        dem_filled = np.where(np.isfinite(dem), dem, np.nanmedian(dem))
        hills = np.isfinite(dem) & (dem >= event["tropo_fit_min_height_m"])
    ref_mask = ref_area if event["reference"].get("min_height_m") is not None else None
    chains: dict[str, list[dict]] = {}
    for p in pairs:
        chains.setdefault(geom_key(p["track"], p["direction"]), []).append(p)
    rates, sigmas, east_parts, up_parts, dirs, cums = [], [], [], [], [], {}
    for key, ps in sorted(chains.items()):
        chain = consecutive_chain(ps)
        if not chain or np.isfinite(chain[-1]["phase"]).mean() < MIN_MEASURED_SHARE:
            continue
        maps, fallbacks, slopes = [], 0, []
        for p in chain:
            if hills is not None:
                # Remove the phase that follows terrain height on the hills above the
                # deforming ground (fitted per pair: the weather changes every 12 days).
                slope = height_slope(p["phase"], dem, hills)
                if slope is not None:
                    p = dict(p, phase=p["phase"] - slope * dem_filled)
                    slopes.append(phase_to_cm(slope, p["wavelength_m"]) * 1000)  # cm per km
            los, fb = referenced_cm(p, event, lon, lat, ref_mask)
            maps.append(los)
            fallbacks += fb
        cum = cumulative(maps)
        dates = [chain[0]["start"]] + [p["end"] for p in chain]
        days = [(d - dates[0]).days for d in dates]
        rate = linear_rate(days, cum) * YEAR_DAYS  # cm per year
        sigma = rate_sigma(days, cum) * YEAR_DAYS
        meta = _geom_meta(chain[-1], cum[-1])
        if slopes:
            meta["height_trend_cm_per_km"] = [round(s, 2) for s in slopes]
        meta.update(
            start=dates[0].isoformat(),
            end=dates[-1].isoformat(),
            dates=[d.isoformat() for d in dates],
            reference_fallbacks=fallbacks,
            pairs=len(chain),
            # Consecutive pairs only: no closed loops, so unwrapping errors cannot be checked by
            # loop closure (the archive has no redundant pairs here, D-082).
            network="chain",
        )
        meta["stable_rate_spread_cm_yr"] = _noise(rate, ref_area)
        meta["sigma_median_cm_yr"] = round(float(np.nanmedian(sigma)), 2)
        geometries.append(meta)
        add_plane(
            {"id": f"rate_{key}", "kind": "rate_los", "geometry": key},
            rate,
            "cm/yr",
            noise=meta["stable_rate_spread_cm_yr"],
        )
        add_plane(
            {"id": f"sigma_rate_{key}", "kind": "sigma", "geometry": key, "of": f"rate_{key}"},
            sigma,
            "cm/yr",
        )
        coh = np.nanmean(np.stack([p["coherence"] for p in chain]), axis=0)
        add_plane({"id": f"coh_{key}", "kind": "coherence", "geometry": key}, coh, "1", scale=0.001)
        for k, d in enumerate(dates):
            add_plane(
                {
                    "id": f"cum_{key}_{d.isoformat()}",
                    "kind": "cum",
                    "geometry": key,
                    "date": d.isoformat(),
                },
                cum[k],
            )
        cums[key] = (dates, cum, chain[-1])
        rates.append(rate)
        sigmas.append(sigma)
        east_parts.append(chain[-1]["e"])
        up_parts.append(chain[-1]["u"])
        dirs.append(chain[-1]["direction"])
    du = de = None
    if {"ascending", "descending"} <= set(dirs):
        de, du = decompose(rates, east_parts, up_parts)
        se, su = decompose_sigma(sigmas, east_parts, up_parts)
        add_plane(
            {"id": "rate_up", "kind": "rate_up", "geometry": None},
            du,
            "cm/yr",
            noise=_noise(du, ref_area),
        )
        add_plane(
            {"id": "rate_east", "kind": "rate_east", "geometry": None},
            de,
            "cm/yr",
            noise=_noise(de, ref_area),
        )
        add_plane(
            {"id": "sigma_rate_up", "kind": "sigma", "geometry": None, "of": "rate_up"}, su, "cm/yr"
        )
        add_plane(
            {"id": "sigma_rate_east", "kind": "sigma", "geometry": None, "of": "rate_east"},
            se,
            "cm/yr",
        )
        v = du[np.isfinite(du)]
        if v.size:
            cell_km2 = (event["res_m"] / 1000) ** 2
            significant = np.isfinite(du) & np.isfinite(su) & (du < -2 * su)
            headline.update(
                up_p01_cm_yr=round(float(np.percentile(v, 1)), 1),
                sinking_10cm_yr_km2=round(float((du < -10).sum() * cell_km2), 1),
                sinking_20cm_yr_km2=round(float((du < -20).sum() * cell_km2), 1),
                sinking_significant_km2=round(float(significant.sum() * cell_km2), 1),
                measured_pct=round(float(np.isfinite(du).mean() * 100), 1),
                sigma_up_median_cm_yr=round(float(np.nanmedian(su)), 2),
            )
    if event.get("gnss"):
        extra["gnss"] = _gnss_checks(event, raw, geometries, cums, du, lon, lat, log)


def _cells_near(lon, lat, lon0, lat0, radius_m: float = 250.0):
    """The grid cells within `radius_m` of a point (a station is one point; the grid is 100 m)."""
    dx = (lon - lon0) * 111_320 * np.cos(np.radians(lat0))
    dy = (lat - lat0) * 110_574
    return dx * dx + dy * dy <= radius_m * radius_m


def _gnss_checks(event, raw, geometries, cums, du, lon, lat, log) -> list[dict]:
    """Each NGL station in the box with data over the radar window (or the year before it):
    its rates, its daily series (same window) and what the radar measured at it."""
    from . import gnss

    out = []
    start = min(date.fromisoformat(g["start"]) for g in geometries)
    end = max(date.fromisoformat(g["end"]) for g in geometries)
    for f in sorted((raw / "gnss").glob("*.tenv3")):
        series = gnss.parse_tenv3(f.read_text(encoding="utf-8", errors="replace"))
        if series["lon"] is None or not series["days"].size:
            continue
        s = gnss.summarise(series, start, end)
        if s is None:
            continue
        near = _cells_near(lon, lat, series["lon"], series["lat"])
        st = {"id": f.stem, "lon": round(series["lon"], 5), "lat": round(series["lat"], 5), **s}
        nisar: dict = {}
        if du is not None and np.isfinite(du[near]).any():
            nisar["rate_up_cm_yr"] = round(float(np.nanmedian(du[near])), 2)
            nisar["cells"] = int(np.isfinite(du[near]).sum())
        st["los_rate_cm_yr"] = {}
        for g in geometries:
            e, n, u = g["los_enu"]
            st["los_rate_cm_yr"][g["key"]] = round(
                e * s["rate_e_cm_yr"] + n * s["rate_n_cm_yr"] + u * s["rate_u_cm_yr"], 2
            )
            dates, cum, _ = cums[g["key"]]
            days = [(d - dates[0]).days for d in dates]
            at = np.array(
                [
                    np.nanmedian(np.where(near, c, np.nan))
                    if np.isfinite(c[near]).any()
                    else np.nan
                    for c in cum
                ]
            )
            if np.isfinite(at).sum() >= MIN_RATE_POINTS:
                ok = np.isfinite(at)
                nisar.setdefault("rate_los_cm_yr", {})[g["key"]] = round(
                    float(np.polyfit(np.array(days)[ok], at[ok], 1)[0] * YEAR_DAYS), 2
                )
        st["nisar"] = nisar
        if s["period"] == "same":
            st["series"] = gnss.series_since(series, start, end)
        out.append(st)
        log(
            f"  GNSS {f.stem}: {s['period']} period, up {s['rate_u_cm_yr']} cm/yr;"
            f" NISAR {nisar.get('rate_up_cm_yr')}"
        )
    out.sort(key=lambda st: (st["period"] != "same", st["id"]))
    return out


def fault_outline(path: Path) -> list | None:
    """USGS ShakeMap rupture polygons as lon/lat rings (public domain), rounded."""
    if not path.is_file():
        return None
    doc = json.loads(path.read_text(encoding="utf-8"))
    rings = []
    for feat in doc.get("features", []):
        geom = feat.get("geometry") or {}
        polys = (
            geom.get("coordinates", [])
            if geom.get("type") == "MultiPolygon"
            else [geom.get("coordinates", [])]
        )
        for poly in polys:
            for ring in poly:
                rings.append([[round(c[0], 4), round(c[1], 4)] for c in ring])
    return rings or None


def write_index(out_root: Path | None = None) -> dict:
    """web/data/motion/index.json: every built event (the manifest points here)."""

    root = (out_root or config.WEB_DATA_DIR) / "motion"
    events = []
    for f in sorted(root.glob("*/motion.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        events.append(
            {
                "id": d["id"],
                "name": d["name"],
                "kind": d["kind"],
                "country": d["country"],
                "bounds": d["grid"]["bounds"],
                "path": f"{f.parent.name}/motion.json",
            }
        )
    events.sort(
        key=lambda e: (e["kind"] != "earthquake", e["id"])
    )  # Ground mode opens on the first
    doc = {"events": events}
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.json").write_text(json.dumps(doc, ensure_ascii=False) + "\n", encoding="utf-8")
    return doc
