"""Under the Canopy pipeline CLI.

python cli.py all --synthetic [--site ID ...]       # synthetic data → web/data/
python cli.py all [--site ID ...]                   # real data from pipeline/data/raw/<site>/
python cli.py fetch --site ID --coverage            # NISAR passes over a site
python cli.py fetch --site ID --gcov --worldcover --dswx --osm --gauge   # download inputs
python cli.py inspect GRANULE.h5                    # list HDF5 datasets (task P-03)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from canopy import config, synth
from canopy.build import build_site
from canopy.export import write_manifest


def _report(site: dict, s: dict, seconds: float) -> None:
    peak = next(p for p in s["passes"] if p["id"] == s["peak_pass"])
    gauge = s["validation"]["gauge"]
    label = "SYNTHETIC" if s["synthetic"] else "real"
    print(
        f"{site['id']:<12} {len(s['passes'])} passes  peak {peak['date']}  "
        f"flooded {peak['flooded_km2']:.1f} km²  hidden {peak['hidden_from_cband_km2']} km²  "
        f"r={gauge['r'] if gauge else 'n/a'}  ({seconds:.1f}s, {label})"
    )
    for w in s["warnings"]:
        if w["code"] != "synthetic_data":
            print(f"    warning {w['code']}: {w['detail']}")


def cmd_all(args: argparse.Namespace) -> int:
    out = (
        Path(args.out)
        if args.out
        else (config.WEB_SYNTH_DIR if args.synthetic else config.WEB_DATA_DIR)
    )
    sites = (
        [config.get_site(s) for s in args.site]
        if args.site
        else [s for s in config.load_sites() if not s.get("belt")]  # belt cells: cli.py belt
    )
    if args.synthetic and not args.site:
        # The simulator covers the three original demo sites only (tests and the offline demo).
        sites = [s for s in sites if "synthetic_seed" in s]
    built = []
    for site in sites:
        t0 = time.perf_counter()
        if args.synthetic:
            scene = synth.make_scene(site)
        else:
            from canopy import real

            if not (config.RAW_DIR / site["id"] / "gcov").is_dir():
                print(f"{site['id']:<12} skipped: no {config.RAW_DIR / site['id'] / 'gcov'}")
                continue
            try:
                scene = real.build_scene(site, width_px=args.grid)
            except SystemExit as exc:  # one site lacking an input must not stop the rest
                print(f"{site['id']:<12} skipped: {exc}")
                continue
        t = config.Thresholds(**site["thresholds"]) if site.get("thresholds") else None
        s = build_site(scene, out, t)
        _report(site, s, time.perf_counter() - t0)
        built.append(site["id"])
    if not built:
        print("Nothing built. Use --synthetic, or fetch real inputs first.", file=sys.stderr)
        return 2
    # Keep the published default (the demo's opening site) when rebuilding a few sites.
    prev = out / "manifest.json"
    keep = (
        json.loads(prev.read_text(encoding="utf-8")).get("default_site") if prev.is_file() else None
    )
    manifest = write_manifest(out, default_site=keep or built[0])
    print(f"manifest: {len(manifest['sites'])} site(s) → {out / 'manifest.json'}")
    return 0


def _fetch_geoglows(site: dict, start, out: Path):
    """The outlook's river: probe points from a grid and from the site's permanent water (JRC)."""
    from canopy import nasa_inputs, outlook

    occ = nasa_inputs.load_jrc(out.parent)
    water = outlook.water_points(occ, site["bbox"])
    return outlook.fetch(site, start.isoformat(), out / "geoglows.json", water=water)


def cmd_fetch(args: argparse.Namespace) -> int:
    from canopy import fetch

    site = config.get_site(args.site)
    raw = config.RAW_DIR / site["id"]
    did = False
    if args.coverage:
        rows = fetch.coverage(site, start=args.start, end=args.end, maturity=args.maturity)
        for (track, direction), n in fetch.summarise_tracks(rows):
            print(f"track {track} {direction}: {n} passes")
        for r in rows:
            where = f"track {r['track']}  frame {r['frame']}  {r['direction']}"
            print(f"  {r['date']}  {where}  {r['file']}")
        did = True
    if args.gcov:
        files = fetch.subset_gcov(
            site,
            raw / "gcov",
            start=args.start,
            end=args.end,
            maturity=args.maturity or "PROVISIONAL",
            limit=args.limit,
        )
        print(f"gcov: {len(files)} granule(s) in {raw / 'gcov'}")
        did = True
    if args.fill:
        files = fetch.subset_fill(site, raw, start=args.start, end=args.end)
        print(f"fill: {len(files)} granule(s) in {raw / 'gcov'} and {raw / 'gcov_fill'}")
        did = True
    if args.gazetteer:
        from canopy import gazetteer

        out = gazetteer.fetch(site, raw / "geonames.json", config.RAW_DIR / "_cache" / "geonames")
        print(f"gazetteer: {len(gazetteer.load(out))} GeoNames place(s) -> {out}")
        did = True
    if args.worldcover:
        print(f"worldcover: {len(fetch.fetch_worldcover(site, raw / 'worldcover'))} tile window(s)")
        did = True
    if args.dswx:
        end = args.end or time.strftime("%Y-%m-%d")
        from canopy import io_gcov

        days = sorted({g.day for p in (raw / "gcov").glob("*.h5") if (g := io_gcov.parse_name(p))})
        tiles = fetch.download_dswx(site, raw / "dswx", args.start, end, near=days or None)
        print(f"dswx: {len(tiles)} WTR file(s) near {len(days)} NISAR date(s)")
        did = True
    if args.osm:
        print(f"osm: {fetch.fetch_osm(site, raw / 'osm.json')}")
        did = True
    if args.wetlands:
        from canopy import wetland_labels

        if site.get("iso3") == "USA":
            print(f"wetlands: {wetland_labels.fetch_nwi(site['bbox'], raw / 'nwi.json')}")
        else:
            print(f"wetlands: {wetland_labels.fetch_osm(site['bbox'], raw / 'osm_wetlands.json')}")
        did = True
    if args.worldpop:
        cache = config.RAW_DIR / "_cache" / "worldpop"
        print(f"worldpop: {fetch.fetch_worldpop(site, raw / 'worldpop.tif', cache)}")
        did = True
    if args.gauge:
        end = args.end or time.strftime("%Y-%m-%d")
        print(f"gauge: {fetch.fetch_gauge(site, raw / 'gauge.csv', args.start, end)}")
        did = True
    if args.nasa:
        _fetch_nasa(site, raw, args)
        did = True
    if not did:
        print(
            "Choose at least one of --coverage --gcov --fill --gazetteer --worldcover --dswx --osm --gauge "
            "--worldpop --nasa",
            file=sys.stderr,
        )
        return 2
    return 0


def _fetch_nasa(site: dict, raw: Path, args: argparse.Namespace) -> None:
    """All docs/12 layers; each step runs independently so one failure doesn't stop the rest."""
    from datetime import date, timedelta

    from canopy import active_fire, burn, io_gcov, nasa_inputs, real

    names = [g for p in sorted((raw / "gcov").glob("*.h5")) if (g := io_gcov.parse_name(p))]
    if not names:
        raise SystemExit(f"Fetch GCOV first: python cli.py fetch --site {site['id']} --gcov")
    days = sorted({g.day for g in names})
    group = names[0].group
    height, width = real.grid_shape(tuple(float(v) for v in site["bbox"]), args.grid)
    out = raw / "nasa"
    start, end = days[0] - timedelta(days=12), min(days[-1] + timedelta(days=12), date.today())
    # Peak = the pass whose radar shows the most open water (classify.py rule 2); the
    # photo must come from the real peak, because the story calls it "peak flood".
    w0, s0, e0, n0 = (float(v) for v in site["bbox"])
    bounds = (w0, s0, e0, n0)
    dark = {}
    fire_before = date.fromisoformat(site["fire"]["before"]) if site.get("fire") else None
    for p in [] if fire_before else sorted((raw / "gcov").glob("*.h5")):
        w = io_gcov.read_window(p, bounds)
        if w is not None and w.day is not None and real.radiometry_ok(w)[0]:
            with np.errstate(invalid="ignore", divide="ignore"):
                dark[w.day] = float(
                    np.nanmean((10 * np.log10(w.hh) < -16) & (10 * np.log10(w.hv) < -22))
                )
    peak = max(dark, key=lambda d: dark[d]) if dark else days[len(days) // 2]
    if fire_before:  # a fire site's photo comes from the first pass after the fire started
        peak = next((d for d in days if d > fire_before), days[-1])
    print(f"peak pass for the photo: {peak}")
    steps = {
        "optical": lambda: nasa_inputs.fetch_optical(site, days, out, height, width),
        "photo": lambda: nasa_inputs.fetch_photo(site, peak, out, height, width),
        "canopy": lambda: nasa_inputs.fetch_canopy(site, out, height, width),
        "dem": lambda: nasa_inputs.fetch_dem(
            site, out, height, width, config.RAW_DIR / "_cache" / "nasadem"
        ),
        "gunw": lambda: nasa_inputs.fetch_gunw(site, group, days, out, height, width),
        "cygnss": lambda: nasa_inputs.fetch_cygnss(site, start, end, out / "cygnss_daily.csv"),
        "swot": lambda: nasa_inputs.fetch_swot(site, start, end, out / "swot_wse.csv"),
        "soil": lambda: nasa_inputs.fetch_soil(site, start, end, out / "soil_moisture.csv"),
        "rain": lambda: nasa_inputs.fetch_rain(site, start, end, out / "imerg_daily.csv"),
        "lc07": lambda: nasa_inputs.fetch_lc07(site, out, height, width),
        "rtc": lambda: nasa_inputs.fetch_rtc(site, days, out, height, width),
        "grdi": lambda: nasa_inputs.fetch_grdi(
            site, out, height, width, config.RAW_DIR / "_cache" / "grdi"
        ),
        "jrc": lambda: nasa_inputs.fetch_jrc(site, out, height, width),
        "grace": lambda: nasa_inputs.fetch_grace(
            site, out, config.RAW_DIR / "_global" / "GRACE_MASCON"
        ),
        "icesat2": lambda: nasa_inputs.fetch_icesat2(site, start, end, out / "icesat2_wse.csv"),
        "hand": lambda: nasa_inputs.fetch_hand(site, out, height, width),
        "glwd": lambda: nasa_inputs.fetch_glwd(site, out, height, width),
        "geoglows": lambda: _fetch_geoglows(site, start, out),
        "burned": lambda: burn.fetch_mcd64a1(site, start, end, out / "mcd64a1"),
        "burned_viirs": lambda: burn.fetch_burned_area(
            site, start, end, out / "vnp64a1", "VNP64A1"
        ),
        "active_fire": lambda: active_fire.fetch(
            site, fire_before - timedelta(days=5), days[-1], out / "active_fire.csv"
        ),
    }
    if not fire_before:  # burned area and active fire are fire-site steps
        for name in ("burned", "burned_viirs", "active_fire"):
            steps.pop(name)
    wanted = args.only.split(",") if args.only else list(steps)
    for name in wanted:
        print(f"== {name}")
        try:
            steps[name]()
        except SystemExit as exc:
            print(f"  {name} skipped: {exc}")
        except Exception as exc:  # noqa: BLE001 - keep going; report each failure
            print(f"  {name} failed: {type(exc).__name__}: {str(exc)[:200]}")


def cmd_calibrate(args: argparse.Namespace) -> int:
    """Tune thresholds per site from labels (task D-04); prints a held-out report."""
    import json

    from canopy import calibrate, real

    site = config.get_site(args.site)
    scene = real.build_scene(site)
    labels = calibrate.load_labels(site["id"], scene)
    print(f"labels from the app: {len(labels)}")
    hand = ["hand labels (app label mode)"] if labels else []
    sources = {"flooded_veg": list(hand), "open_water": list(hand)}
    lc07 = config.RAW_DIR / site["id"] / "nasa" / "lc07.npz"
    if lc07.is_file():
        stage = dict(scene.gauge.daily) if scene.gauge else {}
        levels = [stage.get(d, np.nan) for d in scene.dates]
        cut = np.nanpercentile(levels, 70) if np.isfinite(levels).any() else None
        high = [i for i, v in enumerate(levels) if cut is not None and v >= cut]  # no gauge: none
        auto = calibrate.auto_labels_lc07(
            scene, np.load(lc07)["codes"], high, np.random.default_rng(1)
        )
        wet = [scene.dates[i].isoformat() for i in high]
        print(f"automatic labels from LBA-ECO LC-07: {len(auto)} (high-water passes {wet})")
        labels += auto
        for comp in sources:
            sources[comp].append("LBA-ECO LC-07 Amazon wetland map")
    from canopy import wetland_labels

    wl_file = next(
        (
            f
            for f in (config.RAW_DIR / site["id"] / n for n in ("nwi.json", "osm_wetlands.json"))
            if f.is_file()
        ),
        None,
    )
    if wl_file is not None:
        stage = dict(scene.gauge.daily) if scene.gauge else {}
        levels = [stage.get(d, np.nan) for d in scene.dates]
        cut = np.nanpercentile(levels, 70) if np.isfinite(levels).any() else None
        # No gauge, no honest high-water dates: seasonal wetlands then give no labels at all,
        # only always-flooded ones do (docs/10 D-059).
        high = [i for i, v in enumerate(levels) if cut is not None and v >= cut]
        h, w = scene.hh_db.shape[1:]
        m = wetland_labels.masks(wl_file, scene.bounds, h, w)
        auto = wetland_labels.auto_labels(scene, m, high, np.random.default_rng(3))
        wet = [scene.dates[i].isoformat() for i in high]
        print(
            f"automatic labels from mapped wetlands ({wl_file.name}): {len(auto)} "
            f"(high-water passes {wet})"
        )
        labels += auto
        if auto:
            sources["flooded_veg"].append(
                "USFWS National Wetlands Inventory"
                if wl_file.name == "nwi.json"
                else "OpenStreetMap swamp-forest and forest polygons"
            )
    optical = calibrate.auto_labels_optical(scene, np.random.default_rng(2))
    if optical:
        print(f"automatic open-water labels from OPERA DSWx-HLS (clear, open land): {len(optical)}")
        labels += optical
        sources["open_water"].append("OPERA DSWx-HLS optical water")
    if not labels:
        print(
            "No labels. Export them from the app's label mode to "
            f"{calibrate.LABELS_DIR / (site['id'] + '.json')}",
            file=sys.stderr,
        )
        return 2
    # Always score against the literature defaults so a rerun reproduces the same decision.
    base = config.Thresholds()
    report = calibrate.calibrate(scene, labels, base)
    path = calibrate.write_report(site["id"], report)
    print(json.dumps(report, indent=1))
    print(f"report: {path}")
    if args.apply:
        sites_doc = json.loads(config.SITES_FILE.read_text(encoding="utf-8"))
        chosen, decision = calibrate.accepted(report)
        chosen, decision = calibrate.timing_check(scene, chosen, decision)
        for s in sites_doc["sites"]:
            if s["id"] == site["id"]:
                s["thresholds"] = chosen
                s["calibration"] = {
                    c: {**d, "label_sources": sources[c]} for c, d in decision.items()
                }
        print("decision:", json.dumps(decision))
        config.SITES_FILE.write_text(
            json.dumps(sites_doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
        print(
            f"applied to {config.SITES_FILE}: add the reason as a docs/10 line (CLAUDE.md rule 4)"
        )
    return 0


def cmd_global(args: argparse.Namespace) -> int:
    """Global 0.25° context grid (docs/03 §4.10); --fetch downloads the inputs first."""
    import json
    from datetime import date

    from canopy import export, fetch, global_layers

    raw = config.RAW_DIR / "_global"
    if args.fetch:
        global_layers.fetch_nisar_footprints(
            raw / "nisar_gcov.json.gz", fetch.CALIBRATED_FROM, args.end or date.today().isoformat()
        )
        global_layers.fetch_products(raw)
        global_layers.fetch_wetcharts(raw)
    out_root = Path(args.out) if args.out else config.WEB_DATA_DIR
    sites = [
        {"id": s["id"], "name": s["name"], "bbox": s["bbox"]}
        for s in json.loads(config.SITES_FILE.read_text(encoding="utf-8"))["sites"]
    ]
    global_layers.build(raw, out_root / "global", sites)
    m = json.loads((out_root / "manifest.json").read_text(encoding="utf-8"))
    export.write_manifest(out_root, default_site=m.get("default_site"))
    return 0


def cmd_gibs(args: argparse.Namespace) -> int:
    """NASA GIBS world-layer catalogue for the live map (docs/03 §4.11)."""
    from canopy import gibs

    cap = config.RAW_DIR / "_global" / "gibs_capabilities.xml"
    cap4326 = config.RAW_DIR / "_global" / "gibs_capabilities_4326.xml"
    if args.fetch or not cap.is_file():
        gibs.fetch_capabilities(cap)
    if args.fetch or not cap4326.is_file():
        gibs.fetch_capabilities(cap4326, gibs.CAPABILITIES_4326)
    out = Path(args.out) if args.out else config.WEB_DATA_DIR / "gibs.json"
    doc = gibs.build(cap, out, cap4326)
    for layer in doc["layers"]:
        span = f"{layer['dates'][0][0]}..{layer['dates'][-1][1]}" if layer["dates"] else "static"
        print(f"  {layer['id']:<55} z<={layer['max_zoom']:<2} {span}")
    for o in doc["orbits"]:
        legs = [k for k in ("ascending", "descending") if k in o]
        print(f"  orbit {o['mission']:<14} {'+'.join(legs)} levels {len(o['levels'] or [])}")
    for f in doc["fires"]:
        print(f"  fire  {f['sensor']:<28} {f['dates'][0][0]}..{f['dates'][-1][1]}")
    print(
        f"gibs: {len(doc['layers'])} layers, {len(doc['orbits'])} orbit tracks, "
        f"{len(doc['fires'])} active-fire layers -> {out}"
    )
    return 0


def cmd_motion(args: argparse.Namespace) -> int:
    """Ground that moved (docs/14): NISAR GUNW motion for the events in config/motion.json."""
    from canopy import export, motion

    events = [motion.get_event(e) for e in args.event] if args.event else motion.load_events()
    for ev in events:
        raw = config.RAW_DIR / "motion" / ev["id"]
        if args.fetch:
            motion.fetch_rupture(ev, raw)
            motion.fetch_finite_fault(ev, raw)
            motion.fetch(ev, raw)
            if ev.get("gnss"):
                from canopy import gnss

                gnss.fetch(ev, raw)
        motion.build(ev, raw)
    motion.write_index()
    prev = config.WEB_DATA_DIR / "manifest.json"
    keep = (
        json.loads(prev.read_text(encoding="utf-8")).get("default_site") if prev.is_file() else None
    )
    export.write_manifest(config.WEB_DATA_DIR, default_site=keep)
    return 0


def cmd_glaciers(args: argparse.Namespace) -> int:
    """Glacier atlas (docs/16): ITS_LIVE flow, its history, GRACE mass, NISAR coverage."""
    from canopy import export, glaciers

    glaciers.run(args.site, fetch=args.fetch, annual=not args.static_only, goff=args.goff)
    prev = config.WEB_DATA_DIR / "manifest.json"
    keep = (
        json.loads(prev.read_text(encoding="utf-8")).get("default_site") if prev.is_file() else None
    )
    export.write_manifest(config.WEB_DATA_DIR, default_site=keep)
    return 0


def cmd_ice(args: argparse.Namespace) -> int:
    """Downwind ice (docs/15): smoke, glacier albedo and ice speed for config/ice.json."""
    from canopy import export, ice

    events = [ice.get_event(e) for e in args.event] if args.event else ice.load_events()
    for ev in events:
        raw = config.RAW_DIR / "ice" / ev["id"]
        if args.fetch:
            ice.fetch(ev, raw, only=args.only.split(",") if args.only else None)
        ice.build(ev, raw)
    ice.write_index()
    prev = config.WEB_DATA_DIR / "manifest.json"
    keep = (
        json.loads(prev.read_text(encoding="utf-8")).get("default_site") if prev.is_file() else None
    )
    export.write_manifest(config.WEB_DATA_DIR, default_site=keep)
    return 0


def cmd_events(args: argparse.Namespace) -> int:
    """Snapshot of flood events reported now (GDACS) for World mode (docs/03 §4.15)."""
    from canopy import events, export

    out = config.WEB_DATA_DIR / "events.json"
    doc = events.build(out, args.days)
    levels = {
        lv: sum(1 for e in doc["events"] if e["alert"] == lv) for lv in ("Red", "Orange", "Green")
    }
    print(f"events: {len(doc['events'])} flood events in {args.days} days {levels} -> {out}")
    prev = config.WEB_DATA_DIR / "manifest.json"
    keep = (
        json.loads(prev.read_text(encoding="utf-8")).get("default_site") if prev.is_file() else None
    )
    export.write_manifest(config.WEB_DATA_DIR, default_site=keep)
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    """Serve web/ with the local "analyse here" job API (F36, localhost only)."""
    from canopy import serve

    serve.serve(args.port)
    return 0


def cmd_belt(args: argparse.Namespace) -> int:
    """Detailed maps for flooded-forest cells of the global grid, free (docs/13, D-057)."""
    from concurrent.futures import ThreadPoolExecutor

    from canopy import belt

    if args.cell:  # rerun named cells, e.g. after a better track is found (D-064)
        cells = [(*map(int, c.split(",")), None) for c in args.cell]
    else:
        cells = belt.plan(args.scope)[args.offset : args.offset + args.limit]
    print(f"belt: {len(cells)} cell(s), scope {args.scope}, {args.lanes} lane(s)")
    done = 0

    import threading

    from canopy import export

    lock = threading.Lock()

    def one(cell):
        nonlocal done
        row, col, _ = cell
        entry = belt.run_cell(row, col, force=bool(args.cell))
        with lock:
            done += 1
            state = "mapped" if entry else "skipped"
            print(f"  [{done}/{len(cells)}] {belt.cell_id(row, col)} {state}", flush=True)
            if entry:
                # Publish each new cell at once: a full run takes days on one PC.
                belt.write_index()
                prev = config.WEB_DATA_DIR / "manifest.json"
                keep = (
                    json.loads(prev.read_text(encoding="utf-8")).get("default_site")
                    if prev.is_file()
                    else None
                )
                export.write_manifest(config.WEB_DATA_DIR, default_site=keep)
        return entry

    with ThreadPoolExecutor(max_workers=args.lanes) as pool:
        results = list(pool.map(one, cells))
    doc = belt.write_index()
    print(f"belt: {sum(1 for r in results if r)} mapped now, {len(doc['cells'])} in the index")
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    from canopy import io_gcov

    for line in io_gcov.inspect(Path(args.granule)):
        print(line)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="cli.py", description=(__doc__ or "").strip().splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("all", help="build every product for the sites")
    a.add_argument("--synthetic", action="store_true", help="use synth.py instead of real data")
    a.add_argument("--site", action="append", help="site id (repeatable); default all")
    a.add_argument("--out", default=None, help="default: web/data (real) or web/data-synthetic")
    a.add_argument("--grid", type=int, default=256, help="web grid width in pixels (real data)")
    a.set_defaults(func=cmd_all)

    f = sub.add_parser("fetch", help="query or download real inputs for one site")
    f.add_argument("--site", required=True)
    f.add_argument("--coverage", action="store_true", help="list NISAR GCOV passes")
    f.add_argument("--gcov", action="store_true", help="stream site windows of GCOV")
    f.add_argument(
        "--fill",
        action="store_true",
        help="new dates of the site's track, and other-track passes for its swath gaps (D-101)",
    )
    f.add_argument("--gazetteer", action="store_true", help="GeoNames villages in the box (D-104)")
    f.add_argument("--worldcover", action="store_true", help="save the WorldCover window")
    f.add_argument("--dswx", action="store_true", help="download DSWx-S1 WTR layers")
    f.add_argument("--osm", action="store_true", help="cache OSM roads and places")
    f.add_argument("--worldpop", action="store_true", help="WorldPop window (caches the country)")
    f.add_argument("--nasa", action="store_true", help="all docs/12 NASA layers")
    f.add_argument(
        "--wetlands",
        action="store_true",
        help="mapped wetlands for calibration labels (NWI in the US, OSM elsewhere)",
    )
    f.add_argument("--only", default=None, help="with --nasa: comma list, e.g. optical,gunw")
    f.add_argument("--grid", type=int, default=256, help="web grid width in pixels")
    f.add_argument("--gauge", action="store_true", help="USGS gauge → gauge.csv")
    f.add_argument("--start", default="2026-06-17")
    f.add_argument("--end", default=None)
    f.add_argument("--maturity", default=None, choices=[None, "PROVISIONAL", "BETA"])
    f.add_argument("--limit", type=int, default=None, help="max granules to download")
    f.set_defaults(func=cmd_fetch)

    c = sub.add_parser("calibrate", help="tune thresholds from labels (D-04)")
    c.add_argument("--site", required=True)
    c.add_argument("--apply", action="store_true", help="write tuned thresholds to sites.json")
    c.set_defaults(func=cmd_calibrate)

    g = sub.add_parser("global", help="build the global 0.25° context grid (F31)")
    g.add_argument("--fetch", action="store_true", help="download NISAR footprints and products")
    g.add_argument("--end", default=None, help="last NISAR date (default: today)")
    g.add_argument("--out", default=None, help="default: web/data")
    g.set_defaults(func=cmd_global)

    w = sub.add_parser("gibs", help="catalogue NASA GIBS world layers for the live map")
    w.add_argument("--fetch", action="store_true", help="download the capabilities document again")
    w.add_argument("--out", default=None, help="default: web/data/gibs.json")
    w.set_defaults(func=cmd_gibs)

    v = sub.add_parser("serve", help="serve the app with the local 'analyse here' button")
    v.add_argument("--port", type=int, default=8090)
    v.set_defaults(func=cmd_serve)

    mo = sub.add_parser("motion", help="ground motion from NISAR GUNW (earthquakes, subsidence)")
    mo.add_argument("--event", action="append", help="event id from config/motion.json")
    mo.add_argument("--fetch", action="store_true", help="read the interferograms first")
    mo.set_defaults(func=cmd_motion)
    ic = sub.add_parser("ice", help="smoke, glacier albedo and ice speed downwind of a fire")
    ic.add_argument("--event", action="append", help="ice event id (default: all)")
    ic.add_argument("--fetch", action="store_true", help="download inputs first")
    ic.add_argument("--only", help="fetch steps: albedo,smoke,fire,goff,itslive")
    ic.set_defaults(func=cmd_ice)
    gl = sub.add_parser("glaciers", help="glacier atlas: ITS_LIVE flow and history, GRACE mass")
    gl.add_argument("--site", action="append", help="glacier id from config/glaciers.json")
    gl.add_argument("--fetch", action="store_true", help="read ITS_LIVE and GRACE first")
    gl.add_argument("--static-only", action="store_true", help="skip the 1985-2024 annual maps")
    gl.add_argument("--goff", action="store_true", help="NISAR ice-offset test (nisar_test sites)")
    gl.set_defaults(func=cmd_glaciers)
    ev = sub.add_parser("events", help="flood events reported now (GDACS) for World mode")
    ev.add_argument("--days", type=int, default=45)
    ev.set_defaults(func=cmd_events)
    b = sub.add_parser("belt", help="detailed maps for flooded-forest cells of the global grid")
    b.add_argument("--scope", choices=["strict", "full"], default="strict")
    b.add_argument("--limit", type=int, default=20, help="cells to process, best first")
    b.add_argument("--lanes", type=int, default=2, help="cells in parallel")
    b.add_argument("--offset", type=int, default=0, help="skip the first N cells (for chunks)")
    b.add_argument(
        "--cell", action="append", metavar="ROW,COL", help="only these grid cells (repeatable)"
    )
    b.set_defaults(func=cmd_belt)

    i = sub.add_parser("inspect", help="list the datasets in a GCOV granule")
    i.add_argument("granule")
    i.set_defaults(func=cmd_inspect)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
