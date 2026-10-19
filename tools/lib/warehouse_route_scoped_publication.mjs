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
export const WAREHOUSE_ROUTE_SCOPED_ISSUED_CHECKPOINT_SCHEMA =
  "cityscroll.warehouse_route_scoped_issued_checkpoint.v1";

/**
 * Clearly labeled fixture purpose for the no-KV checkpoint drill.
 * Cleanup must refuse these as non-ownership (gates any live KV GO).
 */
export const WAREHOUSE_ROUTE_SCOPED_FIXTURE_CHECKPOINT_PURPOSE =
  "fixture-non-ownership-drill";

/** Intent purpose: only purpose=publish with per-key issued markers owns cleanup. */
export const WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_PURPOSES = Object.freeze([
  "dry-run",
  "prepare",
  "publish",
]);

/** External artifact name for a per-key issued checkpoint (upload before PUT). */
export function issuedCheckpointArtifactName(route) {
  requireLookupRoute(route);
  return `cc06-route-scoped-issued-${route}`;
}

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
  // Confirmed GETs are counted when a provider response is observed
  // (including "Value not found"). Unacked outcomes stay in unknown counts.
  return { kv_reads: 0, shard_puts: 0, shard_deletes: 0 };
}

export function emptyUnknownOpCounts() {
  return { kv_reads: 0, shard_puts: 0, shard_deletes: 0 };
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
 * Real pre-write GETs for every planned shard key. Records absent / present /
 * unknown per key. Any present value (including one identical to ours) or an
 * unknown/failed GET must abort publish with zero PUTs.
 */
export async function probeWarehouseRouteScopedBaselineAbsence({
  plan,
  invoke,
  configPath = "worker/wrangler.toml",
  nowIso = nowIsoDefault,
} = {}) {
  if (typeof invoke !== "function") fail("probeWarehouseRouteScopedBaselineAbsence requires a Wrangler invoker");
  if (!plan || plan.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLICATION_PLAN_SCHEMA) {
    fail("publication plan is required");
  }
  const probedAt = nowIso();
  const keys = {};
  let attemptedReads = 0;
  let confirmedReads = 0;
  let unknownReads = 0;
  let allAbsent = true;
  for (const shard of plan.shards) {
    // Count attempted only when the GET is actually invoked.
    attemptedReads += 1;
    let status = "unknown";
    let liveValue = null;
    let liveSha = null;
    let errorMessage = null;
    try {
      const result = await invoke([
        "kv", "key", "get", shard.key,
        ...kvArgs(configPath), "--text",
      ]);
      liveValue = parseKvGet(result?.stdout);
      if (liveValue == null) {
        status = "absent";
      } else {
        status = "present";
        liveSha = sha256Text(liveValue);
        allAbsent = false;
      }
      // Observed response (present or absent) is confirmed; timeouts/errors are not.
      confirmedReads += 1;
    } catch (error) {
      if (isMissingKvValue(error)) {
        status = "absent";
        liveValue = null;
        confirmedReads += 1;
      } else {
        status = "unknown";
        errorMessage = String(error?.message || error);
        unknownReads += 1;
        allAbsent = false;
      }
    }
    keys[shard.key] = Object.freeze({
      route: shard.route,
      status,
      live_value_sha256: liveSha,
      matches_planned_value: liveSha != null && liveSha === shard.value_sha256,
      error: errorMessage,
    });
  }
  return {
    schema: "cityscroll.warehouse_route_scoped_baseline_absence.v1",
    probed_at: probedAt,
    deployed_revision: plan.deployed_revision,
    // Legacy alias = attempted (invokes started). Prefer confirmed/unknown fields.
    kv_reads: attemptedReads,
    attempted_kv_reads: attemptedReads,
    confirmed_kv_reads: confirmedReads,
    unknown_kv_reads: unknownReads,
    all_absent: allAbsent,
    keys: Object.freeze(keys),
  };
}

export function assertBaselineAbsenceAllowsPublish(baseline) {
  if (!baseline || baseline.schema !== "cityscroll.warehouse_route_scoped_baseline_absence.v1") {
    fail("baseline absence probe receipt is required before publish");
  }
  if (!baseline.all_absent) {
    const blockers = Object.entries(baseline.keys || {})
      .filter(([, row]) => row.status !== "absent")
      .map(([key, row]) => `${key}:${row.status}${row.matches_planned_value ? "(identical)" : ""}`);
    fail(
      `refusing publish: pre-write GET found pre-existing or unknown keys `
      + `(${blockers.join(", ")}); zero PUTs`,
    );
  }
  return baseline;
}

/**
 * Publish planned shards with issue-before-ack ledger + KV op accounting.
 * Real pre-write GETs run before the first PUT; any present/unknown aborts
 * with zero PUTs. Per-key issued markers are written durably only immediately
 * before that key's PUT. Caller must already hold an explicit publish GO.
 */
export async function publishWarehouseRouteScopedShards({
  plan,
  invoke,
  ledgerPath = null,
  ledger = null,
  intent = null,
  intentPath = null,
  configPath = "worker/wrangler.toml",
  attempt_id = null,
  nowIso = nowIsoDefault,
  baseline = null,
  /**
   * Required for durable ownership: upload the per-key issued checkpoint to an
   * external store (CI artifact) and resolve only after that upload succeeds.
   * Local disk alone is not durable across runner death.
   */
  uploadIssuedCheckpoint = null,
  requireExternalCheckpointUpload = true,
  checkpointDir = null,
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

  // Pre-write GETs: refuse any pre-existing value (including identical) or unknown.
  const probed = baseline || await probeWarehouseRouteScopedBaselineAbsence({
    plan,
    invoke,
    configPath,
    nowIso,
  });
  attempted.kv_reads += probed.attempted_kv_reads ?? probed.kv_reads ?? 0;
  // Confirmed only for observed present/absent responses; timeouts/errors → unknown.
  confirmed.kv_reads += probed.confirmed_kv_reads ?? 0;
  const unknown = emptyUnknownOpCounts();
  unknown.kv_reads += probed.unknown_kv_reads ?? 0;
  try {
    assertBaselineAbsenceAllowsPublish(probed);
  } catch (error) {
    error.publication_receipt = {
      schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA,
      decision: "publish-aborted-preexisting",
      deployed_revision: plan.deployed_revision,
      planned: plan.planned,
      attempted,
      confirmed,
      unknown,
      baseline_absence: probed,
      shards: [],
      state_advanced: false,
    };
    throw error;
  }

  if (intent) {
    if (intent.purpose && intent.purpose !== "publish") {
      fail(`publish requires intent.purpose=publish (got ${intent.purpose})`);
    }
    intent.purpose = "publish";
    if (attempt_id && !intent.attempt_id) intent.attempt_id = attempt_id;
    intent.baseline_absence = probed;
    if (intentPath) persistWarehouseRouteScopedPublishIntent(intentPath, intent);
  }

  const ownership = ledger || makeShardPublicationLedger({
    attempt_id,
    deployed_revision: plan.deployed_revision,
    active_revision: plan.active_revision,
    rollback_revision: plan.rollback_revision,
  });
  if (attempt_id && !ownership.attempt_id) ownership.attempt_id = attempt_id;

  if (requireExternalCheckpointUpload && typeof uploadIssuedCheckpoint !== "function") {
    fail(
      "publish requires uploadIssuedCheckpoint (external per-key artifact upload) "
      + "before any PUT; local files alone are not durable",
    );
  }

  const temp = mkdtempSync(join(tmpdir(), "cityscroll-route-scoped-pub-"));
  const checkpointRoot = checkpointDir || join(temp, "checkpoints");
  mkdirSync(checkpointRoot, { recursive: true, mode: 0o700 });
  const shardReceipts = [];
  try {
    for (const shard of plan.shards) {
      const at = nowIso();
      const entry = makeShardPublicationEntry({
        route: shard.route,
        key: shard.key,
        deployed_revision: shard.deployed_revision,
      });
      // Local issued marker, then EXTERNAL checkpoint upload, then PUT.
      markShardIssued(entry, { value: shard.value, value_sha256: shard.value_sha256 }, at);
      ownership.entries[shard.key] = entry;
      if (ledgerPath) persistShardPublicationLedger(ledgerPath, ownership, { nowIso: () => at });
      if (intent) {
        markIntentShardIssued(intent, shard.key, {
          value: shard.value,
          value_sha256: shard.value_sha256,
        }, at);
        if (intentPath) persistWarehouseRouteScopedPublishIntent(intentPath, intent);
      }

      const checkpoint = buildIssuedCheckpoint({
        attempt_id: ownership.attempt_id || attempt_id,
        route: shard.route,
        key: shard.key,
        deployed_revision: shard.deployed_revision,
        value: shard.value,
        value_sha256: shard.value_sha256,
        issued_at: at,
        row_count: shard.row_count,
      });
      const checkpointPath = join(checkpointRoot, `${shard.route}.json`);
      persistIssuedCheckpoint(checkpointPath, checkpoint);
      if (requireExternalCheckpointUpload) {
        try {
          await uploadIssuedCheckpoint(checkpoint, {
            path: checkpointPath,
            artifactName: issuedCheckpointArtifactName(shard.route),
          });
        } catch (error) {
          error.publication_receipt = {
            schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA,
            decision: "publish-aborted-checkpoint-upload",
            deployed_revision: plan.deployed_revision,
            planned: plan.planned,
            attempted,
            confirmed,
            unknown,
            baseline_absence: probed,
            shards: shardReceipts,
            failed_key: shard.key,
            state_advanced: false,
          };
          throw error;
        }
      }

      const path = join(temp, `${shard.route}.json`);
      writeFileSync(path, shard.value);
      attempted.shard_puts += 1;
      try {
        await invoke(["kv", "key", "put", shard.key, "--path", path, ...kvArgs(configPath)]);
        const ackedAt = nowIso();
        markShardAcked(entry, ackedAt);
        if (intent) {
          markIntentShardAcked(intent, shard.key, ackedAt);
          if (intentPath) persistWarehouseRouteScopedPublishIntent(intentPath, intent);
        }
        confirmed.shard_puts += 1;
        shardReceipts.push({
          route: shard.route,
          key: shard.key,
          value_sha256: shard.value_sha256,
          phase: entry.phase,
          issued_at: entry.issued_at,
          checkpoint_artifact: issuedCheckpointArtifactName(shard.route),
          row_count: shard.row_count,
        });
      } catch (error) {
        const unknownAt = nowIso();
        markShardUnknown(entry, error?.message || error, unknownAt);
        unknown.shard_puts += 1;
        if (intent) {
          markIntentShardUnknown(intent, shard.key, error?.message || error, unknownAt);
          if (intentPath) persistWarehouseRouteScopedPublishIntent(intentPath, intent);
        }
        if (ledgerPath) persistShardPublicationLedger(ledgerPath, ownership, { nowIso: () => unknownAt });
        error.publication_receipt = {
          schema: WAREHOUSE_ROUTE_SCOPED_PUBLICATION_RECEIPT_SCHEMA,
          decision: "publish-failed",
          deployed_revision: plan.deployed_revision,
          planned: plan.planned,
          attempted,
          confirmed,
          unknown,
          baseline_absence: probed,
          shards: shardReceipts,
          failed_key: shard.key,
          ledger_phase: entry.phase,
          // Checkpoint was uploaded; ownership is externally recoverable as UNKNOWN.
          checkpoint_uploaded: true,
          // PUT may have been applied; ACK is lost — not an acknowledged write count.
          acknowledged_provider_writes_lower_bound: confirmed.shard_puts,
          provider_write_outcome: "UNKNOWN",
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
      unknown,
      baseline_absence: probed,
      shards: shardReceipts,
      ledger: ownership,
      intent,
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
        confirmed.kv_reads += 1;
      } catch (error) {
        if (!isMissingKvValue(error)) throw error;
        liveValue = null;
        // Provider answered with absence — confirmed read, not UNKNOWN.
        confirmed.kv_reads += 1;
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
 * purpose=dry-run|prepare never owns cleanup. purpose=publish plus per-key
 * issued markers (written only immediately before each PUT) bind ownership.
 * Digests refuse foreign live values; exact owned values enable exact-value
 * delete for keys that were actually issued.
 */
export function buildWarehouseRouteScopedPublishIntent({
  plan,
  attempt_id = null,
  purpose = "prepare",
  baseline_absence = null,
  created_at = null,
  nowIso = nowIsoDefault,
} = {}) {
  if (!plan || plan.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLICATION_PLAN_SCHEMA) {
    fail("publication plan is required to build intent");
  }
  if (!WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_PURPOSES.includes(purpose)) {
    fail(`intent purpose must be one of ${WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_PURPOSES.join(", ")}`);
  }
  if (purpose === "publish" && !attempt_id) {
    fail("purpose=publish requires a unique attempt_id");
  }
  const at = created_at || nowIso();
  const shards = plan.shards.map((shard) => ({
    route: shard.route,
    key: shard.key,
    deployed_revision: shard.deployed_revision,
    value: shard.value,
    value_sha256: shard.value_sha256,
    row_count: shard.row_count,
    // Planned until a real publish attempt writes issued immediately before PUT.
    phase: null,
    issued_at: null,
    acked_at: null,
    unknown_at: null,
    last_error: null,
  }));
  return {
    schema: WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA,
    purpose,
    attempt_id,
    deployed_revision: plan.deployed_revision,
    active_revision: plan.active_revision,
    rollback_revision: plan.rollback_revision,
    control_routes: [...plan.control_routes],
    lookup_routes: [...plan.lookup_routes],
    created_at: at,
    baseline_absence: baseline_absence == null
      ? null
      : baseline_absence,
    shards,
    planned: plan.planned,
    abort_rules: plan.abort_rules,
    activation: plan.activation,
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
  };
}

function intentShardByKey(intent, key) {
  const shard = (intent.shards || []).find((row) => row.key === key);
  if (!shard) fail(`intent missing shard for key ${key}`);
  return shard;
}

/** Record issued on the intent shard only when that PUT is about to be sent. */
export function markIntentShardIssued(intent, key, { value, value_sha256 }, at) {
  if (!intent || intent.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA) {
    fail("publish intent required");
  }
  if (intent.purpose !== "publish") {
    fail("only purpose=publish intent may record issued markers");
  }
  const shard = intentShardByKey(intent, key);
  shard.phase = "issued";
  shard.value = value;
  shard.value_sha256 = value_sha256;
  shard.issued_at = at;
  shard.acked_at = null;
  shard.unknown_at = null;
  shard.last_error = null;
  return shard;
}

export function markIntentShardAcked(intent, key, at) {
  const shard = intentShardByKey(intent, key);
  if (shard.phase !== "issued" && shard.phase !== "acked") {
    fail(`cannot ack intent shard ${key} in phase ${shard.phase}`);
  }
  shard.phase = "acked";
  shard.acked_at = at;
  shard.last_error = null;
  return shard;
}

export function markIntentShardUnknown(intent, key, error, at) {
  const shard = intentShardByKey(intent, key);
  if (!shard.issued_at) {
    fail(`cannot mark unknown on never-issued intent shard ${key}`);
  }
  shard.phase = "unknown";
  shard.unknown_at = at;
  shard.last_error = String(error || "response-lost-or-errored");
  return shard;
}

/**
 * Ownership for cleanup: purpose=publish + unique attempt_id + at least one
 * per-key issued marker with a real issued_at. Dry-run / prepare / never-issued
 * intents are refused. Prefer mergeOwnershipFromIntentAndCheckpoints when
 * recovering from external per-key checkpoint artifacts.
 */
export function assertPublishOwnershipForCleanup(intent) {
  if (!intent || intent.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA) {
    fail("publish intent required for cleanup ownership");
  }
  if (intent.purpose !== "publish") {
    fail(
      `cleanup refuses intent.purpose=${intent.purpose || "missing"}; `
      + "only a real purpose=publish attempt owns cleanup",
    );
  }
  if (!intent.attempt_id) {
    fail("cleanup refuses publish intent without attempt_id");
  }
  const issued = (intent.shards || []).filter(
    (shard) => shard.issued_at && (shard.phase === "issued" || shard.phase === "acked" || shard.phase === "unknown"),
  );
  if (issued.length === 0) {
    fail("cleanup refuses never-issued publish intent (no per-key issued markers)");
  }
  for (const shard of issued) {
    if (typeof shard.issued_at !== "string" || !shard.issued_at) {
      fail(`cleanup refuses invented or missing issued_at for ${shard.key}`);
    }
  }
  return {
    status: "publish-owned",
    attempt_id: intent.attempt_id,
    issued_keys: issued.map((shard) => shard.key),
    issued_count: issued.length,
  };
}

/**
 * Per-key issued checkpoint uploaded to an external artifact store BEFORE the
 * matching PUT. Local runner files alone are not durable across runner death.
 */
export function buildIssuedCheckpoint({
  attempt_id,
  route,
  key,
  deployed_revision,
  value,
  value_sha256,
  issued_at,
  row_count = null,
  nowIso = nowIsoDefault,
} = {}) {
  if (!attempt_id) fail("issued checkpoint requires attempt_id");
  requireLookupRoute(route);
  const revision = requireRevision(deployed_revision);
  if (key !== warehouseRouteScopedShardKey(route, revision)) {
    fail(`issued checkpoint key mismatch for ${route}`);
  }
  if (typeof value !== "string" || !value) fail("issued checkpoint requires exact owned value");
  const digest = value_sha256 || sha256Text(value);
  if (sha256Text(value) !== digest) fail("issued checkpoint value_sha256 mismatch");
  const at = issued_at || nowIso();
  return {
    schema: WAREHOUSE_ROUTE_SCOPED_ISSUED_CHECKPOINT_SCHEMA,
    purpose: "publish",
    attempt_id,
    route,
    key,
    deployed_revision: revision,
    value,
    value_sha256: digest,
    row_count,
    phase: "issued",
    issued_at: at,
    artifact_name: issuedCheckpointArtifactName(route),
  };
}

/**
 * Clearly labeled fixture checkpoint for the no-KV ownership drill.
 * Uploading/fetching this artifact must never grant cleanup ownership.
 */
export function buildFixtureNonOwnershipCheckpoint(args = {}) {
  const checkpoint = buildIssuedCheckpoint(args);
  return {
    ...checkpoint,
    purpose: WAREHOUSE_ROUTE_SCOPED_FIXTURE_CHECKPOINT_PURPOSE,
    fixture_label: "cc06-fixture-non-ownership-drill",
    ownership: "none",
  };
}

export function persistIssuedCheckpoint(checkpointPath, checkpoint, {
  writeFileSyncFn = writeFileSync,
} = {}) {
  if (!checkpointPath) fail("persistIssuedCheckpoint: path required");
  if (!checkpoint || checkpoint.schema !== WAREHOUSE_ROUTE_SCOPED_ISSUED_CHECKPOINT_SCHEMA) {
    fail("issued checkpoint schema required");
  }
  mkdirSync(dirname(checkpointPath), { recursive: true, mode: 0o700 });
  writeFileSyncFn(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  return checkpoint;
}

export function loadIssuedCheckpoint(checkpointPath, {
  readFileSyncFn = readFileSync,
} = {}) {
  const checkpoint = JSON.parse(readFileSyncFn(checkpointPath, "utf8"));
  if (checkpoint?.schema !== WAREHOUSE_ROUTE_SCOPED_ISSUED_CHECKPOINT_SCHEMA) {
    fail("unsupported issued checkpoint schema");
  }
  return checkpoint;
}

export function verifyIssuedCheckpoint(checkpoint, { intent = null } = {}) {
  if (!checkpoint || checkpoint.schema !== WAREHOUSE_ROUTE_SCOPED_ISSUED_CHECKPOINT_SCHEMA) {
    fail("issued checkpoint required");
  }
  if (checkpoint.purpose === WAREHOUSE_ROUTE_SCOPED_FIXTURE_CHECKPOINT_PURPOSE) {
    fail(
      "cleanup refuses fixture-non-ownership-drill checkpoint "
      + "(labeled fixture is not publish ownership)",
    );
  }
  if (checkpoint.purpose !== "publish") {
    fail(`issued checkpoint purpose must be publish (got ${checkpoint.purpose})`);
  }
  if (!checkpoint.attempt_id) fail("issued checkpoint missing attempt_id");
  requireLookupRoute(checkpoint.route);
  if (!REVISION_RE.test(String(checkpoint.deployed_revision || ""))) {
    fail("issued checkpoint revision must be a full commit SHA");
  }
  if (checkpoint.key !== warehouseRouteScopedShardKey(checkpoint.route, checkpoint.deployed_revision)) {
    fail("issued checkpoint key mismatch");
  }
  if (typeof checkpoint.value !== "string" || !checkpoint.value) {
    fail("issued checkpoint missing exact owned value");
  }
  if (sha256Text(checkpoint.value) !== checkpoint.value_sha256) {
    fail("issued checkpoint value_sha256 mismatch");
  }
  if (typeof checkpoint.issued_at !== "string" || !checkpoint.issued_at) {
    fail("issued checkpoint missing issued_at");
  }
  if (checkpoint.phase !== "issued" && checkpoint.phase !== "unknown" && checkpoint.phase !== "acked") {
    fail(`issued checkpoint has invalid phase ${checkpoint.phase}`);
  }
  if (intent) {
    if (intent.purpose !== "publish") fail("checkpoint intent purpose must be publish");
    if (intent.attempt_id && intent.attempt_id !== checkpoint.attempt_id) {
      fail("checkpoint attempt_id does not match intent");
    }
    if (intent.deployed_revision !== checkpoint.deployed_revision) {
      fail("checkpoint revision does not match intent");
    }
    const planned = (intent.shards || []).find((row) => row.key === checkpoint.key);
    if (!planned) fail("checkpoint key not present on intent");
    if (planned.value_sha256 !== checkpoint.value_sha256) {
      fail("checkpoint digest does not match intent planned value");
    }
  }
  return {
    status: "verified",
    key: checkpoint.key,
    route: checkpoint.route,
    attempt_id: checkpoint.attempt_id,
    provider_writes: 0,
  };
}

/**
 * Build cleanup ownership from the initial intent plus externally uploaded
 * per-key issued checkpoints. Works when no final receipt/ledger artifact
 * exists. Planned-only keys (no checkpoint) are never marked issued.
 * Checkpointed keys without ACK stay UNKNOWN (possibly-issued).
 */
export function mergeOwnershipFromIntentAndCheckpoints({
  intent,
  checkpoints = [],
} = {}) {
  if (!intent || intent.schema !== WAREHOUSE_ROUTE_SCOPED_PUBLISH_INTENT_SCHEMA) {
    fail("publish intent required");
  }
  if (intent.purpose !== "publish") {
    fail(
      `cleanup refuses intent.purpose=${intent.purpose || "missing"}; `
      + "only a real purpose=publish attempt owns cleanup",
    );
  }
  if (!intent.attempt_id) fail("cleanup refuses publish intent without attempt_id");
  verifyWarehouseRouteScopedPublishIntent(intent, { require_values: true });

  const byKey = new Map();
  for (const checkpoint of checkpoints) {
    verifyIssuedCheckpoint(checkpoint, { intent });
    if (checkpoint.attempt_id !== intent.attempt_id) {
      fail(`checkpoint attempt_id ${checkpoint.attempt_id} != intent ${intent.attempt_id}`);
    }
    byKey.set(checkpoint.key, checkpoint);
  }
  if (byKey.size === 0) {
    fail(
      "cleanup refuses: no external per-key issued checkpoints "
      + "(local intent markers alone are not durable across runner death)",
    );
  }

  const ledger = makeShardPublicationLedger({
    attempt_id: intent.attempt_id,
    deployed_revision: intent.deployed_revision,
    active_revision: intent.active_revision,
    rollback_revision: intent.rollback_revision,
  });
  const owned_values = {};
  for (const checkpoint of byKey.values()) {
    const entry = makeShardPublicationEntry({
      route: checkpoint.route,
      key: checkpoint.key,
      deployed_revision: checkpoint.deployed_revision,
    });
    markShardIssued(
      entry,
      { value: checkpoint.value, value_sha256: checkpoint.value_sha256 },
      checkpoint.issued_at,
    );
    // No final ACK artifact → possibly-issued stays UNKNOWN.
    markShardUnknown(entry, "recovered-from-external-issued-checkpoint", checkpoint.issued_at);
    ledger.entries[checkpoint.key] = entry;
    owned_values[checkpoint.key] = checkpoint.value;
  }

  return {
    status: "publish-owned-from-checkpoints",
    attempt_id: intent.attempt_id,
    issued_count: byKey.size,
    issued_keys: Object.freeze([...byKey.keys()]),
    owned_values,
    ledger,
    // Planned keys without checkpoints remain unowned.
    planned_unissued_keys: Object.freeze(
      (intent.shards || [])
        .map((shard) => shard.key)
        .filter((key) => !byKey.has(key)),
    ),
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
 * the final ACK ledger artifact is missing. Only keys with a real per-key
 * issued marker are owned; dry-run / prepare / never-issued intents refuse.
 */
export function ownedValuesFromPublishIntent(intent) {
  verifyWarehouseRouteScopedPublishIntent(intent, { require_values: true });
  assertPublishOwnershipForCleanup(intent);
  const owned = {};
  for (const shard of intent.shards) {
    if (!shard.issued_at) continue;
    if (shard.phase !== "issued" && shard.phase !== "acked" && shard.phase !== "unknown") continue;
    owned[shard.key] = shard.value;
  }
  return owned;
}

/**
 * Seed a recovery ledger from intent for keys that were actually issued.
 * Never invents issued_at or marks planned-only shards as issued/unknown.
 * Acked keys stay acked; issued/unknown without final ACK stay unknown.
 */
export function recoveryLedgerFromPublishIntent(intent, {
  attempt_id = intent?.attempt_id || null,
} = {}) {
  verifyWarehouseRouteScopedPublishIntent(intent, { require_values: true });
  assertPublishOwnershipForCleanup(intent);
  const ledger = makeShardPublicationLedger({
    attempt_id,
    deployed_revision: intent.deployed_revision,
    active_revision: intent.active_revision,
    rollback_revision: intent.rollback_revision,
  });
  for (const shard of intent.shards) {
    if (!shard.issued_at) continue;
    if (shard.phase !== "issued" && shard.phase !== "acked" && shard.phase !== "unknown") continue;
    const entry = makeShardPublicationEntry({
      route: shard.route,
      key: shard.key,
      deployed_revision: shard.deployed_revision,
    });
    markShardIssued(entry, { value: shard.value, value_sha256: shard.value_sha256 }, shard.issued_at);
    if (shard.phase === "acked" && shard.acked_at) {
      markShardAcked(entry, shard.acked_at);
    } else {
      // Issued or unknown without a durable ACK → UNKNOWN for recovery honesty.
      markShardUnknown(
        entry,
        shard.last_error || "recovered-from-intent-without-final-ack",
        shard.unknown_at || shard.issued_at,
      );
    }
    ledger.entries[shard.key] = entry;
  }
  if (Object.keys(ledger.entries).length === 0) {
    fail("recovery ledger empty: intent has no per-key issued markers");
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
