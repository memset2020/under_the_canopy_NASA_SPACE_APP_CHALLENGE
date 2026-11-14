"""Read NISAR L2 GCOV granules (HDF5). Needs the `real` extra (h5py).

Every path and meaning below was checked against a real granule
(task P-03, docs/04 §2): NISAR_L2_PR_GCOV_031_141_A_014_4005_DHDH_A_20260927T231312_...
HHHH/HVHV are float32 linear γ⁰ with NaN fill, stored in 512×512 gzip chunks.
"""

from __future__ import annotations

import re
import warnings
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

import numpy as np

from . import geo

FREQ = "frequencyA"  # 10 m (40 MHz) or 20 m (20 MHz) posting; B is 80 m
GRID_GROUP = f"/science/LSAR/GCOV/grids/{FREQ}"
HH_PATH = f"{GRID_GROUP}/HHHH"
HV_PATH = f"{GRID_GROUP}/HVHV"
MASK_PATH = f"{GRID_GROUP}/mask"
X_PATH = f"{GRID_GROUP}/xCoordinates"
Y_PATH = f"{GRID_GROUP}/yCoordinates"
PROJ_PATH = f"{GRID_GROUP}/projection"  # EPSG code stored as the dataset value
TRACK_PATH = "/science/LSAR/identification/trackNumber"
DIRECTION_PATH = "/science/LSAR/identification/orbitPassDirection"
START_PATH = "/science/LSAR/identification/zeroDopplerStartTime"
# mask: subswath number where valid; 0 = a partially focused or invalid sample in the
# averaging set; 255 = outside the acquisition (from the dataset's own description).
MASK_INVALID = 0
MASK_FILL = 255
# Polarisation modes that carry both HH and HV (DH = dual H, QP = quad).
HV_MODES = ("DH", "QP")

# NISAR_IL_PT_GCOV_CYL_REL_P_FRM_MODE_POLE_S_StartDateTime_EndDateTime_CRID_A_C_LOC_CTR.EXT
NAME_RE = re.compile(
    r"NISAR_(?P<il>\w\w)_(?P<pt>\w\w)_GCOV_(?P<cycle>\d{3})_(?P<track>\d{3})_(?P<dir>[AD])_"
    r"(?P<frame>\d{3})_(?P<mode>\d{4})_(?P<pole>[A-Z]{4})_\w+?_"
    r"(?P<start>\d{8}T\d{6})_(?P<end>\d{8}T\d{6})"
)


@dataclass(frozen=True)
class GranuleName:
    track: int
    direction: str
    frame: int
    start: datetime
    mode: str = ""  # bandwidth code, e.g. 4005 (40 + 5 MHz) or 2005
    pole: str = ""  # polarisation per frequency, e.g. DHDH

    @property
    def day(self) -> date:
        return self.start.date()

    @property
    def has_hv(self) -> bool:
        return self.pole[:2] in HV_MODES

    @property
    def group(self) -> tuple:
        """Passes are only comparable within one track, direction, bandwidth and polarisation."""
        return (self.track, self.direction, self.mode, self.pole)


def parse_name(path: Path | str) -> GranuleName | None:
    """Track, direction, frame and start time from the documented file-name pattern."""
    m = NAME_RE.search(Path(path).name)
    if not m:
        return None
    return GranuleName(
        track=int(m["track"]),
        direction="ascending" if m["dir"] == "A" else "descending",
        frame=int(m["frame"]),
        start=datetime.strptime(m["start"], "%Y%m%dT%H%M%S"),
        mode=m["mode"],
        pole=m["pole"],
    )


@dataclass
class Window:
    """HH/HV over a site, still on the granule's UTM grid."""

    path: Path
    hh: np.ndarray  # linear γ⁰, NaN where invalid
    hv: np.ndarray
    x: np.ndarray  # 1-D pixel-centre eastings of the window
    y: np.ndarray  # 1-D pixel-centre northings
    epsg: int
    track: int | None
    direction: str
    day: date | None


def _h5py():
    try:
        import h5py
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise SystemExit("h5py is missing: pip install -e .[real]") from exc
    return h5py


def _dataset(f: Any, path: str) -> Any:
    ds = f[path]
    if not hasattr(ds, "shape"):
        raise TypeError(f"{path} is not a dataset")
    return ds


def _scalar(f: Any, path: str):
    if path not in f:
        return None
    v = _dataset(f, path)[()]
    if isinstance(v, np.ndarray) and v.shape:
        v = v.ravel()[0]
    return v.decode() if isinstance(v, bytes) else v


def inspect(path: Path) -> list[str]:
    """List every dataset with shape and dtype, the first step of P-03."""
    h5py = _h5py()
    lines: list[str] = []
    with h5py.File(path, "r") as f:

        def visit(name, obj):
            if isinstance(obj, h5py.Dataset):
                lines.append(f"/{name}  shape={obj.shape}  dtype={obj.dtype}")

        f.visititems(visit)
        if MASK_PATH in f:
            vals, counts = np.unique(_dataset(f, MASK_PATH)[::16, ::16], return_counts=True)
            sample = dict(zip(vals.tolist(), counts.tolist(), strict=True))
            lines.append(f"mask values (1/256 sample): {sample}")
    return lines


def _slice_for(coords: np.ndarray, lo: float, hi: float, pad: int = 3) -> slice:
    """Index range of coordinates within [lo, hi], for ascending or descending axes."""
    inside = np.flatnonzero((coords >= lo) & (coords <= hi))
    if inside.size == 0:
        return slice(0, 0)
    return slice(max(int(inside[0]) - pad, 0), min(int(inside[-1]) + pad + 1, coords.size))


# Above this, windows are averaged k × k while read. Every flood site and belt cell is under
# 2.8 M pixels (read exactly as before); the 60 × 100 km fire box at 10 m is 61 M (k = 4).
MAX_WINDOW_PX = 5_000_000


def looks_for(n_pixels: int, max_pixels: int = MAX_WINDOW_PX) -> int:
    """Block size that brings a window under max_pixels (1 = read as is)."""
    return max(1, int(np.ceil(np.sqrt(n_pixels / max_pixels))))


def _looked(ds, rows: slice, cols: slice, k: int, mask_ds=None) -> np.ndarray:
    """A dataset window averaged over k × k blocks, read in strips so a 60 × 100 km box at 10 m
    never sits in memory whole; invalid samples (≤ 0, NaN, masked) are left out of each mean."""
    nr = (rows.stop - rows.start) // k
    nc = (cols.stop - cols.start) // k
    out = np.full((nr, nc), np.nan, dtype=np.float32)
    strip = max(1, 2048 // k)
    for b0 in range(0, nr, strip):
        b1 = min(nr, b0 + strip)
        r0, r1 = rows.start + b0 * k, rows.start + b1 * k
        a = np.asarray(ds[r0:r1, cols.start : cols.start + nc * k], dtype=np.float32)
        bad = ~np.isfinite(a) | (a <= 0)
        if mask_ds is not None:
            m = np.asarray(mask_ds[r0:r1, cols.start : cols.start + nc * k])
            bad |= (m == MASK_INVALID) | (m == MASK_FILL)
        a[bad] = np.nan
        with np.errstate(invalid="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            out[b0:b1] = np.nanmean(a.reshape(b1 - b0, k, nc, k), axis=(1, 3))
    return out


def read_window(
    path: Path, bounds: tuple[float, float, float, float], fileobj: Any = None, full: bool = False
) -> Window | None:
    """Read only the part of a granule covering the site; None if it doesn't overlap.

    `fileobj` lets this read a remote granule (an fsspec/earthaccess file) by range
    requests; with 512×512 chunks a 16 km site costs ~25 MB instead of 7 GB. Windows larger
    than MAX_WINDOW_PX are averaged k × k while read (`full` reads them as they are, for
    writing a faithful subset); every site box before the fire site stays below it.
    """
    h5py = _h5py()
    name = parse_name(path)
    with h5py.File(fileobj if fileobj is not None else path, "r") as f:
        epsg = int(np.asarray(_dataset(f, PROJ_PATH)[()]).ravel()[0])
        x_all = np.asarray(_dataset(f, X_PATH)[()], dtype=float)
        y_all = np.asarray(_dataset(f, Y_PATH)[()], dtype=float)
        xmin, ymin, xmax, ymax = geo.utm_bounds_of(bounds, epsg)
        cols = _slice_for(x_all, xmin, xmax)
        rows = _slice_for(y_all, ymin, ymax)
        if cols.stop - cols.start == 0 or rows.stop - rows.start == 0:
            return None
        k = 1 if full else looks_for((rows.stop - rows.start) * (cols.stop - cols.start))
        if k > 1:
            mask_ds = _dataset(f, MASK_PATH) if MASK_PATH in f else None
            hh = _looked(_dataset(f, HH_PATH), rows, cols, k, mask_ds)
            hv = _looked(_dataset(f, HV_PATH), rows, cols, k, mask_ds)
            nr, nc = hh.shape
            xs = x_all[cols][: nc * k].reshape(nc, k).mean(axis=1)
            ys = y_all[rows][: nr * k].reshape(nr, k).mean(axis=1)
            track = _scalar(f, TRACK_PATH)
            direction = _scalar(f, DIRECTION_PATH)
            start = _scalar(f, START_PATH)
            return _window(path, name, hh, hv, xs, ys, epsg, track, direction, start)
        hh = np.asarray(_dataset(f, HH_PATH)[rows, cols], dtype=np.float64)
        hv = np.asarray(_dataset(f, HV_PATH)[rows, cols], dtype=np.float64)
        bad = ~np.isfinite(hh) | ~np.isfinite(hv) | (hh <= 0) | (hv <= 0)
        if MASK_PATH in f:
            mask = np.asarray(_dataset(f, MASK_PATH)[rows, cols])
            bad |= (mask == MASK_INVALID) | (mask == MASK_FILL)
        hh[bad] = np.nan
        hv[bad] = np.nan
        track = _scalar(f, TRACK_PATH)
        direction = _scalar(f, DIRECTION_PATH)
        start = _scalar(f, START_PATH)

    return _window(path, name, hh, hv, x_all[cols], y_all[rows], epsg, track, direction, start)


def _window(path, name, hh, hv, x, y, epsg, track, direction, start) -> Window:
    day = name.day if name else None
    if day is None and start:
        day = datetime.fromisoformat(str(start)[:19]).date()
    return Window(
        path=path,
        hh=hh,
        hv=hv,
        x=x,
        y=y,
        epsg=epsg,
        track=name.track if name else (None if track is None else int(track)),
        direction=name.direction if name else str(direction or "unknown").lower(),
        day=day,
    )


COVER_CELLS = 64  # coarse grid over the site box for "how much of it has radar"


def coverage_mask(
    w: Window, bounds: tuple[float, float, float, float], n: int = COVER_CELLS
) -> np.ndarray:
    """Cells of an n × n grid over the site box that hold valid radar from this window.

    A union over all frames of a date says how much of the box the date imaged. Summing per-frame
    shares instead counts the overlap between frames twice, and windows are padded past the box,
    so a date with 14 % of the box empty could pass as complete (D-064).
    """
    ok = np.isfinite(w.hh) & np.isfinite(w.hv)
    step = max(1, min(ok.shape) // (3 * n))  # about three samples per cell keeps every cell hit
    rows, cols = np.nonzero(ok[::step, ::step])
    mask = np.zeros(n * n, dtype=bool)
    if rows.size:
        lon, lat = geo.utm_to_lonlat(w.x[::step][cols], w.y[::step][rows], w.epsg)
        idx = geo.target_index(lon, lat, bounds, n, n)
        mask[idx[idx >= 0]] = True
    return mask.reshape(n, n)


def write_subset(w: Window, out: Path) -> Path:
    """Save a site window in the GCOV layout, so the build reads it like a full granule."""
    h5py = _h5py()
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".part")
    opts = {"compression": "gzip", "compression_opts": 4, "shuffle": True}
    with h5py.File(tmp, "w") as f:
        f.create_dataset(HH_PATH, data=w.hh.astype(np.float32), **opts)
        f.create_dataset(HV_PATH, data=w.hv.astype(np.float32), **opts)
        f[X_PATH] = w.x
        f[Y_PATH] = w.y
        f[PROJ_PATH] = np.uint32(w.epsg)
        if w.track is not None:
            f[TRACK_PATH] = np.uint32(w.track)
        f[DIRECTION_PATH] = w.direction.capitalize().encode()
        f.attrs["subset_of"] = w.path.name
        f.attrs["note"] = "Site window of a NISAR L2 GCOV granule; invalid samples already NaN."
    tmp.replace(out)
    return out
