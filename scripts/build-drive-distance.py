"""
build-drive-distance.py — precompute OSRM drive-distance + drive-time for every
ZIP-pair appearing in the inbound + outbound LEHD flows.

Output: public/data/drive-distance.json — a flat object keyed by sorted
"smallerZip|largerZip" string, with `{ miles, seconds }` per entry. The runtime
app loads this once and uses it instead of Haversine when computing
worker-weighted mean commute distance. Pairs missing from the map fall back to
Haversine × a detour factor at runtime.

Endpoint: https://router.project-osrm.org/table/v1/driving — public OSRM demo
server. The demo's `max-table-size` is documented at 100 total coordinates per
request, so we batch 50 sources × 50 destinations per call (100 coords). Each
response yields up to 2,500 cells. With ~432 unique flow ZIPs, we issue
ceil(432/50)² ≈ 81 table requests; pacing is ~1s/req to stay polite to the
demo server.

Cache: scripts/.osrm-distance-cache.json. Keyed on the sorted ZIP-pair (so an
A→B request and a B→A request hit the same row). Cache is checkpointed after
every successful chunk so an interrupted run can resume.

Symmetry assumption: driving distance/time is treated as symmetric. OSRM may
report tiny asymmetries due to one-way streets, but at this aggregation level
(worker-weighted mean across thousands of flows) the asymmetry is well below
the floor of any decision the dashboard supports. We canonicalize on the
sorted pair and store one row.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OSRM_BASE = "https://router.project-osrm.org/table/v1/driving"
TABLE_CHUNK = 50  # 50 src + 50 dst = 100 coords per request — within demo limit
REQUEST_DELAY_S = 1.0
MAX_RETRIES = 3
BACKOFF_BASE_S = 2.0
METERS_PER_MILE = 1609.344

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "public" / "data"
OUTPUT_PATH = DATA_DIR / "drive-distance.json"
CACHE_PATH = Path(__file__).resolve().parent / ".osrm-distance-cache.json"


def _load_cache() -> dict:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            print("  ! cache unreadable; starting fresh", file=sys.stderr)
    return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, sort_keys=True))


def _fetch_table(
    coords: list[tuple[float, float]],
    src_idx: list[int],
    dst_idx: list[int],
    label: str,
) -> dict:
    coord_str = ";".join(f"{lng:.6f},{lat:.6f}" for lng, lat in coords)
    src_str = ";".join(str(i) for i in src_idx)
    dst_str = ";".join(str(i) for i in dst_idx)
    url = (
        f"{OSRM_BASE}/{coord_str}"
        f"?annotations=distance,duration"
        f"&sources={src_str}&destinations={dst_str}"
    )

    last_err: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            time.sleep(REQUEST_DELAY_S)
            with urllib.request.urlopen(url, timeout=120) as resp:
                body = resp.read()
            data = json.loads(body)
            if data.get("code") != "Ok":
                raise RuntimeError(
                    f"OSRM code={data.get('code')!r} message={data.get('message')!r}"
                )
            return data
        except (urllib.error.HTTPError, urllib.error.URLError, RuntimeError, TimeoutError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                wait = BACKOFF_BASE_S ** attempt
                print(
                    f"  ! {label} attempt {attempt}/{MAX_RETRIES} failed: {e}; retry in {wait:.1f}s",
                    file=sys.stderr,
                )
                time.sleep(wait)
    raise RuntimeError(f"OSRM table failed {label}: {last_err}")


def main() -> None:
    print("Loading inputs…")
    zips = {z["zip"]: z for z in json.loads((DATA_DIR / "zips.json").read_text())}
    inbound = json.loads((DATA_DIR / "flows-inbound.json").read_text())
    outbound = json.loads((DATA_DIR / "flows-outbound.json").read_text())

    pairs: set[tuple[str, str]] = set()
    needed_zips: set[str] = set()
    skipped_no_centroid = 0

    for row in inbound + outbound:
        o, d = row["originZip"], row["destZip"]
        if o == d or o == "ALL_OTHER" or d == "ALL_OTHER":
            continue
        zo, zd = zips.get(o), zips.get(d)
        if not zo or not zd or zo.get("lat") is None or zd.get("lat") is None:
            skipped_no_centroid += 1
            continue
        a, b = (o, d) if o < d else (d, o)
        pairs.add((a, b))
        needed_zips.add(o)
        needed_zips.add(d)

    print(f"  unique ZIPs: {len(needed_zips)}")
    print(f"  unique symmetric pairs: {len(pairs)}")
    if skipped_no_centroid:
        print(f"  skipped (missing centroid): {skipped_no_centroid}")

    cache = _load_cache()
    needed_pairs = [p for p in pairs if f"{p[0]}|{p[1]}" not in cache]
    print(f"  cached: {len(pairs) - len(needed_pairs)}; need: {len(needed_pairs)}")

    if needed_pairs:
        # For sorted pairs (a < b), `a` is always the "low" ZIP and `b` is the
        # "high" ZIP. Source set = all unique low values; destination set = all
        # unique high values. Iterating src × dst guarantees coverage of every
        # needed pair.
        src_set = sorted({a for a, _ in needed_pairs})
        dst_set = sorted({b for _, b in needed_pairs})
        print(f"  src ZIPs to query: {len(src_set)}; dst ZIPs: {len(dst_set)}")

        n_src_chunks = (len(src_set) + TABLE_CHUNK - 1) // TABLE_CHUNK
        n_dst_chunks = (len(dst_set) + TABLE_CHUNK - 1) // TABLE_CHUNK
        total_calls = n_src_chunks * n_dst_chunks
        print(f"  table requests: {total_calls}")

        call_idx = 0
        for si, ss in enumerate(range(0, len(src_set), TABLE_CHUNK)):
            src_chunk = src_set[ss : ss + TABLE_CHUNK]
            for di, dd in enumerate(range(0, len(dst_set), TABLE_CHUNK)):
                dst_chunk = dst_set[dd : dd + TABLE_CHUNK]
                call_idx += 1

                # Coords for this request — dedup src+dst (a ZIP can appear in
                # both lists). Indices into the request-local coords list are
                # what the URL references.
                used_zips: list[str] = list(dict.fromkeys(src_chunk + dst_chunk))
                req_coords = [(zips[z]["lng"], zips[z]["lat"]) for z in used_zips]
                used_idx = {z: i for i, z in enumerate(used_zips)}
                src_local = [used_idx[z] for z in src_chunk]
                dst_local = [used_idx[z] for z in dst_chunk]
                label = f"call {call_idx}/{total_calls} (src[{si+1}/{n_src_chunks}] dst[{di+1}/{n_dst_chunks}])"
                print(
                    f"  {label} coords={len(req_coords)} src={len(src_local)} dst={len(dst_local)}"
                )

                data = _fetch_table(req_coords, src_local, dst_local, label)
                dist_m = data.get("distances") or []
                dur_s = data.get("durations") or []

                added = 0
                for i, src_zip in enumerate(src_chunk):
                    for j, dst_zip in enumerate(dst_chunk):
                        a, b = (src_zip, dst_zip) if src_zip < dst_zip else (dst_zip, src_zip)
                        if (a, b) not in pairs:
                            continue
                        key = f"{a}|{b}"
                        if key in cache:
                            continue
                        m = dist_m[i][j] if i < len(dist_m) and j < len(dist_m[i]) else None
                        s = dur_s[i][j] if i < len(dur_s) and j < len(dur_s[i]) else None
                        if m is None or s is None:
                            continue
                        cache[key] = {
                            "miles": round(m / METERS_PER_MILE, 4),
                            "seconds": round(s, 1),
                        }
                        added += 1
                print(f"    +{added} new pairs (cache: {len(cache)})")
                _save_cache(cache)

    # Filter cache to just the pairs we care about for the published file.
    out = {f"{a}|{b}": cache[f"{a}|{b}"] for (a, b) in pairs if f"{a}|{b}" in cache}
    print(f"Resolved: {len(out)}/{len(pairs)} pairs")

    if len(out) < len(pairs):
        missing = [p for p in pairs if f"{p[0]}|{p[1]}" not in out]
        print(f"  unresolved sample: {missing[:5]}", file=sys.stderr)

    OUTPUT_PATH.write_text(json.dumps(out, separators=(",", ":")))
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
