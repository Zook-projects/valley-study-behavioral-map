"""
anchors.py — Single source of truth for the 11-anchor study area.

Both build-data.py and build-passthrough.py used to define these constants
inline; drift between the two scripts would silently break the corridor
graph's ZIP→node binding. Importing from one module guarantees lockstep.
"""

from __future__ import annotations

# 11 anchor ZCTAs spanning De Beque → Aspen.
ANCHOR_ZIPS: set[str] = {
    "81601", "81611", "81615", "81621", "81623",
    "81630", "81635", "81647", "81650", "81652", "81654",
}

# City-center coordinates for the 11 anchors. Gazetteer centroids drift far
# from downtown for sprawling resort/rural ZIPs, so the build overrides them.
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

# Friendly place names for the 11 anchors. External CO ZIPs fall back to the
# gazetteer-derived seed map; if both miss, the UI renders the bare ZIP code.
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
