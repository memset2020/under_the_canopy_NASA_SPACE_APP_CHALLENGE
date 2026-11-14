"""Build a notebook for every published site: water, fire, ground and ice (docs/10 D-098).

    python notebooks/build_notebooks.py                      # every site, executed
    python notebooks/build_notebooks.py --kind water --site sylhet
    python notebooks/build_notebooks.py --no-execute         # cells only, fast

Each notebook is written by its motif (notebooks/motifs/), carries the site's published files in a
folded first cell, and is executed in an empty temporary folder, exactly as a user would run it, so a
notebook that cannot run from its own contents fails here. Outputs go to notebooks/build/<kind>/<id>.ipynb
(git-ignored) with notebooks/build/index.json; notebooks/sync_to_drive.sh publishes them.
Execution needs jupyter (nbclient, ipykernel), numpy, matplotlib, scikit-learn, torch and rasterio.
"""

from __future__ import annotations

import argparse
import importlib
import json
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from motifs.common import ROOT, WEB_DATA, embed_cell

OUT = ROOT / "notebooks" / "build"
REFERENCE = ROOT / "notebooks" / "under_the_canopy_nisar_ml_tutorial.ipynb"
KINDS = ("water", "fire", "ground", "ice")  # notebooks/motifs/<kind>.py


def sites() -> list[tuple[str, str, str]]:
    """(kind, id, name) for every published site, in the app's own lists."""
    manifest = json.loads((WEB_DATA / "manifest.json").read_text())
    out = []
    for s in manifest["sites"]:
        if s.get("synthetic"):
            continue
        out.append(("fire" if s.get("kind") == "fire" else "water", s["id"], s["name"]))
    for e in json.loads((WEB_DATA / "motion" / "index.json").read_text())["events"]:
        out.append(("ground", e["id"], e["name"]))
    for g in json.loads((WEB_DATA / "glaciers" / "index.json").read_text())["glaciers"]:
        out.append(("ice", g["id"], g["name"]))
    return out


def execute(nb: dict, timeout: int = 1200) -> tuple[dict, list[str]]:
    import nbformat
    from nbclient import NotebookClient
    from nbclient.exceptions import CellExecutionError

    node = nbformat.reads(json.dumps(nb), as_version=4)
    with tempfile.TemporaryDirectory() as tmp:
        client = NotebookClient(
            node,
            timeout=timeout,
            kernel_name="python3",
            resources={"metadata": {"path": tmp}},
            record_timing=False,  # no run timestamps in the published notebooks
        )
        try:
            client.execute()
        except CellExecutionError as err:
            raise RuntimeError(str(err)[-1500:]) from err
    errors = [
        o.get("ename", "")
        for c in node.cells
        if c.cell_type == "code"
        for o in c.get("outputs", [])
        if o.get("output_type") == "error"
    ]
    return json.loads(nbformat.writes(node)), errors


def build_one(kind: str, site_id: str, run: bool) -> dict:
    motif = importlib.import_module(f"motifs.{kind}")
    nb = motif.build(site_id).to_json()
    cell, digests = embed_cell(motif.files(site_id))
    nb["cells"].insert(1, dict(cell, id="data"))
    t = time.time()
    if run:
        nb, errors = execute(nb)
        if errors:
            raise RuntimeError(f"{kind}/{site_id}: {errors}")
    if (kind, site_id) == ("water", "sylhet") and run:
        # The repository's reference copy: same notebook without its packed data (inside the repo,
        # the setup cell finds web/data/ one folder up).
        ref = dict(nb, cells=[c for c in nb["cells"] if c.get("id") != "data"])
        REFERENCE.write_text(json.dumps(ref, indent=1, ensure_ascii=False) + "\n")
    path = OUT / kind / f"{site_id}.ipynb"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n")
    return {
        "kind": kind,
        "id": site_id,
        "file": str(path.relative_to(ROOT)),
        "bytes": path.stat().st_size,
        "executed": run,
        "seconds": round(time.time() - t),
        "data": digests,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=(__doc__ or "").splitlines()[0])
    ap.add_argument("--kind", choices=KINDS)
    ap.add_argument("--site", action="append", help="site id (repeatable)")
    ap.add_argument("--no-execute", action="store_true")
    a = ap.parse_args()
    todo = [
        s
        for s in sites()
        if (not a.kind or s[0] == a.kind) and (not a.site or s[1] in a.site)
    ]
    index_file = OUT / "index.json"
    index = json.loads(index_file.read_text()) if index_file.exists() else {}
    failed = []
    for kind, sid, name in todo:
        try:
            entry = build_one(kind, sid, not a.no_execute)
        except (
            RuntimeError,
            OSError,
            KeyError,
            ValueError,
            IndexError,
            TypeError,
            AssertionError,
        ) as err:
            failed.append(f"{kind}/{sid}: {str(err)[:300]}")
            print("FAILED", failed[-1], flush=True)
            continue
        index[f"{kind}/{sid}"] = dict(entry, name=name)
        print(
            f"{kind:6} {sid:24} {entry['bytes'] / 1e6:5.1f} MB  {entry['seconds']:4d} s",
            flush=True,
        )
        index_file.write_text(json.dumps(index, indent=1, ensure_ascii=False) + "\n")
    if failed:
        print(f"\n{len(failed)} failed:", *failed, sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    if "--clean" in sys.argv:
        shutil.rmtree(OUT, ignore_errors=True)
        sys.argv.remove("--clean")
    main()
