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
export const PROCUREMENT_BROWSE_QUERY_ROWS_SCHEMA = "cityscroll.procurement_browse_query_rows.v1";
export const DEFAULT_BROWSE_QUERY_PAGE_SIZE = 40;
export const DEFAULT_BROWSE_QUERY_SHARD_ROWS = 512;
export const PROCUREMENT_BROWSE_QUERY_ROWS_PATH = "procurement_browse_query_rows.json";
export const PROCUREMENT_BROWSE_FIRST_PAGE_MODES = Object.freeze(["award", "archive"]);

// Keep this list aligned with filterMoneySnapshot and moneyRowHTML. A field
// added to either consumer must be added here and covered by the equivalence
// test below; otherwise the bounded projection must fail closed.
export const PROCUREMENT_BROWSE_QUERY_FIELDS = Object.freeze([
  "procurement_id", "canonical_href", "procurement_stages", "primary_stage", "process_states",
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
    connectionRelation: options.connectionRelation || "",
    processStates: Array.isArray(options.processStates)
      ? options.processStates
      : options.processStates ? [options.processStates] : [],
    contractObjectRef: options.contractObjectRef || "",
    sort: options.sort || "newest",
    today: options.today,
    weekEnd: options.weekEnd,
    monthEnd: options.monthEnd,
    limit: Number.isInteger(options.limit) ? options.limit : DEFAULT_BROWSE_QUERY_PAGE_SIZE,
  };
}

function hasMergingBaseRows(options = {}) {
  return Array.isArray(options.baseRows) && options.baseRows.length > 0;
}

/** Default Recent Awards / Archive first pages can use the precomputed slice. */
export function procurementBrowseFirstPageKey(options = {}) {
  if (hasMergingBaseRows(options)) return null;
  const opts = queryOptions(options);
  if (!PROCUREMENT_BROWSE_FIRST_PAGE_MODES.includes(opts.mode)) return null;
  if (opts.agency || opts.keyword || opts.method || opts.closingWeek) return null;
  if (opts.minAmount != null || opts.maxAmount != null || opts.category) return null;
  if (opts.months != null || opts.excludeSpecial) return null;
  if (opts.entityRefs.length || opts.contractObjectRef) return null;
  if (opts.processStates.length) return null;
  if (opts.sort !== "newest") return null;
  if (opts.limit !== DEFAULT_BROWSE_QUERY_PAGE_SIZE) return null;
  return opts.mode;
}

function queryRowsFromManifest(manifest) {
  if (Array.isArray(manifest?.query_rows) && manifest.query_rows.length === manifest.row_count) {
    return manifest.query_rows;
  }
  return null;
}

/**
 * Query the bounded rows using the same resident filter and sort contract as
 * the full row projection. The returned `total` is deliberately exposed so
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
  }
  const fingerprint = browse?.source_model_fingerprint
    || browse?.coherence_receipt?.source_model_fingerprint
    || null;
  const firstPages = Object.fromEntries(PROCUREMENT_BROWSE_FIRST_PAGE_MODES.map((mode) => {
    const page = queryProcurementBrowseRows(queryRows, { mode, sort: "newest" });
    return [mode, {
      rows: page.rows,
      total: page.total,
      facets: page.facets,
    }];
  }));
  const queryRowsArtifact = {
    schema: PROCUREMENT_BROWSE_QUERY_ROWS_SCHEMA,
    version: 1,
    source_fingerprint: fingerprint,
    row_count: queryRows.length,
    query_rows: queryRows,
  };
  const manifest = {
    schema: PROCUREMENT_BROWSE_QUERY_SCHEMA,
    version: 2,
    source_model_schema: browse?.source_model_schema || null,
    generated_at: browse?.generated_at || null,
    source_model_fingerprint: fingerprint,
    row_count: fullRows.length,
    query_fields: PROCUREMENT_BROWSE_QUERY_FIELDS,
    query_rows_path: PROCUREMENT_BROWSE_QUERY_ROWS_PATH,
    query_rows_bytes: serializedBytes(queryRowsArtifact),
    first_pages: firstPages,
    shards: shards.map((shard, index) => ({
      path: shardPath(index),
      bytes: serializedBytes(shard),
      row_count: shard.rows.length,
    })),
  };
  return { manifest, shards, queryRowsArtifact };
}

export function validateProcurementBrowseQueryRows(manifest, artifact) {
  return Boolean(
    artifact?.schema === PROCUREMENT_BROWSE_QUERY_ROWS_SCHEMA
    && artifact?.version === 1
    && artifact?.source_fingerprint === manifest?.source_model_fingerprint
    && Array.isArray(artifact?.query_rows)
    && artifact.query_rows.length === manifest?.row_count,
  );
}

export function validateProcurementBrowseQueryManifest(manifest) {
  if (
    manifest?.schema !== PROCUREMENT_BROWSE_QUERY_SCHEMA
    || ![1, 2].includes(manifest?.version)
    || !Number.isInteger(manifest.row_count)
    || !Array.isArray(manifest.shards)
    || !manifest.source_model_fingerprint
  ) return false;
  const inline = queryRowsFromManifest(manifest);
  if (manifest.version === 1) return Boolean(inline);
  return Boolean(
    typeof manifest.query_rows_path === "string"
    && manifest.first_pages
    && PROCUREMENT_BROWSE_FIRST_PAGE_MODES.every((mode) => Array.isArray(manifest.first_pages?.[mode]?.rows)),
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

export function queryProcurementBrowseManifest(manifest, options = {}, queryRows = null) {
  if (!validateProcurementBrowseQueryManifest(manifest)) {
    throw new Error("invalid procurement browse query manifest");
  }
  const rows = queryRows || queryRowsFromManifest(manifest);
  if (!Array.isArray(rows) || rows.length !== manifest.row_count) {
    const firstPageKey = procurementBrowseFirstPageKey(options);
    const precomputed = firstPageKey ? manifest.first_pages?.[firstPageKey] : null;
    if (precomputed && Array.isArray(precomputed.rows)) {
      return {
        rows: precomputed.rows,
        total: precomputed.total,
        facets: precomputed.facets,
        ordered_ids: precomputed.rows.map((row) => row?.procurement_id || row?.request_id).filter(Boolean),
        source: "first-page",
      };
    }
    throw new Error("procurement query rows unavailable");
  }
  const result = queryProcurementBrowseRows(rows, options);
  const facetResult = queryProcurementBrowseRows(rows, {
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
  return rows;
}

/**
 * Fetch a bounded first page and expose a post-paint full hydration promise.
 *
 * The bounded manifest, its query rows and the full-row shards are the whole
 * read path: they are written together by one build boundary, and the
 * monolithic projection they replaced is no longer published. A hydration that
 * cannot assemble the complete row set therefore reports itself unavailable
 * rather than resolving rows, so a caller keeps the bounded page it already
 * painted instead of merging a truncated or stale superset over it.
 */
function dataUrl(path) {
  const value = String(path || "");
  return value.startsWith("data/") ? value : `data/${value}`;
}

export async function loadProcurementBrowseQuery({
  fetchImpl = globalThis.fetch,
  manifestUrl = "data/procurement_browse_query.json",
  options = {},
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");
  try {
    const response = await fetchImpl(manifestUrl);
    if (!response?.ok) throw new Error("bounded procurement artifact unavailable");
    const manifest = await response.json();
    let queryRows = queryRowsFromManifest(manifest);
    const firstPageKey = procurementBrowseFirstPageKey(options);
    if (!firstPageKey || !manifest.first_pages?.[firstPageKey]) {
      if (!queryRows) {
        const rowsResponse = await fetchImpl(dataUrl(manifest.query_rows_path || PROCUREMENT_BROWSE_QUERY_ROWS_PATH));
        if (!rowsResponse?.ok) throw new Error("procurement query rows unavailable");
        const artifact = await rowsResponse.json();
        if (!validateProcurementBrowseQueryRows(manifest, artifact)) {
          throw new Error("procurement query rows freshness mismatch");
        }
        queryRows = artifact.query_rows;
      }
    }
    const firstPage = queryProcurementBrowseManifest(manifest, options, queryRows);
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
          } catch (error) {
            return { rows: null, source: "hydration-unavailable", manifest, reason: error?.message || String(error) };
          }
        })();
      }
      return hydrationPromise;
    };
    return {
      ...firstPage,
      source: firstPage.source === "first-page" ? "bounded-first-page" : "bounded-query",
      manifest,
      hydrate,
    };
  } catch (error) {
    throw new Error(`procurement browse data unavailable: ${error?.message || error}`);
  }
}
