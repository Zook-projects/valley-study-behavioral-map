"""
context_builders/education.py — Compose education.json from cached
ACS S1501 (educational attainment) + B14001 (school enrollment).
"""

from __future__ import annotations

from context_schema import build_envelope, source, trend_series
from geographies import (
    STATE_FIPS,
    COUNTY_FIPS,
    PLACE_CODES,
    all_place_records,
)

from . import _census_shared as cs

DIRECT_VARS = {
    "eduLessHs": "S1501_C01_007E",
    "eduHs": "S1501_C01_009E",
    "eduSomeCol": "S1501_C01_010E",
    "eduBach": "S1501_C01_012E",
    "eduGradPlus": "S1501_C01_013E",
    "pctBachPlus": "S1501_C02_015E",
}

TREND_KEYS = ["pctBachPlus"]
ACS_LATEST_YEAR = 2024
ACS_TREND_START = 2010


def _latest_block(subj_row, b14_row) -> dict | None:
    block: dict = {}
    for key in ["eduLessHs", "eduHs", "eduSomeCol", "eduBach", "eduGradPlus", "pctBachPlus"]:
        v = cs.number_or_none(subj_row, DIRECT_VARS[key])
        if v is not None:
            block[key] = v
    return block or None


def _trend_block(subj_by_year: dict[int, dict | None], b14_by_year: dict[int, dict | None]) -> dict:
    out: dict[str, list[dict]] = {}
    for tk in TREND_KEYS:
        var = DIRECT_VARS.get(tk)
        if var is None:
            continue
        pairs: list[tuple[int, int | float | None]] = []
        for y in sorted(subj_by_year.keys()):
            row = subj_by_year.get(y)
            v = cs.number_or_none(row, var)
            pairs.append((y, v))
        out[tk] = trend_series(pairs)
    return out


def build_education() -> dict:
    subj_by_year: dict[int, list[dict]] = {}
    b14_by_year: dict[int, list[dict]] = {}
    for year in range(ACS_TREND_START, ACS_LATEST_YEAR + 1):
        subj_by_year[year] = cs.load_acs5_subject(year)
        b14_by_year[year] = cs.load_acs5(year)

    subj_latest = subj_by_year.get(ACS_LATEST_YEAR, [])
    b14_latest = b14_by_year.get(ACS_LATEST_YEAR, [])

    state_block = {
        "latest": _latest_block(
            cs.state_row(subj_latest, STATE_FIPS),
            cs.state_row(b14_latest, STATE_FIPS),
        ),
        "trend": _trend_block(
            {y: cs.state_row(subj_by_year[y], STATE_FIPS) for y in subj_by_year},
            {y: cs.state_row(b14_by_year[y], STATE_FIPS) for y in b14_by_year},
        ),
    }

    county_data = {}
    for cfips in COUNTY_FIPS.keys():
        county_data[f"{STATE_FIPS}{cfips}"] = {
            "latest": _latest_block(
                cs.county_row(subj_latest, STATE_FIPS, cfips),
                cs.county_row(b14_latest, STATE_FIPS, cfips),
            ),
            "trend": _trend_block(
                {y: cs.county_row(subj_by_year[y], STATE_FIPS, cfips) for y in subj_by_year},
                {y: cs.county_row(b14_by_year[y], STATE_FIPS, cfips) for y in b14_by_year},
            ),
        }

    place_data = {}
    for rec in all_place_records():
        if rec["place_geoid"]:
            place_code = rec["place_geoid"][2:]
            latest_subj = cs.place_row(subj_latest, STATE_FIPS, place_code)
            latest_b14 = cs.place_row(b14_latest, STATE_FIPS, place_code)
            trend_subj = {y: cs.place_row(subj_by_year[y], STATE_FIPS, place_code) for y in subj_by_year}
            trend_b14 = {y: cs.place_row(b14_by_year[y], STATE_FIPS, place_code) for y in b14_by_year}
        else:
            latest_subj = cs.zcta_row(subj_latest, rec["zip"])
            latest_b14 = cs.zcta_row(b14_latest, rec["zip"])
            trend_subj = {y: cs.zcta_row(subj_by_year[y], rec["zip"]) for y in subj_by_year}
            trend_b14 = {y: cs.zcta_row(b14_by_year[y], rec["zip"]) for y in b14_by_year}
        place_data[rec["zip"]] = {
            "latest": _latest_block(latest_subj, latest_b14),
            "trend": _trend_block(trend_subj, trend_b14),
        }

    return build_envelope(
        topic="education",
        vintage_start=ACS_TREND_START,
        vintage_end=ACS_LATEST_YEAR,
        sources=[
            source(
                id="ACS5_SUBJECT",
                agency="U.S. Census Bureau",
                dataset="ACS 5-Year Subject Tables (S1501)",
                endpoint=f"https://api.census.gov/data/{ACS_LATEST_YEAR}/acs/acs5/subject",
            ),
        ],
        state_data=state_block,
        county_data=county_data,
        place_data=place_data,
    )
