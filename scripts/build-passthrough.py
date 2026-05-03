#!/usr/bin/env python3
"""
build-passthrough.py — Extract latest-year pass-through OD flows per anchor.

Tree-topology pass-through definition for anchor A:
  - residence != A AND workplace != A
  - the (h_zcta → w_zcta) commute path on the I-70 / Hwy 82 tree topology
    physically passes through anchor A
  - inbound bucket:  workplace ∈ ANCHOR_ZIPS - {A}  (worker is heading TO an
                     anchor; A is between origin and the working anchor)
  - outbound bucket: residence ∈ ANCHOR_ZIPS - {A}  (worker lives AT an
                     anchor; A is between that anchor and the workplace)

A single per-anchor `total` is also emitted: the unfiltered sum of pass-through
workers for that anchor across BOTH directions, including non-anchor endpoints
(after sentinel collapse). This is the canonical "total pass-through volume"
headline for the card and resolves the inbound/outbound asymmetry that the
old longitude-XOR check produced.

Topology
--------
  branches centered on GWS junction (81601):
    JUNCTION  – 81601 only
    W branch  – I-70 west of GWS:
                  New Castle (81647) → Silt (81652) → Rifle (81650)
                  → Parachute (81635) → De Beque (81630)
    S branch  – Hwy 82 south up Roaring Fork Valley:
                  Carbondale (81623) → Basalt (81621) → Aspen (81611)
    SPUR      – terminal, off main corridor:
                  Old Snowmass (81654), Snowmass Village (81615)
                  – pass-through total = 0 by construction
    E branch  – everything east of GWS collapses to a single GW_E sentinel
                (no anchors on this branch)

  Non-anchor ZIPs are collapsed up-front into one of three sentinels:
    GW_E      – non-anchor north of corridor, east of GWS  (Eagle, Vail, …)
    GW_W      – non-anchor north of corridor, west of GWS  (Grand Junction, …)
    GW_OTHER  – non-anchor south of corridor / off-network (Leadville, Front
                Range south, RF Valley non-anchors, …) – modeled as joining
                the network at the JUNCTION

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
        "total": 12345,
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

# Per-anchor, per-mode pair cap. With non-anchor endpoints collapsed into
# 3 sentinels, the (h_node, w_node) label space is at most 14×14 = 196,
# so the cap effectively never bites — the residual is kept for forward
# compatibility but should always be 0 in the current build.
PAIRS_PER_ANCHOR_PER_MODE = 5000

# Synthetic non-anchor sentinels.
GATEWAY_E_ZIP = "GW_E"
GATEWAY_W_ZIP = "GW_W"
GATEWAY_OTHER_ZIP = "GW_OTHER"

# Geographic boundaries used to assign non-anchor ZIPs to a sentinel.
# - GWS_LNG / GWS_LAT mirror the GWS centroid used elsewhere in the build.
# - NORTH_LAT_THRESHOLD splits "on/near the I-70 corridor" (north) from
#   "off-corridor" (south). Sits between GWS (39.55) and Carbondale (39.40).
GWS_LNG = -107.3248
GWS_LAT = 39.5505
NORTH_LAT_THRESHOLD = 39.45


def gateway_for(
    zip_code: str, lat: float | None, lng: float | None
) -> str | None:
    """Assign a non-anchor ZIP to one of three sentinels. Anchor ZIPs return
    None (keep their identity). Missing coordinates fall through to
    GW_OTHER so the row isn't silently dropped."""
    if zip_code in ANCHOR_ZIPS:
        return None
    if lat is None or lng is None:
        return GATEWAY_OTHER_ZIP
    if lat < NORTH_LAT_THRESHOLD:
        return GATEWAY_OTHER_ZIP
    if lng > GWS_LNG:
        return GATEWAY_E_ZIP
    return GATEWAY_W_ZIP


# ---------------------------------------------------------------------------
# Tree-topology classifier
# ---------------------------------------------------------------------------
# Each anchor maps to (branch, position). Position is signed distance from
# the JUNCTION along the branch — increases as you move outward.
#   W branch position  = GWS_LNG - lng         (further west → larger pos)
#   S branch position  = GWS_LAT - lat         (further south → larger pos)
ANCHOR_NODES: dict[str, tuple[str, float]] = {
    "81601": ("JUNCTION", 0.0),                  # Glenwood Springs
    "81647": ("W", -107.3248 - (-107.5306)),     # New Castle  ≈ 0.2058
    "81652": ("W", -107.3248 - (-107.6539)),     # Silt        ≈ 0.3291
    "81650": ("W", -107.3248 - (-107.7831)),     # Rifle       ≈ 0.4583
    "81635": ("W", -107.3248 - (-108.0531)),     # Parachute   ≈ 0.7283
    "81630": ("W", -107.3248 - (-108.2231)),     # De Beque    ≈ 0.8983
    "81623": ("S", 39.5505 - 39.4019),           # Carbondale  ≈ 0.1486
    "81621": ("S", 39.5505 - 39.3691),           # Basalt      ≈ 0.1814
    "81611": ("S", 39.5505 - 39.1911),           # Aspen       ≈ 0.3594
    "81654": ("SPUR", 0.0),                      # Old Snowmass
    "81615": ("SPUR", 0.0),                      # Snowmass Village
}

# When a SPUR anchor appears AS AN ENDPOINT, remap to the nearest main-
# corridor anchor for the topology check. OSM merges onto Hwy 82 around
# Snowmass Canyon (just south of Basalt); SMV connects via Brush Creek to
# the Aspen-Snowmass Y intersection. Self-loop pairs (anchor→spur) are
# excluded by the not-A check before topology runs.
SPUR_ENDPOINT_REMAP: dict[str, str] = {
    "81654": "81621",  # Old Snowmass → Basalt
    "81615": "81611",  # Snowmass Village → Aspen
}

# Sentinel positions on the topology. GW_E and GW_W sit "infinitely far"
# along their respective branches so any anchor on that branch sits between
# the JUNCTION and the sentinel. GW_OTHER endpoints are off-corridor — their
# physical commute path can't be determined (statewide CO data includes
# Front Range south, San Luis Valley, etc., which DON'T transit the I-70 /
# Hwy 82 corridor). Marking them OFF excludes them from pass-through totals
# entirely, which honors "truly passing through" over inflated headlines.
# The label still exists in the JSON so future contexts can surface it; it
# just never appears in pass-through pair lists.
GATEWAY_NODES: dict[str, tuple[str, float]] = {
    GATEWAY_E_ZIP: ("E", 1.0),         # > 0; no anchors on E branch
    GATEWAY_W_ZIP: ("W", 1.0),         # > De Beque (0.8983)
    GATEWAY_OTHER_ZIP: ("OFF", 0.0),   # off-corridor; excluded from passes_through
}


def node_for(zip_code: str) -> tuple[str, float]:
    """Return (branch, position) for an anchor or sentinel. Spur anchors
    are remapped to their attachment anchor for topology checks."""
    if zip_code in SPUR_ENDPOINT_REMAP:
        return ANCHOR_NODES[SPUR_ENDPOINT_REMAP[zip_code]]
    if zip_code in ANCHOR_NODES:
        return ANCHOR_NODES[zip_code]
    if zip_code in GATEWAY_NODES:
        return GATEWAY_NODES[zip_code]
    raise KeyError(f"unknown zip_code in topology: {zip_code!r}")


def passes_through(anchor_zip: str, h_zip: str, w_zip: str) -> bool:
    """True iff the unique tree-path from h_zip to w_zip on the I-70 / Hwy 82
    topology passes strictly through anchor_zip (excluding endpoints).

    Spur anchors (OSM, SMV) are terminal and never sit on through-paths; the
    function returns False for them by construction.
    """
    if anchor_zip == h_zip or anchor_zip == w_zip:
        return False
    a_branch, a_pos = ANCHOR_NODES[anchor_zip]
    if a_branch == "SPUR":
        return False

    h_branch, h_pos = node_for(h_zip)
    w_branch, w_pos = node_for(w_zip)

    # Off-corridor endpoints (GW_OTHER) have undefined commute paths —
    # exclude from pass-through entirely.
    if h_branch == "OFF" or w_branch == "OFF":
        return False

    # JUNCTION (GWS): on the path iff the endpoints are on different
    # branches. (Same-branch trips never visit the junction; different-
    # branch trips always route through it.)
    if a_branch == "JUNCTION":
        return h_branch != w_branch

    # A is on a non-junction branch (W or S).
    same_h = h_branch == a_branch
    same_w = w_branch == a_branch
    if same_h and same_w:
        # Same-branch trip: A on path iff a_pos is strictly between the
        # two endpoint positions.
        lo, hi = (h_pos, w_pos) if h_pos <= w_pos else (w_pos, h_pos)
        return lo < a_pos < hi
    if same_h:
        # Path: h_branch → JUNCTION → w_branch. A is on h's leg iff
        # 0 < a_pos < h_pos (A sits between the JUNCTION and h).
        return 0.0 < a_pos < h_pos
    if same_w:
        return 0.0 < a_pos < w_pos
    # Neither endpoint shares A's branch; the path doesn't visit A.
    return False


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
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

    # Load both lat AND lng — sentinel assignment uses both.
    print(f"loading ZCTA centroids…", file=sys.stderr)
    centroids = load_gazetteer(GAZETTEER_CACHE_DIR)
    zcta_lat: dict[str, float] = {z: lat for z, (lat, _lng) in centroids.items()}
    zcta_lng: dict[str, float] = {z: lng for z, (_lat, lng) in centroids.items()}
    # Override anchor centroids onto the gazetteer so the classification
    # uses the city-center coordinates the rest of the app already trusts.
    for zip_code, (lat, lng) in CITY_CENTROIDS.items():
        zcta_lat[zip_code] = lat
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

    # Pre-aggregate by (h_zcta, w_zcta) so the per-anchor pass below operates
    # on unique pairs rather than block-level rows.
    agg = (
        df.groupby(["h_zcta", "w_zcta"], as_index=False)["S000"]
        .sum()
        .rename(columns={"S000": "workerCount"})
    )
    print(
        f"  → {len(agg):,} unique ZCTA→ZCTA pairs",
        file=sys.stderr,
    )

    # Collapse non-anchor endpoints to sentinels up-front and re-aggregate
    # by (h_node, w_node) so every downstream check operates in the
    # 14-label topology (11 anchors + 3 sentinels).
    def collapse(z: str) -> str:
        return gateway_for(z, zcta_lat.get(z), zcta_lng.get(z)) or z

    agg["h_zcta"] = agg["h_zcta"].map(collapse)
    agg["w_zcta"] = agg["w_zcta"].map(collapse)
    agg = (
        agg.groupby(["h_zcta", "w_zcta"], as_index=False)["workerCount"]
        .sum()
    )
    print(
        f"  → {len(agg):,} unique pairs after sentinel collapse "
        f"({len(agg['h_zcta'].unique())} origin labels, "
        f"{len(agg['w_zcta'].unique())} dest labels)",
        file=sys.stderr,
    )

    by_anchor: dict[str, dict] = {}
    for anchor_zip in CITY_CENTROIDS:
        # Spur anchors are terminal off the main corridor — nothing passes
        # "through" them. Emit empty buckets and total=0 explicitly.
        if anchor_zip in SPUR_ENDPOINT_REMAP:
            by_anchor[anchor_zip] = {
                "total": 0,
                "inbound": {"pairs": [], "residual": 0},
                "outbound": {"pairs": [], "residual": 0},
            }
            continue

        # Identify pass-through pairs via the tree-topology check.
        mask = [
            passes_through(anchor_zip, h, w)
            for h, w in zip(agg["h_zcta"].tolist(), agg["w_zcta"].tolist())
        ]
        sub = agg[mask]
        total_workers = int(sub["workerCount"].sum())

        # Inbound bucket: workplace endpoint is one of the OTHER 10 anchors,
        # OR both endpoints are sentinels (e.g., GW_E ↔ GW_W transits — non-
        # anchor commuters whose path crosses A but who don't terminate at
        # any anchor). Sentinel↔sentinel pairs also land in the outbound
        # bucket below; the runtime de-dupes by (origin, dest) so they
        # surface exactly once. Including them here closes the gap between
        # the canonical `total` and the runtime column sums.
        sentinel_pair = (
            sub["h_zcta"].isin(GATEWAY_NODES) & sub["w_zcta"].isin(GATEWAY_NODES)
        )
        inbound_sub = sub[sub["w_zcta"].isin(ANCHOR_ZIPS) | sentinel_pair]
        inbound_pairs, inbound_residual = slice_top_and_residual(
            inbound_sub, PAIRS_PER_ANCHOR_PER_MODE
        )

        # Outbound bucket: residence endpoint is one of the OTHER 10 anchors,
        # OR both endpoints are sentinels (mirrored above).
        outbound_sub = sub[sub["h_zcta"].isin(ANCHOR_ZIPS) | sentinel_pair]
        outbound_pairs, outbound_residual = slice_top_and_residual(
            outbound_sub, PAIRS_PER_ANCHOR_PER_MODE
        )

        # Bucket overlap contract: a pair appears in BOTH inbound_pairs and
        # outbound_pairs ONLY when its presence in both buckets is structural
        # — i.e., both endpoints are anchor ZIPs (in which case it satisfies
        # both bucket criteria) OR both are sentinels (the sentinel_pair
        # carve-out above). Consumers that need a single count of any pair
        # must dedupe by (originZip, destZip) on read; see the pass-through
        # card union+dedup at BottomCardStrip.tsx and the E↔W transit dedup
        # in passthroughTransits.ts. The XLSX export deliberately keeps the
        # duplication, labeling each row by its source bucket. This
        # assertion catches a future regression in the bucket-assignment
        # logic that would let a non-anchor / non-sentinel pair land in
        # both buckets and silently double-count anywhere that dedupes.
        in_keys = {(p["originZip"], p["destZip"]) for p in inbound_pairs}
        out_keys = {(p["originZip"], p["destZip"]) for p in outbound_pairs}
        for key in in_keys & out_keys:
            origin, dest = key
            both_anchor = origin in ANCHOR_ZIPS and dest in ANCHOR_ZIPS
            both_sentinel = origin in GATEWAY_NODES and dest in GATEWAY_NODES
            if not (both_anchor or both_sentinel):
                raise AssertionError(
                    f"anchor {anchor_zip}: pair ({origin}, {dest}) appears in "
                    f"both inbound and outbound buckets but is neither "
                    f"anchor↔anchor nor sentinel↔sentinel. The bucket-"
                    f"assignment logic above let through an unexpected case "
                    f"that consumers' dedup pattern was not designed for."
                )

        by_anchor[anchor_zip] = {
            "total": total_workers,
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
        f"  {'ZIP':>5}  {'total':>10}  {'mode':>8}  {'pairs':>6}  "
        f"{'workers':>10}  {'residual':>10}",
        file=sys.stderr,
    )
    for zip_code in sorted(ANCHOR_ZIPS):
        entry = by_anchor.get(zip_code)
        if not entry:
            continue
        total = entry.get("total", 0)
        for mode_name in ("inbound", "outbound"):
            bucket = entry[mode_name]
            n_pairs = len(bucket["pairs"])
            n_workers = sum(r["workerCount"] for r in bucket["pairs"])
            print(
                f"  {zip_code:>5}  {total:>10,}  {mode_name:>8}  {n_pairs:>6}  "
                f"{n_workers:>10,}  {bucket['residual']:>10,}",
                file=sys.stderr,
            )

    return 0


if __name__ == "__main__":
    sys.exit(main())
