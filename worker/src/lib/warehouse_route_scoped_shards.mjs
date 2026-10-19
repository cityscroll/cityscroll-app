/**
 * Route-scoped, versioned KV warehouse materialization candidate (cc-06).
 *
 * Loads one immutable shard per lookup route on demand and caches it per
 * isolate. Default production path stays the static JSON imports in the three
 * baseline lookup modules until a later promotion GO. This module never
 * statically imports those JSON payloads, so health/browse control routes that
 * do not call it do not pay warehouse construction cost.
 *
 * cache_state is only index-cold-reset or isolate-reuse-hit. Never invents
 * semantic cold/warm or startup_time_ms. Absent/failed/invalid shards abort to
 * retain-baseline. WORKER_COST_ENFORCEMENT is unrelated and stays inactive.
 */

import { readKvValue } from "./preset_fallback_kv.mjs";

export const WAREHOUSE_ROUTE_SCOPED_FLAG = "WAREHOUSE_ROUTE_SCOPED_SHARDS";
export const WAREHOUSE_ROUTE_SCOPED_ENABLED = "enabled";

export const WAREHOUSE_ROUTE_SCOPED_SHARD_SCHEMA = "cityscroll.warehouse_route_scoped_shard.v1";
export const WAREHOUSE_ROUTE_SCOPED_KEY_PREFIX = "warehouse:route-scoped:v1";

/** Lookup routes that own versioned shards. Health/browse are controls only. */
export const WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES = Object.freeze([
  "zap-bbl",
  "zap-project",
  "doing-business",
]);

export const WAREHOUSE_ROUTE_SCOPED_CACHE_STATES = Object.freeze([
  "index-cold-reset",
  "isolate-reuse-hit",
]);

const REVISION_RE = /^[a-f0-9]{40}$/;

/** @type {Map<string, { revision: string, doc: object }>} */
const isolateShardCache = new Map();

export function warehouseRouteScopedShardsEnabled(env) {
  return env?.[WAREHOUSE_ROUTE_SCOPED_FLAG] === WAREHOUSE_ROUTE_SCOPED_ENABLED;
}

export function warehouseRouteScopedShardKey(route, revision) {
  if (!WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(route)) {
    throw new Error(`route-scoped shard route must be one of ${WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.join(", ")}`);
  }
  if (!REVISION_RE.test(String(revision || ""))) {
    throw new Error("route-scoped shard revision must be a full commit SHA");
  }
  return `${WAREHOUSE_ROUTE_SCOPED_KEY_PREFIX}:${route}:${revision}`;
}

export function resetWarehouseRouteScopedShardCache(route = null) {
  if (route == null) {
    isolateShardCache.clear();
    return { cleared: "all" };
  }
  if (!WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(route)) {
    throw new Error(`route-scoped shard route must be one of ${WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.join(", ")}`);
  }
  isolateShardCache.delete(route);
  return { cleared: route };
}

export function warehouseRouteScopedShardCacheSnapshot() {
  return Object.freeze(
    Object.fromEntries(
      [...isolateShardCache.entries()].map(([route, entry]) => [
        route,
        Object.freeze({ revision: entry.revision, row_count: Array.isArray(entry.doc?.rows) ? entry.doc.rows.length : 0 }),
      ]),
    ),
  );
}

/**
 * Build an immutable route shard document from a materialization-shaped doc.
 * Used by deploy-time publication and fixtures; never writes KV by itself.
 */
export function buildWarehouseRouteScopedShardDocument(route, materialization, {
  deployed_revision,
  materialized_at = null,
} = {}) {
  if (!WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(route)) {
    throw new Error(`route-scoped shard route must be one of ${WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.join(", ")}`);
  }
  if (!REVISION_RE.test(String(deployed_revision || ""))) {
    throw new Error("deployed_revision must be a full commit SHA");
  }
  if (!materialization || typeof materialization !== "object" || Array.isArray(materialization)) {
    throw new Error("materialization must be an object");
  }
  const rows = Array.isArray(materialization.rows) ? materialization.rows : null;
  if (!rows) throw new Error("materialization.rows must be an array");
  return {
    schema: WAREHOUSE_ROUTE_SCOPED_SHARD_SCHEMA,
    kind: "route-scoped-shards",
    route,
    deployed_revision,
    materialized_at: materialized_at || materialization.materialized_at || null,
    materialization: {
      schema_version: materialization.schema_version ?? null,
      mode: materialization.mode || null,
      materialized_at: materialization.materialized_at || null,
      dataset_id: materialization.dataset_id || null,
      phase: materialization.phase || null,
      rows,
      ...(materialization.project_count != null ? { project_count: materialization.project_count } : {}),
      ...(materialization.bbl_row_count != null ? { bbl_row_count: materialization.bbl_row_count } : {}),
      ...(materialization.row_count != null ? { row_count: materialization.row_count } : {}),
    },
  };
}

export function parseWarehouseRouteScopedShardRecord(raw, { route, revision } = {}) {
  if (raw == null || raw === "") {
    return { status: "absent", reason: "empty", doc: null };
  }
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { status: "failed", reason: "unparseable", doc: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "invalid", reason: "not-object", doc: null };
  }
  if (parsed.schema !== WAREHOUSE_ROUTE_SCOPED_SHARD_SCHEMA) {
    return { status: "invalid", reason: "schema", doc: null };
  }
  if (parsed.kind !== "route-scoped-shards") {
    return { status: "invalid", reason: "kind", doc: null };
  }
  if (route != null && parsed.route !== route) {
    return { status: "invalid", reason: "route-mismatch", doc: null };
  }
  if (revision != null && parsed.deployed_revision !== revision) {
    return { status: "invalid", reason: "revision-mismatch", doc: null };
  }
  if (!WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(parsed.route)) {
    return { status: "invalid", reason: "route", doc: null };
  }
  if (!REVISION_RE.test(String(parsed.deployed_revision || ""))) {
    return { status: "invalid", reason: "revision", doc: null };
  }
  const materialization = parsed.materialization;
  if (!materialization || typeof materialization !== "object" || Array.isArray(materialization)) {
    return { status: "invalid", reason: "materialization", doc: null };
  }
  if (!Array.isArray(materialization.rows)) {
    return { status: "invalid", reason: "rows", doc: null };
  }
  return { status: "ok", reason: null, doc: parsed };
}

function abortRetainBaseline(status, reason, extras = {}) {
  return {
    status,
    reason,
    doc: null,
    materialization: null,
    cache_state: null,
    kv_reads: extras.kv_reads ?? 0,
    abort: true,
    operation_recommendation: "retain-baseline",
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
    ...extras,
  };
}

/**
 * Load one versioned route shard. Explicit cache reset then load yields
 * index-cold-reset; a hit in the isolate cache yields isolate-reuse-hit.
 */
export async function loadWarehouseRouteScopedShard(env, {
  route,
  revision,
  kv = env?.ALERT_STATE,
} = {}) {
  if (!WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(route)) {
    throw new Error(`route-scoped shard route must be one of ${WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.join(", ")}`);
  }
  if (!REVISION_RE.test(String(revision || ""))) {
    throw new Error("route-scoped shard revision must be a full commit SHA");
  }

  const cached = isolateShardCache.get(route);
  if (cached && cached.revision === revision) {
    return {
      status: "ok",
      reason: null,
      doc: cached.doc,
      materialization: cached.doc.materialization,
      cache_state: "isolate-reuse-hit",
      kv_reads: 0,
      abort: false,
      operation_recommendation: null,
      financial_savings_confirmed: false,
      shipped_savings_claimed: false,
      key: warehouseRouteScopedShardKey(route, revision),
    };
  }

  if (!kv || typeof kv.get !== "function") {
    return abortRetainBaseline("absent", "no-kv");
  }

  let raw;
  try {
    raw = await readKvValue(kv, warehouseRouteScopedShardKey(route, revision));
  } catch {
    return abortRetainBaseline("failed", "kv-read-error", { kv_reads: 1 });
  }

  const parsed = parseWarehouseRouteScopedShardRecord(raw, { route, revision });
  if (parsed.status !== "ok") {
    return abortRetainBaseline(parsed.status, parsed.reason, { kv_reads: 1 });
  }

  isolateShardCache.set(route, { revision, doc: parsed.doc });
  return {
    status: "ok",
    reason: null,
    doc: parsed.doc,
    materialization: parsed.doc.materialization,
    cache_state: "index-cold-reset",
    kv_reads: 1,
    abort: false,
    operation_recommendation: null,
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
    key: warehouseRouteScopedShardKey(route, revision),
  };
}

/**
 * Candidate-facing resolve: static baseline unless the explicit enable flag is
 * set. Flag-off never reads KV and never claims route-scoped materialization.
 */
export async function resolveWarehouseRouteScopedLookup(env, {
  route,
  revision,
  kv = env?.ALERT_STATE,
} = {}) {
  if (!warehouseRouteScopedShardsEnabled(env)) {
    return {
      path: "static-baseline",
      status: "disabled",
      reason: "flag-off",
      doc: null,
      materialization: null,
      cache_state: null,
      kv_reads: 0,
      abort: false,
      operation_recommendation: null,
      financial_savings_confirmed: false,
      shipped_savings_claimed: false,
    };
  }
  const loaded = await loadWarehouseRouteScopedShard(env, { route, revision, kv });
  if (loaded.abort) {
    return { path: "abort-retain-baseline", ...loaded };
  }
  return { path: "route-scoped-shards", ...loaded };
}
