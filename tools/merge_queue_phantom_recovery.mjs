#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const RECEIPT_SCHEMA = "cityscroll.merge_queue_phantom_recovery.v1";
export const RECOVERY_KIND = "exact-signature-phantom-queue";
export const MERGE_METHOD = "SQUASH";
export const REQUIRED_CHECKS = Object.freeze([
  "Unit tests (site + worker)",
  "Accessibility + language gate (axe on every PR)",
  "Reading-level ratchet gate (readable-or-else)",
]);

const GREEN = new Set(["SUCCESS", "PASSED"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);
const RED = new Set(["FAILURE", "FAILED", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);

export class PhantomRecoveryError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = "PhantomRecoveryError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PhantomRecoveryError(code, message, details);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function upper(value) {
  return String(value ?? "").trim().toUpperCase();
}

function field(object, ...names) {
  return names.map((name) => object?.[name]).find((value) => value !== undefined && value !== null);
}

function pullHead(pr) {
  return field(pr, "headRefOid", "head_sha", "headSha", "head")?.sha
    || field(pr, "headRefOid", "head_sha", "headSha")
    || pr?.head?.oid;
}

function pullNumber(pr) {
  return Number(field(pr, "number", "pullNumber"));
}

function pullId(pr) {
  return field(pr, "id", "pullRequestId");
}

function mergeState(pr) {
  return upper(field(pr, "mergeStateStatus", "merge_state_status", "mergeableState"));
}

function mergeability(pr) {
  return upper(field(pr, "mergeable", "mergeability"));
}

function intentOf(pr) {
  return field(pr, "standingMergeIntent", "standing_merge_intent", "autoMergeRequest", "auto_merge");
}

function checkRows(pr) {
  const rows = field(pr, "requiredChecks", "required_checks", "checks", "statusChecks");
  return Array.isArray(rows) ? rows : [];
}

function checkName(row) {
  return String(field(row, "name", "context", "checkName") ?? "");
}

function checkState(row) {
  return upper(field(row, "conclusion", "state", "status"));
}

function checkSummary(pr) {
  const rows = checkRows(pr);
  const byName = new Map(rows.map((row) => [checkName(row), row]));
  const missing = REQUIRED_CHECKS.filter((name) => !byName.has(name));
  const pending = [];
  const failing = [];
  const unstable = [];
  for (const name of REQUIRED_CHECKS) {
    const row = byName.get(name);
    if (!row) continue;
    const state = checkState(row);
    if (row.stable === false || row.unstable === true || upper(row.status) === "UNSTABLE") unstable.push(name);
    if (PENDING.has(state) || PENDING.has(upper(row.status))) pending.push(name);
    else if (RED.has(state)) failing.push(name);
    else if (!GREEN.has(state)) unstable.push(name);
  }
  if (pr.checksStable === false || pr.checks_stable === false) unstable.push("checks");
  return {
    missing: [...new Set(missing)],
    pending: [...new Set(pending)],
    failing: [...new Set(failing)],
    unstable: [...new Set(unstable)],
  };
}

function batchHead(batch) {
  return field(batch, "headSha", "head_sha", "headRefOid", "head_oid", "sha")
    || batch?.head?.sha || batch?.head?.oid;
}

function batchNumber(batch) {
  const value = field(batch, "pullNumber", "pull_number", "prNumber", "pr_number", "number");
  return value === undefined ? null : Number(value);
}

function batchIdentity(batch) {
  return String(field(batch, "id", "batchId", "batch_id") ?? digest(batch));
}

function exactBatches(batches, target) {
  return (Array.isArray(batches) ? batches : []).filter((batch) => {
    const headMatches = String(batchHead(batch) || "").toLowerCase() === target.headSha.toLowerCase();
    const number = batchNumber(batch);
    return headMatches && (number === null || number === target.pullNumber);
  });
}

function targetFrom(input) {
  const target = {
    owner: String(input?.owner || ""),
    repo: String(input?.repo || ""),
    pullNumber: Number(input?.pullNumber),
    headSha: String(input?.headSha || ""),
  };
  if (!target.owner || !target.repo || !Number.isInteger(target.pullNumber) || target.pullNumber <= 0 || !target.headSha) {
    fail("INVALID_TARGET", "owner, repo, pullNumber, and headSha are required");
  }
  return target;
}

function signatureFor(target, checks) {
  return digest({
    kind: RECOVERY_KIND,
    owner: target.owner,
    repo: target.repo,
    pullNumber: target.pullNumber,
    headSha: target.headSha,
    requiredChecks: checks,
  });
}

function assertInitialState(pr, target) {
  if (pullNumber(pr) !== target.pullNumber) fail("PR_MISMATCH", "adapter returned a different pull request");
  if (!pullId(pr)) fail("MISSING_PR_ID", "adapter did not return the pull request node id");
  if (pullHead(pr) !== target.headSha) fail("CHANGED_HEAD", "pull request head does not match the exact target SHA");
  if (upper(field(pr, "baseRefName", "base_ref")) !== "MAIN") fail("WRONG_BASE", "pull request does not target main");
  if (upper(field(pr, "state")) !== "OPEN") fail("CLOSED_PR", "pull request is not open");
  if (pr.isDraft === true || pr.draft === true) fail("DRAFT_PR", "draft pull requests cannot be recovered");

  const state = mergeState(pr);
  if (state === "CONFLICTING" || state === "DIRTY") fail("CONFLICTING", `merge state is ${state}`);
  if (state === "UNKNOWN" || !state) fail("UNKNOWN_MERGE_STATE", "merge state is unknown");
  if (state !== "CLEAN") fail("MERGE_STATE_NOT_CLEAN", `merge state is ${state}`);
  const mergeable = mergeability(pr);
  if (mergeable === "CONFLICTING") fail("CONFLICTING", "pull request is conflicting");
  if (mergeable === "UNKNOWN" || !mergeable) fail("UNKNOWN_MERGEABILITY", "mergeability is unknown");
  if (mergeable !== "MERGEABLE") fail("NOT_MERGEABLE", `mergeability is ${mergeable}`);

  const intent = intentOf(pr);
  if (!intent || intent.enabled === false || upper(intent.state) === "DISABLED") {
    fail("MISSING_INTENT", "standing merge intent is absent or disabled");
  }
  const method = upper(field(intent, "mergeMethod", "merge_method", "method"));
  if (method && method !== MERGE_METHOD) fail("POLICY_MISMATCH", `standing merge intent uses ${method}`);
  if (pr.isInMergeQueue === true || pr.is_in_merge_queue === true) fail("ALREADY_QUEUED", "pull request is already in the merge queue");

  const checks = checkSummary(pr);
  if (checks.failing.length) fail("FAILING_CHECKS", `required checks are red: ${checks.failing.join(", ")}`, checks);
  if (checks.pending.length) fail("PENDING_CHECKS", `required checks are pending: ${checks.pending.join(", ")}`, checks);
  if (checks.missing.length) fail("MISSING_CHECKS", `required checks are missing: ${checks.missing.join(", ")}`, checks);
  if (checks.unstable.length) fail("UNSTABLE_CHECKS", `required checks are unstable: ${checks.unstable.join(", ")}`, checks);
  return checks;
}

function assertHead(pr, target, phase) {
  if (pullNumber(pr) !== target.pullNumber || pullHead(pr) !== target.headSha) {
    fail("CHANGED_HEAD", `pull request head changed ${phase}`);
  }
}

function requireAdapter(adapter) {
  const methods = ["getPullRequest", "listMergeQueueBatches", "dequeuePullRequest", "enableAutoMerge", "getAuditReceipt", "recordAuditReceipt"];
  for (const method of methods) if (typeof adapter?.[method] !== "function") fail("INVALID_ADAPTER", `adapter is missing ${method}()`);
}

/**
 * Run one exact-signature recovery. The adapter is deliberately injectable so a
 * GraphQL client can supply normalized snapshots and durable audit storage in
 * production, while fixtures can prove every transition without network access.
 */
export async function recoverPhantomMergeQueue({ input, adapter }) {
  requireAdapter(adapter);
  const target = targetFrom(input);
  // Check the durable target index before reading mutable GitHub state. A
  // successful prior run is necessarily queued now, so replay protection must
  // win over the normal already-queued guard on subsequent invocations.
  const priorReceipt = await adapter.getAuditReceipt({ target });
  if (priorReceipt) fail("REPLAYED_SIGNATURE", "an audit receipt already exists for this exact PR/head target");
  const initial = await adapter.getPullRequest(target);
  const checks = assertInitialState(initial, target);
  const signature = signatureFor(target, checks);
  const existingReceipt = await adapter.getAuditReceipt({ signature, target });
  if (existingReceipt) fail("REPLAYED_SIGNATURE", "an audit receipt already exists for this exact PR/head signature");

  const beforeBatches = await adapter.listMergeQueueBatches(target);
  const activeBefore = exactBatches(beforeBatches, target);
  if (activeBefore.length) fail("ACTIVE_BATCH", "an exact-head merge-queue batch already exists", { batchIds: activeBefore.map(batchIdentity) });

  await adapter.dequeuePullRequest({ pullRequestId: pullId(initial), ...target, signature });
  const afterDequeue = await adapter.getPullRequest(target);
  assertHead(afterDequeue, target, "after dequeue");
  if (afterDequeue.isInMergeQueue !== false) fail("DEQUEUE_NOT_CONFIRMED", "dequeue did not clear queue membership");

  await adapter.enableAutoMerge({ pullRequestId: pullId(afterDequeue), mergeMethod: MERGE_METHOD, ...target, signature });
  const final = await adapter.getPullRequest(target);
  assertHead(final, target, "after re-enqueue");
  if (final.isInMergeQueue !== true) fail("QUEUE_MEMBERSHIP_NOT_CONFIRMED", "re-enqueue did not establish queue membership");
  const afterBatches = await adapter.listMergeQueueBatches(target);
  const beforeIds = new Set((Array.isArray(beforeBatches) ? beforeBatches : []).map(batchIdentity));
  const newBatches = exactBatches(afterBatches, target).filter((batch) => !beforeIds.has(batchIdentity(batch)));
  if (!newBatches.length) fail("MISSING_NEW_BATCH", "no new same-head merge-queue batch receipt was observed");
  if (newBatches.length !== 1) fail("AMBIGUOUS_NEW_BATCH", "more than one new same-head batch receipt was observed");

  const batch = newBatches[0];
  const receipt = {
    schema: RECEIPT_SCHEMA,
    kind: RECOVERY_KIND,
    signature,
    target,
    preconditions: {
      mergeStateStatus: mergeState(initial),
      mergeable: mergeability(initial),
      standingMergeIntent: true,
      isInMergeQueue: false,
      exactHeadBatchCount: activeBefore.length,
      requiredChecks: REQUIRED_CHECKS,
    },
    transition: {
      dequeuePullRequest: 1,
      enableAutoMerge: 1,
      mergeMethod: MERGE_METHOD,
    },
    result: {
      isInMergeQueue: true,
      headSha: pullHead(final),
      batchId: batchIdentity(batch),
    },
  };
  receipt.receiptId = digest(receipt);
  const recorded = await adapter.recordAuditReceipt(receipt);
  if (recorded && recorded.signature && recorded.signature !== receipt.signature) {
    fail("AUDIT_CONFLICT", "audit store returned a different signature");
  }
  return receipt;
}

function fixtureAdapter(scenario) {
  const operations = [];
  let phase = "initial";
  let storedReceipt = scenario.auditReceipt || null;
  return {
    operations,
    async getPullRequest() {
      const phaseState = phase === "initial" ? scenario.pullRequest : phase === "dequeued" ? scenario.afterDequeue : scenario.afterEnqueue;
      return { ...scenario.pullRequest, ...phaseState };
    },
    async listMergeQueueBatches() {
      return phase === "initial" || phase === "dequeued" ? (scenario.batches || []) : (scenario.afterBatches || []);
    },
    async getAuditReceipt() {
      return storedReceipt;
    },
    async dequeuePullRequest() {
      operations.push("dequeuePullRequest");
      phase = "dequeued";
    },
    async enableAutoMerge() {
      operations.push("enableAutoMerge");
      phase = "enqueued";
    },
    async recordAuditReceipt(receipt) {
      operations.push("recordAuditReceipt");
      if (!storedReceipt) storedReceipt = receipt;
      return storedReceipt;
    },
  };
}

export function createFixtureAdapter(scenario) {
  return fixtureAdapter(scenario);
}

async function runFixture(path) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  const adapter = fixtureAdapter(fixture.positive);
  const receipt = await recoverPhantomMergeQueue({ input: fixture.positive.target, adapter });
  if (canonical(receipt) !== canonical(fixture.positive.expectedReceipt)) fail("FIXTURE_RECEIPT_MISMATCH", "positive receipt is not deterministic");
  if (canonical(adapter.operations) !== canonical(["dequeuePullRequest", "enableAutoMerge", "recordAuditReceipt"])) fail("FIXTURE_TRANSITION_MISMATCH", "positive fixture did not perform exactly one transition");
  for (const negativeCase of fixture.negativeCases || []) {
    const requiredCheckPatch = negativeCase.requiredCheck || null;
    const requiredChecks = requiredCheckPatch
      ? fixture.positive.pullRequest.requiredChecks.map((check, index) => index === 0 ? { ...check, ...requiredCheckPatch } : check)
      : fixture.positive.pullRequest.requiredChecks;
    const scenario = {
      ...fixture.positive,
      ...negativeCase,
      pullRequest: { ...fixture.positive.pullRequest, requiredChecks, ...(negativeCase.pullRequest || {}) },
      batches: negativeCase.batches || [],
      afterBatches: negativeCase.afterBatches || fixture.positive.afterBatches,
    };
    const negativeAdapter = fixtureAdapter(scenario);
    try {
      await recoverPhantomMergeQueue({ input: scenario.target, adapter: negativeAdapter });
      fail("FIXTURE_NEGATIVE_PASSED", `${negativeCase.name} unexpectedly passed`);
    } catch (error) {
      if (!(error instanceof PhantomRecoveryError) || error.code !== negativeCase.errorCode) throw error;
    }
    if (negativeAdapter.operations.length) fail("FIXTURE_NEGATIVE_MUTATED", `${negativeCase.name} performed a mutation`);
  }
  return { schema: RECEIPT_SCHEMA, positive: receipt.receiptId, negativeCases: (fixture.negativeCases || []).length };
}

async function main() {
  const fixtureIndex = process.argv.indexOf("--fixture");
  if (fixtureIndex >= 0) {
    const result = await runFixture(process.argv[fixtureIndex + 1]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new Error("live recovery requires an injected GraphQL adapter; use --fixture for the deterministic gate");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
}
