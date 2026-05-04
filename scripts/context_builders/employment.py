"""
context_builders/employment.py — Compose employment.json from cached
BLS QCEW + LAUS + BEA REIS + CDLE OEWS.

QCEW supersector NAICS-2 → narrative buckets (Construction, Retail, Health,
Accommodation/Food, Arts/Ent, Professional, Government, Other) follows the
plan's enumeration in `latest` keys.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from context_schema import build_envelope, source, trend_series
from geographies import STATE_FIPS, COUNTY_FIPS

CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "context-cache"
QCEW_DIR = CACHE_DIR / "bls" / "qcew" / "annual"
BLS_V2_DIR = CACHE_DIR / "bls" / "v2"
BEA_DIR = CACHE_DIR / "bea"

QCEW_YEARS = list(range(2002, 2026))


def _latest_qcew_year(area_fips: str) -> int | None:
    """Walk back through QCEW_YEARS until we find a year whose annual file
    exists for this area. Annual QCEW lags ~6 months — the most recent
    QCEW_YEARS entry is typically not yet published, so the builder must
    discover the actual latest vintage rather than blindly indexing [-1]."""
    for y in reversed(QCEW_YEARS):
        path = QCEW_DIR / f"{y}-{area_fips}.csv"
        if path.exists() and path.stat().st_size > 0:
            return y
    return None

# QCEW NAICS-2 supersector codes (industry_code) → topic key.
# See https://www.bls.gov/cew/classifications/industry/qcew-naics-classifications.htm
QCEW_NAICS_TO_KEY: dict[str, str] = {
    "10": "qcewTotalEmp",          # total covered (own_code = 0)
    "1023": "naicsConstruction",   # NAICS 23
    "1044": "naicsRetail",         # 44–45 retail
    "1062": "naicsHealthCare",     # 62 health care + soc assist
    "1071": "naicsArtsEnt",        # 71 arts/ent
    "1072": "naicsAccommFood",     # 72 accommodation/food
    "1054": "naicsProfSvc",        # 54 prof/sci/tech
    "1092": "naicsGovt",           # 92 public admin
}


def _read_qcew_annual(year: int, area_fips: str) -> list[dict]:
    path = QCEW_DIR / f"{year}-{area_fips}.csv"
    if not path.exists():
        return []
    with path.open() as f:
        return list(csv.DictReader(f))


def _qcew_total_for_area(rows: list[dict]) -> dict:
    """Pull total covered employment (industry_code='10', own_code='0')
    plus per-supersector employment for the configured NAICS codes."""
    block: dict = {}
    for r in rows:
        ic = r.get("industry_code") or r.get("industryCode")
        oc = r.get("own_code") or r.get("ownCode")
        if ic == "10" and oc == "0":
            try:
                block["qcewTotalEmp"] = int(r["annual_avg_emplvl"])
                block["qcewAvgWeeklyWage"] = int(r["annual_avg_wkly_wage"])
            except (KeyError, ValueError, TypeError):
                pass
        elif ic in QCEW_NAICS_TO_KEY and oc == "0":
            try:
                block[QCEW_NAICS_TO_KEY[ic]] = int(r["annual_avg_emplvl"])
            except (KeyError, ValueError, TypeError):
                pass
    return block


def _qcew_trend_for_area(area_fips: str, key: str) -> list[dict]:
    pairs = []
    for y in QCEW_YEARS:
        rows = _read_qcew_annual(y, area_fips)
        if not rows:
            continue
        block = _qcew_total_for_area(rows)
        v = block.get(key)
        pairs.append((y, v))
    return trend_series(pairs)


def _laus_for_geo(series_ids: list[str]) -> dict:
    """Find the cached BLS v2 response file containing these series and
    pull latest unemployment + labor force into a normalized dict."""
    if not BLS_V2_DIR.exists():
        return {}
    for f in BLS_V2_DIR.glob("*.json"):
        try:
            with f.open() as fh:
                data = json.load(fh)
        except Exception:
            continue
        series_list = data.get("Results", {}).get("series", [])
        ids_in_file = [s.get("seriesID") for s in series_list]
        if not all(sid in ids_in_file for sid in series_ids):
            continue
        # Latest (year+period) per series
        out: dict = {}
        # Match by series-suffix to label
        for s in series_list:
            sid = s.get("seriesID", "")
            if not s.get("data"):
                continue
            latest = s["data"][0]  # BLS sorts newest-first
            try:
                v = float(latest.get("value"))
            except (TypeError, ValueError):
                continue
            if sid.endswith("03"):
                out["unemploymentRate"] = v
            elif sid.endswith("04"):
                out["unemployment"] = int(v)
            elif sid.endswith("05"):
                out["employed"] = int(v)
            elif sid.endswith("06"):
                out["laborForce"] = int(v)
        return out
    return {}


def _bea_for_geo(geo_fips: str) -> dict:
    """Walk BEA cache, pull latest values for each known table+line."""
    if not BEA_DIR.exists():
        return {}
    out: dict = {}
    for f in BEA_DIR.glob("*.json"):
        try:
            with f.open() as fh:
                data = json.load(fh)
        except Exception:
            continue
        params = data.get("BEAAPI", {}).get("Request", {}).get("RequestParam", [])
        # Pull TableName + LineCode + GeoFips from the request params
        param = {p.get("ParameterName"): p.get("ParameterValue") for p in params}
        if param.get("GeoFips") != geo_fips:
            continue
        table = param.get("TableName")
        line = param.get("LineCode")
        rows = data.get("BEAAPI", {}).get("Results", {}).get("Data", [])
        if not rows:
            continue
        latest = max(rows, key=lambda r: int(r.get("TimePeriod", 0)) if str(r.get("TimePeriod", "")).isdigit() else 0)
        try:
            v = float(latest.get("DataValue", "0").replace(",", ""))
        except (TypeError, ValueError):
            continue
        # Map table+line → key
        if table == "CAINC1" and line == str(bea_line_code("CAINC1", "perCapitaIncome")):
            out["beaPerCapitaIncome"] = v
        elif table == "CAEMP25N" and line == str(bea_line_code("CAEMP25N", "proprietorsEmp")):
            out["beaPropEmp"] = int(v)
        elif table == "CAGDP9" and line == "1":
            out["beaCountyGdp"] = v
    return out


def bea_line_code(table: str, key: str) -> int:
    import bea_api as ba
    if table == "CAINC1":
        return ba.CAINC1_LINES[key]
    if table == "CAEMP25N":
        return ba.CAEMP25N_LINES[key]
    if table == "CAGDP9":
        return ba.CAGDP9_LINES[key]
    return -1


def build_employment() -> dict:
    import bls_api as ba

    # State — pick the latest QCEW vintage that actually published.
    state_latest_year = _latest_qcew_year("08000") or QCEW_YEARS[-1]
    state_block = _qcew_total_for_area(_read_qcew_annual(state_latest_year, "08000"))
    state_block.update(_laus_for_geo(list(ba.laus_state_series(STATE_FIPS).values())))
    state_block.update(_bea_for_geo(f"{STATE_FIPS}000"))
    state_trend = {}
    for k in ["qcewTotalEmp", "naicsAccommFood", "naicsConstruction"]:
        state_trend[k] = _qcew_trend_for_area("08000", k)

    state_data = {"latest": state_block or None, "trend": state_trend}

    # Counties — same per-area latest-vintage discovery.
    county_data = {}
    county_latest_years: list[int] = []
    for cfips in COUNTY_FIPS.keys():
        area = f"{STATE_FIPS}{cfips}"
        latest_y = _latest_qcew_year(area) or QCEW_YEARS[-1]
        county_latest_years.append(latest_y)
        block = _qcew_total_for_area(_read_qcew_annual(latest_y, area))
        block.update(_laus_for_geo(list(ba.laus_county_series(STATE_FIPS, cfips).values())))
        block.update(_bea_for_geo(area))
        ctrend = {}
        for k in ["qcewTotalEmp", "naicsAccommFood", "naicsConstruction", "naicsHealthCare"]:
            ctrend[k] = _qcew_trend_for_area(area, k)
        county_data[area] = {"latest": block or None, "trend": ctrend}

    # Places — QCEW/LAUS/BEA do not publish at the place level; placeholder.
    place_data = {}

    # vintage_end reflects the latest year actually present in the cache —
    # not the QCEW_YEARS upper bound, which leads the published vintage by
    # the natural ~6-month QCEW lag.
    actual_latest = max([state_latest_year, *county_latest_years]) if county_latest_years else state_latest_year
    return build_envelope(
        topic="employment",
        vintage_start=QCEW_YEARS[0],
        vintage_end=actual_latest,
        sources=[
            source(
                id="QCEW",
                agency="U.S. Bureau of Labor Statistics",
                dataset="Quarterly Census of Employment and Wages",
                endpoint="https://data.bls.gov/cew/data/api",
            ),
            source(
                id="LAUS",
                agency="U.S. Bureau of Labor Statistics",
                dataset="Local Area Unemployment Statistics",
                endpoint="https://api.bls.gov/publicAPI/v2/timeseries/data",
            ),
            source(
                id="BEA_REIS",
                agency="U.S. Bureau of Economic Analysis",
                dataset="Regional Economic Accounts",
                endpoint="https://apps.bea.gov/api/data",
            ),
        ],
        state_data=state_data,
        county_data=county_data,
        place_data=place_data,
    )
