"""
osrm.py — fetch real road geometry for corridor edges via OSRM.

Used at build time only by `scripts/build-data.py`. The runtime app has no
OSRM dependency — it consumes the baked-in `corridors.json`.

Public OSRM demo server is the default endpoint. Responses are cached to
`scripts/.osrm-corridor-cache.json` so repeat builds against unchanged
control points hit the network 0×. The cache key includes the coordinates
*and* options that affect the returned geometry, so changing either
invalidates the row.

Routing strategy: for a corridor authored with N control points
(p0, p1, …, pN-1), every point is sent to OSRM as an ordered waypoint.
This forces OSRM to thread the route through the highway the author
intended — Hwy 82, I-70, Brush Creek Rd — rather than picking some
parallel side-road shortcut. The first and last waypoints are anchored to
the node coordinates by the caller before the call.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

OSRM_BASE_URL = "https://router.project-osrm.org/route/v1/driving"

# Pacing for the public demo server — empirically safe spacing observed in v2.
REQUEST_DELAY_S = 0.4
MAX_RETRIES = 3
BACKOFF_BASE_S = 1.5

# Default: no per-waypoint snap radius. OSRM uses its built-in nearest-road
# search, which is generous enough to tolerate hand-authored control points
# sketched roughly along a highway. Pass an explicit radius (in meters) to
# tighten the snap when ambiguous parallel roads need to be excluded.
DEFAULT_SNAP_RADIUS_M: int | None = None


class OsrmError(RuntimeError):
    """Raised when OSRM returns a non-`Ok` response after all retries."""


def _coords_path(coords: list[list[float]]) -> str:
    """Format an ordered list of [lng, lat] pairs into the OSRM URL path segment."""
    return ";".join(f"{c[0]:.6f},{c[1]:.6f}" for c in coords)


def _cache_key(coords: list[list[float]], radius_m: int | None) -> str:
    """Stable hash of the request inputs, used as the cache row key."""
    payload = json.dumps(
        {"coords": [[round(c[0], 6), round(c[1], 6)] for c in coords], "r": radius_m},
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _load_cache(cache_path: Path) -> dict:
    if not cache_path.exists():
        return {}
    try:
        with cache_path.open(encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        print(f"  ! OSRM cache unreadable ({e}); starting fresh", file=sys.stderr)
        return {}


def _write_cache(cache_path: Path, cache: dict) -> None:
    cache_path.write_text(json.dumps(cache, sort_keys=True, indent=2))


def route_polyline(
    coords: list[list[float]],
    cache_path: Path,
    radius_m: int | None = DEFAULT_SNAP_RADIUS_M,
    label: str = "",
) -> list[list[float]]:
    """
    Return the OSRM-snapped polyline that threads `coords` along real roads.

    Args:
      coords: ordered [lng, lat] waypoints. First is the start, last is the
        end, intermediates are via-points used to constrain the route to a
        specific corridor.
      cache_path: filesystem location of the JSON-on-disk request cache.
        Created if missing.
      radius_m: snap radius applied to every waypoint. OSRM will refuse the
        route if any point falls outside this radius from the road network.
      label: optional human-readable tag for log lines.

    Returns:
      A list of [lng, lat] pairs forming the routed polyline.

    Raises:
      OsrmError: if OSRM returns no route after MAX_RETRIES retries, or
        responds with a non-`Ok` status code.
    """
    if len(coords) < 2:
        raise ValueError("route_polyline needs at least 2 coordinates")

    cache = _load_cache(cache_path)
    key = _cache_key(coords, radius_m)
    if key in cache:
        return [list(p) for p in cache[key]["geometry"]]

    # continue_straight=true forbids U-turns at via-points. Without this,
    # roughly-sketched control points can cause OSRM to overshoot and double
    # back, producing absurdly long routes.
    qs = "overview=full&geometries=geojson&continue_straight=true"
    if radius_m is not None:
        radii = ";".join(str(radius_m) for _ in coords)
        qs = f"{qs}&radiuses={radii}"
    url = f"{OSRM_BASE_URL}/{_coords_path(coords)}?{qs}"

    last_err: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            time.sleep(REQUEST_DELAY_S)
            with urllib.request.urlopen(url, timeout=30) as resp:
                body = resp.read()
            data = json.loads(body)
            if data.get("code") != "Ok":
                raise OsrmError(
                    f"OSRM responded code={data.get('code')!r} "
                    f"message={data.get('message')!r} for {label or coords[0]}…{coords[-1]}"
                )
            routes = data.get("routes") or []
            if not routes:
                raise OsrmError(f"OSRM returned no routes for {label!r}")
            geometry = routes[0]["geometry"]["coordinates"]
            polyline = [[round(float(p[0]), 6), round(float(p[1]), 6)] for p in geometry]
            cache[key] = {"geometry": polyline, "label": label}
            _write_cache(cache_path, cache)
            return polyline
        except (urllib.error.HTTPError, urllib.error.URLError, OsrmError, TimeoutError) as e:
            last_err = e
            if attempt < MAX_RETRIES:
                wait = BACKOFF_BASE_S ** attempt
                print(
                    f"  ! OSRM attempt {attempt}/{MAX_RETRIES} failed for "
                    f"{label!r}: {e}; retrying in {wait:.1f}s",
                    file=sys.stderr,
                )
                time.sleep(wait)
            else:
                break

    raise OsrmError(
        f"OSRM failed after {MAX_RETRIES} attempts for {label!r}: {last_err}"
    )
