"""
geographies.py — Census GEOID / FIPS lookups for the study area.

Extends scripts/anchors.py with the Census Place GEOIDs, county FIPS, and
ZCTA→Place crosswalk needed by the context fetchers (ACS, PEP, Decennial,
CBP, BPS, BLS, BEA, HUD).

Single source of truth — every fetcher and the build-context.py orchestrator
imports from here so a Place GEOID drift can't desync the topic JSONs.
"""

from __future__ import annotations

from anchors import ANCHOR_PLACE_NAMES, ANCHOR_ZIPS, CITY_CENTROIDS

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------
STATE_FIPS: str = "08"
STATE_NAME: str = "Colorado"

# ---------------------------------------------------------------------------
# Counties — 4 counties touching the 11 anchor places.
# Garfield holds 7 anchors, Pitkin holds 4. Eagle and Mesa border the study
# area (Eagle covers Basalt's eastern half, Mesa covers De Beque's western
# tail). Both border counties are included so the regional context picks up
# the full economic shed.
# ---------------------------------------------------------------------------
COUNTY_FIPS: dict[str, str] = {
    # FIPS → Name (3-digit county code; full GEOID is STATE_FIPS + this)
    "045": "Garfield County",
    "097": "Pitkin County",
    "037": "Eagle County",
    "077": "Mesa County",
}

# Convenience: full 5-digit county GEOIDs
COUNTY_GEOIDS: dict[str, str] = {
    f"{STATE_FIPS}{cfips}": name for cfips, name in COUNTY_FIPS.items()
}

# ---------------------------------------------------------------------------
# Places (Census incorporated/CDP places) — 10 of the 11 anchors are
# incorporated. Old Snowmass (81654) is unincorporated and falls back to its
# ZCTA at the place level. Each Place GEOID is STATE_FIPS + 5-digit Place
# code. Codes confirmed against Census 2024 Gazetteer — verify before final
# build if Place codes ever change.
# ---------------------------------------------------------------------------
PLACE_CODES: dict[str, dict] = {
    # Place codes verified against Census 2023 ACS 5-Year /acs/acs5?for=place:*&in=state:08
    "81601": {
        "place_code": "30780",
        "place_name": "Glenwood Springs",
        "county_fips": "045",
        "kind": "place",
    },
    "81611": {
        "place_code": "03620",
        "place_name": "Aspen",
        "county_fips": "097",
        "kind": "place",
    },
    "81615": {
        "place_code": "71755",
        "place_name": "Snowmass Village",
        "county_fips": "097",
        "kind": "place",
    },
    "81621": {
        "place_code": "04935",
        "place_name": "Basalt",
        "county_fips": "097",
        "kind": "place",
    },
    "81623": {
        "place_code": "12045",
        "place_name": "Carbondale",
        # Carbondale sits in Garfield County (FIPS 045), not Pitkin (097).
        # Carbondale Place straddles a sliver of Pitkin County but Census
        # Bureau primary-county assignment is Garfield, which matches the
        # municipal boundary and how every other public source files it.
        "county_fips": "045",
        "kind": "place",
    },
    "81630": {
        "place_code": "19355",
        "place_name": "De Beque",
        "county_fips": "045",
        "kind": "place",
    },
    "81635": {
        "place_code": "57400",
        "place_name": "Parachute",
        "county_fips": "045",
        "kind": "place",
    },
    "81647": {
        "place_code": "53395",
        "place_name": "New Castle",
        "county_fips": "045",
        "kind": "place",
    },
    "81650": {
        "place_code": "64255",
        "place_name": "Rifle",
        "county_fips": "045",
        "kind": "place",
    },
    "81652": {
        "place_code": "70195",
        "place_name": "Silt",
        "county_fips": "045",
        "kind": "place",
    },
    "81654": {
        # Unincorporated — fall back to ZCTA. Place_code is None so the
        # Census fetcher knows to use ZCTA-geography variants of every API
        # call for this anchor.
        "place_code": None,
        "place_name": "Old Snowmass",
        "county_fips": "097",
        "kind": "zcta",
    },
}


def place_geoid(zip_code: str) -> str | None:
    """Full 7-digit Census Place GEOID for an anchor ZIP, or None for ZCTA-fallback anchors."""
    rec = PLACE_CODES.get(zip_code)
    if rec is None or rec["place_code"] is None:
        return None
    return f"{STATE_FIPS}{rec['place_code']}"


def county_geoid(zip_code: str) -> str | None:
    """5-digit county GEOID (e.g., '08045') for an anchor ZIP."""
    rec = PLACE_CODES.get(zip_code)
    if rec is None:
        return None
    return f"{STATE_FIPS}{rec['county_fips']}"


def county_name(zip_code: str) -> str | None:
    rec = PLACE_CODES.get(zip_code)
    if rec is None:
        return None
    return COUNTY_FIPS[rec["county_fips"]]


def all_place_records() -> list[dict]:
    """All 11 anchor place records in canonical (sorted-ZIP) order, ready to embed in topic JSONs."""
    out = []
    for zip_code in sorted(ANCHOR_ZIPS):
        rec = PLACE_CODES[zip_code]
        out.append({
            "zip": zip_code,
            "name": rec["place_name"],
            "kind": rec["kind"],
            "place_geoid": place_geoid(zip_code),
            "county_geoid": county_geoid(zip_code),
            "county_name": county_name(zip_code),
            "centroid": CITY_CENTROIDS.get(zip_code),
        })
    return out


def all_county_records() -> list[dict]:
    """All 4 county records in sorted-FIPS order."""
    return [
        {"fips": cfips, "geoid": f"{STATE_FIPS}{cfips}", "name": COUNTY_FIPS[cfips]}
        for cfips in sorted(COUNTY_FIPS.keys())
    ]


def state_record() -> dict:
    return {"fips": STATE_FIPS, "name": STATE_NAME}


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    import json
    print(json.dumps({
        "state": state_record(),
        "counties": all_county_records(),
        "places": all_place_records(),
    }, indent=2))
