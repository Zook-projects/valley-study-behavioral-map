"""
fetch-context-census.py — Pull every Census-API series the context layer
needs into data/context-cache/census/.

Coverage:
  ACS 5-Year (rolling 2010–2023, latest = 2023):
    Demographics — B01001 (age/sex), B02001/B03002 (race/ethnicity),
                   B11001 (households), B19013 (median HH income), B01002
                   (median age)
    Education    — S1501 (educational attainment), B14001 (school enrollment)
    Housing      — B25003 (tenure), B25004 (vacancy), B25064 (median gross
                   rent), B25077 (median home value), B25070/B25091 (cost
                   burden)
  PEP — annual population estimates 2020+ (place + county + state)
  Decennial 2020 PL/DHC — total population, race, age 18+
  CBP / ZBP — annual establishment counts + employment by NAICS-2
  BPS — annual residential building permits by structure type

Geographies fetched:
  state    — Colorado (08)
  counties — Garfield (08045), Pitkin (08097), Eagle (08037), Mesa (08077)
  places   — 10 incorporated places (place GEOID)
  zcta     — Old Snowmass (81654) only — fallback for the unincorporated anchor

The script gracefully skips any series that returns an error, so a missing
endpoint never breaks the rest of the cache.
"""

from __future__ import annotations

import sys
from pathlib import Path

import census_api
from geographies import (
    STATE_FIPS,
    COUNTY_FIPS,
    PLACE_CODES,
    all_county_records,
    all_place_records,
)

# ---------------------------------------------------------------------------
# Variable groups — keyed by topic key the build envelope uses.
# Census variable names follow B##### and S##### conventions; '_001E' suffixes
# pick the estimate column. See https://api.census.gov/data/2023/acs/acs5/variables.html
# ---------------------------------------------------------------------------
ACS5_DEMOGRAPHICS = {
    "population": "B01001_001E",
    "medianAge": "B01002_001E",
    "ageU18": "_compose:age_under_18",  # composite — sum of B01001 buckets
    "age18to34": "_compose:age_18_34",
    "age35to54": "_compose:age_35_54",
    "age55to64": "_compose:age_55_64",
    "age65plus": "_compose:age_65_plus",
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

ACS5_EDUCATION = {
    "eduLessHs": "S1501_C01_007E",  # less than HS, pop 25+
    "eduHs": "S1501_C01_009E",       # HS grad
    "eduSomeCol": "S1501_C01_010E",  # some college, no degree (approx)
    "eduBach": "S1501_C01_012E",     # bachelor's
    "eduGradPlus": "S1501_C01_013E", # graduate or professional
    "pctBachPlus": "S1501_C02_015E", # % bachelor's or higher
    # NOTE: B14001 (school enrollment) is a detailed-table variable — can't
    # be mixed with S-table vars on /acs/acs5/subject. Pull it separately
    # later if needed; education table alone is the headline.
}

ACS5_HOUSING = {
    "medianHomeValueAcs": "B25077_001E",
    "medianGrossRent": "B25064_001E",
    "ownerOccupied": "B25003_002E",
    "renterOccupied": "B25003_003E",
    "homeownerVacancy": "B25004_001E",  # placeholder; B25004 is by-tenure detail
    "rentalVacancy": "B25004_001E",
    # Cost-burden composites computed from B25070 (renters) + B25091 (owners)
    "costBurden30": "_compose:cost_burden_30",
    "costBurden50": "_compose:cost_burden_50",
}

ACS_LATEST_YEAR = 2024
ACS_TREND_START = 2010


# Composite-variable definitions: for each composite key, list the raw ACS
# variables that sum together. The fetcher pulls each underlying variable in
# its raw form; the topic builder composes them.
COMPOSITES_AGE = {
    "age_under_18": [
        # Male + female combined: B01001_003..006 + B01001_027..030
        "B01001_003E", "B01001_004E", "B01001_005E", "B01001_006E",
        "B01001_027E", "B01001_028E", "B01001_029E", "B01001_030E",
    ],
    "age_18_34": [
        "B01001_007E", "B01001_008E", "B01001_009E", "B01001_010E",
        "B01001_011E", "B01001_012E",
        "B01001_031E", "B01001_032E", "B01001_033E", "B01001_034E",
        "B01001_035E", "B01001_036E",
    ],
    "age_35_54": [
        "B01001_013E", "B01001_014E", "B01001_015E", "B01001_016E",
        "B01001_037E", "B01001_038E", "B01001_039E", "B01001_040E",
    ],
    "age_55_64": [
        "B01001_017E", "B01001_018E", "B01001_019E",
        "B01001_041E", "B01001_042E", "B01001_043E",
    ],
    "age_65_plus": [
        "B01001_020E", "B01001_021E", "B01001_022E", "B01001_023E",
        "B01001_024E", "B01001_025E",
        "B01001_044E", "B01001_045E", "B01001_046E", "B01001_047E",
        "B01001_048E", "B01001_049E",
    ],
}

COMPOSITES_HOUSING = {
    "cost_burden_30": [
        # Owners 30%+ + renters 30%+ aggregated. ACS publishes these in
        # B25070 (renters: cost as % of HH income) and B25091 (owners w/
        # mortgage). The composite sums every bucket ≥30%.
        "B25070_007E", "B25070_008E", "B25070_009E", "B25070_010E",
        "B25091_008E", "B25091_009E", "B25091_010E", "B25091_011E",
    ],
    "cost_burden_50": [
        "B25070_010E",
        "B25091_011E",
    ],
}


def _flatten_vars(group: dict[str, str]) -> list[str]:
    """Resolve composite tokens to underlying variables; pass-through plain."""
    raw: list[str] = []
    for key, var in group.items():
        if var.startswith("_compose:"):
            comp = var.split(":", 1)[1]
            if comp in COMPOSITES_AGE:
                raw.extend(COMPOSITES_AGE[comp])
            elif comp in COMPOSITES_HOUSING:
                raw.extend(COMPOSITES_HOUSING[comp])
        else:
            raw.append(var)
    return sorted(set(raw))


# ---------------------------------------------------------------------------
# Fetchers — one function per (topic-group × geography). Each returns the raw
# rows-as-dicts; persistence to cache is handled inside census_api.fetch().
# ---------------------------------------------------------------------------
def _acs_geographies():
    state_geo = {"for": f"state:{STATE_FIPS}"}
    county_geos = [
        {"for": f"county:{cfips}", "in": f"state:{STATE_FIPS}"}
        for cfips in COUNTY_FIPS.keys()
    ]
    place_geos = []
    zcta_geos = []
    for rec in all_place_records():
        if rec["place_geoid"]:
            place_geos.append({
                "zip": rec["zip"],
                "geo": {"for": f"place:{rec['place_geoid'][2:]}", "in": f"state:{STATE_FIPS}"},
            })
        else:
            # ZCTA fallback (e.g., Old Snowmass 81654)
            zcta_geos.append({
                "zip": rec["zip"],
                "geo": {"for": f"zip code tabulation area:{rec['zip']}"},
            })
    return state_geo, county_geos, place_geos, zcta_geos


def fetch_acs5_topic(year: int, group: dict[str, str], label: str) -> None:
    """Pull a single ACS topic group across all 4 levels for a given year."""
    if not census_api.has_key():
        print(f"  [{label} {year}] no CENSUS_API_KEY — skipping", file=sys.stderr)
        return

    raw_vars = _flatten_vars(group)
    state_geo, county_geos, place_geos, zcta_geos = _acs_geographies()

    print(f"  [{label} {year}] {len(raw_vars)} vars × {1 + len(county_geos) + len(place_geos) + len(zcta_geos)} geographies", file=sys.stderr)

    # Census API caps `get` parameter at 50 vars per call. Chunk if needed.
    def _chunked(lst, size=49):
        for i in range(0, len(lst), size):
            yield lst[i:i+size]

    is_subject = label == "education"
    api = census_api.fetch_acs5_subject if is_subject else census_api.fetch_acs5

    def _safe(geo: dict) -> None:
        for chunk in _chunked(raw_vars):
            try:
                api(year, variables=["NAME", *chunk], geography=geo)
            except Exception as e:
                # One bad call shouldn't abandon the rest of the loop —
                # cache what we can, print, move on.
                print(f"  [{label} {year}] {geo} chunk failed: {e}", file=sys.stderr)

    _safe(state_geo)
    for cgeo in county_geos:
        _safe(cgeo)
    for pg in place_geos:
        _safe(pg["geo"])
    for zg in zcta_geos:
        _safe(zg["geo"])


def _try(label: str, fn) -> None:
    try:
        fn()
    except Exception as e:
        print(f"  [{label}] {e}", file=sys.stderr)


def fetch_pep(year: int) -> None:
    """PEP annual population — quickest population-by-place trend update."""
    if not census_api.has_key():
        return
    state_geo, county_geos, place_geos, _ = _acs_geographies()
    pep_vars = ["NAME", "POP"]
    _try(f"pep {year} state", lambda: census_api.fetch_pep(year, variables=pep_vars, geography=state_geo))
    for cgeo in county_geos:
        _try(f"pep {year} {cgeo}", lambda c=cgeo: census_api.fetch_pep(year, variables=pep_vars, geography=c))
    for pg in place_geos:
        _try(f"pep {year} {pg['zip']}", lambda p=pg: census_api.fetch_pep(year, variables=pep_vars, geography=p["geo"]))


def fetch_decennial_2020() -> None:
    """Decennial 2020 PL — high-precision 2020 baseline counts."""
    if not census_api.has_key():
        return
    state_geo, county_geos, place_geos, zcta_geos = _acs_geographies()
    pl_vars = ["NAME", "P1_001N", "P2_002N"]
    _try("dec 2020 state", lambda: census_api.fetch_decennial(2020, table="pl", variables=pl_vars, geography=state_geo))
    for cgeo in county_geos:
        _try(f"dec 2020 {cgeo}", lambda c=cgeo: census_api.fetch_decennial(2020, table="pl", variables=pl_vars, geography=c))
    for pg in place_geos:
        _try(f"dec 2020 {pg['zip']}", lambda p=pg: census_api.fetch_decennial(2020, table="pl", variables=pl_vars, geography=p["geo"]))
    for zg in zcta_geos:
        _try(f"dec 2020 {zg['zip']}", lambda z=zg: census_api.fetch_decennial(2020, table="pl", variables=pl_vars, geography=z["geo"]))


def fetch_cbp_zbp(year: int) -> None:
    """County Business Patterns + ZIP Business Patterns — establishment counts."""
    if not census_api.has_key():
        return
    state_geo = {"for": f"state:{STATE_FIPS}"}
    cbp_vars = ["NAME", "ESTAB", "EMP", "PAYANN"]
    _try(f"cbp {year} state", lambda: census_api.fetch_cbp(year, variables=cbp_vars, geography=state_geo))
    for cfips in COUNTY_FIPS.keys():
        _try(f"cbp {year} county:{cfips}", lambda c=cfips: census_api.fetch_cbp(
            year, variables=cbp_vars,
            geography={"for": f"county:{c}", "in": f"state:{STATE_FIPS}"},
        ))
    # ZBP discontinued after 2018 — only call for years that have it.
    if year <= 2018:
        zbp_vars = ["NAME", "ESTAB"]
        for rec in all_place_records():
            _try(f"zbp {year} {rec['zip']}", lambda r=rec: census_api.fetch_zbp(
                year, variables=zbp_vars,
                geography={"for": f"zip code:{r['zip']}"},
            ))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    if not census_api.has_key():
        print(
            "ERROR: CENSUS_API_KEY required.\n"
            "Sign up free at https://api.census.gov/data/key_signup.html\n"
            "Add to .env.local as: CENSUS_API_KEY=your-key-here",
            file=sys.stderr,
        )
        return 1

    print("Fetching Census family series into context-cache/census/…", file=sys.stderr)

    print("ACS 5-Year — demographics:", file=sys.stderr)
    for year in range(ACS_TREND_START, ACS_LATEST_YEAR + 1):
        fetch_acs5_topic(year, ACS5_DEMOGRAPHICS, "demographics")

    print("ACS 5-Year — education:", file=sys.stderr)
    for year in range(ACS_TREND_START, ACS_LATEST_YEAR + 1):
        fetch_acs5_topic(year, ACS5_EDUCATION, "education")

    print("ACS 5-Year — housing:", file=sys.stderr)
    for year in range(ACS_TREND_START, ACS_LATEST_YEAR + 1):
        fetch_acs5_topic(year, ACS5_HOUSING, "housing")

    print("PEP population estimates (2020+):", file=sys.stderr)
    for year in range(2020, ACS_LATEST_YEAR + 2):  # PEP usually leads ACS by 1
        fetch_pep(year)

    print("Decennial 2020:", file=sys.stderr)
    fetch_decennial_2020()

    print("CBP + ZBP establishments:", file=sys.stderr)
    # CBP runs ~1.5 years lagged; latest typical vintage two before "now".
    # Range stops at ACS_LATEST_YEAR so the loop tracks ACS releases.
    for year in range(2018, ACS_LATEST_YEAR + 1):
        fetch_cbp_zbp(year)

    print("Census family fetch complete.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
