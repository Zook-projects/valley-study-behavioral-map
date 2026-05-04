"""
context_builders/demographics.py — Compose demographics.json from cached
Census ACS + PEP + Decennial responses.
"""

from __future__ import annotations

import importlib

from context_schema import build_envelope, source, trend_series
from geographies import (
    STATE_FIPS,
    COUNTY_FIPS,
    PLACE_CODES,
    all_county_records,
    all_place_records,
)

from . import _census_shared as cs

# Re-import composite age definitions from the fetcher so the bucket math
# stays in lockstep with what was actually pulled.
_fetch_mod = importlib.import_module("fetch-context-census".replace("-", "_")) if False else None
# Inline copy is safer than dynamic import (the fetch script's filename has
# hyphens which Python module loader won't handle). The age composites are
# small enough to mirror here.
COMPOSITES_AGE = {
    "ageU18": [
        "B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E",
        "B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E",
    ],
    "age18to34": [
        "B01001_007E", "B01001_008E", "B01001_009E", "B01001_010E",
        "B01001_011E", "B01001_012E",
        "B01001_031E", "B01001_032E", "B01001_033E", "B01001_034E",
        "B01001_035E", "B01001_036E",
    ],
    "age35to54": [
        "B01001_013E", "B01001_014E", "B01001_015E", "B01001_016E",
        "B01001_037E", "B01001_038E", "B01001_039E", "B01001_040E",
    ],
    "age55to64": [
        "B01001_017E", "B01001_018E", "B01001_019E",
        "B01001_041E", "B01001_042E", "B01001_043E",
    ],
    "age65plus": [
        "B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E",
        "B01001_024E", "B01001_025E",
        "B01001_044E", "B01001_045E", "B01001_046E", "B01001_047E",
        "B01001_048E", "B01001_049E",
    ],
}

DIRECT_VARS = {
    "population": "B01001_001E",
    "medianAge": "B01002_001E",
    "male": "B01001_002E",
    "female": "B01001_026E",
    "white": "B02001_002E",
    "black": "B02001_003E",
    "amInd": "B02001_004E",
    "asian": "B02001_005E",
    "nhpi": "B02001_006E",
    "twoOrMore": "B02001_008E",
    "hispanic": "B03002_012E",
    "notHispanic": "B03002_002E",
    "familyHh": "B11001_002E",
    "nonFamilyHh": "B11001_007E",
    "medianHhIncome": "B19013_001E",
}

TREND_KEYS = ["population", "medianHhIncome", "ageU18", "age65plus"]
ACS_LATEST_YEAR = 2024
ACS_TREND_START = 2010


def _latest_block(row) -> dict | None:
    if row is None:
        return None
    block: dict = {}
    for key, var in DIRECT_VARS.items():
        v = cs.number_or_none(row, var)
        if v is not None:
            block[key] = v
    for key, parts in COMPOSITES_AGE.items():
        v = cs.sum_vars(row, parts)
        if v is not None:
            block[key] = v
    return block or None


def _trend_block(rows_by_year: dict[int, dict | None]) -> dict:
    out: dict[str, list[dict]] = {}
    for tk in TREND_KEYS:
        var = DIRECT_VARS.get(tk)
        pairs: list[tuple[int, int | float | None]] = []
        for y, row in sorted(rows_by_year.items()):
            if var:
                v = cs.number_or_none(row, var)
            elif tk in COMPOSITES_AGE:
                v = cs.sum_vars(row, COMPOSITES_AGE[tk])
            else:
                v = None
            pairs.append((y, v))
        out[tk] = trend_series(pairs)
    return out


def build_demographics() -> dict:
    rows_by_year: dict[int, list[dict]] = {}
    for year in range(ACS_TREND_START, ACS_LATEST_YEAR + 1):
        rows_by_year[year] = cs.load_acs5(year)

    latest_rows = rows_by_year.get(ACS_LATEST_YEAR, [])

    # State
    state_latest_row = cs.state_row(latest_rows, STATE_FIPS)
    state_block = {
        "latest": _latest_block(state_latest_row),
        "trend": _trend_block({y: cs.state_row(rows_by_year[y], STATE_FIPS) for y in rows_by_year}),
    }

    # Counties
    county_data: dict[str, dict] = {}
    for cfips in COUNTY_FIPS.keys():
        latest_row = cs.county_row(latest_rows, STATE_FIPS, cfips)
        trend_rows = {y: cs.county_row(rows_by_year[y], STATE_FIPS, cfips) for y in rows_by_year}
        county_data[f"{STATE_FIPS}{cfips}"] = {
            "latest": _latest_block(latest_row),
            "trend": _trend_block(trend_rows),
        }

    # Places (incorporated) + ZCTA fallback
    place_data: dict[str, dict] = {}
    for rec in all_place_records():
        if rec["place_geoid"]:
            place_code = rec["place_geoid"][2:]
            latest_row = cs.place_row(latest_rows, STATE_FIPS, place_code)
            trend_rows = {y: cs.place_row(rows_by_year[y], STATE_FIPS, place_code) for y in rows_by_year}
        else:
            latest_row = cs.zcta_row(latest_rows, rec["zip"])
            trend_rows = {y: cs.zcta_row(rows_by_year[y], rec["zip"]) for y in rows_by_year}
        place_data[rec["zip"]] = {
            "latest": _latest_block(latest_row),
            "trend": _trend_block(trend_rows),
        }

    return build_envelope(
        topic="demographics",
        vintage_start=ACS_TREND_START,
        vintage_end=ACS_LATEST_YEAR,
        sources=[
            source(
                id="ACS5",
                agency="U.S. Census Bureau",
                dataset="American Community Survey 5-Year Estimates",
                endpoint=f"https://api.census.gov/data/{ACS_LATEST_YEAR}/acs/acs5",
            ),
        ],
        state_data=state_block,
        county_data=county_data,
        place_data=place_data,
    )
