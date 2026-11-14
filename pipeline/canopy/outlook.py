"""The next two weeks (experimental, v11): NISAR-learned flood response × a river forecast.

At fetch time the site's main river is found on GEOGloWS (ECMWF river model, free API, no key):
river ids are sampled over the box and the reach with the largest flow is kept; its daily flows for
the season and its 15-day ensemble forecast are saved. At build time the hidden flood of each pass
is regressed on log10 of that day's flow; only a good fit (n >= MIN_N, r >= MIN_R) produces an
outlook, and never beyond the season's own range of flows (no extrapolation). Endpoints used:
/api/v2/getriverid, /retrospectivedaily, /forecaststats.
"""

from __future__ import annotations

import json
import time
import urllib.request
from datetime import date, datetime
from pathlib import Path

import numpy as np

API = "https://geoglows.ecmwf.int/api/v2"
UA = {"User-Agent": "under-the-canopy/0.2 (NASA Space Apps)"}
MIN_N = 6
MIN_R = 0.6  # and positive: more river, more water under the trees (docs/10 D-073)
RANGE_SLACK = 0.10  # forecast flows within 10 % of the season's log-flow range still count


def _get(url: str, tries: int = 3) -> dict:
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:  # noqa: S310
                return json.loads(r.read().decode("utf-8"))
        except Exception:  # noqa: BLE001 - the free service is busy now and then
            if k == tries - 1:
                raise
            time.sleep(2 + 3 * k)
    return {}


def daily(datetimes: list[str], values: list) -> dict[str, float]:
    """Mean per UTC day of a (sub-)daily series; blanks ('' or None) skipped."""
    acc: dict[str, list[float]] = {}
    for t, v in zip(datetimes, values, strict=False):
        if v in ("", None):
            continue
        acc.setdefault(str(t)[:10], []).append(float(v))
    return {d: float(np.mean(v)) for d, v in sorted(acc.items())}


SEARCH_DEG = (
    0.25  # look this far around the box: the river driving a floodplain often runs outside it
)


def water_points(occurrence: np.ndarray | None, bbox, k: int = 12, min_pct: float = 90.0) -> list:
    """Up to k lon/lat points on permanent water (JRC occurrence >= min_pct), spread through it."""
    if occurrence is None:
        return []
    rows, cols = np.nonzero(np.nan_to_num(occurrence, nan=0.0) >= min_pct)
    if not rows.size:
        return []
    h, w = occurrence.shape
    west, south, east, north = bbox
    pick = np.linspace(0, rows.size - 1, min(k, rows.size)).astype(int)
    return [
        (west + (cols[i] + 0.5) * (east - west) / w, north - (rows[i] + 0.5) * (north - south) / h)
        for i in pick
    ]


def fetch(site: dict, start: str, out: Path, grid: int = 5, water=(), log=print) -> Path | None:
    """Main river near the box, its daily flows since `start` and its 15-day forecast.

    The largest river by mean flow this season among reaches found from a grid over the box and
    SEARCH_DEG around it (at Janauacá the Solimões runs just north of the box) and from points on
    the box's permanent water: the river network is dense, so a grid point alone usually lands
    nearest to a creek (all 25 grid reaches at Atchafalaya carried under 12 m³/s).
    """
    w, s, e, n = site["bbox"]
    w, s, e, n = w - SEARCH_DEG, s - SEARCH_DEG, e + SEARCH_DEG, n + SEARCH_DEG
    # Probes: a wide grid (rivers just outside the box), the box itself and its permanent water;
    # the network is dense, so the more probes, the more likely one lands nearest the main stem.
    wide = [(lon, lat) for lat in np.linspace(s, n, grid) for lon in np.linspace(w, e, grid)]
    bw, bs, be, bn = site["bbox"]
    inner = [(lon, lat) for lat in np.linspace(bs, bn, 3) for lon in np.linspace(bw, be, 3)]
    points = wide + inner
    from concurrent.futures import ThreadPoolExecutor

    def river_at(pt):
        try:
            return _get(f"{API}/getriverid?lat={pt[1]:.4f}&lon={pt[0]:.4f}").get("river_id")
        except Exception as exc:  # noqa: BLE001
            log(f"  geoglows: getriverid failed ({type(exc).__name__})")
            return None

    end = date.today().isoformat()
    span = f"start_date={start.replace('-', '')}&end_date={end.replace('-', '')}"

    def season(rid):
        try:
            r = _get(f"{API}/retrospectivedaily/{rid}?format=json&{span}")
        except Exception as exc:  # noqa: BLE001
            log(f"  geoglows: river {rid} retrospective failed ({type(exc).__name__})")
            return None
        flows = daily(r.get("datetime", []), r.get(str(rid), []))
        return (
            {
                "river_id": rid,
                "mean_cms": float(np.mean(list(flows.values()))),
                "retrospective": flows,
            }
            if flows
            else None
        )

    # Four requests at a time: polite to a free service, and minutes faster per site.
    with ThreadPoolExecutor(4) as pool:
        ids = {int(r) for r in pool.map(river_at, [*points, *water]) if r}
        if not ids:
            return None
        found = [x for x in pool.map(season, sorted(ids)) if x]
    if not found:
        return None
    best = max(found, key=lambda x: x["mean_cms"])
    fc = _get(f"{API}/forecaststats/{best['river_id']}?format=json")
    t = fc.get("datetime", [])
    best["forecast"] = {k: daily(t, fc.get(f"flow_{k}", [])) for k in ("25p", "med", "75p")}
    best["forecast_generated"] = (fc.get("metadata") or {}).get("gen_date")
    best["candidates"] = sorted(ids)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(best) + "\n", encoding="utf-8")
    last = max(best["forecast"]["med"], default="?")
    log(f"  geoglows: river {best['river_id']}, {best['mean_cms']:.0f} m³/s, forecast to {last}")
    return out


def fit(passes: list[dict], flows: dict[str, float], key: str = "flooded_veg_km2") -> dict:
    """Least squares of a pass area on log10(flow of that day)."""
    pts = [(np.log10(flows[p["date"]]), p[key]) for p in passes if flows.get(p["date"], 0) > 0]
    out = {
        "n": len(pts),
        "r": None,
        "slope": None,
        "intercept": None,
        "rmse_km2": None,
        "x_lo": None,
        "x_hi": None,
    }
    if len(pts) < 3:
        return out
    x = np.array([a for a, _ in pts])
    y = np.array([b for _, b in pts])
    if np.ptp(x) == 0 or np.ptp(y) == 0:
        return out
    slope, intercept = np.polyfit(x, y, 1)
    pred = slope * x + intercept
    out.update(
        r=round(float(np.corrcoef(x, y)[0, 1]), 3),
        slope=round(float(slope), 4),
        intercept=round(float(intercept), 4),
        rmse_km2=round(float(np.sqrt(np.mean((pred - y) ** 2))), 3),
        x_lo=round(float(x.min()), 4),
        x_hi=round(float(x.max()), 4),
    )
    return out


def withheld_reason(f: dict, good: bool) -> str | None:
    """Why a fit gives no outlook: too few passes, too weak, or strong the wrong way round."""
    if good:
        return None
    if f["n"] < MIN_N or f["r"] is None:
        return "few_passes"
    return "inverse" if f["r"] <= -MIN_R else "weak"


def outlook(passes: list[dict], raw_doc: dict, area_km2: float) -> dict | None:
    """The outlook block for summary.products (None without GEOGloWS data)."""
    if not raw_doc:
        return None
    flows = raw_doc["retrospective"]
    f = fit(passes, flows)
    # A falling river that floods the forest is not a relation to forecast with: at seven passes a
    # strong negative r against a creek (one site: r = -0.82 at 1 m³/s) is chance, not hydrology.
    good = f["n"] >= MIN_N and f["r"] is not None and f["r"] >= MIN_R
    days = []
    if good:
        span = f["x_hi"] - f["x_lo"]
        lo, hi = f["x_lo"] - RANGE_SLACK * span, f["x_hi"] + RANGE_SLACK * span
        fc = raw_doc["forecast"]
        for d in sorted(fc.get("med", {})):
            q = [fc.get(k, {}).get(d) for k in ("25p", "med", "75p")]
            if not all(v and v > 0 for v in q):
                continue
            lq = np.log10(q)
            inside = bool(lo <= lq[1] <= hi)
            ys = np.clip(f["slope"] * lq + f["intercept"], 0, area_km2)
            days.append(
                {
                    "date": d,
                    "q25": round(q[0], 2),
                    "q50": round(q[1], 2),
                    "q75": round(q[2], 2),
                    "y_lo": round(float(min(ys[0], ys[2])), 3) if inside else None,
                    "y50": round(float(ys[1]), 3) if inside else None,
                    "y_hi": round(float(max(ys[0], ys[2])), 3) if inside else None,
                    "beyond_season": not inside,
                }
            )
    past = [
        [
            p["date"],
            round(flows[p["date"]], 2) if p["date"] in flows else None,
            p["flooded_veg_km2"],
        ]
        for p in passes
    ]
    return {
        "source": "GEOGloWS ECMWF river model (retrospective and 15-day ensemble forecast)",
        "river_id": raw_doc["river_id"],
        "river_mean_cms": round(raw_doc["mean_cms"], 1),
        "reaches_checked": len(raw_doc.get("candidates", [])),
        "forecast_generated": raw_doc.get("forecast_generated"),
        "fit": f,
        "usable": good,
        "withheld": withheld_reason(f, good),
        "past": past,
        "forecast": days,
        "flows": [[d, round(v, 2)] for d, v in sorted(flows.items())],
    }


def load(raw: Path) -> dict | None:
    f = raw / "nasa" / "geoglows.json"
    return json.loads(f.read_text(encoding="utf-8")) if f.is_file() else None


def to_date(s: str) -> date:
    return datetime.fromisoformat(s[:10]).date()
