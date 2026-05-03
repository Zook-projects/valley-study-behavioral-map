#!/usr/bin/env python3
"""
build-data.py — Convert filtered LODES8 extracts into flow + ZIP + corridor JSON.

Reads:
  - data/lodes-cache/filtered/{rac,wac,od}-YYYY.csv (built by fetch-lodes.py)
  - public/data/corridors.geojson — hand-authored canonical corridor graph
  - 2024 Census ZCTA Gazetteer (downloaded to /tmp on first run)
  - Census ZIP→city crosswalk (downloaded once to data/uszips-cache/, see zip_places.py)

Writes (all under public/data/):
  - flows-inbound.json    workplace-anchored flows (latest year, corridorPath baked in)
  - flows-outbound.json   residence-anchored flows (latest year, corridorPath baked in)
  - zips.json             union of every ZIP appearing in flows + the 11 anchors
  - corridors.json        smoothed geometries + node metadata
  - rac.json              per-ZIP residence-side panel (latest + 2002–2023 trend) + aggregate
  - wac.json              per-ZIP workplace-side panel (latest + 2002–2023 trend) + aggregate
  - od-summary.json       per-anchor inflow/outflow blocks + top partners + aggregate

The flow JSONs ship the latest LODES vintage only (rendered on the map). The
2002–2023 trend story lives in rac.json / wac.json / od-summary.json and is
consumed by the bottom card strip's sparklines.

No network calls (after the first gazetteer fetch). Deterministic — two runs
against identical inputs produce byte-identical outputs.

Run via: python3 scripts/build-data.py
"""

from __future__ import annotations

import heapq
import json
import math
import sys
from pathlib import Path

import pandas as pd

import lodes
from anchors import ANCHOR_ZIPS, ANCHOR_PLACE_NAMES, CITY_CENTROIDS
from osrm import OsrmError, route_polyline
from geo import haversine_length_meters, load_gazetteer
from zip_places import load_census_zip_places, merge_place_seed

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
VAULT_DIR = PROJECT_ROOT.parent  # .../Valley Study - Behavioral Map/
OUT_DIR = PROJECT_ROOT / "public" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

CORRIDORS_GEOJSON = OUT_DIR / "corridors.geojson"
OSRM_CACHE_PATH = HERE / ".osrm-corridor-cache.json"
GAZETTEER_CACHE_DIR = PROJECT_ROOT / "data" / "lodes-cache" / "gazetteer"
ZIP_PLACES_CACHE_DIR = PROJECT_ROOT / "data" / "uszips-cache"

# OnTheMap anchor xwalk — same file used by fetch-lodes.py to define the study
# area. Carries block-level centroids (blklatdd / blklondd) for every block in
# the 11 anchor ZCTAs, which the block heatmap pipeline reads to plot points.
ANCHOR_XWALK = (
    VAULT_DIR
    / "Area Characteristics - LODES"
    / "Metadata"
    / "xwalk_5a50a3e01d538ef651de716dd7cd9a09.xlsx"
)

COORD_DECIMALS = 6
OSRM_SNAP_RADIUS_M: int | None = None

# Latest LODES vintage shipped on the map. The card-strip sparklines render
# the full 2002–2023 series; the corridor map renders this single year.
LATEST_YEAR = lodes.LATEST_YEAR

# Anchor constants (ANCHOR_ZIPS / CITY_CENTROIDS / ANCHOR_PLACE_NAMES) are
# imported from anchors.py — the single source of truth shared with
# build-passthrough.py.

# Gateway routing rules (preserved from the prior build).
GATEWAY_E_NODE = "GW_E"
GATEWAY_W_NODE = "GW_W"
GATEWAY_SPLIT_LNG = -107.3248

# QA tolerances surfaced by the reconciliation block at end of run. Inbound
# drift between WAC latest total and the sum of inbound flow workers is
# warned (not fatal) above this fraction. Outbound drift is expected to be
# larger because residents working out-of-state are absent from the CO-only
# OD pull, so it's reported but never warned on.
INBOUND_DRIFT_TOL_PCT = 0.005

# Per-pair segment sanity tolerance. LODES uses noise infusion so segment
# axes (age / wage / naics3) are not guaranteed to sum exactly to
# workerCount, but drift greater than this on any single row indicates an
# ingest bug that broke segment column propagation.
SEG_AXIS_TOL = 2


# ---------------------------------------------------------------------------
# Place-name resolver
# ---------------------------------------------------------------------------
def load_place_name_seed() -> dict[str, str]:
    """
    Build a three-layer ZIP→place lookup:

      1. Census ZIP→city crosswalk (broad fallback covering all U.S. ZCTAs).
         Source: github.com/scpike/us-state-county-zip — public-domain Census
         data, fetched once and cached under data/uszips-cache/.
      2. Prior build's zips.json (preserves friendly-name overrides made by
         hand). Empty strings in the prior are ignored so Census fallbacks
         can fill them.
      3. ANCHOR_PLACE_NAMES (the 11 study anchors — these always win).
    """
    prior_seed: dict[str, str] = {}
    prior = OUT_DIR / "zips.json"
    if prior.exists():
        try:
            with prior.open(encoding="utf-8") as fh:
                for entry in json.load(fh):
                    z = entry.get("zip")
                    p = entry.get("place")
                    if z and p:
                        prior_seed[z] = p
        except Exception as e:
            print(f"  ! could not seed place names from prior zips.json: {e}", file=sys.stderr)
    try:
        census = load_census_zip_places(ZIP_PLACES_CACHE_DIR)
    except Exception as e:
        print(f"  ! could not load Census ZIP→city crosswalk: {e}", file=sys.stderr)
        census = {}
    return merge_place_seed(census, prior_seed, ANCHOR_PLACE_NAMES)


# ---------------------------------------------------------------------------
# Corridor graph — load, validate, route via OSRM
# ---------------------------------------------------------------------------
def _round_pair(p: list[float] | tuple[float, float]) -> list[float]:
    return [round(float(p[0]), COORD_DECIMALS), round(float(p[1]), COORD_DECIMALS)]


def load_corridor_graph() -> tuple[
    dict[str, dict],
    list[dict],
    dict[str, list[tuple[str, str, float]]],
    dict[str, str],
]:
    if not CORRIDORS_GEOJSON.exists():
        raise RuntimeError(
            f"corridors.geojson not found at {CORRIDORS_GEOJSON} — "
            "see the corridor authoring workflow in README.md"
        )
    with CORRIDORS_GEOJSON.open(encoding="utf-8") as fh:
        gj = json.load(fh)

    nodes: dict[str, dict] = {}
    corridors: list[dict] = []
    seen_corridor_ids: set[str] = set()
    zip_to_node: dict[str, str] = {}

    for feat in gj.get("features", []):
        props = feat.get("properties") or {}
        kind = props.get("kind")
        if kind == "node":
            node_id = props.get("nodeId")
            if not node_id or node_id in nodes:
                raise RuntimeError(f"corridors.geojson: missing or duplicate nodeId: {node_id!r}")
            geom = feat.get("geometry") or {}
            coords = geom.get("coordinates") or []
            if not (isinstance(coords, list) and len(coords) >= 2):
                raise RuntimeError(f"node {node_id} has no coordinates")
            lng, lat = float(coords[0]), float(coords[1])
            zip_str = props.get("associatedZip")
            nodes[node_id] = {
                "id": node_id,
                "label": props.get("label", node_id),
                "lng": round(lng, COORD_DECIMALS),
                "lat": round(lat, COORD_DECIMALS),
                "zip": zip_str,
            }
            if zip_str:
                if zip_str in zip_to_node and zip_to_node[zip_str] != node_id:
                    print(
                        f"  ! ZIP {zip_str} associated with multiple nodes: "
                        f"{zip_to_node[zip_str]!r} and {node_id!r}; "
                        f"keeping {zip_to_node[zip_str]!r}",
                        file=sys.stderr,
                    )
                else:
                    zip_to_node[zip_str] = node_id
        elif kind == "corridor":
            corridors.append({"_props": props})

    adjacency: dict[str, list[tuple[str, str, float]]] = {nid: [] for nid in nodes}
    routed_corridors: list[dict] = []
    for c in corridors:
        props = c["_props"]
        cid = props.get("corridorId")
        if not cid or cid in seen_corridor_ids:
            raise RuntimeError(f"corridors.geojson: missing or duplicate corridorId: {cid!r}")
        seen_corridor_ids.add(cid)
        from_id = props.get("fromNodeId")
        to_id = props.get("toNodeId")
        if from_id not in nodes or to_id not in nodes:
            raise RuntimeError(
                f"corridor {cid}: fromNodeId={from_id!r} or toNodeId={to_id!r} "
                "does not reference a defined node"
            )
        ctrl = props.get("controlPoints")
        if not isinstance(ctrl, list) or len(ctrl) < 2:
            raise RuntimeError(f"corridor {cid}: needs at least 2 control points")
        ctrl = [[float(p[0]), float(p[1])] for p in ctrl]
        ctrl[0] = [nodes[from_id]["lng"], nodes[from_id]["lat"]]
        ctrl[-1] = [nodes[to_id]["lng"], nodes[to_id]["lat"]]
        endpoints = [ctrl[0], ctrl[-1]]
        try:
            geometry = route_polyline(
                endpoints,
                cache_path=OSRM_CACHE_PATH,
                radius_m=OSRM_SNAP_RADIUS_M,
                label=cid,
            )
        except OsrmError as e:
            raise RuntimeError(
                f"corridor {cid}: OSRM routing failed — {e}. "
                "Aborting build; corridor geometries must follow real road geometry."
            ) from e
        geometry = [_round_pair(p) for p in geometry]
        if geometry:
            geometry[0] = [nodes[from_id]["lng"], nodes[from_id]["lat"]]
            geometry[-1] = [nodes[to_id]["lng"], nodes[to_id]["lat"]]
        length_m = haversine_length_meters(geometry)

        routed_corridors.append({
            "id": cid,
            "label": props.get("label", cid),
            "from": from_id,
            "to": to_id,
            "roadName": props.get("roadName", ""),
            "geometry": geometry,
            "lengthMeters": round(length_m, 1),
        })
        adjacency[from_id].append((cid, to_id, length_m))
        adjacency[to_id].append((cid, from_id, length_m))

    if not routed_corridors:
        raise RuntimeError("corridors.geojson contains no corridor features")
    return nodes, routed_corridors, adjacency, zip_to_node


# ---------------------------------------------------------------------------
# Dijkstra over the corridor graph
# ---------------------------------------------------------------------------
def shortest_corridor_path(
    adjacency: dict[str, list[tuple[str, str, float]]],
    start: str,
    end: str,
) -> list[str] | None:
    if start == end:
        return []
    if start not in adjacency or end not in adjacency:
        return None
    pq: list[tuple[float, int, tuple[str, ...], str]] = [(0.0, 0, (), start)]
    best: dict[str, tuple[float, int, tuple[str, ...]]] = {start: (0.0, 0, ())}
    while pq:
        dist, hops, path, node = heapq.heappop(pq)
        if node == end:
            return list(path)
        prev = best.get(node)
        if prev is not None and (dist, hops, path) > prev:
            continue
        for cid, nbr, length in adjacency[node]:
            cand_dist = dist + length
            cand_hops = hops + 1
            cand_path = path + (cid,)
            existing = best.get(nbr)
            cand_key = (cand_dist, cand_hops, cand_path)
            if existing is None or cand_key < existing:
                best[nbr] = cand_key
                heapq.heappush(pq, (cand_dist, cand_hops, cand_path, nbr))
    return None


# ---------------------------------------------------------------------------
# Flow → corridor path mapping (preserved from prior build)
# ---------------------------------------------------------------------------
def classify_external_zip(zip_code: str, lng: float | None) -> str | None:
    if not zip_code or not zip_code.isdigit() or len(zip_code) != 5:
        return None
    prefix = zip_code[:2]
    if prefix not in ("80", "81"):
        return None
    if lng is not None:
        return GATEWAY_E_NODE if lng > GATEWAY_SPLIT_LNG else GATEWAY_W_NODE
    return GATEWAY_E_NODE if prefix == "80" else GATEWAY_W_NODE


def resolve_node_for_zip(
    zip_code: str,
    zip_to_node: dict[str, str],
    zip_lng: dict[str, float],
) -> str | None:
    if zip_code in zip_to_node:
        return zip_to_node[zip_code]
    return classify_external_zip(zip_code, zip_lng.get(zip_code))


def attach_corridor_paths(
    flows: list[dict],
    adjacency: dict[str, list[tuple[str, str, float]]],
    zip_to_node: dict[str, str],
    zip_lng: dict[str, float],
) -> tuple[int, int, int]:
    routed = 0
    self_loop = 0
    reclassified = 0
    path_cache: dict[tuple[str, str], list[str] | None] = {}
    for f in flows:
        ozip = f["originZip"]
        dzip = f["destZip"]
        if ozip == dzip:
            f["corridorPath"] = []
            self_loop += 1
            continue
        if ozip == "ALL_OTHER" or dzip == "ALL_OTHER":
            f["corridorPath"] = []
            continue
        o_node = resolve_node_for_zip(ozip, zip_to_node, zip_lng)
        d_node = resolve_node_for_zip(dzip, zip_to_node, zip_lng)
        if o_node is None or d_node is None:
            if o_node is None:
                f["originZip"] = "ALL_OTHER"
            if d_node is None:
                f["destZip"] = "ALL_OTHER"
            f["corridorPath"] = []
            reclassified += 1
            continue
        cache_key = (o_node, d_node)
        if cache_key in path_cache:
            path = path_cache[cache_key]
        else:
            path = shortest_corridor_path(adjacency, o_node, d_node)
            path_cache[cache_key] = path
        if path is None:
            raise RuntimeError(
                f"no corridor path between node {o_node!r} and node {d_node!r} "
                f"(flow {ozip}→{dzip}); the corridor graph is disconnected"
            )
        f["corridorPath"] = path
        routed += 1
    return routed, self_loop, reclassified


# ---------------------------------------------------------------------------
# Block-level heatmap data (od-blocks.json)
# ---------------------------------------------------------------------------
def _segments_block(row) -> dict:
    """Build the BlockSegments dict from a renamed-OD pandas row."""
    return {
        "age": {
            "u29":       int(row["ageU29"]),
            "age30to54": int(row["age30to54"]),
            "age55plus": int(row["age55plus"]),
        },
        "wage": {
            "low":  int(row["wageLow"]),
            "mid":  int(row["wageMid"]),
            "high": int(row["wageHigh"]),
        },
        "naics3": {
            "goods":          int(row["naicsGoods"]),
            "tradeTransUtil": int(row["naicsTradeTransUtil"]),
            "allOther":       int(row["naicsAllOther"]),
        },
    }


def build_od_blocks(
    od_blocks_latest: pd.DataFrame,
    block_centroids: dict[str, tuple[float, float]],
) -> tuple[dict, dict]:
    """
    Build the per-anchor block-level heatmap structure for od-blocks.json.

    Returns (doc, qa) where doc has the schema documented in the plan:
      { latestYear, anchors: { <zip>: { workplaceBlocks: [...], homeBlocks: [...] } } }
    and qa carries per-anchor totals + drop counts for reconciliation logging.

    `od_blocks_latest` is the output of lodes.aggregate_od_to_block_pairs()
    filtered to LATEST_YEAR. Required columns:
      h_geocode, w_geocode, h_zcta, w_zcta,
      totalJobs, ageU29, age30to54, age55plus,
      wageLow, wageMid, wageHigh,
      naicsGoods, naicsTradeTransUtil, naicsAllOther.

    `block_centroids` maps 15-digit block GEOID → (lat, lng). Only anchor
    blocks (the side WITHIN the anchor) need centroids — partner side is
    aggregated by ZCTA only and identified by `partner.zip`. Blocks without
    a centroid are dropped with a per-anchor counter.
    """
    df = od_blocks_latest.copy()

    # Normalize NaN ZCTAs (out-of-state partner blocks) to ALL_OTHER so they
    # become a named partner bucket rather than a NaN group key.
    df["h_zcta"] = df["h_zcta"].fillna("ALL_OTHER").astype(str)
    df["w_zcta"] = df["w_zcta"].fillna("ALL_OTHER").astype(str)

    seg_value_cols = [
        "totalJobs",
        "ageU29", "age30to54", "age55plus",
        "wageLow", "wageMid", "wageHigh",
        "naicsGoods", "naicsTradeTransUtil", "naicsAllOther",
    ]

    def _build_side(
        anchor: str,
        anchor_col: str,        # "w_zcta" for inbound/workplace, "h_zcta" for outbound/home
        anchor_block_col: str,  # "w_geocode" or "h_geocode"
        partner_col: str,       # "h_zcta" or "w_zcta"
    ) -> tuple[list[dict], int, int]:
        """Return (blocks_array, total_workers, dropped_for_no_centroid)."""
        scope = df[df[anchor_col] == anchor]
        if scope.empty:
            return [], 0, 0

        # Aggregate per (anchor block, partner ZCTA).
        partner_grp = (
            scope.groupby([anchor_block_col, partner_col], as_index=False)[seg_value_cols]
            .sum()
        )
        # Aggregate per anchor block (totals across all partners).
        block_grp = (
            scope.groupby([anchor_block_col], as_index=False)[seg_value_cols]
            .sum()
        )

        blocks_out: list[dict] = []
        dropped = 0
        total_workers = 0
        for _, brow in block_grp.iterrows():
            block_id = str(brow[anchor_block_col])
            centroid = block_centroids.get(block_id)
            if centroid is None:
                dropped += int(brow["totalJobs"])
                continue
            lat, lng = centroid
            block_total = int(brow["totalJobs"])
            total_workers += block_total

            # Partner detail — sorted by descending workers for stable JSON.
            partners_for_block = partner_grp[
                partner_grp[anchor_block_col] == block_id
            ].sort_values("totalJobs", ascending=False)
            partners_out: list[dict] = []
            for _, prow in partners_for_block.iterrows():
                partners_out.append({
                    "zip":   str(prow[partner_col]),
                    "total": int(prow["totalJobs"]),
                    **_segments_block(prow),
                })

            entry = {
                "block":     block_id,
                "lat":       round(float(lat), 6),
                "lng":       round(float(lng), 6),
                "anchorZip": anchor,
                "total":     block_total,
                **_segments_block(brow),
                "partners":  partners_out,
            }
            blocks_out.append(entry)

        # Stable order — block GEOID ascending. Keeps build deterministic.
        blocks_out.sort(key=lambda b: b["block"])
        return blocks_out, total_workers, dropped

    anchors_out: dict[str, dict] = {}
    qa: dict[str, dict] = {}
    for anchor in sorted(ANCHOR_ZIPS):
        wp_blocks, wp_total, wp_dropped = _build_side(
            anchor, "w_zcta", "w_geocode", "h_zcta"
        )
        hm_blocks, hm_total, hm_dropped = _build_side(
            anchor, "h_zcta", "h_geocode", "w_zcta"
        )
        anchors_out[anchor] = {
            "workplaceBlocks": wp_blocks,
            "homeBlocks":      hm_blocks,
        }
        qa[anchor] = {
            "workplaceTotal":   wp_total,
            "workplaceDropped": wp_dropped,
            "homeTotal":        hm_total,
            "homeDropped":      hm_dropped,
            "workplaceBlocks":  len(wp_blocks),
            "homeBlocks":       len(hm_blocks),
        }

    doc = {
        "latestYear": LATEST_YEAR,
        "anchors":    anchors_out,
    }
    return doc, qa


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    # ------------------------- LODES ingest --------------------------------
    print("loading LODES filtered cache…", file=sys.stderr)
    rac_raw = lodes.load_rac_all_years()
    wac_raw = lodes.load_wac_all_years()
    od_raw = lodes.load_od_all_years()
    print(
        f"  → RAC {len(rac_raw):,} block-year rows; "
        f"WAC {len(wac_raw):,}; OD {len(od_raw):,}",
        file=sys.stderr,
    )

    rac = lodes.aggregate_rac_or_wac(rac_raw)
    wac = lodes.aggregate_rac_or_wac(wac_raw)
    od_pairs = lodes.aggregate_od_to_zip_pairs(od_raw)
    print(
        f"  → RAC ZCTA-years {len(rac):,}; WAC ZCTA-years {len(wac):,}; "
        f"OD pairs {len(od_pairs):,}",
        file=sys.stderr,
    )

    # Block-level OD aggregation for the heatmap layer. Latest year only —
    # the heatmap is purely visual and tied to the latest LODES vintage.
    od_blocks_latest = lodes.aggregate_od_to_block_pairs(
        od_raw[od_raw["year"] == LATEST_YEAR]
    )
    print(
        f"  → OD block pairs (latest only) {len(od_blocks_latest):,}",
        file=sys.stderr,
    )

    # Block centroids — read from the OnTheMap anchor xwalk. Covers every
    # block within the 11 anchor ZCTAs; partner-side blocks (outside the
    # anchors) don't need centroids because the heatmap only plots the
    # anchor's own blocks.
    print(f"loading anchor block centroids: {ANCHOR_XWALK.name}", file=sys.stderr)
    xw = pd.read_excel(
        ANCHOR_XWALK,
        dtype={"tabblk2020": str, "zcta": str},
    )
    block_centroids: dict[str, tuple[float, float]] = {}
    for _, r in xw.iterrows():
        b = str(r["tabblk2020"])
        try:
            lat = float(r["blklatdd"])
            lng = float(r["blklondd"])
        except (TypeError, ValueError):
            continue
        if math.isnan(lat) or math.isnan(lng):
            continue
        block_centroids[b] = (lat, lng)
    print(
        f"  → {len(block_centroids):,} anchor block centroids", file=sys.stderr,
    )

    # ------------------------- Corridor graph ------------------------------
    print("loading corridor graph…", file=sys.stderr)
    nodes, corridors, adjacency, zip_to_node = load_corridor_graph()
    print(
        f"  → {len(nodes)} nodes, {len(corridors)} corridors, "
        f"{len(zip_to_node)} ZIP→node bindings",
        file=sys.stderr,
    )

    print("loading ZCTA gazetteer…", file=sys.stderr)
    centroids = load_gazetteer(GAZETTEER_CACHE_DIR)
    print(f"  → {len(centroids):,} ZCTA centroids", file=sys.stderr)

    zip_to_place = load_place_name_seed()

    # ------------------------- Build flow rows -----------------------------
    # The map renders the latest LODES vintage. Other years live in the
    # rac/wac/od-summary trend arrays for the card strip.
    od_latest = od_pairs[od_pairs["year"] == LATEST_YEAR]

    # Build a FlowRow's per-pair segments block from the namedtuple emitted by
    # od_latest.itertuples(). LODES OD files carry all 9 segment buckets (3 age
    # × 3 wage × 3 industry NAICS-3) per pair; aggregate_od_to_zip_pairs has
    # already renamed the columns. Within each axis the buckets sum to
    # totalJobs (S000), within ±2 because of LODES noise infusion.
    def _segments_for_row(r) -> dict:
        return {
            "age": {
                "u29": int(r.ageU29),
                "age30to54": int(r.age30to54),
                "age55plus": int(r.age55plus),
            },
            "wage": {
                "low": int(r.wageLow),
                "mid": int(r.wageMid),
                "high": int(r.wageHigh),
            },
            "naics3": {
                "goods": int(r.naicsGoods),
                "tradeTransUtil": int(r.naicsTradeTransUtil),
                "allOther": int(r.naicsAllOther),
            },
        }

    flows_inbound_out: list[dict] = []
    for r in od_latest[od_latest["w_zip"].isin(ANCHOR_ZIPS)].itertuples(index=False):
        flows_inbound_out.append({
            "originZip": str(r.h_zip),
            "originPlace": zip_to_place.get(str(r.h_zip), ""),
            "destZip": str(r.w_zip),
            "destPlace": zip_to_place.get(str(r.w_zip), ""),
            "workerCount": int(r.totalJobs),
            "year": int(r.year),
            "source": "LEHD",
            "segments": _segments_for_row(r),
        })

    flows_outbound_out: list[dict] = []
    for r in od_latest[od_latest["h_zip"].isin(ANCHOR_ZIPS)].itertuples(index=False):
        flows_outbound_out.append({
            "originZip": str(r.h_zip),
            "originPlace": zip_to_place.get(str(r.h_zip), ""),
            "destZip": str(r.w_zip),
            "destPlace": zip_to_place.get(str(r.w_zip), ""),
            "workerCount": int(r.totalJobs),
            "year": int(r.year),
            "source": "LEHD",
            "segments": _segments_for_row(r),
        })

    # Stable order — keeps build deterministic.
    flows_inbound_out.sort(key=lambda f: (f["destZip"], -f["workerCount"], f["originZip"]))
    flows_outbound_out.sort(key=lambda f: (f["originZip"], -f["workerCount"], f["destZip"]))

    # ------------------------- ZIP discovery + zips.json -------------------
    all_zips: set[str] = set()
    for f in flows_inbound_out:
        if f["originZip"].isdigit():
            all_zips.add(f["originZip"])
        if f["destZip"].isdigit():
            all_zips.add(f["destZip"])
    for f in flows_outbound_out:
        if f["originZip"].isdigit():
            all_zips.add(f["originZip"])
        if f["destZip"].isdigit():
            all_zips.add(f["destZip"])
    # Always include every anchor (even if zero-flow in latest year).
    all_zips.update(ANCHOR_ZIPS)

    # Per-anchor totals from latest-year LODES (consistent with flow data).
    workplace_totals = wac[wac["year"] == LATEST_YEAR].set_index("zcta")["totalJobs"].to_dict()
    residence_totals = rac[rac["year"] == LATEST_YEAR].set_index("zcta")["totalJobs"].to_dict()

    zips_out: list[dict] = []
    missing_centroids: list[str] = []
    for zip_code in sorted(all_zips):
        if zip_code in CITY_CENTROIDS:
            lat, lng = CITY_CENTROIDS[zip_code]
        else:
            centroid = centroids.get(zip_code)
            if centroid is None:
                missing_centroids.append(zip_code)
                continue
            lat, lng = centroid
        zips_out.append({
            "zip": zip_code,
            "place": zip_to_place.get(zip_code, ""),
            "lat": lat,
            "lng": lng,
            "totalAsWorkplace": int(workplace_totals.get(zip_code, 0)),
            "totalAsResidence": int(residence_totals.get(zip_code, 0)),
            "isAnchor": zip_code in ANCHOR_ZIPS,
        })

    # Synthetic ALL_OTHER bucket: aggregate any flows that landed there post-
    # corridor reclassification (out-of-state and unrouted endpoints).
    aol_inbound = sum(
        f["workerCount"] for f in flows_inbound_out if f["originZip"] == "ALL_OTHER"
    )
    aol_outbound = sum(
        f["workerCount"] for f in flows_outbound_out if f["destZip"] == "ALL_OTHER"
    )
    zips_out.append({
        "zip": "ALL_OTHER",
        "place": "All Other Locations",
        "lat": None,
        "lng": None,
        "totalAsWorkplace": aol_outbound,
        "totalAsResidence": aol_inbound,
        "isAnchor": False,
        "isSynthetic": True,
    })
    if missing_centroids:
        print(
            f"  ! {len(missing_centroids)} ZIPs without centroids "
            f"(dropped): {missing_centroids[:20]}{'…' if len(missing_centroids) > 20 else ''}",
            file=sys.stderr,
        )

    # ------------------------- Corridor routing ----------------------------
    print("\nrouting flows through corridor graph…", file=sys.stderr)
    zip_lng: dict[str, float] = {}
    for z, (_lat, lng) in centroids.items():
        zip_lng[z] = lng
    for z, (_lat, lng) in CITY_CENTROIDS.items():
        zip_lng[z] = lng
    in_routed, in_self, in_reclass = attach_corridor_paths(
        flows_inbound_out, adjacency, zip_to_node, zip_lng
    )
    out_routed, out_self, out_reclass = attach_corridor_paths(
        flows_outbound_out, adjacency, zip_to_node, zip_lng
    )
    print(
        f"  inbound:  routed={in_routed}, self={in_self}, reclassified={in_reclass}",
        file=sys.stderr,
    )
    print(
        f"  outbound: routed={out_routed}, self={out_self}, reclassified={out_reclass}",
        file=sys.stderr,
    )

    # ------------------------- Card-strip JSONs ----------------------------
    print("\nbuilding rac.json / wac.json / od-summary.json…", file=sys.stderr)
    rac_entries, rac_aggregate = lodes.build_rac_or_wac_entries(rac, zip_to_place)
    wac_entries, wac_aggregate = lodes.build_rac_or_wac_entries(wac, zip_to_place)
    od_entries, od_aggregate = lodes.build_od_summary(
        od_pairs, ANCHOR_ZIPS, zip_to_place
    )

    rac_doc = {"latestYear": LATEST_YEAR, "aggregate": rac_aggregate, "entries": rac_entries}
    wac_doc = {"latestYear": LATEST_YEAR, "aggregate": wac_aggregate, "entries": wac_entries}
    od_doc = {"latestYear": LATEST_YEAR, "aggregate": od_aggregate, "entries": od_entries}

    print("\nbuilding od-blocks.json…", file=sys.stderr)
    od_blocks_doc, od_blocks_qa = build_od_blocks(
        od_blocks_latest, block_centroids
    )

    # ------------------------- Reconciliation ------------------------------
    print("\nreconciling LODES totals against flows…", file=sys.stderr)
    wac_latest_total = sum(int(e["latest"]["totalJobs"]) for e in wac_entries)
    rac_latest_total = sum(int(e["latest"]["totalJobs"]) for e in rac_entries)
    inbound_workers_total = sum(f["workerCount"] for f in flows_inbound_out)
    outbound_workers_total = sum(f["workerCount"] for f in flows_outbound_out)

    # Inbound flows = OD pairs whose w_zip is one of our 11 anchors.
    # Latest WAC (workplace jobs at our 11 anchors) should equal inbound
    # totalWorkers exactly when every job is captured. The OD aux file we
    # filtered carries out-of-state inflow workers, so the equality should
    # hold within rounding (LODES is internally consistent).
    in_drift = abs(wac_latest_total - inbound_workers_total) / max(wac_latest_total, 1)
    out_drift = abs(rac_latest_total - outbound_workers_total) / max(rac_latest_total, 1)
    print(
        f"  WAC latest total = {wac_latest_total:,}; flows-inbound total = "
        f"{inbound_workers_total:,}; drift = {in_drift:.2%}",
        file=sys.stderr,
    )
    print(
        f"  RAC latest total = {rac_latest_total:,}; flows-outbound total = "
        f"{outbound_workers_total:,}; drift = {out_drift:.2%}",
        file=sys.stderr,
    )
    # Outbound has an expected gap: residents working out-of-state are absent
    # from CO-only OD pulls. Warn but don't fail above the small expected gap.
    if in_drift > INBOUND_DRIFT_TOL_PCT:
        print(
            f"  ! inbound drift {in_drift:.2%} exceeds "
            f"{INBOUND_DRIFT_TOL_PCT:.1%}; possible ingest bug",
            file=sys.stderr,
        )

    # Per-pair segment sanity: each axis (age / wage / naics3) sums to within
    # SEG_AXIS_TOL of workerCount. Tolerance hoisted to the constants block
    # at the top of the file.
    seg_violations = 0
    for f in (flows_inbound_out + flows_outbound_out):
        seg = f.get("segments")
        if not seg:
            continue
        wc = f["workerCount"]
        sums = {
            "age": seg["age"]["u29"] + seg["age"]["age30to54"] + seg["age"]["age55plus"],
            "wage": seg["wage"]["low"] + seg["wage"]["mid"] + seg["wage"]["high"],
            "naics3": seg["naics3"]["goods"] + seg["naics3"]["tradeTransUtil"] + seg["naics3"]["allOther"],
        }
        for axis_name, s in sums.items():
            if abs(s - wc) > SEG_AXIS_TOL:
                seg_violations += 1
                if seg_violations <= 5:
                    print(
                        f"  ! segment drift on {f['originZip']}→{f['destZip']} "
                        f"{axis_name}: sum={s} workerCount={wc}",
                        file=sys.stderr,
                    )
                break
    if seg_violations:
        print(
            f"  ! {seg_violations} flow rows with segment drift > ±{SEG_AXIS_TOL}",
            file=sys.stderr,
        )
    else:
        print(
            f"  segment sanity ok — every axis sums to workerCount ±{SEG_AXIS_TOL}",
            file=sys.stderr,
        )

    # ------------------------- Block-heatmap reconciliation ----------------
    # Block-level totals must match the OD ZIP-level totals (same universe —
    # both sum the same OD pairs, just at different aggregation grains).
    # Comparing against RAC instead of OD-outbound would conflate the known
    # CO-only-OD gap (residents working out-of-state) with block-aggregation
    # bugs.
    print("\nreconciling od-blocks against OD totals…", file=sys.stderr)
    block_drift_violations = 0
    block_drift_tol = 0.005
    total_dropped_workers = 0
    total_anchor_workers = 0
    for anchor in sorted(ANCHOR_ZIPS):
        qa = od_blocks_qa[anchor]
        # OD-in (sum of pairs where w_zip == anchor) and OD-out (h_zip == anchor)
        # — identical universe to the block aggregation, so totals must match
        # within rounding.
        od_in = sum(
            f["workerCount"] for f in flows_inbound_out if f["destZip"] == anchor
        )
        od_out = sum(
            f["workerCount"] for f in flows_outbound_out if f["originZip"] == anchor
        )
        wp_drift = abs(qa["workplaceTotal"] - od_in) / max(od_in, 1)
        hm_drift = abs(qa["homeTotal"] - od_out) / max(od_out, 1)
        total_dropped_workers += qa["workplaceDropped"] + qa["homeDropped"]
        total_anchor_workers += od_in + od_out
        if wp_drift > block_drift_tol or hm_drift > block_drift_tol:
            block_drift_violations += 1
            print(
                f"  ! {anchor}: wp_blocks_total={qa['workplaceTotal']:,} vs "
                f"od_in={od_in:,} ({wp_drift:.2%}); "
                f"hm_blocks_total={qa['homeTotal']:,} vs od_out={od_out:,} "
                f"({hm_drift:.2%})",
                file=sys.stderr,
            )
        if qa["workplaceDropped"] or qa["homeDropped"]:
            print(
                f"    {anchor}: dropped_workers wp={qa['workplaceDropped']:,} "
                f"hm={qa['homeDropped']:,} (block missing centroid)",
                file=sys.stderr,
            )
    if block_drift_violations:
        print(
            f"  ! {block_drift_violations} anchors with block↔OD drift > "
            f"{block_drift_tol:.1%}",
            file=sys.stderr,
        )
    else:
        print(
            f"  block↔OD totals reconcile within ±{block_drift_tol:.1%} "
            f"for all 11 anchors",
            file=sys.stderr,
        )
    drop_rate = total_dropped_workers / max(total_anchor_workers, 1)
    if drop_rate > 0.01:
        print(
            f"  ! missing-centroid drop rate {drop_rate:.2%} exceeds 1% — "
            f"check the anchor xwalk for incomplete coverage",
            file=sys.stderr,
        )
    else:
        print(
            f"  missing-centroid drop rate = {drop_rate:.2%} "
            f"({total_dropped_workers:,} of {total_anchor_workers:,} workers)",
            file=sys.stderr,
        )

    # ------------------------- Per-anchor QA -------------------------------
    print("\nQA — per-anchor totals (latest year):", file=sys.stderr)
    print(f"  {'ZIP':>5}  {'Place':<22} {'WAC':>8} {'OD-in':>8}  {'RAC':>8} {'OD-out':>8}", file=sys.stderr)
    for zip_code in sorted(ANCHOR_ZIPS):
        place = zip_to_place.get(zip_code, "")
        wac_total = int(wac[(wac["year"] == LATEST_YEAR) & (wac["zcta"] == zip_code)]["totalJobs"].sum())
        rac_total = int(rac[(rac["year"] == LATEST_YEAR) & (rac["zcta"] == zip_code)]["totalJobs"].sum())
        od_in = sum(f["workerCount"] for f in flows_inbound_out if f["destZip"] == zip_code)
        od_out = sum(f["workerCount"] for f in flows_outbound_out if f["originZip"] == zip_code)
        print(
            f"  {zip_code:>5}  {place:<22} {wac_total:>8,} {od_in:>8,}  "
            f"{rac_total:>8,} {od_out:>8,}",
            file=sys.stderr,
        )

    # ------------------------- corridors.json ------------------------------
    corridors_json = {
        "version": 1,
        "nodes": [
            {
                "id": n["id"],
                "label": n["label"],
                "lng": n["lng"],
                "lat": n["lat"],
                "zip": n["zip"],
            }
            for n in sorted(nodes.values(), key=lambda x: x["id"])
        ],
        "corridors": [
            {
                "id": c["id"],
                "label": c["label"],
                "from": c["from"],
                "to": c["to"],
                "roadName": c["roadName"],
                "geometry": c["geometry"],
                "lengthMeters": c["lengthMeters"],
            }
            for c in sorted(corridors, key=lambda x: x["id"])
        ],
    }

    # ------------------------- Write ---------------------------------------
    inbound_path = OUT_DIR / "flows-inbound.json"
    outbound_path = OUT_DIR / "flows-outbound.json"
    zips_path = OUT_DIR / "zips.json"
    corridors_path = OUT_DIR / "corridors.json"
    rac_path = OUT_DIR / "rac.json"
    wac_path = OUT_DIR / "wac.json"
    od_path = OUT_DIR / "od-summary.json"
    od_blocks_path = OUT_DIR / "od-blocks.json"

    inbound_path.write_text(json.dumps(flows_inbound_out, separators=(",", ":")))
    outbound_path.write_text(json.dumps(flows_outbound_out, separators=(",", ":")))
    zips_path.write_text(json.dumps(zips_out, separators=(",", ":")))
    corridors_path.write_text(json.dumps(corridors_json, separators=(",", ":")))
    rac_path.write_text(json.dumps(rac_doc, separators=(",", ":")))
    wac_path.write_text(json.dumps(wac_doc, separators=(",", ":")))
    od_path.write_text(json.dumps(od_doc, separators=(",", ":")))
    od_blocks_path.write_text(json.dumps(od_blocks_doc, separators=(",", ":")))

    for path in (inbound_path, outbound_path, zips_path, corridors_path,
                 rac_path, wac_path, od_path, od_blocks_path):
        print(f"wrote {path.name}  ({path.stat().st_size:,} bytes)", file=sys.stderr)

    # Drop legacy outputs.
    for legacy_name in ("flows.json", "segment-aggregation.json"):
        legacy = OUT_DIR / legacy_name
        if legacy.exists():
            legacy.unlink()
            print(f"removed legacy {legacy.name}", file=sys.stderr)

    print(
        f"\nyears={lodes.YEARS[0]}..{lodes.YEARS[-1]}, "
        f"zips={len(zips_out)}, "
        f"rac_rows={len(rac_entries)}, wac_rows={len(wac_entries)}, "
        f"od_pairs={len(od_pairs)}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
