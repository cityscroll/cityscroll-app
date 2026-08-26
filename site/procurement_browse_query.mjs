/**
 * Bounded, filterable projection for the non-default Contracts Browse path.
 *
 * The query rows contain every field used by filterMoneySnapshot and the
 * visible list card, but omit notice evidence and source lineage. Those
 * heavier fields remain in deterministic full-row shards and are hydrated
 * after the first page paints.
 */

import { filterMoneySnapshot, moneyMethodFacet } from "./resident_snapshot_queries.mjs";
import { mergeCanonicalProcurementBrowseRows } from "./contract_search_bridge.mjs";

export const PROCUREMENT_BROWSE_QUERY_SCHEMA = "cityscroll.procurement_browse_query.v1";
export const PROCUREMENT_BROWSE_QUERY_SHARD_SCHEMA = "cityscroll.procurement_browse_query_shard.v1";
export const DEFAULT_BROWSE_QUERY_PAGE_SIZE = 40;
export const DEFAULT_BROWSE_QUERY_SHARD_ROWS = 512;

// Keep this list aligned with filterMoneySnapshot and moneyRowHTML. A field
// added to either consumer must be added here and covered by the equivalence
// test below; otherwise the bounded projection must fail closed.
export const PROCUREMENT_BROWSE_QUERY_FIELDS = Object.freeze([
  "procurement_id", "canonical_href", "procurement_stages", "primary_stage",
  "request_id", "start_date", "due_date", "agency_name", "short_title", "pin",
  "contract_id", "contract_amount", "vendor_name", "selection_method_description",
  "category_description", "type_of_notice_description", "source_system",
  "method_family", "procurement_category", "coverage_state", "additional_description_1",
  "project_id", "project_name",
]);

function queryRowFromFullRow(row = {}) {
  return Object.fromEntries(PROCUREMENT_BROWSE_QUERY_FIELDS
    .filter((field) => Object.hasOwn(row, field))
    .map((field) => [field, row[field]]));
}

function shardPath(index) {
  return `procurement_browse_rows/shard-${String(index).padStart(3, "0")}.json`;
}

function serializedBytes(value) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
}

function queryOptions(options = {}) {
  return {
    mode: options.mode || "award",
    agency: options.agency || "",
    keyword: options.keyword || "",
    method: options.method || "",
    closingWeek: Boolean(options.closingWeek),
    minAmount: options.minAmount ?? null,
    maxAmount: options.maxAmount ?? null,
    category: options.category || "",
    months: options.months ?? null,
    excludeSpecial: Boolean(options.excludeSpecial),
    entityRefs: Array.isArray(options.entityRefs) ? options.entityRefs : [],
    contractObjectRef: options.contractObjectRef || "",
    sort: options.sort || "newest",
    today: options.today,
    weekEnd: options.weekEnd,
    monthEnd: options.monthEnd,
    limit: Number.isInteger(options.limit) ? options.limit : DEFAULT_BROWSE_QUERY_PAGE_SIZE,
  };
}

/**
 * Query the bounded rows using the same resident filter and sort contract as
 * the legacy full projection. The returned `total` is deliberately exposed so
 * reconciliation can prove more than the visible first page.
 */
export function queryProcurementBrowseRows(rows, options = {}) {
  const candidateRows = options.baseRows
    ? mergeCanonicalProcurementBrowseRows(options.baseRows, rows)
    : rows;
  const selected = filterMoneySnapshot(candidateRows, { ...queryOptions(options), limit: Number.MAX_SAFE_INTEGER });
  return {
    rows: selected.slice(0, queryOptions(options).limit),
    total: selected.length,
    facets: { method: moneyMethodFacet(selected, Number.MAX_SAFE_INTEGER) },
    ordered_ids: selected.map((row) => row?.procurement_id || row?.request_id).filter(Boolean),
  };
}

/** Build the manifest and full-row shards from one Browse projection. */
export function buildProcurementBrowseQueryArtifacts(
  browse,
  { shardRows = DEFAULT_BROWSE_QUERY_SHARD_ROWS } = {},
) {
  const fullRows = Array.isArray(browse?.rows) ? browse.rows : [];
  const queryRows = fullRows.map(queryRowFromFullRow);
  const shards = [];
  const rowShardById = {};
  for (let offset = 0; offset < fullRows.length; offset += shardRows) {
    const index = shards.length;
    const rows = fullRows.slice(offset, offset + shardRows);
    const shard = {
      schema: PROCUREMENT_BROWSE_QUERY_SHARD_SCHEMA,
      version: 1,
      source_fingerprint: browse?.source_model_fingerprint
        || browse?.coherence_receipt?.source_model_fingerprint
        || null,
      shard_id: String(index).padStart(3, "0"),
      rows,
    };
    shards.push(shard);
    for (const row of rows) {
      if (row?.procurement_id) rowShardById[row.procurement_id] = shardPath(index);
    }
  }
  const manifest = {
    schema: PROCUREMENT_BROWSE_QUERY_SCHEMA,
    version: 1,
    source_model_schema: browse?.source_model_schema || null,
    generated_at: browse?.generated_at || null,
    source_model_fingerprint: browse?.source_model_fingerprint
      || browse?.coherence_receipt?.source_model_fingerprint
      || null,
    row_count: fullRows.length,
    query_fields: PROCUREMENT_BROWSE_QUERY_FIELDS,
    query_rows: queryRows,
    shards: shards.map((shard, index) => ({
      path: shardPath(index),
      bytes: serializedBytes(shard),
      row_count: shard.rows.length,
    })),
    row_shard_by_id: rowShardById,
  };
  return { manifest, shards };
}

export function validateProcurementBrowseQueryManifest(manifest) {
  return Boolean(
    manifest?.schema === PROCUREMENT_BROWSE_QUERY_SCHEMA
    && manifest?.version === 1
    && Array.isArray(manifest.query_rows)
    && Number.isInteger(manifest.row_count)
    && manifest.query_rows.length === manifest.row_count
    && Array.isArray(manifest.shards)
    && manifest.source_model_fingerprint,
  );
}

export function validateProcurementBrowseQueryShard(manifest, shard, descriptor = null) {
  return Boolean(
    shard?.schema === PROCUREMENT_BROWSE_QUERY_SHARD_SCHEMA
    && shard?.version === 1
    && shard?.source_fingerprint === manifest?.source_model_fingerprint
    && Array.isArray(shard?.rows)
    && (!descriptor || shard.rows.length === descriptor.row_count),
  );
}

export function queryProcurementBrowseManifest(manifest, options = {}) {
  if (!validateProcurementBrowseQueryManifest(manifest)) {
    throw new Error("invalid procurement browse query manifest");
  }
  const result = queryProcurementBrowseRows(manifest.query_rows, options);
  const facetResult = queryProcurementBrowseRows(manifest.query_rows, {
    ...options,
    method: "",
  });
  return {
    ...result,
    facets: facetResult.facets,
    total: result.total,
  };
}

export function combineProcurementBrowseQueryShards(manifest, shards = []) {
  if (!validateProcurementBrowseQueryManifest(manifest)) {
    throw new Error("invalid procurement browse query manifest");
  }
  if (!Array.isArray(shards) || shards.length !== manifest.shards.length) {
    throw new Error("procurement shard count mismatch");
  }
  for (const [index, shard] of shards.entries()) {
    if (!validateProcurementBrowseQueryShard(manifest, shard, manifest.shards[index])) {
      throw new Error("procurement shard freshness mismatch");
    }
  }
  const rows = shards.flatMap((shard) => shard.rows);
  const byId = new Map(rows.map((row) => [row?.procurement_id, row]).filter(([id]) => id));
  if (rows.length !== manifest.row_count || byId.size !== manifest.row_count) {
    throw new Error("procurement shard row count mismatch");
  }
  const hydrated = manifest.query_rows.map((row) => byId.get(row?.procurement_id));
  if (hydrated.some((row) => !row)) throw new Error("procurement shard identity mismatch");
  return hydrated;
}

/**
 * Fetch a bounded first page and expose a post-paint full hydration promise.
 * Any bounded-artifact failure falls back to the legacy full projection before
 * resolving, so callers never receive a silently empty or truncated result.
 */
export async function loadProcurementBrowseQuery({
  fetchImpl = globalThis.fetch,
  manifestUrl = "data/procurement_browse_query.json",
  legacyUrl = "data/procurement_browse_rows.json",
  options = {},
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");
  try {
    const response = await fetchImpl(manifestUrl);
    if (!response?.ok) throw new Error("bounded procurement artifact unavailable");
    const manifest = await response.json();
    const firstPage = queryProcurementBrowseManifest(manifest, options);
    let hydrationPromise = null;
    const hydrate = () => {
      if (!hydrationPromise) {
        hydrationPromise = (async () => {
          try {
            const shardResponses = await Promise.all(manifest.shards.map((descriptor) => fetchImpl(`data/${descriptor.path}`)));
            if (shardResponses.some((response) => !response?.ok)) throw new Error("procurement shard unavailable");
            const shards = await Promise.all(shardResponses.map((response) => response.json()));
            const rows = combineProcurementBrowseQueryShards(manifest, shards);
            return { rows, source: "bounded-shards", manifest };
          } catch (_error) {
            return loadLegacy();
          }
        })();
      }
      return hydrationPromise;
    };
    return { ...firstPage, source: "bounded-query", manifest, hydrate };
  } catch (_error) {
    return loadLegacy();
  }

  async function loadLegacy() {
    const response = await fetchImpl(legacyUrl);
    if (!response?.ok) throw new Error("procurement browse data unavailable");
    const payload = await response.json();
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!rows.length && Number(payload?.row_count || 0) > 0) throw new Error("empty procurement fallback");
    return { rows, total: rows.length, facets: { method: moneyMethodFacet(rows, Number.MAX_SAFE_INTEGER) }, source: "legacy-full", hydrate: () => Promise.resolve({ rows, source: "legacy-full" }) };
  }
}
