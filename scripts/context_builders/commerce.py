"""
context_builders/commerce.py — Compose commerce.json from CDOR sales tax,
home-rule city reports, and Census CBP/ZBP establishment counts.

State-collected jurisdictions (De Beque, Parachute, New Castle, Rifle, Silt,
plus the 4 counties): pulled from CDOR Socrata.
Home-rule cities (Glenwood Springs, Aspen, Carbondale, Snowmass Village,
Basalt): manual file drops under data/context-cache/home-rule/{slug}/.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from context_schema import build_envelope, source, trend_series
from geographies import COUNTY_FIPS, STATE_FIPS, all_place_records

CACHE_ROOT = Path(__file__).resolve().parent.parent.parent / "data" / "context-cache"
CDOR_DIR = CACHE_ROOT / "cdor"
HOME_RULE_DIR = CACHE_ROOT / "home-rule"
CBP_DIR = CACHE_ROOT / "census" / "cbp"


def _load_cdor(label: str) -> list[dict]:
    path = CDOR_DIR / f"{label}.json"
    if not path.exists():
        return []
    try:
        with path.open() as f:
            return json.load(f)
    except json.JSONDecodeError:
        return []


def _sum_three_columns(matched: list[dict], industry_filter: str | None = None) -> tuple[dict, int | None]:
    """
    Sum gross_sales + retail_sales + state_net_taxable_sales by year from a
    list of monthly CDOR rows. Returns the three column totals for the
    most-recent year that has all 12 months published, plus that year.

    Year strings ship as either "2025" or "2025.0" depending on vintage —
    `int(float(...))` handles both. Only complete-year sums are returned so
    a year-to-date partial doesn't masquerade as an annual headline.
    """
    by_year: dict[int, dict[str, float]] = {}
    months_per_year: dict[int, int] = {}
    for r in matched:
        if industry_filter is not None and r.get("industry") != industry_filter:
            continue
        try:
            y = int(float(r.get("year") or r.get("data_year") or 0))
        except (TypeError, ValueError):
            continue
        bucket = by_year.setdefault(y, {"gross": 0.0, "retail": 0.0, "taxable": 0.0})
        any_value = False
        for key, col in (
            ("gross", "gross_sales"),
            ("retail", "retail_sales"),
            ("taxable", "state_net_taxable_sales"),
        ):
            try:
                bucket[key] += float(r.get(col))
                any_value = True
            except (TypeError, ValueError):
                continue
        if any_value:
            months_per_year[y] = months_per_year.get(y, 0) + 1
    if not by_year:
        return {}, None
    complete_years = [y for y, n in months_per_year.items() if n >= 12]
    latest_y = max(complete_years) if complete_years else max(by_year.keys())
    bucket = by_year[latest_y]
    return {
        "cdorGrossSales": bucket["gross"],
        "cdorRetailSales": bucket["retail"],
        "cdorNetTaxableSales": bucket["taxable"],
    }, latest_y


def _cdor_state_aggregate() -> tuple[dict, int | None]:
    """
    Sum state-level monthly rows from CDOR's 'Retail Reports by Industry in
    Colorado' dataset (6kn4-89kh). Filters to `industry == "Total"` (the
    canonical statewide monthly total) before summing.
    """
    rows = _load_cdor("retail-by-state")
    return _sum_three_columns(rows, industry_filter="Total")


def _cbp_for_county(geoid: str) -> dict:
    """Walk Census CBP cache and pull latest ESTAB/EMP for a county."""
    if not CBP_DIR.exists():
        return {}
    latest_year = -1
    block = {}
    for year_dir in CBP_DIR.iterdir():
        if not year_dir.is_dir():
            continue
        try:
            y = int(year_dir.name)
        except ValueError:
            continue
        if y < latest_year:
            continue
        for f in year_dir.glob("*.json"):
            try:
                with f.open() as fh:
                    data = json.load(fh)
            except Exception:
                continue
            if not data or len(data) < 2:
                continue
            header = data[0]
            for row in data[1:]:
                rec = dict(zip(header, row))
                if rec.get("state") == STATE_FIPS and rec.get("county") == geoid[2:]:
                    estab = rec.get("ESTAB")
                    emp = rec.get("EMP")
                    if estab is not None:
                        try:
                            block["cbpEstabCount"] = int(estab)
                        except (ValueError, TypeError):
                            pass
                    if emp is not None:
                        try:
                            block["cbpEmp"] = int(emp)
                        except (ValueError, TypeError):
                            pass
                    latest_year = y
    return block


def _cdor_aggregate_for_jurisdiction(name: str, *, level: str = "city") -> tuple[dict, int | None]:
    """
    Sum CDOR retail-report rows matching a jurisdiction name. Emits all three
    canonical CDOR columns — gross_sales, retail_sales, state_net_taxable_sales
    — so the UI can toggle which column to surface as the headline.
    """
    label = "retail-by-county" if level == "county" else "retail-by-city"
    rows = _load_cdor(label)
    if not rows:
        return {}, None
    target = name.upper()
    matched = [
        r for r in rows
        if (r.get("city") or r.get("county_name") or r.get("county")
            or r.get("jurisdiction") or r.get("location") or "").upper() == target
    ]
    return _sum_three_columns(matched)


def _home_rule_for_city(city_slug: str) -> dict:
    """Read any normalized JSON dropped under home-rule/{slug}/normalized.json."""
    path = HOME_RULE_DIR / city_slug / "normalized.json"
    if not path.exists():
        return {}
    try:
        with path.open() as f:
            data = json.load(f)
        # Expected shape: { latest: {...}, trend: [...] }
        return data.get("latest", {})
    except (json.JSONDecodeError, KeyError):
        return {}


def build_commerce() -> dict:
    # State block — pulled from CDOR's "Retail Reports by Industry in CO"
    # (dataset 6kn4-89kh), summing the 'Total' industry across all 12 months
    # per year for the latest available annual aggregate.
    state_block, state_latest_y = _cdor_state_aggregate()
    cdor_latest_years: list[int] = []
    if state_latest_y is not None:
        cdor_latest_years.append(state_latest_y)

    # Counties — CBP + CDOR retail-by-county
    county_data = {}
    for cfips in COUNTY_FIPS.keys():
        geoid = f"{STATE_FIPS}{cfips}"
        block = _cbp_for_county(geoid)
        # CDOR county dataset uses just "GARFIELD" / "PITKIN" — strip "COUNTY"
        county_lookup_name = COUNTY_FIPS[cfips].replace(" County", "")
        cdor_block, latest_y = _cdor_aggregate_for_jurisdiction(county_lookup_name, level="county")
        block.update(cdor_block)
        if latest_y is not None:
            cdor_latest_years.append(latest_y)
        county_data[geoid] = {"latest": block or None, "trend": {}}

    # Places — CDOR's "Retail Reports by City" includes both state-collected
    # AND home-rule jurisdictions because the underlying figures are gross
    # retail sales reported by retailers (regardless of who collects sales
    # tax). The home-rule manual-drop pathway is reserved for cases where a
    # city publishes more granular figures than CDOR exposes (sector splits,
    # monthly cadence) — fall back to CDOR by default.
    place_data = {}
    for rec in all_place_records():
        cdor_block, latest_y = _cdor_aggregate_for_jurisdiction(rec["name"], level="city")
        block = cdor_block
        if latest_y is not None:
            cdor_latest_years.append(latest_y)
        place_data[rec["zip"]] = {"latest": block or None, "trend": {}}

    actual_latest = max(cdor_latest_years) if cdor_latest_years else 2024
    return build_envelope(
        topic="commerce",
        vintage_start=2010,
        vintage_end=actual_latest,
        sources=[
            source(
                id="CDOR_SALES",
                agency="Colorado Department of Revenue",
                dataset="Sales Tax Statistics",
                endpoint="https://data.colorado.gov/resource/5sah-tx5b.json",
            ),
            source(
                id="CBP",
                agency="U.S. Census Bureau",
                dataset="County Business Patterns",
                endpoint="https://api.census.gov/data/2022/cbp",
            ),
            source(
                id="HOMERULE",
                agency="Home-rule cities (Glenwood / Aspen / Carbondale / Snowmass V / Basalt)",
                dataset="City Sales Tax Reports",
                endpoint="see context-cache/home-rule/MANIFEST.md",
            ),
        ],
        state_data={"latest": state_block or None, "trend": {}},
        county_data=county_data,
        place_data=place_data,
    )
