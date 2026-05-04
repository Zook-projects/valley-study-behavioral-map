"""
bls_api.py — BLS Public Data API v2 + QCEW bulk-CSV wrapper.

QCEW (Quarterly Census of Employment and Wages) provides covered employment +
wages by NAICS at county level. The bulk single-file-by-area CSVs are the
right ingestion path; the v2 API is reserved for LAUS unemployment series.

Auth: free BLS Public Data API v2 key. Set BLS_API_KEY in .env.local.
QCEW bulk endpoints are keyless.
"""

from __future__ import annotations

from pathlib import Path
import csv
import io
import json
import os
import sys
import time
import urllib.request
import urllib.error

QCEW_AREA_BASE = "https://data.bls.gov/cew/data/api"
BLS_V2_BASE = "https://api.bls.gov/publicAPI/v2/timeseries/data"
DEFAULT_TIMEOUT = 60
RETRY_COUNT = 3

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CACHE_DIR = PROJECT_ROOT / "data" / "context-cache" / "bls"


def _api_key() -> str | None:
    key = os.environ.get("BLS_API_KEY")
    return key if key else None


def fetch_qcew_area_annual(year: int, area_fips: str, *, use_cache: bool = True) -> list[dict]:
    """
    Annual QCEW for a single area — every NAICS published, every ownership code.

    `area_fips` is a 5-digit county code (e.g., '08045'), 'C0800' for state, or
    one of the published MSA codes. Endpoint: /api/{year}/annual/area/{area}.csv

    Returns list of dicts with keys including 'industry_code', 'own_code',
    'annual_avg_emplvl', 'annual_avg_wkly_wage', etc. See:
    https://www.bls.gov/cew/about-data/downloadable-file-layouts/csvs-by-area.htm
    """
    cache_path = CACHE_DIR / "qcew" / "annual" / f"{year}-{area_fips}.csv"
    if use_cache and cache_path.exists():
        return _read_csv(cache_path)
    # BLS QCEW Open Data Access: annual = "a", quarterly = "1"–"4".
    url = f"{QCEW_AREA_BASE}/{year}/a/area/{area_fips}.csv"
    body = _fetch_text(url)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(body)
    return _parse_csv(body)


def fetch_qcew_area_quarterly(year: int, qtr: int, area_fips: str, *, use_cache: bool = True) -> list[dict]:
    """Quarterly QCEW for a single area."""
    cache_path = CACHE_DIR / "qcew" / "quarterly" / f"{year}-{qtr}-{area_fips}.csv"
    if use_cache and cache_path.exists():
        return _read_csv(cache_path)
    url = f"{QCEW_AREA_BASE}/{year}/{qtr}/area/{area_fips}.csv"
    body = _fetch_text(url)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(body)
    return _parse_csv(body)


def fetch_v2_series(
    series_ids: list[str],
    *,
    start_year: int,
    end_year: int,
    use_cache: bool = True,
) -> dict:
    """
    BLS Public Data API v2 — used for LAUS, CES, OEWS, projections.

    LAUS series IDs follow `LAUCN{state}{county}{measure}` for unemployment
    (e.g., LAUCN080450000000003 = Garfield County unemployment rate).

    Without a key, capped at 25 queries/day and 10-year span. With a key:
    500 queries/day and 20-year span.
    """
    payload = {
        "seriesid": series_ids,
        "startyear": str(start_year),
        "endyear": str(end_year),
    }
    key = _api_key()
    if key:
        payload["registrationkey"] = key

    cache_token = f"{','.join(sorted(series_ids))}-{start_year}-{end_year}"
    cache_path = CACHE_DIR / "v2" / f"{_safe(cache_token)}.json"
    if use_cache and cache_path.exists():
        with cache_path.open() as f:
            return json.load(f)

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BLS_V2_BASE,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    last_err: Exception | None = None
    for attempt in range(RETRY_COUNT):
        try:
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if data.get("status") != "REQUEST_SUCCEEDED":
                raise RuntimeError(f"BLS v2 returned {data.get('status')}: {data.get('message')}")
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            with cache_path.open("w") as f:
                json.dump(data, f)
            return data
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as e:
            last_err = e
            if attempt < RETRY_COUNT - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            break
    raise RuntimeError(f"BLS v2 API failed: {last_err}")


def laus_county_series(state_fips: str, county_fips: str) -> dict[str, str]:
    """LAUS series IDs for a county. Returns {measure_name: series_id}."""
    base = f"LAUCN{state_fips}{county_fips}0000000"
    return {
        "unemploymentRate": f"{base}03",
        "unemployment": f"{base}04",
        "employed": f"{base}05",
        "laborForce": f"{base}06",
    }


def laus_state_series(state_fips: str) -> dict[str, str]:
    base = f"LASST{state_fips}0000000000"
    return {
        "unemploymentRate": f"{base}03",
        "unemployment": f"{base}04",
        "employed": f"{base}05",
        "laborForce": f"{base}06",
    }


def has_key() -> bool:
    return _api_key() is not None


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------
def _fetch_text(url: str) -> str:
    last_err: Exception | None = None
    for attempt in range(RETRY_COUNT):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "valley-context/1.0"})
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status}: {url}")
                return resp.read().decode("utf-8")
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as e:
            last_err = e
            if attempt < RETRY_COUNT - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            break
    raise RuntimeError(f"BLS bulk fetch failed: {url} ({last_err})")


def _parse_csv(body: str) -> list[dict]:
    reader = csv.DictReader(io.StringIO(body))
    return list(reader)


def _read_csv(path: Path) -> list[dict]:
    with path.open() as f:
        return list(csv.DictReader(f))


def _safe(s: str) -> str:
    return s.replace("/", "_").replace(":", "_")[:200]


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    if not has_key():
        print("WARN: no BLS_API_KEY in env — v2 calls capped at 25/day.", file=sys.stderr)
    print("Smoke test — QCEW 2023 annual for Garfield County (08045):", file=sys.stderr)
    rows = fetch_qcew_area_annual(2023, "08045")
    total_emp = next(
        (r for r in rows if r.get("industry_code") == "10" and r.get("own_code") == "0"),
        None,
    )
    if total_emp:
        print(f"  Total covered employment: {total_emp.get('annual_avg_emplvl')}")
    else:
        print("  (no total-private row found — check cache)")
