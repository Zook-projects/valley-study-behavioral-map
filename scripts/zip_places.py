"""
zip_places.py — Census-derived ZIP → place lookup.

Source
------
Pulls a Census-derived ZIP/state/county/city crosswalk from a publicly
mirrored CSV. The underlying data is U.S. Census Bureau (public domain);
the mirror at github.com/scpike/us-state-county-zip just makes it directly
fetchable from a CI build without authentication.

Used by both build-data.py (full builds) and patch-place-names.py (surgical
backfill of existing zips.json / flows JSONs without a full rebuild).

Cleaning rules
--------------
- Title-case the raw city values ("Glenwood springs" → "Glenwood Springs").
- Drop "Zcta NNNNN" placeholder rows the upstream uses when Census had no
  named place; these add no signal over the bare ZIP and would clutter the
  export.
- Append ", {state}" only when state != "CO" (this study is Colorado-focused;
  in-state cities read more naturally without the suffix, while out-of-state
  ZIPs benefit from disambiguation).
"""

from __future__ import annotations

import csv
import sys
import urllib.request
from pathlib import Path

CENSUS_ZIP_CSV_URL = (
    "https://raw.githubusercontent.com/scpike/us-state-county-zip/master/geo-data.csv"
)
CENSUS_ZIP_CSV_FILENAME = "census-zip-to-city.csv"

# State abbreviation that gets a stripped (no suffix) place label. Anything
# else gets ", {state}" appended for disambiguation across same-name cities.
HOME_STATE = "CO"


def fetch_census_csv(cache_dir: Path) -> Path:
    """Return the local path to the Census ZIP CSV, fetching once if needed."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / CENSUS_ZIP_CSV_FILENAME
    if cached.exists() and cached.stat().st_size > 100_000:
        return cached
    print(
        f"  · fetching Census ZIP→city crosswalk from {CENSUS_ZIP_CSV_URL}",
        file=sys.stderr,
    )
    req = urllib.request.Request(
        CENSUS_ZIP_CSV_URL,
        headers={"User-Agent": "valley-commute-flows-build/1.0"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = resp.read()
    cached.write_bytes(body)
    return cached


def _clean_city(raw: str) -> str:
    """Title-case + filter Census placeholders. Returns empty string when the
    row carries no usable city label."""
    s = (raw or "").strip()
    if not s:
        return ""
    # Census placeholder for unnamed ZCTAs.
    if s.lower().startswith("zcta "):
        return ""
    # The mirror lowercases everything except the first letter; some entries
    # like "Glenwood springs" lose the second word's capital. Normalise.
    return " ".join(w.capitalize() for w in s.split())


def load_census_zip_places(cache_dir: Path) -> dict[str, str]:
    """Return a {zip: place} dict derived from the Census mirror.

    The first row encountered for each ZIP wins — the upstream sometimes has
    duplicate rows when a ZIP straddles multiple counties, and the first row
    is the primary city per the mirror's ordering. Empty / placeholder cities
    are skipped, so the returned dict only carries usable labels.
    """
    csv_path = fetch_census_csv(cache_dir)
    out: dict[str, str] = {}
    with csv_path.open(encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            zip_code = (row.get("zipcode") or "").strip()
            if not zip_code or not zip_code.isdigit():
                continue
            zip_code = zip_code.zfill(5)
            if zip_code in out:
                continue
            city = _clean_city(row.get("city", ""))
            if not city:
                continue
            state = (row.get("state_abbr") or "").strip().upper()
            if state and state != HOME_STATE:
                out[zip_code] = f"{city}, {state}"
            else:
                out[zip_code] = city
    return out


def merge_place_seed(
    census: dict[str, str],
    prior: dict[str, str],
    anchor_overrides: dict[str, str],
) -> dict[str, str]:
    """Three-layer merge with anchors winning, then prior, then Census.

    Empty-string values in `prior` are dropped so they don't shadow Census
    fallbacks for ZIPs the prior build couldn't name. The returned dict is
    safe for use as a defaulting place lookup.
    """
    seed: dict[str, str] = dict(census)
    for k, v in prior.items():
        if v and v.strip():
            seed[k] = v
    seed.update(anchor_overrides)
    return seed
