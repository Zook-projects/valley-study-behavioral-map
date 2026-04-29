#!/usr/bin/env python3
"""
fetch-lodes.py — One-time download + filter for LODES8 Colorado bulk files.

Pulls the canonical block-level LODES extracts directly from the LEHD endpoint
and filters them down to rows that touch the 11 anchor ZCTAs of the Roaring
Fork / Western Garfield study area. Intermediate raw .csv.gz files and the
filtered per-year CSVs are cached under data/lodes-cache/ so subsequent builds
run offline.

Filter scope:
  - RAC: rows whose h_geocode is in any of the 11 anchor ZCTAs.
  - WAC: rows whose w_geocode is in any of the 11 anchor ZCTAs.
  - OD main (in-state CO): rows where either endpoint is in our anchor blocks.
    This captures every commute that touches the study area, in both directions.
  - OD aux (workplace in CO, residence out of state): rows where w_geocode is in
    our anchor blocks. This adds out-of-state inflow workers.

Coverage gap (documented):
  Out-of-state OUTFLOWS (residents of our 11 ZCTAs working in another state) live
  in OTHER states' OD aux files. We do not pull those — for the Roaring Fork
  Valley they are a small minority of total outflow. The build will treat any
  unmapped flow endpoint as ALL_OTHER, consistent with the existing pipeline.

Run via: python3 scripts/fetch-lodes.py
"""

from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------------------
# Paths / config
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
VAULT_DIR = PROJECT_ROOT.parent  # .../Valley Study - Behavioral Map/

CACHE_DIR = PROJECT_ROOT / "data" / "lodes-cache"
RAW_DIR = CACHE_DIR / "raw"
FILTERED_DIR = CACHE_DIR / "filtered"
RAW_DIR.mkdir(parents=True, exist_ok=True)
FILTERED_DIR.mkdir(parents=True, exist_ok=True)

# OnTheMap-exported xwalk that defines the 11 anchor ZCTAs and their member
# blocks. Treated as the authoritative inclusion filter for the study area.
ANCHOR_XWALK = (
    VAULT_DIR
    / "Area Characteristics - LODES"
    / "Metadata"
    / "xwalk_5a50a3e01d538ef651de716dd7cd9a09.xlsx"
)

STATE = "co"
BASE_URL = f"https://lehd.ces.census.gov/data/lodes/LODES8/{STATE}"
YEARS = list(range(2002, 2024))  # 22 vintages, inclusive


# ---------------------------------------------------------------------------
# Download helper
# ---------------------------------------------------------------------------
def download(url: str, dest: Path) -> bool:
    """Idempotent download. Returns True if a fetch happened, False if cached."""
    if dest.exists() and dest.stat().st_size > 0:
        return False
    print(f"  fetching {url}", file=sys.stderr)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        urllib.request.urlretrieve(url, tmp)
        tmp.rename(dest)
    except Exception:
        if tmp.exists():
            tmp.unlink()
        raise
    return True


# ---------------------------------------------------------------------------
# Per-year filters
# ---------------------------------------------------------------------------
def filter_rac(year: int, anchor_blocks: set[str], state_b2z: dict[str, str]) -> None:
    raw = RAW_DIR / f"{STATE}_rac_S000_JT00_{year}.csv.gz"
    out = FILTERED_DIR / f"rac-{year}.csv"
    download(f"{BASE_URL}/rac/{raw.name}", raw)
    if out.exists():
        return
    df = pd.read_csv(raw, dtype={"h_geocode": str})
    sub = df[df["h_geocode"].isin(anchor_blocks)].copy()
    sub.insert(0, "year", year)
    sub.insert(2, "zcta", sub["h_geocode"].map(state_b2z))
    sub = sub.sort_values(["zcta", "h_geocode"]).reset_index(drop=True)
    sub.to_csv(out, index=False)
    print(f"  RAC {year}: {len(df):,}→{len(sub):,} rows", file=sys.stderr)


def filter_wac(year: int, anchor_blocks: set[str], state_b2z: dict[str, str]) -> None:
    raw = RAW_DIR / f"{STATE}_wac_S000_JT00_{year}.csv.gz"
    out = FILTERED_DIR / f"wac-{year}.csv"
    download(f"{BASE_URL}/wac/{raw.name}", raw)
    if out.exists():
        return
    df = pd.read_csv(raw, dtype={"w_geocode": str})
    sub = df[df["w_geocode"].isin(anchor_blocks)].copy()
    sub.insert(0, "year", year)
    sub.insert(2, "zcta", sub["w_geocode"].map(state_b2z))
    sub = sub.sort_values(["zcta", "w_geocode"]).reset_index(drop=True)
    sub.to_csv(out, index=False)
    print(f"  WAC {year}: {len(df):,}→{len(sub):,} rows", file=sys.stderr)


def filter_od(year: int, anchor_blocks: set[str], state_b2z: dict[str, str]) -> None:
    main_raw = RAW_DIR / f"{STATE}_od_main_JT00_{year}.csv.gz"
    aux_raw = RAW_DIR / f"{STATE}_od_aux_JT00_{year}.csv.gz"
    out = FILTERED_DIR / f"od-{year}.csv"
    download(f"{BASE_URL}/od/{main_raw.name}", main_raw)
    download(f"{BASE_URL}/od/{aux_raw.name}", aux_raw)
    if out.exists():
        return
    dfm = pd.read_csv(main_raw, dtype={"h_geocode": str, "w_geocode": str})
    dfa = pd.read_csv(aux_raw,  dtype={"h_geocode": str, "w_geocode": str})

    mask_m = dfm["h_geocode"].isin(anchor_blocks) | dfm["w_geocode"].isin(anchor_blocks)
    mask_a = dfa["w_geocode"].isin(anchor_blocks)
    sub_m = dfm[mask_m].copy()
    sub_a = dfa[mask_a].copy()
    sub_m["origin_kind"] = "main"
    sub_a["origin_kind"] = "aux"
    sub = pd.concat([sub_m, sub_a], ignore_index=True)

    # Resolve ZCTAs where possible (statewide xwalk covers in-state CO only).
    sub["h_zcta"] = sub["h_geocode"].map(state_b2z)
    sub["w_zcta"] = sub["w_geocode"].map(state_b2z)
    # State FIPS prefix — used downstream to bucket out-of-state endpoints.
    sub["h_state"] = sub["h_geocode"].str[:2]
    sub["w_state"] = sub["w_geocode"].str[:2]

    sub.insert(0, "year", year)
    sub = sub.sort_values(["w_geocode", "h_geocode"]).reset_index(drop=True)
    sub.to_csv(out, index=False)
    print(
        f"  OD  {year}: main {len(dfm):,}→{len(sub_m):,}, "
        f"aux {len(dfa):,}→{len(sub_a):,}",
        file=sys.stderr,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    if not ANCHOR_XWALK.exists():
        print(f"missing anchor xwalk: {ANCHOR_XWALK}", file=sys.stderr)
        return 1

    print(f"loading anchor xwalk: {ANCHOR_XWALK.name}", file=sys.stderr)
    xw = pd.read_excel(ANCHOR_XWALK, dtype=str)
    anchor_blocks = set(xw["tabblk2020"])
    anchor_zctas = sorted(xw["zcta"].unique())
    print(
        f"  → {len(anchor_blocks):,} blocks across {len(anchor_zctas)} ZCTAs: "
        f"{anchor_zctas}",
        file=sys.stderr,
    )

    # Pull the statewide CO xwalk for resolving external CO blocks → ZCTAs.
    state_xwalk_raw = RAW_DIR / f"{STATE}_xwalk.csv.gz"
    download(f"{BASE_URL}/{STATE}_xwalk.csv.gz", state_xwalk_raw)
    print("loading statewide CO xwalk…", file=sys.stderr)
    sxw = pd.read_csv(state_xwalk_raw, dtype=str, usecols=["tabblk2020", "zcta"])
    state_b2z = dict(zip(sxw["tabblk2020"], sxw["zcta"]))
    print(f"  → {len(state_b2z):,} block→ZCTA mappings", file=sys.stderr)

    # Sanity: every anchor block in the OnTheMap xwalk should be in the
    # statewide xwalk and resolve to the same ZCTA.
    a2z = dict(zip(xw["tabblk2020"], xw["zcta"]))
    mismatches = [b for b, z in a2z.items() if state_b2z.get(b) != z]
    if mismatches:
        print(
            f"  ! {len(mismatches)} anchor blocks disagree with statewide xwalk; "
            "first 5: " + str(mismatches[:5]),
            file=sys.stderr,
        )

    for year in YEARS:
        print(f"\n--- {year} ---", file=sys.stderr)
        filter_rac(year, anchor_blocks, state_b2z)
        filter_wac(year, anchor_blocks, state_b2z)
        filter_od(year, anchor_blocks, state_b2z)

    print("\nfetch-lodes.py done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
