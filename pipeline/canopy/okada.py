"""Surface motion of a buried fault slip: Okada (1985) rectangular dislocations in an elastic
half-space, summed over the subfaults of a USGS finite-fault model.

This is the standard forward model of earthquake geodesy: a seismologists' slip model predicts the
ground motion, and the radar measures it. Okada, Y. (1985), Surface deformation due to shear and
tensile faults in a half-space, Bull. Seismol. Soc. Am. 75(4), 1135-1154. The code follows the
equations as written in F. Beauducel's okada85.m (2012) and reproduces Okada's own check list
(Table 2, case 2) to four digits (tests/test_okada.py). Poisson's ratio 0.25 (λ = μ), as in Okada's
table; USGS models use a layered crust, so amplitudes differ by a few per cent (D-082).
"""

from __future__ import annotations

import re

import numpy as np

from . import geo

EPS = 1e-12


def _atan(xi, eta, q, r):
    with np.errstate(divide="ignore", invalid="ignore"):
        out = np.arctan(xi * eta / (q * r))
    return np.where(np.abs(q) < EPS, 0.0, out)


def _i5(xi, eta, q, dip, a, r, db):
    c, s = np.cos(dip), np.sin(dip)
    if c > EPS:
        x = np.sqrt(xi**2 + q**2)
        with np.errstate(divide="ignore", invalid="ignore"):
            out = a * 2 / c * np.arctan((eta * (x + q * c) + x * (r + x) * s) / (xi * (r + x) * c))
        return np.where(np.abs(xi) < EPS, 0.0, out)
    return -a * xi * s / (r + db)


def _i4(db, eta, q, dip, a, r):
    c, s = np.cos(dip), np.sin(dip)
    if c > EPS:
        return a / c * (np.log(r + db) - s * np.log(r + eta))
    return -a * q / (r + db)


def _i3(eta, q, dip, a, r):
    c, s = np.cos(dip), np.sin(dip)
    yb = eta * c + q * s
    db = eta * s - q * c
    if c > EPS:
        return a * (yb / (c * (r + db)) - np.log(r + eta)) + s / c * _i4(db, eta, q, dip, a, r)
    return a / 2 * (eta / (r + db) + yb * q / (r + db) ** 2 - np.log(r + eta))


def _i1(xi, eta, q, dip, a, r):
    c, s = np.cos(dip), np.sin(dip)
    db = eta * s - q * c
    if c > EPS:
        return a * (-xi / (c * (r + db))) - s / c * _i5(xi, eta, q, dip, a, r, db)
    return -a / 2 * xi * q / (r + db) ** 2


def _strike_slip(xi, eta, q, dip, a):
    """Okada (1985) eq. 25."""
    c, s = np.cos(dip), np.sin(dip)
    r = np.sqrt(xi**2 + eta**2 + q**2)
    db = eta * s - q * c
    i2 = a * (-np.log(r + eta)) - _i3(eta, q, dip, a, r)
    ux = xi * q / (r * (r + eta)) + _atan(xi, eta, q, r) + _i1(xi, eta, q, dip, a, r) * s
    uy = (eta * c + q * s) * q / (r * (r + eta)) + q * c / (r + eta) + i2 * s
    uz = db * q / (r * (r + eta)) + q * s / (r + eta) + _i4(db, eta, q, dip, a, r) * s
    return ux, uy, uz


def _dip_slip(xi, eta, q, dip, a):
    """Okada (1985) eq. 26."""
    c, s = np.cos(dip), np.sin(dip)
    r = np.sqrt(xi**2 + eta**2 + q**2)
    db = eta * s - q * c
    ux = q / r - _i3(eta, q, dip, a, r) * s * c
    uy = (
        (eta * c + q * s) * q / (r * (r + xi))
        + c * _atan(xi, eta, q, r)
        - _i1(xi, eta, q, dip, a, r) * s * c
    )
    uz = db * q / (r * (r + xi)) + s * _atan(xi, eta, q, r) - _i5(xi, eta, q, dip, a, r, db) * s * c
    return ux, uy, uz


def _chinnery(f, x, p, length, width, q, dip, a):
    """f(ξ, η) evaluated at the four corners of the fault (Chinnery's notation)."""
    out = [np.zeros(np.shape(x)) for _ in range(3)]
    for xi, eta, sign in (
        (x, p, 1),
        (x, p - width, -1),
        (x - length, p, -1),
        (x - length, p - width, 1),
    ):
        for k, v in enumerate(f(xi, eta, q, dip, a)):
            out[k] = out[k] + sign * v
    return out


def okada_xy(x, y, depth_bottom, dip_deg, length, width, u_strike, u_dip, nu: float = 0.25):
    """Surface motion in Okada's own frame: x along strike, the fault from x = 0 to `length`, its
    lower edge at depth `depth_bottom` under the line y = 0 (Okada 1985, Fig. 1)."""
    dip = np.radians(dip_deg)
    a = 1 - 2 * nu  # μ / (λ + μ)
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    p = y * np.cos(dip) + depth_bottom * np.sin(dip)
    q = y * np.sin(dip) - depth_bottom * np.cos(dip)
    ss = _chinnery(_strike_slip, x, p, length, width, q, dip, a) if u_strike else None
    ds = _chinnery(_dip_slip, x, p, length, width, q, dip, a) if u_dip else None
    out = []
    for k in range(3):
        v = np.zeros(np.shape(x))
        if ss is not None:
            v = v - u_strike / (2 * np.pi) * ss[k]
        if ds is not None:
            v = v - u_dip / (2 * np.pi) * ds[k]
        out.append(v)
    return out


def okada_enu(
    east, north, depth_centre, strike_deg, dip_deg, length, width, rake_deg, slip, nu=0.25
):
    """East, north and up motion at points (east, north) measured from the centre of a
    rectangular patch (all lengths in one unit; Aki-Richards strike, dip to the right of strike,
    rake 180 = right-lateral)."""
    st, dp, rk = np.radians([strike_deg, dip_deg, rake_deg])
    d = depth_centre + np.sin(dp) * width / 2
    ec = np.asarray(east, dtype=float) + np.cos(st) * np.cos(dp) * width / 2
    nc = np.asarray(north, dtype=float) - np.sin(st) * np.cos(dp) * width / 2
    x = np.cos(st) * nc + np.sin(st) * ec + length / 2
    y = np.sin(st) * nc - np.cos(st) * ec + np.cos(dp) * width
    ux, uy, uz = okada_xy(x, y, d, dip_deg, length, width, np.cos(rk) * slip, np.sin(rk) * slip, nu)
    return np.sin(st) * ux - np.cos(st) * uy, np.cos(st) * ux + np.sin(st) * uy, uz


# ---------------------------------------------------------------- USGS finite-fault models


def parse_fsp(text: str) -> list[dict]:
    """Subfaults of a USGS finite-fault model in the SRCMOD .fsp format: centre lat/lon, depth of
    the centre (km), slip (m), rake, and the segment's strike, dip and subfault size (km)."""
    patches: list[dict] = []
    seg: dict | None = None
    for line in text.splitlines():
        if line.startswith("%"):
            m = re.search(r"SEGMENT # (\d+): STRIKE = ([\d.]+) deg DIP = ([\d.]+)", line)
            if m:
                seg = {"segment": int(m[1]), "strike": float(m[2]), "dip": float(m[3])}
            m = re.search(r"Dx = ([\d.]+) km\s+Dz = ([\d.]+) km", line)
            if m and seg is not None:
                seg["dx_km"], seg["dz_km"] = float(m[1]), float(m[2])
            continue
        v = line.split()
        if len(v) >= 7 and seg is not None and "dx_km" in seg:
            lat, lon, _x, _y, z, slip, rake = (float(t) for t in v[:7])
            p = dict(seg, lat=lat, lon=lon, depth_km=z, slip_m=slip, rake=rake)
            if len(v) >= 10:
                # Rupture time and rise time (s) and the subfault's seismic moment (N m).
                p.update(trup_s=float(v[7]), rise_s=float(v[8]), moment_nm=float(v[9]))
            patches.append(p)
    return patches


def fsp_header(text: str) -> dict:
    """Magnitude and moment from an .fsp header."""
    m = re.search(r"Mw = ([\d.]+)\s+Mo = ([\d.eE+]+)", text)
    return {"mw": float(m[1]), "moment_nm": float(m[2])} if m else {}


def utm_epsg(lon: float, lat: float) -> int:
    zone = int((lon + 180) // 6) + 1
    return (32600 if lat >= 0 else 32700) + zone


def patches_enu(patches: list[dict], lon, lat, nu: float = 0.25):
    """East, north and up (m) at lon/lat points from every subfault, in a UTM plane."""
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    epsg = utm_epsg(float(np.mean(lon)), float(np.mean(lat)))
    x, y = geo.lonlat_to_utm(lon, lat, epsg)
    e, n, u = np.zeros(lon.shape), np.zeros(lon.shape), np.zeros(lon.shape)
    for p in patches:
        if p["slip_m"] <= 0:
            continue
        px, py = geo.lonlat_to_utm(np.array(p["lon"]), np.array(p["lat"]), epsg)
        de, dn, du = okada_enu(
            (x - px) / 1000,
            (y - py) / 1000,
            p["depth_km"],
            p["strike"],
            p["dip"],
            p["dx_km"],
            p["dz_km"],
            p["rake"],
            p["slip_m"],
            nu,
        )
        e += de
        n += dn
        u += du
    return e, n, u


def patch_outline(p: dict) -> list[list[float]]:
    """The map outline (lon, lat) of a subfault: its four corners projected to the surface."""
    epsg = utm_epsg(p["lon"], p["lat"])
    cx, cy = geo.lonlat_to_utm(np.array(p["lon"]), np.array(p["lat"]), epsg)
    st, dp = np.radians(p["strike"]), np.radians(p["dip"])
    along = np.array([np.sin(st), np.cos(st)]) * p["dx_km"] * 500  # half length, m
    down = np.array([np.sin(st + np.pi / 2), np.cos(st + np.pi / 2)])
    down = down * np.cos(dp) * p["dz_km"] * 500
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    xs = np.array([float(cx) + a * along[0] + b * down[0] for a, b in corners])
    ys = np.array([float(cy) + a * along[1] + b * down[1] for a, b in corners])
    lon, lat = geo.utm_to_lonlat(xs, ys, epsg)
    return [[round(float(o), 4), round(float(a), 4)] for o, a in zip(lon, lat, strict=True)]


def top_trace(patches: list[dict]) -> list[list[list[float]]]:
    """Per segment, the line along the top edge of its shallowest row of subfaults (lon, lat):
    where the modelled fault comes closest to the surface."""
    out = []
    for seg in sorted({p["segment"] for p in patches}):
        ps = [p for p in patches if p["segment"] == seg]
        top = min(p["depth_km"] for p in ps)
        row = [p for p in ps if abs(p["depth_km"] - top) < 0.5]
        st = np.radians(row[0]["strike"])
        dp = np.radians(row[0]["dip"])
        epsg = utm_epsg(row[0]["lon"], row[0]["lat"])
        pts = []
        for p in row:
            x, y = geo.lonlat_to_utm(np.array(p["lon"]), np.array(p["lat"]), epsg)
            # From the subfault centre up-dip by half its width.
            back = -np.cos(dp) * p["dz_km"] * 500
            pts.append(
                (float(x) + back * np.sin(st + np.pi / 2), float(y) + back * np.cos(st + np.pi / 2))
            )
        s_hat = np.array([np.sin(st), np.cos(st)])
        pts.sort(key=lambda q: q[0] * s_hat[0] + q[1] * s_hat[1])
        half = row[0]["dx_km"] * 500
        ends = [
            (pts[0][0] - half * s_hat[0], pts[0][1] - half * s_hat[1]),
            (pts[-1][0] + half * s_hat[0], pts[-1][1] + half * s_hat[1]),
        ]
        line = [ends[0], *pts, ends[1]]
        lon, lat = geo.utm_to_lonlat(
            np.array([q[0] for q in line]), np.array([q[1] for q in line]), epsg
        )
        out.append(
            [[round(float(o), 4), round(float(a), 4)] for o, a in zip(lon, lat, strict=True)]
        )
    return out


# ---------------------------------------------------------------- the rupture in time


def slip_share(t_s: float, trup_s: float, rise_s: float) -> float:
    """Share of a subfault's final slip reached at time t: nothing before its rupture time, then
    a cosine ramp over its rise time (the shape of the slip-velocity functions USGS fits, a
    smooth start and stop), all of it after."""
    if t_s <= trup_s:
        return 0.0
    if t_s >= trup_s + max(rise_s, 1e-6):
        return 1.0
    return 0.5 * (1 - np.cos(np.pi * (t_s - trup_s) / rise_s))


def rupture_frames(patches: list[dict], lon, lat, times_s, nu: float = 0.25):
    """East, north and up (m) at lon/lat points at each time of the rupture, with the moment
    released in each step (N m): each subfault's static Okada displacement scaled by how much
    of its slip it has reached. A kinematic picture of the static field growing, not the
    seismic waves (the ground shakes far more, briefly, while they pass)."""
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    frames = np.zeros((len(times_s), 3, *lon.shape), dtype=np.float32)
    released = np.zeros(len(times_s))
    for p in patches:
        if p["slip_m"] <= 0 or "trup_s" not in p:
            continue
        g = np.stack(patches_enu([p], lon, lat, nu)).astype(np.float32)
        prev = 0.0
        for k, t in enumerate(times_s):
            f = slip_share(t, p["trup_s"], p["rise_s"])
            if f > 0:
                frames[k] += f * g
            released[k] += (f - prev) * p.get("moment_nm", 0.0)
            prev = f
    return frames, released
