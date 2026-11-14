"""Local 'analyse here' server (F36): validation and job API, without real NISAR jobs."""

import json
import threading
import urllib.error
import urllib.request
from functools import partial
from http.server import ThreadingHTTPServer

import pytest

from canopy import serve


def test_site_for_centres_a_16_km_box_with_a_safe_id():
    s = serve.site_for(91.92, 24.99)
    assert s["id"] == "here_n24p99_e91p92"
    w, so, e, n = s["bbox"]
    assert abs((w + e) / 2 - 91.92) < 1e-6 and abs((so + n) / 2 - 24.99) < 1e-6
    assert serve.site_for(-60.3, -3.4)["id"] == "here_s3p40_w60p30"


@pytest.fixture()
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(serve, "_run", lambda job: job.update(status="running"))
    serve._jobs.clear()
    (tmp_path / "index.html").write_text("ok")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), partial(serve.Handler, directory=str(tmp_path)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def _post(url, body):
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def test_health_validation_and_one_job_at_a_time(server):
    with urllib.request.urlopen(server + "/api/health", timeout=10) as r:
        assert json.load(r) == {"analyse": True}
    assert _post(server + "/api/analyse", b'{"lon": "x"}')[0] == 400
    assert _post(server + "/api/analyse", b'{"lon": 0, "lat": 89}')[0] == 400
    code, body = _post(server + "/api/analyse", b'{"lon": 17.48, "lat": 1.37}')
    assert code == 202 and body["site"] == "here_n1p37_e17p48"
    assert _post(server + "/api/analyse", b'{"lon": 10, "lat": 1}')[0] == 409
    with urllib.request.urlopen(f"{server}/api/jobs/{body['job']}", timeout=10) as r:
        assert json.load(r)["status"] == "running"
    with urllib.request.urlopen(server + "/index.html", timeout=10) as r:
        assert r.read() == b"ok"  # still serves the app
        assert r.headers["X-Canopy-Analyse"] == "1"
