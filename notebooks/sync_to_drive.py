"""Publish the built notebooks to Google Drive and write web/data/notebooks.json (docs/10 D-098).

    python notebooks/build_notebooks.py      # build and run every notebook first
    python notebooks/sync_to_drive.py        # upload, share view-only, write the app's index

Uses rclone (https://rclone.org; a free tool, not a project dependency). Once per machine, grant
Google permission in your browser:

    rclone config create canopy-drive drive scope=drive.file

drive.file lets rclone see and change only files it created. Files go to the Drive folder
Under_The_Canopy_NASA_Space_App_Challenge_Notebooks/<kind>/<id>.ipynb and are replaced in place
on later runs, so their Drive ids, and the app's Colab links, never change. Each is shared
"anyone with the link can view" (the owner's choice, D-097): viewers run their own copy and
cannot change the original. The Sylhet notebook is also kept at the folder's top as
under_the_canopy_notebook.ipynb, the link the landing page uses (D-097).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "notebooks" / "build"
OUT = ROOT / "web" / "data" / "notebooks.json"
REMOTE = os.environ.get("CANOPY_DRIVE_REMOTE", "canopy-drive")
FOLDER = "Under_The_Canopy_NASA_Space_App_Challenge_Notebooks"
FEATURED = ("water/sylhet.ipynb", "under_the_canopy_notebook.ipynb")
RCLONE = shutil.which("rclone") or str(Path.home() / ".local" / "bin" / "rclone")


def rclone(*args: str, capture: bool = False) -> str:
    res = subprocess.run([RCLONE, *args], check=True, text=True, capture_output=capture)
    return res.stdout if capture else ""


def main() -> None:
    index_file = BUILD / "index.json"
    if not index_file.exists():
        sys.exit(
            "No notebooks built yet: run python notebooks/build_notebooks.py first."
        )
    if not Path(RCLONE).exists() and not shutil.which("rclone"):
        sys.exit("rclone not found: see https://rclone.org/install/")
    if f"{REMOTE}:" not in rclone("listremotes", capture=True).split():
        sys.exit(
            f"No Google Drive connection yet. Run once and approve in your browser:\n  {RCLONE} config create {REMOTE} drive scope=drive.file"
        )
    built = json.loads(index_file.read_text())
    unrun = [k for k, v in built.items() if not v.get("executed")]
    if unrun:
        sys.exit(
            f"These notebooks were built without running them; rebuild before publishing: {unrun}"
        )

    # Upload changed files only (rclone compares size and time) and replace them in place.
    rclone(
        "copy", str(BUILD), f"{REMOTE}:{FOLDER}", "--include", "*/*.ipynb", "--progress"
    )
    rclone("copyto", str(BUILD / FEATURED[0]), f"{REMOTE}:{FOLDER}/{FEATURED[1]}")
    files = {
        f["Path"]: f["ID"]
        for f in json.loads(
            rclone("lsjson", "-R", "--files-only", f"{REMOTE}:{FOLDER}", capture=True)
        )
    }

    def urls(path: str) -> dict:
        rclone(
            "link", f"{REMOTE}:{FOLDER}/{path}", capture=True
        )  # anyone with the link can view
        fid = files[path]
        return {
            "colab": f"https://colab.research.google.com/drive/{fid}",
            "download": f"https://drive.usercontent.google.com/download?id={fid}&export=download&confirm=t",
        }

    notebooks = {}
    for key, entry in sorted(built.items()):
        path = f"{key}.ipynb"
        if path not in files:
            print("not in Drive, skipped:", path)
            continue
        notebooks[key] = {
            "kind": entry["kind"],
            "id": entry["id"],
            "name": entry["name"],
            "bytes": entry["bytes"],
            "data": entry["data"],
            **urls(path),
        }
        print(f"{key:30} {notebooks[key]['colab']}")
    doc = {
        "schema_version": 1,
        "folder": FOLDER,
        "featured": {"key": FEATURED[0].removesuffix(".ipynb"), **urls(FEATURED[1])},
        "notebooks": notebooks,
    }
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    print(f"\n{len(notebooks)} notebooks published; wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
