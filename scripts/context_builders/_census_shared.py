"""
_census_shared.py — Helpers used by demographics / education / housing builders.

Reads cached ACS / PEP / Decennial / CBP / ZBP responses out of
data/context-cache/census/ and assembles the per-level latest + trend blocks.
"""

from __future__ import annotations

from pathlib import Path
import json

# scripts/context_builders/_census_shared.py → project root is 3 levels up.
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
CACHE_DIR = PROJECT_ROOT / "data" / "context-cache" / "census"


def _coerce(value):
    """Census API returns strings — coerce to int/float when possible, else None."""
    if value is None or value == "" or value == "null":
        return None
    try:
        s = str(value)
        if "." in s:
            return float(s)
        return int(s)
    except (ValueError, TypeError):
        return None


def _to_dicts(rows):
    if not rows:
        return []
    header = rows[0]
    return [dict(zip(header, r)) for r in rows[1:]]


def _load_cached(dataset: str, year: int) -> list[dict]:
    """
    Walk the cache directory for a dataset+year and return every cached
    response as flat list of dicts. Each cache file is one Census API call;
    we union all of them so we get every geography that was fetched.
    """
    base = CACHE_DIR / dataset / str(year)
    if not base.exists():
        return []
    out: list[dict] = []
    for f in base.glob("*.json"):
        try:
            with f.open() as fh:
                data = json.load(fh)
            out.extend(_to_dicts(data))
        except Exception:
            continue
    return out


def load_acs5(year: int) -> list[dict]:
    return _load_cached("acs/acs5", year)


def load_acs5_subject(year: int) -> list[dict]:
    return _load_cached("acs/acs5/subject", year)


def load_pep(year: int) -> list[dict]:
    return _load_cached("pep/population", year)


def load_decennial_pl(year: int = 2020) -> list[dict]:
    return _load_cached("dec/pl", year)


def load_cbp(year: int) -> list[dict]:
    return _load_cached("cbp", year)


def load_zbp(year: int) -> list[dict]:
    return _load_cached("zbp", year)


def _merge(rows: list[dict]) -> dict | None:
    """Union the columns from every matching row. Census variables are
    chunked across multiple API calls (the `get=` param caps at ~50 vars),
    so a single geography's data is split across several cache files.
    Merging unions every column the chunks emitted."""
    if not rows:
        return None
    out: dict = {}
    for r in rows:
        for k, v in r.items():
            # Only fill keys we don't already have a non-empty value for —
            # this preserves the first-seen geography metadata (NAME, state, etc.)
            # while combining variable columns across chunks.
            if k not in out or out[k] in (None, ""):
                out[k] = v
    return out


def state_row(rows: list[dict], state_fips: str = "08") -> dict | None:
    matches = [r for r in rows if r.get("state") == state_fips
               and not r.get("county") and not r.get("place")
               and not r.get("zip code tabulation area")]
    return _merge(matches)


def county_row(rows: list[dict], state_fips: str, county_fips: str) -> dict | None:
    matches = [r for r in rows if r.get("state") == state_fips and r.get("county") == county_fips]
    return _merge(matches)


def place_row(rows: list[dict], state_fips: str, place_code: str) -> dict | None:
    matches = [r for r in rows if r.get("state") == state_fips and r.get("place") == place_code]
    return _merge(matches)


def zcta_row(rows: list[dict], zcta: str) -> dict | None:
    matches: list[dict] = []
    for r in rows:
        zkey = r.get("zip code tabulation area") or r.get("zcta5") or r.get("ZCTA5")
        if zkey == zcta:
            matches.append(r)
    return _merge(matches)


def number_or_none(row: dict | None, key: str):
    if row is None:
        return None
    return _coerce(row.get(key))


def sum_vars(row: dict | None, keys: list[str]) -> int | None:
    """Sum a list of raw ACS variable values; return None if every value missing."""
    if row is None:
        return None
    total = 0
    any_value = False
    for k in keys:
        v = _coerce(row.get(k))
        if v is None:
            continue
        any_value = True
        total += v
    return int(total) if any_value else None
