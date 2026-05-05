"""
context_builders/housing.py — Compose housing.json from cached
ACS B25 (Census) + Zillow ZHVI/ZORI + HUD CHAS + HUD FMR + Census BPS.

Each underlying source contributes a subset of keys. The builder unions them
per geography level — missing sources leave their keys absent rather than
zero-valued, so the renderer's "no data" placeholder triggers correctly.
"""

from __future__ import annotations

import json
from pathlib import Path

from context_schema import build_envelope, source, trend_series
from geographies import (
    STATE_FIPS,
    COUNTY_FIPS,
    all_place_records,
)

from . import _census_shared as cs

CACHE_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "context-cache"

ACS_HOUSING_VARS = {
    "medianHomeValueAcs": "B25077_001E",
    "medianGrossRent": "B25064_001E",
    "ownerOccupied": "B25003_002E",
    "renterOccupied": "B25003_003E",
}
ACS_LATEST_YEAR = 2024
ACS_TREND_START = 2015  # B25 series have decent ZCTA-level coverage from 2015 on


def _zillow_for_geo(geo_kind: str, key: str, *, kind: str = "all") -> dict | None:
    """
    Read a normalized Zillow ZHVI record from data/context-cache/zillow/.
    `kind` selects the property-type / bedroom-tier variant:
      'all'           → zhvi-{geo}.json       (SFR + Condo combined, mid-tier)
      'sfr'           → zhvi-sfr-{geo}.json   (Single-family only)
      'condo'         → zhvi-condo-{geo}.json (Condo / co-op only)
      'br1'..'br5'    → zhvi-br{N}-{geo}.json (mid-tier, by bedroom count)
    `geo_kind` is one of 'zip', 'city', 'county', 'state', 'us'.
    Returns the matching record (with 'latest' + 'trend') or None.
    """
    prefix = "zhvi" if kind == "all" else f"zhvi-{kind}"
    path = CACHE_DIR / "zillow" / f"{prefix}-{geo_kind}.json"
    if not path.exists():
        return None
    try:
        with path.open() as f:
            data = json.load(f)
    except json.JSONDecodeError:
        return None
    for rec in data:
        if rec.get("key") == key:
            return rec
    return None


def _zori_for_geo(geo_kind: str, key: str) -> dict | None:
    path = CACHE_DIR / "zillow" / f"zori-{geo_kind}.json"
    if not path.exists():
        return None
    try:
        with path.open() as f:
            data = json.load(f)
    except json.JSONDecodeError:
        return None
    for rec in data:
        if rec.get("key") == key:
            return rec
    return None


def _hud_fmr_county(county_geoid: str) -> dict | None:
    """county_geoid is the 5-digit Census GEOID (e.g., '08045'); HUD's cache
    file uses '{state_county}99999' (HUD's entity-ID format)."""
    hud_code = f"{county_geoid}99999"
    # Cache files include the year in the cache_key — pick the most recent.
    cache_dir = CACHE_DIR / "hud"
    if not cache_dir.exists():
        return None
    matches = sorted(cache_dir.glob(f"fmr-{hud_code}-*.json"), reverse=True)
    if not matches:
        return None
    try:
        with matches[0].open() as f:
            return json.load(f)
    except json.JSONDecodeError:
        return None


def _bps_for_year(year: int) -> list[dict]:
    """Phase 3 fetcher will write a normalized JSON; for now graceful empty."""
    path = CACHE_DIR / "bps" / f"{year}.json"
    if not path.exists():
        return []
    try:
        with path.open() as f:
            return json.load(f)
    except json.JSONDecodeError:
        return []


def _acs_block(row) -> dict:
    block: dict = {}
    for key, var in ACS_HOUSING_VARS.items():
        v = cs.number_or_none(row, var)
        if v is not None:
            block[key] = v
    return block


ZHVI_VARIANTS: tuple[tuple[str, str], ...] = (
    ("all",   "zhvi"),
    ("sfr",   "zhviSfr"),
    ("condo", "zhviCondo"),
    ("br1",   "zhviBr1"),
    ("br2",   "zhviBr2"),
    ("br3",   "zhviBr3"),
    ("br4",   "zhviBr4"),
    ("br5",   "zhviBr5"),
)


def _merge_zillow(block: dict, geo_kind: str, key: str) -> None:
    # Eight ZHVI variants — all-homes, SFR-only, Condo-only, and the five
    # bedroom tiers. The UI's Housing Market panel renders all eight.
    for variant_kind, out_key in ZHVI_VARIANTS:
        z = _zillow_for_geo(geo_kind, key, kind=variant_kind)
        if z and z.get("latest") is not None:
            block[out_key] = z["latest"]
    z = _zori_for_geo(geo_kind, key)
    if z and z.get("latest") is not None:
        block["zori"] = z["latest"]


def _zillow_trend_block(geo_kind: str, key: str) -> dict:
    """Build a {variantOutKey: TrendSeries} dict for every ZHVI variant."""
    out: dict = {}
    for variant_kind, out_key in ZHVI_VARIANTS:
        out[out_key] = _zillow_trend(geo_kind, key, kind=variant_kind)
    return out


def _merge_fmr(block: dict, county_geoid: str) -> None:
    fmr = _hud_fmr_county(county_geoid)
    if not fmr:
        return
    # HUD FMR API returns {data: { basicdata: { Two-Bedroom, ... } }}
    # for a single county, or a list of dicts when the county spans multiple
    # FMR areas. Handle both shapes.
    try:
        basic = fmr.get("data", {}).get("basicdata", {})
        row = basic[0] if isinstance(basic, list) and basic else basic
        if isinstance(row, dict):
            two_br = row.get("Two-Bedroom") or row.get("Two_Bedroom") or row.get("fmr_2")
            if two_br is not None:
                block["fmr2br"] = float(two_br)
    except (AttributeError, KeyError, TypeError, ValueError):
        pass


def _zillow_trend(geo_kind: str, key: str, *, kind: str = "all") -> list[dict]:
    z = _zillow_for_geo(geo_kind, key, kind=kind)
    if not z or not z.get("trend"):
        return []
    return trend_series([(int(p["year"]), float(p["value"])) for p in z["trend"]])


def build_housing() -> dict:
    rows_by_year: dict[int, list[dict]] = {}
    for year in range(ACS_TREND_START, ACS_LATEST_YEAR + 1):
        rows_by_year[year] = cs.load_acs5(year)
    latest_rows = rows_by_year.get(ACS_LATEST_YEAR, [])

    # State
    state_row = cs.state_row(latest_rows, STATE_FIPS)
    state_block_latest = _acs_block(state_row)
    _merge_zillow(state_block_latest, "state", "CO")
    state_trend = _zillow_trend_block("state", "CO")
    for tk, var in ACS_HOUSING_VARS.items():
        pairs = []
        for y in sorted(rows_by_year):
            row = cs.state_row(rows_by_year[y], STATE_FIPS)
            pairs.append((y, cs.number_or_none(row, var)))
        state_trend[tk] = trend_series(pairs)

    state_data = {"latest": state_block_latest or None, "trend": state_trend}

    # Counties
    county_data = {}
    for cfips in COUNTY_FIPS.keys():
        geoid = f"{STATE_FIPS}{cfips}"
        latest_county = cs.county_row(latest_rows, STATE_FIPS, cfips)
        block = _acs_block(latest_county)
        _merge_zillow(block, "county", geoid)
        _merge_fmr(block, geoid)
        ctrend = _zillow_trend_block("county", geoid)
        for tk, var in ACS_HOUSING_VARS.items():
            pairs = []
            for y in sorted(rows_by_year):
                row = cs.county_row(rows_by_year[y], STATE_FIPS, cfips)
                pairs.append((y, cs.number_or_none(row, var)))
            ctrend[tk] = trend_series(pairs)
        county_data[geoid] = {"latest": block or None, "trend": ctrend}

    # Places
    place_data = {}
    for rec in all_place_records():
        if rec["place_geoid"]:
            pc = rec["place_geoid"][2:]
            latest_place = cs.place_row(latest_rows, STATE_FIPS, pc)
            block = _acs_block(latest_place)
            ptrend = {}
            for tk, var in ACS_HOUSING_VARS.items():
                pairs = []
                for y in sorted(rows_by_year):
                    row = cs.place_row(rows_by_year[y], STATE_FIPS, pc)
                    pairs.append((y, cs.number_or_none(row, var)))
                ptrend[tk] = trend_series(pairs)
        else:
            latest_place = cs.zcta_row(latest_rows, rec["zip"])
            block = _acs_block(latest_place)
            ptrend = {}
            for tk, var in ACS_HOUSING_VARS.items():
                pairs = []
                for y in sorted(rows_by_year):
                    row = cs.zcta_row(rows_by_year[y], rec["zip"])
                    pairs.append((y, cs.number_or_none(row, var)))
                ptrend[tk] = trend_series(pairs)
        # Zillow ZIP-level — merge all eight ZHVI variants + trend block
        _merge_zillow(block, "zip", rec["zip"])
        ptrend.update(_zillow_trend_block("zip", rec["zip"]))
        ptrend["zori"] = _zillow_trend("zip", rec["zip"])  # placeholder; ZORI ZIP coverage uneven
        place_data[rec["zip"]] = {"latest": block or None, "trend": ptrend}

    # United States benchmark — synthetic place entry keyed 'US'. Built only
    # from Zillow metro/country rows (no ACS/HUD/CHAS). The frontend renders
    # this alongside cities/counties/state in the Housing Market view.
    us_block: dict = {}
    _merge_zillow(us_block, "us", "US")
    us_trend = _zillow_trend_block("us", "US")
    if us_block:
        place_data["US"] = {"latest": us_block or None, "trend": us_trend}

    envelope = build_envelope(
        topic="housing",
        vintage_start=ACS_TREND_START,
        vintage_end=ACS_LATEST_YEAR,
        sources=[
            source(
                id="ACS5",
                agency="U.S. Census Bureau",
                dataset="ACS 5-Year Estimates (B25 series)",
                endpoint=f"https://api.census.gov/data/{ACS_LATEST_YEAR}/acs/acs5",
            ),
            source(
                id="ZILLOW",
                agency="Zillow Research",
                dataset="ZHVI / ZORI",
                endpoint="https://www.zillow.com/research/data/",
            ),
            source(
                id="HUD_FMR",
                agency="U.S. Department of Housing and Urban Development",
                dataset="Fair Market Rents",
                endpoint="https://www.huduser.gov/hudapi/public/fmr",
            ),
        ],
        state_data=state_data,
        county_data=county_data,
        place_data=place_data,
    )

    # Append the United States benchmark as a synthetic place entry. The
    # `all_place_records()` enumeration does not include the U.S., so
    # build_envelope drops any place_data["US"]; injecting it here keeps
    # the rest of the envelope shape unchanged while making the national
    # series available to the Housing Market view.
    us_pd = place_data.get("US")
    if us_pd:
        envelope["places"].append({
            "zip": "US",
            "name": "United States",
            "kind": "national",
            "placeGeoid": None,
            "countyGeoid": "",
            "countyName": "",
            "latest": us_pd.get("latest"),
            "trend": us_pd.get("trend", {}),
        })

    return envelope
