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


def _aggregate_cdor(matched: list[dict], industry_filter: str | None = None) -> tuple[dict, dict, int | None]:
    """
    Sum gross_sales + retail_sales + state_net_taxable_sales from a list of
    monthly CDOR rows. Returns three things:

      - latest:   {cdorGrossSales, cdorRetailSales, cdorNetTaxableSales} for the
                  most-recent year with all 12 months published. Mirrors the
                  prior return contract so the headline card does not regress.
      - trend:    {annual: [...], monthly: [...]} covering 2016 → latest.
                    annual entries are emitted only for complete years (12
                    months reported) so YTD partials don't masquerade as
                    annual values.
                    monthly entries are emitted for every month present, in
                    chronological order — partial leading-edge months kept so
                    the chart shows true cadence.
      - latest_y: the year used for the latest block (None if no complete year).

    Year strings ship as either "2025" or "2025.0" depending on vintage —
    `int(float(...))` handles both.
    """
    by_year: dict[int, dict[str, float]] = {}
    months_per_year: dict[int, int] = {}
    by_month: dict[tuple[int, int], dict[str, float]] = {}

    for r in matched:
        if industry_filter is not None and r.get("industry") != industry_filter:
            continue
        try:
            y = int(float(r.get("year") or r.get("data_year") or 0))
        except (TypeError, ValueError):
            continue
        try:
            m = int(float(r.get("month") or 0))
        except (TypeError, ValueError):
            m = 0

        bucket = by_year.setdefault(y, {"gross": 0.0, "retail": 0.0, "taxable": 0.0})
        month_bucket = by_month.setdefault((y, m), {"gross": 0.0, "retail": 0.0, "taxable": 0.0})
        any_value = False
        for key, col in (
            ("gross", "gross_sales"),
            ("retail", "retail_sales"),
            ("taxable", "state_net_taxable_sales"),
        ):
            try:
                v = float(r.get(col))
            except (TypeError, ValueError):
                continue
            bucket[key] += v
            month_bucket[key] += v
            any_value = True
        if any_value:
            months_per_year[y] = months_per_year.get(y, 0) + 1

    if not by_year:
        return {}, {"annual": [], "monthly": []}, None

    complete_years = sorted(y for y, n in months_per_year.items() if n >= 12)
    latest_y = complete_years[-1] if complete_years else max(by_year.keys())
    latest_bucket = by_year[latest_y]
    latest = {
        "cdorGrossSales": latest_bucket["gross"],
        "cdorRetailSales": latest_bucket["retail"],
        "cdorNetTaxableSales": latest_bucket["taxable"],
    }

    annual = [
        {
            "year": y,
            "gross": by_year[y]["gross"],
            "retail": by_year[y]["retail"],
            "taxable": by_year[y]["taxable"],
        }
        for y in complete_years
    ]
    monthly = [
        {
            "year": y,
            "month": m,
            "gross": v["gross"],
            "retail": v["retail"],
            "taxable": v["taxable"],
        }
        for (y, m), v in sorted(by_month.items())
        if m >= 1 and m <= 12
    ]
    return latest, {"annual": annual, "monthly": monthly}, latest_y


def _cdor_state_aggregate() -> tuple[dict, dict, int | None]:
    """
    Sum state-level monthly rows from CDOR's 'Retail Reports by Industry in
    Colorado' dataset (6kn4-89kh). Filters to `industry == "Total"` (the
    canonical statewide monthly total) before summing.
    """
    rows = _load_cdor("retail-by-state")
    return _aggregate_cdor(rows, industry_filter="Total")


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


def _cdor_aggregate_for_jurisdiction(name: str, *, level: str = "city") -> tuple[dict, dict, int | None]:
    """
    Sum CDOR retail-report rows matching a jurisdiction name. Emits all three
    canonical CDOR columns — gross_sales, retail_sales, state_net_taxable_sales
    — so the UI can toggle which column to surface as the headline.
    """
    label = "retail-by-county" if level == "county" else "retail-by-city"
    rows = _load_cdor(label)
    if not rows:
        return {}, {"annual": [], "monthly": []}, None
    target = name.upper()
    matched = [
        r for r in rows
        if (r.get("city") or r.get("county_name") or r.get("county")
            or r.get("jurisdiction") or r.get("location") or "").upper() == target
    ]
    return _aggregate_cdor(matched)


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


def _share_of_county(place_trend: dict, county_trend: dict) -> dict:
    """
    Compute a place's share of its county for each measure, both annually
    (matching years in the place vs county series) and monthly. Surfaces a
    "latest" block keyed off the latest year present in BOTH series so the
    UI can drop a clean "(X% of County)" label without re-deriving it client-
    side. Returns an empty payload when the county series is missing.

    Shares are emitted as fractions in [0, 1] (or above 1 for the rare case
    where a place exceeds its county totals — e.g., a regional retail hub
    pulling cross-county shoppers, which CDOR captures by point-of-sale).
    """
    if not county_trend or not place_trend:
        return {}
    county_annual_by_year = {row["year"]: row for row in county_trend.get("annual", [])}
    annual = []
    for row in place_trend.get("annual", []):
        c = county_annual_by_year.get(row["year"])
        if not c:
            continue
        annual.append({
            "year": row["year"],
            "gross": (row["gross"] / c["gross"]) if c.get("gross") else None,
            "retail": (row["retail"] / c["retail"]) if c.get("retail") else None,
            "taxable": (row["taxable"] / c["taxable"]) if c.get("taxable") else None,
        })

    county_monthly_by_key = {(r["year"], r["month"]): r for r in county_trend.get("monthly", [])}
    monthly = []
    for row in place_trend.get("monthly", []):
        c = county_monthly_by_key.get((row["year"], row["month"]))
        if not c:
            continue
        monthly.append({
            "year": row["year"],
            "month": row["month"],
            "gross": (row["gross"] / c["gross"]) if c.get("gross") else None,
            "retail": (row["retail"] / c["retail"]) if c.get("retail") else None,
            "taxable": (row["taxable"] / c["taxable"]) if c.get("taxable") else None,
        })

    latest_block = annual[-1] if annual else None
    return {
        "latest": latest_block,
        "annual": annual,
        "monthly": monthly,
    }


def build_commerce() -> dict:
    # State block — pulled from CDOR's "Retail Reports by Industry in CO"
    # (dataset 6kn4-89kh), summing the 'Total' industry across all 12 months
    # per year for the latest available annual aggregate.
    state_block, state_trend, state_latest_y = _cdor_state_aggregate()
    cdor_latest_years: list[int] = []
    if state_latest_y is not None:
        cdor_latest_years.append(state_latest_y)

    # Counties — CBP + CDOR retail-by-county
    county_data = {}
    county_trends: dict[str, dict] = {}
    for cfips in COUNTY_FIPS.keys():
        geoid = f"{STATE_FIPS}{cfips}"
        block = _cbp_for_county(geoid)
        # CDOR county dataset uses just "GARFIELD" / "PITKIN" — strip "COUNTY"
        county_lookup_name = COUNTY_FIPS[cfips].replace(" County", "")
        cdor_block, county_trend, latest_y = _cdor_aggregate_for_jurisdiction(county_lookup_name, level="county")
        block.update(cdor_block)
        if latest_y is not None:
            cdor_latest_years.append(latest_y)
        county_data[geoid] = {"latest": block or None, "trend": county_trend}
        county_trends[geoid] = county_trend

    # Places — CDOR's "Retail Reports by City" includes both state-collected
    # AND home-rule jurisdictions because the underlying figures are gross
    # retail sales reported by retailers (regardless of who collects sales
    # tax). The home-rule manual-drop pathway is reserved for cases where a
    # city publishes more granular figures than CDOR exposes (sector splits,
    # monthly cadence) — fall back to CDOR by default.
    #
    # Each place also gets a `shareOfCounty` block precomputed against its
    # containing county so the UI can render "(X% of County)" labels and a
    # county-share comparison bar without redoing arithmetic on the client.
    place_data = {}
    for rec in all_place_records():
        cdor_block, place_trend, latest_y = _cdor_aggregate_for_jurisdiction(rec["name"], level="city")
        block = cdor_block
        if latest_y is not None:
            cdor_latest_years.append(latest_y)
        county_geoid = rec.get("county_geoid")
        share_block = _share_of_county(place_trend, county_trends.get(county_geoid, {}))
        place_data[rec["zip"]] = {
            "latest": block or None,
            "trend": place_trend,
            "shareOfCounty": share_block,
        }

    actual_latest = max(cdor_latest_years) if cdor_latest_years else 2024

    # 2016 coverage assertion — fail the build if any populated trend lost
    # historical depth. CDOR Socrata has had 2016 forward since the dataset
    # was provisioned; a regression would indicate the upstream pull dropped
    # rows. Assertion is a single-line guard; raises rather than warns so the
    # broken JSON never ships.
    for label, payload in (
        ("state", state_trend),
        *((f"county {gid}", t) for gid, t in county_trends.items()),
    ):
        annual = payload.get("annual") if payload else None
        if annual:
            first_year = annual[0]["year"]
            if first_year > 2016:
                raise AssertionError(
                    f"commerce trend coverage regressed: {label} starts at {first_year}, expected <= 2016"
                )

    return build_envelope(
        topic="commerce",
        vintage_start=2016,
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
        state_data={"latest": state_block or None, "trend": state_trend},
        county_data=county_data,
        place_data=place_data,
    )
