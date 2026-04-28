# Valley Commute Flows · 2023 LEHD

An interactive dark-mode map of where workers in the Roaring Fork Valley and
Western Garfield County commute from. Eleven workplace ZIPs anchor the picture
(De Beque to Aspen, ~45,800 workers total); each commute flow is routed onto a
**hand-authored canonical corridor graph** — a small, named network of road
segments (Hwy 82, I-70, the Snowmass spur, and east/west gateway approaches) —
and the residual is surfaced as an off-map "All Other Locations" node so the
cross-zip / non-spatial split is never hidden.

Hovering any corridor surfaces the destinations (outbound mode) or origins
(inbound mode) whose flows traverse it, with absolute worker counts and
per-ZIP percentages of that corridor's total visible workers. The corridor
label appears in long form (e.g., "Hwy 82 — Carbondale to Glenwood") so the
geography is unambiguous.

Source: U.S. Census Bureau, **LEHD OnTheMap — Zip Code Work Area Analysis**,
All Jobs, 2023 vintage.

## Stack

- Vite + React 18 + TypeScript
- MapLibre GL JS (CARTO Dark Matter base + Mapzen Terrain Tiles hillshade
  via AWS Open Data, no API key)
- D3-style SVG overlay reprojected on every map move
- Tailwind CSS v4
- Python data-build script (openpyxl + TIGER 2024 ZCTA Gazetteer)

## Run locally

```bash
npm install
npm run dev
# → http://localhost:5173
```

Production build:

```bash
npm run build
npm run preview
```

## Configuration

The build is otherwise envless. One optional flag controls the hillshade
relief layer rendered on top of the CARTO Dark Matter base. The flag exists
so the basemap can be toggled to its flat form for side-by-side review (Lee
Barger's review cycle, comparison screenshots, etc.) without a code change.

| Variable | Default | Effect |
|----------|---------|--------|
| `VITE_HILLSHADE_ENABLED` | `true` | When `true` (or unset), MapLibre fetches free, no-key terrarium-encoded DEM tiles from the **Mapzen Terrain Tiles** dataset on AWS Open Data (`s3.amazonaws.com/elevation-tiles-prod/terrarium/`) and renders a dark hillshade beneath the labels and overlays. Set to `false` to disable the layer entirely — no terrain tile requests are made. |

Copy `.env.example` to `.env.local` to override.

## The corridor graph

The map's edge geometry is **not** derived from runtime routing. It is
hand-authored in `public/data/corridors.geojson` as a small graph of named
road segments, then smoothed at build time and consumed by the frontend as
the single source of truth for what gets drawn.

The graph contains:

- **14 nodes** — 10 anchor towns (ASP, SMV, BAS, CARB, GWS, NCT, SLT, RFL,
  PCT, DBQ), 2 junctions (J_BC where the Snowmass spur leaves Hwy 82,
  J_OS where the El Jebel/Old Snowmass cluster sits), and 2 synthetic
  gateways (GW_E / GW_W) representing east-of-state and west-of-state
  external origins/destinations.
- **13 corridors** — each a named edge between two nodes with a `roadName`,
  a long-form label, and an ordered list of `controlPoints` shaping the
  visible polyline. Two corridors (`I70_RFL_PCT`, `C82_BAS_CARB`) carry
  extra control points to round visible bends; this affects rendering only
  and does not split the corridor for analysis.

ZCTA-to-node bindings are declared per-node (e.g., `81601 → GWS`,
`81654 → J_OS`). At build time every flow's origin and destination ZIP is
looked up against this binding table; out-of-state ZIPs are reclassified to
the appropriate gateway, and ZIPs that map nowhere fall through to
`ALL_OTHER` and surface as the off-map residual node.

### Authoring workflow

1. Edit `public/data/corridors.geojson`. Each node is a `Point` feature with
   `properties.kind = "node"`; each corridor is a `LineString` feature with
   `properties.kind = "corridor"`, `from`/`to` node IDs, a `roadName`, a
   long-form `label`, and a `controlPoints` array (lng/lat pairs). The
   first and last control points should align with the endpoint nodes —
   the build script anchors them defensively if they drift.
2. To round a visible bend, add control points to the corridor's
   `controlPoints` array. Do **not** introduce a new node mid-corridor
   unless you want to split the segment for analytical aggregation —
   adding a node creates a new corridor edge and changes which flows roll
   up where.
3. To re-bind a ZIP to a different node, edit the source node's
   `properties.zips` list. Each ZIP must appear on at most one node.
4. Re-run the build script (below). It will validate the schema, anchor
   endpoints, smooth every corridor, recompute lengths, route every flow,
   and emit `corridors.json` for the frontend.

### Geometry pass

Each corridor's geometry is fetched at build time from the public
**OSRM** demo server (`router.project-osrm.org`) using the corridor's
from-node and to-node coordinates. OSRM's driving profile picks the
fastest route between the endpoints, which on every corridor in this
graph is the named highway (Hwy 82, I-70, Brush Creek Rd) — the valley
has no parallel-road ambiguity at the scale these corridors span.

Responses are cached in `scripts/.osrm-corridor-cache.json` (gitignored)
keyed by endpoint coordinates. A clean first-run hits the network 13×;
subsequent builds against unchanged corridors are fully offline. If
OSRM fails or returns a non-`Ok` response after 3 retries, the build
hard-aborts — corridors must follow real road geometry, no silent
fallback to straight lines.

The endpoints of the returned polyline are anchored to the node
coordinates exactly (OSRM may snap a few meters off), and every vertex
is rounded to 6 decimals (~10 cm). Haversine length is recomputed from
the returned polyline.

### Routing

Every flow is routed across the corridor graph using **Dijkstra's
algorithm** on the undirected graph, weighted by corridor length
in meters (haversine over the OSRM-returned polyline). Tie-breaking is
deterministic: shortest total length, then fewest hops, then alphabetical
corridor-ID sequence. The graph is undirected — mode-exclusivity
(inbound XOR outbound) is enforced at the flow level by which dataset is
loaded, not at the corridor level.

There is **no runtime routing dependency**. The frontend consumes the
baked `corridors.json` and never calls OSRM. OSRM is used at build time
only.

## Refreshing the data

Source spreadsheet lives at `../LEHD - Zip Code Jobs Data.xlsx`. Re-run the
build script to regenerate the static JSON bundle:

```bash
python3 scripts/build-data.py
```

The script writes:

- `public/data/flows-inbound.json` — workplace-anchored flows, each with a
  `corridorPath: [CorridorId, …]` list
- `public/data/flows-outbound.json` — residence-anchored flows, with
  `corridorPath`
- `public/data/zips.json` — ZIP centroid + role metadata
- `public/data/corridors.json` — the smoothed, length-stamped corridor
  graph the frontend renders

The script:

1. Reads the LEHD export sheets (header row 6) for the inbound and
   outbound commute tables and normalizes ZIPs.
2. Joins ZIPs to TIGER 2024 ZCTA centroids (auto-fetched on first run from
   the Census Gazetteer) and overrides the 11 anchor centroids with
   city-center coordinates.
3. Adds an `ALL_OTHER` synthetic ZIP representing the residual workforce
   share not in the top-25 home/work ZIPs.
4. Loads `public/data/corridors.geojson`, validates the schema, and for
   every corridor calls OSRM with the from-node and to-node coordinates
   to fetch the real road polyline (cached on disk for repeat builds).
   Endpoints are re-anchored to the node coords, vertices rounded to
   6 decimals, and haversine length recomputed.
5. Resolves each flow's endpoints to graph nodes via the ZIP-to-node
   binding (with 80xxx/81xxx fallbacks to the east/west gateways) and
   runs Dijkstra to attach a `corridorPath` to every routable flow.
   Self-flows and unmappable flows carry an empty path and aggregate to
   the off-map `ALL_OTHER` node instead.
6. Emits the four JSON outputs above and deletes any legacy
   `flows.json` / `segment-aggregation.json` from earlier builds. Output
   is byte-stable: two consecutive builds against the same inputs
   produce identical files.

Each flow row carries `source: "LEHD"` so future v2 layers (Placer.ai,
ACS journey-to-work, RFTA boardings) can be merged into the same JSON
shape.

## Project structure

```
public/
  data/
    corridors.geojson           ← hand-authored corridor graph (source of truth)
    corridors.json              ← smoothed graph emitted by the build
    flows-inbound.json          ← workplace-anchored rows + corridorPath
    flows-outbound.json         ← residence-anchored rows + corridorPath
    zips.json                   ← centroid + role metadata
  favicon.svg
scripts/
  build-data.py                 ← xlsx + corridors.geojson → JSON
  osrm.py                       ← OSRM corridor-routing helper (build-time)
  smoothing.py                  ← haversine length helper
src/
  components/
    MapCanvas.tsx        ← MapLibre + SVG overlay, per-corridor rendering
    DashboardTile.tsx    ← 380px frosted-glass left rail
    ModeToggle.tsx       ← Inbound (To) / Outbound (From) toggle
    ZipSelector.tsx      ← anchor chips + type-ahead search
    StatsAggregated.tsx  ← whole-region stats (active mode only)
    StatsForZip.tsx      ← top-10 origins/destinations for selected ZIP
    MethodologyFooter.tsx
  lib/
    arcMath.ts           ← log-scale stroke widths
    flowQueries.ts       ← pure selectors over the flow array
    corridors.ts         ← mode-aware corridor aggregation (hover tooltip)
    format.ts            ← number formatting
  types/flow.ts          ← FlowRow, ZipMeta, Mode, CorridorRecord, …
  App.tsx                ← top-level layout
  index.css              ← Tailwind + locked palette + .glass utility
  main.tsx
```

## Visual language

- Base palette: near-black `#08090c`, frosted panels at ~4% white
- Single accent: warm amber `#FFB454` for selection/hover only
- Corridors: monochrome smoothed polylines from the canonical graph.
  Stroke width log-scales with the aggregated worker count of every
  visible flow that traverses the corridor — heavy corridors render
  thicker. Selected/hovered corridors swap to amber and gain a Gaussian
  glow. Corridors carrying any `ALL_OTHER`-bound flow render dashed.
- Self-flows render as concentric rings on the node rather than a dot loop.
- Off-map "All Other Locations" anchored at canvas (0.82, 0.92) with
  dashed amber strokes when relevant.
- Labels carry a dark stroke halo (`paint-order: stroke fill`) so they
  stay legible over corridors, with side-flip dedup in the
  Carbondale–Basalt–Aspen cluster.

## Accessibility

- Anchor chips: `aria-pressed`, descriptive `aria-label`s
- SVG anchor centroids: `role="button"`, `tabindex="0"`, Enter/Space toggle
- Corridors: `role="img"` + per-corridor `aria-label` describing
  aggregated workers and contributing flow count for the active mode
- `prefers-reduced-motion: reduce` skips opacity/fill transitions

## Deploy

The `dist/` output is fully static and self-contained (no env vars, no API
keys). Drop it on any static host. A GitHub Pages workflow stub lives at
`.github/workflows/deploy.yml` and is intentionally **not pushed** in this
build pass — see comments in the file before enabling.

## License & attribution

- Map base: © OpenStreetMap contributors, © CARTO
- Hillshade: Mapzen Terrain Tiles (AWS Open Data; terrarium-encoded DEM
  blending JAXA AW3D30, USGS NED, ETOPO1, and others — see
  https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
- Centroids: U.S. Census Bureau, TIGER 2024 ZCTA Gazetteer
- Flows: U.S. Census Bureau, LEHD OnTheMap (2023)
- Code: internal — City of Glenwood Springs Economic Development
