/**
 * Retained ZAP project context selected by exact references.
 *
 * This module is deliberately pure: acquisition happens in build tooling and
 * resident readers consume only the resulting materialization or its shards.
 */

export const HISTORICAL_PROJECT_CONTEXT_SCHEMA = "cityscroll.historical_project_context.v1";
export const HISTORICAL_PROJECT_CONTEXT_SHARD_SIZE = 250;

const clean = (value) => String(value ?? "").trim();

export function exactProjectId(value) {
  const id = clean(value);
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,24}$/.test(id) ? id : null;
}

function idsFromRows(rows) {
  return (rows || []).map((row) => exactProjectId(row?.project_id)).filter(Boolean);
}

/** The selection basis is only the union of exact retained source references. */
export function referencedProjectIds({ currentRows = [], zapBblRows = [], mihRows = [] } = {}) {
  return [...new Set([
    ...idsFromRows(currentRows),
    ...idsFromRows(zapBblRows),
    ...idsFromRows(mihRows),
  ])].sort();
}

function retainProjectRow(row) {
  const id = exactProjectId(row?.project_id);
  if (!id) return null;
  return {
    ...row,
    project_id: id,
    // Publisher omissions are unknown, never a negative assertion.
    public_status: row.public_status == null || row.public_status === ""
      ? "unknown"
      : row.public_status,
  };
}

/**
 * Select publisher rows by exact project_id. Input ordering cannot affect the
 * result, and lookalike names/addresses are intentionally not consulted.
 */
export function selectHistoricalProjectContext({
  currentRows = [],
  zapBblRows = [],
  mihRows = [],
  publisherRows = [],
} = {}) {
  const selectedIds = referencedProjectIds({ currentRows, zapBblRows, mihRows });
  const publisherById = new Map();
  for (const raw of publisherRows) {
    const row = retainProjectRow(raw);
    if (row && !publisherById.has(row.project_id)) publisherById.set(row.project_id, row);
  }
  const currentIds = new Set(idsFromRows(currentRows));
  const retained = selectedIds.map((id) => publisherById.get(id)).filter(Boolean);
  const missing = selectedIds.filter((id) => !publisherById.has(id));
  const excluded = [...publisherById.keys()].filter((id) => !selectedIds.includes(id)).sort();
  return {
    schema_version: HISTORICAL_PROJECT_CONTEXT_SCHEMA,
    selected_ids: selectedIds,
    current_ids: [...currentIds].sort(),
    retained_rows: retained.sort((a, b) => a.project_id.localeCompare(b.project_id)),
    missing_ids: missing,
    excluded_ids: excluded,
    counts: {
      selected: selectedIds.length,
      retained: retained.length,
      missing: missing.length,
      excluded: excluded.length,
      current: selectedIds.filter((id) => currentIds.has(id)).length,
      historical: selectedIds.filter((id) => !currentIds.has(id) && publisherById.has(id)).length,
    },
  };
}

export function shardHistoricalProjectContext(rows, shardSize = HISTORICAL_PROJECT_CONTEXT_SHARD_SIZE) {
  const size = Math.max(1, Math.floor(Number(shardSize) || HISTORICAL_PROJECT_CONTEXT_SHARD_SIZE));
  const sorted = [...(rows || [])].map(retainProjectRow).filter(Boolean)
    .sort((a, b) => a.project_id.localeCompare(b.project_id));
  const shards = [];
  for (let i = 0; i < sorted.length; i += size) {
    const entries = sorted.slice(i, i + size);
    shards.push({
      schema_version: HISTORICAL_PROJECT_CONTEXT_SCHEMA,
      shard: String(shards.length).padStart(4, "0"),
      rows: entries,
    });
  }
  return shards;
}

export function buildHistoricalProjectContextManifest(selection, shards, opts = {}) {
  const paths = (shards || []).map((_, index) => `historical_project_context/${String(index).padStart(4, "0")}.json`);
  return {
    schema_version: HISTORICAL_PROJECT_CONTEXT_SCHEMA,
    source: opts.source || { dataset_id: "hgx4-8ukb" },
    current_project_ids: selection?.current_ids || [],
    selected_ids: selection?.selected_ids || [],
    shard_size: opts.shardSize || HISTORICAL_PROJECT_CONTEXT_SHARD_SIZE,
    shards: paths,
    counts: selection?.counts || { selected: 0, retained: 0, missing: 0, excluded: 0 },
  };
}

/** Exact-ID reader over a manifest and already-loaded shard documents. */
export function createHistoricalProjectContextReader(manifest, shards = []) {
  const byId = new Map();
  for (const shard of shards || []) {
    for (const row of shard?.rows || []) {
      const id = exactProjectId(row?.project_id);
      if (id && !byId.has(id)) byId.set(id, row);
    }
  }
  return {
    manifest,
    get(projectId) {
      const id = exactProjectId(projectId);
      return id ? byId.get(id) || null : null;
    },
    has(projectId) {
      return Boolean(this.get(projectId));
    },
    size: byId.size,
  };
}
