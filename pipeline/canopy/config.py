"""Thresholds, class codes, colours and paths shared by every pipeline stage."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, fields
from pathlib import Path

PIPELINE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = PIPELINE_DIR.parent
WEB_DATA_DIR = REPO_ROOT / "web" / "data"  # real sites (committed for releases)
WEB_SYNTH_DIR = REPO_ROOT / "web" / "data-synthetic"  # tests and demo; regenerated
SITES_FILE = PIPELINE_DIR / "config" / "sites.json"
# Places built with "analyse here" (serve.py); git-ignored, merged into the site list.
LOCAL_SITES_FILE = PIPELINE_DIR / "config" / "sites.local.json"
RAW_DIR = PIPELINE_DIR / "data" / "raw"

# Class codes (docs/04 §4.2). web/src/rules.js uses the same numbers.
NODATA, DRY, OPEN_WATER, FLOODED_VEG, EXCLUDED = 0, 1, 2, 3, 4

# veg codes (docs/04 §4.1)
VEG_OTHER, VEG_YES, VEG_BUILT_UP = 0, 1, 2

# ESA WorldCover classes that can hide water under a canopy, and the built-up class.
WORLDCOVER_VEG = (10, 20, 90, 95)
WORLDCOVER_BUILT_UP = 50

# Quantisation (docs/04 §3.7). 0.25 dB is exact in binary, which makes
# Python/JS comparisons bit-identical.
Q_STEP_DB = 0.25
Q_OFFSET_DB = -50.0

CBAND_MATCH_DAYS = 6
NOMINAL_REPEAT_DAYS = 12
EXPOSURE_BUFFER_M = 1000.0


@dataclass(frozen=True)
class Thresholds:
    """Classification thresholds in dB (docs/04 §4.3; changes need a docs/10 line)."""

    ow_hh_db: float = -16.0
    ow_hv_db: float = -22.0
    fv_hh_db: float = -5.0
    fv_ratio_db: float = 7.0
    margin_db: float = 1.0
    max_spread_db: float = 3.0

    def __post_init__(self) -> None:
        for f in fields(self):
            value = getattr(self, f.name)
            if (value / Q_STEP_DB) % 1 != 0:
                raise ValueError(f"{f.name}={value} is not a multiple of {Q_STEP_DB} dB")

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


# Colour tokens (docs/06). Okabe-Ito based so the classes stay distinct with
# colour-vision deficiency: blue water vs amber hidden flood.
PALETTE_RGBA: dict[int, tuple[int, int, int, int]] = {
    NODATA: (0, 0, 0, 0),
    DRY: (0, 0, 0, 0),
    OPEN_WATER: (0, 114, 178, 220),
    FLOODED_VEG: (230, 159, 0, 235),
    EXCLUDED: (120, 120, 120, 110),
}
CBAND_WATER_RGBA = (86, 180, 233, 220)

# Sequential ramp for hydroperiod days (light = brief, dark = long).
# Light blue to deep purple: amber is reserved for water hidden under trees (docs/10 D-061).
HYDRO_RAMP: list[tuple[int, int, int]] = [
    (198, 219, 239),
    (158, 202, 225),
    (107, 174, 214),
    (106, 81, 163),
    (63, 0, 125),
]


def load_sites(path: Path = SITES_FILE) -> list[dict]:
    """Return the site list from config/sites.json, plus any "analyse here" sites."""
    with path.open(encoding="utf-8") as fh:
        sites = json.load(fh)["sites"]
    if path == SITES_FILE and LOCAL_SITES_FILE.is_file():
        with LOCAL_SITES_FILE.open(encoding="utf-8") as fh:
            sites += json.load(fh)["sites"]
    return sites


def get_site(site_id: str, path: Path = SITES_FILE) -> dict:
    for site in load_sites(path):
        if site["id"] == site_id:
            return site
    raise KeyError(f"unknown site {site_id!r}; see {path}")
