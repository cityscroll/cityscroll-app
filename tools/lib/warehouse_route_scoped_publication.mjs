/**
 * Owned, bounded route-scoped warehouse shard publication (cc-06 A1 prereq).
 *
 * Mirrors the cc-05 binding ledger honesty rules:
 *   null → issued → acked | unknown
 * Exact-value cleanup only; foreign values abort (leave-foreign).
 * Durable recovery ledger records every issued put/clear.
 *
 * Bounds: at most three ALERT_STATE puts per deploy revision (one per lookup
 * route). Health and browse are control routes and never receive shards.
 * Publishing does not enable WAREHOUSE_ROUTE_SCOPED_SHARDS. Live writes stay
 * GO-gated at the CLI/launch boundary. WORKER_COST_ENFORCEMENT stays inactive.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  WAREHOUSE_ROUTE_SCOPED_KEY_PREFIX,
  WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES,
  buildWarehouseRouteScopedShardDocument,
  warehouseRouteScopedShardKey,
} from "../../worker/src/lib/warehouse_route_scoped_shards.mjs";

export const WAREHOUSE_ROUTE_SCOPED_PUBLICATION_LEDGER_SCHEMA =
  "cityscroll.warehouse_route_scoped_publication_ledger.v1";
export const WAREHOUSE_ROUTE_SCOPED_PUBLICATION_PLAN_SCHEMA =
  "cityscroll.warehouse_route_scoped_publication_plan.v1";
export const WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA =
  "cityscroll.warehouse_route_scoped_publication_receipt.v1";
export const WAREHOUSE_ROUTE_SCOPED_CLEANUP_PLAN_SCHEMA =
  "cityscroll.warehouse_route_scoped_cleanup_plan.v1";
export const WAREHOUSE_ROUTE_SCOPED_PREFLIGHT_SCHEMA =
  "cityscroll.warehouse_route_scoped_publication_preflight.v1";
export const WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA =
  "cityscroll.warehouse_route_scoped_publish_intent.v1";

/** Control routes never receive shards. */
export const WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES = Object.freeze([
  "health",
  "browse",
]);

/** Default on-disk materialization sources for the three lookup routes. */
export const WAREHOUSE_ROUTE_SCOPED_MATERIALIZATION_PATHS = Object.freeze({
  "zap-bbl": "site/data/zap_bbl_warehouse_lookup.json",
  "zap-project": "site/data/zap_projects_warehouse_lookup.json",
  "doing-business": "site/data/doing_business_warehouse_lookup.json",
});

const REVISION_RE = /^[a-f0-9]{40}$/;
const MAX_SHARD_PUTS_PER_REVISION = WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.length;

function fail(message) {
  throw new Error(message);
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIsoDefault() {
  return new Date().toISOString();
}

function kvArgs(configPath) {
  return ["--binding", "ALERT_STATE", "--remote", "--config", configPath];
}

function parseKvGet(raw) {
  // Preserve exact payload bytes for exact-value clear. Only the provider's
  // absent sentinel is treated as missing; do not trim owned JSON bodies.
  if (raw == null) return null;
  const text = String(raw);
  const trimmed = text.trim();
  if (!trimmed || trimmed === "Value not found") return null;
  return text;
}

function isMissingKvValue(error) {
  const providerText = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
  if (error?.status != null && error.status !== 1) return false;
  return /\b404:?\s+Not Found\b/.test(providerText)
    || /\b(?:code|error)(?::)?\s*10009\b/i.test(providerText)
    || /\bValue not found\b/i.test(providerText);
}

function emptyOpCounts() {
  return { kv_reads: 0, shard_puts: 0, shard_deletes: 0 };
}

function emptyConfirmedCounts() {
  return { shard_puts: 0, shard_deletes: 0 };
}

function requireRevision(revision, label = "deployed_revision") {
  const text = String(revision || "").trim().toLowerCase();
  if (!REVISION_RE.test(text)) fail(`${label} must be a full commit SHA`);
  return text;
}

function requireLookupRoute(route) {
  if (!WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(route)) {
    fail(`route must be one of ${WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.join(", ")}`);
  }
  return route;
}

function assertControlRoutes(controlRoutes) {
  for (const route of controlRoutes) {
    if (!WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES.includes(route)) {
      fail(`control route must be one of ${WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES.join(", ")}`);
    }
    if (WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(route)) {
      fail("control routes must not include lookup shard routes");
    }
  }
}

/**
 * Per-shard ownership ledger (issue-before-ack), matching cc-05 EXPECTED honesty.
 * States: null → issued → acked | unknown. Readback after lost write is not ACK.
 */
export function makeShardPublicationEntry({
  route,
  key,
  deployed_revision,
  value = null,
  value_sha256 = null,
} = {}) {
  requireLookupRoute(route);
  return {
    route,
    key,
    deployed_revision,
    phase: null, // null | "issued" | "acked" | "unknown"
    value,
    value_sha256,
    issued_at: null,
    acked_at: null,
    unknown_at: null,
    last_error: null,
    readback_confirmed_present: false,
    readback_confirmed_present_at: null,
    readback_confirmed_absent: false,
    readback_confirmed_absent_at: null,
    clear_phase: null, // null | "issued" | "acked" | "unknown"
    clear_issued_at: null,
    clear_acked_at: null,
    clear_unknown_at: null,
    clear_last_error: null,
    clear_readback_confirmed_absent: false,
    clear_readback_confirmed_absent_at: null,
    clear_readback_confirmed_present: false,
    clear_readback_confirmed_present_at: null,
    clear_abort_reason: null,
  };
}

export function makeShardPublicationLedger({
  attempt_id = null,
  deployed_revision,
  active_revision = null,
  rollback_revision = null,
} = {}) {
  const revision = requireRevision(deployed_revision);
  return {
    schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_LEDGER_SCHEMA,
    attempt_id,
    deployed_revision: revision,
    active_revision: active_revision ? requireRevision(active_revision, "active_revision") : null,
    rollback_revision: rollback_revision
      ? requireRevision(rollback_revision, "rollback_revision")
      : null,
    control_routes: [...WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES],
    entries: {},
    created_at: null,
    updated_at: null,
  };
}

export function markShardIssued(entry, { value, value_sha256 }, at) {
  entry.phase = "issued";
  entry.value = value;
  entry.value_sha256 = value_sha256;
  entry.issued_at = at;
  entry.last_error = null;
  entry.readback_confirmed_present = false;
  entry.readback_confirmed_present_at = null;
  entry.readback_confirmed_absent = false;
  entry.readback_confirmed_absent_at = null;
  return entry;
}

/** Only when the provider put response was successfully received. */
export function markShardAcked(entry, at) {
  entry.phase = "acked";
  entry.ack_outcome = "acked";
  entry.acked_at = at;
  entry.last_error = null;
  return entry;
}

export function markShardUnknown(entry, error, at) {
  entry.phase = "unknown";
  entry.ack_outcome = "unknown";
  entry.unknown_at = at;
  entry.last_error = String(error || "response-lost-or-errored");
  return entry;
}

export function markShardReadbackConfirmedPresent(entry, at) {
  if (entry.phase !== "acked") entry.phase = "unknown";
  entry.readback_confirmed_present = true;
  entry.readback_confirmed_present_at = at;
  entry.readback_confirmed_absent = false;
  return entry;
}

export function markShardReadbackConfirmedAbsent(entry, at) {
  entry.readback_confirmed_absent = true;
  entry.readback_confirmed_absent_at = at;
  entry.readback_confirmed_present = false;
  return entry;
}

export function markShardClearIssued(entry, at) {
  entry.clear_phase = "issued";
  entry.clear_ack_outcome = null;
  entry.clear_issued_at = at;
  entry.clear_last_error = null;
  entry.clear_abort_reason = null;
  entry.clear_readback_confirmed_absent = false;
  entry.clear_readback_confirmed_absent_at = null;
  entry.clear_readback_confirmed_present = false;
  entry.clear_readback_confirmed_present_at = null;
  return entry;
}

export function markShardClearAcked(entry, at) {
  entry.clear_phase = "acked";
  entry.clear_ack_outcome = "acked";
  entry.clear_acked_at = at;
  entry.clear_last_error = null;
  return entry;
}

export function markShardClearUnknown(entry, error, at) {
  entry.clear_phase = "unknown";
  entry.clear_ack_outcome = "unknown";
  entry.clear_unknown_at = at;
  entry.clear_last_error = String(error || "clear-response-lost-or-errored");
  return entry;
}

/**
 * Exact-value clear decision. Never clears a foreign value.
 * @returns {{ action: "already-absent"|"clear-owned"|"leave-foreign"|"refuse-missing-owned-value", reason: string }}
 */
export function planExactValueShardClear({ ownedValue, liveValue } = {}) {
  if (ownedValue == null || ownedValue === "") {
    return {
      action: "refuse-missing-owned-value",
      reason: "owned-value-required-for-exact-clear",
      foreign: false,
    };
  }
  if (liveValue == null || liveValue === "") {
    return {
      action: "already-absent",
      reason: "live-value-absent",
      foreign: false,
    };
  }
  if (liveValue === ownedValue) {
    return {
      action: "clear-owned",
      reason: "live-equals-owned",
      foreign: false,
    };
  }
  return {
    action: "leave-foreign",
    reason: "live-value-differs-from-owned",
    foreign: true,
  };
}

export function persistShardPublicationLedger(ledgerPath, ledger, {
  writeFileSyncFn = writeFileSync,
  nowIso = nowIsoDefault,
} = {}) {
  if (typeof ledgerPath !== "string" || !ledgerPath) {
    fail("persistShardPublicationLedger: ledgerPath required");
  }
  const at = nowIso();
  if (!ledger.created_at) ledger.created_at = at;
  ledger.updated_at = at;
  mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
  writeFileSyncFn(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  return ledger;
}

export function loadShardPublicationLedger(ledgerPath, {
  readFileSyncFn = readFileSync,
} = {}) {
  const raw = readFileSyncFn(ledgerPath, "utf8");
  const ledger = JSON.parse(raw);
  if (ledger?.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLICATION_LEDGER_SCHEMA) {
    fail("unsupported shard publication ledger schema");
  }
  return ledger;
}

/**
 * Load materialization JSON for one lookup route (fixture or tip path).
 */
export function loadRouteMaterialization(route, path, {
  readFileSyncFn = readFileSync,
} = {}) {
  requireLookupRoute(route);
  const doc = JSON.parse(readFileSyncFn(path, "utf8"));
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    fail(`materialization for ${route} must be an object`);
  }
  if (!Array.isArray(doc.rows)) fail(`materialization for ${route} must include rows[]`);
  return doc;
}

/**
 * Plan ≤3 revision-keyed shard puts. Never plans shards for health/browse.
 */
export function planWarehouseRouteScopedPublication({
  deployed_revision,
  materializations,
  control_routes = [...WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES],
  active_revision = null,
  rollback_revision = null,
  materialized_at = null,
} = {}) {
  const revision = requireRevision(deployed_revision);
  assertControlRoutes(control_routes);
  if (!materializations || typeof materializations !== "object") {
    fail("materializations must map lookup routes to docs");
  }

  const shards = [];
  for (const route of WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES) {
    if (control_routes.includes(route)) {
      fail(`lookup route ${route} must not appear in control_routes`);
    }
    const materialization = materializations[route];
    if (!materialization) fail(`missing materialization for ${route}`);
    const doc = buildWarehouseRouteScopedShardDocument(route, materialization, {
      deployed_revision: revision,
      materialized_at,
    });
    const value = `${JSON.stringify(doc)}\n`;
    const key = warehouseRouteScopedShardKey(route, revision);
    shards.push({
      route,
      key,
      deployed_revision: revision,
      value,
      value_sha256: sha256Text(value),
      row_count: Array.isArray(doc.materialization?.rows) ? doc.materialization.rows.length : 0,
      document: doc,
    });
  }

  if (shards.length > MAX_SHARD_PUTS_PER_REVISION) {
    fail(`publication refuses more than ${MAX_SHARD_PUTS_PER_REVISION} shard puts per revision`);
  }
  if (shards.length !== MAX_SHARD_PUTS_PER_REVISION) {
    fail(`publication requires exactly ${MAX_SHARD_PUTS_PER_REVISION} lookup shards`);
  }

  // Refuse accidental control-route keys in the plan.
  for (const shard of shards) {
    for (const control of control_routes) {
      if (shard.key.includes(`:${control}:`)) {
        fail(`publication plan must not include control route ${control}`);
      }
    }
  }

  return {
    schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_PLAN_SCHEMA,
    decision: "publish-revision-shards",
    deployed_revision: revision,
    active_revision: active_revision ? requireRevision(active_revision, "active_revision") : null,
    rollback_revision: rollback_revision
      ? requireRevision(rollback_revision, "rollback_revision")
      : null,
    control_routes: Object.freeze([...control_routes]),
    lookup_routes: Object.freeze([...WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES]),
    key_prefix: WAREHOUSE_ROUTE_SCOPED_KEY_PREFIX,
    shards: Object.freeze(shards.map((shard) => Object.freeze({ ...shard }))),
    planned: Object.freeze({
      kv_reads: 0,
      shard_puts: shards.length,
      shard_deletes: 0,
      max_shard_puts_per_revision: MAX_SHARD_PUTS_PER_REVISION,
    }),
    abort_rules: Object.freeze({
      on_invalid_revision: "refuse",
      on_control_route_target: "refuse",
      on_foreign_clear: "leave-foreign",
      exact_value_cleanup_only: true,
    }),
    activation: Object.freeze({
      publishes_shards: true,
      enables_flag: false,
      flag: "WAREHOUSE_ROUTE_SCOPED_SHARDS",
      note: "Publishing shards does not enable the flag; enable is a separate GO.",
    }),
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
  };
}

/**
 * Publish planned shards with issue-before-ack ledger + KV op accounting.
 * Caller must already hold an explicit publish GO; this function does not
 * check GO codes (the launch/CLI boundary does).
 */
export async function publishWarehouseRouteScopedShards({
  plan,
  invoke,
  ledgerPath = null,
  ledger = null,
  configPath = "worker/wrangler.toml",
  attempt_id = null,
  nowIso = nowIsoDefault,
} = {}) {
  if (typeof invoke !== "function") fail("publishWarehouseRouteScopedShards requires a Wrangler invoker");
  if (!plan || plan.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLICATION_PLAN_SCHEMA) {
    fail("publication plan is required");
  }
  if (plan.decision !== "publish-revision-shards") fail(`unsupported publication decision ${plan.decision}`);
  if (plan.shards.length > MAX_SHARD_PUTS_PER_REVISION) {
    fail(`publication refuses more than ${MAX_SHARD_PUTS_PER_REVISION} shard puts`);
  }

  const attempted = emptyOpCounts();
  const confirmed = emptyConfirmedCounts();
  const ownership = ledger || makeShardPublicationLedger({
    attempt_id,
    deployed_revision: plan.deployed_revision,
    active_revision: plan.active_revision,
    rollback_revision: plan.rollback_revision,
  });
  if (attempt_id && !ownership.attempt_id) ownership.attempt_id = attempt_id;

  const temp = mkdtempSync(join(tmpdir(), "cityscroll-route-scoped-pub-"));
  const shardReceipts = [];
  try {
    for (const shard of plan.shards) {
      const at = nowIso();
      const entry = makeShardPublicationEntry({
        route: shard.route,
        key: shard.key,
        deployed_revision: shard.deployed_revision,
      });
      markShardIssued(entry, { value: shard.value, value_sha256: shard.value_sha256 }, at);
      ownership.entries[shard.key] = entry;
      if (ledgerPath) persistShardPublicationLedger(ledgerPath, ownership, { nowIso: () => at });

      const path = join(temp, `${shard.route}.json`);
      writeFileSync(path, shard.value);
      attempted.shard_puts += 1;
      try {
        await invoke(["kv", "key", "put", shard.key, "--path", path, ...kvArgs(configPath)]);
        const ackedAt = nowIso();
        markShardAcked(entry, ackedAt);
        confirmed.shard_puts += 1;
        shardReceipts.push({
          route: shard.route,
          key: shard.key,
          value_sha256: shard.value_sha256,
          phase: entry.phase,
          row_count: shard.row_count,
        });
      } catch (error) {
        const unknownAt = nowIso();
        markShardUnknown(entry, error?.message || error, unknownAt);
        if (ledgerPath) persistShardPublicationLedger(ledgerPath, ownership, { nowIso: () => unknownAt });
        error.publication_receipt = {
          schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA,
          decision: "publish-failed",
          deployed_revision: plan.deployed_revision,
          planned: plan.planned,
          attempted,
          confirmed,
          shards: shardReceipts,
          failed_key: shard.key,
          ledger_phase: entry.phase,
          state_advanced: false,
        };
        throw error;
      }
      if (ledgerPath) persistShardPublicationLedger(ledgerPath, ownership, { nowIso });
    }

    return {
      schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA,
      decision: "published",
      deployed_revision: plan.deployed_revision,
      planned: plan.planned,
      attempted,
      confirmed,
      shards: shardReceipts,
      ledger: ownership,
      activation: plan.activation,
      financial_savings_confirmed: false,
      shipped_savings_claimed: false,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Plan cleanup for owned revision shards. Protects active + rollback revisions.
 * Exact-value only — foreign values become leave-foreign aborts.
 */
export function planWarehouseRouteScopedCleanup({
  deployed_revision,
  owned_entries,
  live_values = {},
  active_revision = null,
  rollback_revision = null,
  control_routes = [...WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES],
} = {}) {
  const revision = requireRevision(deployed_revision);
  assertControlRoutes(control_routes);
  const active = active_revision ? requireRevision(active_revision, "active_revision") : null;
  const rollback = rollback_revision
    ? requireRevision(rollback_revision, "rollback_revision")
    : null;

  if (active && revision === active) {
    return {
      schema: WAREHOUSE_ROUTE_SCOPED_CLEANUP_PLAN_SCHEMA,
      decision: "refuse-active-revision",
      reason: "cleanup-must-not-delete-active-serving-revision",
      deployed_revision: revision,
      actions: Object.freeze([]),
      planned: Object.freeze({ kv_reads: 0, shard_puts: 0, shard_deletes: 0 }),
    };
  }
  if (rollback && revision === rollback) {
    return {
      schema: WAREHOUSE_ROUTE_SCOPED_CLEANUP_PLAN_SCHEMA,
      decision: "refuse-rollback-revision",
      reason: "cleanup-must-not-delete-retained-rollback-revision",
      deployed_revision: revision,
      actions: Object.freeze([]),
      planned: Object.freeze({ kv_reads: 0, shard_puts: 0, shard_deletes: 0 }),
    };
  }

  const actions = [];
  let plannedDeletes = 0;
  let plannedReads = 0;
  for (const route of WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES) {
    const key = warehouseRouteScopedShardKey(route, revision);
    const owned = owned_entries?.[key] || owned_entries?.[route] || null;
    const ownedValue = typeof owned === "string"
      ? owned
      : (owned?.value ?? null);
    const liveValue = Object.prototype.hasOwnProperty.call(live_values, key)
      ? live_values[key]
      : undefined;
    const needsLiveRead = liveValue === undefined;
    if (needsLiveRead) plannedReads += 1;

    const decision = liveValue === undefined
      ? {
          action: "read-then-decide",
          reason: "live-value-not-supplied",
          foreign: false,
        }
      : planExactValueShardClear({ ownedValue, liveValue });

    if (decision.action === "clear-owned") plannedDeletes += 1;
    actions.push({
      route,
      key,
      owned_value_sha256: ownedValue ? sha256Text(ownedValue) : null,
      decision,
    });
  }

  return {
    schema: WAREHOUSE_ROUTE_SCOPED_CLEANUP_PLAN_SCHEMA,
    decision: "cleanup-owned-revision",
    deployed_revision: revision,
    active_revision: active,
    rollback_revision: rollback,
    control_routes: Object.freeze([...control_routes]),
    actions: Object.freeze(actions.map((row) => Object.freeze({ ...row }))),
    planned: Object.freeze({
      kv_reads: plannedReads,
      shard_puts: 0,
      shard_deletes: plannedDeletes,
    }),
    abort_rules: Object.freeze({
      exact_value_cleanup_only: true,
      on_foreign: "leave-foreign",
      protect_revisions: Object.freeze([active, rollback].filter(Boolean)),
    }),
  };
}

/**
 * Execute exact-value cleanup for owned shards. Aborts (leave-foreign) when
 * live value differs from the ledger-owned value. Never deletes control routes.
 */
export async function cleanupWarehouseRouteScopedShards({
  plan,
  invoke,
  owned_values,
  ledger = null,
  ledgerPath = null,
  configPath = "worker/wrangler.toml",
  nowIso = nowIsoDefault,
} = {}) {
  if (typeof invoke !== "function") fail("cleanupWarehouseRouteScopedShards requires a Wrangler invoker");
  if (!plan || plan.schema !== WAREHOUSE_ROUTE_SCOPED_CLEANUP_PLAN_SCHEMA) {
    fail("cleanup plan is required");
  }
  if (plan.decision === "refuse-active-revision" || plan.decision === "refuse-rollback-revision") {
    return {
      schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA,
      decision: plan.decision,
      reason: plan.reason,
      deployed_revision: plan.deployed_revision,
      attempted: emptyOpCounts(),
      confirmed: emptyConfirmedCounts(),
      actions: [],
    };
  }
  if (plan.decision !== "cleanup-owned-revision") {
    fail(`unsupported cleanup decision ${plan.decision}`);
  }

  const attempted = emptyOpCounts();
  const confirmed = emptyConfirmedCounts();
  const actionReceipts = [];

  for (const action of plan.actions) {
    let decision = action.decision;
    let liveValue = null;

    if (decision.action === "read-then-decide" || decision.action === "clear-owned") {
      attempted.kv_reads += 1;
      try {
        const result = await invoke([
          "kv", "key", "get", action.key,
          ...kvArgs(configPath), "--text",
        ]);
        liveValue = parseKvGet(result?.stdout);
      } catch (error) {
        if (!isMissingKvValue(error)) throw error;
        liveValue = null;
      }
      const ownedValue = owned_values?.[action.key] ?? null;
      decision = planExactValueShardClear({ ownedValue, liveValue });
    }

    const entry = ledger?.entries?.[action.key] || null;
    if (decision.action === "already-absent") {
      if (entry) markShardReadbackConfirmedAbsent(entry, nowIso());
      actionReceipts.push({
        route: action.route,
        key: action.key,
        action: decision.action,
        reason: decision.reason,
      });
      continue;
    }
    if (decision.action === "leave-foreign" || decision.action === "refuse-missing-owned-value") {
      if (entry) {
        entry.clear_abort_reason = decision.reason;
        if (decision.action === "leave-foreign") {
          markShardReadbackConfirmedPresent(entry, nowIso());
        }
      }
      actionReceipts.push({
        route: action.route,
        key: action.key,
        action: decision.action,
        reason: decision.reason,
        foreign: decision.foreign === true,
      });
      continue;
    }
    if (decision.action !== "clear-owned") {
      fail(`unexpected cleanup action ${decision.action}`);
    }

    const at = nowIso();
    if (entry) markShardClearIssued(entry, at);
    if (ledgerPath && ledger) persistShardPublicationLedger(ledgerPath, ledger, { nowIso: () => at });

    attempted.shard_deletes += 1;
    try {
      await invoke(["kv", "key", "delete", action.key, ...kvArgs(configPath)]);
      const ackedAt = nowIso();
      if (entry) markShardClearAcked(entry, ackedAt);
      confirmed.shard_deletes += 1;
      actionReceipts.push({
        route: action.route,
        key: action.key,
        action: "cleared-owned",
        reason: decision.reason,
      });
    } catch (error) {
      const unknownAt = nowIso();
      if (entry) markShardClearUnknown(entry, error?.message || error, unknownAt);
      if (ledgerPath && ledger) {
        persistShardPublicationLedger(ledgerPath, ledger, { nowIso: () => unknownAt });
      }
      error.publication_receipt = {
        schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA,
        decision: "cleanup-failed",
        deployed_revision: plan.deployed_revision,
        attempted,
        confirmed,
        actions: actionReceipts,
        failed_key: action.key,
      };
      throw error;
    }
    if (ledgerPath && ledger) persistShardPublicationLedger(ledgerPath, ledger, { nowIso });
  }

  return {
    schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA,
    decision: "cleaned",
    deployed_revision: plan.deployed_revision,
    planned: plan.planned,
    attempted,
    confirmed,
    actions: actionReceipts,
    ledger,
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
  };
}

/**
 * Read-only preflight: plan shards locally, optionally GET live KV keys and
 * assert control routes are not targeted. Never puts or deletes.
 */
export function preflightWarehouseRouteScopedPublicationReadonly({
  deployed_revision,
  materializations = null,
  live_shard_values = null,
  flag_binding_present = null,
  health_commit = null,
  control_routes = [...WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES],
} = {}) {
  const revision = requireRevision(deployed_revision);
  assertControlRoutes(control_routes);

  let plan = null;
  if (materializations) {
    plan = planWarehouseRouteScopedPublication({
      deployed_revision: revision,
      materializations,
      control_routes,
    });
  }

  const expectedKeys = WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.map(
    (route) => warehouseRouteScopedShardKey(route, revision),
  );

  const live = [];
  if (live_shard_values && typeof live_shard_values === "object") {
    for (const key of expectedKeys) {
      const value = live_shard_values[key];
      live.push({
        key,
        present: value != null && value !== "",
        value_sha256: value ? sha256Text(value) : null,
      });
    }
  }

  const checks = {
    revision_ok: true,
    control_routes_excluded: expectedKeys.every(
      (key) => !control_routes.some((route) => key.includes(`:${route}:`)),
    ),
    planned_put_count: plan ? plan.shards.length : null,
    planned_put_count_bounded: plan
      ? plan.shards.length <= MAX_SHARD_PUTS_PER_REVISION
      : null,
    flag_binding_present,
    flag_must_stay_off_until_separate_go: true,
    health_commit_matches: health_commit == null
      ? null
      : String(health_commit).toLowerCase() === revision,
    enables_flag: false,
  };

  const ok = checks.revision_ok
    && checks.control_routes_excluded
    && (checks.planned_put_count_bounded === null || checks.planned_put_count_bounded === true)
    && (checks.health_commit_matches === null || checks.health_commit_matches === true);

  return {
    schema: WAREHOUSE_ROUTE_SCOPED_PREFLIGHT_SCHEMA,
    mode: "readonly",
    outcome: ok ? "preflight-readonly-passed" : "preflight-readonly-failed",
    deployed_revision: revision,
    expected_keys: Object.freeze(expectedKeys),
    control_routes: Object.freeze([...control_routes]),
    live_shards: Object.freeze(live),
    checks: Object.freeze(checks),
    plan_summary: plan
      ? Object.freeze({
          decision: plan.decision,
          shard_puts: plan.planned.shard_puts,
          routes: plan.lookup_routes,
          activation: plan.activation,
        })
      : null,
    provider_writes: 0,
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
  };
}

/**
 * Build materializations map from on-disk tip (or fixture) paths.
 */
/**
 * Durable publish intent written and uploaded BEFORE any KV put.
 * Cleanup can recover from this artifact by run-id even when the publisher
 * dies before the final ACK ledger. Digests alone are enough to refuse a
 * foreign live value; exact owned values enable exact-value delete.
 */
export function buildWarehouseRouteScopedPublishIntent({
  plan,
  attempt_id = null,
  baseline_absence = null,
  created_at = null,
  nowIso = nowIsoDefault,
} = {}) {
  if (!plan || plan.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLICATION_PLAN_SCHEMA) {
    fail("publication plan is required to build intent");
  }
  const at = created_at || nowIso();
  const shards = plan.shards.map((shard) => ({
    route: shard.route,
    key: shard.key,
    deployed_revision: shard.deployed_revision,
    value: shard.value,
    value_sha256: shard.value_sha256,
    row_count: shard.row_count,
  }));
  return {
    schema: WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA,
    attempt_id,
    deployed_revision: plan.deployed_revision,
    active_revision: plan.active_revision,
    rollback_revision: plan.rollback_revision,
    control_routes: [...plan.control_routes],
    lookup_routes: [...plan.lookup_routes],
    created_at: at,
    baseline_absence: baseline_absence == null
      ? null
      : Object.freeze({ ...baseline_absence }),
    shards: Object.freeze(shards.map((row) => Object.freeze({ ...row }))),
    planned: plan.planned,
    abort_rules: plan.abort_rules,
    activation: plan.activation,
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
  };
}

export function persistWarehouseRouteScopedPublishIntent(intentPath, intent, {
  writeFileSyncFn = writeFileSync,
} = {}) {
  if (typeof intentPath !== "string" || !intentPath) {
    fail("persistWarehouseRouteScopedPublishIntent: intentPath required");
  }
  if (!intent || intent.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA) {
    fail("publish intent schema required");
  }
  mkdirSync(dirname(intentPath), { recursive: true, mode: 0o700 });
  writeFileSyncFn(intentPath, `${JSON.stringify(intent, null, 2)}\n`, { mode: 0o600 });
  return intent;
}

export function loadWarehouseRouteScopedPublishIntent(intentPath, {
  readFileSyncFn = readFileSync,
} = {}) {
  const intent = JSON.parse(readFileSyncFn(intentPath, "utf8"));
  if (intent?.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA) {
    fail("unsupported publish intent schema");
  }
  return intent;
}

/**
 * Verify a recovered intent against a freshly planned tip (or itself).
 * Used by dry-run cross-run readback and cleanup recovery.
 */
export function verifyWarehouseRouteScopedPublishIntent(intent, {
  plan = null,
  require_values = true,
} = {}) {
  if (!intent || intent.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA) {
    fail("publish intent required");
  }
  if (!Array.isArray(intent.shards) || intent.shards.length !== MAX_SHARD_PUTS_PER_REVISION) {
    fail(`intent must name exactly ${MAX_SHARD_PUTS_PER_REVISION} shards`);
  }
  const keys = new Set();
  for (const shard of intent.shards) {
    requireLookupRoute(shard.route);
    if (!REVISION_RE.test(String(shard.deployed_revision || ""))) {
      fail("intent shard revision must be a full commit SHA");
    }
    if (shard.deployed_revision !== intent.deployed_revision) {
      fail("intent shard revision must match intent.deployed_revision");
    }
    if (shard.key !== warehouseRouteScopedShardKey(shard.route, intent.deployed_revision)) {
      fail(`intent key mismatch for ${shard.route}`);
    }
    if (keys.has(shard.key)) fail(`duplicate intent key ${shard.key}`);
    keys.add(shard.key);
    if (require_values) {
      if (typeof shard.value !== "string" || !shard.value) {
        fail(`intent missing exact owned value for ${shard.key}`);
      }
      if (sha256Text(shard.value) !== shard.value_sha256) {
        fail(`intent value_sha256 mismatch for ${shard.key}`);
      }
    }
    for (const control of intent.control_routes || WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES) {
      if (shard.key.includes(`:${control}:`)) {
        fail(`intent must not include control route ${control}`);
      }
    }
  }
  if (plan) {
    if (plan.deployed_revision !== intent.deployed_revision) {
      fail("intent revision does not match plan");
    }
    if (plan.shards.length !== intent.shards.length) {
      fail("intent shard count does not match plan");
    }
    for (let i = 0; i < plan.shards.length; i += 1) {
      if (plan.shards[i].key !== intent.shards[i].key) {
        fail("intent key order/identity does not match plan");
      }
      if (plan.shards[i].value_sha256 !== intent.shards[i].value_sha256) {
        fail("intent digest does not match plan (tip materialization drifted)");
      }
    }
  }
  return {
    schema: WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA,
    status: "verified",
    deployed_revision: intent.deployed_revision,
    shard_count: intent.shards.length,
    keys: Object.freeze([...keys]),
    provider_writes: 0,
  };
}

/**
 * Build owned_values map from a recovered intent for exact-value cleanup when
 * the final ACK ledger artifact is missing.
 */
export function ownedValuesFromPublishIntent(intent) {
  verifyWarehouseRouteScopedPublishIntent(intent, { require_values: true });
  const owned = {};
  for (const shard of intent.shards) {
    owned[shard.key] = shard.value;
  }
  return owned;
}

/**
 * Seed a recovery ledger from intent with phase=unknown for each shard when
 * the publisher may have issued puts without an ACK receipt.
 */
export function recoveryLedgerFromPublishIntent(intent, {
  attempt_id = intent?.attempt_id || null,
  at = null,
  nowIso = nowIsoDefault,
} = {}) {
  verifyWarehouseRouteScopedPublishIntent(intent, { require_values: true });
  const issuedAt = at || nowIso();
  const ledger = makeShardPublicationLedger({
    attempt_id,
    deployed_revision: intent.deployed_revision,
    active_revision: intent.active_revision,
    rollback_revision: intent.rollback_revision,
  });
  for (const shard of intent.shards) {
    const entry = makeShardPublicationEntry({
      route: shard.route,
      key: shard.key,
      deployed_revision: shard.deployed_revision,
    });
    markShardIssued(entry, { value: shard.value, value_sha256: shard.value_sha256 }, issuedAt);
    // No ACK receipt → UNKNOWN ownership honesty for recovery.
    markShardUnknown(entry, "recovered-from-intent-without-final-ack", issuedAt);
    ledger.entries[shard.key] = entry;
  }
  return ledger;
}

export function loadWarehouseRouteScopedMaterializations({
  root = process.cwd(),
  paths = WAREHOUSE_ROUTE_SCOPED_MATERIALIZATION_PATHS,
  readFileSyncFn = readFileSync,
} = {}) {
  const materializations = {};
  for (const route of WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES) {
    const rel = paths[route];
    if (!rel) fail(`no materialization path for ${route}`);
    materializations[route] = loadRouteMaterialization(route, join(root, rel), {
      readFileSyncFn,
    });
  }
  return materializations;
}
