#!/usr/bin/env python3
"""
build-data.py — Convert filtered LODES8 extracts into flow + ZIP + corridor JSON.

Reads:
  - data/lodes-cache/filtered/{rac,wac,od}-YYYY.csv (built by fetch-lodes.py)
  - public/data/corridors.geojson — hand-authored canonical corridor graph
  - 2024 Census ZCTA Gazetteer (downloaded to /tmp on first run)

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
import sys
import urllib.request
import zipfile
from pathlib import Path

import lodes
from osrm import OsrmError, route_polyline
from smoothing import haversine_length_meters

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
OUT_DIR = PROJECT_ROOT / "public" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

CORRIDORS_GEOJSON = OUT_DIR / "corridors.geojson"
OSRM_CACHE_PATH = HERE / ".osrm-corridor-cache.json"

GAZ_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip"
GAZ_LOCAL_TXT = Path("/tmp/2024_Gaz_zcta_national.txt")
GAZ_LOCAL_ZIP = Path("/tmp/gaz_zcta_2024.zip")

COORD_DECIMALS = 6
OSRM_SNAP_RADIUS_M: int | None = None

# Latest LODES vintage shipped on the map. The card-strip sparklines render
# the full 2002–2023 series; the corridor map renders this single year.
LATEST_YEAR = lodes.LATEST_YEAR

# Anchor ZIPs — appear as workplace (inbound) and residence (outbound).
ANCHOR_ZIPS = {
    "81601", "81611", "81615", "81621", "81623",
    "81630", "81635", "81647", "81650", "81652", "81654",
}

# City-center coordinates for anchor ZIPs. Same overrides as the prior build —
# gazetteer centroids are too far from downtown for sprawling resort/rural ZIPs.
CITY_CENTROIDS: dict[str, tuple[float, float]] = {
    "81601": (39.5505, -107.3248),
    "81611": (39.1911, -106.8175),
    "81615": (39.2130, -106.9378),
    "81621": (39.3691, -107.0328),
    "81623": (39.4019, -107.2117),
    "81630": (39.3306, -108.2231),
    "81635": (39.4519, -108.0531),
    "81647": (39.5736, -107.5306),
    "81650": (39.5347, -107.7831),
    "81652": (39.5483, -107.6539),
    "81654": (39.3310, -106.9849),
}

# Friendly place names for the 11 anchors. External CO ZIPs fall back to
# whatever the gazetteer-derived seed map provides; if both miss, the UI
# renders the bare ZIP code.
ANCHOR_PLACE_NAMES: dict[str, str] = {
    "81601": "Glenwood Springs",
    "81611": "Aspen",
    "81615": "Snowmass Village",
    "81621": "Basalt",
    "81623": "Carbondale",
    "81630": "DeBeque",
    "81635": "Battlement Mesa",
    "81647": "New Castle",
    "81650": "Rifle",
    "81652": "Silt",
    "81654": "Snowmass",
}

# Gateway routing rules (preserved from the prior build).
GATEWAY_E_NODE = "GW_E"
GATEWAY_W_NODE = "GW_W"
GATEWAY_SPLIT_LNG = -107.3248


# ---------------------------------------------------------------------------
# Gazetteer load
# ---------------------------------------------------------------------------
def load_gazetteer() -> dict[str, tuple[float, float]]:
    if not GAZ_LOCAL_TXT.exists():
        print(f"  fetching gazetteer → {GAZ_URL}", file=sys.stderr)
        urllib.request.urlretrieve(GAZ_URL, GAZ_LOCAL_ZIP)
        with zipfile.ZipFile(GAZ_LOCAL_ZIP) as zf:
            zf.extractall("/tmp")

    centroids: dict[str, tuple[float, float]] = {}
    with open(GAZ_LOCAL_TXT, encoding="utf-8") as fh:
        header = fh.readline().rstrip("\n").split("\t")
        header = [h.strip() for h in header]
        idx_geo = header.index("GEOID")
        idx_lat = header.index("INTPTLAT")
        idx_lng = header.index("INTPTLONG")
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) <= idx_lng:
                continue
            zcta = parts[idx_geo].strip()
            try:
                lat = float(parts[idx_lat].strip())
                lng = float(parts[idx_lng].strip())
            except ValueError:
                continue
            centroids[zcta] = (lat, lng)
    return centroids


# ---------------------------------------------------------------------------
# Place-name resolver
# ---------------------------------------------------------------------------
def load_place_name_seed() -> dict[str, str]:
    """
    Bootstrap a ZIP→place lookup from the prior build's zips.json so external
    CO ZIPs already known to the renderer keep their friendly labels. Anchor
    overrides win over this seed.
    """
    seed: dict[str, str] = {}
    prior = OUT_DIR / "zips.json"
    if prior.exists():
        try:
            with prior.open(encoding="utf-8") as fh:
                for entry in json.load(fh):
                    z = entry.get("zip")
                    p = entry.get("place")
                    if z and p:
                        seed[z] = p
        except Exception as e:
            print(f"  ! could not seed place names from prior zips.json: {e}", file=sys.stderr)
    seed.update(ANCHOR_PLACE_NAMES)
    return seed


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

    rac = lodes.aggregate_rac_or_wac(rac_raw, "h_geocode")
    wac = lodes.aggregate_rac_or_wac(wac_raw, "w_geocode")
    od_pairs = lodes.aggregate_od_to_zip_pairs(od_raw)
    print(
        f"  → RAC ZCTA-years {len(rac):,}; WAC ZCTA-years {len(wac):,}; "
        f"OD pairs {len(od_pairs):,}",
        file=sys.stderr,
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
    centroids = load_gazetteer()
    print(f"  → {len(centroids):,} ZCTA centroids", file=sys.stderr)

    zip_to_place = load_place_name_seed()

    # ------------------------- Build flow rows -----------------------------
    # The map renders the latest LODES vintage. Other years live in the
    # rac/wac/od-summary trend arrays for the card strip.
    od_latest = od_pairs[od_pairs["year"] == LATEST_YEAR]

    # Per-anchor totals for percentage normalization.
    inbound_totals = (
        od_latest[od_latest["w_zip"].isin(ANCHOR_ZIPS)]
        .groupby("w_zip")["totalJobs"].sum().to_dict()
    )
    outbound_totals = (
        od_latest[od_latest["h_zip"].isin(ANCHOR_ZIPS)]
        .groupby("h_zip")["totalJobs"].sum().to_dict()
    )

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
        denom = inbound_totals.get(r.w_zip, 0) or 1
        flows_inbound_out.append({
            "originZip": str(r.h_zip),
            "originPlace": zip_to_place.get(str(r.h_zip), ""),
            "destZip": str(r.w_zip),
            "destPlace": zip_to_place.get(str(r.w_zip), ""),
            "workerCount": int(r.totalJobs),
            "percentage": round(int(r.totalJobs) / denom, 6),
            "year": int(r.year),
            "source": "LEHD",
            "segments": _segments_for_row(r),
        })

    flows_outbound_out: list[dict] = []
    for r in od_latest[od_latest["h_zip"].isin(ANCHOR_ZIPS)].itertuples(index=False):
        denom = outbound_totals.get(r.h_zip, 0) or 1
        flows_outbound_out.append({
            "originZip": str(r.h_zip),
            "originPlace": zip_to_place.get(str(r.h_zip), ""),
            "destZip": str(r.w_zip),
            "destPlace": zip_to_place.get(str(r.w_zip), ""),
            "workerCount": int(r.totalJobs),
            "percentage": round(int(r.totalJobs) / denom, 6),
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
    if in_drift > 0.005:
        print(
            f"  ! inbound drift {in_drift:.2%} exceeds 0.5%; possible ingest bug",
            file=sys.stderr,
        )

    # Per-pair segment sanity: each axis (age / wage / naics3) sums to within
    # ±2 of workerCount. LODES uses noise infusion so exact equality won't
    # hold, but drift > 2 on any single row indicates an ingest bug that
    # broke segment column propagation.
    SEG_TOL = 2
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
            if abs(s - wc) > SEG_TOL:
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
            f"  ! {seg_violations} flow rows with segment drift > ±{SEG_TOL}",
            file=sys.stderr,
        )
    else:
        print(
            f"  segment sanity ok — every axis sums to workerCount ±{SEG_TOL}",
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

    inbound_path.write_text(json.dumps(flows_inbound_out, separators=(",", ":")))
    outbound_path.write_text(json.dumps(flows_outbound_out, separators=(",", ":")))
    zips_path.write_text(json.dumps(zips_out, indent=2))
    corridors_path.write_text(json.dumps(corridors_json, separators=(",", ":")))
    rac_path.write_text(json.dumps(rac_doc, separators=(",", ":")))
    wac_path.write_text(json.dumps(wac_doc, separators=(",", ":")))
    od_path.write_text(json.dumps(od_doc, separators=(",", ":")))

    for path in (inbound_path, outbound_path, zips_path, corridors_path,
                 rac_path, wac_path, od_path):
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
