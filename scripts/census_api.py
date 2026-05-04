"""
census_api.py — Census Data API wrapper.

Covers ACS 5-Year detailed (B-) and subject (S-) tables, ACS Data Profile (DP-),
PEP, Decennial 2020 (PL/DHC), County Business Patterns (CBP), ZIP Business
Patterns (ZBP), and the Building Permits Survey (BPS).

Auth: free Census API key (https://api.census.gov/data/key_signup.html).
Set CENSUS_API_KEY in .env.local. Without a key, requests return after 500
calls/day per IP — fine for one-off pulls but the key is recommended.
"""

from __future__ import annotations

from pathlib import Path
import hashlib
import json
import os
import sys
import time
from typing import Iterable
from urllib.parse import urlencode

import urllib.request
import urllib.error

CENSUS_BASE = "https://api.census.gov/data"
DEFAULT_TIMEOUT = 60
RETRY_COUNT = 3
RETRY_BACKOFF_SEC = 2

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CACHE_DIR = PROJECT_ROOT / "data" / "context-cache" / "census"


def _api_key() -> str | None:
    key = os.environ.get("CENSUS_API_KEY")
    return key if key else None


def _cache_path(dataset: str, year: int, geography: dict, variables: list[str]) -> Path:
    """
    Cache key = geography (always present, always short) + an md5 hash of the
    sorted variable list (to disambiguate per chunk without bloating the
    filename). Filenames are stable across runs as long as inputs match.
    """
    geo_part = json.dumps(geography, sort_keys=True).replace("/", "_").replace(":", "_").replace('"', "").replace(" ", "")
    var_hash = hashlib.md5(",".join(sorted(variables)).encode()).hexdigest()[:8]
    safe = f"{geo_part}-{var_hash}"[:200]
    return CACHE_DIR / dataset / str(year) / f"{safe}.json"


def fetch(
    dataset: str,
    year: int,
    *,
    variables: list[str],
    geography: dict[str, str],
    cache_key: str | None = None,
    use_cache: bool = True,
) -> list[list[str]]:
    """
    Generic Census API GET.

    `dataset` is the path under /data/{year}/, e.g. 'acs/acs5', 'acs/acs5/subject',
    'pep/population', 'dec/dhc', 'cbp', 'zbp'. `geography` is the for/in pair, e.g.
    {'for': 'place:30835', 'in': 'state:08'}.

    Returns the raw rows (header + data). Caches on disk so re-runs are offline.
    """
    params: dict[str, str] = {
        "get": ",".join(variables),
        **geography,
    }
    key = _api_key()
    if key:
        params["key"] = key

    url = f"{CENSUS_BASE}/{year}/{dataset}?{urlencode(params)}"

    path = _cache_path(dataset, year, geography, variables)

    if use_cache and path.exists():
        with path.open() as f:
            return json.load(f)

    last_err: Exception | None = None
    for attempt in range(RETRY_COUNT):
        try:
            with urllib.request.urlopen(url, timeout=DEFAULT_TIMEOUT) as resp:
                # 204 No Content = ACS published nothing for this variable+geography
                # combination. Common at place level for housing detail tables.
                # Cache an empty list so retries don't re-hit and the builder
                # treats it as "no data" rather than an error.
                if resp.status == 204:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with path.open("w") as f:
                        json.dump([], f)
                    return []
                if resp.status != 200:
                    raise RuntimeError(f"Census API returned {resp.status}: {url}")
                body = resp.read().decode("utf-8")
                data = json.loads(body)
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("w") as f:
                json.dump(data, f)
            return data
        except urllib.error.HTTPError as e:
            # 404 = endpoint doesn't exist for this year (e.g., PEP pre-2015,
            # ZBP post-2018). Skip cleanly without retry.
            if e.code in (400, 404):
                return []
            last_err = e
            if attempt < RETRY_COUNT - 1:
                time.sleep(RETRY_BACKOFF_SEC ** (attempt + 1))
                continue
            break
        except (urllib.error.URLError, RuntimeError) as e:
            last_err = e
            if attempt < RETRY_COUNT - 1:
                time.sleep(RETRY_BACKOFF_SEC ** (attempt + 1))
                continue
            break
    raise RuntimeError(f"Census API failed after {RETRY_COUNT} retries: {url} ({last_err})")


def fetch_acs5(
    year: int,
    *,
    variables: list[str],
    table: str = "acs5",
    geography: dict[str, str],
) -> list[list[str]]:
    """Convenience for ACS 5-Year detailed-table calls."""
    return fetch(f"acs/{table}", year, variables=variables, geography=geography)


def fetch_acs5_subject(year: int, *, variables: list[str], geography: dict[str, str]) -> list[list[str]]:
    return fetch("acs/acs5/subject", year, variables=variables, geography=geography)


def fetch_pep(year: int, *, variables: list[str], geography: dict[str, str]) -> list[list[str]]:
    return fetch("pep/population", year, variables=variables, geography=geography)


def fetch_decennial(
    year: int,
    *,
    table: str,
    variables: list[str],
    geography: dict[str, str],
) -> list[list[str]]:
    """`table` is one of 'pl', 'dhc', 'ddhca' (only 2020+)."""
    return fetch(f"dec/{table}", year, variables=variables, geography=geography)


def fetch_cbp(year: int, *, variables: list[str], geography: dict[str, str]) -> list[list[str]]:
    return fetch("cbp", year, variables=variables, geography=geography)


def fetch_zbp(year: int, *, variables: list[str], geography: dict[str, str]) -> list[list[str]]:
    return fetch("zbp", year, variables=variables, geography=geography)


def to_dicts(rows: list[list[str]]) -> list[dict]:
    """Census API returns header + rows. Promote header to dict keys."""
    if not rows:
        return []
    header = rows[0]
    return [dict(zip(header, r)) for r in rows[1:]]


def has_key() -> bool:
    return _api_key() is not None


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    if not has_key():
        print("WARN: no CENSUS_API_KEY in env — proceeding keyless (low rate limit).", file=sys.stderr)
    print("Smoke test — Garfield County total population, ACS 2023 5-Year (B01001_001E):", file=sys.stderr)
    rows = fetch_acs5(
        2023,
        variables=["NAME", "B01001_001E"],
        geography={"for": "county:045", "in": "state:08"},
    )
    print(json.dumps(to_dicts(rows), indent=2))
