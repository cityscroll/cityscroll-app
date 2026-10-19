#!/usr/bin/env node
/**
 * CLI for owned route-scoped warehouse shard publication (cc-06).
 *
 * Commands:
 *   plan                 — build a local publication plan (no provider I/O)
 *   prepare-intent       — write durable intent (purpose=prepare); no KV
 *   dry-run              — write durable intent (purpose=dry-run); no KV
 *   dry-run-readback     — load prior intent by path; verify; no KV
 *   probe-baseline       — real GETs of planned keys; record baseline_absence; no PUTs
 *   write-issued-checkpoint — mark one key issued + write checkpoint file (no PUT)
 *   put-one              — PUT one key after its external checkpoint artifact exists
 *   preflight-readonly   — plan + optional live KV GETs; never puts/deletes
 *   publish              — GO-gated; pre-write GETs then checkpoint-upload-before-PUT
 *   cleanup              — GO-gated; intent + external per-key checkpoints (no final needed)
 *
 * Publishing shards does not enable WAREHOUSE_ROUTE_SCOPED_SHARDS.
 * Live measure/stage remain separate GOs. Never overlap the frozen cc-05
 * measurement window (finish+restore before 06:30Z or run after that window).
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWranglerInvoker } from "./lib/wrangler_exec.mjs";

import {
  WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES,
  assertBaselineAbsenceAllowsPublish,
  buildIssuedCheckpoint,
  buildWarehouseRouteScopedPublishIntent,
  cleanupWarehouseRouteScopedShards,
  issuedCheckpointArtifactName,
  loadIssuedCheckpoint,
  loadShardPublicationLedger,
  loadWarehouseRouteScopedMaterializations,
  loadWarehouseRouteScopedPublishIntent,
  markIntentShardAcked,
  markIntentShardIssued,
  markIntentShardUnknown,
  markShardAcked,
  markShardIssued,
  markShardUnknown,
  makeShardPublicationEntry,
  makeShardPublicationLedger,
  mergeOwnershipFromIntentAndCheckpoints,
  persistIssuedCheckpoint,
  persistShardPublicationLedger,
  persistWarehouseRouteScopedPublishIntent,
  planWarehouseRouteScopedCleanup,
  planWarehouseRouteScopedPublication,
  preflightWarehouseRouteScopedPublicationReadonly,
  probeWarehouseRouteScopedBaselineAbsence,
  publishWarehouseRouteScopedShards,
  verifyIssuedCheckpoint,
  verifyWarehouseRouteScopedPublishIntent,
} from "./lib/warehouse_route_scoped_publication.mjs";
import { warehouseRouteScopedShardKey } from "../worker/src/lib/warehouse_route_scoped_shards.mjs";
import { WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES } from "../worker/src/lib/warehouse_route_scoped_shards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GO_CODE_RE = /^C6-[0-9a-fA-F]{8}$/;

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function usage() {
  return `usage:
  node tools/warehouse_route_scoped_publication.mjs plan --revision <40-hex> [--out <path>]
  node tools/warehouse_route_scoped_publication.mjs prepare-intent --revision <40-hex> --intent <path> [--attempt-id <id>] [--out <path>]
  node tools/warehouse_route_scoped_publication.mjs dry-run --revision <40-hex> --intent <path> [--attempt-id <id>] [--out <path>]
  node tools/warehouse_route_scoped_publication.mjs dry-run-readback --intent <path> [--revision <40-hex>] [--out <path>]
  node tools/warehouse_route_scoped_publication.mjs probe-baseline --revision <40-hex> --intent <path> [--out <path>]
  node tools/warehouse_route_scoped_publication.mjs write-issued-checkpoint --revision <40-hex> --intent <path> --route <route> --checkpoint <path> --ledger <path> --attempt-id <id>
  node tools/warehouse_route_scoped_publication.mjs put-one --revision <40-hex> --intent <path> --route <route> --checkpoint <path> --ledger <path> --attempt-id <id>
  node tools/warehouse_route_scoped_publication.mjs preflight-readonly --revision <40-hex> [--live-kv] [--health-commit <40-hex>] [--out <path>]
  node tools/warehouse_route_scoped_publication.mjs publish --revision <40-hex> --ledger <path> --attempt-id <id> [--intent <path>] [--checkpoint-dir <path>]
      (requires CC06_PUBLISH_EXECUTE_CODE=C6-<8hex>; CC06_CHECKPOINT_STORE_DIR or upload helper)
  node tools/warehouse_route_scoped_publication.mjs cleanup --revision <40-hex> --intent <path> [--checkpoint-dir <path>] [--ledger <path>]
      (requires CC06_PUBLISH_EXECUTE_CODE=C6-<8hex>; external checkpoints; protects --active/--rollback)`;
}

/**
 * External durability for per-key issued checkpoints. Prefers an explicit
 * durable store directory (tests / local rehearsal) or a helper command
 * (CI). Local intent/ledger files alone are not enough.
 */
function createCheckpointUploader({ storeDir = null } = {}) {
  const dir = storeDir || process.env.CC06_CHECKPOINT_STORE_DIR || null;
  const helper = process.env.CC06_CHECKPOINT_UPLOAD_HELPER || null;
  if (!dir && !helper) {
    throw new Error(
      "publish requires CC06_CHECKPOINT_STORE_DIR or CC06_CHECKPOINT_UPLOAD_HELPER "
      + "so each issued checkpoint is externalized before PUT",
    );
  }
  return async (checkpoint, { path, artifactName }) => {
    if (dir) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const dest = join(dir, `${artifactName}.json`);
      copyFileSync(path, dest);
      return { store: "dir", dest, artifactName };
    }
    const result = spawnSync(helper, [path, artifactName], {
      encoding: "utf8",
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error(
        `checkpoint upload helper failed for ${artifactName}: `
        + `${result.stderr || result.stdout || result.status}`,
      );
    }
    return { store: "helper", artifactName };
  };
}

function requireGoCode(command) {
  const raw = process.env.CC06_PUBLISH_EXECUTE_CODE || "";
  if (!GO_CODE_RE.test(raw)) {
    throw new Error(
      `${command} refuses without CC06_PUBLISH_EXECUTE_CODE=C6-<8 hex chars>; `
      + "bare GO-cc06-A1-publish is not a go",
    );
  }
  const hex = raw.slice(3).toLowerCase();
  return `C6-${hex}`;
}

function refuseWindowOverlap() {
  // Soft guard: refuse live publish/cleanup during the frozen cc-05 attach window
  // on 2026-10-20 (06:30Z–09:00Z inclusive of buffer). Override only with
  // CC06_ALLOW_WINDOW_OVERLAP=1 for non-production drills.
  if (process.env.CC06_ALLOW_WINDOW_OVERLAP === "1") return;
  const now = Date.now();
  const start = Date.parse("2026-10-20T06:30:00.000Z");
  const end = Date.parse("2026-10-20T09:00:00.000Z");
  if (Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end) {
    throw new Error(
      "refusing cc-06 provider mutation during frozen cc-05 window buffer "
      + "(2026-10-20T06:30Z..09:00Z); finish before 06:30Z or run after the window",
    );
  }
}

function writeJson(path, value) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const command = process.argv[2];
if (!command || hasFlag("--help") || hasFlag("-h")) {
  console.log(usage());
  process.exit(command ? 0 : 2);
}

const revision = arg("--revision");
if (!revision && command !== "dry-run-readback") {
  console.error("--revision <40-hex> is required");
  console.error(usage());
  process.exit(2);
}

const outPath = arg("--out");
const activeRevision = arg("--active");
const rollbackRevision = arg("--rollback");

if (command === "plan") {
  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: revision,
    materializations,
    active_revision: activeRevision,
    rollback_revision: rollbackRevision,
  });
  const summary = {
    schema: plan.schema,
    decision: plan.decision,
    deployed_revision: plan.deployed_revision,
    control_routes: plan.control_routes,
    lookup_routes: plan.lookup_routes,
    planned: plan.planned,
    shards: plan.shards.map((shard) => ({
      route: shard.route,
      key: shard.key,
      value_sha256: shard.value_sha256,
      row_count: shard.row_count,
    })),
    activation: plan.activation,
    abort_rules: plan.abort_rules,
    financial_savings_claimed: false,
  };
  writeJson(outPath, summary);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

if (command === "prepare-intent" || command === "dry-run") {
  const intentPath = arg("--intent");
  if (!intentPath) throw new Error("--intent is required");
  const purpose = command === "dry-run" ? "dry-run" : "prepare";
  const attemptId = arg("--attempt-id") || `attempt-local-${Date.now()}-cc06-${purpose}`;
  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: revision,
    materializations,
    active_revision: activeRevision,
    rollback_revision: rollbackRevision,
  });
  const intent = buildWarehouseRouteScopedPublishIntent({
    plan,
    attempt_id: attemptId,
    purpose,
    // No provider GET on dry-run/prepare; baseline_absence stays null until
    // probe-baseline / publish records real pre-write GETs.
    baseline_absence: null,
  });
  persistWarehouseRouteScopedPublishIntent(intentPath, intent);
  const verification = verifyWarehouseRouteScopedPublishIntent(intent, { plan });
  const receipt = {
    schema: "cityscroll.warehouse_route_scoped_publication_receipt.v1",
    decision: command === "dry-run" ? "dry-run-intent-ready" : "intent-prepared",
    mode: command === "dry-run" ? "dry-run" : "prepare-intent",
    purpose,
    deployed_revision: intent.deployed_revision,
    attempt_id: attemptId,
    intent_path: intentPath,
    planned: plan.planned,
    verification,
    shards: intent.shards.map((shard) => ({
      route: shard.route,
      key: shard.key,
      value_sha256: shard.value_sha256,
      row_count: shard.row_count,
      phase: shard.phase,
    })),
    provider_writes: 0,
    activation: plan.activation,
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
  };
  writeJson(outPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(0);
}

if (command === "probe-baseline") {
  const intentPath = arg("--intent");
  if (!intentPath) throw new Error("--intent is required for probe-baseline");
  const intent = loadWarehouseRouteScopedPublishIntent(intentPath);
  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: revision,
    materializations,
    active_revision: activeRevision,
    rollback_revision: rollbackRevision,
  });
  verifyWarehouseRouteScopedPublishIntent(intent, { plan, require_values: true });
  // Promote to publish purpose once we are about to bind a real attempt.
  const attemptId = arg("--attempt-id") || intent.attempt_id;
  if (!attemptId) throw new Error("probe-baseline requires --attempt-id (unique publish attempt)");
  intent.purpose = "publish";
  intent.attempt_id = attemptId;
  const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
  const baseline = await probeWarehouseRouteScopedBaselineAbsence({ plan, invoke });
  intent.baseline_absence = baseline;
  persistWarehouseRouteScopedPublishIntent(intentPath, intent);
  const receipt = {
    schema: "cityscroll.warehouse_route_scoped_publication_receipt.v1",
    decision: baseline.all_absent ? "baseline-absent" : "baseline-blocked",
    mode: "probe-baseline",
    purpose: intent.purpose,
    attempt_id: attemptId,
    deployed_revision: intent.deployed_revision,
    baseline_absence: baseline,
    provider_writes: 0,
    kv_reads: baseline.kv_reads,
  };
  writeJson(outPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  try {
    assertBaselineAbsenceAllowsPublish(baseline);
  } catch (error) {
    process.exit(2);
  }
  process.exit(0);
}

if (command === "write-issued-checkpoint") {
  refuseWindowOverlap();
  const goCode = requireGoCode("write-issued-checkpoint");
  const intentPath = arg("--intent");
  const ledgerPath = arg("--ledger");
  const checkpointPath = arg("--checkpoint");
  const route = arg("--route");
  const attemptId = arg("--attempt-id");
  if (!intentPath || !ledgerPath || !checkpointPath || !route || !attemptId) {
    throw new Error("write-issued-checkpoint requires --intent --ledger --checkpoint --route --attempt-id");
  }
  if (!WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.includes(route)) {
    throw new Error(`route must be one of ${WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES.join(", ")}`);
  }
  const intent = loadWarehouseRouteScopedPublishIntent(intentPath);
  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: revision,
    materializations,
    active_revision: activeRevision,
    rollback_revision: rollbackRevision,
  });
  verifyWarehouseRouteScopedPublishIntent(intent, { plan, require_values: true });
  if (intent.purpose !== "publish") {
    throw new Error("write-issued-checkpoint requires purpose=publish intent (run probe-baseline first)");
  }
  intent.attempt_id = attemptId;
  const shard = plan.shards.find((row) => row.route === route);
  if (!shard) throw new Error(`plan missing route ${route}`);
  assertBaselineAbsenceAllowsPublish(intent.baseline_absence);

  let ledger;
  try {
    ledger = loadShardPublicationLedger(ledgerPath);
  } catch {
    ledger = makeShardPublicationLedger({
      attempt_id: attemptId,
      deployed_revision: plan.deployed_revision,
      active_revision: plan.active_revision,
      rollback_revision: plan.rollback_revision,
    });
  }
  ledger.attempt_id = attemptId;
  const at = new Date().toISOString();
  const entry = makeShardPublicationEntry({
    route: shard.route,
    key: shard.key,
    deployed_revision: shard.deployed_revision,
  });
  markShardIssued(entry, { value: shard.value, value_sha256: shard.value_sha256 }, at);
  ledger.entries[shard.key] = entry;
  persistShardPublicationLedger(ledgerPath, ledger, { nowIso: () => at });
  markIntentShardIssued(intent, shard.key, {
    value: shard.value,
    value_sha256: shard.value_sha256,
  }, at);
  persistWarehouseRouteScopedPublishIntent(intentPath, intent);

  const checkpoint = buildIssuedCheckpoint({
    attempt_id: attemptId,
    route: shard.route,
    key: shard.key,
    deployed_revision: shard.deployed_revision,
    value: shard.value,
    value_sha256: shard.value_sha256,
    issued_at: at,
    row_count: shard.row_count,
  });
  persistIssuedCheckpoint(checkpointPath, checkpoint);
  const receipt = {
    schema: "cityscroll.warehouse_route_scoped_publication_receipt.v1",
    decision: "issued-checkpoint-written",
    mode: "write-issued-checkpoint",
    go_code: goCode,
    attempt_id: attemptId,
    route,
    key: shard.key,
    value_sha256: shard.value_sha256,
    issued_at: at,
    checkpoint_path: checkpointPath,
    artifact_name: issuedCheckpointArtifactName(route),
    provider_writes: 0,
  };
  writeJson(outPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(0);
}

if (command === "put-one") {
  refuseWindowOverlap();
  const goCode = requireGoCode("put-one");
  const intentPath = arg("--intent");
  const ledgerPath = arg("--ledger");
  const checkpointPath = arg("--checkpoint");
  const route = arg("--route");
  const attemptId = arg("--attempt-id");
  if (!intentPath || !ledgerPath || !checkpointPath || !route || !attemptId) {
    throw new Error("put-one requires --intent --ledger --checkpoint --route --attempt-id");
  }
  const intent = loadWarehouseRouteScopedPublishIntent(intentPath);
  const checkpoint = loadIssuedCheckpoint(checkpointPath);
  verifyIssuedCheckpoint(checkpoint, { intent });
  if (checkpoint.route !== route) {
    throw new Error(`checkpoint route ${checkpoint.route} != --route ${route}`);
  }
  if (checkpoint.attempt_id !== attemptId) {
    throw new Error("checkpoint attempt_id does not match --attempt-id");
  }
  const ledger = loadShardPublicationLedger(ledgerPath);
  const entry = ledger.entries?.[checkpoint.key];
  if (!entry?.issued_at) {
    throw new Error(`ledger missing issued marker for ${checkpoint.key}`);
  }
  const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
  const tempDir = join(dirname(checkpointPath), ".put-one-tmp");
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const bodyPath = join(tempDir, `${route}.json`);
  writeFileSync(bodyPath, checkpoint.value, { mode: 0o600 });
  try {
    await invoke([
      "kv", "key", "put", checkpoint.key,
      "--path", bodyPath,
      "--binding", "ALERT_STATE",
      "--remote",
      "--config", "worker/wrangler.toml",
    ]);
    const ackedAt = new Date().toISOString();
    markShardAcked(entry, ackedAt);
    persistShardPublicationLedger(ledgerPath, ledger, { nowIso: () => ackedAt });
    markIntentShardAcked(intent, checkpoint.key, ackedAt);
    persistWarehouseRouteScopedPublishIntent(intentPath, intent);
    const receipt = {
      schema: "cityscroll.warehouse_route_scoped_publication_receipt.v1",
      decision: "put-one-acked",
      mode: "put-one",
      go_code: goCode,
      attempt_id: attemptId,
      route,
      key: checkpoint.key,
      value_sha256: checkpoint.value_sha256,
      phase: "acked",
      provider_writes: 1,
    };
    writeJson(outPath, receipt);
    console.log(JSON.stringify(receipt, null, 2));
  } catch (error) {
    const unknownAt = new Date().toISOString();
    markShardUnknown(entry, error?.message || error, unknownAt);
    persistShardPublicationLedger(ledgerPath, ledger, { nowIso: () => unknownAt });
    markIntentShardUnknown(intent, checkpoint.key, error?.message || error, unknownAt);
    persistWarehouseRouteScopedPublishIntent(intentPath, intent);
    throw error;
  }
  process.exit(0);
}

if (command === "dry-run-readback") {
  const intentPath = arg("--intent");
  if (!intentPath) throw new Error("--intent is required for dry-run-readback");
  const intent = loadWarehouseRouteScopedPublishIntent(intentPath);
  let plan = null;
  if (revision) {
    const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
    plan = planWarehouseRouteScopedPublication({
      deployed_revision: revision,
      materializations,
      active_revision: activeRevision,
      rollback_revision: rollbackRevision,
    });
  }
  const verification = verifyWarehouseRouteScopedPublishIntent(intent, {
    plan,
    require_values: true,
  });
  const receipt = {
    schema: "cityscroll.warehouse_route_scoped_publication_receipt.v1",
    decision: "dry-run-readback-verified",
    mode: "dry-run-readback",
    deployed_revision: intent.deployed_revision,
    attempt_id: intent.attempt_id,
    intent_path: intentPath,
    verification,
    provider_writes: 0,
    financial_savings_confirmed: false,
    shipped_savings_claimed: false,
  };
  writeJson(outPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  process.exit(0);
}

if (command === "preflight-readonly") {
  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  let liveShardValues = null;
  if (hasFlag("--live-kv")) {
    const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
    liveShardValues = {};
    for (const route of WAREHOUSE_ROUTE_SCOPED_LOOKUP_ROUTES) {
      const key = warehouseRouteScopedShardKey(route, revision.toLowerCase());
      try {
        const result = await invoke([
          "kv", "key", "get", key,
          "--binding", "ALERT_STATE",
          "--remote",
          "--config", "worker/wrangler.toml",
          "--text",
        ]);
        const text = String(result?.stdout || "").trim();
        liveShardValues[key] = (!text || text === "Value not found") ? null : text;
      } catch (error) {
        const providerText = `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`;
        if (/\b404:?\s+Not Found\b/.test(providerText) || /\bValue not found\b/i.test(providerText)) {
          liveShardValues[key] = null;
        } else {
          throw error;
        }
      }
    }
  }

  const report = preflightWarehouseRouteScopedPublicationReadonly({
    deployed_revision: revision,
    materializations,
    live_shard_values: liveShardValues,
    flag_binding_present: null,
    health_commit: arg("--health-commit"),
    control_routes: [...WAREHOUSE_ROUTE_SCOPED_CONTROL_ROUTES],
  });
  writeJson(outPath, report);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.outcome === "preflight-readonly-passed" ? 0 : 1);
}

/**
 * Load externally uploaded per-key issued checkpoints from a directory
 * (CI download-artifact merge of cc06-route-scoped-issued-* artifacts).
 */
function loadCheckpointsFromDir(checkpointDir) {
  if (!checkpointDir) return [];
  const checkpoints = [];
  const stack = [checkpointDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const checkpoint = loadIssuedCheckpoint(full);
        verifyIssuedCheckpoint(checkpoint);
        checkpoints.push(checkpoint);
      } catch {
        // Skip non-checkpoint JSON (receipts, summaries).
      }
    }
  }
  return checkpoints;
}

if (command === "publish") {
  refuseWindowOverlap();
  const goCode = requireGoCode("publish");
  const ledgerPath = arg("--ledger");
  const attemptId = arg("--attempt-id");
  const checkpointDir = arg("--checkpoint-dir");
  if (!ledgerPath) throw new Error("--ledger is required for publish");
  if (!attemptId) throw new Error("--attempt-id is required for publish");

  const materializations = loadWarehouseRouteScopedMaterializations({ root: ROOT });
  const plan = planWarehouseRouteScopedPublication({
    deployed_revision: revision,
    materializations,
    active_revision: activeRevision,
    rollback_revision: rollbackRevision,
  });
  const intentPath = arg("--intent");
  let intent = null;
  if (intentPath) {
    intent = loadWarehouseRouteScopedPublishIntent(intentPath);
    verifyWarehouseRouteScopedPublishIntent(intent, { plan, require_values: true });
    intent.purpose = "publish";
    intent.attempt_id = attemptId;
  } else {
    intent = buildWarehouseRouteScopedPublishIntent({
      plan,
      attempt_id: attemptId,
      purpose: "publish",
    });
  }
  // External durability: each issued checkpoint must leave the runner before PUT.
  const uploadIssuedCheckpoint = createCheckpointUploader({
    storeDir: checkpointDir || process.env.CC06_CHECKPOINT_STORE_DIR || null,
  });
  const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
  try {
    const receipt = await publishWarehouseRouteScopedShards({
      plan,
      invoke,
      ledgerPath,
      attempt_id: attemptId,
      intent,
      intentPath: intentPath || null,
      uploadIssuedCheckpoint,
      checkpointDir: checkpointDir || null,
    });
    const out = { ...receipt, go_code: goCode, ledger: undefined, intent: undefined };
    // Persist full ledger separately; stdout keeps receipt without raw shard bodies.
    persistShardPublicationLedger(ledgerPath, receipt.ledger);
    if (intentPath) persistWarehouseRouteScopedPublishIntent(intentPath, intent);
    writeJson(outPath, out);
    console.log(JSON.stringify({
      schema: out.schema,
      decision: out.decision,
      deployed_revision: out.deployed_revision,
      planned: out.planned,
      attempted: out.attempted,
      confirmed: out.confirmed,
      shards: out.shards,
      go_code: goCode,
      activation: out.activation,
    }, null, 2));
  } catch (error) {
    if (error?.publication_receipt) {
      console.error(JSON.stringify(error.publication_receipt));
    }
    throw error;
  }
  process.exit(0);
}

if (command === "cleanup") {
  refuseWindowOverlap();
  const goCode = requireGoCode("cleanup");
  const ledgerPath = arg("--ledger");
  const intentPath = arg("--intent");
  const checkpointDir = arg("--checkpoint-dir");
  if (!intentPath && !checkpointDir && !ledgerPath) {
    throw new Error(
      "cleanup requires --intent + --checkpoint-dir (preferred; works with no final artifact), "
      + "or a ledger recovered from external issued checkpoints",
    );
  }

  let ledger = null;
  let ownedValues = {};
  let ownershipSource = null;
  let plannedUnissued = [];

  // Preferred durable path: initial intent + externally uploaded per-key checkpoints.
  // Works when the publisher died before any final receipt/ledger artifact.
  if (intentPath && checkpointDir) {
    const intent = loadWarehouseRouteScopedPublishIntent(intentPath);
    const checkpoints = loadCheckpointsFromDir(checkpointDir);
    const ownership = mergeOwnershipFromIntentAndCheckpoints({ intent, checkpoints });
    ownedValues = ownership.owned_values;
    ledger = ownership.ledger;
    ownershipSource = ownership.status;
    plannedUnissued = [...ownership.planned_unissued_keys];
    if (ledgerPath) {
      persistShardPublicationLedger(ledgerPath, ledger);
    }
  } else if (checkpointDir && !intentPath) {
    throw new Error("cleanup --checkpoint-dir requires --intent (initial publish intent artifact)");
  } else if (ledgerPath) {
    // Ledger must itself have been recovered from external checkpoints / prior
    // durable ownership — local invent-from-intent alone is refused below.
    try {
      ledger = loadShardPublicationLedger(ledgerPath);
      for (const [key, entry] of Object.entries(ledger.entries || {})) {
        if (entry?.value && entry?.issued_at && (entry.phase === "issued" || entry.phase === "acked" || entry.phase === "unknown")) {
          ownedValues[key] = entry.value;
        }
      }
      if (Object.keys(ownedValues).length > 0) ownershipSource = "ledger";
    } catch (error) {
      throw error;
    }
  }

  // Refuse local-only intent markers: they are not durable across runner death.
  if (intentPath && !checkpointDir && Object.keys(ownedValues).length === 0) {
    throw new Error(
      "cleanup refuses local-only intent markers; provide --checkpoint-dir with "
      + "externally uploaded per-key issued checkpoints (cc06-route-scoped-issued-*)",
    );
  }

  if (!ledger || Object.keys(ownedValues).length === 0) {
    throw new Error(
      "cleanup refuses: no publish-owned issued keys from external checkpoints "
      + "(need intent + per-key issued checkpoint artifacts; final receipt optional)",
    );
  }

  const plan = planWarehouseRouteScopedCleanup({
    deployed_revision: revision,
    owned_entries: ledger.entries,
    active_revision: activeRevision || ledger.active_revision,
    rollback_revision: rollbackRevision || ledger.rollback_revision,
  });
  const invoke = createWranglerInvoker({ cwd: ROOT, wranglerVersion: "4.126.0" });
  try {
    const receipt = await cleanupWarehouseRouteScopedShards({
      plan,
      invoke,
      owned_values: ownedValues,
      ledger,
      ledgerPath,
    });
    writeJson(outPath, {
      ...receipt,
      go_code: goCode,
      ownership_source: ownershipSource,
      planned_unissued_keys: plannedUnissued,
      ledger: undefined,
    });
    console.log(JSON.stringify({
      schema: receipt.schema,
      decision: receipt.decision,
      reason: receipt.reason || null,
      deployed_revision: receipt.deployed_revision,
      planned: receipt.planned,
      attempted: receipt.attempted,
      confirmed: receipt.confirmed,
      actions: receipt.actions,
      ownership_source: ownershipSource,
      planned_unissued_keys: plannedUnissued,
      go_code: goCode,
    }, null, 2));
  } catch (error) {
    if (error?.publication_receipt) {
      console.error(JSON.stringify(error.publication_receipt));
    }
    throw error;
  }
  process.exit(0);
}

console.error(usage());
process.exit(2);
