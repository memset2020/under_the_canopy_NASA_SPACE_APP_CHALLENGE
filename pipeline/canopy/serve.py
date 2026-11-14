"""Local "analyse here" server (F36, docs/10 D-055).

Serves web/ like `python -m http.server`, plus a small job API on 127.0.0.1 only:

    GET  /api/health          {"analyse": true}
    POST /api/analyse         {"lon": .., "lat": ..} -> {"job": id}
    GET  /api/jobs/<id>       status, log tail, site id when done

A job checks NISAR coverage over a 16 km box, then runs the same `cli.py` steps as a hand
build (radar subsets, land cover, C-band water, optical, canopy, terrain, roads, people)
and builds the site into web/data. It uses the Earthdata login in ~/.netrc through
earthaccess; this module never reads that file. GitHub Pages has no /api, so the app's
button only appears when this server is the one serving it.
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
import uuid
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from . import config, fetch

WEB_DIR = config.PIPELINE_DIR.parent / "web"
BOX_DEG = (0.16, 0.14)  # same size as the hand-picked sites
MIN_PASSES = 6
MAX_BODY = 1024
STEPS = [
    ("radar", ["fetch", "--gcov"]),
    ("land cover", ["fetch", "--worldcover"]),
    ("C-band water", ["fetch", "--dswx"]),
    ("roads and places", ["fetch", "--osm"]),
    ("people", ["fetch", "--worldpop"]),
    ("NASA layers", ["fetch", "--nasa", "--only", "optical,photo,canopy,dem,rtc"]),
    ("build", ["all"]),
]
REQUIRED = {"radar", "build"}

_jobs: dict[str, dict] = {}
_lock = threading.Lock()


def site_for(lon: float, lat: float) -> dict:
    """A site config centred on the clicked point."""
    w, h = BOX_DEG
    tag = f"{'n' if lat >= 0 else 's'}{abs(lat):.2f}_{'e' if lon >= 0 else 'w'}{abs(lon):.2f}"
    return {
        "id": "here_" + tag.replace(".", "p"),
        "name": f"Analysed here: {abs(lat):.2f}°{'N' if lat >= 0 else 'S'}, "
        f"{abs(lon):.2f}°{'E' if lon >= 0 else 'W'}",
        "country": "",
        "bbox": [
            round(lon - w / 2, 4),
            round(lat - h / 2, 4),
            round(lon + w / 2, 4),
            round(lat + h / 2, 4),
        ],
        "zoom": 12,
        "language": "en",
        "flood_season": "unknown",
        "custom": True,
    }


def _save_local_site(site: dict) -> None:
    path = config.LOCAL_SITES_FILE
    doc = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {"sites": []}
    doc["sites"] = [s for s in doc["sites"] if s["id"] != site["id"]] + [site]
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _log(job: dict, line: str) -> None:
    with _lock:
        job["log"] = (job["log"] + [line])[-40:]


def _run(job: dict) -> None:
    site = job["site"]
    job["status"] = "running"
    _log(job, f"Checking NISAR coverage over {site['bbox']}")
    try:
        group, passes = fetch.plan_gcov(site)
    except Exception as exc:  # noqa: BLE001 - report any search failure to the page
        job.update(status="failed", message=f"NISAR search failed: {exc}")
        return
    if group is None or len(passes) < MIN_PASSES:
        job.update(
            status="no_coverage",
            message=f"{len(passes)} HH+HV passes from one track; {MIN_PASSES} are needed.",
        )
        return
    _log(job, f"{len(passes)} passes on track {group[0]} {group[1]}")
    _save_local_site(site)
    for i, (label, args) in enumerate(STEPS, start=1):
        job["step"] = f"{i}/{len(STEPS)} {label}"
        _log(job, f"== {label}")
        cmd = [sys.executable, "cli.py", *args, "--site", site["id"]]
        proc = subprocess.run(  # noqa: S603 - fixed argv, site id generated here
            cmd, cwd=config.PIPELINE_DIR, capture_output=True, text=True, timeout=7200
        )
        for line in (proc.stdout + proc.stderr).splitlines()[-6:]:
            _log(job, line[:200])
        if proc.returncode != 0 and label in REQUIRED:
            job.update(status="failed", message=f"step '{label}' failed")
            return
    job.update(status="done", site_id=site["id"], finished=time.time())


class Handler(SimpleHTTPRequestHandler):
    # Every response says the job API is here, so the app can detect it from the files it
    # already loads, without probing a URL that 404s on ordinary static hosting.
    def end_headers(self) -> None:
        self.send_header("X-Canopy-Analyse", "1")
        # Revalidate every file (a 304 is cheap): a browser holding an old module next to a
        # new one fails to start the app and shows a blank page.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        if self.path == "/api/health":
            self._json(200, {"analyse": True})
        elif self.path.startswith("/api/jobs/"):
            job = _jobs.get(self.path.rsplit("/", 1)[-1])
            if job is None:
                self._json(404, {"error": "unknown job"})
            else:
                with _lock:
                    self._json(
                        200,
                        {k: v for k, v in job.items() if k != "site"} | {"site": job["site"]["id"]},
                    )
        else:
            super().do_GET()

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        if self.path != "/api/analyse":
            self._json(404, {"error": "not found"})
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_BODY:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "bad body"})
            return
        try:
            body = json.loads(self.rfile.read(n))
            lon, lat = float(body["lon"]), float(body["lat"])
        except (ValueError, KeyError, TypeError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "lon and lat are required numbers"})
            return
        if not (-180 <= lon <= 180 and -80 <= lat <= 80):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "outside the mapped latitudes"})
            return
        with _lock:
            if any(j["status"] in ("queued", "running") for j in _jobs.values()):
                self._json(HTTPStatus.CONFLICT, {"error": "a job is already running"})
                return
            job_id = uuid.uuid4().hex[:12]
            job = {
                "id": job_id,
                "status": "queued",
                "step": "",
                "log": [],
                "site": site_for(lon, lat),
            }
            _jobs[job_id] = job
        threading.Thread(target=_run, args=(job,), daemon=True).start()
        self._json(202, {"job": job_id, "site": job["site"]["id"]})


class Server(ThreadingHTTPServer):
    # The app requests ~70 modules at once. The default backlog of 5 overflows; Linux retries
    # the extra connections quietly, Windows refuses them and feature modules fail to load.
    request_queue_size = 128


def serve(port: int = 8090) -> None:
    handler = partial(Handler, directory=str(WEB_DIR))
    httpd = Server(("127.0.0.1", port), handler)
    print(f"Under the Canopy with 'analyse here': http://127.0.0.1:{port}/  (Ctrl+C stops)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
