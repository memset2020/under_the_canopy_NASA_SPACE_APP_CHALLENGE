"""Download inputs into pipeline/data/raw/<site>/ (tasks P-02, P-06, D-02, D-03, D-05, D-06).

Needs the `real` extra. Earthdata credentials are read from ~/.netrc
(machine urs.earthdata.nasa.gov) at run time and never stored in the repo.
Each function is a separate network step; the build itself is offline.
"""

from __future__ import annotations

import netrc
from collections import Counter
from pathlib import Path

import numpy as np

from . import io_gauge, io_gcov, osm

# Confirmed in asf_search 14 (asf.DATASET.NISAR, asf.PRODUCT_TYPE.GCOV, dataMaturity filter).
NISAR_DATASET = "NISAR"
GCOV_LEVEL = "GCOV"
CALIBRATED_FROM = "2026-06-17"  # docs/04 §2: calibrated public data starts here
EDL_HOST = "urs.earthdata.nasa.gov"
# Verified with earthaccess. DSWx-S1 is produced ~2 months after acquisition.
DSWX_SHORT_NAME = "OPERA_L3_DSWX-S1_V1"
DSWX_WTR_SUFFIX = "_B01_WTR.tif"
# Public ESA WorldCover v200 (2021) cloud-optimised 3° tiles; verified by a real fetch.
# WorldPop R2025A constrained 100 m counts (verified). The server ignores
# HTTP range requests, so the national file is downloaded once and cached.
WORLDPOP_YEAR = 2026
WORLDPOP_URL = (
    "https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/{year}/{ISO3}/v1/100m/"
    "constrained/{iso3}_pop_{year}_CN_100m_R2025A_v1.tif"
)
WORLDCOVER_URL = (
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/"
    "ESA_WorldCover_10m_2021_v200_{tile}_Map.tif"
)


def _asf():
    try:
        import asf_search  # pyright: ignore[reportMissingImports]
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("asf_search is missing: pip install -e .[real]") from exc
    return asf_search


def bbox_wkt(bbox: list[float]) -> str:
    w, s, e, n = bbox
    return f"POLYGON(({w} {s},{e} {s},{e} {n},{w} {n},{w} {s}))"


def _search(site: dict, start: str, end: str | None, maturity: str | None):
    asf = _asf()
    opts = {
        "dataset": NISAR_DATASET,
        "processingLevel": GCOV_LEVEL,
        "intersectsWith": bbox_wkt(site["bbox"]),
        "start": start,
        "end": end,
    }
    if maturity:
        opts["dataMaturity"] = maturity
    return asf.search(**opts)


def coverage(
    site: dict, start: str = CALIBRATED_FROM, end: str | None = None, maturity: str | None = None
) -> list[dict]:
    """One row per GCOV granule intersecting the site, newest first."""
    rows = []
    for r in _search(site, start, end, maturity):
        p = r.properties
        rows.append(
            {
                "date": str(p.get("startTime", ""))[:10],
                "track": p.get("pathNumber"),
                "frame": p.get("frameNumber"),
                "direction": str(p.get("flightDirection", "")).lower(),
                "file": p.get("fileName"),
                "url": p.get("url"),
            }
        )
    return sorted(rows, key=lambda row: row["date"], reverse=True)


def summarise_tracks(rows: list[dict]) -> list[tuple[tuple, int]]:
    """Passes per (track, direction): pick the most frequent one (docs/04 §3.1)."""
    return Counter((r["track"], r["direction"]) for r in rows).most_common()


def _edl_credentials() -> tuple[str, str]:
    try:
        auth = netrc.netrc().authenticators(EDL_HOST)
    except (FileNotFoundError, netrc.NetrcParseError) as exc:
        raise SystemExit(f"Add an Earthdata Login entry for {EDL_HOST} to ~/.netrc") from exc
    if not auth or not auth[0] or not auth[2]:
        raise SystemExit(f"~/.netrc has no login/password for {EDL_HOST}")
    return auth[0], auth[2]


MIN_PASSES = 6  # docs/04 §7: fewer passes cannot be checked against a gauge
FULL_VALID = 0.98  # a group this complete is taken without probing the others


def plan_gcov(
    site: dict,
    start: str = CALIBRATED_FROM,
    end: str | None = None,
    maturity: str | None = "PROVISIONAL",
    probe=None,
):
    """The comparable group (track, direction, bandwidth, HH+HV polarisation) to map the site with.

    Without `probe`: the group with most dates. With `probe(frames) -> imaged share`, groups
    are ranked by passes × the share of the box their newest granule actually images, because
    CMR footprints are frame outlines: at Janauacá and two analysed places they claim 100 % while
    the swath edge leaves 13-35 % of the box empty (docs/10 D-064). Probing stops at the first
    group that is nearly complete.
    """
    groups: dict[tuple, list] = {}
    for r in _search(site, start, end, maturity):
        name = io_gcov.parse_name(r.properties.get("fileName", ""))
        if name and name.has_hv:
            groups.setdefault(name.group, []).append(r)
    if not groups:
        return None, []

    def dates(g):
        return sorted({io_gcov.parse_name(r.properties["fileName"]).day for r in groups[g]})

    ranked = sorted(groups, key=lambda g: (len(dates(g)), g[2]), reverse=True)
    best = ranked[0]
    if probe is not None and len(ranked) > 1:
        floor = min(MIN_PASSES, len(dates(best)))
        scores = {}
        for g in (g for g in ranked if len(dates(g)) >= floor):
            last = dates(g)[-1]  # every frame of the newest date: two frames can meet in a box
            frames = [
                r for r in groups[g] if io_gcov.parse_name(r.properties["fileName"]).day == last
            ]
            valid = probe(frames)
            scores[g] = len(dates(g)) * valid
            if valid >= FULL_VALID:
                break
        complete = [g for g in scores if scores[g] >= FULL_VALID * len(dates(g))]
        if complete:  # the same rule as the build (real.select_track): whole box first
            best = max(complete, key=lambda g: (len(dates(g)), scores[g]))
        else:
            best = max(scores, key=lambda g: (scores[g], len(dates(g))))
    chosen = sorted(groups[best], key=lambda r: r.properties["fileName"])
    return best, chosen


def subset_gcov(
    site: dict,
    out: Path,
    start: str = CALIBRATED_FROM,
    end: str | None = None,
    maturity: str | None = "PROVISIONAL",
    limit: int | None = None,
    log=print,
) -> list[Path]:
    """Stream only the site window of each granule (HTTP range reads) into raw/<site>/gcov/.

    A 7 GB granule costs ~25 MB this way. Existing subsets are kept, so reruns resume.
    """
    try:
        import earthaccess  # pyright: ignore[reportMissingImports]
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("earthaccess is missing: pip install -e .[real]") from exc
    earthaccess.login(strategy="netrc")
    w0, s0, e0, n0 = (float(v) for v in site["bbox"])
    bounds = (w0, s0, e0, n0)
    probed: dict[str, io_gcov.Window | None] = {}

    def read(r):
        name = r.properties["fileName"]
        if name not in probed:
            remote = earthaccess.open([r.properties["url"]])[0]
            try:
                # Full resolution: this window may be written as the site's subset.
                probed[name] = io_gcov.read_window(Path(name), bounds, fileobj=remote, full=True)
            finally:
                remote.close()  # the window is in memory; its block cache need not be
        return probed[name]

    def probe(frames) -> float:
        windows = [w for w in (read(r) for r in frames) if w is not None]
        masks = [io_gcov.coverage_mask(w, bounds) for w in windows]
        valid = float(np.logical_or.reduce(masks).mean()) if masks else 0.0
        log(
            f"  probe track {frames[0].properties.get('pathNumber')}: {valid:.0%} of the box imaged"
        )
        return valid

    group, results = plan_gcov(site, start, end, maturity, probe=probe)
    if group is None or not results:
        return []
    log(f"group: track {group[0]} {group[1]} mode {group[2]} pol {group[3]}, {len(results)} passes")
    # Windows are held only until written: a 60 × 100 km fire box at 10 m is ~0.5 GB per
    # pass, and keeping every probe and pass ran a 7.7 GB machine out of memory.
    chosen = {r.properties["fileName"] for r in results}
    for name in [k for k in probed if k not in chosen]:
        del probed[name]
    out.mkdir(parents=True, exist_ok=True)
    saved = []
    for r in results[:limit]:
        name = r.properties["fileName"]
        target = out / name
        if target.is_file():
            saved.append(target)
            continue
        w = read(r)
        if w is None:
            log(f"  {name}: does not overlap the site, skipped")
            continue
        saved.append(io_gcov.write_subset(w, target))
        valid = float(np.isfinite(w.hh).mean())
        log(f"  {w.day}  {w.hh.shape[0]}x{w.hh.shape[1]} px  {valid:.0%} valid  -> {target.name}")
        probed.pop(name, None)
        del w
    return saved


FILL_MAX_DAYS = 7  # D-101: a gap is filled only from a pass at most this far from the site's own


def plan_fill(primary_days: list, candidates: list[tuple], max_days: int = FILL_MAX_DAYS) -> dict:
    """For each date of the site's own track, the nearest other-track date (HH+HV) that can fill
    where that track has no radar: {own day: (other day, group)}, nearest first, then the
    other track with the most dates. candidates: (day, group) of the other tracks' granules."""
    count = Counter(g for _, g in candidates)
    plan = {}
    for d in primary_days:
        near = [(abs((c - d).days), -count[g], c, g) for c, g in candidates]
        near = [x for x in near if x[0] <= max_days]
        if near:
            _, _, c, g = min(near, key=lambda x: (x[0], x[1], x[2]))
            plan[d] = (c, g)
    return plan


def subset_fill(
    site: dict,
    raw: Path,
    start: str = CALIBRATED_FROM,
    end: str | None = None,
    max_days: int = FILL_MAX_DAYS,
    log=print,
) -> list[Path]:
    """Fill the site's own track where its swath leaves the box empty (D-101).

    The track is the one already in raw/<site>/gcov (most granules). New dates of that track are
    added there; for each of its dates, the nearest HH+HV pass of another track within
    `max_days` that images the empty part is saved to raw/<site>/gcov_fill/. Only windows are
    read (HTTP range reads), as in subset_gcov.
    """
    try:
        import earthaccess  # pyright: ignore[reportMissingImports]
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("earthaccess is missing: pip install -e .[real]") from exc
    own = [n for p in sorted((raw / "gcov").glob("*.h5")) if (n := io_gcov.parse_name(p))]
    if not own:
        raise SystemExit(f"No GCOV in {raw / 'gcov'}: run fetch --gcov first")
    group = Counter(n.group for n in own).most_common(1)[0][0]
    w0, s0, e0, n0 = (float(v) for v in site["bbox"])
    bounds = (w0, s0, e0, n0)
    rows = {}
    for r in _search(site, start, end, "PROVISIONAL"):
        name = io_gcov.parse_name(r.properties.get("fileName", ""))
        if name and name.has_hv:
            rows.setdefault(r.properties["fileName"], (r, name))
    earthaccess.login(strategy="netrc")

    def window(r):
        remote = earthaccess.open([r.properties["url"]])[0]
        try:
            return io_gcov.read_window(
                Path(r.properties["fileName"]), bounds, fileobj=remote, full=True
            )
        finally:
            remote.close()

    saved = []
    have = {p.name for p in (raw / "gcov").glob("*.h5")}
    for fname, (r, name) in sorted(rows.items()):
        if name.group == group and fname not in have:
            w = window(r)
            if w is not None:
                saved.append(io_gcov.write_subset(w, raw / "gcov" / fname))
                log(f"  own track {name.day}: added -> {fname}")
    own_days = sorted({n.day for p in (raw / "gcov").glob("*.h5") if (n := io_gcov.parse_name(p))})
    others = [(n.day, n.group) for _r, n in rows.values() if n.group[:2] != group[:2]]
    plan = plan_fill(own_days, others, max_days)
    out = raw / "gcov_fill"
    out.mkdir(parents=True, exist_ok=True)
    for d in own_days:
        if d not in plan:
            log(f"  {d}: no other-track pass within {max_days} days")
            continue
        c, g = plan[d]
        for fname, (r, n) in sorted(rows.items()):
            if n.day != c or n.group != g:
                continue
            target = out / fname
            if not target.is_file():
                w = window(r)
                if w is None:
                    continue
                valid = float(np.isfinite(w.hh).mean())
                io_gcov.write_subset(w, target)
                log(f"  {d}: fill from track {g[0]} {g[1]} {c} ({valid:.0%} valid) -> {fname}")
            saved.append(target)
    return saved


def download_dswx(
    site: dict, out: Path, start: str, end: str, near: list | None = None, max_days: int = 6
) -> list[Path]:
    """Download the WTR layer of DSWx-S1 granules over the site.

    With `near` (NISAR pass dates), only granules within ±max_days of a pass are fetched.
    """
    try:
        import earthaccess  # pyright: ignore[reportMissingImports]
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("earthaccess is missing: pip install -e .[real]") from exc
    from .io_reference import dswx_date

    earthaccess.login(strategy="netrc")
    w, s, e, n = site["bbox"]
    granules = earthaccess.search_data(
        short_name=DSWX_SHORT_NAME, bounding_box=(w, s, e, n), temporal=(start, end)
    )
    links = []
    for g in granules:
        for u in g.data_links():
            if not u.endswith(DSWX_WTR_SUFFIX):
                continue
            d = dswx_date(Path(u))
            if near and (d is None or min(abs((d - x).days) for x in near) > max_days):
                continue
            if not (out / Path(u).name).is_file():
                links.append(u)
    out.mkdir(parents=True, exist_ok=True)
    if links:
        earthaccess.download(links, local_path=str(out))
    return sorted(out.glob("*WTR*.tif"))


def worldcover_tiles(bbox: list[float]) -> list[str]:
    """3° tile names (lower-left corner) covering a bbox, e.g. N30W093."""
    import math

    w, s, e, n = bbox
    names = []
    for lat in range(math.floor(s / 3) * 3, math.ceil(n / 3) * 3, 3):
        for lon in range(math.floor(w / 3) * 3, math.ceil(e / 3) * 3, 3):
            ns = f"{'N' if lat >= 0 else 'S'}{abs(lat):02d}"
            ew = f"{'E' if lon >= 0 else 'W'}{abs(lon):03d}"
            names.append(ns + ew)
    return names


def fetch_worldcover(site: dict, out: Path) -> list[Path]:
    """Read only the site window from each cloud-optimised tile and save it locally."""
    try:
        import rasterio
        from rasterio.windows import from_bounds
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("rasterio is missing: pip install -e .[real]") from exc
    out.mkdir(parents=True, exist_ok=True)
    pad = 0.01
    w, s, e, n = site["bbox"]
    saved = []
    for tile in worldcover_tiles(site["bbox"]):
        url = WORLDCOVER_URL.format(tile=tile)
        with rasterio.open(f"/vsicurl/{url}") as src:
            tb = src.bounds  # a site can straddle tiles: clip to this tile first
            box = (
                max(w - pad, tb.left),
                max(s - pad, tb.bottom),
                min(e + pad, tb.right),
                min(n + pad, tb.top),
            )
            if box[0] >= box[2] or box[1] >= box[3]:
                continue
            win = from_bounds(*box, transform=src.transform).round_offsets().round_lengths()
            data = src.read(1, window=win)
            profile = src.profile | {
                "width": data.shape[1],
                "height": data.shape[0],
                "transform": src.window_transform(win),
                "driver": "GTiff",
                "compress": "deflate",
            }
        path = out / f"worldcover_{tile}.tif"
        with rasterio.open(path, "w", **profile) as dst:
            dst.write(data, 1)
        saved.append(path)
    return saved


def fetch_gauge(site: dict, out: Path, start: str, end: str) -> Path:
    """Write raw/<site>/gauge.csv from the configured public source (usgs or ana)."""
    cfg = site.get("gauge") or {}
    sources = {"usgs": io_gauge.fetch_usgs, "ana": io_gauge.fetch_ana}
    if cfg.get("source") not in sources or not cfg.get("id"):
        raise SystemExit(
            f"{site['id']}: set gauge {{'source': 'usgs'|'ana', 'id': ...}} in config/sites.json, "
            f"or place a date,stage_m CSV at {out}"
        )
    rows = sources[cfg["source"]](cfg["id"], start, end)
    if not rows:
        raise SystemExit(f"{site['id']}: gauge {cfg['id']} returned no data for {start}..{end}")
    io_gauge.write_csv(out, rows)
    return out


def fetch_osm(site: dict, out: Path) -> Path:
    return osm.fetch(site["bbox"], out)


def _download(url: str, target: Path, log=print) -> Path:
    """Stream a public file to disk (resumable by skipping a complete file)."""
    import urllib.request

    if target.is_file() and target.stat().st_size > 0:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "under-the-canopy/0.2"})
    with urllib.request.urlopen(req, timeout=120) as res, tmp.open("wb") as fh:  # noqa: S310
        total = int(res.headers.get("Content-Length") or 0)
        done = 0
        while chunk := res.read(1 << 20):
            fh.write(chunk)
            done += len(chunk)
            if total and done % (100 << 20) < (1 << 20):
                log(f"  {target.name}: {done / 1e6:.0f}/{total / 1e6:.0f} MB")
    tmp.replace(target)
    return target


def fetch_worldpop(
    site: dict, out: Path, cache: Path, year: int = WORLDPOP_YEAR, log=print
) -> Path:
    """Cache the national WorldPop file, then save only the site window as worldpop.tif."""
    try:
        import rasterio
        from rasterio.windows import from_bounds
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("rasterio is missing: pip install -e .[real]") from exc
    iso3 = site.get("iso3")
    if not iso3:
        raise SystemExit(f"{site['id']}: add an 'iso3' country code to config/sites.json")
    url = WORLDPOP_URL.format(year=year, ISO3=iso3.upper(), iso3=iso3.lower())
    national = _download(url, cache / Path(url).name, log)
    pad = 0.02
    w, s, e, n = site["bbox"]
    with rasterio.open(national) as src:
        win = from_bounds(w - pad, s - pad, e + pad, n + pad, transform=src.transform)
        win = win.round_offsets().round_lengths()
        data = src.read(1, window=win)
        profile = src.profile | {
            "width": data.shape[1],
            "height": data.shape[0],
            "transform": src.window_transform(win),
            "driver": "GTiff",
            "compress": "deflate",
        }
    out.parent.mkdir(parents=True, exist_ok=True)
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(data, 1)
    return out
