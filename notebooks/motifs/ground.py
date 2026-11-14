"""Ground that moved: the notebook motif for the Ground events (earthquake and subsidence).

Reads web/data/motion/<id>/motion.json and motion.bin.gz (int16 planes, gzip; motion.py), checks
the decode against the published headline, and follows the app's own checks: the control pair
before the quake, JPL's processing of the same pairs, the USGS fault model forward-modelled with
Okada (1985), GNSS stations. The east/up split is recomputed from the line-of-sight maps by least
squares (Wright et al. 2004) and compared with the published one.
"""

from __future__ import annotations

import json

from .common import WEB_DATA, Notebook, references, setup_cell, title_block


def files(event_id: str) -> list[str]:
    out = [
        f"web/data/motion/{event_id}/{f}"
        for f in ("motion.json", "motion.bin.gz", "rupture.bin.gz")
    ]
    return [f for f in out if (WEB_DATA.parent.parent / f).exists()]


def build(event_id: str) -> Notebook:
    m = json.loads((WEB_DATA / "motion" / event_id / "motion.json").read_text())
    quake = m["kind"] == "earthquake"
    nb = Notebook({"EVENT": event_id})
    has_rupture = (WEB_DATA / "motion" / event_id / "rupture.bin.gz").exists() and bool(
        m.get("rupture")
    )
    has_gnss = bool(m.get("gnss"))
    has_model = bool(m.get("model"))

    if quake:
        title_block(
            nb,
            f"Ground that moved: {m['name']}",
            "Measuring an earthquake from orbit with NISAR radar interferometry, and testing the measurement",
            "ground · earthquake",
        )
        intro = f"""
On {m["quakes"][0]["utc"][:10] if m.get("quakes") else "the day of the event"} the ground in **{m["name"].split(",")[0]}** jumped. Seismometers record how
the ground *shook*; radar satellites can measure how far it *moved*, everywhere at once, to centimetres. This
notebook uses NISAR's real interferograms of this event to map the motion, split it into east-west and up-down,
and test it against three independent witnesses: NASA JPL's own processing of the same radar pairs, the USGS
model of the fault, and the radar's own measurement before the quake.

| Chapters | Question |
|:--|:--|
| 1–2 | What happened, who looked, and how can radar measure centimetres from 747 km up? |
| 3–4 | What did each radar track see? How big is the noise? |
| 5 | Which way did the ground move: east-west and up-down from four viewing directions |
| 6–7 | Do JPL's processing and the USGS fault model agree, and where don't they? |
| 8–9 | Profiles across the fault, and the rupture second by second |
| last | Limits, and what you could study next |
"""
    else:
        title_block(
            nb,
            f"Ground that moved: {m['name']}",
            "Measuring a sinking city from orbit with NISAR radar interferometry, checked against GPS",
            "ground · subsidence",
        )
        intro = f"""
Some cities sink: when groundwater is pumped from soft clay faster than it refills, the clay compacts and the
ground above it drops, slowly but relentlessly, cracking pipes, buildings and streets. Mexico City is the
textbook case, sinking faster than 30 cm a year in places (Chaussard et al. 2014). This notebook uses NISAR's
real interferograms of **{m["name"].split(",")[0]}** to measure how fast each place sinks, and tests the result
against GPS stations that measure the same motion on the ground every day.

| Chapters | Question |
|:--|:--|
| 1–2 | Where is it, who looked, and how can radar measure centimetres from 747 km up? |
| 3–4 | What did each radar track see, and how uncertain is each pixel? |
| 5 | Up-down and east-west from two viewing directions |
| 6 | Does GPS on the ground agree? |
| 7–8 | Profiles across the basin, and the sinking month by month |
| last | Limits, and what you could study next |
"""
    nb.md(
        intro
        + "\n**Real data only.** Every number is read from the project's published files, and the decode is checked against the app."
    )
    nb.md("""
## 0 · Setting up

Run the cells in order (*Runtime → Run all* in Colab). The first, folded cell unpacks the published data.
Motion maps use a **diverging** colour map centred on zero (blue one way, red the other), because motion has a
sign; magnitudes and coherence use perceptually uniform maps, never a rainbow (Crameri et al. 2020).
""")
    setup_cell(
        nb, [f"motion/{event_id}/motion.json", f"motion/{event_id}/motion.bin.gz"]
    )

    # 1 -------------------------------------------------------------------------------------------
    nb.md("""
## 1 · The event, and who looked

NISAR looks sideways, and on each orbit it sees a place from one direction: **ascending** passes (flying north)
look east, **descending** passes (flying south) look west. Several tracks of the same place give several
viewing directions, which Chapter 5 combines.
""")
    nb.code(r'''
EVENT = "@@EVENT@@"
doc = json.loads((DATA / "motion" / EVENT / "motion.json").read_text())
W, H = doc["grid"]["width"], doc["grid"]["height"]
west, south, east, north = BOUNDS = doc["grid"]["bounds"]
extent = (west, east, south, north)
raw = np.frombuffer(gzip.decompress((DATA / "motion" / EVENT / doc["binary"]).read_bytes()), "<i2").reshape(len(doc["planes"]), H, W)


def plane(pid):
    """One plane in its unit: int16 × the plane's scale (or the file's), no-data as NaN (web/src/motionmaps.js)."""
    k = next(i for i, p in enumerate(doc["planes"]) if p["id"] == pid)
    v = raw[k].astype(float) * (doc["planes"][k].get("scale") or doc["scale_cm"])
    v[raw[k] == doc["nodata"]] = np.nan
    return v


ids = [p["id"] for p in doc["planes"]]
geoms = doc["geometries"]
print(doc["name"], f"· {W} × {H} cells of {doc['grid']['res_m']} m · {doc['source']}")
print("Sign convention:", doc["sign"])
for g in geoms:
    print(f"  track {g['track']:3} {g['direction']:10} looks {'east' if g['direction'] == 'ascending' else 'west'}, incidence {g['incidence_deg']:.1f}° · "
          f"{g['start']} → {g['end']} · measured {g['measured_pct']}% of the box · median coherence {g['coherence_median']}")
for q in doc.get("quakes") or []:
    print(f"  M{q['mag']} {q['utc']} at {q['lat']:.2f}°N {q['lon']:.2f}°E, {q['depth_km']} km deep ({q.get('place', '')})")
''')
    nb.code(r"""
dem = plane("dem")
gy, gx = np.gradient(np.nan_to_num(dem), 1.0)
shade = np.clip(0.5 + (gx - gy) / (np.nanstd(gx) * 6 + 1e-9), 0, 1)   # light from the north-west
fig, ax = plt.subplots(figsize=(12, 12 * H / W + 1))
ax.imshow(shade, extent=extent, cmap="gray", vmin=0, vmax=1)
ax.imshow(dem, extent=extent, cmap="cividis", alpha=0.35)
for ring in doc.get("fault") or []:
    ax.add_patch(mpatches.Polygon(ring, closed=True, fill=False, ec="white", lw=1.5))
for q in doc.get("quakes") or []:
    ax.scatter(q["lon"], q["lat"], marker="*", s=40 * q["mag"] ** 2, color=C["burn"], edgecolor="white", zorder=3)
    ax.annotate(f"M{q['mag']}", (q["lon"], q["lat"]), xytext=(8, 8), textcoords="offset points", color="white", weight="bold")
for s_ in doc.get("gnss") or []:
    ax.scatter(s_["lon"], s_["lat"], marker="^", s=90, color=C["gnss"], edgecolor="white", zorder=3)
    ax.annotate(s_["id"], (s_["lon"], s_["lat"]), xytext=(6, 4), textcoords="offset points", color="white", weight="bold", fontsize=9)
rb = doc["reference"].get("bbox")
if rb:
    ax.add_patch(mpatches.Rectangle((rb[0], rb[1]), rb[2] - rb[0], rb[3] - rb[1], fill=False, ec=C["gauge"], lw=2, ls="--"))
    ax.annotate("reference", (rb[0], rb[3]), xytext=(0, 4), textcoords="offset points", color=C["gauge"], weight="bold", fontsize=9)
mapframe(ax, BOUNDS, f"{doc['name']}: terrain, {'fault and epicentres' if doc.get('quakes') else 'GPS stations'}")
plt.tight_layout(); plt.show()
print("Reference area (motion is measured relative to it):", doc["reference"]["label"])
""")

    # 2 -------------------------------------------------------------------------------------------
    nb.md(f"""
## 2 · How radar measures centimetres from 747 km up

A radar echo has a **phase**: where in its wave cycle it arrives. Compare the phase of two passes over the same
spot, 12 days apart, and any change in the distance between satellite and ground shows up as a phase change.
That is **interferometry** (InSAR). NISAR's L-band wavelength is {m["wavelength_m"] * 100:.1f} cm; the wave goes
there *and back*, so one full cycle of phase change is **{m["half_wavelength_cm"]} cm** of motion along the
radar's line of sight. Drawn as repeating colour bands, these cycles are the famous **fringes**: each band is
{m["half_wavelength_cm"]} cm.

Three things to keep in mind:

* **Line of sight (LOS).** One interferogram measures motion only *toward or away from the satellite*, a slanted
  direction, not east or up. Chapter 5 combines directions.
* **Coherence** (0 to 1) says whether the ground looked the same to the radar both times. Where it is low
  (moving water, dense forest, rapid change) the phase is noise and is left out (here below {m["min_coherence"]}).
* **Relative, not absolute.** Phase is measured against a reference area assumed still: {m["reference"]["label"]}.
""")
    if quake:
        nb.code(r"""
g0 = max(geoms, key=lambda g: g["measured_pct"])
los = plane(f"los_{g0['key']}")
fig, (a1, a2) = plt.subplots(1, 2, figsize=(15, 15 * H / W / 2 + 1.5))
fr = np.mod(los, doc["half_wavelength_cm"])
a1.imshow(fr, extent=extent, cmap="twilight", vmin=0, vmax=doc["half_wavelength_cm"]); a1.set_facecolor("#222")
mapframe(a1, BOUNDS, f"Track {g0['key']} as fringes: one colour cycle = {doc['half_wavelength_cm']} cm")
lim = np.nanpercentile(np.abs(los), 99)
im = a2.imshow(los, extent=extent, cmap="RdBu_r", vmin=-lim, vmax=lim); a2.set_facecolor("#ddd")
mapframe(a2, BOUNDS, "The same, unwrapped: motion in cm", light=False); fig.colorbar(im, ax=a2, shrink=0.7, label="cm toward the satellite")
plt.tight_layout(); plt.show()
""")
    else:
        nb.code(r"""
g0 = max(geoms, key=lambda g: g["measured_pct"])
rate = plane(f"rate_{g0['key']}")
fig, (a1, a2) = plt.subplots(1, 2, figsize=(15, 15 * H / W / 2 + 1.5))
a1.imshow(np.mod(rate, doc["half_wavelength_cm"]), extent=extent, cmap="twilight", vmin=0, vmax=doc["half_wavelength_cm"]); a1.set_facecolor("#222")
mapframe(a1, BOUNDS, f"Track {g0['key']}, one year of motion as fringes ({doc['half_wavelength_cm']} cm each)")
lim = np.nanpercentile(np.abs(rate), 99)
im = a2.imshow(rate, extent=extent, cmap="RdBu_r", vmin=-lim, vmax=lim); a2.set_facecolor("#ddd")
mapframe(a2, BOUNDS, "The same as a rate", light=False); fig.colorbar(im, ax=a2, shrink=0.7, label="cm per year toward the satellite")
plt.tight_layout(); plt.show()
""")
    nb.md(
        "**Count the fringes** from the reference area to the place that moved most, multiply by the half wavelength, and you have estimated the motion by eye: that is exactly what the unwrapped map on the right does, cell by cell."
    )

    # 3 decode check + every track ------------------------------------------------------------------
    nb.md("""
## 3 · What each track saw, and a check against the app

Every map in the app is drawn in the browser from these planes. The first line below recomputes the app's
headline number from them, so you know the decode is right.
""")
    if quake:
        nb.code(r"""
east_map, up_map = plane("east"), plane("up")
v = east_map[np.isfinite(east_map)]
assert round(float(np.percentile(v, 1)), 1) == doc["headline"]["east_p01_cm"]
print(f"Decode check: the fastest-moving 1 % moved {abs(doc['headline']['east_p01_cm'])} cm or more {'west' if doc['headline']['east_p01_cm'] < 0 else 'east'}, as the app says.")
n = len(geoms)
fig, axs = plt.subplots(n, 2, figsize=(14, (14 * H / W / 2 + 0.6) * n), squeeze=False)
for row, g in zip(axs, geoms):
    los = plane(f"los_{g['key']}"); coh = plane(f"coh_{g['key']}")
    lim = np.nanpercentile(np.abs(los), 99)
    im = row[0].imshow(los, extent=extent, cmap="RdBu_r", vmin=-lim, vmax=lim); row[0].set_facecolor("#ddd")
    mapframe(row[0], BOUNDS, f"{g['key']}: motion toward the satellite (cm)", light=False); fig.colorbar(im, ax=row[0], shrink=0.8)
    im = row[1].imshow(coh, extent=extent, cmap="cividis", vmin=0, vmax=1)
    mapframe(row[1], BOUNDS, f"{g['key']}: coherence (median {g['coherence_median']})"); fig.colorbar(im, ax=row[1], shrink=0.8)
plt.tight_layout(); plt.show()
""")
    else:
        nb.code(r"""
up_rate, east_rate = plane("rate_up"), plane("rate_east")
v = up_rate[np.isfinite(up_rate)]
assert round(float(np.percentile(v, 1)), 1) == doc["headline"]["up_p01_cm_yr"]
print(f"Decode check: the fastest-sinking 1 % sink {abs(doc['headline']['up_p01_cm_yr'])} cm a year or more, as the app says.")
n = len(geoms)
fig, axs = plt.subplots(n, 3, figsize=(16, (16 * H / W / 3 + 0.9) * n), squeeze=False)
for row, g in zip(axs, geoms):
    r_ = plane(f"rate_{g['key']}"); sg = plane(f"sigma_rate_{g['key']}"); coh = plane(f"coh_{g['key']}")
    lim = np.nanpercentile(np.abs(r_), 99)
    for ax, img, t, kw, lab in [(row[0], r_, "rate (cm/yr)", dict(cmap="RdBu_r", vmin=-lim, vmax=lim), "cm/yr"),
                                (row[1], sg, "uncertainty, 1σ (cm/yr)", dict(cmap="cividis", vmin=0, vmax=np.nanpercentile(sg, 98)), "cm/yr"),
                                (row[2], coh, "coherence", dict(cmap="cividis", vmin=0, vmax=1), "")]:
        im = ax.imshow(img, extent=extent, **kw); ax.set_facecolor("#ddd"); mapframe(ax, BOUNDS, f"{g['key']}: {t}", light=False); fig.colorbar(im, ax=ax, shrink=0.75, label=lab)
plt.tight_layout(); plt.show()
for g in geoms:
    print(f"{g['key']}: {len(g.get('dates') or [])} dates, {g['pairs'] if isinstance(g.get('pairs'), int) else len(g.get('pairs') or [])} pairs, median 1σ {g['sigma_median_cm_yr']} cm/yr, stable ground scatters by {g['stable_rate_spread_cm_yr']} cm/yr")
""")
    nb.md("""
**Coherence explains the gaps.** Where coherence is low (water, dense vegetation, steep slopes in shadow, places
that changed too much) there is no measurement: a blank is honest, a guess is not.
""")

    # 4 noise -----------------------------------------------------------------------------------------
    if quake:
        nb.md("""
## 4 · How big is the noise? The pair before the quake

Every interferogram contains more than motion: the atmosphere (water vapour slows radar), the ionosphere, and
orbit errors. The cleanest way to see this noise is the radar's own measurement **before** the earthquake: a
pair of passes 12 days apart in which nothing should have moved. Its spread is the noise floor the quake must beat.
""")
        nb.code(r"""
fig, axs = plt.subplots(1, len(geoms), figsize=(4 * len(geoms), 3.4), sharey=True, squeeze=False)
for ax, g in zip(axs[0], geoms):
    across, before = plane(f"los_{g['key']}"), plane(f"before_los_{g['key']}")
    bins = np.linspace(-60, 60, 121)
    ax.hist(before[np.isfinite(before)], bins=bins, color="#888", alpha=0.8, density=True, label="12 days before")
    ax.hist(across[np.isfinite(across)], bins=bins, color=C["burn"], alpha=0.6, density=True, label="across the quake")
    ax.set_yscale("log"); ax.set_title(f"{g['key']}: noise {g['control']['noise_cm']} cm"); ax.set_xlabel("cm toward the satellite")
axs[0][0].legend(fontsize=8); axs[0][0].set_ylabel("share of cells (log)")
plt.tight_layout(); plt.show()
""")
        nb.md(
            "The grey 'before' histograms are narrow: a few centimetres of atmosphere and processing noise. The coloured 'across' ones reach tens of centimetres: the earthquake stands far above its own noise floor."
        )
    else:
        nb.md("""
## 4 · How uncertain is each pixel?

The rate at each pixel is fitted to a time series of interferograms (a **network** of pairs), so each pixel has
a standard error (1σ, shown above). A larger error source is the **atmosphere**: water vapour delays the radar,
and because the air over mountains is thinner, the delay follows terrain height. The project fits and removes the
part of the phase that follows height, pair by pair (the *stratified troposphere* correction, Doin et al. 2009),
and references everything to the volcanic hills, which do not sink.
""")
        nb.code(r"""
fig, ax = plt.subplots(figsize=(9, 3.6))
for g in geoms:
    ht = g.get("height_trend_cm_per_km") or []
    if ht:
        ax.plot(range(1, len(ht) + 1), ht, "o-", label=f"{g['key']}")
ax.axhline(0, color=C["ink"], lw=0.8); ax.set_xlabel("pair"); ax.set_ylabel("phase that followed height (cm per km)")
ax.set_title("The atmosphere, measured and removed: one fit per pair"); ax.legend()
plt.tight_layout(); plt.show()
""")
        nb.md(
            "Each dot is how much of one pair's signal tracked terrain height (cm per km of height): that is weather, not ground motion, and it was removed. It changes sign from pair to pair, as weather does."
        )

    # 5 decomposition --------------------------------------------------------------------------------
    nb.md("""
## 5 · Which way did the ground move?

Each track measures the projection of the 3-D motion onto its own line of sight. Track *i* sees

$$d_i = e\\,\\ell^{(i)}_E + n\\,\\ell^{(i)}_N + u\\,\\ell^{(i)}_U$$

where $(\\ell_E, \\ell_N, \\ell_U)$ is the unit vector from ground to satellite (`los_enu`). NISAR orbits nearly
north–south, so every track's north component is small: north motion is the hardest to resolve (Wright et al.
2004). The standard approach, used here, solves for **east** and **up** by least squares and accepts that north
is not measured. With an ascending and a descending track, the two directions are well separated.
""")
    if quake:
        nb.code(r"""
L = np.array([g["los_enu"] for g in geoms])            # (tracks, 3)
D = np.stack([plane(f"los_{g['key']}") for g in geoms])  # (tracks, H, W)
ok = np.isfinite(D)
e_ls, u_ls = np.full((H, W), np.nan), np.full((H, W), np.nan)
asc = np.array([g["direction"] == "ascending" for g in geoms])
for mask in {tuple(c) for c in ok.reshape(len(geoms), -1).T}:
    use = np.array(mask)
    if use.sum() < 2 or not (asc[use].any() and (~asc[use]).any()):
        continue                                          # needs both looking directions
    cells = (ok == use[:, None, None]).all(0)
    A = L[use][:, [0, 2]]
    sol, *_ = np.linalg.lstsq(A, D[use][:, cells], rcond=None)
    e_ls[cells], u_ls[cells] = sol
both = np.isfinite(e_ls) & np.isfinite(east_map)
r_e = np.corrcoef(e_ls[both], east_map[both])[0, 1]
print(f"East from this least-squares fit vs the app's east map: r = {r_e:.3f}, median difference {np.median(e_ls[both] - east_map[both]):+.1f} cm over {both.sum():,} cells")
lim = np.nanpercentile(np.abs(east_map), 99)
fig, axs = plt.subplots(1, 2, figsize=(15, 15 * H / W / 2 + 1.5))
for ax, img, t, l in [(axs[0], east_map, "East-west (red = east)", lim), (axs[1], up_map, "Up-down (red = up)", max(5, np.nanpercentile(np.abs(up_map), 99)))]:
    im = ax.imshow(img, extent=extent, cmap="RdBu_r", vmin=-l, vmax=l); ax.set_facecolor("#ddd")
    for ring in doc.get("fault") or []:
        ax.add_patch(mpatches.Polygon(ring, closed=True, fill=False, ec=C["ink"], lw=1))
    mapframe(ax, BOUNDS, t + " (cm)", light=False); fig.colorbar(im, ax=ax, shrink=0.75, label="cm")
plt.tight_layout(); plt.show()
h = doc["headline"]
print(f"East-west: 1st–99th percentile {h['east_p01_cm']} to {h['east_p99_cm']} cm; up-down: {h['up_p01_cm']} to {h['up_p99_cm']} cm.")
""")
        nb.md("""
**Reading the maps.** On a strike-slip fault the two sides slide past each other horizontally, so the
east-west map should show opposite colours on the two sides of the fault, and the up-down map should be small.
Check both. The recomputed east agrees with the app's (the r above): small differences come from how the app
weights and fills cells, which is why you check rather than assume.
""")
    else:
        nb.code(r"""
lim = np.nanpercentile(np.abs(up_rate), 99)
fig, axs = plt.subplots(1, 2, figsize=(15, 15 * H / W / 2 + 1.5))
for ax, img, t in [(axs[0], up_rate, "Up-down (blue = sinking)"), (axs[1], east_rate, "East-west")]:
    l = lim if "Up" in t else max(3, np.nanpercentile(np.abs(east_rate), 99))
    im = ax.imshow(img, extent=extent, cmap="RdBu_r", vmin=-l, vmax=l); ax.set_facecolor("#ddd")
    mapframe(ax, BOUNDS, t + " (cm per year)", light=False); fig.colorbar(im, ax=ax, shrink=0.75, label="cm/yr")
plt.tight_layout(); plt.show()
h = doc["headline"]
print(f"Fastest 1 % sinking at {abs(h['up_p01_cm_yr'])} cm/yr or more; {h['sinking_10cm_yr_km2']:,} km² sink faster than 10 cm/yr, "
      f"{h['sinking_20cm_yr_km2']:,} km² faster than 20 cm/yr; median 1σ {h['sigma_up_median_cm_yr']} cm/yr; measured {h['measured_pct']}% of the box.")
""")
        nb.md(
            "Sinking ground clay compacts vertically, so the up-down map carries the story and the east-west map should be small, except at the edges of the sinking bowl, where the ground also tilts inward."
        )

    # 6/7 checks -------------------------------------------------------------------------------------
    if quake:
        nb.md("""
## 6 · Check 1: NASA JPL's processing of the same pairs

JPL processed the same NISAR pairs independently for its urgent response. Agreement tests the *processing*
(unwrapping, referencing, corrections), not the radar itself.
""")
        nb.code(r"""
rows = [(g["key"], g["jpl"]) for g in geoms if g.get("jpl")]
if rows:
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(12, 3.8))
    a1.bar([k for k, _ in rows], [j["corr"] for _, j in rows], color=C["east"]); a1.set_ylim(0.9, 1.0); a1.set_ylabel("correlation r"); a1.set_title("Same pairs, two processings")
    a2.bar([k for k, _ in rows], [j["rms_diff_cm"] for _, j in rows], color="#888"); a2.set_ylabel("RMS difference (cm)"); a2.set_title("How far apart")
    for k_, (_, j) in enumerate(rows):
        a1.text(k_, j["corr"] + 0.002, f"{j['corr']:.3f}", ha="center"); a2.text(k_, j["rms_diff_cm"] + 0.05, f"{j['rms_diff_cm']:.1f} (slope {j['slope']:.2f})", ha="center", fontsize=8)
    plt.tight_layout(); plt.show()
    print("Tracks without a JPL product to compare:", [g["key"] for g in geoms if not g.get("jpl")] or "none")
""")
        nb.md("""
**A slope above 1** means this processing measures slightly larger motion than JPL's on the same pairs, a few
percent. The project's open question (docs/10 §2) suggests why: a difference in the ionosphere correction.
Agreement in shape (r near 1) with a small difference in size is typical of two careful processings.
""")
        if has_model:
            nb.md("""
## 7 · Check 2: the USGS fault model, forward-modelled

The USGS built a model of the fault from seismic waves (and some radar): 130 rectangular patches, each with a
slip. Feed those patches into **Okada's (1985)** equations for a dislocation in an elastic half-space and you get
the surface motion the model predicts, which the project projects onto each track's line of sight. The fair test
is a track **the model never used**: there, agreement is a prediction, not a fit.
""")
            nb.code(r"""
md_ = doc["model"]
print(md_["label"], f"· Mw {md_['mw']:.2f} · used: {md_['used_data']}")
fit = md_["fit"]
keys = [g["key"] for g in geoms]
fig, axs = plt.subplots(1, 2, figsize=(13, 4))
cols = [C["burn"] if not fit[k].get("used_by_model", True) else "#888" for k in keys]
axs[0].bar(keys, [fit[k]["corr"] for k in keys], color=cols); axs[0].set_ylim(0, 1); axs[0].set_ylabel("r, model vs radar")
axs[0].set_title("Model against each track (orange = never used by the model)")
axs[1].bar(keys, [fit[k]["robust_resid_cm"] for k in keys], color=cols); axs[1].set_ylabel("robust residual (cm)"); axs[1].set_title("How far off, typically")
plt.tight_layout(); plt.show()
held = [k for k in keys if not fit[k].get("used_by_model", True)]
for k in held:
    obs, mod = plane(f"los_{k}"), plane(f"model_los_{k}")
    res = obs - mod
    lim = np.nanpercentile(np.abs(obs), 99)
    fig, axs = plt.subplots(1, 3, figsize=(17, 17 * H / W / 3 + 1.6))
    for ax, img, t in [(axs[0], obs, f"{k} observed"), (axs[1], mod, f"{k} predicted by the USGS model"), (axs[2], res, "observed − predicted")]:
        im = ax.imshow(img, extent=extent, cmap="RdBu_r", vmin=-lim, vmax=lim); ax.set_facecolor("#ddd")
        for ring in doc.get("fault") or []:
            ax.add_patch(mpatches.Polygon(ring, closed=True, fill=False, ec=C["ink"], lw=1))
        mapframe(ax, BOUNDS, t, light=False)
    fig.colorbar(im, ax=axs, shrink=0.6, label="cm toward the satellite"); plt.show()
    print(f"{k} (held out): r = {fit[k]['corr']}, robust residual {fit[k]['robust_resid_cm']} cm, median residual {fit[k]['median_resid_cm']} cm")
""")
            nb.md("""
**Where the residual is large, ask why.** A smooth model with 10 km patches cannot reproduce slip that is
shallow, patchy or continued after the quake (*afterslip*). A concentrated residual near the fault is a
scientific lead, not just an error; the project lists one near Caracas airport as an open question (docs/10 §2).
""")
    else:
        if has_gnss:
            nb.md("""
## 6 · Check: GPS on the ground

GNSS (GPS) stations measure their own position every day to millimetres; the Nevada Geodetic Laboratory processes
thousands of them openly (Blewitt et al. 2018). A station is a perfect independent witness: a fixed point on the
ground, measured by a completely different technique. Compare its vertical rate with the radar's at the same place.
""")
            nb.code(r"""
st = [s_ for s_ in doc["gnss"] if s_.get("nisar")]
fig, ax = plt.subplots(figsize=(9, 4))
x = np.arange(len(st))
ax.bar(x - 0.18, [s_["rate_u_cm_yr"] for s_ in st], width=0.34, color=C["gnss"], yerr=[2 * s_["rate_u_formal_se_cm_yr"] for s_ in st], capsize=3, label="GNSS station (±2 formal σ)")
ax.bar(x + 0.18, [s_["nisar"]["rate_up_cm_yr"] for s_ in st], width=0.34, color=C["east"], label="NISAR, cells around the station")
ax.set_xticks(x, [f"{s_['id']}\n{s_['period']} period" for s_ in st]); ax.axhline(0, color=C["ink"], lw=0.8)
ax.set_ylabel("vertical rate (cm/yr)"); ax.set_title("Sinking at the GPS stations"); ax.legend()
plt.tight_layout(); plt.show()
for s_ in st:
    print(f"{s_['id']}: GNSS {s_['rate_u_cm_yr']} cm/yr ({s_['start']} to {s_['end']}, {s_['period']} period) · NISAR {s_['nisar']['rate_up_cm_yr']} cm/yr from {s_['nisar']['cells']} cells")
""")
            nb.code(r"""
s0 = next((s_ for s_ in doc["gnss"] if s_.get("series")), None)
if s0:
    ser = np.array([[day(r[0]).toordinal(), r[3]] for r in s0["series"]])
    t0 = ser[0, 0]
    fig, ax = plt.subplots(figsize=(11, 4))
    ax.plot([dt.date.fromordinal(int(t)) for t in ser[:, 0]], ser[:, 1], ".", color=C["gnss"], ms=3, label=f"{s0['id']} daily height (GNSS)")
    rr = int(np.clip((north - s0["lat"]) / (north - south) * H, 0, H - 1)); cc = int(np.clip((s0["lon"] - west) / (east - west) * W, 0, W - 1))
    for g in geoms:
        cum = [(p["id"].split("_")[-1], plane(p["id"])[max(rr - 1, 0):rr + 2, max(cc - 1, 0):cc + 2]) for p in doc["planes"] if p["id"].startswith(f"cum_{g['key']}_")]
        pts = [(day(d), np.nanmedian(v)) for d, v in cum if np.isfinite(v).any()]
        if pts:
            # Line of sight to vertical, assuming the motion is vertical (true for compacting clay, to first order).
            ax.plot([d for d, _ in pts], [v / g["los_enu"][2] for _, v in pts], "o-", color=C["east"] if g["direction"] == "ascending" else C["up"],
                    label=f"NISAR {g['key']}, line of sight ÷ its vertical part")
    ax.set_ylabel("cm"); ax.set_title(f"The sinking, day by day and pass by pass, at {s0['id']}"); ax.legend(fontsize=8); months(ax)
    plt.tight_layout(); plt.show()
""")
            nb.md(
                "**Agreement within a few centimetres a year**, by two completely different techniques, is strong evidence. A gap is information too: the GNSS antenna sits on one building, NISAR averages several cells; and a station measured in a different period (`period` above) should not be expected to match exactly."
            )

    # 8 profiles -------------------------------------------------------------------------------------
    nb.md(
        """
## {} · Profiles: a slice through the motion

A **swath profile** takes every cell within a few kilometres of a line and plots its value against distance
along the line: the standard way geodesists read a deformation map, because a profile shows steps and slopes
that colours hide.
""".format("8" if quake else "7")
    )
    nb.code(r"""
km_lon, km_lat = 111.32 * np.cos(np.radians((south + north) / 2)), 111.32
LON, LAT = np.meshgrid(west + (np.arange(W) + 0.5) * (east - west) / W, north - (np.arange(H) + 0.5) * (north - south) / H)
layers = [("east", plane("east"), C["east"]), ("up", plane("up"), C["up"])] if "east" in ids else [("up rate", plane("rate_up"), C["east"]), ("east rate", plane("rate_east"), C["up"])]
fig, axs = plt.subplots(1, len(doc["profiles"]), figsize=(7 * len(doc["profiles"]), 4), squeeze=False)
for ax, pr in zip(axs[0], doc["profiles"]):
    (ax_, ay_), (bx_, by_) = pr["a"], pr["b"]
    vx, vy = (bx_ - ax_) * km_lon, (by_ - ay_) * km_lat; L_ = np.hypot(vx, vy)
    px, py = (LON - ax_) * km_lon, (LAT - ay_) * km_lat
    along = (px * vx + py * vy) / L_; across = (px * vy - py * vx) / L_
    sel = (along >= 0) & (along <= L_) & (np.abs(across) <= pr["half_width_km"])
    bins = np.arange(0, L_ + 1, 1.0)
    for name, img, col in layers:
        ok = sel & np.isfinite(img)
        idx = np.digitize(along[ok], bins)
        med = [np.median(img[ok][idx == k]) if (idx == k).sum() >= 3 else np.nan for k in range(1, len(bins))]
        ax.scatter(along[ok], img[ok], s=1, color=col, alpha=0.08)
        ax.plot(bins[:-1] + 0.5, med, color=col, lw=2, label=name)
    ax.axhline(0, color=C["ink"], lw=0.6); ax.set_xlabel("distance along the profile (km)")
    ax.set_ylabel("cm" if "east" in ids else "cm/yr"); ax.set_title(f"Profile {pr['id']} (±{pr['half_width_km']} km wide)"); ax.legend()
plt.tight_layout(); plt.show()
""")
    nb.md(
        "Dots are single cells; the line is the median in 1 km steps. A sharp **step** in the east-west profile marks where the fault broke the surface; a smooth **bowl** in a vertical profile marks a sinking basin, its edges where the clay thins."
    )

    # 9 time -----------------------------------------------------------------------------------------
    if quake and has_rupture:
        nb.md("""
## 9 · The rupture, second by second

The USGS model also says *when* each patch slipped. Adding up the patches' Okada motion as they break gives the
surface motion through the earthquake itself, about a minute and a half, the way seismologists animate a
rupture. Below: the moment released over time and the east-west motion at a few instants.
""")
        nb.code(r"""
ru = doc["rupture"]
rw, rh = ru["grid"]["width"], ru["grid"]["height"]
frames = np.frombuffer(gzip.decompress((DATA / "motion" / EVENT / ru["file"]).read_bytes()), "<i2").reshape(len(ru["times_s"]), 3, rh, rw).astype(float) * ru["scale_cm"]
fig = plt.figure(figsize=(16, 7))
a0 = fig.add_axes([0.05, 0.62, 0.9, 0.32])
mo = np.asarray(ru["moment_released_nm"])           # released in each time step, not a running total
step = np.diff(ru["times_s"]).mean()
a0.bar(ru["times_s"], mo / step, width=step * 0.8, color=C["burn"], label="moment rate")
a0.set_ylabel("moment rate (N·m per s)"); a0.set_xlabel("seconds after the first rupture")
a0b = a0.twinx(); a0b.plot(ru["times_s"], np.cumsum(mo) / mo.sum() * 100, "o-", color=C["ink"], label="released so far")
a0b.set_ylabel("% released so far"); a0b.set_ylim(0, 105)
M0 = doc["model"]["moment_nm"]
a0.set_title(f"How the moment came out: total {M0:.2e} N·m = Mw {2 / 3 * (np.log10(M0) - 9.1):.2f}; half of it within {ru['times_s'][int(np.searchsorted(np.cumsum(mo) / mo.sum(), 0.5))]:.0f} s")
picks = [k for k in np.linspace(0, len(ru["times_s"]) - 1, 5).astype(int)]
lim = np.nanpercentile(np.abs(frames[-1, 0]), 99)
for j, k in enumerate(picks):
    ax = fig.add_axes([0.05 + j * 0.185, 0.05, 0.17, 0.45])
    ax.imshow(frames[k, 0], extent=extent, cmap="RdBu_r", vmin=-lim, vmax=lim); ax.set_xticks([]); ax.set_yticks([])
    ax.set_title(f"{ru['times_s'][k]:.0f} s", fontsize=10)
plt.show()
""")
        nb.md(
            "This is the model's story, not a measurement: radar only sees the end state (12 days apart). It shows why the final map looks the way it does: the rupture ran along the fault, and motion grew where it passed."
        )
    if not quake:
        nb.md("""
## 8 · The sinking, month by month

Each track's interferograms were combined into a **time series**: the cumulative motion at every date since
the first. Small multiples show how steadily the bowl deepens.
""")
        nb.code(r"""
g = max(geoms, key=lambda g: g["measured_pct"])
cum = [(p["id"].split("_")[-1], plane(p["id"])) for p in doc["planes"] if p["id"].startswith(f"cum_{g['key']}_")]
pick = cum[:: max(1, len(cum) // 6)][:6]
lim = np.nanpercentile(np.abs(cum[-1][1]), 99)
fig, axs = plt.subplots(1, len(pick), figsize=(3 * len(pick), 3.6), squeeze=False)
for ax, (d, img) in zip(axs[0], pick):
    ax.imshow(img, extent=extent, cmap="RdBu_r", vmin=-lim, vmax=lim); ax.set_facecolor("#ddd"); ax.set_xticks([]); ax.set_yticks([]); ax.set_title(d, fontsize=9)
plt.suptitle(f"Track {g['key']}: cumulative motion toward the satellite (cm), same colour scale", x=0.01, ha="left", weight="bold")
plt.tight_layout(); plt.show()
""")

    # limits, next, refs ---------------------------------------------------------------------------
    nb.md("""
## Taking the map into a GIS
""")
    nb.code(r"""
try:
    import rasterio
    from rasterio.transform import from_bounds
except ImportError:
    print("pip install rasterio to write GeoTIFFs")
else:
    for pid in [p for p in ("east", "up", "rate_up", "rate_east") if p in ids]:
        out = Path(f"{EVENT}_{pid}.tif")
        with rasterio.open(out, "w", driver="GTiff", width=W, height=H, count=1, dtype="float32", crs="EPSG:4326",
                           transform=from_bounds(west, south, east, north, W, H), nodata=np.nan, compress="deflate") as dst:
            dst.write(plane(pid).astype("float32"), 1)
            dst.update_tags(unit=next(p["unit"] for p in doc["planes"] if p["id"] == pid), sign=doc["sign"], source=doc["source"])
        print("Wrote", out)
""")
    if quake:
        nxt = """
1. **North.** The east/up split ignores north motion. How large an error does that make for this fault's
   orientation? (Hint: project a pure north motion onto each `los_enu`.)
2. **Afterslip.** Interferograms from later pairs would show whether the fault kept slipping after the quake.
3. **The residual near the fault.** Is the misfit shallow slip the 10 km model cannot resolve? Try finer patches.
4. **Damage.** Coherence loss between pairs marks places that changed: does it outline damaged buildings?
"""
    else:
        nxt = """
1. **Why here?** Overlay the sinking map on a map of the old lakebed clay: does the bowl follow the clay?
2. **Acceleration.** Is the rate steady, or speeding up? Fit a curve to the cumulative series pixel by pixel.
3. **Damage.** Where does the *gradient* of sinking (differential subsidence) cross pipelines and metro lines?
4. **Seasons.** Does pumping in the dry season show as faster sinking? You would need a longer series.
"""
    nb.md(f"""
## What would you study next?
{nxt}
## Limits

* NISAR's 2026 interferograms are **provisional**; maps are at {m["grid"]["res_m"]} m.
* Motion is relative to the reference area, which is assumed not to move.
* North motion is not resolved; east and up assume it is negligible (Wright et al. 2004).
* The atmosphere and ionosphere are corrected, not removed perfectly; the noise floor above is the honest measure.
""")
    keys = (
        ["wright2004", "okada1985", "doin2009", "crameri2020", "nisar_handbook"]
        if quake
        else [
            "chaussard2014",
            "wright2004",
            "doin2009",
            "blewitt2018",
            "crameri2020",
            "nisar_handbook",
        ]
    )
    references(
        nb,
        keys,
        data_line="Data: NISAR L2 GUNW, NASA-ISRO, via the Alaska Satellite Facility DAAC; JPL urgent-response products; USGS NEIC finite-fault model; Nevada Geodetic Laboratory GNSS; Copernicus DEM.",
    )
    return nb
