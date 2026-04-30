"""
lodes.py — LODES8 ingest helpers used by build-data.py.

Reads the per-year filtered CSVs produced by scripts/fetch-lodes.py and
aggregates them to ZCTA-level totals across the full 2002–2023 vintage span.

LODES variable code → human key mapping is centralized here so the build
script never sees raw `Cxxx` / `CNSxx` / `Sxxx` columns.
"""

from __future__ import annotations

from pathlib import Path
import sys

import pandas as pd

HERE = Path(__file__).resolve().parent
PROJECT_ROOT = HERE.parent
FILTERED_DIR = PROJECT_ROOT / "data" / "lodes-cache" / "filtered"

YEARS = list(range(2002, 2024))
LATEST_YEAR = 2023

# ---------------------------------------------------------------------------
# Column → key mappings (per LODES8 tech doc + plan Appendix A)
# ---------------------------------------------------------------------------
RAC_WAC_COLS: dict[str, str] = {
    "C000": "totalJobs",
    "CA01": "ageU29",
    "CA02": "age30to54",
    "CA03": "age55plus",
    "CE01": "wageLow",
    "CE02": "wageMid",
    "CE03": "wageHigh",
    "CR01": "raceWhite",
    "CR02": "raceBlack",
    "CR03": "raceAmInd",
    "CR04": "raceAsian",
    "CR05": "raceNhpi",
    # NOTE: LODES8 omits a CR06 column. The race code set runs CR01..CR05
    # then jumps to CR07 ("Two or More Race Groups") — this is per the LEHD
    # LODES tech doc, not a missing extract. No race count is dropped.
    "CR07": "raceTwoOrMore",
    "CT01": "ethnicityNotHispanic",
    "CT02": "ethnicityHispanic",
    "CD01": "educationLessHs",
    "CD02": "educationHs",
    "CD03": "educationSomeCol",
    "CD04": "educationBachPlus",
    "CS01": "sexMale",
    "CS02": "sexFemale",
}

# NAICS-20 → NAICS-3 super-sector rollup. Bucket lists must stay in sync with
# the plan's Appendix A and with OD's SI01..SI03 columns.
NAICS_GOODS = ["CNS01", "CNS02", "CNS04", "CNS05"]                # 11, 21, 23, 31-33
NAICS_TTU   = ["CNS03", "CNS06", "CNS07", "CNS08"]                # 22, 42, 44-45, 48-49
NAICS_OTHER = [                                                   # 51..92
    "CNS09", "CNS10", "CNS11", "CNS12", "CNS13", "CNS14",
    "CNS15", "CNS16", "CNS17", "CNS18", "CNS19", "CNS20",
]

# Individual NAICS-20 columns kept on RAC/WAC latest blocks (informational
# only — the cards roll them into the 3-bucket axis to align with OD).
NAICS_20_COLS: dict[str, str] = {
    "CNS01": "naics11_agriculture",
    "CNS02": "naics21_mining",
    "CNS03": "naics22_utilities",
    "CNS04": "naics23_construction",
    "CNS05": "naics3133_manufacturing",
    "CNS06": "naics42_wholesale",
    "CNS07": "naics4445_retail",
    "CNS08": "naics4849_transportation",
    "CNS09": "naics51_information",
    "CNS10": "naics52_finance",
    "CNS11": "naics53_realEstate",
    "CNS12": "naics54_professional",
    "CNS13": "naics55_management",
    "CNS14": "naics56_admin",
    "CNS15": "naics61_education",
    "CNS16": "naics62_healthcare",
    "CNS17": "naics71_arts",
    "CNS18": "naics72_accommodation",
    "CNS19": "naics81_otherServices",
    "CNS20": "naics92_publicAdmin",
}

OD_COLS: dict[str, str] = {
    "S000": "totalJobs",
    "SA01": "ageU29",
    "SA02": "age30to54",
    "SA03": "age55plus",
    "SE01": "wageLow",
    "SE02": "wageMid",
    "SE03": "wageHigh",
    "SI01": "naicsGoods",
    "SI02": "naicsTradeTransUtil",
    "SI03": "naicsAllOther",
}


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------
def _load_year_csv(prefix: str, year: int) -> pd.DataFrame:
    path = FILTERED_DIR / f"{prefix}-{year}.csv"
    if not path.exists():
        raise FileNotFoundError(
            f"missing filtered LODES file: {path}. Run scripts/fetch-lodes.py first."
        )
    # Force ZCTA + geocode columns to string so NaN-induced dtype=float doesn't
    # silently strip leading zeros or coerce comparisons in the build script.
    return pd.read_csv(
        path,
        dtype={
            "h_geocode": str,
            "w_geocode": str,
            "zcta": str,
            "h_zcta": str,
            "w_zcta": str,
            "h_state": str,
            "w_state": str,
        },
    )


def load_rac_all_years() -> pd.DataFrame:
    """Load every per-year RAC filtered CSV. One row per (block, year) at this stage."""
    frames = [_load_year_csv("rac", y) for y in YEARS]
    return pd.concat(frames, ignore_index=True)


def load_wac_all_years() -> pd.DataFrame:
    frames = [_load_year_csv("wac", y) for y in YEARS]
    return pd.concat(frames, ignore_index=True)


def load_od_all_years() -> pd.DataFrame:
    frames = [_load_year_csv("od", y) for y in YEARS]
    return pd.concat(frames, ignore_index=True)


# ---------------------------------------------------------------------------
# Aggregation helpers
# ---------------------------------------------------------------------------
def aggregate_rac_or_wac(df: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregate block-level RAC/WAC rows up to (zcta, year) totals across every
    LODES variable plus the rolled-up NAICS-3 columns.

    Output columns: zcta, year + every value column in RAC_WAC_COLS
    + naicsGoods + naicsTradeTransUtil + naicsAllOther. NAICS-20 columns are
    summed only as inputs to the NAICS-3 rollup and are dropped from the
    returned frame — no downstream consumer reads them.
    """
    naics20_cols = list(NAICS_20_COLS.keys())
    value_cols = list(RAC_WAC_COLS.keys()) + naics20_cols
    # Drop any rows whose ZCTA mapping failed — should not happen given the
    # fetch-time filter, but be defensive.
    df = df[df["zcta"].notna()].copy()
    grouped = (
        df.groupby(["zcta", "year"], as_index=False)[value_cols]
        .sum()
        .sort_values(["zcta", "year"])
        .reset_index(drop=True)
    )

    # Roll up NAICS-3
    grouped["naicsGoods"] = grouped[NAICS_GOODS].sum(axis=1)
    grouped["naicsTradeTransUtil"] = grouped[NAICS_TTU].sum(axis=1)
    grouped["naicsAllOther"] = grouped[NAICS_OTHER].sum(axis=1)

    # Rename LODES codes → human keys, then drop the now-unused NAICS-20
    # columns. The NAICS_20_COLS dict stays as documentation but the data
    # path keeps only the 3-bucket rollup that downstream code actually uses.
    grouped = grouped.rename(columns=RAC_WAC_COLS)
    grouped = grouped.drop(columns=naics20_cols)

    return grouped


def aggregate_od_to_zip_pairs(df: pd.DataFrame) -> pd.DataFrame:
    """
    Aggregate filtered OD rows to (h_zip, w_zip, year). External (out-of-state)
    endpoints get bucketed as 'ALL_OTHER' — they cannot be routed through the
    corridor graph and the existing renderer treats ALL_OTHER as off-map.

    External *in-state* endpoints retain their CO ZCTA — the corridor router
    classifies those by centroid longitude into a gateway node.
    """
    df = df.copy()

    # Map h_zip / w_zip:
    # - h_zcta / w_zcta from the statewide xwalk (in-state CO ZCTAs)
    # - else ALL_OTHER (out-of-state and any unresolved CO blocks)
    def to_zip(zcta_series: pd.Series) -> pd.Series:
        return zcta_series.where(zcta_series.notna(), "ALL_OTHER")

    df["h_zip"] = to_zip(df["h_zcta"])
    df["w_zip"] = to_zip(df["w_zcta"])

    value_cols = list(OD_COLS.keys())
    grouped = (
        df.groupby(["h_zip", "w_zip", "year"], as_index=False)[value_cols]
        .sum()
        .sort_values(["h_zip", "w_zip", "year"])
        .reset_index(drop=True)
    )
    grouped = grouped.rename(columns=OD_COLS)
    return grouped


# ---------------------------------------------------------------------------
# Per-ZIP and aggregate panel builders
# ---------------------------------------------------------------------------
def _trend_series(rows: pd.DataFrame, col: str) -> list[dict]:
    """Compact 22-point series for a single dimension."""
    sub = rows[["year", col]].sort_values("year")
    return [
        {"year": int(y), "value": int(v)}
        for y, v in zip(sub["year"], sub[col])
    ]


def _latest_block(row: pd.Series) -> dict:
    """Latest-year breakdown block for an RAC/WAC entry."""
    return {
        "totalJobs": int(row["totalJobs"]),
        "age": {
            "u29": int(row["ageU29"]),
            "age30to54": int(row["age30to54"]),
            "age55plus": int(row["age55plus"]),
        },
        "wage": {
            "low": int(row["wageLow"]),
            "mid": int(row["wageMid"]),
            "high": int(row["wageHigh"]),
        },
        "naics3": {
            "goods": int(row["naicsGoods"]),
            "tradeTransUtil": int(row["naicsTradeTransUtil"]),
            "allOther": int(row["naicsAllOther"]),
        },
        "race": {
            "white": int(row["raceWhite"]),
            "black": int(row["raceBlack"]),
            "amInd": int(row["raceAmInd"]),
            "asian": int(row["raceAsian"]),
            "nhpi": int(row["raceNhpi"]),
            "twoOrMore": int(row["raceTwoOrMore"]),
        },
        "ethnicity": {
            "notHispanic": int(row["ethnicityNotHispanic"]),
            "hispanic": int(row["ethnicityHispanic"]),
        },
        "education": {
            "lessHs": int(row["educationLessHs"]),
            "hs": int(row["educationHs"]),
            "someCol": int(row["educationSomeCol"]),
            "bachPlus": int(row["educationBachPlus"]),
        },
        "sex": {
            "male": int(row["sexMale"]),
            "female": int(row["sexFemale"]),
        },
    }


# Trend dimensions emitted on RAC/WAC entries (the dimensions cards visualize
# as sparklines). Education / race / ethnicity / sex carry latest-year only —
# documented in the plan.
TREND_DIMS = [
    "totalJobs",
    "ageU29", "age30to54", "age55plus",
    "wageLow", "wageMid", "wageHigh",
    "naicsGoods", "naicsTradeTransUtil", "naicsAllOther",
]


def build_rac_or_wac_entries(
    grouped: pd.DataFrame,
    zip_to_place: dict[str, str],
) -> tuple[list[dict], dict]:
    """
    Build (per-zip entries, aggregate roll-up) for RAC or WAC.

    `grouped` is the output of `aggregate_rac_or_wac`. The aggregate roll-up
    is the sum of per-zip latest blocks plus a year-by-year sum trend.
    """
    entries: list[dict] = []
    for zcta, rows in grouped.groupby("zcta", sort=True):
        rows = rows.sort_values("year")
        latest_row = rows[rows["year"] == LATEST_YEAR]
        if latest_row.empty:
            continue
        entry = {
            "zip": str(zcta),
            "place": zip_to_place.get(str(zcta), ""),
            "latestYear": LATEST_YEAR,
            "latest": _latest_block(latest_row.iloc[0]),
            "trend": {dim: _trend_series(rows, dim) for dim in TREND_DIMS},
        }
        entries.append(entry)

    # Aggregate roll-up — sum of every per-zip × per-year row.
    agg_year = (
        grouped.groupby("year", as_index=False)
        [list(RAC_WAC_COLS.values()) + ["naicsGoods", "naicsTradeTransUtil", "naicsAllOther"]]
        .sum()
        .sort_values("year")
        .reset_index(drop=True)
    )
    agg_latest = agg_year[agg_year["year"] == LATEST_YEAR]
    aggregate = {
        "latestYear": LATEST_YEAR,
        "latest": _latest_block(agg_latest.iloc[0]) if not agg_latest.empty else None,
        "trend": {dim: _trend_series(agg_year, dim) for dim in TREND_DIMS},
    }
    return entries, aggregate


def _od_latest_block(row: pd.Series) -> dict:
    return {
        "totalJobs": int(row["totalJobs"]),
        "age": {
            "u29": int(row["ageU29"]),
            "age30to54": int(row["age30to54"]),
            "age55plus": int(row["age55plus"]),
        },
        "wage": {
            "low": int(row["wageLow"]),
            "mid": int(row["wageMid"]),
            "high": int(row["wageHigh"]),
        },
        "naics3": {
            "goods": int(row["naicsGoods"]),
            "tradeTransUtil": int(row["naicsTradeTransUtil"]),
            "allOther": int(row["naicsAllOther"]),
        },
    }


OD_TREND_DIMS = [
    "totalJobs",
    "ageU29", "age30to54", "age55plus",
    "wageLow", "wageMid", "wageHigh",
    "naicsGoods", "naicsTradeTransUtil", "naicsAllOther",
]


def build_od_summary(
    od_pairs: pd.DataFrame,
    anchor_zips: set[str],
    zip_to_place: dict[str, str],
    top_n: int = 25,
) -> tuple[list[dict], dict]:
    """
    Build (per-zip OD summary entries, aggregate OD roll-up).

    Per-anchor inflow = OD pairs where w_zip == anchor (workers commuting in).
    Per-anchor outflow = OD pairs where h_zip == anchor (residents commuting out).

    Self-pairs (h_zip == w_zip — people who live and work in the same ZIP) are
    excluded so totals/trends/partners reflect true cross-ZIP commuters only.
    Within-ZIP workforce is captured separately by the per-ZIP "live and work"
    stat in StatsForZip.
    """
    # Capture self-pairs (h_zip == w_zip — people who live AND work in the
    # same ZIP) BEFORE filtering them out, so we can emit a separate
    # "within-ZIP" trend per anchor for the bottom-strip OD card.
    # Sum all 10 OD value columns (totalJobs + 9 segment buckets) so the
    # within-ZIP card supports the segment filter the same way inflow/outflow
    # do — sparklines re-aggregate from the per-year per-bucket series.
    self_pairs = od_pairs[od_pairs["h_zip"] == od_pairs["w_zip"]]
    self_by_year = (
        self_pairs.groupby(["h_zip", "year"], as_index=False)[list(OD_COLS.values())]
        .sum()
        .rename(columns={"h_zip": "zip"})
    )

    # Drop within-ZIP commuters at the source so every downstream aggregation
    # (inflow/outflow latest, trends, top partners, regional roll-up) is
    # consistently a cross-ZIP universe.
    od_pairs = od_pairs[od_pairs["h_zip"] != od_pairs["w_zip"]]

    # Sum to (zip, year) for inflow and outflow separately.
    inflow_by_year = (
        od_pairs.groupby(["w_zip", "year"], as_index=False)[list(OD_COLS.values())]
        .sum()
        .rename(columns={"w_zip": "zip"})
    )
    outflow_by_year = (
        od_pairs.groupby(["h_zip", "year"], as_index=False)[list(OD_COLS.values())]
        .sum()
        .rename(columns={"h_zip": "zip"})
    )

    # Pre-compute (anchor, partner, year) totals once for both directions.
    # The per-anchor loop below indexes into these instead of re-filtering
    # od_pairs on every iteration. Multi-ZIP places (Grand Junction's 81501
    # + 81504, Denver's many ZIPs) are consolidated into a single ranked
    # row downstream so a city counts once and doesn't burn multiple top-N
    # slots. Top-N named rows are followed by a pinned "All Other Locations"
    # residual = scope total − sum of top-N (incl. native LODES ALL_OTHER
    # rolled in). This guarantees the listed values sum to the card's total.
    inflow_by_partner_year = (
        od_pairs.groupby(["w_zip", "h_zip", "year"], as_index=False)["totalJobs"]
        .sum()
    )
    outflow_by_partner_year = (
        od_pairs.groupby(["h_zip", "w_zip", "year"], as_index=False)["totalJobs"]
        .sum()
    )

    def _split_top(
        scope_by_partner_year: pd.DataFrame,
        partner_col: str,
        anchor: str,
    ) -> list[dict]:
        scope = scope_by_partner_year[scope_by_partner_year.iloc[:, 0] == anchor]
        if scope.empty:
            return []
        latest = scope[scope["year"] == LATEST_YEAR]
        grand_total = int(latest["totalJobs"].sum())

        # Roll named rows up by place, falling back to ZIP when the ZIP has
        # no place mapping. ALL_OTHER is excluded from this pass — it's
        # reconstructed below as the residual.
        consolidated: dict[str, dict] = {}
        for _, row in latest.sort_values("totalJobs", ascending=False).iterrows():
            zip_val = str(row[partner_col])
            if zip_val == "ALL_OTHER":
                continue
            place = zip_to_place.get(zip_val, "")
            key = f"place:{place}" if place else f"zip:{zip_val}"
            if key in consolidated:
                consolidated[key]["totalJobs"] += int(row["totalJobs"])
                consolidated[key]["zips"].append(zip_val)
            else:
                consolidated[key] = {
                    "place": place,
                    "zips": [zip_val],
                    "totalJobs": int(row["totalJobs"]),
                }

        ranked = sorted(consolidated.values(), key=lambda r: -r["totalJobs"])
        top_named = ranked[:top_n]
        residual_total = grand_total - sum(r["totalJobs"] for r in top_named)

        def _trend_for_zips(zips: list[str]) -> list[dict]:
            rows = scope[scope[partner_col].isin(zips)]
            if rows.empty:
                return []
            yearly = (
                rows.groupby("year", as_index=False)["totalJobs"]
                .sum()
                .sort_values("year")
            )
            return [
                {"year": int(r["year"]), "value": int(r["totalJobs"])}
                for _, r in yearly.iterrows()
            ]

        output: list[dict] = []
        for r in top_named:
            # Multi-ZIP places (e.g., Denver, Grand Junction) collapse to
            # the literal "multiple" so the UI still renders a ZIP suffix
            # without ballooning the row width.
            zip_str = r["zips"][0] if len(r["zips"]) == 1 else "multiple"
            output.append({
                "zip": zip_str,
                "place": r["place"],
                "workers": r["totalJobs"],
                "zips": sorted(r["zips"]),
                "trend": _trend_for_zips(r["zips"]),
            })
        if residual_total > 0:
            # Residual trend = scope total − sum of top-N trends per year.
            # Native ALL_OTHER is rolled in so the line matches the latest-
            # year residual figure.
            top_zip_set = {z for r in top_named for z in r["zips"]}
            resid_rows = scope[~scope[partner_col].isin(top_zip_set)]
            resid_trend: list[dict] = []
            if not resid_rows.empty:
                yearly = (
                    resid_rows.groupby("year", as_index=False)["totalJobs"]
                    .sum()
                    .sort_values("year")
                )
                resid_trend = [
                    {"year": int(r["year"]), "value": int(r["totalJobs"])}
                    for _, r in yearly.iterrows()
                ]
            output.append({
                "zip": "ALL_OTHER",
                "place": "All Other Locations",
                "workers": residual_total,
                "zips": [],
                "trend": resid_trend,
            })
        # Final sort by workers desc — ensures the ALL_OTHER residual takes
        # its true rank among the named partners rather than always sitting
        # at the end. Any external consumer of od-summary.json that trusts
        # array order now sees a correctly ranked list. Frontend filters
        # like `p.zip !== 'ALL_OTHER'` continue to work.
        output.sort(key=lambda r: -r["workers"])
        return output

    entries: list[dict] = []
    for zcta in sorted(anchor_zips):
        in_rows = inflow_by_year[inflow_by_year["zip"] == zcta].sort_values("year")
        out_rows = outflow_by_year[outflow_by_year["zip"] == zcta].sort_values("year")
        if in_rows.empty and out_rows.empty:
            continue

        in_latest = in_rows[in_rows["year"] == LATEST_YEAR]
        out_latest = out_rows[out_rows["year"] == LATEST_YEAR]

        in_partners = _split_top(inflow_by_partner_year, "h_zip", zcta)
        out_partners = _split_top(outflow_by_partner_year, "w_zip", zcta)

        # Within-ZIP series (people who live AND work in this anchor).
        # Latest carries the full OdLatest shape (totalJobs + age/wage/naics3
        # buckets) so the within-ZIP card can re-aggregate under a segment
        # filter. Trend mirrors OD_TREND_DIMS so each per-bucket sparkline can
        # recompute from the same per-year per-bucket series.
        self_rows = self_by_year[self_by_year["zip"] == zcta].sort_values("year")
        self_latest = self_rows[self_rows["year"] == LATEST_YEAR]
        within_latest = (
            _od_latest_block(self_latest.iloc[0])
            if not self_latest.empty else None
        )
        within_trend = {dim: _trend_series(self_rows, dim) for dim in OD_TREND_DIMS}

        entries.append({
            "zip": zcta,
            "place": zip_to_place.get(zcta, ""),
            "latestYear": LATEST_YEAR,
            "inflow": {
                "latest": _od_latest_block(in_latest.iloc[0]) if not in_latest.empty else None,
                "trend": {dim: _trend_series(in_rows, dim) for dim in OD_TREND_DIMS},
            },
            "outflow": {
                "latest": _od_latest_block(out_latest.iloc[0]) if not out_latest.empty else None,
                "trend": {dim: _trend_series(out_rows, dim) for dim in OD_TREND_DIMS},
            },
            "withinZip": {
                "latest": within_latest,
                "trend": within_trend,
            },
            "topPartners": {
                "inflow": in_partners,
                "outflow": out_partners,
            },
        })

    # Aggregate roll-up — split by direction. The OD dataset is a ring of pairs
    # touching the 11 anchors (either endpoint), so it is NOT a closed universe:
    # naively summing every pair would double-count nothing but would conflate
    # inflow-to-anchors with outflow-from-anchors-to-non-anchors. Instead, emit
    # inflow (w_zip in anchors) and outflow (h_zip in anchors) separately so the
    # aggregate matches the per-zip view's inflow/outflow shape.
    agg_inflow_year = (
        inflow_by_year[inflow_by_year["zip"].isin(anchor_zips)]
        .groupby("year", as_index=False)[list(OD_COLS.values())]
        .sum()
        .sort_values("year")
        .reset_index(drop=True)
    )
    agg_outflow_year = (
        outflow_by_year[outflow_by_year["zip"].isin(anchor_zips)]
        .groupby("year", as_index=False)[list(OD_COLS.values())]
        .sum()
        .sort_values("year")
        .reset_index(drop=True)
    )
    agg_inflow_latest = agg_inflow_year[agg_inflow_year["year"] == LATEST_YEAR]
    agg_outflow_latest = agg_outflow_year[agg_outflow_year["year"] == LATEST_YEAR]

    # Within-ZIP aggregate — sum self-pairs across the anchor set per year,
    # carrying every OD value column so the aggregate within-ZIP card can
    # also re-aggregate under a segment filter.
    agg_self_year = (
        self_by_year[self_by_year["zip"].isin(anchor_zips)]
        .groupby("year", as_index=False)[list(OD_COLS.values())]
        .sum()
        .sort_values("year")
        .reset_index(drop=True)
    )
    agg_self_latest = agg_self_year[agg_self_year["year"] == LATEST_YEAR]
    agg_within_latest = (
        _od_latest_block(agg_self_latest.iloc[0])
        if not agg_self_latest.empty else None
    )
    agg_within_trend = {dim: _trend_series(agg_self_year, dim) for dim in OD_TREND_DIMS}

    aggregate = {
        "latestYear": LATEST_YEAR,
        "inflow": {
            "latest": _od_latest_block(agg_inflow_latest.iloc[0]) if not agg_inflow_latest.empty else None,
            "trend": {dim: _trend_series(agg_inflow_year, dim) for dim in OD_TREND_DIMS},
        },
        "outflow": {
            "latest": _od_latest_block(agg_outflow_latest.iloc[0]) if not agg_outflow_latest.empty else None,
            "trend": {dim: _trend_series(agg_outflow_year, dim) for dim in OD_TREND_DIMS},
        },
        "withinZip": {
            "latest": agg_within_latest,
            "trend": agg_within_trend,
        },
    }
    return entries, aggregate


# ---------------------------------------------------------------------------
# CLI smoke test
# ---------------------------------------------------------------------------
if __name__ == "__main__":  # pragma: no cover
    print("loading RAC…", file=sys.stderr)
    rac = aggregate_rac_or_wac(load_rac_all_years())
    print(f"  → {len(rac)} (zcta,year) rows", file=sys.stderr)

    print("loading WAC…", file=sys.stderr)
    wac = aggregate_rac_or_wac(load_wac_all_years())
    print(f"  → {len(wac)} (zcta,year) rows", file=sys.stderr)

    print("loading OD…", file=sys.stderr)
    od = aggregate_od_to_zip_pairs(load_od_all_years())
    print(f"  → {len(od)} (h_zip,w_zip,year) rows", file=sys.stderr)
