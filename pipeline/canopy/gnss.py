"""GNSS stations as an independent check of radar ground motion (D-082).

Daily positions from the Nevada Geodetic Laboratory (NGL; Blewitt, Hammond & Kreemer 2018, Eos 99,
doi:10.1029/2018EO104623), free and without an account: the station list (llh.out) and one
.tenv3 file per station, IGS20 frame. GNSS measures east, north and up at one point; projected on
a radar geometry's line of sight it gives what the radar should see there.

The positions are in a global frame, so the horizontal includes the plate's own motion (up to
about 1.5 cm a year); the radar is referenced to stable ground nearby, which moves with the plate.
The vertical is compared as is, and the line-of-sight comparison carries that small bias (stated).
"""

from __future__ import annotations

import urllib.request
from datetime import date, timedelta
from pathlib import Path

import numpy as np

NGL_LLH = "https://geodesy.unr.edu/NGLStationPages/llh.out"
NGL_TENV3 = "https://geodesy.unr.edu/gps_timeseries/IGS20/tenv3/IGS20/{id}.tenv3"
MJD0 = date(1858, 11, 17)
MIN_DAYS_IN_WINDOW = 60  # fewer daily positions inside the radar's window: not a same-period check
EARLIER_MAX_GAP_DAYS = 730  # an earlier rate counts as context only if it ended this close before
YEAR_DAYS = 365.25


def _get(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310 - fixed NGL host
        return r.read()


def stations_in(bbox, llh_text: str) -> list[dict]:
    """Stations of NGL's list inside a lon/lat box (the list gives longitudes in −180…180 or
    0…360)."""
    w, s, e, n = bbox
    out = []
    for line in llh_text.splitlines():
        v = line.split()
        if len(v) < 3:
            continue
        try:
            lat, lon = float(v[1]), float(v[2])
        except ValueError:
            continue
        lon = lon - 360 if lon > 180 else lon
        if w <= lon <= e and s <= lat <= n:
            out.append({"id": v[0], "lon": lon, "lat": lat})
    return out


def fetch(event: dict, raw: Path, log=print) -> list[Path]:
    """Every NGL station inside the event box, to raw/gnss/<id>.tenv3."""
    folder = raw / "gnss"
    folder.mkdir(parents=True, exist_ok=True)
    llh = folder / "llh.out"
    if not llh.is_file():
        llh.write_bytes(_get(NGL_LLH))
    saved = []
    for st in stations_in(event["bbox"], llh.read_text(encoding="utf-8", errors="replace")):
        target = folder / f"{st['id']}.tenv3"
        try:
            target.write_bytes(_get(NGL_TENV3.format(id=st["id"])))
            saved.append(target)
        except OSError as exc:
            log(f"  GNSS {st['id']}: {type(exc).__name__}")
    log(f"  GNSS: {len(saved)} station series from NGL")
    return saved


def parse_tenv3(text: str) -> dict:
    """Daily east, north and up (m) of one station, with dates and lon/lat."""
    rows = []
    lon = lat = None
    for line in text.splitlines():
        v = line.split()
        if len(v) < 13 or not v[3].replace(".", "").isdigit():
            continue
        mjd = int(float(v[3]))
        e = float(v[7]) + float(v[8])
        n = float(v[9]) + float(v[10])
        u = float(v[11]) + float(v[12])
        rows.append((mjd, e, n, u))
        if len(v) >= 22:
            lat, lon = float(v[20]), float(v[21])
    a = np.array(rows, dtype=float).reshape(-1, 4)
    return {
        "days": a[:, 0] - (date(2000, 1, 1) - MJD0).days,  # days since 2000-01-01
        "e": a[:, 1],
        "n": a[:, 2],
        "u": a[:, 3],
        "lon": lon,
        "lat": lat,
    }


def day_number(d: date) -> float:
    return float((d - date(2000, 1, 1)).days)


def from_day_number(x: float) -> date:
    return date(2000, 1, 1) + timedelta(days=int(round(x)))


def rate(days, values) -> tuple[float, float]:
    """Least-squares rate (units per year) and its standard error from the scatter about the
    line. Daily GNSS noise is time-correlated, so the formal error is too small (by a factor of a
    few: Williams 2003, J. Geodesy 76:483); it is reported as 'formal'."""
    t = np.asarray(days, dtype=float)
    y = np.asarray(values, dtype=float)
    if t.size < 3:
        return float("nan"), float("nan")
    tm = t - t.mean()
    slope = float((tm * (y - y.mean())).sum() / (tm * tm).sum())
    res = y - y.mean() - slope * tm
    se = float(np.sqrt((res**2).sum() / (t.size - 2) / (tm * tm).sum()))
    return slope * YEAR_DAYS, se * YEAR_DAYS


def summarise(series: dict, start: date, end: date) -> dict | None:
    """One station against a radar window: 'same' (daily positions over the window: rates and
    the series), 'earlier' (a year of data ending shortly before the window: rates only, context)
    or None."""
    t = series["days"]
    t0, t1 = day_number(start), day_number(end)
    inside = (t >= t0) & (t <= t1)
    if inside.sum() >= MIN_DAYS_IN_WINDOW:
        sel, period = inside, "same"
    elif t.size and t1 - t.max() <= EARLIER_MAX_GAP_DAYS + (t1 - t0) and t.max() < t0:
        sel = t >= t.max() - YEAR_DAYS
        if sel.sum() < 200:
            return None
        period = "earlier"
    else:
        return None
    out: dict = {
        "period": period,
        "start": from_day_number(t[sel].min()).isoformat(),
        "end": from_day_number(t[sel].max()).isoformat(),
        "days": int(sel.sum()),
    }
    for k in ("e", "n", "u"):
        r, se = rate(t[sel], series[k][sel])
        out[f"rate_{k}_cm_yr"] = round(r * 100, 2)
        out[f"rate_{k}_formal_se_cm_yr"] = round(se * 100, 2)
    return out


def series_since(series: dict, start: date, end: date) -> list[list]:
    """Daily [date, east, north, up] in cm relative to the start date (the median of the days
    within 3 days of it), over the window: the radar series start at zero on the same date."""
    t = series["days"]
    t0, t1 = day_number(start), day_number(end)
    near = np.abs(t - t0) <= 3
    if not near.any():
        return []
    base = [float(np.median(series[k][near])) for k in ("e", "n", "u")]
    sel = (t >= t0 - 3) & (t <= t1 + 3)
    return [
        [
            from_day_number(d).isoformat(),
            round((series["e"][i] - base[0]) * 100, 2),
            round((series["n"][i] - base[1]) * 100, 2),
            round((series["u"][i] - base[2]) * 100, 2),
        ]
        for i, d in zip(np.where(sel)[0], t[sel], strict=True)
    ]
