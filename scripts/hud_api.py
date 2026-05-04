"""
hud_api.py — HUD User API wrapper for Fair Market Rents (FMR) + Income Limits.

CHAS (Comprehensive Housing Affordability Strategy) is bulk-download only — no
public API — handled separately by scripts/fetch-context-housing.py.

Auth: free HUD User API token (https://www.huduser.gov/portal/dataset/fmr-api.html).
Set HUD_API_TOKEN in .env.local.
"""

from __future__ import annotations

from pathlib import Path
import json
import os
import sys
import time
import urllib.request
import urllib.error

HUD_BASE = "https://www.huduser.gov/hudapi/public"
DEFAULT_TIMEOUT = 60
RETRY_COUNT = 3

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CACHE_DIR = PROJECT_ROOT / "data" / "context-cache" / "hud"


def _token() -> str | None:
    return os.environ.get("HUD_API_TOKEN")


def fetch_fmr_county(state_county_fips: str, year: int, *, use_cache: bool = True) -> dict:
    """
    FMR by bedroom count for a county.

    `state_county_fips` is a 5-digit FIPS like '08045'. HUD uses its own 10-digit
    entity-code format: state(2) + county(3) + '99999'. Discoverable via
    /fmr/listCounties/{ST}.
    """
    hud_code = f"{state_county_fips}99999"
    return _fetch(
        f"fmr/data/{hud_code}", {"year": str(year)},
        cache_key=f"fmr-{hud_code}-{year}", use_cache=use_cache,
    )


def fetch_il_county(state_county_fips: str, year: int, *, use_cache: bool = True) -> dict:
    """Income Limits (Very Low / Low / Extremely Low) for a county."""
    hud_code = f"{state_county_fips}99999"
    return _fetch(
        f"il/data/{hud_code}", {"year": str(year)},
        cache_key=f"il-{hud_code}-{year}", use_cache=use_cache,
    )


def has_token() -> bool:
    return _token() is not None


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------
def _fetch(path: str, params: dict[str, str], *, cache_key: str, use_cache: bool) -> dict:
    token = _token()
    if not token:
        raise RuntimeError(
            "HUD_API_TOKEN required. Sign up free at https://www.huduser.gov/portal/"
        )
    cache_path = CACHE_DIR / f"{_safe(cache_key)}.json"
    if use_cache and cache_path.exists():
        with cache_path.open() as f:
            return json.load(f)

    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{HUD_BASE}/{path}?{qs}"
    last_err: Exception | None = None
    for attempt in range(RETRY_COUNT):
        try:
            req = urllib.request.Request(
                url,
                headers={"Authorization": f"Bearer {token}"},
            )
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
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
    raise RuntimeError(f"HUD API failed: {last_err}")


def _safe(s: str) -> str:
    return s.replace("/", "_").replace(":", "_")[:200]


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    if not has_token():
        print("ERR: HUD_API_TOKEN required. Aborting smoke test.", file=sys.stderr)
        sys.exit(1)
    data = fetch_fmr_county("08045", 2025)
    print(json.dumps(data, indent=2))
