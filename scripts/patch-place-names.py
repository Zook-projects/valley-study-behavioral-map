#!/usr/bin/env python3
"""
patch-place-names.py — Surgical backfill of empty `place` fields in the
already-built data outputs without a full rebuild.

Reads & writes (all under public/data/):
  - zips.json
  - flows-inbound.json
  - flows-outbound.json
  - flows-passthrough.json (places stay derived at runtime; this script
    leaves it untouched)

Place-name precedence (same as build-data.py):
  1. Existing non-empty value (preserved, no overwrite)
  2. ANCHOR_PLACE_NAMES override
  3. Census ZIP→city crosswalk fallback

Use this whenever the Census source updates, or when you want to populate
labels for ZIPs the prior build left blank, without paying the full LODES
+ OSRM rebuild cost.

Run via: python3 scripts/patch-place-names.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from anchors import ANCHOR_PLACE_NAMES
from zip_places import load_census_zip_places

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
OUT_DIR = PROJECT_ROOT / "public" / "data"
ZIP_PLACES_CACHE_DIR = PROJECT_ROOT / "data" / "uszips-cache"


def resolve(zip_code: str, current: str, census: dict[str, str]) -> str:
    """Return the best place name for `zip_code` given the current value."""
    if zip_code == "ALL_OTHER":
        # The synthetic ALL_OTHER node carries its own canonical label set in
        # build-data.py. Don't overwrite it.
        return current
    # Anchors always win.
    anchor = ANCHOR_PLACE_NAMES.get(zip_code)
    if anchor:
        return anchor
    # Preserve any existing non-empty label (hand overrides).
    if current and current.strip():
        return current
    # Census fallback.
    return census.get(zip_code, "")


def patch_zips(census: dict[str, str]) -> tuple[int, int]:
    """Return (patched_count, total_count)."""
    path = OUT_DIR / "zips.json"
    data = json.loads(path.read_text())
    patched = 0
    for entry in data:
        zip_code = entry.get("zip", "")
        old = entry.get("place", "") or ""
        new = resolve(zip_code, old, census)
        if new != old:
            entry["place"] = new
            patched += 1
    path.write_text(json.dumps(data, indent=2))
    return patched, len(data)


def patch_flows(filename: str, census: dict[str, str]) -> tuple[int, int]:
    """Return (patched_field_count, total_rows). Updates both originPlace
    and destPlace where empty."""
    path = OUT_DIR / filename
    data = json.loads(path.read_text())
    patched = 0
    for row in data:
        for side, zip_field, place_field in (
            ("origin", "originZip", "originPlace"),
            ("dest", "destZip", "destPlace"),
        ):
            zip_code = row.get(zip_field, "")
            old = row.get(place_field, "") or ""
            new = resolve(zip_code, old, census)
            if new != old:
                row[place_field] = new
                patched += 1
    path.write_text(json.dumps(data, indent=2))
    return patched, len(data)


def main() -> None:
    if not OUT_DIR.exists():
        print(f"missing {OUT_DIR} — run build-data.py first", file=sys.stderr)
        sys.exit(1)

    print("loading Census ZIP→city crosswalk…", file=sys.stderr)
    census = load_census_zip_places(ZIP_PLACES_CACHE_DIR)
    print(f"  → {len(census):,} ZIP→city entries", file=sys.stderr)

    print("patching zips.json…", file=sys.stderr)
    z_patched, z_total = patch_zips(census)
    print(f"  → patched {z_patched:,} / {z_total:,} ZIP rows", file=sys.stderr)

    for fname in ("flows-inbound.json", "flows-outbound.json"):
        print(f"patching {fname}…", file=sys.stderr)
        f_patched, f_total = patch_flows(fname, census)
        print(f"  → patched {f_patched:,} place fields across {f_total:,} flow rows", file=sys.stderr)

    print("done.", file=sys.stderr)


if __name__ == "__main__":
    main()
