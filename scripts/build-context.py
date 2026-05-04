"""
build-context.py — Orchestrator for the 6 context topic JSONs.

Reads cached extracts populated by the fetch-context-*.py scripts, normalizes
each into the `context_schema.build_envelope` wire format, validates, and
writes public/data/context/{topic}.json.

Topics:
  demographics  ← fetch_context_census (ACS B/S, PEP, Decennial)
  education     ← fetch_context_census (ACS S1501) + NCES CCD (county/district)
  employment    ← fetch_context_labor  (BLS QCEW + LAUS, BEA REIS, CDLE OEWS)
  housing       ← fetch_context_census (ACS B25) + fetch_context_housing
                  (Zillow, HUD CHAS, HUD FMR, Census BPS)
  commerce      ← fetch_context_census (CBP/ZBP) + fetch_context_tax (CDOR
                  + home-rule city reports)
  tourism       ← fetch_context_tax (CDOR lodging) + fetch_context_tourism
                  (BLS NAICS 71/72, BTS, RFTA, CTO)

Each topic uses the union of available sources — if a fetcher hasn't been run
yet (cache empty), the topic envelope still emits with whatever has been
filled so the UI can show partial data with explicit "no data" placeholders.

Determinism: same cache → byte-stable output.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from context_schema import (
    TOPICS,
    build_envelope,
    coverage_table,
    validate_envelope,
    write_topic_json,
)

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
OUT_DIR = PROJECT_ROOT / "public" / "data" / "context"

# Each topic builder is imported lazily so a missing module (e.g., a fetcher
# we haven't shipped yet, or a cache that's empty) doesn't break the others.
TOPIC_BUILDERS: dict[str, str] = {
    "demographics": "build_demographics",
    "education": "build_education",
    "employment": "build_employment",
    "housing": "build_housing",
    "commerce": "build_commerce",
    "tourism": "build_tourism",
}


def _empty_envelope(topic: str) -> dict:
    return build_envelope(
        topic=topic,
        vintage_start=2010,
        vintage_end=2024,
        sources=[],
        state_data=None,
        county_data={},
        place_data={},
    )


def _try_build(topic: str) -> dict:
    """
    Each topic builder is in `context_builders/{topic}.py` (lazy-loaded).
    If the module or cache isn't ready, fall back to an empty envelope so the
    JSON file still emits.
    """
    try:
        mod = __import__(f"context_builders.{topic}", fromlist=[TOPIC_BUILDERS[topic]])
        builder = getattr(mod, TOPIC_BUILDERS[topic])
        env = builder()
        return env
    except (ImportError, FileNotFoundError) as e:
        print(f"  {topic:<14} (skipped — {type(e).__name__}: {e})", file=sys.stderr)
        return _empty_envelope(topic)
    except Exception as e:  # pragma: no cover
        # Still emit empty so build never hard-aborts mid-run; surface error.
        print(f"  {topic:<14} (ERROR — {type(e).__name__}: {e})", file=sys.stderr)
        return _empty_envelope(topic)


def main() -> int:
    print("Building context JSONs…", file=sys.stderr)
    print(f"Output: {OUT_DIR}", file=sys.stderr)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print("\nQA coverage:", file=sys.stderr)
    print("  topic          state    counties    places", file=sys.stderr)
    print("  " + "-" * 50, file=sys.stderr)

    all_warnings: dict[str, list[str]] = {}
    for topic in TOPICS:
        env = _try_build(topic)
        warnings = validate_envelope(env)
        all_warnings[topic] = warnings
        print(coverage_table(env), file=sys.stderr)
        write_topic_json(env, OUT_DIR / f"{topic}.json")

    print("", file=sys.stderr)
    if any(all_warnings.values()):
        print("Validation warnings:", file=sys.stderr)
        for topic, ws in all_warnings.items():
            for w in ws:
                print(f"  {topic}: {w}", file=sys.stderr)
    else:
        print("All envelopes passed validation.", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
