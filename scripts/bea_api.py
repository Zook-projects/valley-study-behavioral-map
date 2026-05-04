"""
bea_api.py — BEA Regional Economic Accounts (REIS) wrapper.

Covers CAINC (personal income by place of residence), CAEMP25N (employment by
industry), CAGDP9 (county GDP).

Auth: free BEA API key (https://apps.bea.gov/API/signup/). Required.
Set BEA_API_KEY in .env.local.
"""

from __future__ import annotations

from pathlib import Path
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error

BEA_BASE = "https://apps.bea.gov/api/data"
DEFAULT_TIMEOUT = 60
RETRY_COUNT = 3

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CACHE_DIR = PROJECT_ROOT / "data" / "context-cache" / "bea"


def _api_key() -> str | None:
    key = os.environ.get("BEA_API_KEY")
    return key if key else None


def fetch_regional(
    *,
    table_name: str,
    line_code: int | str,
    geo_fips: str,
    year: str = "ALL",
    use_cache: bool = True,
) -> dict:
    """
    BEA Regional dataset query.

    `table_name` is e.g. 'CAINC1', 'CAINC4', 'CAEMP25N', 'CAGDP9'.
    `line_code` is the row of interest (table-specific, see BEA documentation).
    `geo_fips` is a 5-digit county GEOID, '08000' for state, or 'COUNTY'/'STATE'
    for a full pull.
    """
    key = _api_key()
    if not key:
        raise RuntimeError(
            "BEA_API_KEY required. Sign up free at https://apps.bea.gov/API/signup/"
        )

    params = {
        "UserID": key,
        "method": "GetData",
        "datasetname": "Regional",
        "TableName": table_name,
        "LineCode": str(line_code),
        "GeoFips": geo_fips,
        "Year": year,
        "ResultFormat": "JSON",
    }
    cache_token = f"{table_name}-{line_code}-{geo_fips}-{year}"
    cache_path = CACHE_DIR / f"{cache_token}.json"

    if use_cache and cache_path.exists():
        with cache_path.open() as f:
            return json.load(f)

    url = f"{BEA_BASE}?{urllib.parse.urlencode(params)}"
    last_err: Exception | None = None
    for attempt in range(RETRY_COUNT):
        try:
            with urllib.request.urlopen(url, timeout=DEFAULT_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            with cache_path.open("w") as f:
                json.dump(data, f)
            return data
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            last_err = e
            if attempt < RETRY_COUNT - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            break
    raise RuntimeError(f"BEA API failed: {last_err}")


def has_key() -> bool:
    return _api_key() is not None


# Common line codes per table (from BEA documentation).
# CAINC1 line 1 = personal income (thousands of dollars).
# CAINC1 line 2 = population.
# CAINC1 line 3 = per capita personal income (dollars).
CAINC1_LINES = {
    "personalIncome": 1,
    "population": 2,
    "perCapitaIncome": 3,
}

# CAEMP25N — Total full-time and part-time employment by industry.
# Line 10 = total employment; lines 70/80 = wage/salary vs. proprietors.
CAEMP25N_LINES = {
    "totalEmp": 10,
    "wageSalaryEmp": 70,
    "proprietorsEmp": 80,
}

# CAGDP9 line 1 = All industry total (real GDP).
CAGDP9_LINES = {
    "countyGdp": 1,
}


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    if not has_key():
        print("ERR: BEA_API_KEY required. Aborting smoke test.", file=sys.stderr)
        sys.exit(1)
    print("Smoke test — Garfield County per-capita income 2023:", file=sys.stderr)
    data = fetch_regional(
        table_name="CAINC1",
        line_code=CAINC1_LINES["perCapitaIncome"],
        geo_fips="08045",
        year="2023",
    )
    print(json.dumps(data.get("BEAAPI", {}).get("Results", {}).get("Data", []), indent=2))
