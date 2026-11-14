"""Burned forest through the smoke: the notebook motif for fire sites (site kind "fire").

Follows pipeline/canopy/burn.py (the rule, its dates, its checks) on the published site grid. The
app's burn map is made on a finer 55 m grid that is not published (D-088), so the notebook reruns
the rule on the site grid and measures its agreement with the published map instead of claiming
identity. Bald Range also gets the downwind ice chapter (Columbia Icefield, D-085).
"""

from __future__ import annotations

import json

from .common import WEB_DATA, Notebook, references, setup_cell, title_block

ICEFIELD = "ice/columbia_icefield/ice.json"


def files(site_id: str) -> list[str]:
    out = [
        f"web/data/{site_id}/{f}"
        for f in ("summary.json", "stack.bin", "static.bin", "active_fire.json")
    ]
    out = [f for f in out if (WEB_DATA.parent.parent / f).exists()]
    if _icefield_for(site_id):
        out.append(f"web/data/{ICEFIELD}")
    return out


def _icefield_for(site_id: str) -> bool:
    f = WEB_DATA / ICEFIELD
    return f.exists() and json.loads(f.read_text()).get("fire_site") == site_id


def build(site_id: str) -> Notebook:
    s = json.loads((WEB_DATA / site_id / "summary.json").read_text())
    b = s["products"]["burn"]
    nb = Notebook({"SITE": site_id})
    name = s["site"]["name"]
    tuned = b.get("tuned_site") == site_id
    has_af = (WEB_DATA / site_id / "active_fire.json").exists()
    ice = _icefield_for(site_id)

    title_block(
        nb,
        f"Burned forest through the smoke: {name}",
        "Mapping a wildfire with NISAR's L-band radar, and checking it against NASA's fire satellites",
        "fire",
    )
    nb.md(f"""
When a forest burns, smoke hides it from cameras for days or weeks, exactly when firefighters, ecologists and
carbon accountants want to know what burned. Radar sees through smoke. This notebook uses NISAR's real L-band
measurements over **{b.get("fire", {}).get("name", name)}** to map what burned, pass by pass, and to check that
map against NASA's own fire products: the MODIS and VIIRS monthly burned-area maps and the VIIRS active-fire
detections that see the flames themselves.

| Chapters | Question |
|:--|:--|
| 1–2 | When did the fire burn, who looked, and how does fire change a radar echo? |
| 3–5 | What did NISAR measure, and how does a rule turn it into a burn map? |
| 6–8 | How did the fire spread, and does the radar map agree with NASA's fire satellites? |
| 9–10 | How sure are we, and what can be mistaken for a burn (or for a flood)? |
{"| 11 | Downwind: smoke and soot on the Columbia Icefield |" if ice else ""}
| last | What would you study next? |

**Real data only.** Every number is read from the project's published files. The rule here is the app's own;
where the notebook cannot reproduce the app exactly (the app maps on a finer grid), it measures the difference
and says so.
""")
    nb.md("""
## 0 · Setting up

Run the cells in order (*Runtime → Run all* in Colab). The first, folded cell unpacks the published data.
Colours keep one meaning throughout: **vermilion for burned**, greys for unburned, and perceptually uniform
maps (*cividis*) for quantities. A change map uses a **diverging** palette centred on zero (blue down, red up),
because a change has a sign (Crameri et al. 2020).
""")
    req = [f"{site_id}/summary.json", f"{site_id}/stack.bin", f"{site_id}/static.bin"]
    setup_cell(nb, req)

    # 1 -------------------------------------------------------------------------------------------
    nb.md("""
## 1 · The fire, and who looked when

Three kinds of NASA observation meet here: NISAR's radar every 12 days; the VIIRS instruments on three
satellites, which detect the heat of active fire several times a day at 375 m (Schroeder et al. 2014); and the
monthly burned-area maps from MODIS (MCD64A1, Giglio et al. 2018) and VIIRS (VNP64A1), made from changes in
reflectance after the fire.
""")
    nb.code(r"""
SITE = "@@SITE@@"
summary = json.loads((DATA / SITE / "summary.json").read_text())
assert not summary.get("synthetic")
site, grid, passes, B = summary["site"], summary["grid"], summary["passes"], summary["products"]["burn"]
west, south, east, north = BOUNDS = grid["bounds"]
extent = (west, east, south, north)
dates = [day(p["date"]) for p in passes]
print(site["name"], f"({site['country']}) · track {summary['track']['number']} {summary['track']['direction']} · {len(passes)} passes")
fire = B.get("fire") or {}
if fire.get("reported_ha"):
    print(f"Reported size: {fire['reported_ha'] / 100:,.0f} km² ({fire.get('reported_source', '')})")
print(f"Forest in the box: {B['forest_km2']:,.0f} km² · burned by the radar rule: {B['burned_km2']:,.0f} km² (app, 55 m grid)")

af = B.get("active_fire") or {}
fig, (a1, a2) = plt.subplots(2, 1, figsize=(11, 5.2), sharex=True, gridspec_kw={"height_ratios": [1, 1.5]})
rows = [("NISAR radar passes", [p["date"] for p in passes], C["lband"]),
        ("baseline (before the fire)", B["baseline"], "#888")]
for y, (n, ds, col) in enumerate(rows[::-1]):
    a1.scatter([day(d) for d in ds], [y] * len(ds), s=70, color=col, edgecolor="white", zorder=3)
a1.set_yticks(range(len(rows)), [r[0] for r in rows[::-1]]); a1.tick_params(axis="y", length=0); a1.spines["left"].set_visible(False)
a1.set_ylim(-0.6, len(rows) - 0.4); a1.set_title("Who looked, and when")
if af.get("by_day"):
    d_ = [day(r["date"]) for r in af["by_day"]]
    a2.bar(d_, [r["n"] for r in af["by_day"]], width=1, color=C["burn"])
    a2.set_ylabel("VIIRS fire detections per day"); a2.set_title(f"The flames, seen from orbit: {af['n']:,} VIIRS 375 m detections ({af['first']} to {af['last']})")
months(a2); plt.tight_layout(); plt.show()
""")

    # 2 -------------------------------------------------------------------------------------------
    nb.md("""
## 2 · How fire changes a radar echo

NISAR sends horizontally polarised pulses and listens twice: **HH** (horizontal back) and **HV** (vertical back).
In a living forest, **HV is mostly the echo of the crown**: millions of needles and twigs bounce the pulse around
and turn some of it from horizontal to vertical (*volume scattering*). **HH** also carries echoes from trunks and
the ground.

A crown fire burns the needles and fine branches. The volume goes, so **HV drops**; more of the pulse reaches
trunks and ground, so HH holds up better. Studies of burn severity with radar found exactly this: HV falls as
severity rises, at every frequency, while at L-band HH changes less (Tanase 2011). The project therefore watches
the **ratio HH − HV** (in dB), which **rises** when a forest burns.

**Why the ratio and not HV alone?** Rain, dew and soil moisture move *both* channels together. Over Thunder Bay
those changes moved the HV of the whole forest by up to 0.8 dB from pass to pass, more than the fire's own HV
loss in places (decision D-076). A ratio cancels what moves both.
""")
    nb.code(r"""
def stand(ax, title, burned):
    ax.set_xlim(0, 10); ax.set_ylim(0, 7); ax.axis("off"); ax.set_title(title)
    ax.add_patch(mpatches.Rectangle((0, 0), 10, 1.0, color=C["rock"] if not burned else "#3a3330"))
    for x in (2.2, 4.0, 5.8, 7.6):
        ax.add_patch(mpatches.Rectangle((x - 0.1, 1.0), 0.2, 3.6, color="#5a4632" if not burned else "#1f1a17"))
        if not burned:
            ax.add_patch(mpatches.Ellipse((x, 4.8), 1.6, 2.4, color="#2f6b4a", alpha=0.9))
    arrow = {"arrowstyle": "-|>", "lw": 2.2, "mutation_scale": 16}
    ax.annotate("", xy=(4.6, 4.6) if not burned else (4.6, 1.05), xytext=(0.6, 6.6), arrowprops=dict(color=C["ink"], **arrow))
    if not burned:
        for dx, dy in [(-3.4, 1.6), (-2.0, 2.2), (2.6, 1.8), (1.8, -1.4)]:
            ax.annotate("", xy=(4.6 + dx, 4.6 + dy), xytext=(4.6, 4.6), arrowprops={"color": C["dry"], "lw": 1.2, "arrowstyle": "-|>"})
        txt = "crowns: strong HV (volume)"
    else:
        ax.annotate("", xy=(5.7, 2.2), xytext=(4.6, 1.05), arrowprops=dict(color=C["burn"], **arrow))
        ax.annotate("", xy=(0.9, 6.3), xytext=(5.7, 2.2), arrowprops=dict(color=C["burn"], **arrow))
        txt = "trunks and ground: HV falls, HH − HV rises"
    ax.text(5, 0.4, txt, ha="center", color="white", fontsize=9, weight="bold")


fig, axs = plt.subplots(1, 2, figsize=(11, 3.8))
stand(axs[0], "Before: a living crown", False); stand(axs[1], "After a crown fire", True)
plt.tight_layout(); plt.show()
""")

    # 3 -------------------------------------------------------------------------------------------
    nb.md("""
## 3 · What NISAR measured

The same published files as every site in the project (`docs/03_ARCHITECTURE.md` §4): per-pass HH and HV in a
one-byte-per-pixel stack, and fixed layers including land cover, GEDI canopy height and the app's own burn map
on the site grid (`burn_pass`: 0 = not burned, *k* = first seen burned at pass *k*).

The rule only looks at **forest**: vegetated land (ESA WorldCover) that, where NASA's GEDI lidar measured it, is at
least 5 m tall (`burn.forest_mask` in the pipeline). The published land-cover layer is the flood rule's version,
in which high ground was blanked out (floods are not claimed on hills); for fire, that ground counts again. The
next cell checks this reconstruction against the app's own forest area.
""")
    nb.code(r"""
gs = summary["grid_stack"]
W, H, P = grid["width"], grid["height"], len(passes)
stack = np.fromfile(DATA / SITE / gs["stack_file"], np.uint8).reshape(len(gs["layers"]), P, H, W)
static = np.fromfile(DATA / SITE / gs["static_file"], np.uint8).reshape(len(gs["static_layers"]), H, W)
LAYER = {l["name"]: i for i, l in enumerate(gs["layers"])}
STATIC = {l["name"]: i for i, l in enumerate(gs["static_layers"])}


def decode(layer, q):
    out = q.astype(float) * layer.get("scale", 1) + layer.get("offset", 0)
    if layer.get("nodata") is not None:
        out[q == layer["nodata"]] = np.nan
    return out


layer = lambda n: decode(gs["layers"][LAYER[n]], stack[LAYER[n]])
fixed = lambda n: decode(gs["static_layers"][STATIC[n]], static[STATIC[n]])
hh, hv = layer("hh"), layer("hv")
veg = static[STATIC["veg"]]
height = fixed("canopy_height_m")
burn_pass = static[STATIC["burn_pass"]].astype(int)        # the app's map on this grid
# The published veg layer is the flood rule's: high ground (terrain_gate) was set to "other" because
# floods are not claimed there. Fire is, so gated pixels count as vegetation again; with GEDI's height
# test this recovers the app's forest area to within a few percent (checked below).
gate = static[STATIC["terrain_gate"]] == 1
forest = ((veg == 1) | gate) & ~(np.isfinite(height) & (height < 5))
lat_c = north - (np.arange(H) + 0.5) * (north - south) / H
row_km2 = ((east - west) / W * 111_320 * np.cos(np.radians(lat_c)) * (north - south) / H * 111_320 / 1e6)[:, None]
area = lambda m: float((row_km2 * m).sum())
print(f"{W} × {H} pixels of {grid['pixel_size_m']:.0f} m · forest here {area(forest):,.0f} km² (app, on its 55 m grid: {B['forest_km2']:,.0f} km²)")
print(f"The app's burn map on this grid: {area(burn_pass > 0):,.0f} km², {100 * ((burn_pass > 0) & forest).sum() / max((burn_pass > 0).sum(), 1):.1f} % of it inside this forest mask")
""")

    # 4 -------------------------------------------------------------------------------------------
    nb.md("""
## 4 · Before and after

The **baseline** is each pixel's median HH − HV over the passes before the fire. Subtract it from every pass and
you get the **change** Δ(HH − HV): zero where nothing happened, positive where the crown burned.
""")
    nb.code(r"""
base_k = [k for k, p in enumerate(passes) if p["date"] in B["baseline"]]
ratio = hh - hv
delta = ratio - np.nanmedian(ratio[base_k], axis=0)[None]
last = P - 1
fig, axs = plt.subplots(1, 3, figsize=(16, 5.2))
for ax, img, t in [(axs[0], ratio[base_k[-1]], f"HH − HV before ({passes[base_k[-1]]['date']})"), (axs[1], ratio[last], f"HH − HV after ({passes[last]['date']})")]:
    im = ax.imshow(img, extent=extent, cmap="cividis", vmin=2, vmax=12); mapframe(ax, BOUNDS, t); fig.colorbar(im, ax=ax, shrink=0.8, label="dB")
im = axs[2].imshow(np.where(forest, delta[last], np.nan), extent=extent, cmap="RdBu_r", vmin=-3, vmax=3)
axs[2].set_facecolor("#ddd"); mapframe(axs[2], BOUNDS, "Change in forest: Δ(HH − HV)", light=False); fig.colorbar(im, ax=axs[2], shrink=0.8, label="dB (red = rose)")
plt.tight_layout(); plt.show()
""")
    nb.md(
        "The red patches on the right are where HH − HV rose: candidates for burned forest. Grey is not forest (lakes, rock, cleared land), which the rule does not judge."
    )

    # 5 -------------------------------------------------------------------------------------------
    nb.md(f"""
## 5 · The rule, and a check against the app

A forest pixel counts as **burned** when, on some pass after the baseline, its ratio rises at least
**{b["rise_db"]} dB** above its baseline *and*, averaged over that pass and every later one, stays at least that
high: one bright pass alone is not trusted (it may be rain). The last pass, with nothing after it, needs
**{b["last_pass_rise_db"]} dB**. A burned pixel is **dated** by the first pass whose rise passed **{b["onset_db"]} dB**,
because the signal keeps growing for weeks as dead trees dry and drop what is left.

{"The 1 dB threshold was chosen on the **west half** of this fire's box (best agreement with MODIS) and is reported on the **east half**, which it never saw: the same spatial hold-out idea as block cross-validation (Roberts et al. 2017)." if tuned else f"The 1 dB threshold was chosen at **{b.get('tuned_site')}**; this fire is a test it never saw."}
""")
    nb.code(r'''
def first_rise(delta, forest, start, rise_db, extra=B["last_pass_rise_db"] - B["rise_db"]):
    """pipeline/canopy/burn.first_rise: first pass from `start` where the rise passed rise_db and lasted."""
    fin = np.isfinite(delta)
    vals = np.where(fin, delta, 0.0)
    after_sum = np.cumsum(vals[::-1], axis=0)[::-1]; after_n = np.cumsum(fin[::-1], axis=0)[::-1]
    first = np.full(delta.shape[1:], -1, dtype=int)
    for k in range(start, delta.shape[0]):
        with np.errstate(invalid="ignore", divide="ignore"):
            mean_after = after_sum[k] / after_n[k]
            up = fin[k] & (delta[k] >= rise_db)
            lasting = np.where(after_n[k] >= 2, mean_after >= rise_db, delta[k] >= rise_db + extra)
        new = up & lasting & forest & (first < 0)
        first[new] = k
    return first


start = max(base_k) + 1
confirmed = first_rise(delta, forest, start, B["rise_db"])
onset = first_rise(delta, forest & (confirmed >= 0), start, B["onset_db"])
first = np.where((onset >= 0) & (onset <= confirmed), onset, confirmed)
ours, app = first >= 0, burn_pass > 0
agree = (ours & app).sum() / max((ours | app).sum(), 1)
print(f"Burned on the {grid['pixel_size_m']:.0f} m site grid: {area(ours):,.0f} km² (this notebook) vs {area(app):,.0f} km² (the app's 55 m map, brought to this grid)")
both = ours & app
print(f"Overlap (intersection over union): {agree:.0%}." + (f" Same pass where both call it burned: {(first[both] + 1 == burn_pass[both]).mean():.0%}." if both.any() else ""))

fig, axs = plt.subplots(1, 3, figsize=(16, 5.2))
for ax, m, t in [(axs[0], app, "The app's burn map (55 m, on this grid)"), (axs[1], ours, "This notebook, same rule on the site grid")]:
    ax.imshow(np.where(forest, 1.0, np.nan), extent=extent, cmap=ListedColormap(["#c9cdc7"]), interpolation="nearest")
    ax.imshow(np.where(m, 1.0, np.nan), extent=extent, cmap=ListedColormap([C["burn"]]), interpolation="nearest"); mapframe(ax, BOUNDS, t, light=False)
diff = np.full((H, W), np.nan); diff[ours & app] = 0; diff[app & ~ours] = 1; diff[ours & ~app] = 2
axs[2].imshow(np.where(forest, 3.0, np.nan), extent=extent, cmap=ListedColormap(["#e6e8e4"]), interpolation="nearest")
axs[2].imshow(diff, extent=extent, cmap=ListedColormap([C["burn"], "#0072B2", "#E69F00"]), vmin=-0.5, vmax=2.5, interpolation="nearest")
mapframe(axs[2], BOUNDS, "Where they differ", light=False)
axs[2].legend(handles=[mpatches.Patch(color=C["burn"], label="both"), mpatches.Patch(color="#0072B2", label="app only"), mpatches.Patch(color="#E69F00", label="notebook only")], loc="lower right", fontsize=8, frameon=True)
plt.tight_layout(); plt.show()
''')
    nb.md("""
**Why they differ, and why that is fine.** The app runs the rule on 55 m cells built from the same radar reads,
drops burned patches smaller than 0.05 km² (speckle, not fire), and brings the result to this grid by majority
(decision D-088). Coarser pixels average more speckle away, so the notebook's map is smoother and a little
different at the edges. Seeing *how much* an answer depends on the grid is itself a result worth reporting.
""")

    # 6 -------------------------------------------------------------------------------------------
    nb.md("""
## 6 · How the fire spread

Each burned pixel has a **date**: the pass at which its rise began. Coloured by date, the map becomes a
**progression map**, the way fire scientists draw a fire's growth. Beside it: the burned area added at each
pass, and the change of the ratio pass by pass for burned and for unburned forest.
""")
    nb.code(r"""
burned_k = np.where(app, burn_pass - 1, -1)
post = list(range(start, P))
fig = plt.figure(figsize=(16, 5.4))
ax0 = fig.add_axes([0.03, 0.08, 0.36, 0.84])
ax0.imshow(np.where(forest, 1.0, np.nan), extent=extent, cmap=ListedColormap(["#d9dcd6"]), interpolation="nearest")
im = ax0.imshow(np.where(burned_k >= 0, burned_k, np.nan), extent=extent, cmap="cividis", vmin=start, vmax=P - 1, interpolation="nearest")
mapframe(ax0, BOUNDS, "Progression: first pass seen burned", light=False)
cb = fig.colorbar(im, ax=ax0, shrink=0.8); cb.set_ticks(post); cb.set_ticklabels([passes[k]["date"][5:] for k in post])
ax1 = fig.add_axes([0.47, 0.58, 0.5, 0.34])
bp_ = B["by_pass"]
ax1.bar([day(r["date"]) for r in bp_], [r["new_km2"] for r in bp_], width=6, color=C["burn"], label="newly burned")
ax1.plot([day(r["date"]) for r in bp_], [r["burned_km2"] for r in bp_], "o-", color=C["ink"], label="total burned")
ax1.set_ylabel("km²"); ax1.set_title("Burned area, pass by pass (app)"); ax1.legend(fontsize=8); months(ax1)
ax2 = fig.add_axes([0.47, 0.08, 0.5, 0.36], sharex=ax1)
for m, col, lab in [(app & forest, C["burn"], "burned forest"), (~app & forest, "#888", "unburned forest")]:
    med = [np.nanmedian(delta[k][m]) for k in range(P)]
    q1 = [np.nanpercentile(delta[k][m], 25) for k in range(P)]; q3 = [np.nanpercentile(delta[k][m], 75) for k in range(P)]
    ax2.fill_between(dates, q1, q3, color=col, alpha=0.25); ax2.plot(dates, med, "o-", color=col, label=f"{lab} (median, middle half shaded)")
ax2.axhline(B["rise_db"], color=C["ink"], ls=":", lw=1); ax2.text(dates[0], B["rise_db"] + 0.1, f"rule: +{B['rise_db']} dB", fontsize=8)
ax2.set_ylabel("Δ(HH − HV) (dB)"); ax2.legend(fontsize=8, loc="upper left"); months(ax2)
plt.show()
""")
    nb.md("""
**Reading the lower right panel.** Unburned forest wanders a few tenths of a decibel around zero (weather,
moisture); burned forest jumps after the fire and keeps rising, which is why the rule asks the rise to *last*.
The gap between the two lines is the signal; the width of the grey band is the noise it must beat.
""")

    # 7 -------------------------------------------------------------------------------------------
    if has_af:
        nb.md("""
## 7 · The flames, from orbit: VIIRS active fire

VIIRS sees the heat of fires burning at the moment it passes overhead (Schroeder et al. 2014). Its detections
are an independent witness: they know nothing about radar. If the radar's burn map is right, the detections
should fall on it, and should come **before or around** the pass at which the radar first saw each burn.
""")
        nb.code(r"""
afp = json.loads((DATA / SITE / "active_fire.json").read_text())
ox, oy = afp["origin"]; step = afp["step_deg"]
lon = ox + np.asarray(afp["x"]) * step; lat = oy + np.asarray(afp["y"]) * step
dd = np.asarray(afp["d"]); frp = np.asarray(afp["frp"]); conf_ = np.asarray(afp["c"])
fig, (a1, a2) = plt.subplots(1, 2, figsize=(15, 5.6), gridspec_kw={"width_ratios": [1.2, 1]})
a1.imshow(np.where(forest, 1.0, np.nan), extent=extent, cmap=ListedColormap(["#d9dcd6"]), interpolation="nearest")
a1.imshow(np.where(app, 1.0, np.nan), extent=extent, cmap=ListedColormap(["#f2b38f"]), interpolation="nearest")
inside = (lon >= west) & (lon <= east) & (lat >= south) & (lat <= north)
sc = a1.scatter(lon[inside], lat[inside], c=dd[inside], s=1, cmap="cividis", alpha=0.35, linewidths=0)
mapframe(a1, BOUNDS, "VIIRS detections over the radar's burn map (pale)", light=False)
fig.colorbar(sc, ax=a1, shrink=0.8, label=f"days after {afp['day0']}")
a2.hist(frp[frp > 0], bins=np.logspace(0, np.log10(frp.max() + 1), 40), color=C["burn"])
a2.set_xscale("log"); a2.set_xlabel("fire radiative power per detection (MW)"); a2.set_ylabel("detections")
a2.set_title("How hot: most detections are small, a few are huge")
plt.tight_layout(); plt.show()
rows, cols = ((north - lat[inside]) / (north - south) * H).astype(int).clip(0, H - 1), ((lon[inside] - west) / (east - west) * W).astype(int).clip(0, W - 1)
on_burn = app[rows, cols]
print(f"{inside.sum():,} VIIRS detections in the box; {on_burn.mean():.0%} fall on pixels the radar mapped as burned.")
dates_check = (B.get("active_fire") or {}).get("dates") or {}
if dates_check:
    print(f"App's date check: in {dates_check['cells']:,} cells, VIIRS's first confident sighting came before NISAR's detecting pass in "
          f"{dates_check['before_pct']}% and inside its window in {dates_check['within_pct']}% (median lead {dates_check['median_lead_days']} days).")
""")

    # 8 -------------------------------------------------------------------------------------------
    nb.md("""
## 8 · Does it agree with NASA's burned-area maps?

The app compared its 55 m map with NASA's monthly 500 m burned-area maps, resampled to the site grid, and
published the scores. **Precision**: of what the radar called burned, the share the reference also called
burned. **Recall**: of what the reference called burned, the share the radar found. **F1** balances the two.
Two NASA maps can disagree with each other too (decision D-085), so every reference is shown, not just the
friendliest.
""")
    nb.code(r"""
checks = [B["validation"]] + list(B.get("checks") or [])
fig, (a1, a2) = plt.subplots(1, 2, figsize=(14, 4.6))
labels, xs = [], np.arange(len(checks))
for k, c in enumerate(checks):
    vals = [c["precision"], c["recall"], c["f1"]]
    a1.bar(k + np.array([-0.25, 0, 0.25]), vals, width=0.24, color=["#56B4E9", "#009E73", C["ink"]])
    for x_, v in zip(k + np.array([-0.25, 0, 0.25]), vals):
        a1.text(x_, v + 0.02, f"{v:.2f}", ha="center", fontsize=8)
    if c.get("held_out"):
        a1.scatter([k + 0.25], [c["held_out"]["f1"]], marker="D", s=60, color="white", edgecolor=C["burn"], lw=2, zorder=3)
    labels.append(f"{c['product']}\n{c['ref_burned_km2']:,.0f} km² reference")
a1.set_xticks(xs, labels); a1.set_ylim(0, 1.1); a1.set_title("Agreement with NASA burned-area maps")
a1.legend(handles=[mpatches.Patch(color="#56B4E9", label="precision"), mpatches.Patch(color="#009E73", label="recall"), mpatches.Patch(color=C["ink"], label="F1"),
                   plt.Line2D([], [], marker="D", ls="", markerfacecolor="white", markeredgecolor=C["burn"], label="F1 on the held-out east half")], fontsize=8, loc="upper right")
for c in checks:
    sw = c.get("sweep") or []
    if sw:
        a2.plot([r["rise_db"] for r in sw], [r["f1"] for r in sw], "o-", label=c["product"], color=["#0072B2", "#E69F00", "#009E73"][checks.index(c) % 3])
a2.axvline(B["rise_db"], color=C["ink"], ls=":"); a2.set_xlabel("rise threshold (dB)"); a2.set_ylabel("F1"); a2.set_ylim(0, 1)
a2.set_title("How the threshold choice moves agreement"); a2.legend()
plt.tight_layout(); plt.show()
for c in checks:
    ho = c.get("held_out") or {}
    print(f"{c['product']:8} P {c['precision']:.2f}  R {c['recall']:.2f}  F1 {c['f1']:.2f}" + (f" · held-out {ho.get('half')} half F1 {ho['f1']:.2f}" if ho else "")
          + (f" · dates: {c['dates']['within_pct']}% within the radar's window" if c.get("dates") else ""))
""")
    nb.md("""
**How to read disagreement.** MODIS and VIIRS are made by related methods from optical reflectance, and can still
disagree by a factor of three on the same fire; the radar may sit between them. A burned-area map is a
*model* of the ground, not the ground. The robust conclusion is the one that survives every reference, and the
held-out half tells you whether the threshold was simply fitted to the answer.
""")

    # 9 -------------------------------------------------------------------------------------------
    nb.md("""
## 9 · How sure are we? The threshold, rerun

Rerun the rule here on the site grid with rise thresholds from 0.5 to 2 dB and watch the burned area. A gentle
slope means a robust map; a steep one means the threshold decides the answer.
""")
    nb.code(r"""
rises = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
areas = [area(first_rise(delta, forest, start, r) >= 0) for r in rises]
fig, ax = plt.subplots(figsize=(8, 4))
ax.plot(rises, areas, "o-", color=C["burn"], lw=2)
for r, a in zip(rises, areas):
    ax.text(r, a, f" {a:,.0f}", va="bottom", fontsize=8)
ax.axvline(B["rise_db"], color=C["ink"], ls=":"); ax.set_xlabel("rise threshold (dB)"); ax.set_ylabel("burned forest (km², site grid)")
ax.set_title("Burned area against the threshold"); plt.tight_layout(); plt.show()
""")

    # 10 ------------------------------------------------------------------------------------------
    nb.md("""
## 10 · Look-alikes, both ways

A burned forest and a flooded forest can look alike to radar: in both, the crown's volume echo matters less and
trunks matter more. The project ran its **flood** rule over this fire's dry forest to measure the confusion:
""")
    nb.code(r"""
look = B.get("flood_lookalike") or {}
if look:
    fig, ax = plt.subplots(figsize=(7.5, 2.8))
    ax.barh(["before the fire", f"after ({look['date']})"], [look["before_km2"], look["km2"]], color=["#888", C["burn"]])
    for y_, v in enumerate([look["before_km2"], look["km2"]]):
        ax.text(v, y_, f"  {v:.1f} km²", va="center", weight="bold")
    ax.set_xlabel("dry forest the flood rule called 'water under trees' (km²)")
    ax.set_title(f"{look['in_burned_pct']} % of that false 'flood' lies inside the burned area")
    plt.tight_layout(); plt.show()
""")
    nb.md("""
The other way round, rain-soaked or flooded forest can raise HH and look like a burn on a single pass, which is
why the rule asks the rise to **last** over the following passes. Every detector needs its look-alikes named and
tested.
""")

    # 11 ice --------------------------------------------------------------------------------------
    if ice:
        nb.md("""
## 11 · Downwind: smoke and soot on the Columbia Icefield

Fire's effects travel. About 340 km north-east of this fire lies the Columbia Icefield, where wildfire soot has
been measured darkening the ice: the Athabasca Glacier's summer albedo (the share of sunlight reflected) fell
from 0.29 in 2015 to 0.16 in 2018 (Aubry-Wake et al. 2022). Darker ice melts faster, although thick smoke also
shades it. The project tracked fire upwind, smoke over the ice, and how bright the ice was:
""")
        nb.code(r"""
icef = json.loads((DATA / "ice" / "columbia_icefield" / "ice.json").read_text())
fd, sm = icef["fire"], icef["smoke"]
fig, (a1, a2) = plt.subplots(2, 1, figsize=(11, 5.4), sharex=True)
a1.bar([day(r["date"]) for r in fd["days"]], [r["n"] for r in fd["days"]], width=1, color=C["burn"])
a1.set_ylabel("fire pixels per day"); a1.set_title(f"Fire upwind: {fd['label']} ({fd['n']:,} VIIRS detections)")
sd = [r for r in (sm.get("days") or []) if r.get("base_median") is not None]
if sd:
    t_ = [day(r["date"]) for r in sd]
    lo_ = [r["base_lo"] for r in sd]; hi_ = [r["base_hi"] for r in sd]
    a2.fill_between(t_, lo_, hi_, color="#bbb", alpha=0.6, label=f"other years ({icef['baseline_years'][0]}–{icef['baseline_years'][-1]}), range")
    a2.plot(t_, [r["base_median"] for r in sd], color="#777", lw=1, label="other years, median")
    v_ = [(day(r["date"]), r["value"]) for r in sd if r.get("value") is not None]
    a2.plot([d for d, _ in v_], [v for _, v in v_], "o", color=C["burn"], ms=4, label=f"{icef['year']}")
    a2.legend(fontsize=8, loc="upper left")
a2.axhline(sm.get("smoky_aod", 0.4), color=C["burn"], ls=":"); a2.set_ylabel("aerosol optical depth")
a2.set_title(f"Smoke over the ice (VIIRS Deep Blue): {sm.get('smoky_days', 0)} smoky days, AOD > {sm.get('smoky_aod')}")
months(a2); plt.tight_layout(); plt.show()
print("Measured on the ice:", icef["measured"]["athabasca_albedo"], "—", icef["measured"]["source"])
sp = icef.get("speed") or {}
if sp:
    print("NISAR ice offsets (GOFF) were tested here too:", {k: v for k, v in sp.items() if not isinstance(v, (list, dict))})
""")
        nb.md("""
**Co-occurrence is not cause.** Fire upwind, smoke overhead and dark ice in the same summer fit the soot story,
but an early snowline (old, dirty ice exposed sooner) also darkens a glacier. Separating the two needs on-ice
measurements, like the ones in Aubry-Wake et al. (2022).
""")

    # export + next + refs ------------------------------------------------------------------------
    nb.md("""
## Taking the map into a GIS

The app's burn map on the site grid as a **GeoTIFF** (EPSG:4326): 0 = not burned, *k* = first seen burned at
pass *k*. Open it in QGIS or ArcGIS beside a fire perimeter.
""")
    nb.code(r"""
try:
    import rasterio
    from rasterio.transform import from_bounds
except ImportError:
    print("pip install rasterio to write GeoTIFFs")
else:
    out = Path(f"{SITE}_burn_pass.tif")
    with rasterio.open(out, "w", driver="GTiff", width=W, height=H, count=1, dtype="uint8", crs="EPSG:4326",
                       transform=from_bounds(west, south, east, north, W, H), compress="deflate") as dst:
        dst.write(burn_pass.astype("uint8"), 1)
        dst.update_tags(values="0 not burned; k first seen burned at pass k", passes=", ".join(p["date"] for p in passes),
                        source="Under the Canopy published build; NASA-ISRO NISAR L2 GCOV, provisional")
    print("Wrote", out)
""")
    nb.md(f"""
## What would you study next?

1. **Severity, not just burned or not.** Does the size of the rise track burn severity? Compare it with an optical
   severity index (dNBR from Landsat or Sentinel-2) where clouds and smoke allow.
2. **Forest type.** The 1 dB threshold was tuned in boreal forest; Bald Range's open dry pine preferred about
   0.75 dB. Fit the threshold against canopy height and cover (GEDI) across fires.
3. **Recovery.** Keep following the ratio after the fire: when does it start to fall back as vegetation returns?
4. **Fusion.** Combine radar change with VIIRS hotspots, as Belenguer-Plomer et al. (2019) did with Sentinel-1:
   hotspots say *where* to look, radar says *what* burned.

## Limits

* NISAR's 2026 products are **provisional**; {len(s["passes"])} passes on one track.
* The app's map is made on a 55 m grid that is not published; here the same rule runs on the {s["grid"]["pixel_size_m"]:.0f} m site grid.
* MODIS and VIIRS burned-area maps are references, not ground truth, and they disagree with each other.
""")
    keys = [
        "tanase2011",
        "belenguer2019",
        "giglio2018",
        "boschetti2019",
        "schroeder2014",
        "roberts2017",
        "crameri2020",
        "nisar_handbook",
    ]
    if ice:
        keys.insert(5, "aubrywake2022")
    references(
        nb,
        keys,
        data_line="Data: NISAR, NASA-ISRO, via the Alaska Satellite Facility DAAC; MODIS MCD64A1 and VIIRS VNP64A1 burned area and VIIRS 375 m active fire, NASA; ESA WorldCover; GEDI, NASA.",
    )
    return nb
