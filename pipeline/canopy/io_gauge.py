"""River-gauge series (docs/04 §7). The build reads only raw/<site>/gauge.csv;
`cli.py fetch --gauge` writes that file from USGS, or you place an ANA/BWDB export there."""

from __future__ import annotations

import csv
from datetime import date
from pathlib import Path

FT_TO_M = 0.3048
# Verified against station 07381515: parameter 00065 = gage height,
# statistic 00003 = daily mean, unit "ft".
USGS_STAGE_PARAM = "00065"
USGS_DAILY_MEAN = "00003"


def load_csv(path: Path) -> list[tuple[date, float]]:
    """Read `date,stage_m` rows (ISO dates). Blank or non-numeric stages are skipped."""
    rows: list[tuple[date, float]] = []
    with path.open(encoding="utf-8") as fh:
        for rec in csv.DictReader(fh):
            try:
                rows.append((date.fromisoformat(rec["date"][:10]), float(rec["stage_m"])))
            except (KeyError, ValueError):
                continue
    rows.sort()
    return rows


def write_csv(path: Path, rows: list[tuple[date, float]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["date", "stage_m"])
        for d, s in rows:
            w.writerow([d.isoformat(), f"{s:.3f}"])


def fetch_usgs(site_no: str, start: str, end: str) -> list[tuple[date, float]]:
    """Daily mean gage height from the USGS Water Data API, converted to metres.

    Uses `dataretrieval.waterdata` (the legacy waterservices endpoint returned
    HTTP 503 when tested and is being retired). Values are often Provisional.
    """
    try:
        from dataretrieval import waterdata  # pyright: ignore[reportMissingImports]
    except ImportError as exc:  # pragma: no cover
        raise SystemExit("dataretrieval is missing: pip install -e .[real]") from exc
    df, _meta = waterdata.get_daily(
        monitoring_location_id=f"USGS-{site_no}",
        parameter_code=USGS_STAGE_PARAM,
        statistic_id=USGS_DAILY_MEAN,
        time=f"{start}/{end}",
        skip_geometry=True,
    )
    if df.empty:
        raise SystemExit(f"USGS {site_no}: no daily gage height between {start} and {end}")
    units = set(df["unit_of_measure"].dropna())
    factor = {"ft": FT_TO_M, "m": 1.0}
    if not units <= factor.keys():
        raise SystemExit(f"USGS {site_no}: unexpected units {units}")
    rows = [
        (date.fromisoformat(str(t)[:10]), float(v) * factor[u])
        for t, v, u in zip(df["time"], df["value"], df["unit_of_measure"], strict=True)
        if v == v  # skip NaN
    ]
    return sorted(rows)


# ANA (Brazil) Hidro-Telemetria public web service, verified with station
# 14100000 (MANACAPURU, Rio Solimões-Amazonas): 15-minute "Nivel" in centimetres.
ANA_URL = (
    "http://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos"
    "?codEstacao={code}&DataInicio={start}&DataFim={end}"
)


def _get_with_retry(url: str, tries: int = 4) -> str:
    """The ANA service returns sporadic HTTP 500s; back off and retry."""
    import time
    import urllib.error
    import urllib.request

    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as res:  # noqa: S310 - fixed host
                return res.read().decode("utf-8", "replace")
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise
            time.sleep(5 * (attempt + 1))
    return ""


def fetch_ana(code: str, start: str, end: str) -> list[tuple[date, float]]:
    """Daily mean stage (m) from ANA telemetry, requested one month at a time."""
    import re
    from collections import defaultdict
    from datetime import timedelta

    d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
    readings: dict[date, list[float]] = defaultdict(list)
    cur = d0
    while cur <= d1:
        stop = min(cur + timedelta(days=30), d1)
        url = ANA_URL.format(
            code=code, start=cur.strftime("%d/%m/%Y"), end=stop.strftime("%d/%m/%Y")
        )
        xml = _get_with_retry(url)
        for stamp, level in re.findall(
            r"<DataHora>(.*?)</DataHora>.*?<Nivel>(.*?)</Nivel>", xml, re.S
        ):
            try:
                readings[date.fromisoformat(stamp.strip()[:10])].append(float(level) / 100.0)
            except ValueError:
                continue
        cur = stop + timedelta(days=1)
    return sorted((d, sum(v) / len(v)) for d, v in readings.items() if v)
