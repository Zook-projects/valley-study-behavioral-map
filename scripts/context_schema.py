"""
context_schema.py — Shared envelope + helpers for the 6 context topic JSONs.

Every fetch-context-*.py script returns a `TopicData` payload using these
helpers; build-context.py merges them into the per-topic envelopes and writes
public/data/context/{topic}.json.

Schema is documented in /Users/jakezook/.claude/plans/groovy-foraging-scroll.md
under "Output JSON contract".
"""

from __future__ import annotations

from datetime import date
from typing import Any
import json

from geographies import (
    STATE_FIPS,
    STATE_NAME,
    all_county_records,
    all_place_records,
    state_record,
)

# Six canonical topic IDs.
TOPICS: list[str] = [
    "demographics",
    "education",
    "employment",
    "housing",
    "commerce",
    "tourism",
]


# ---------------------------------------------------------------------------
# Source descriptors (embedded into the topic envelope's `sources[]`)
# ---------------------------------------------------------------------------
def source(
    *,
    id: str,
    agency: str,
    dataset: str,
    endpoint: str,
    last_pulled: str | None = None,
) -> dict:
    return {
        "id": id,
        "agency": agency,
        "dataset": dataset,
        "endpoint": endpoint,
        "lastPulled": last_pulled or date.today().isoformat(),
    }


# ---------------------------------------------------------------------------
# Trend point + series helpers
# ---------------------------------------------------------------------------
def trend_point(year: int, value: int | float | None) -> dict:
    return {"year": int(year), "value": value if value is None else float(value)}


def trend_series(pairs: list[tuple[int, int | float | None]]) -> list[dict]:
    return [trend_point(y, v) for y, v in sorted(pairs, key=lambda p: p[0])]


# ---------------------------------------------------------------------------
# Envelope builder
# ---------------------------------------------------------------------------
def build_envelope(
    *,
    topic: str,
    vintage_start: int,
    vintage_end: int,
    sources: list[dict],
    state_data: dict | None,
    county_data: dict[str, dict],
    place_data: dict[str, dict],
) -> dict:
    """
    Compose the wire-format topic envelope.

    `state_data`        : single dict {latest, trend} or None
    `county_data`       : keyed by 5-digit county GEOID (e.g., '08045')
    `place_data`        : keyed by anchor ZIP (e.g., '81601')

    Levels with no data emitted by a fetcher come through as
    {latest: null, trend: {}}; the renderer treats null as "no data
    published at this geography" and shows a labeled placeholder.
    """
    state_block = None
    if state_data is not None:
        rec = state_record()
        state_block = {
            **rec,
            "latest": state_data.get("latest"),
            "trend": state_data.get("trend", {}),
        }

    counties = []
    for rec in all_county_records():
        d = county_data.get(rec["geoid"], {})
        counties.append({
            **rec,
            "latest": d.get("latest"),
            "trend": d.get("trend", {}),
        })

    places = []
    for rec in all_place_records():
        d = place_data.get(rec["zip"], {})
        # Strip non-serializable centroid tuple — keep only what the UI uses.
        place_entry = {
            "zip": rec["zip"],
            "name": rec["name"],
            "kind": rec["kind"],
            "placeGeoid": rec["place_geoid"],
            "countyGeoid": rec["county_geoid"],
            "countyName": rec["county_name"],
            "latest": d.get("latest"),
            "trend": d.get("trend", {}),
        }
        # Pass through any topic-specific extras (e.g., commerce's
        # `shareOfCounty`) without coupling them to the shared schema.
        for k, v in d.items():
            if k not in ("latest", "trend"):
                place_entry[k] = v
        places.append(place_entry)

    return {
        "topic": topic,
        "vintageRange": {"start": int(vintage_start), "end": int(vintage_end)},
        "sources": sources,
        "state": state_block,
        "counties": counties,
        "places": places,
    }


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------
def validate_envelope(envelope: dict, *, expected_county_count: int = 4, expected_place_count: int = 11) -> list[str]:
    """Return a list of validation warnings (empty == clean)."""
    warnings: list[str] = []
    if envelope.get("topic") not in TOPICS:
        warnings.append(f"unknown topic: {envelope.get('topic')}")
    counties = envelope.get("counties", [])
    if len(counties) != expected_county_count:
        warnings.append(f"county count {len(counties)} != expected {expected_county_count}")
    places = envelope.get("places", [])
    if len(places) != expected_place_count:
        warnings.append(f"place count {len(places)} != expected {expected_place_count}")
    if envelope.get("state") is None:
        warnings.append("state block is null")
    return warnings


def coverage_table(envelope: dict) -> str:
    """Render a one-line QA summary for the build log."""
    topic = envelope.get("topic", "?")
    state_ok = "✓" if (envelope.get("state") and envelope["state"].get("latest")) else "·"
    counties = envelope.get("counties", [])
    county_filled = sum(1 for c in counties if c.get("latest"))
    places = envelope.get("places", [])
    place_filled = sum(1 for p in places if p.get("latest"))
    return (
        f"  {topic:<14} state {state_ok}  "
        f"counties {county_filled}/{len(counties)}  "
        f"places {place_filled}/{len(places)}"
    )


# ---------------------------------------------------------------------------
# JSON write — byte-stable
# ---------------------------------------------------------------------------
def write_topic_json(envelope: dict, out_path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(envelope, indent=2, sort_keys=False, ensure_ascii=False)
    out_path.write_text(text + "\n")


if __name__ == "__main__":  # pragma: no cover
    # Smoke: emit an empty demographics envelope so the schema is inspectable.
    env = build_envelope(
        topic="demographics",
        vintage_start=2010,
        vintage_end=2023,
        sources=[],
        state_data=None,
        county_data={},
        place_data={},
    )
    print(json.dumps(env, indent=2))
