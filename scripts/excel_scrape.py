"""
excel_scrape.py — Helpers for ingesting Excel/CSV/PDF artifacts from
agency websites that don't offer programmatic APIs.

Specifically used by:
- Colorado Department of Revenue Sales/Lodging tax reports (Excel)
- Home-rule city sales-tax dashboards (Glenwood Springs / Aspen / Carbondale /
  Snowmass Village / Basalt) — formats vary across cities
- Census Building Permits Survey flat files
- RFTA Year-in-Review PDFs

The expectation is that fetch-context-tax.py and fetch-context-tourism.py
download the source artifact to the cache directory once per refresh, then
this module's helpers parse it into a normalized DataFrame. Manual file drops
are also supported — drop a file in the cache directory and the parser runs.
"""

from __future__ import annotations

from pathlib import Path
import csv
import io
import sys
import time
import urllib.request
import urllib.error

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
CACHE_ROOT = PROJECT_ROOT / "data" / "context-cache"

DEFAULT_TIMEOUT = 120
RETRY_COUNT = 3


def download_to_cache(url: str, cache_subdir: str, filename: str, *, use_cache: bool = True) -> Path:
    """
    Download a file (Excel, CSV, PDF) to data/context-cache/{subdir}/{filename}.
    Returns the local path. Skips download when the file already exists.
    """
    target = CACHE_ROOT / cache_subdir / filename
    if use_cache and target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)

    last_err: Exception | None = None
    for attempt in range(RETRY_COUNT):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "valley-context/1.0"},
            )
            with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status}: {url}")
                with target.open("wb") as f:
                    f.write(resp.read())
            return target
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as e:
            last_err = e
            if attempt < RETRY_COUNT - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            break
    raise RuntimeError(f"download failed for {url}: {last_err}")


def read_csv_dicts(path: Path) -> list[dict]:
    with path.open() as f:
        return list(csv.DictReader(f))


def read_excel_dicts(path: Path, sheet: str | int = 0) -> list[dict]:
    """
    Lazy-load openpyxl/pandas only when called. The build doesn't require
    Excel parsing for the LODES path, so no top-level import.
    """
    try:
        import pandas as pd  # type: ignore
    except ImportError as e:
        raise RuntimeError("pandas required to parse Excel — install via `pip install pandas openpyxl`") from e
    df = pd.read_excel(path, sheet_name=sheet)
    return df.to_dict(orient="records")


def expected_files_in(cache_subdir: str) -> list[Path]:
    """List every cached artifact under a subdirectory — useful to surface manual drops."""
    root = CACHE_ROOT / cache_subdir
    if not root.exists():
        return []
    return sorted([p for p in root.glob("**/*") if p.is_file()])


if __name__ == "__main__":  # pragma: no cover
    print("excel_scrape — module entry point. Used by fetch-context-tax.py and fetch-context-tourism.py.", file=sys.stderr)
    print("Cache root:", CACHE_ROOT)
