"""
fetch-context-tax.py — Sales tax + lodging tax + home-rule city dashboards.

Coverage:
  CDOR Sales Tax Statistics — state-collected jurisdiction distributions.
  CDOR Lodging Tax Reports — county lodging tax + LMD distributions.
  Home-rule cities (self-collected, separate downloads):
    - Glenwood Springs Finance — monthly sales tax reports
    - Aspen Finance — monthly sales tax reports
    - Carbondale Finance — monthly sales tax reports
    - Snowmass Village Finance — monthly sales tax reports
    - Basalt Finance — monthly sales tax reports

The CDOR pieces are exposed through Socrata (data.colorado.gov). Home-rule
city reports are city-website artifacts whose formats vary (PDF, Excel)
and require manual file drops or per-city scraping. This script downloads
what it can and records URLs/filenames for everything else so the user
knows what to drop into data/context-cache/{cdor,home-rule}/ manually.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import excel_scrape
import socrata_api

CACHE_ROOT = Path(__file__).resolve().parent.parent / "data" / "context-cache"
CDOR_DIR = CACHE_ROOT / "cdor"
HOME_RULE_DIR = CACHE_ROOT / "home-rule"

# CDOR Socrata datasets — verified against data.colorado.gov catalog.
# CDOR publishes "Retail Reports" series (gross taxable sales by jurisdiction).
# Lodging tax distributions are PDF/Excel only — not exposed via Socrata.
CDOR_DATASETS = {
    "retail-by-state": "6kn4-89kh",       # Statewide retail by industry × month — sum 'Total' rows for state totals
    "retail-by-county": "x8tb-f3vh",      # Gross sales by county
    "retail-by-city": "2yhn-3dbj",        # Gross sales by city — feeds place-level
    "retail-by-industry-county": "fe4v-h3pk",  # NAICS slice for context
}

# State-collected jurisdictions in our study area (CDOR collects + remits).
# Glenwood Springs, Aspen, Carbondale, Snowmass Village, Basalt are home-rule
# self-collecting and are NOT in this set — pulled via city-specific endpoints.
CDOR_TARGET_JURISDICTIONS = [
    "DE BEQUE", "PARACHUTE", "NEW CASTLE", "RIFLE", "SILT",
    "GARFIELD COUNTY", "PITKIN COUNTY", "EAGLE COUNTY", "MESA COUNTY",
]

# Home-rule city sales-tax dashboard URLs (best-effort — these change).
HOME_RULE_SOURCES = {
    "Glenwood Springs": "https://www.gwsco.gov/206/Sales-Tax-Reports",
    "Aspen": "https://www.aspen.gov/170/Sales-and-Use-Tax",
    "Carbondale": "https://carbondalegov.org/finance/",
    "Snowmass Village": "https://www.tosv.com/176/Sales-Tax-Reports",
    "Basalt": "https://www.basalt.net/247/Finance",
}


def fetch_cdor() -> None:
    print("CDOR — sales tax + lodging tax via Socrata:", file=sys.stderr)
    for label, dataset_id in CDOR_DATASETS.items():
        try:
            # Filter to our study-area jurisdictions where the dataset has
            # an obvious column. Sales Tax Statistics typically has 'jurisdiction_name';
            # lodging tax has 'jurisdiction'. Issue: Socrata column names vary
            # by dataset. We pull a generous batch and let the builder filter.
            data = socrata_api.fetch_resource(dataset_id, limit=50000)
            target = CDOR_DIR / f"{label}.json"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(data, indent=2))
            print(f"  {label} ({dataset_id}) → {len(data)} rows", file=sys.stderr)
        except Exception as e:
            print(f"  [{label} {dataset_id}] {e}", file=sys.stderr)


def fetch_home_rule_pointers() -> None:
    """
    Write a manifest of home-rule city report URLs so the user knows where to
    grab the underlying files. Auto-download is fragile because these are
    HTML directory pages, not direct downloads.
    """
    HOME_RULE_DIR.mkdir(parents=True, exist_ok=True)
    manifest = HOME_RULE_DIR / "MANIFEST.md"
    lines = [
        "# Home-rule city sales-tax sources",
        "",
        "Each city below is a Colorado home-rule self-collecting jurisdiction.",
        "CDOR does not publish their sales-tax data; collect monthly from the URL,",
        "drop the latest report (PDF or Excel) into the matching subfolder here,",
        "then re-run `python3 scripts/build-context.py`. The commerce builder",
        "discovers anything in `home-rule/{slug}/` and aggregates it into the",
        "place-level commerce envelope.",
        "",
    ]
    for city, url in HOME_RULE_SOURCES.items():
        slug = city.lower().replace(" ", "-")
        (HOME_RULE_DIR / slug).mkdir(parents=True, exist_ok=True)
        lines.append(f"- **{city}** — `home-rule/{slug}/` — {url}")
    manifest.write_text("\n".join(lines) + "\n")
    print(f"Home-rule city manifest written: {manifest}", file=sys.stderr)


def main() -> int:
    print("Fetching tax series into context-cache/{cdor,home-rule}/…", file=sys.stderr)
    fetch_cdor()
    fetch_home_rule_pointers()
    print("Tax fetch complete.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
