#!/usr/bin/env python3
"""
build-passthrough.py — Extract latest-year pass-through OD flows per anchor.

Mode-aware pass-through definition for anchor A:
  - residence != A AND workplace != A
  - residence and workplace flank A longitudinally (XOR east/west of A)
  - inbound bucket:  workplace ∈ ANCHOR_ZIPS - {A}
                     (residence may be any non-A ZCTA on the opposite side)
  - outbound bucket: residence ∈ ANCHOR_ZIPS - {A}
                     (workplace may be any non-A ZCTA on the opposite side)

A given pair can appear in both buckets when both endpoints are anchors —
that is anchor-to-anchor pass-through, which legitimately surfaces on either
mode.

Reads:
  - data/lodes-cache/raw/co_od_main_JT00_{LATEST_YEAR}.csv.gz
  - data/lodes-cache/raw/co_xwalk.csv.gz
  - 2024 ZCTA Gazetteer (cached under data/lodes-cache/gazetteer/; downloaded
    on first call via geo.load_gazetteer)

Writes public/data/flows-passthrough.json with shape:
  {
    "year": 2023,
    "pairsPerAnchorPerMode": 5000,
    "byAnchor": {
      "81601": {
        "inbound":  { "pairs": [...], "residual": 0 },
        "outbound": { "pairs": [...], "residual": 0 }
      },
      ...
    }
  }

Run via: python3 scripts/build-passthrough.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

import lodes  # for LATEST_YEAR
from anchors import ANCHOR_ZIPS, CITY_CENTROIDS
from geo import load_gazetteer

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
RAW_DIR = PROJECT_ROOT / "data" / "lodes-cache" / "raw"
OUT_PATH = PROJECT_ROOT / "public" / "data" / "flows-passthrough.json"
GAZETTEER_CACHE_DIR = PROJECT_ROOT / "data" / "lodes-cache" / "gazetteer"

LATEST_YEAR = lodes.LATEST_YEAR

# Per-anchor, per-mode pair cap. Top N pairs by worker count are emitted
# explicitly; the remaining tail collapses into a single residual integer
# surfaced as "All other locations" in the dashboard. 5000 is generous
# enough that the residual stays small in practice — for inbound/outbound
# slices restricted to anchor endpoints, total pair volume is well below
# the cap and the cap effectively never bites.
PAIRS_PER_ANCHOR_PER_MODE = 5000


def load_gazetteer_lng() -> dict[str, float]:
    """Return ZCTA → centroid longitude. Pass-through is E/W-only so the
    latitude is unused — derive from the shared loader and drop lat."""
    centroids = load_gazetteer(GAZETTEER_CACHE_DIR)
    return {z: lng for z, (_lat, lng) in centroids.items()}


def slice_top_and_residual(
    sub: pd.DataFrame, cap: int
) -> tuple[list[dict], int]:
    """Sort sub by worker count desc, take the top-cap rows as records, and
    sum the rest into a single residual integer."""
    if sub.empty:
        return [], 0
    sub = sub.sort_values("workerCount", ascending=False)
    head = sub.head(cap)
    residual = (
        int(sub["workerCount"].iloc[cap:].sum()) if len(sub) > cap else 0
    )
    records = [
        {
            "originZip": str(row["h_zcta"]),
            "destZip": str(row["w_zcta"]),
            "workerCount": int(row["workerCount"]),
        }
        for _, row in head.iterrows()
    ]
    return records, residual


def main() -> int:
    main_raw = RAW_DIR / f"co_od_main_JT00_{LATEST_YEAR}.csv.gz"
    xwalk_raw = RAW_DIR / "co_xwalk.csv.gz"
    if not main_raw.exists() or not xwalk_raw.exists():
        print(
            f"missing inputs:\n  {main_raw}\n  {xwalk_raw}\n"
            f"Run scripts/fetch-lodes.py first.",
            file=sys.stderr,
        )
        return 1

    print(f"loading CO statewide block→ZCTA xwalk…", file=sys.stderr)
    sxw = pd.read_csv(xwalk_raw, dtype=str, usecols=["tabblk2020", "zcta"])
    block_to_zcta = dict(zip(sxw["tabblk2020"], sxw["zcta"]))

    # Override anchor centroids onto the gazetteer so the E/W classification
    # uses the city-center coordinates the rest of the app already trusts.
    print(f"loading ZCTA centroids (longitude only)…", file=sys.stderr)
    zcta_lng = load_gazetteer_lng()
    for zip_code, (_lat, lng) in CITY_CENTROIDS.items():
        zcta_lng[zip_code] = lng

    print(
        f"reading CO OD main {LATEST_YEAR} ({main_raw.name})…", file=sys.stderr
    )
    df = pd.read_csv(
        main_raw,
        dtype={"h_geocode": str, "w_geocode": str},
        usecols=["h_geocode", "w_geocode", "S000"],
    )
    print(f"  → {len(df):,} OD rows", file=sys.stderr)

    # Resolve to ZCTAs via the statewide xwalk.
    df["h_zcta"] = df["h_geocode"].map(block_to_zcta)
    df["w_zcta"] = df["w_geocode"].map(block_to_zcta)
    before = len(df)
    df = df.dropna(subset=["h_zcta", "w_zcta"])
    print(
        f"  → {len(df):,} after ZCTA resolution "
        f"(dropped {before - len(df):,} unmapped)",
        file=sys.stderr,
    )

    # Drop rows with no centroid for either side. Without longitude we can't
    # decide which side of an anchor a ZIP sits on.
    pre_lng = len(df)
    df = df[df["h_zcta"].isin(zcta_lng) & df["w_zcta"].isin(zcta_lng)]
    print(
        f"  → {len(df):,} after centroid filter "
        f"(dropped {pre_lng - len(df):,})",
        file=sys.stderr,
    )

    # Pre-aggregate by (h_zcta, w_zcta) so the per-anchor pass below operates
    # on unique pairs rather than block-level rows. We INTENTIONALLY do not
    # drop anchor-touching pairs here — pairs where one endpoint is another
    # anchor are valid pass-through commutes for a third-anchor view, and
    # they drive the inbound/outbound mode-aware buckets below.
    agg = (
        df.groupby(["h_zcta", "w_zcta"], as_index=False)["S000"]
        .sum()
        .rename(columns={"S000": "workerCount"})
    )
    agg["h_lng"] = agg["h_zcta"].map(zcta_lng)
    agg["w_lng"] = agg["w_zcta"].map(zcta_lng)
    print(
        f"  → {len(agg):,} unique ZCTA→ZCTA pairs",
        file=sys.stderr,
    )

    by_anchor: dict[str, dict] = {}
    for anchor_zip, (_lat, anchor_lng) in CITY_CENTROIDS.items():
        # Pass-through requires the selected anchor itself to be excluded
        # on both sides, but the OTHER 10 anchors remain valid endpoints.
        not_a = (agg["h_zcta"] != anchor_zip) & (agg["w_zcta"] != anchor_zip)
        # E/W flank check.
        h_east = agg["h_lng"] > anchor_lng
        w_east = agg["w_lng"] > anchor_lng
        flanks = h_east ^ w_east
        flank_sub = agg[not_a & flanks]

        # Inbound mode: workplace ∈ ANCHOR_ZIPS - {anchor_zip}. The selected
        # anchor itself is already excluded by `not_a`, so isin(ANCHOR_ZIPS)
        # implicitly resolves to "the other 10 anchors".
        inbound_sub = flank_sub[flank_sub["w_zcta"].isin(ANCHOR_ZIPS)]
        inbound_pairs, inbound_residual = slice_top_and_residual(
            inbound_sub, PAIRS_PER_ANCHOR_PER_MODE
        )

        # Outbound mode: residence ∈ ANCHOR_ZIPS - {anchor_zip}.
        outbound_sub = flank_sub[flank_sub["h_zcta"].isin(ANCHOR_ZIPS)]
        outbound_pairs, outbound_residual = slice_top_and_residual(
            outbound_sub, PAIRS_PER_ANCHOR_PER_MODE
        )

        by_anchor[anchor_zip] = {
            "inbound": {"pairs": inbound_pairs, "residual": inbound_residual},
            "outbound": {"pairs": outbound_pairs, "residual": outbound_residual},
        }

    out = {
        "year": LATEST_YEAR,
        "pairsPerAnchorPerMode": PAIRS_PER_ANCHOR_PER_MODE,
        "byAnchor": by_anchor,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"\nwrote {OUT_PATH}", file=sys.stderr)
    print(
        f"\nQA — per-anchor pass-through totals (latest year):", file=sys.stderr
    )
    print(
        f"  {'ZIP':>5}  {'mode':>8}  {'pairs':>6}  {'workers':>10}  {'residual':>10}",
        file=sys.stderr,
    )
    for zip_code in sorted(ANCHOR_ZIPS):
        entry = by_anchor.get(zip_code)
        if not entry:
            continue
        for mode_name in ("inbound", "outbound"):
            bucket = entry[mode_name]
            n_pairs = len(bucket["pairs"])
            n_workers = sum(r["workerCount"] for r in bucket["pairs"])
            print(
                f"  {zip_code:>5}  {mode_name:>8}  {n_pairs:>6}  "
                f"{n_workers:>10,}  {bucket['residual']:>10,}",
                file=sys.stderr,
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
