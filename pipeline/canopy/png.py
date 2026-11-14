"""Minimal PNG encoder (stdlib zlib + struct) and the colour maps for overlays.

Keeps the pipeline core numpy-only (docs/10 D-003): no Pillow.
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

import numpy as np

from .config import CBAND_WATER_RGBA, HYDRO_RAMP, PALETTE_RGBA


def encode_png(rgba: np.ndarray) -> bytes:
    """Encode an (H, W, 3|4) uint8 array as PNG bytes."""
    arr = np.ascontiguousarray(rgba, dtype=np.uint8)
    if arr.ndim != 3 or arr.shape[2] not in (3, 4):
        raise ValueError(f"expected (H, W, 3|4), got {arr.shape}")
    h, w, ch = arr.shape
    colour_type = 6 if ch == 4 else 2
    raw = np.concatenate([np.zeros((h, 1), dtype=np.uint8), arr.reshape(h, w * ch)], axis=1)

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", w, h, 8, colour_type, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw.tobytes(), 9))
        + chunk(b"IEND", b"")
    )


def write_png(path: Path, rgba: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encode_png(rgba))


def decode_png(data: bytes) -> np.ndarray:
    """Decode a PNG written by encode_png (8-bit RGB/RGBA, filter 0 only) to (H, W, ch)."""
    i, idat, w, h, ch = 8, b"", 0, 0, 4
    while i < len(data):
        n, tag = struct.unpack(">I4s", data[i : i + 8])
        if tag == b"IHDR":
            w, h, _, colour_type = struct.unpack(">IIBB", data[i + 8 : i + 18])
            ch = 4 if colour_type == 6 else 3
        elif tag == b"IDAT":
            idat += data[i + 8 : i + 8 + n]
        i += 12 + n
    raw = np.frombuffer(zlib.decompress(idat), dtype=np.uint8).reshape(h, 1 + w * ch)
    if raw[:, 0].any():
        raise ValueError("only unfiltered PNGs from encode_png can be read")
    return raw[:, 1:].reshape(h, w, ch).copy()


NO_RADAR_RGBA = (205, 212, 214, 120)


def stripe_no_radar(rgba: np.ndarray, no_radar: np.ndarray) -> np.ndarray:
    """Light grey stripes where there was no radar, so a swath edge is not read as dry land."""
    out = rgba.copy()
    r, c = np.indices(no_radar.shape)
    paint = no_radar & ((r + c) % 6 < 2) & (out[..., 3] == 0)
    out[paint] = NO_RADAR_RGBA
    return out


def hatch_mask(shape: tuple[int, int]) -> np.ndarray:
    """Diagonal hatch for low-confidence pixels (docs/03 §4.5)."""
    r, c = np.indices(shape)
    return (r + c) % 4 < 2


def colour_classes(cls: np.ndarray, conf: np.ndarray) -> np.ndarray:
    lut = np.zeros((256, 4), dtype=np.uint8)
    for code, rgba in PALETTE_RGBA.items():
        lut[code] = rgba
    out = lut[cls]
    out[(conf == 0) & hatch_mask(cls.shape)] = 0
    return out


def colour_cband(cband: np.ndarray) -> np.ndarray:
    out = np.zeros((*cband.shape, 4), dtype=np.uint8)
    out[cband == 2] = CBAND_WATER_RGBA
    return out


def ramp_rgb(t: np.ndarray) -> np.ndarray:
    """Interpolate HYDRO_RAMP at t in [0, 1]."""
    stops = np.asarray(HYDRO_RAMP, dtype=float)
    x = np.clip(np.asarray(t, dtype=float), 0, 1) * (len(stops) - 1)
    i = np.minimum(np.floor(x).astype(int), len(stops) - 2)
    f = (x - i)[..., None]
    return stops[i] * (1 - f) + stops[i + 1] * f


def colour_hydroperiod(days: np.ndarray, max_days: int) -> np.ndarray:
    out = np.zeros((*days.shape, 4), dtype=np.uint8)
    on = days > 0
    if max_days > 0:
        out[on, :3] = ramp_rgb(days[on] / max_days).round().astype(np.uint8)
        out[on, 3] = 225
    return out


# v3 layers. Canopy: light → dark green; level change: brown (fall) ↔ blue (rise),
# a diverging scale that stays readable with colour-vision deficiency.
CANOPY_RAMP = [(237, 248, 233), (186, 228, 179), (116, 196, 118), (49, 163, 84), (0, 90, 50)]
LEVEL_FALL = (94, 60, 153)  # purple: brown read as amber next to the hidden-flood colour
LEVEL_RISE = (1, 133, 113)


def _ramp(stops, t):
    stops = np.asarray(stops, dtype=float)
    x = np.clip(np.asarray(t, dtype=float), 0, 1) * (len(stops) - 1)
    i = np.minimum(np.floor(x).astype(int), len(stops) - 2)
    f = (x - i)[..., None]
    return stops[i] * (1 - f) + stops[i + 1] * f


def colour_scalar(
    values: np.ndarray, vmax: float, ramp=CANOPY_RAMP, alpha: int = 220
) -> np.ndarray:
    out = np.zeros((*values.shape, 4), dtype=np.uint8)
    ok = np.isfinite(values)
    if vmax > 0 and ok.any():
        out[ok, :3] = _ramp(ramp, values[ok] / vmax).round().astype(np.uint8)
        out[ok, 3] = alpha
    return out


# Height above nearest drainage: one teal hue, strongest on the lowest ground (where floods
# reach) and clear by HAND_MAX_M; teal, not the open-water blue, because it is terrain.
HAND_RGB = (42, 157, 143)


def colour_hand(hand_m: np.ndarray, vmax_m: float) -> np.ndarray:
    out = np.zeros((*hand_m.shape, 4), dtype=np.uint8)
    ok = np.isfinite(hand_m)
    t = np.clip(hand_m[ok] / vmax_m, 0, 1)
    out[ok, :3] = HAND_RGB
    out[ok, 3] = np.round(235 * (1 - t) ** 0.8).astype(np.uint8)
    return out


def colour_level_change(dh_cm: np.ndarray, vmax_cm: float) -> np.ndarray:
    """Diverging map of water-level change; |dh| sets the strength, sign the hue."""
    out = np.zeros((*dh_cm.shape, 4), dtype=np.uint8)
    ok = np.isfinite(dh_cm)
    if not ok.any() or vmax_cm <= 0:
        return out
    k = np.clip(np.abs(dh_cm[ok]) / vmax_cm, 0, 1)[:, None]
    hue = np.where((dh_cm[ok] >= 0)[:, None], LEVEL_RISE, LEVEL_FALL)
    out[ok, :3] = (np.array([245, 245, 245]) * (1 - k) + hue * k).round().astype(np.uint8)
    out[ok, 3] = 230
    return out
