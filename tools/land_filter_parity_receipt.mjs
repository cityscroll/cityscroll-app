#!/usr/bin/env node
/**
 * The Land filter parity receipt (lm-08).
 *
 * One canonical query, two renderings. For each fixture scope this records the route, the
 * normalized filter state, the query that state produces, the canonical result ids in order, the
 * ids each rendering produced, the mapped/unmapped partition and its arithmetic, the semantic
 * scope, and the watch a resident would save. Everything is derived from committed fixtures and
 * pure modules, so the same tree always writes the same bytes.
 *
 *   node tools/land_filter_parity_receipt.mjs           # write docs/evidence/land-filter-parity.json
 *   node tools/land_filter_parity_receipt.mjs --check    # fail if the committed receipt has drifted
 *
 * `--check` is what makes the receipt evidence rather than decoration: a renderer that starts
 * filtering on its own, drops an unmapped row, applies a second limit, or reorders the population
 * changes these bytes, and the check fails naming the fixture.
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  LAND_FILTER_DIMENSIONS,
  LAND_FILTER_PARITY_SCHEMA,
  LAND_HEARING_ROW_SELECTORS,
  buildLandParityReceipt,
  landCanonicalIds,
  landFilterStateFromRouteParams,
  landSnapshotQueryFromState,
} from "../site/land_filter_parity.mjs";
import { buildLandMapModel } from "../site/land_map_model.mjs";
import { filterLandSnapshot } from "../site/resident_snapshot_queries.mjs";
import { scopeFromRouteHash, watchFromScope } from "../site/scope_v0.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = path.join(ROOT, "docs", "evidence", "land-filter-parity.json");

const read = (...parts) => JSON.parse(readFileSync(path.join(ROOT, ...parts), "utf8"));
const landDefault = read("site", "data", "land_default_ulurp.json");
const points = read("site", "data", "land_project_map_points.json");
const hearings = read("site", "data", "land_upcoming_hearings.json");

const ACTION_ROWS = Array.isArray(hearings.hearings) ? hearings.hearings : [];
/* A fixed date, because a receipt that moves with the wall clock is not a receipt. */
const TODAY = "2026-08-31";

/**
 * The fixture matrix. Every entry is a route a resident could actually be on, chosen to cover a
 * population shape that a count-only test would pass: a single mapped result, a single result
 * with no published location, an entirely unmapped scope, an empty one, a mixed one, and the
 * limit boundaries around a known population.
 */
const FIXTURES = [
  ["default-list", "#land?status=all&stage=any", null,
    "The whole filtered population in List: the 40/33/7 arithmetic."],
  ["default-map", "#land?status=all&stage=any&view=map", null,
    "The same population in Map. Only `view` differs, so nothing else may."],
  ["combined-list", "#land?status=all&stage=city_council&boro=Queens&family=rezoning", null,
    "A combined scope in List: stage, borough, and family together."],
  ["combined-map", "#land?status=all&stage=city_council&boro=Queens&family=rezoning&view=map", null,
    "The same combined scope in Map."],
  ["regulatory-effect-map", `#land?status=all&stage=any&view=map&facet=${encodeURIComponent(JSON.stringify({ regulatoryEffect: "upzone" }))}`, null,
    "The dimension with no route key of its own, carried in the typed facet blob."],
  ["mapped-only", "#land?status=all&stage=any&q=Westshore&view=map", null,
    "A scope whose only result is on the map."],
  ["unmapped-only", "#land?status=all&stage=any&cd=Q07&view=map", null,
    "A scope whose only result has no published location. It stays a result."],
  ["all-unmapped", "#land?status=all&stage=completed&view=map", null,
    "Every result lacks a point. The map has no markers and the search is not empty."],
  ["mixed", "#land?status=all&stage=any&cd=M05&view=map", null,
    "Both sides of the partition are populated."],
  ["empty", "#land?status=all&stage=any&q=zzzznotathing&view=map", null,
    "No matching rows. Both renderings are empty and neither invents one."],
  ["limit-below", "#land?status=all&stage=any&view=map", 39,
    "Limit below the matching population: the canonical order is truncated, not re-picked."],
  ["limit-equal", "#land?status=all&stage=any&view=map", 40,
    "Limit equal to the matching population."],
  ["limit-above", "#land?status=all&stage=any&view=map", 45,
    "Limit above the matching population: no padding, no change."],
  ["legacy-status", "#land?status=public:In Public Review", null,
    "A legacy status spelling still adopts the stage it always did."],
  ["invalid-values", "#land?status=all&stage=sideways&family=not_a_family&boro=Atlantis&council=77", null,
    "Unrecognized values fall back to their defaults instead of narrowing to nothing."],
];

function receiptFor([id, route, limit, proves]) {
  const state = landFilterStateFromRouteParams(route);
  const query = landSnapshotQueryFromState(state, { actionRows: ACTION_ROWS, today: TODAY, limit });
  const rows = filterLandSnapshot(landDefault.projects, query);
  const model = buildLandMapModel({ rows, pointLookup: points, filters: query });
  const receipt = buildLandParityReceipt({
    route,
    state,
    query,
    rows,
    listIds: landCanonicalIds(rows),
    model,
    view: state.view,
    watch: watchFromScope(scopeFromRouteHash(route), { lens: "land" }),
  });
  // The query's evidence inputs are large and are not part of what parity claims.
  const { actionRows: _actionRows, ...recordedQuery } = receipt.query;
  return {
    id,
    proves,
    route: receipt.route,
    view: receipt.view,
    state: receipt.state,
    query: { ...recordedQuery, action_rows_count: ACTION_ROWS.length },
    semantic_scope: receipt.semantic_scope,
    watch_scope: receipt.watch_scope,
    canonical_ids: receipt.canonical_ids,
    list_ids: receipt.list_ids,
    marker_ids: receipt.marker_ids,
    unmapped_ids: receipt.unmapped_ids,
    counts: receipt.counts,
    partition: {
      disjoint: receipt.marker_ids.every((markerId) => !receipt.unmapped_ids.includes(markerId)),
      union_equals_canonical:
        [...receipt.marker_ids, ...receipt.unmapped_ids].sort().join(",") === [...receipt.canonical_ids].sort().join(","),
      counts_sum: receipt.counts.mapped + receipt.counts.unmapped === receipt.counts.total,
    },
    violations: receipt.violations,
    parity: receipt.parity,
  };
}

export function buildParityEvidence() {
  const fixtures = FIXTURES.map(receiptFor);
  for (const fixture of fixtures) {
    assert.deepEqual(fixture.violations, [], `${fixture.id}: ${fixture.violations.join(", ")}`);
  }
  return {
    schema: "cityscroll.land-filter-parity-receipt.v1",
    card: "cityscroll-land-map-view/lm-08-filter-parity",
    model_schema: LAND_FILTER_PARITY_SCHEMA,
    determinism: {
      today: TODAY,
      sources: [
        "site/data/land_default_ulurp.json",
        "site/data/land_project_map_points.json",
        "site/data/land_upcoming_hearings.json",
      ],
      note: "No clock, network, or randomness. The same tree writes the same bytes.",
    },
    baseline: { total: 40, mapped: 33, unmapped: 7 },
    inventory: {
      query_dimensions: LAND_FILTER_DIMENSIONS.map((dimension) => ({
        id: dimension.id,
        query_key: dimension.queryKey,
        route_key: dimension.routeKey,
        facet_key: dimension.facetKey ?? null,
        default: dimension.defaultValue,
        reaches_watch_scope: dimension.reachesWatchScope,
        note: dimension.note,
      })),
      hearing_row_selectors: LAND_HEARING_ROW_SELECTORS.map((selector) => ({
        id: selector.id,
        route_key: selector.routeKey,
        note: selector.note,
      })),
      recorded_discrepancies: [
        {
          id: "attendance-legacy-status-spelling",
          detail:
            "scope v0 serializes `attendance` only beside the modern `future=hearing` spelling; the "
            + "legacy inbound `status=hearings` spelling drops it. The project population is identical "
            + "either way, so this is a selector discrepancy, not a parity failure.",
        },
        {
          id: "closing-week-has-no-land-route-key",
          detail:
            "The Land surface has no `closing` route key, so a hearings closing-this-week selection "
            + "does not survive canonical serialization. Pre-existing; recorded rather than changed, "
            + "because altering it would change Land URL semantics beyond this card.",
        },
      ],
    },
    fixtures,
  };
}

function main() {
  const evidence = buildParityEvidence();
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.argv.includes("--check")) {
    let committed;
    try {
      committed = readFileSync(RECEIPT, "utf8");
    } catch (_error) {
      console.error(`missing parity receipt: ${path.relative(ROOT, RECEIPT)}`);
      process.exit(1);
    }
    if (committed !== serialized) {
      console.error(`land filter parity receipt is stale: ${path.relative(ROOT, RECEIPT)}`);
      console.error("regenerate with: node tools/land_filter_parity_receipt.mjs");
      process.exit(1);
    }
    console.log(`land filter parity receipt current (${evidence.fixtures.length} fixtures)`);
    return;
  }
  writeFileSync(RECEIPT, serialized);
  console.log(`wrote ${path.relative(ROOT, RECEIPT)} (${evidence.fixtures.length} fixtures)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
