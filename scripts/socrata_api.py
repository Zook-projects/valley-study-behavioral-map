"""
socrata_api.py — Socrata Open Data API (SODA) wrapper for Colorado portals.

Used for data.colorado.gov, data.cdor.colorado.gov (Colorado Department of
Revenue), and any DOLA/CDLE/CDOT datasets exposed through Socrata.

Auth: optional free app token (https://data.colorado.gov/profile/app_tokens).
Tokens raise rate limits; without one, anonymous quota is enforced per IP.
Set SOCRATA_APP_TOKEN in .env.local.
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

DEFAULT_DOMAIN = "data.colorado.gov"
DEFAULT_TIMEOUT = 60
RETRY_COUNT = 3

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CACHE_DIR = PROJECT_ROOT / "data" / "context-cache" / "socrata"


def _token() -> str | None:
    return os.environ.get("SOCRATA_APP_TOKEN")


def fetch_resource(
    dataset_id: str,
    *,
    domain: str = DEFAULT_DOMAIN,
    where: str | None = None,
    select: str | None = None,
    order: str | None = None,
    limit: int = 50000,
    use_cache: bool = True,
) -> list[dict]:
    """
    SODA query. Returns list of records.

    Datasets are referenced by their 4x4 token (e.g. 'abcd-1234'). The query
    layer supports SoQL — SQL-flavored params like $where, $select, $order.
    """
    params: dict[str, str] = {"$limit": str(limit)}
    if where:
        params["$where"] = where
    if select:
        params["$select"] = select
    if order:
        params["$order"] = order
    token = _token()
    if token:
        params["$$app_token"] = token

    cache_token = f"{domain}-{dataset_id}-{json.dumps(params, sort_keys=True)}"
    cache_path = CACHE_DIR / f"{_safe(cache_token)}.json"
    if use_cache and cache_path.exists():
        with cache_path.open() as f:
            return json.load(f)

    url = f"https://{domain}/resource/{dataset_id}.json?{urllib.parse.urlencode(params)}"
    last_err: Exception | None = None
    for attempt in range(RETRY_COUNT):
        try:
            with urllib.request.urlopen(url, timeout=DEFAULT_TIMEOUT) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"Socrata {resp.status}: {url}")
                data = json.loads(resp.read().decode("utf-8"))
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
    raise RuntimeError(f"Socrata API failed: {last_err}")


def has_token() -> bool:
    return _token() is not None


def _safe(s: str) -> str:
    return s.replace("/", "_").replace(":", "_")[:200]


# ---------------------------------------------------------------------------
# CLI smoke test — uses the published Colorado population dataset.
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    if not has_token():
        print("WARN: no SOCRATA_APP_TOKEN — anon rate-limited.", file=sys.stderr)
    print("Smoke test — listing first 5 datasets at data.colorado.gov:", file=sys.stderr)
    print("(no-op smoke; use specific dataset_id to actually fetch).")
