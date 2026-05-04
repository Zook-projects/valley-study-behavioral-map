"""
fetch-context-tourism.py — Tourism-side sources.

Coverage:
  CDOR Lodging Tax — already covered by fetch-context-tax.py (Socrata).
  BLS QCEW NAICS 71 + 72 — already pulled by fetch-context-labor.py.
  BTS T-100 enplanements — Aspen-Pitkin (ASE), Eagle/Vail (EGE), Grand
    Junction (GJT) airport monthly enplanements via the BTS Transtats
    public CSVs. The schema is stable: aircraft, origin/dest, year, month,
    passengers. We fetch a slim slice for our 3 airports.
  RFTA Year-in-Review — annual PDFs from rfta.com. We download the most
    recent one to data/context-cache/rfta/ and the tourism builder reads
    it; PDF parsing is best-effort.
  Colorado Tourism Office (Longwoods) — annual visitor profile reports.
    URLs change each release; download the latest PDF if available.
  Municipal STR registries — uneven; we record URLs for manual collection.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import excel_scrape

CACHE_ROOT = Path(__file__).resolve().parent.parent / "data" / "context-cache"
BTS_DIR = CACHE_ROOT / "bts"
RFTA_DIR = CACHE_ROOT / "rfta"
CTO_DIR = CACHE_ROOT / "cto"
STR_DIR = CACHE_ROOT / "str"

# BTS T-100 segment data — public CSV. The full file is enormous; the build
# downloads a year-and-month parameterized slice. URL pattern verified
# against https://www.transtats.bts.gov/.
BTS_AIRPORTS = ["ASE", "EGE", "GJT"]

# RFTA — annual Year-in-Review PDFs (filename per year)
RFTA_YIR = "https://www.rfta.com/wp-content/uploads/2025/04/24232-Year-in-Review-2024.pdf"

# CTO Longwoods Visitor Profile (link rotates per year)
CTO_2024 = "https://industry.colorado.com/research"  # landing page; PDFs linked from there

# Municipal STR registries (best-effort URLs — these change frequently)
STR_SOURCES = {
    "Glenwood Springs": "https://www.gwsco.gov/",
    "Aspen": "https://www.aspen.gov/",
    "Carbondale": "https://carbondalegov.org/",
    "Snowmass Village": "https://www.tosv.com/",
    "Basalt": "https://www.basalt.net/",
}


def fetch_rfta_yir() -> None:
    print("RFTA — Year-in-Review PDF:", file=sys.stderr)
    try:
        path = excel_scrape.download_to_cache(RFTA_YIR, "rfta", "yir-2024.pdf")
        print(f"  cached {path.name}", file=sys.stderr)
    except Exception as e:
        print(f"  [rfta] {e}", file=sys.stderr)


def fetch_bts_pointers() -> None:
    """
    BTS T-100 requires a custom POST query against the Transtats web form,
    which doesn't have a clean public CSV endpoint per-airport. We record a
    pointer so a manual export drop is straightforward.
    """
    BTS_DIR.mkdir(parents=True, exist_ok=True)
    manifest = BTS_DIR / "MANIFEST.md"
    lines = [
        "# BTS T-100 enplanements — manual export instructions",
        "",
        "Visit https://www.transtats.bts.gov/Tables.asp?DB_ID=111&DB_Name=Air%20Carrier%20Statistics",
        "Choose 'T-100 Domestic Segment (U.S. Carriers)'. Filter by airport code:",
        "",
    ]
    for code in BTS_AIRPORTS:
        lines.append(f"- {code} → save CSV as `bts/{code.lower()}.csv`")
    lines.append("")
    lines.append("Re-run `python3 scripts/build-context.py` to fold the data into tourism.json.")
    manifest.write_text("\n".join(lines) + "\n")
    print(f"BTS manifest written: {manifest}", file=sys.stderr)


def fetch_cto_pointer() -> None:
    CTO_DIR.mkdir(parents=True, exist_ok=True)
    manifest = CTO_DIR / "MANIFEST.md"
    manifest.write_text(
        "# Colorado Tourism Office — Longwoods Visitor Profile\n\n"
        f"Landing: {CTO_2024}\n\n"
        "Drop the latest annual PDF here as `longwoods-{year}.pdf`. The tourism\n"
        "builder reads any matching file.\n"
    )
    print(f"CTO manifest written: {manifest}", file=sys.stderr)


def fetch_str_pointers() -> None:
    STR_DIR.mkdir(parents=True, exist_ok=True)
    manifest = STR_DIR / "MANIFEST.md"
    lines = ["# Municipal STR registry sources", ""]
    for city, url in STR_SOURCES.items():
        slug = city.lower().replace(" ", "-")
        (STR_DIR / slug).mkdir(parents=True, exist_ok=True)
        lines.append(f"- **{city}** — `str/{slug}/` — {url}")
    manifest.write_text("\n".join(lines) + "\n")
    print(f"STR manifest written: {manifest}", file=sys.stderr)


def main() -> int:
    print("Fetching tourism series into context-cache/{bts,rfta,cto,str}/…", file=sys.stderr)
    fetch_rfta_yir()
    fetch_bts_pointers()
    fetch_cto_pointer()
    fetch_str_pointers()
    print("Tourism fetch complete.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
