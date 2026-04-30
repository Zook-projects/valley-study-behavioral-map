"""
geo.py — geographic helpers used at build time.

Two helpers:
  - haversine_length_meters: polyline length, used to compute corridor lengths
    from OSRM-returned road geometry.
  - load_gazetteer: download + parse the 2024 ZCTA Gazetteer into a
    {zcta: (lat, lng)} dict. Cached on disk so repeat builds run offline.

(Earlier builds also smoothed corridors with a Catmull-Rom spline; that pass
was removed when corridors were switched to real road geometry from OSRM.)
"""

from __future__ import annotations

import math
import sys
import urllib.request
import zipfile
from pathlib import Path

GAZ_URL = (
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/"
    "2024_Gazetteer/2024_Gaz_zcta_national.zip"
)
GAZ_TXT_NAME = "2024_Gaz_zcta_national.txt"
GAZ_ZIP_NAME = "2024_Gaz_zcta_national.zip"


def load_gazetteer(cache_dir: Path) -> dict[str, tuple[float, float]]:
    """
    Return a {ZCTA: (lat, lng)} dict for every ZCTA in the 2024 Census
    Gazetteer. Downloads + extracts on first call; cached on disk thereafter.

    `cache_dir` is created if missing. Both the .zip download and extracted
    .txt live there.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    txt_path = cache_dir / GAZ_TXT_NAME
    zip_path = cache_dir / GAZ_ZIP_NAME

    if not txt_path.exists():
        print(f"  fetching gazetteer → {GAZ_URL}", file=sys.stderr)
        urllib.request.urlretrieve(GAZ_URL, zip_path)
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(cache_dir)

    centroids: dict[str, tuple[float, float]] = {}
    with open(txt_path, encoding="utf-8") as fh:
        header = [h.strip() for h in fh.readline().rstrip("\n").split("\t")]
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


def haversine_length_meters(points: list[list[float]]) -> float:
    """
    Sum Haversine distances along a polyline of [lng, lat] pairs and return
    total length in meters. Used to compute corridor lengths for Dijkstra.
    """
    if len(points) < 2:
        return 0.0
    R = 6_371_000.0
    total = 0.0
    for i in range(1, len(points)):
        lng1, lat1 = points[i - 1]
        lng2, lat2 = points[i]
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlam = math.radians(lng2 - lng1)
        a = (
            math.sin(dphi / 2) ** 2
            + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
        )
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        total += R * c
    return total
