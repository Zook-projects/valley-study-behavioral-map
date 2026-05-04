"""
fetch-context-labor.py — Pull BLS QCEW + LAUS, BEA REIS, and CDLE OEWS
into data/context-cache/{bls,bea,cdle}/.

Coverage:
  BLS QCEW    — annual covered employment + wages by NAICS, county+state
  BLS LAUS    — monthly labor force / employment / unemployment, county+state
  BEA REIS    — CAINC1 (per-capita income), CAEMP25N (employment by industry),
                CAGDP9 (county GDP)
  CDLE OEWS   — Occupational Employment and Wage Statistics (state + nonmetro
                area). The CDLE OEWS endpoint is part of the BLS API; pulled
                via fetch_v2_series.

Place-level employment/income is not published — every level here is county
or state. The topic builder propagates None to the place tier.
"""

from __future__ import annotations

import sys

import bls_api
import bea_api
from geographies import STATE_FIPS, COUNTY_FIPS

QCEW_YEARS = list(range(2002, 2026))  # 2025 annual lands ~June 2026
LAUS_START = 2010
LAUS_END = 2026

BEA_TABLES = [
    ("CAINC1", bea_api.CAINC1_LINES["perCapitaIncome"], "perCapitaIncome"),
    ("CAINC1", bea_api.CAINC1_LINES["personalIncome"], "personalIncome"),
    ("CAEMP25N", bea_api.CAEMP25N_LINES["totalEmp"], "beaTotalEmp"),
    ("CAEMP25N", bea_api.CAEMP25N_LINES["proprietorsEmp"], "beaPropEmp"),
    ("CAGDP9", bea_api.CAGDP9_LINES["countyGdp"], "countyGdp"),
]


def fetch_qcew_for_areas() -> None:
    print("BLS QCEW — annual single-area CSVs:", file=sys.stderr)
    # State first (areacode = "C0800")
    for year in QCEW_YEARS:
        try:
            bls_api.fetch_qcew_area_annual(year, "08000")  # state
        except Exception as e:
            print(f"  [qcew state {year}] {e}", file=sys.stderr)
        for cfips in COUNTY_FIPS.keys():
            area = f"{STATE_FIPS}{cfips}"
            try:
                bls_api.fetch_qcew_area_annual(year, area)
            except Exception as e:
                print(f"  [qcew {area} {year}] {e}", file=sys.stderr)


def fetch_laus_series() -> None:
    print("BLS LAUS — county+state unemployment via v2 timeseries:", file=sys.stderr)
    if not bls_api.has_key():
        print("  WARN: no BLS_API_KEY — capped at 25 queries/day", file=sys.stderr)

    # State
    state_ids = list(bls_api.laus_state_series(STATE_FIPS).values())
    try:
        bls_api.fetch_v2_series(state_ids, start_year=LAUS_START, end_year=LAUS_END)
    except Exception as e:
        print(f"  [laus state] {e}", file=sys.stderr)

    # Counties
    for cfips in COUNTY_FIPS.keys():
        ids = list(bls_api.laus_county_series(STATE_FIPS, cfips).values())
        try:
            bls_api.fetch_v2_series(ids, start_year=LAUS_START, end_year=LAUS_END)
        except Exception as e:
            print(f"  [laus {STATE_FIPS}{cfips}] {e}", file=sys.stderr)


def fetch_bea_regional() -> None:
    print("BEA REIS — county-level personal income, employment, GDP:", file=sys.stderr)
    if not bea_api.has_key():
        print("  ERROR: BEA_API_KEY required — skipping BEA pull", file=sys.stderr)
        return

    for table, line, label in BEA_TABLES:
        # State
        try:
            bea_api.fetch_regional(
                table_name=table,
                line_code=line,
                geo_fips=f"{STATE_FIPS}000",
                year="ALL",
            )
        except Exception as e:
            print(f"  [bea {table}/{label} state] {e}", file=sys.stderr)
        # Counties
        for cfips in COUNTY_FIPS.keys():
            geo = f"{STATE_FIPS}{cfips}"
            try:
                bea_api.fetch_regional(
                    table_name=table,
                    line_code=line,
                    geo_fips=geo,
                    year="ALL",
                )
            except Exception as e:
                print(f"  [bea {table}/{label} {geo}] {e}", file=sys.stderr)


def main() -> int:
    print("Fetching labor + income series into context-cache/{bls,bea}/…", file=sys.stderr)
    fetch_qcew_for_areas()
    fetch_laus_series()
    fetch_bea_regional()
    print("Labor + income fetch complete.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
