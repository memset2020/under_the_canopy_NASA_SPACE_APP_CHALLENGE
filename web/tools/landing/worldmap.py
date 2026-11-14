"""World map for the landing page's "Where it works" section (docs/10 D-084).

    python3 tools/landing/worldmap.py        # writes media/world.png and media/world.json

Land, forest cover and the World mode's screening of forests that flood (global.json
`likely_rule`), from the published global grid (web/data/global), so the map behind the site
dots is the app's own data. numpy only; ImageMagick's `convert` packs the PNG to a palette.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy as np

WEB = Path(__file__).resolve().parents[2]
LAT_TOP, LAT_BOTTOM = 72.0, -56.0  # inhabited land; the poles add nothing to this story

LAND = np.array([29, 45, 51], float)
FOREST = np.array([47, 78, 64], float)
AMBER = np.array([230, 159, 0], float)


def main() -> None:
    meta = json.loads((WEB / "data/global/global.json").read_text(encoding="utf-8"))
    ids = [layer["id"] for layer in meta["layers"]]
    gw, gh, res = meta["grid"]["width"], meta["grid"]["height"], meta["grid"]["res_deg"]
    raw = np.fromfile(WEB / "data/global" / meta["binary"], dtype=np.uint8).reshape(
        len(ids), gh, gw
    )

    def plane(name: str) -> np.ndarray:
        return raw[ids.index(name)]

    # The grid has no land mask: a cell is land if any land layer holds a value (as film.js).
    land = (
        (plane("people") != 255)
        | (plane("glwd_forested_pct") != 255)
        | (plane("nisar_first_day") != 255)
        | (plane("forest_pct") > 0)
    )
    forest = np.clip(plane("forest_pct").astype(float) / 100, 0, 1)
    likely = plane("likely")
    rgb = LAND + (FOREST - LAND) * forest[..., None]
    for cls, mix in ((1, 0.38), (2, 0.8)):
        m = likely == cls
        rgb[m] = rgb[m] + (AMBER - rgb[m]) * mix
    alpha = np.where(land, 255, 0)
    r0, r1 = int((90 - LAT_TOP) / res), int((90 - LAT_BOTTOM) / res)
    img = np.dstack([np.clip(rgb, 0, 255), alpha])[r0:r1].astype(np.uint8)
    h, w = img.shape[:2]

    out = WEB / "media"
    out.mkdir(exist_ok=True)
    pam = out / "world.pam"
    header = (
        f"P7\nWIDTH {w}\nHEIGHT {h}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n"
    )
    pam.write_bytes(header.encode() + img.tobytes())
    subprocess.run(
        ["convert", str(pam), "-colors", "64", str(out / "world.png")], check=True
    )
    pam.unlink()
    (out / "world.json").write_text(
        json.dumps(
            {"lat_top": LAT_TOP, "lat_bottom": LAT_BOTTOM, "width": w, "height": h},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"world map {w}×{h} → {out / 'world.png'}")


if __name__ == "__main__":
    main()
