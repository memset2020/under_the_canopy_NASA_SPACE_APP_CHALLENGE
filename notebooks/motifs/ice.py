"""Glaciers in motion: the notebook motif for the Ice mode's glaciers.

Reads web/data/glaciers/<id>/glacier.json and glacier.bin.gz (uint16/int16 planes then the annual
speed maps, gzip; glaciers.py), checks the decode against the published statistics, and tells the
glacier's story through ITS_LIVE speed (the app's source), the flowline through 40 years, trend and
season, published checks, and GRACE mass change. NISAR's own ice offsets are named for what they
are: counted in NASA's catalogue, tested on the Columbia Icefield, not yet resolving these glaciers.
"""

from __future__ import annotations

import json

from .common import WEB_DATA, Notebook, references, setup_cell, title_block

KIND_TEXT = {
    "outlet": "an **outlet glacier**: a fast river of ice draining an ice sheet to the sea. Its speed is set at its front, where warm ocean water can melt and thin the ice, and a few such glaciers carry much of the ice sheets' loss to the ocean (Joughin et al. 2004 showed one of them, Jakobshavn, doubling its speed in a decade).",
    "tidewater": "a **tidewater glacier**: it ends in the sea and loses ice by calving icebergs. Tidewater glaciers can retreat or advance quickly, partly independent of climate, because the depth of water at the front controls how fast they calve.",
    "mountain": "a **mountain glacier**: fed by snow high up, it flows down a valley and melts at its tongue. Mountain glaciers respond to summer warmth and winter snow, and most have been thinning and slowing as they lose mass.",
    "lake": "a **lake-terminating glacier**: it ends in a lake, often one its own retreat created. Water at the front speeds calving and melt, so these glaciers can retreat faster than their neighbours on land.",
    "surge": "a **surge-type glacier**: for years or decades it barely moves, then for a few months or years it races forward many times faster, as water at its bed lets it slide. A speed record is the best way to catch a surge.",
    "piedmont": "a **piedmont glacier**: it spills out of the mountains onto a flat plain and spreads into a wide lobe, slow at the edges, faster where valley glaciers feed it.",
}


def files(gid: str) -> list[str]:
    return [f"web/data/glaciers/{gid}/{f}" for f in ("glacier.json", "glacier.bin.gz")]


def build(gid: str) -> Notebook:
    g = json.loads((WEB_DATA / "glaciers" / gid / "glacier.json").read_text())
    nb = Notebook({"GID": gid})
    kind_text = KIND_TEXT.get(g["kind"], f"a {g['kind']} glacier.")
    title_block(
        nb,
        f"A glacier in motion: {g['name']}",
        "Reading forty years of glacier speed from satellites, and what NISAR adds",
        "ice",
    )
    nb.md(f"""
Glaciers are rivers of ice. They flow downhill under their own weight, metres to kilometres a year, and how fast
they flow tells us how they are changing: a glacier that speeds up may be losing ice to the ocean, one that slows
may be thinning and dying. Worldwide, glaciers lost 267 ± 16 billion tonnes of ice a year from 2000 to 2019, a
fifth of the sea-level rise in that time, and the loss is accelerating (Hugonnet et al. 2021).

**{g["name"]}** ({g["country"]}) is {kind_text}

This notebook reads the same data as the Under the Canopy app:

| Chapters | Question |
|:--|:--|
| 1–2 | Where is it, and how do satellites measure the speed of ice? |
| 3–4 | How fast does it flow, and where? |
| 5–6 | How has it changed in 40 years, and through each year? |
| 7–8 | Does it agree with published measurements, and how much ice is the region losing? |
| 9 | How sure are we, and what can NISAR add? |

**Real data only.** The speeds come from NASA's MEaSUREs ITS_LIVE project (Gardner et al. 2018), built from
millions of Landsat and Sentinel image pairs; the regional mass change from NASA/JPL's GRACE and GRACE-FO
satellites (Watkins et al. 2015).
""")
    nb.md("""
## 0 · Setting up

Run the cells in order (*Runtime → Run all* in Colab). The first, folded cell unpacks the published data. Speed
spans a hundredfold range (slow edges, fast trunk), so speed maps use a **logarithmic** colour scale; changes use
a **diverging** map centred on zero; everything else uses perceptually uniform maps, never a rainbow (Crameri et
al. 2020).
""")
    setup_cell(nb, [f"glaciers/{gid}/glacier.json", f"glaciers/{gid}/glacier.bin.gz"])

    # 1 -------------------------------------------------------------------------------------------
    nb.md("""
## 1 · The glacier, and who looked
""")
    nb.code(r"""
GID = "@@GID@@"
doc = json.loads((DATA / "glaciers" / GID / "glacier.json").read_text())
W, H = doc["grid"]["width"], doc["grid"]["height"]
west, south, east, north = BOUNDS = doc["bounds"]
extent = (west, east, south, north)
print(f"{doc['name']} ({doc['country']}) · {doc['kind']} glacier · RGI region {doc['region']}")
print(f"Box {west}–{east}°E, {south}–{north}°N · {W} × {H} cells of {doc['grid']['cell_m']:.0f} m ({doc['grid']['crs']}, drawn here in longitude–latitude)")
print("Speed source:", doc["source"]["name"])
print("Citation:", doc["source"]["cite"])
n = doc.get("nisar") or {}
if n:
    print("NISAR products over this glacier in NASA's catalogue: " + ", ".join(f"{k} {v['n']} (latest {v['latest']})" for k, v in n.items()))
""")

    # 2 -------------------------------------------------------------------------------------------
    nb.md("""
## 2 · How satellites measure the speed of ice

Take two images of the same glacier, days or weeks apart. Crevasses, rocks and dirt bands on the ice have moved.
Find each small patch of the first image in the second (*feature tracking* by cross-correlation), measure how far
it moved, divide by the time between the images: that is the speed. ITS_LIVE does this for millions of image
pairs from Landsat (optical) and Sentinel-1 (radar) and Sentinel-2, and averages them into maps.

NISAR's **GOFF** product (geocoded pixel offsets) is the same idea with radar images 12 days apart: it works through
clouds and in polar night. Its limit, measured by the project on the Columbia Icefield, is that a slow glacier
whose surface melts within 12 days changes too much to be tracked (decision D-085).
""")
    nb.code(r"""
fig, axs = plt.subplots(1, 3, figsize=(13, 3.6))
rng = np.random.default_rng(1)
tex = rng.random((40, 40)); tex = (tex + np.roll(tex, 1, 0) + np.roll(tex, 1, 1)) / 3
for ax, shift, t in [(axs[0], 0, "image 1 (day 0)"), (axs[1], 6, "image 2 (day 12): the ice moved")]:
    ax.imshow(np.roll(tex, shift, 1), cmap="gray"); ax.set_xticks([]); ax.set_yticks([]); ax.set_title(t)
    ax.add_patch(mpatches.Rectangle((12 + shift, 14), 10, 10, fill=False, ec=C["burn"], lw=2))
axs[1].annotate("", xy=(18, 19), xytext=(12, 19), arrowprops={"arrowstyle": "-|>", "color": C["ink"], "lw": 2})
lags = np.arange(-12, 13); score = [np.corrcoef(tex[14:24, 12:22].ravel(), np.roll(tex, 6, 1)[14:24, 12 + l:22 + l].ravel())[0, 1] for l in lags]
axs[2].plot(lags, score, "o-", color=C["ink"]); axs[2].axvline(6, color=C["burn"], ls=":")
axs[2].set_xlabel("trial shift (pixels)"); axs[2].set_ylabel("match (correlation)"); axs[2].set_title("The best match is the displacement")
plt.tight_layout(); plt.show()
""")
    nb.md(
        "The patch (box) is searched for in the second image at every trial shift; the shift where the two match best is how far the ice moved. Speed = displacement ÷ time."
    )

    # 3 decode + map ----------------------------------------------------------------------------------
    nb.md("""
## 3 · How fast it flows, and where

The file holds several maps (*planes*) as 16-bit integers with a scale each: speed, its east and north parts,
the trend over the decade, the size and timing of the seasonal cycle, the error, a surface class (ice, rock,
floating ice, no data) and terrain. The first line checks the decode against the app's published statistics.
""")
    nb.code(r"""
raw = np.frombuffer(gzip.decompress((DATA / "glaciers" / GID / "glacier.bin.gz").read_bytes()), "<u2")
npl = len(doc["planes"])
maps = raw[: npl * W * H].reshape(npl, H, W)


def plane(pid):
    k = next(i for i, p in enumerate(doc["planes"]) if p["id"] == pid)
    p = doc["planes"][k]
    if p["signed"]:
        q = maps[k].view(np.int16).astype(float); bad = q == doc["nodata_i16"]
    else:
        q = maps[k].astype(float); bad = q == doc["nodata_u16"]
    q = q * p["scale"]; q[bad] = np.nan
    return q


speed, ve, vn = plane("speed"), plane("east"), plane("north")
surface = plane("surface")
ice = surface == 1
vals = speed[np.isfinite(speed) & ice]
# The app's statistics were computed before the maps were stored in 0.1 m/yr steps, so a value on a
# rounding edge (49.5 → 49 or 50) may differ by one: agreement within 1 m/yr is exact for our purpose.
assert abs(np.percentile(vals, 99.5) - doc["stats"]["max_m_yr"]) <= 1 and abs(np.median(vals) - doc["stats"]["median_m_yr"]) <= 1
print(f"Decode check: fastest ice {doc['stats']['max_m_yr']:,} m/yr (99.5th percentile), median {doc['stats']['median_m_yr']:,} m/yr, as the app says.")
print(f"That is up to {doc['stats']['max_m_yr'] / 365:.1f} m a day. Ice with a speed: {doc['stats']['ice_km2']:,} km².")

SURF = ListedColormap([C["ice"], "#a9c9d9", C["rock"], "#dddddd", "#1f6f8b"])
fig, (a1, a2) = plt.subplots(1, 2, figsize=(15, 15 * H / W / 2 + 1.6))
a1.imshow(np.where(np.isfinite(surface), surface, np.nan), extent=extent, cmap=SURF, vmin=0.5, vmax=5.5, interpolation="nearest")
mapframe(a1, BOUNDS, "What each cell is", light=False)
a1.legend(handles=[mpatches.Patch(color=c_, label=l_) for c_, l_ in zip([C["ice"], "#a9c9d9", C["rock"], "#dddddd", "#1f6f8b"],
                   ["ice with a speed", "ice, no speed", "rock", "no measurement", "floating ice / mélange"])], fontsize=8, loc="lower right", frameon=True)
im = a2.imshow(np.where(speed > 0, speed, np.nan), extent=extent, cmap="cividis", norm=LogNorm(vmin=max(1, np.nanpercentile(speed, 5)), vmax=np.nanpercentile(speed, 99.5)))
a2.set_facecolor("#3a3a3a")
step = max(W, H) // 28
yy, xx = np.mgrid[step // 2:H:step, step // 2:W:step]
lon_s = west + (xx + 0.5) * (east - west) / W; lat_s = north - (yy + 0.5) * (north - south) / H
u, v = ve[yy, xx], vn[yy, xx]; sp = np.hypot(u, v); sp = np.where(sp > 0, sp, np.nan)
keep = np.isfinite(sp) & (sp > np.nanpercentile(speed, 50)) & ice[yy, xx]
a2.quiver(lon_s[keep], lat_s[keep], (u / sp)[keep], (v / sp)[keep], color="white", scale=35, width=0.002, alpha=0.8)
fl = doc["flowline"]; a2.plot(fl["lon"], fl["lat"], color=C["burn"], lw=2)
mapframe(a2, BOUNDS, f"Speed, {doc['source']['static_years'][0]}–{doc['source']['static_years'][1]} (log scale; arrows = direction; orange = flowline)")
fig.colorbar(im, ax=a2, shrink=0.75, label="m per year")
plt.tight_layout(); plt.show()
""")
    nb.md("""
**Reading the speed map.** Ice is fastest in the middle of the main trunk and near the front, slowest at the
edges where it rubs against rock, just like a river. The arrows show which way it flows; the orange line is the
**flowline** the project traced down the trunk, which the next chapters follow through time.
""")

    # 4 flowline profile ------------------------------------------------------------------------------
    nb.md("""
## 4 · Along the flowline

Follow the orange line from the top of the glacier to its front, and plot the speed along it. Speed usually grows
toward the front (more ice converging, steeper slopes, or the pull of the ocean), then may fall where the ice
spreads or grounds.
""")
    nb.code(r"""
km = np.asarray(fl["km"]); mean_v = np.asarray(fl["mean_m_yr"], float)
fig, ax = plt.subplots(figsize=(11, 3.8))
ax.plot(km, mean_v, color=C["ink"], lw=2)
ax.fill_between(km, 0, mean_v, color=C["ice"], alpha=0.3)
ax.axvline(fl["front_km"], color=C["burn"], ls=":"); ax.text(fl["front_km"], np.nanmax(mean_v) * 0.95, " front", color=C["burn"])
ax.set_xlabel("distance down the flowline (km)"); ax.set_ylabel("speed (m/yr)"); ax.set_title("Speed along the flowline")
plt.tight_layout(); plt.show()
""")

    # 5 history ----------------------------------------------------------------------------------------
    nb.md("""
## 5 · Forty years in one picture

ITS_LIVE also has a speed map for **every year** since 1985 (where images allow). Sampling each year along the
flowline gives a picture glaciologists use constantly: distance down the glacier across, year down, colour =
speed. A speed-up shows as a band of colour; a surge as a sudden bright year; a retreating front as the fast
zone moving up-glacier.
""")
    nb.code(r"""
hist = doc["history"]
years = hist["years"]
S = np.array([[np.nan if v is None else v for v in row] for row in hist["speed"]], float)
fig = plt.figure(figsize=(14, 6))
a1 = fig.add_axes([0.06, 0.1, 0.55, 0.82])
kmh = np.linspace(km.min(), km.max(), S.shape[1])
im = a1.imshow(np.where(S > 0, S, np.nan), aspect="auto", cmap="cividis", norm=LogNorm(vmin=max(1, np.nanpercentile(S, 5)), vmax=np.nanpercentile(S, 99)),
               extent=(kmh[0], kmh[-1], years[-1] + 0.5, years[0] - 0.5))
a1.set_facecolor("#3a3a3a"); a1.set_xlabel("distance down the flowline (km)"); a1.set_ylabel("year"); a1.set_title("Speed along the flowline, year by year (grey = no data)")
fig.colorbar(im, ax=a1, label="m/yr")
a2 = fig.add_axes([0.70, 0.1, 0.28, 0.82])
tr = hist.get("trunk") or []
ty = [y for y, t in zip(years, tr) if t and t.get("v") is not None]
tv = [t["v"] for t in tr if t and t.get("v") is not None]; te = [t.get("err") or 0 for t in tr if t and t.get("v") is not None]
a2.errorbar(tv, ty, xerr=te, fmt="o", color=C["ink"], ms=4, ecolor="#bbb", capsize=0, label="trunk (± ITS_LIVE error)")
fr = hist.get("front") or []
fy = [y for y, f in zip(years, fr) if f is not None]
a2.plot([f for f in fr if f is not None], fy, ".-", color=C["burn"], label="near the front")
a2.invert_yaxis(); a2.set_xlabel("m/yr"); a2.set_title("Trunk and front, year by year"); a2.legend(fontsize=8)
a2.xaxis.set_major_locator(plt.MaxNLocator(4))
plt.show()
if len(tv) >= 6:
    first, last = np.nanmedian(tv[:5]), np.nanmedian(tv[-5:])
    print(f"Trunk speed: median {first:,.0f} m/yr in {ty[0]}–{ty[min(4, len(ty) - 1)]}, {last:,.0f} m/yr in {ty[-5]}–{ty[-1]} ({100 * (last - first) / first:+.0f} %).")
""")
    nb.md(
        "**Mind the error bars.** Early years have fewer image pairs (Landsat 4–5 only), so their speeds are less certain. A change counts only where it is larger than the error, and only if neighbouring years agree."
    )

    # 6 trend + season --------------------------------------------------------------------------------
    nb.md("""
## 6 · Speeding up or slowing down, and through each year

Two more maps from ITS_LIVE's fit at every cell: the **trend** (how fast the speed changed per year over the
decade) and the **seasonal cycle** (how much faster the ice moves in its fastest season, and when). Meltwater
reaching the bed lubricates it, so many glaciers speed up in early summer.
""")
    nb.code(r"""
trend, amp, phase = plane("trend"), plane("amp"), plane("phase")
fig, axs = plt.subplots(1, 3, figsize=(17, 17 * H / W / 3 + 1.6))
lim = max(abs(doc["stats"]["trend_p02"]), abs(doc["stats"]["trend_p98"]), 0.5)
im = axs[0].imshow(np.where(ice, trend, np.nan), extent=extent, cmap="RdBu_r", vmin=-lim, vmax=lim); axs[0].set_facecolor("#ddd")
mapframe(axs[0], BOUNDS, "Trend (red = speeding up)", light=False); fig.colorbar(im, ax=axs[0], shrink=0.75, label="m/yr per year")
im = axs[1].imshow(np.where(ice, amp, np.nan), extent=extent, cmap="cividis", vmax=np.nanpercentile(amp[ice], 98)); axs[1].set_facecolor("#ddd")
mapframe(axs[1], BOUNDS, "Seasonal swing (amplitude)", light=False); fig.colorbar(im, ax=axs[1], shrink=0.75, label="m/yr")
im = axs[2].imshow(np.where(ice & (amp > np.nanpercentile(amp[ice], 50)), phase, np.nan), extent=extent, cmap="twilight", vmin=0, vmax=365); axs[2].set_facecolor("#ddd")
mapframe(axs[2], BOUNDS, "Day of year it flows fastest (where the swing is large)", light=False)
cb = fig.colorbar(im, ax=axs[2], shrink=0.75); cb.set_ticks([1, 91, 182, 274, 365]); cb.set_ticklabels(["Jan", "Apr", "Jul", "Oct", "Dec"])
plt.tight_layout(); plt.show()
print(f"ITS_LIVE could fit a seasonal cycle at {doc['stats'].get('seasonal_share', float('nan')):.0%} of the cells that have a speed; "
      f"where it could, the median swing is {np.nanmedian(amp[ice]):,.0f} m/yr against a median speed of {np.nanmedian(speed[ice]):,.0f} m/yr.")
""")
    nb.md(
        "The day-of-year map uses a **cyclic** colour map (*twilight*), because 31 December is next to 1 January: a straight colour scale would put them at opposite ends."
    )

    # 7 annual small multiples -------------------------------------------------------------------------
    nb.md("""
## 7 · Year by year, as maps

The annual speed maps, at half resolution, on one colour scale: small multiples let the eye compare years
without remembering.
""")
    nb.code(r"""
ag = doc["annual_grid"]; aw, ah = ag["width"], ag["height"]
ann = raw[npl * W * H:].reshape(len(ag["years"]), ah, aw).astype(float)
ann[ann == doc["nodata_u16"]] = np.nan; ann *= ag["scale"]
pick = np.unique(np.linspace(0, len(ag["years"]) - 1, 8).astype(int))
vmax = np.nanpercentile(ann, 99.5)
fig, axs = plt.subplots(1, len(pick), figsize=(2.2 * len(pick), 2.4 * ah / aw + 0.8), squeeze=False)
for ax, k in zip(axs[0], pick):
    ax.imshow(np.where(ann[k] > 0, ann[k], np.nan), cmap="cividis", norm=LogNorm(vmin=max(1, np.nanpercentile(ann, 5)), vmax=vmax))
    ax.set_facecolor("#3a3a3a"); ax.set_xticks([]); ax.set_yticks([]); ax.set_title(str(ag["years"][k]), fontsize=9)
plt.suptitle("Annual speed (same log scale; grey = no measurement that year)", x=0.01, ha="left", weight="bold")
plt.tight_layout(); plt.show()
""")

    # 8 checks + GRACE ---------------------------------------------------------------------------------
    nb.md("""
## 8 · Checks: published measurements, and the region's ice mass

**Published speeds.** Where field or satellite studies have published a speed for this glacier, the project
compared it with ITS_LIVE for the same year and place. Agreement within the measurements' errors builds trust;
a mismatch is a question.

**GRACE.** The GRACE and GRACE-FO satellites weigh the Earth's water and ice from orbit by measuring tiny changes
in gravity. Their monthly *mascons* (Watkins et al. 2015) give the mass change of the whole region around this
glacier, in gigatonnes (1 Gt = a cube of ice about 1 km on a side).
""")
    nb.code(r"""
for c in doc.get("checks") or []:
    if "published_m_yr" in c:
        line = f"• {c['what']} ({c['year']}): published {c['published_m_yr']:,} m/yr"
        if c.get("itslive_m_yr") is not None:
            line += f", ITS_LIVE {c['itslive_m_yr']:,} m/yr (ratio {c.get('ratio', float('nan')):.2f})"
        else:
            line += ", no ITS_LIVE map that year to compare"
    else:
        line = f"• {c['what']}: ITS_LIVE {c.get('itslive_from_m_yr', '?'):,} → {c.get('itslive_to_m_yr', '?'):,} m/yr ({c.get('change_pct', '?')} %)"
    print(line + (f" — {'agrees' if c.get('agrees') else 'differs'}" if "agrees" in c else "") + f"\n    {c['source']}")
if not doc.get("checks"):
    print("No published speed for this glacier was found to compare with (a gap worth filling).")

gr = doc.get("grace") or {}
if gr.get("months"):
    t = [day(m_ + "-15") for m_ in gr["months"]]
    fig, ax = plt.subplots(figsize=(11, 3.8))
    ax.plot(t, gr["gt"], ".", color=C["ink"], ms=3, label="monthly mass (GRACE / GRACE-FO)")
    tt = np.array([d.toordinal() / 365.25 for d in t]); fit = np.polyfit(tt, gr["gt"], 1)
    ax.plot(t, np.polyval(fit, tt), color=C["burn"], lw=2, label=f"trend {fit[0]:+.1f} Gt/yr")
    ax.set_ylabel("Gt (relative)"); ax.set_title(f"Ice and water mass of {gr['region']} (GRACE mascons)"); ax.legend()
    plt.tight_layout(); plt.show()
    print(f"App's trend for the region: {gr.get('trend_gt_yr')} Gt/yr (2002–2019 only: {gr.get('trend_2002_2019_gt_yr')} Gt/yr).")
    if gr.get("published"):
        p_ = gr["published"]
        print(f"Published for {p_['period']}: {p_['gt_yr']} ± {p_['err']} Gt/yr ({p_['source']})")
""")
    nb.md(
        "**Scale matters.** GRACE sees a region hundreds of kilometres across, not one glacier: it tells you whether the glacier's neighbourhood is losing ice, which is the context for whatever this one glacier does."
    )

    # 9 uncertainty + NISAR ----------------------------------------------------------------------------
    nb.md("""
## 9 · How sure are we, and what can NISAR add?

**The rock test.** Rock does not flow, so any "speed" measured on rock is error. The spread of speeds on rock is
the honest noise floor of the speed map; only motion well above it is real.
""")
    nb.code(r"""
err = plane("error")
rock = surface == 3
fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4))
rv = speed[rock & np.isfinite(speed)]
if rv.size:
    a1.hist(rv, bins=np.linspace(0, np.nanpercentile(rv, 99), 60), color=C["rock"])
    a1.set_xlabel("apparent speed on rock (m/yr)"); a1.set_ylabel("cells"); a1.set_title(f"Noise floor: rock median {np.median(rv):.1f} m/yr")
im = a2.imshow(np.where(ice, err, np.nan), extent=extent, cmap="cividis", vmax=np.nanpercentile(err[ice], 98)); a2.set_facecolor("#ddd")
mapframe(a2, BOUNDS, "ITS_LIVE error on the ice", light=False); fig.colorbar(im, ax=a2, shrink=0.8, label="m/yr")
plt.tight_layout(); plt.show()
if rv.size:
    print(f"Ice moving faster than twice the rock 95th percentile ({2 * np.percentile(rv, 95):.1f} m/yr): {(speed[ice] > 2 * np.percentile(rv, 95)).mean():.0%} of the ice cells.")
n = doc.get("nisar") or {}
print("NISAR over this glacier so far: " + (", ".join(f"{k}: {v['n']}" for k, v in n.items()) if n else "none in the catalogue"))
""")
    nb.md("""
**What NISAR adds.** NISAR images every glacier on Earth every 12 days, through cloud and polar night, and its
GOFF offsets measure ice motion directly. On the Columbia Icefield the project tested them and found that slow,
melting glaciers decorrelate in 12 days (decision D-085); fast outlet and tidewater glaciers, which move metres a
day, are where NISAR's offsets should work first. Testing that here, against the ITS_LIVE map above, is the obvious
next study.

## What would you study next?

1. **NISAR against ITS_LIVE.** Download this glacier's NISAR GOFF granules (counted above) from the Alaska Satellite
   Facility and compare their speeds with the map here, cell by cell, with the rock test as the noise floor.
2. **What drives the change?** Compare the trunk's speed record with the region's GRACE mass loss, and with ocean
   or air temperature records: does speed-up follow warm years?
3. **The front.** Track where the fast zone ends, year by year: is the front retreating?
4. **Seasons.** Is the fastest day of year changing, as melt starts earlier?

## Limits

* ITS_LIVE speeds are averages of many image pairs; early years and cloudy regions have fewer.
* The grid is Web Mercator, drawn here in longitude–latitude: shapes are slightly stretched near the poles.
* GRACE measures a region hundreds of kilometres wide, not this glacier alone.
* NISAR's own ice offsets are provisional and, on slow melting glaciers, not yet resolving speed.
""")
    keys = [
        "hugonnet2021",
        "gardner2018",
        "watkins2015",
        "crameri2020",
        "nisar_handbook",
    ]
    if gid == "jakobshavn" or g["kind"] == "outlet":
        keys.insert(2, "joughin2004")
    references(
        nb,
        keys,
        extra=tuple(
            f"{c['source']}" + (f" ({c['url']})" if c.get("url") else "")
            for c in (g.get("checks") or [])
        ),
        data_line=f"Data: {g['source']['name']}; {g.get('grace', {}).get('source', 'NASA/JPL GRACE mascons')}; terrain: {g.get('relief_source', 'Copernicus DEM')}; NISAR granule counts from NASA CMR.",
    )
    return nb
