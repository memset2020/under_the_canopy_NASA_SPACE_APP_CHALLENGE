"""The one in-memory shape passed between pipeline stages."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime

import numpy as np


@dataclass
class Gauge:
    id: str
    name: str
    source: str
    daily: list[tuple[date, float]]  # (date, stage_m)
    units: str = "m"


@dataclass
class Exposure:
    population: np.ndarray  # (H, W) people per pixel
    places: list[dict]  # {name, lon, lat, population}
    roads: list[dict]  # {name, highway, coords: [[lon, lat], ...]}


@dataclass
class OpticalObs:
    """One optical water map (OPERA DSWx-HLS) matched to a NISAR pass."""

    day: date
    water: np.ndarray  # (H, W) bool, water seen by the optical sensor
    clear: np.ndarray  # (H, W) bool, not cloud / shadow / fill


@dataclass
class LevelChange:
    """Water-level change between two passes from NISAR GUNW, on the web grid."""

    start: date
    end: date
    dh_cm: np.ndarray | None = None  # (H, W) cm, NaN where not measured; None = derive from phase
    coherent_share: float = 0.0
    phase_rad: np.ndarray | None = None  # ionosphere-corrected unwrapped phase on the web grid
    coherence: np.ndarray | None = None
    wavelength_m: float = 0.242
    incidence_deg: float = 37.0


@dataclass
class Context:
    """Daily drivers and independent signals (docs/03 §4.3 `context`)."""

    rain_daily: list[tuple[date, float]] = field(default_factory=list)
    rain_source: str | None = None
    inundation_daily: list[tuple[date, float]] = field(default_factory=list)
    inundation_source: str | None = None
    soil_moisture: list[tuple[date, float]] = field(default_factory=list)
    soil_moisture_source: str | None = None
    # v9: monthly basin water-storage anomaly (cm of water vs 2004–2009), GRACE/GRACE-FO.
    water_storage_monthly: list[tuple[date, float]] = field(default_factory=list)
    water_storage_source: str | None = None


@dataclass
class Scene:
    """Analysis-ready inputs for one site, already on the web grid.

    hh_db, hv_db, spread_db: (P, H, W) float, NaN = nodata.
    cband: (P, H, W) uint8 (0 no data, 1 not water, 2 water) or None.
    veg: (H, W) uint8 with docs/04 §4.1 codes.
    """

    site: dict
    bounds: tuple[float, float, float, float]  # west, south, east, north
    dates: list[date]
    hh_db: np.ndarray
    hv_db: np.ndarray
    spread_db: np.ndarray
    veg: np.ndarray
    synthetic: bool
    track_number: int | None = None
    direction: str = "unknown"
    cband: np.ndarray | None = None
    cband_dates: list[date | None] | None = None
    # v11: earliest granule start time (UTC) of each pass date, from the granule name.
    acquired: list[datetime | None] | None = None
    gauge: Gauge | None = None
    exposure: Exposure | None = None
    optical_rgb: np.ndarray | None = None  # (H, W, 3|4) uint8; alpha 0 = outside the scene
    optical_cloud: float | None = None  # share of covered pixels flagged cloud/shadow
    optical_date: date | None = None
    optical_obs: list[OpticalObs | None] | None = None  # per pass
    canopy_cover_pct: np.ndarray | None = None  # (H, W) float, NaN = no GEDI data
    canopy_height_m: np.ndarray | None = None
    canopy_source: str | None = None
    terrain_gate: np.ndarray | None = None  # (H, W) bool, True = high ground
    hand_m: np.ndarray | None = None  # (H, W) float, height above nearest drainage (v11)
    glwd_class: np.ndarray | None = None  # (H, W) uint8 GLWD v2 class, 255 = none (v11)
    river: dict | None = None  # GEOGloWS main river: flows and 15-day forecast (v11, outlook.py)
    # v14: burned-area references on the grid (burn.load_refs): product, source, doy (burn day,
    # 0 unburned, NaN unmapped) and months; and VIIRS active-fire detections (active_fire.load).
    burn_refs: list[dict] = field(default_factory=list)
    active_fire: dict | None = None
    # The burn map's own finer grid (burn.FINE_PIXEL_M, D-088): hh_db, hv_db (P, h, w), veg,
    # canopy_height_m, area (km² per cell) and refs on it; None keeps the burn on the site grid.
    burn_fine: dict | None = None
    terrain_source: str | None = None
    terrain_rule: str | None = None
    level_changes: list[LevelChange] = field(default_factory=list)
    context: Context = field(default_factory=Context)
    swot: list[dict] = field(default_factory=list)  # {id, name, kind, series: [(date, wse_m)]}
    icesat2: list[dict] = field(default_factory=list)  # v9, same shape as swot
    jrc_occurrence: np.ndarray | None = None  # v9 (H, W) % of 1984–2021 that was water
    rtc_vv_db: np.ndarray | None = None  # (P, H, W) C-band VV dB matched to each pass, NaN = none
    rtc_vh_db: np.ndarray | None = None
    rtc_dates: list[date | None] | None = None
    reference_cls: np.ndarray | None = None  # (H, W) 0 unknown, 1 dry, 2 open water, 3 flooded veg
    reference_name: str | None = None
    reference_period: str | None = None
    grdi: np.ndarray | None = None  # (H, W) SEDAC relative deprivation 0–100, NaN = none
    # D-101: (P, H, W) bool, True where the pass's own track had no radar and another track's
    # pass filled in; per pass {track, direction, date, days_apart, share, offset_*_db} or None.
    fill_mask: np.ndarray | None = None
    fill: list[dict | None] | None = None
    warnings: list[dict] = field(default_factory=list)
    sources: list[dict] = field(default_factory=list)

    @property
    def shape(self) -> tuple[int, int]:
        return self.veg.shape

    def warn(self, code: str, detail: str = "") -> None:
        self.warnings.append({"code": code, "detail": detail})
