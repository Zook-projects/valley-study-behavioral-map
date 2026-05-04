"""
fetch-context-housing.py — Housing-side sources beyond Census ACS.

Coverage:
  Zillow ZHVI / ZORI — bulk CSVs, ZIP + city + county + state. The
                       canonical download root is https://files.zillowstatic.com/
                       research/public_csvs/. Filenames follow the pattern
                       Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv etc.
  HUD FMR            — county-level Fair Market Rents via the HUD User API.
  HUD CHAS           — Comprehensive Housing Affordability Strategy bulk
                       downloads (place + county). HUD ships a single zip
                       per vintage covering all U.S. geographies.
  Census BPS         — annual residential building permits, place + county.

Bulk artifacts (Zillow CSVs, CHAS zip, BPS flat files) are downloaded into
data/context-cache/{zillow,hud,bps}/ so the build is reproducible. The
HUD FMR API needs a token; everything else is keyless.

After download, this script also writes pre-normalized JSON in the cache
so context_builders/housing.py can consume them without re-parsing the
upstream formats.
"""

from __future__ import annotations

import csv
import io
import json
import sys
from pathlib import Path

import excel_scrape
import hud_api
from anchors import ANCHOR_ZIPS
from geographies import COUNTY_FIPS, STATE_FIPS

CACHE_ROOT = Path(__file__).resolve().parent.parent / "data" / "context-cache"
ZILLOW_DIR = CACHE_ROOT / "zillow"
HUD_DIR = CACHE_ROOT / "hud"
BPS_DIR = CACHE_ROOT / "bps"

# Zillow public-CSV URLs (current as of 2025). These names are stable but
# Zillow occasionally updates the slug — verify https://www.zillow.com/research/data/
# before final builds.
# All-homes ZHVI: SFR + Condo combined, mid-tier, smoothed + seasonally adjusted.
ZILLOW_ZHVI_ZIP = "https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv"
ZILLOW_ZHVI_CITY = "https://files.zillowstatic.com/research/public_csvs/zhvi/City_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv"
ZILLOW_ZHVI_COUNTY = "https://files.zillowstatic.com/research/public_csvs/zhvi/County_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv"
ZILLOW_ZHVI_STATE = "https://files.zillowstatic.com/research/public_csvs/zhvi/State_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv"

# Single-family-only ZHVI (no tier filter).
ZILLOW_ZHVI_SFR_ZIP = "https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfr_sm_sa_month.csv"
ZILLOW_ZHVI_SFR_CITY = "https://files.zillowstatic.com/research/public_csvs/zhvi/City_zhvi_uc_sfr_sm_sa_month.csv"
ZILLOW_ZHVI_SFR_COUNTY = "https://files.zillowstatic.com/research/public_csvs/zhvi/County_zhvi_uc_sfr_sm_sa_month.csv"
ZILLOW_ZHVI_SFR_STATE = "https://files.zillowstatic.com/research/public_csvs/zhvi/State_zhvi_uc_sfr_sm_sa_month.csv"

# Condo / co-op-only ZHVI (no tier filter).
ZILLOW_ZHVI_CONDO_ZIP = "https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_condo_sm_sa_month.csv"
ZILLOW_ZHVI_CONDO_CITY = "https://files.zillowstatic.com/research/public_csvs/zhvi/City_zhvi_uc_condo_sm_sa_month.csv"
ZILLOW_ZHVI_CONDO_COUNTY = "https://files.zillowstatic.com/research/public_csvs/zhvi/County_zhvi_uc_condo_sm_sa_month.csv"
ZILLOW_ZHVI_CONDO_STATE = "https://files.zillowstatic.com/research/public_csvs/zhvi/State_zhvi_uc_condo_sm_sa_month.csv"

ZILLOW_ZORI_ZIP = "https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv"
ZILLOW_ZORI_CITY = "https://files.zillowstatic.com/research/public_csvs/zori/City_zori_uc_sfrcondomfr_sm_month.csv"

ZILLOW_TARGETS_ZIP = sorted(ANCHOR_ZIPS)
ZILLOW_CITY_NAMES = [
    "Glenwood Springs", "Aspen", "Snowmass Village", "Basalt",
    "Carbondale", "De Beque", "Parachute", "New Castle",
    "Rifle", "Silt",
]
ZILLOW_COUNTY_NAMES = ["Garfield County", "Pitkin County", "Eagle County", "Mesa County"]


# ---------------------------------------------------------------------------
# Zillow helpers
# ---------------------------------------------------------------------------
def _download_zillow(url: str, filename: str) -> Path | None:
    try:
        return excel_scrape.download_to_cache(url, "zillow", filename)
    except Exception as e:
        print(f"  [zillow] download failed for {filename}: {e}", file=sys.stderr)
        return None


def _parse_zillow_csv(path: Path) -> list[dict]:
    with path.open() as f:
        return list(csv.DictReader(f))


def _zillow_filter_records(rows: list[dict], match_fn) -> list[dict]:
    return [r for r in rows if match_fn(r)]


def _zillow_to_normalized(
    rows: list[dict],
    *,
    key_field: str,
    name_field: str = "RegionName",
) -> list[dict]:
    """
    Collapse Zillow's wide-CSV layout (one column per month) into:
        [{key, name, latest, trend: [{year, value}]}, ...]

    Trend is annualized — December value of each year (or the latest available
    month if December is missing).
    """
    out: list[dict] = []
    for row in rows:
        month_keys = [k for k in row.keys() if "-" in k and len(k) >= 7 and k[4] == "-"]
        if not month_keys:
            continue
        month_keys.sort()
        # Group by year, keep December (or latest) value
        by_year: dict[int, float] = {}
        for mk in month_keys:
            try:
                y = int(mk[:4])
                v = float(row[mk])
            except (ValueError, TypeError):
                continue
            by_year[y] = v
        if not by_year:
            continue
        latest_month = month_keys[-1]
        try:
            latest_value = float(row[latest_month])
        except (ValueError, TypeError):
            latest_value = None
        trend = [{"year": y, "value": v} for y, v in sorted(by_year.items())]
        out.append({
            "key": row.get(key_field) or row.get(name_field),
            "name": row.get(name_field),
            "latest": latest_value,
            "trend": trend,
        })
    return out


def _write_normalized(filename: str, rows: list[dict]) -> None:
    ZILLOW_DIR.mkdir(parents=True, exist_ok=True)
    path = ZILLOW_DIR / filename
    path.write_text(json.dumps(rows, indent=2))


def fetch_zillow() -> None:
    print("Zillow ZHVI / ZORI — bulk public CSVs:", file=sys.stderr)
    targets = [
        # All-homes ZHVI (mid-tier SFR + Condo combined)
        (ZILLOW_ZHVI_ZIP,    "zhvi-zip.csv",    "zhvi-zip.json",    "RegionName", lambda r: r.get("RegionName") in ZILLOW_TARGETS_ZIP),
        (ZILLOW_ZHVI_CITY,   "zhvi-city.csv",   "zhvi-city.json",   "RegionName", lambda r: r.get("RegionName") in ZILLOW_CITY_NAMES and r.get("State") == "CO"),
        (ZILLOW_ZHVI_COUNTY, "zhvi-county.csv", "zhvi-county.json", "RegionName", lambda r: r.get("RegionName") in ZILLOW_COUNTY_NAMES and r.get("State") == "CO"),
        # State CSV: StateName column is empty; the state name is in RegionName.
        (ZILLOW_ZHVI_STATE,  "zhvi-state.csv",  "zhvi-state.json",  "RegionName",  lambda r: r.get("RegionName") == "Colorado"),
        # Single-family-only ZHVI
        (ZILLOW_ZHVI_SFR_ZIP,    "zhvi-sfr-zip.csv",    "zhvi-sfr-zip.json",    "RegionName", lambda r: r.get("RegionName") in ZILLOW_TARGETS_ZIP),
        (ZILLOW_ZHVI_SFR_CITY,   "zhvi-sfr-city.csv",   "zhvi-sfr-city.json",   "RegionName", lambda r: r.get("RegionName") in ZILLOW_CITY_NAMES and r.get("State") == "CO"),
        (ZILLOW_ZHVI_SFR_COUNTY, "zhvi-sfr-county.csv", "zhvi-sfr-county.json", "RegionName", lambda r: r.get("RegionName") in ZILLOW_COUNTY_NAMES and r.get("State") == "CO"),
        (ZILLOW_ZHVI_SFR_STATE,  "zhvi-sfr-state.csv",  "zhvi-sfr-state.json",  "RegionName", lambda r: r.get("RegionName") == "Colorado"),
        # Condo / co-op-only ZHVI
        (ZILLOW_ZHVI_CONDO_ZIP,    "zhvi-condo-zip.csv",    "zhvi-condo-zip.json",    "RegionName", lambda r: r.get("RegionName") in ZILLOW_TARGETS_ZIP),
        (ZILLOW_ZHVI_CONDO_CITY,   "zhvi-condo-city.csv",   "zhvi-condo-city.json",   "RegionName", lambda r: r.get("RegionName") in ZILLOW_CITY_NAMES and r.get("State") == "CO"),
        (ZILLOW_ZHVI_CONDO_COUNTY, "zhvi-condo-county.csv", "zhvi-condo-county.json", "RegionName", lambda r: r.get("RegionName") in ZILLOW_COUNTY_NAMES and r.get("State") == "CO"),
        (ZILLOW_ZHVI_CONDO_STATE,  "zhvi-condo-state.csv",  "zhvi-condo-state.json",  "RegionName", lambda r: r.get("RegionName") == "Colorado"),
        # ZORI rents
        (ZILLOW_ZORI_ZIP,    "zori-zip.csv",    "zori-zip.json",    "RegionName", lambda r: r.get("RegionName") in ZILLOW_TARGETS_ZIP),
        (ZILLOW_ZORI_CITY,   "zori-city.csv",   "zori-city.json",   "RegionName", lambda r: r.get("RegionName") in ZILLOW_CITY_NAMES and r.get("State") == "CO"),
    ]
    for url, csv_name, json_name, key_field, match_fn in targets:
        path = _download_zillow(url, csv_name)
        if path is None:
            continue
        rows = _zillow_filter_records(_parse_zillow_csv(path), match_fn)
        norm = _zillow_to_normalized(rows, key_field=key_field)
        # Override key for state-level so the builder can match by 'CO'
        if "state" in json_name:
            for r in norm:
                r["key"] = "CO"
        # Override key for county to use 5-digit GEOID. Zillow County CSV
        # carries 'StateCodeFIPS' + 'MunicipalCodeFIPS' columns; we don't
        # have those preserved in our slim filter — county GEOID lookup
        # against the County name is sufficient for our 4 counties.
        if "county" in json_name:
            name_to_geoid = {
                "Garfield County": f"{STATE_FIPS}045",
                "Pitkin County": f"{STATE_FIPS}097",
                "Eagle County": f"{STATE_FIPS}037",
                "Mesa County": f"{STATE_FIPS}077",
            }
            for r in norm:
                r["key"] = name_to_geoid.get(r["name"], r["name"])
        _write_normalized(json_name, norm)
        print(f"  {csv_name} → {json_name} ({len(norm)} rows)", file=sys.stderr)


# ---------------------------------------------------------------------------
# HUD FMR
# ---------------------------------------------------------------------------
def fetch_hud_fmr(year: int) -> None:
    print(f"HUD FMR — county-level for {year}:", file=sys.stderr)
    if not hud_api.has_token():
        print("  ERROR: HUD_API_TOKEN required — skipping FMR pull", file=sys.stderr)
        return
    for cfips in COUNTY_FIPS.keys():
        geo = f"{STATE_FIPS}{cfips}"
        try:
            data = hud_api.fetch_fmr_county(geo, year)
            target = HUD_DIR / f"fmr-{geo}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(data, indent=2))
        except Exception as e:
            print(f"  [fmr {geo}] {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Census BPS — bulk-download annual flat files (no API)
# ---------------------------------------------------------------------------
BPS_BASE = "https://www2.census.gov/econ/bps/Place"

def fetch_bps(year: int) -> None:
    print(f"Census BPS — {year}:", file=sys.stderr)
    # The BPS publishes per-state annual XLSX. The naming convention is
    # `co{yy}a.txt` for annual flat files; the exact filename has changed
    # across vintages so this is best-effort.
    yy = str(year)[-2:]
    url = f"{BPS_BASE}/co{yy}a.txt"
    try:
        path = excel_scrape.download_to_cache(url, "bps", f"co{yy}a.txt")
        # Normalize is deferred — context_builders.housing reads the raw
        # cache file as-needed. Phase 4+ may add a parser.
        print(f"  cached {path.name}", file=sys.stderr)
    except Exception as e:
        print(f"  [bps {year}] {e}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    print("Fetching housing series into context-cache/{zillow,hud,bps}/…", file=sys.stderr)
    fetch_zillow()
    # HUD FMR FY runs Oct→Sep — latest FY usually published the prior September.
    for y in range(2022, 2027):
        fetch_hud_fmr(y)
    for y in range(2018, 2025):
        fetch_bps(y)
    print("Housing fetch complete.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
