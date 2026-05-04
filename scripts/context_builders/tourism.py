"""
context_builders/tourism.py — Compose tourism.json from CDOR lodging tax,
QCEW NAICS 71/72 (already in BLS cache), BTS enplanements (manual drop),
RFTA Year-in-Review, CTO Longwoods, and municipal STR registries.

Most tourism keys land at the county or state level. Place-level tourism
data is sparse — lodging tax for a few cities, plus per-city STR counts
where the registry is public.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path

from context_schema import build_envelope, source, trend_series
from geographies import COUNTY_FIPS, STATE_FIPS, all_place_records

CACHE_ROOT = Path(__file__).resolve().parent.parent.parent / "data" / "context-cache"
CDOR_DIR = CACHE_ROOT / "cdor"
BTS_DIR = CACHE_ROOT / "bts"
QCEW_DIR = CACHE_ROOT / "bls" / "qcew" / "annual"
STR_DIR = CACHE_ROOT / "str"


def _cdor_lodging_for(name: str) -> dict:
    path = CDOR_DIR / "lodging-tax.json"
    if not path.exists():
        return {}
    try:
        with path.open() as f:
            rows = json.load(f)
    except json.JSONDecodeError:
        return {}
    target = name.upper()
    matched = []
    for r in rows:
        candidate = (
            r.get("jurisdiction_name")
            or r.get("jurisdiction")
            or r.get("location")
            or ""
        ).upper()
        if candidate == target:
            matched.append(r)
    if not matched:
        return {}
    total = 0.0
    any_v = False
    for r in matched:
        v = r.get("gross_taxable_sales") or r.get("gross_lodging_sales") or r.get("retail_sales")
        try:
            total += float(v)
            any_v = True
        except (TypeError, ValueError):
            continue
    return {"cdorLodgingTaxableSales": total} if any_v else {}


def _qcew_naics71_72(area_fips: str) -> dict:
    """QCEW NAICS 71 + 72 employment for the latest cached year."""
    if not QCEW_DIR.exists():
        return {}
    latest_year = -1
    block = {}
    for path in QCEW_DIR.glob(f"*-{area_fips}.csv"):
        # Extract year from filename: "YYYY-{area}.csv"
        try:
            y = int(path.stem.split("-")[0])
        except (ValueError, IndexError):
            continue
        if y < latest_year:
            continue
        with path.open() as f:
            for r in csv.DictReader(f):
                ic = r.get("industry_code") or r.get("industryCode")
                oc = r.get("own_code") or r.get("ownCode")
                if oc != "0":
                    continue
                if ic == "1071":
                    try:
                        block["qcewNaics71Emp"] = int(r["annual_avg_emplvl"])
                        latest_year = y
                    except (ValueError, KeyError):
                        pass
                elif ic == "1072":
                    try:
                        block["qcewNaics72Emp"] = int(r["annual_avg_emplvl"])
                        latest_year = y
                    except (ValueError, KeyError):
                        pass
    return block


def _bts_enplanements(airport: str) -> int | None:
    path = BTS_DIR / f"{airport.lower()}.csv"
    if not path.exists():
        return None
    try:
        with path.open() as f:
            rows = list(csv.DictReader(f))
        # Sum 'PASSENGERS' for the latest year.
        latest_year = max((int(r.get("YEAR", 0)) for r in rows if str(r.get("YEAR", "")).isdigit()), default=None)
        if latest_year is None:
            return None
        total = 0
        for r in rows:
            try:
                if int(r.get("YEAR")) == latest_year:
                    total += int(float(r.get("PASSENGERS", 0)))
            except (TypeError, ValueError):
                continue
        return total or None
    except Exception:
        return None


def _str_count(city_slug: str) -> int | None:
    """Read a normalized count from str/{slug}/normalized.json if present."""
    path = STR_DIR / city_slug / "normalized.json"
    if not path.exists():
        return None
    try:
        with path.open() as f:
            data = json.load(f)
        v = data.get("active_listings")
        return int(v) if v is not None else None
    except Exception:
        return None


def build_tourism() -> dict:
    # State block
    state_block = {}
    state_block.update(_qcew_naics71_72("08000"))
    state_block.update(_cdor_lodging_for("STATE OF COLORADO"))

    # Counties
    county_data = {}
    for cfips in COUNTY_FIPS.keys():
        geoid = f"{STATE_FIPS}{cfips}"
        block = _qcew_naics71_72(geoid)
        block.update(_cdor_lodging_for(f"{COUNTY_FIPS[cfips]}".upper()))
        # Airport enplanements pinned to the county where the airport sits
        if cfips == "097":  # Pitkin
            v = _bts_enplanements("ASE")
            if v is not None:
                block["aseEnplanements"] = v
        elif cfips == "037":  # Eagle
            v = _bts_enplanements("EGE")
            if v is not None:
                block["egeEnplanements"] = v
        elif cfips == "077":  # Mesa
            v = _bts_enplanements("GJT")
            if v is not None:
                block["gjtEnplanements"] = v
        county_data[geoid] = {"latest": block or None, "trend": {}}

    # Places — lodging tax for state-collected cities + STR counts
    place_data = {}
    for rec in all_place_records():
        block = {}
        block.update(_cdor_lodging_for(rec["name"]))
        slug = rec["name"].lower().replace(" ", "-")
        v = _str_count(slug)
        if v is not None:
            block["strActiveListings"] = v
        place_data[rec["zip"]] = {"latest": block or None, "trend": {}}

    return build_envelope(
        topic="tourism",
        vintage_start=2010,
        vintage_end=2024,
        sources=[
            source(
                id="CDOR_LODGING",
                agency="Colorado Department of Revenue",
                dataset="Lodging Tax Reports",
                endpoint="https://data.colorado.gov/resource/5xyk-vsx9.json",
            ),
            source(
                id="QCEW_TOURISM",
                agency="U.S. Bureau of Labor Statistics",
                dataset="QCEW NAICS 71 (Arts/Ent) + NAICS 72 (Accommodation/Food)",
                endpoint="https://data.bls.gov/cew/data/api",
            ),
            source(
                id="BTS_T100",
                agency="U.S. Bureau of Transportation Statistics",
                dataset="T-100 Domestic Segment Data",
                endpoint="https://www.transtats.bts.gov/",
            ),
            source(
                id="RFTA_YIR",
                agency="Roaring Fork Transportation Authority",
                dataset="Annual Year-in-Review",
                endpoint="https://www.rfta.com/public-documents/",
            ),
        ],
        state_data={"latest": state_block or None, "trend": {}},
        county_data=county_data,
        place_data=place_data,
    )
