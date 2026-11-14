"""Shared pieces of the notebook motifs: cell builders, the setup cell, and checked references.

Each motif (water.py, fire.py, ground.py, ice.py) turns one published site into a list of cells.
build_notebooks.py writes them out, packs the site's published files into a folded first cell, and
runs them. Cell text uses @@TOKEN@@ placeholders (not str.format) so code cells keep their braces.
"""

from __future__ import annotations

import base64
import hashlib
import json
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB_DATA = ROOT / "web" / "data"
REPO_URL = "https://github.com/memset2020/under_the_canopy_NASA_SPACE_APP_CHALLENGE"


class Notebook:
    """An ordered list of cells with token replacement."""

    def __init__(self, tokens: dict[str, str] | None = None):
        self.cells: list[dict] = []
        self.tokens = dict(tokens or {})

    def _fill(self, text: str) -> str:
        for k, v in self.tokens.items():
            text = text.replace(f"@@{k}@@", str(v))
        assert "@@" not in text, text[text.index("@@") - 40 : text.index("@@") + 40]
        return text.strip("\n")

    def md(self, text: str) -> None:
        self.cells.append(
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": self._fill(text).splitlines(keepends=True),
            }
        )

    def code(self, text: str) -> None:
        self.cells.append(
            {
                "cell_type": "code",
                "metadata": {},
                "execution_count": None,
                "outputs": [],
                "source": self._fill(text).splitlines(keepends=True),
            }
        )

    def to_json(self) -> dict:
        return {
            "nbformat": 4,
            "nbformat_minor": 5,
            "metadata": {
                "colab": {"provenance": []},
                "kernelspec": {
                    "display_name": "Python 3",
                    "language": "python",
                    "name": "python3",
                },
                "language_info": {"name": "python"},
            },
            "cells": [dict(c, id=f"c{k:02d}") for k, c in enumerate(self.cells)],
        }


# ------------------------------------------------------------------------------------ data packing


def embed_cell(files: list[str]) -> tuple[dict, dict]:
    """A folded code cell that writes `files` (paths under the repository) next to the notebook,
    and {path: sha256} so the app can tell when a published notebook is out of date."""
    packed, digests = {}, {}
    for rel in files:
        data = (ROOT / rel).read_bytes()
        digests[rel] = hashlib.sha256(data).hexdigest()
        packed[rel] = [digests[rel], base64.b64encode(zlib.compress(data, 9)).decode()]
    src = (
        "# The published data this notebook reads, packed inside it (notebooks/build_notebooks.py).\n"
        "# Folded on purpose: it is a few megabytes of base64, not reading.\n"
        "import base64, hashlib, zlib\nfrom pathlib import Path\n\n"
        f"EMBEDDED = {json.dumps(packed, indent=0)}\n\n"
        "for rel, (sha256, blob) in EMBEDDED.items():\n"
        "    data = zlib.decompress(base64.b64decode(blob))\n"
        '    assert hashlib.sha256(data).hexdigest() == sha256, f"{rel} is damaged"\n'
        "    Path(rel).parent.mkdir(parents=True, exist_ok=True)\n"
        "    Path(rel).write_bytes(data)\n"
        'print(f"Unpacked {len(EMBEDDED)} published files ({sum(len(zlib.decompress(base64.b64decode(b))) for _, b in EMBEDDED.values()) / 1e6:.1f} MB).")\n'
    )
    cell = {
        "cell_type": "code",
        "metadata": {"cellView": "form", "jupyter": {"source_hidden": True}},
        "execution_count": None,
        "outputs": [],
        "source": src.splitlines(keepends=True),
    }
    return cell, digests


# ------------------------------------------------------------------------------------ setup cell

# Every notebook starts with the same tools, colours and map frame. `REQUIRED` (a list of paths
# under web/data) is filled in per notebook; the data is normally unpacked by the cell above.
SETUP = r'''
import json
import gzip
import datetime as dt
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.dates as mdates
from matplotlib.colors import ListedColormap, BoundaryNorm, LogNorm

REQUIRED = @@REQUIRED@@

import warnings
# NaN pixels (outside the radar swath) are normal here; NumPy's warning about them is not news.
warnings.filterwarnings("ignore", message="Mean of empty slice")
warnings.filterwarnings("ignore", message="All-NaN slice")
warnings.filterwarnings("ignore", message="No artists with labels")


def find_root() -> Path:
    """Where web/data/ is: unpacked next to this notebook, or in a clone of the repository."""
    for root in (Path.cwd(), Path.cwd().parent, Path("/content")):
        if all((root / "web" / "data" / r).exists() for r in REQUIRED):
            return root
    raise FileNotFoundError("Run the first (folded) cell to unpack the data, or open this notebook inside the project.")


ROOT = find_root()
DATA = ROOT / "web" / "data"

# One meaning per colour, in every notebook of the project (Okabe-Ito, safe for colour-blind readers).
C = dict(water="#0072B2", hidden="#E69F00", dry="#3b4a45", built="#999999", nodata="#000000", burn="#D55E00",
         lband="#E69F00", cband="#56B4E9", gauge="#009E73", swot="#CC79A7", rain="#56B4E9", ink="#222222",
         east="#0072B2", up="#D55E00", model="#009E73", gnss="#CC79A7", ice="#56B4E9", rock="#8a7a5a")
plt.rcParams.update({
    "figure.dpi": 110, "savefig.dpi": 150, "font.size": 10, "axes.titlesize": 11, "axes.titleweight": "bold",
    "axes.spines.top": False, "axes.spines.right": False, "axes.titlelocation": "left", "legend.frameon": False,
})
day = lambda s: dt.date.fromisoformat(str(s)[:10])


def months(ax):
    ax.xaxis.set_major_locator(mdates.MonthLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b"))


def mapframe(ax, bounds, title=None, bar_km=None, light=True):
    """Coordinates, a scale bar and a north arrow on a map drawn with extent=(west, east, south, north)."""
    west, south, east, north = bounds
    km_per_deg = 111.32 * np.cos(np.radians((south + north) / 2))
    width_km = (east - west) * km_per_deg
    bar_km = bar_km or next(b for b in (1, 2, 5, 10, 20, 50, 100, 200) if b >= width_km / 6)
    ink = "white" if light else "black"
    ax.set_xlabel("longitude (°)"); ax.set_ylabel("latitude (°)")
    ax.xaxis.set_major_locator(plt.MaxNLocator(4)); ax.yaxis.set_major_locator(plt.MaxNLocator(4))
    if title:
        ax.set_title(title)
    x0, y0 = west + 0.04 * (east - west), south + 0.05 * (north - south)
    ax.plot([x0, x0 + bar_km / km_per_deg], [y0, y0], color="black" if light else "white", lw=4, solid_capstyle="butt")
    ax.plot([x0, x0 + bar_km / km_per_deg], [y0, y0], color=ink, lw=1.5, solid_capstyle="butt")
    ax.text(x0, y0 + 0.025 * (north - south), f"{bar_km} km", fontsize=8, color=ink, weight="bold")
    xa, ya = east - 0.05 * (east - west), north - 0.05 * (north - south)
    ax.annotate("N", xy=(xa, ya), xytext=(xa, ya - 0.1 * (north - south)), ha="center", color=ink, weight="bold",
                arrowprops=dict(arrowstyle="-|>", color=ink, lw=1.5))


def pearson_ci(x, y):
    """r and its 95 % interval (Fisher z); small samples get wide intervals, and we show them."""
    x, y = np.asarray(x, float), np.asarray(y, float)
    r = np.corrcoef(x, y)[0, 1]
    if len(x) < 4:
        return r, np.nan, np.nan
    z, se = np.arctanh(np.clip(r, -0.999999, 0.999999)), 1 / np.sqrt(len(x) - 3)
    lo, hi = np.tanh([z - 1.96 * se, z + 1.96 * se])
    return r, lo, hi


print("Reading", DATA)
'''


def setup_cell(nb: Notebook, required: list[str]) -> None:
    nb.code(SETUP.replace("@@REQUIRED@@", json.dumps(required)))


# ------------------------------------------------------------------------------------ references

# Each checked by search (D-096, D-098); page ranges not seen are marked (verify).
REFS = {
    "hess1990": "Hess, L. L., Melack, J. M., and Simonett, D. S. (1990). Radar detection of flooding beneath the forest canopy: a review. *International Journal of Remote Sensing* 11(7), 1313–1325.",
    "hess2003": "Hess, L. L., Melack, J. M., Novo, E. M. L. M., Barbosa, C. C. F., and Gastil, M. (2003). Dual-season mapping of wetland inundation and vegetation for the central Amazon basin. *Remote Sensing of Environment* 87, 404–428 (verify pages).",
    "hess2015": "Hess, L. L., et al. (2015). Wetlands of the lowland Amazon basin: extent, vegetative cover, and dual-season inundated area as mapped with JERS-1 synthetic aperture radar. *Wetlands* 35, 745–756 (verify pages). Data: ORNL DAAC, doi:10.3334/ORNLDAAC/1284.",
    "rosenqvist2020": "Rosenqvist, J., Rosenqvist, A., Jensen, K., and McDonald, K. (2020). Mapping of maximum and minimum inundation extents in the Amazon basin 2014–2017 with ALOS-2 PALSAR-2 ScanSAR time-series data. *Remote Sensing* 12(8), 1326.",
    "tsyganskaya2018": "Tsyganskaya, V., Martinis, S., Marzahn, P., and Ludwig, R. (2018). SAR-based detection of flooded vegetation – a review of characteristics and approaches. *International Journal of Remote Sensing* 39(8), 2255–2293.",
    "roberts2017": "Roberts, D. R., et al. (2017). Cross-validation strategies for data with temporal, spatial, hierarchical, or phylogenetic structure. *Ecography* 40(8), 913–929.",
    "olofsson2014": "Olofsson, P., et al. (2014). Good practices for estimating area and assessing accuracy of land change. *Remote Sensing of Environment* 148, 42–57.",
    "bonafilia2020": "Bonafilia, D., Tellman, B., Anderson, T., and Issenberg, E. (2020). Sen1Floods11: a georeferenced dataset to train and test deep learning flood algorithms for Sentinel-1. *CVPR Workshops*, 210–211.",
    "crameri2020": "Crameri, F., Shephard, G. E., and Heron, P. J. (2020). The misuse of colour in science communication. *Nature Communications* 11, 5444.",
    "pekel2016": "Pekel, J.-F., Cottam, A., Gorelick, N., and Belward, A. S. (2016). High-resolution mapping of global surface water and its long-term changes. *Nature* 540, 418–422.",
    "nobre2011": "Nobre, A. D., et al. (2011). Height Above the Nearest Drainage – a hydrologically relevant new terrain model. *Journal of Hydrology* 404, 13–29.",
    "dubayah2020": "Dubayah, R., et al. (2020). The Global Ecosystem Dynamics Investigation: high-resolution laser ranging of the Earth's forests and topography. *Science of Remote Sensing* 1, 100002.",
    "nisar_handbook": "NASA-ISRO SAR (NISAR) Mission Science Users' Handbook, NASA Jet Propulsion Laboratory ([nisar.jpl.nasa.gov](https://nisar.jpl.nasa.gov)).",
    "tanase2011": "Tanase, M. A. (2011). *Remote sensing of burn severity using synthetic aperture radar* (PhD thesis, X-, C- and L-band over Mediterranean pine forests). University of Zaragoza ([zaguan.unizar.es/record/5735](https://zaguan.unizar.es/record/5735)).",
    "belenguer2019": "Belenguer-Plomer, M. A., Tanase, M. A., Fernandez-Carrillo, A., and Chuvieco, E. (2019). Burned area detection and mapping using Sentinel-1 backscatter coefficient and thermal anomalies. *Remote Sensing of Environment* 233, 111345.",
    "giglio2018": "Giglio, L., Boschetti, L., Roy, D. P., Humber, M. L., and Justice, C. O. (2018). The Collection 6 MODIS burned area mapping algorithm and product. *Remote Sensing of Environment* 217, 72–85.",
    "boschetti2019": "Boschetti, L., et al. (2019). Global validation of the Collection 6 MODIS burned area product. *Remote Sensing of Environment* 235, 111490.",
    "schroeder2014": "Schroeder, W., Oliva, P., Giglio, L., and Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: algorithm description and initial assessment. *Remote Sensing of Environment* 143, 85–96.",
    "aubrywake2022": "Aubry-Wake, C., Bertoncini, A., and Pomeroy, J. W. (2022). Fire and ice: the impact of wildfire-affected albedo and irradiance on glacier melt. *Earth's Future* 10, e2022EF002685.",
    "wright2004": "Wright, T. J., Parsons, B. E., and Lu, Z. (2004). Toward mapping surface deformation in three dimensions using InSAR. *Geophysical Research Letters* 31, L01607.",
    "okada1985": "Okada, Y. (1985). Surface deformation due to shear and tensile faults in a half-space. *Bulletin of the Seismological Society of America* 75(4), 1135–1154.",
    "doin2009": "Doin, M.-P., Lasserre, C., Peltzer, G., Cavalié, O., and Doubre, C. (2009). Corrections of stratified tropospheric delays in SAR interferometry: validation with global atmospheric models. *Journal of Applied Geophysics* 69, 35–50.",
    "chaussard2014": "Chaussard, E., Wdowinski, S., Cabral-Cano, E., and Amelung, F. (2014). Land subsidence in central Mexico detected by ALOS InSAR time-series. *Remote Sensing of Environment* 140, 94–106.",
    "blewitt2018": "Blewitt, G., Hammond, W. C., and Kreemer, C. (2018). Harnessing the GPS data explosion for interdisciplinary science. *Eos* 99, doi:10.1029/2018EO104623.",
    "gardner2018": "Gardner, A. S., et al. (2018). Increased West Antarctic and unchanged East Antarctic ice discharge over the last 7 years. *The Cryosphere* 12, 521–547. ITS_LIVE data: doi:10.5067/JQ6337239C96 (as cited in the app's glacier files).",
    "joughin2004": "Joughin, I., Abdalati, W., and Fahnestock, M. (2004). Large fluctuations in speed on Greenland's Jakobshavn Isbræ glacier. *Nature* 432, 608–610.",
    "hugonnet2021": "Hugonnet, R., et al. (2021). Accelerated global glacier mass loss in the early twenty-first century. *Nature* 592, 726–731.",
    "watkins2015": "Watkins, M. M., Wiese, D. N., Yuan, D.-N., Boening, C., and Landerer, F. W. (2015). Improved methods for observing Earth's time variable mass distribution with GRACE using spherical cap mascons. *Journal of Geophysical Research: Solid Earth* 120, 2648–2671.",
}


def references(
    nb: Notebook, keys: list[str], extra: tuple[str, ...] = (), data_line: str = ""
) -> None:
    lines = [f"{k + 1}. {REFS[key]}" for k, key in enumerate(keys)]
    lines += [f"{len(keys) + k + 1}. {e}" for k, e in enumerate(extra)]
    lines.append(
        f"{len(lines) + 1}. This project: `docs/03_ARCHITECTURE.md` §4 (the files), `docs/10_DECISIONS_AND_RISKS.md` (why each choice was made)."
    )
    nb.md(
        "## References\n\n"
        + "\n".join(lines)
        + (f"\n\n*{data_line}*" if data_line else "")
    )


def title_block(nb: Notebook, title: str, subtitle: str, kind_label: str) -> None:
    nb.md(f"""
# {title}
### {subtitle}

*A notebook from the [Under the Canopy]({REPO_URL}) project, NASA Space Apps 2026 · {kind_label}*

---
""")
