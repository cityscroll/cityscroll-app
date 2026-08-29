#!/usr/bin/env node

/**
 * Decide and receipt one bounded rerun for a corpus-known flaky check.
 *
 * This is deliberately a policy projection, not a GitHub mutator. The
 * existing CI fresh-runner job remains the executor; this tool joins its
 * primary/retry evidence to MT-1's attempt and required-check receipts.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTelemetry } from "./merge_throughput_telemetry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_SCHEMA = "cityscroll.merge-throughput.known-flake-signatures.v1";
const SOURCE_SCHEMA = "cityscroll.merge-throughput.known-flake-source.v1";
const RECEIPT_SCHEMA = "cityscroll.merge-throughput.known-flake-rerun.receipt.v1";
const TELEMETRY_ATTEMPT_SCHEMA = "cityscroll.merge-throughput.merge-group-attempt-receipt.v1";
const TELEMETRY_CHECK_SCHEMA = "cityscroll.merge-throughput.required-check-receipt.v1";

function fail(message) {
  throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : canonicalJson(value));
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot read JSON ${file}: ${error.message}`);
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label}: expected a non-empty string`);
  return value;
}

function requireInteger(value, label, { minimum = 0 } = {}) {
  if (!Number.isInteger(value) || value < minimum) fail(`${label}: expected an integer >= ${minimum}`);
  return value;
}

function requireDuration(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${label}: expected a finite duration >= 0`);
  }
  return value;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${label}: expected a SHA-256 identity`);
  return value;
}

function optionalSha(value, label) {
  if (value != null) requireSha(value, label);
}

function validateRegistry(registry, corpus) {
  if (registry?.schema !== REGISTRY_SCHEMA) fail(`invalid registry schema: expected ${REGISTRY_SCHEMA}`);
  if (registry.corpus?.path !== "data/incident-corpus.json") fail("registry must name the MT-0 corpus");
  const incident = corpus.incidents?.find((row) => row.id === registry.corpus.incident_id);
  if (!incident || incident.class !== "flaky-shard-ejection") fail("registry corpus incident is not a corpus-known flaky incident");
  if (registry.corpus.corpus_signature_id !== incident.signature?.id) fail("registry must preserve the corpus signature lineage");
  requireString(registry.corpus.derivation, "registry.corpus.derivation");
  if (!Array.isArray(registry.corpus.history_refs) || registry.corpus.history_refs.length === 0) {
    fail("registry must preserve corpus history references");
  }
  const historyRefs = new Set((corpus.history_records ?? []).map((row) => row.ref));
  for (const ref of registry.corpus.history_refs) {
    if (!historyRefs.has(ref)) fail(`registry history reference is absent from corpus: ${ref}`);
  }
  if (!Array.isArray(registry.signatures) || registry.signatures.length === 0) fail("registry signatures must be non-empty");
  const signatures = new Map();
  for (const [index, signature] of registry.signatures.entries()) {
    const label = `signatures[${index}]`;
    requireString(signature.id, `${label}.id`);
    if (signatures.has(signature.id)) fail(`${label}: duplicate signature id`);
    signatures.set(signature.id, signature);
    if (signature.class !== "flaky-shard-ejection") fail(`${label}.class: only flaky-shard-ejection is rerunnable`);
    requireString(signature.check, `${label}.check`);
    requireString(signature.failure_signature, `${label}.failure_signature`);
    requireString(signature.retry_job, `${label}.retry_job`);
    requireString(signature.runner, `${label}.runner`);
    if (signature.max_automatic_reruns !== 1) fail(`${label}.max_automatic_reruns must be exactly one`);
    if (signature.escalate_after_consistent_failures !== 3) fail(`${label}.escalate_after_consistent_failures must be exactly three`);
    requireString(signature.success_condition, `${label}.success_condition`);
  }
  return signatures;
}

function validateSource(source, signatures) {
  if (source?.schema !== SOURCE_SCHEMA) fail(`invalid source schema: expected ${SOURCE_SCHEMA}`);
  requireString(source.repository, "repository");
  requireString(source.source_run_id, "source_run_id");
  requireString(source.telemetry_source, "telemetry_source");
  if (!Array.isArray(source.observations) || source.observations.length === 0) fail("observations must be non-empty");
  const keys = new Set();
  for (const [index, observation] of source.observations.entries()) {
    const label = `observations[${index}]`;
    requireInteger(observation.pull_request, `${label}.pull_request`, { minimum: 1 });
    requireString(observation.check, `${label}.check`);
    requireInteger(observation.merge_group_attempt, `${label}.merge_group_attempt`, { minimum: 1 });
    requireInteger(observation.sequence, `${label}.sequence`, { minimum: 1 });
    const key = `${observation.pull_request}:${observation.check}:${observation.merge_group_attempt}`;
    if (keys.has(key)) fail(`${label}: duplicate PR/check/merge-group attempt`);
    keys.add(key);
    if (!signatures.has(observation.signature?.id) && observation.signature?.id == null) {
      fail(`${label}.signature.id: missing signature identity`);
    }
    if (!observation.original || typeof observation.original !== "object") fail(`${label}.original: missing result`);
    requireString(observation.original.result, `${label}.original.result`);
    requireString(observation.original.source_run_id, `${label}.original.source_run_id`);
    requireString(observation.original.failure_signature, `${label}.original.failure_signature`);
    optionalSha(observation.original.input_identity, `${label}.original.input_identity`);
    optionalSha(observation.original.artifact_identity, `${label}.original.artifact_identity`);
    requireDuration(observation.original.duration_seconds, `${label}.original.duration_seconds`);
    if (typeof observation.original.ejected !== "boolean") fail(`${label}.original.ejected: expected boolean`);
    if (observation.retry != null) {
      if (typeof observation.retry !== "object") fail(`${label}.retry: expected an object`);
      requireString(observation.retry.result, `${label}.retry.result`);
      requireString(observation.retry.source_run_id, `${label}.retry.source_run_id`);
      requireString(observation.retry.runner, `${label}.retry.runner`);
      requireString(observation.retry.job, `${label}.retry.job`);
      optionalSha(observation.retry.input_identity, `${label}.retry.input_identity`);
      optionalSha(observation.retry.artifact_identity, `${label}.retry.artifact_identity`);
      requireDuration(observation.retry.duration_seconds, `${label}.retry.duration_seconds`);
    }
    if (!observation.aggregate || typeof observation.aggregate !== "object") fail(`${label}.aggregate: missing success condition`);
    if (typeof observation.aggregate.other_required_checks_green !== "boolean") {
      fail(`${label}.aggregate.other_required_checks_green: expected boolean`);
    }
    requireInteger(observation.aggregate.required_check_count, `${label}.aggregate.required_check_count`, { minimum: 1 });
  }
  const sequence = source.observations.map((row) => row.sequence);
  if (new Set(sequence).size !== sequence.length || sequence.some((value, index) => value !== index + 1)) {
    fail("observations.sequence must be contiguous and deterministic");
  }
}

function loadTelemetry(source) {
  const telemetrySource = readJson(path.resolve(ROOT, source.telemetry_source));
  const telemetry = buildTelemetry(telemetrySource);
  if (telemetrySource.repository !== source.repository) fail("known-flake and MT-1 repositories do not match");
  const attempts = new Map(telemetry.attemptReceipts.map((row) => [`${row.pull_request}:${row.attempt}`, row]));
  const checks = new Map(telemetry.checkReceipts.map((row) => [`${row.pull_request}:${row.attempt}:${row.required_check}`, row]));
  return { telemetry, attempts, checks };
}

function classifyObservation(observation, signature, streakBefore) {
  const exactSignature = Boolean(signature)
    && observation.signature.class === signature.class
    && observation.signature.check === signature.check
    && observation.signature.failure_signature === signature.failure_signature
    && observation.original.failure_signature === signature.failure_signature
    && observation.original.result === "failure";
  const originalIdentitiesPresent = observation.original.input_identity != null
    && observation.original.artifact_identity != null;
  const retryIdentitiesStable = observation.retry == null
    || (observation.retry.input_identity != null
      && observation.retry.artifact_identity != null
      && observation.original.input_identity === observation.retry.input_identity
      && observation.original.artifact_identity === observation.retry.artifact_identity);
  const identitiesStable = exactSignature
    && originalIdentitiesPresent
    && retryIdentitiesStable;
  const retryExecutorMatches = exactSignature
    && (observation.retry == null
      || (observation.retry.runner === signature.runner && observation.retry.job === signature.retry_job));
  const bounded = signature != null && signature.max_automatic_reruns === 1;
  const escalated = exactSignature
    && streakBefore + 1 >= (signature?.escalate_after_consistent_failures ?? 3);
  const eligible = exactSignature && identitiesStable && retryExecutorMatches && bounded && !escalated;
  const retryCleared = eligible && observation.retry?.result === "success";
  const rerunRequested = eligible && observation.retry == null;
  const aggregateGreen = retryCleared
    && observation.aggregate.other_required_checks_green
    && observation.aggregate.required_check_count > 0;
  const reasons = [];
  if (!signature) reasons.push("signature is outside the corpus-derived registry");
  else if (!exactSignature) reasons.push("failure signature, class, or check does not exactly match the registry");
  if (!identitiesStable) reasons.push("source or browser-artifact identity changed or is missing");
  if (!retryExecutorMatches) reasons.push("retry is not the existing fresh-runner job");
  if (!bounded) reasons.push("automatic rerun budget is not one");
  if (escalated) reasons.push("three consistent failures reached the escalation boundary");
  if (eligible && observation.retry != null && observation.retry.result !== "success") reasons.push("retry did not satisfy the declared success result");
  if (retryCleared && !observation.aggregate.other_required_checks_green) reasons.push("another required check is not green");
  return {
    eligible,
    action: escalated
      ? "escalate_real_failure"
      : rerunRequested
        ? "request_auto_rerun_once"
        : eligible && retryCleared
          ? "classify_flaky_recovery"
          : eligible
            ? "surface_after_bounded_rerun"
            : "surface_without_auto_rerun",
    exact_signature_match: exactSignature,
    identities_unchanged: identitiesStable,
    fresh_runner_retry: retryExecutorMatches,
    rerun_count: eligible ? 1 : 0,
    rerun_requested: rerunRequested,
    retry_cleared_failure: retryCleared,
    required_aggregate_green: aggregateGreen,
    escalation: escalated,
    consistent_failure_streak: streakBefore + 1,
    reasons,
  };
}

function buildRerunReceipts(source, registry, joined) {
  const streaks = new Map();
  return [...source.observations].sort((a, b) => a.sequence - b.sequence).map((observation) => {
    const signature = registry.get(observation.signature?.id);
    const streakKey = `${observation.check}:${observation.signature?.id ?? "unknown"}`;
    const before = streaks.get(streakKey) ?? 0;
    const classification = classifyObservation(observation, signature, before);
    const consistentFailure = classification.exact_signature_match
      && observation.original.result === "failure"
      && (observation.retry == null || observation.retry.result === "failure");
    streaks.set(streakKey, consistentFailure ? before + 1 : 0);
    const attemptKey = `${observation.pull_request}:${observation.merge_group_attempt}`;
    const telemetryAttempt = joined.attempts.get(attemptKey);
    const telemetryCheck = joined.checks.get(`${attemptKey}:${observation.check}`);
    if (!telemetryAttempt) fail(`missing MT-1 attempt receipt for ${attemptKey}`);
    if (!telemetryCheck) fail(`missing MT-1 required-check receipt for ${attemptKey}:${observation.check}`);
    if (telemetryAttempt.schema !== TELEMETRY_ATTEMPT_SCHEMA || telemetryCheck.schema !== TELEMETRY_CHECK_SCHEMA) {
      fail(`unexpected MT-1 receipt schema for ${attemptKey}`);
    }
    if (telemetryCheck.status !== observation.original.result) {
      fail(`MT-1 original status does not match known-flake observation for ${attemptKey}:${observation.check}`);
    }
    if (telemetryCheck.source?.run_id !== observation.original.source_run_id) {
      fail(`MT-1 source run does not match known-flake observation for ${attemptKey}:${observation.check}`);
    }
    if (telemetryAttempt.ejection.count !== (observation.original.ejected ? 1 : 0)) {
      fail(`MT-1 ejection impact does not match known-flake observation for ${attemptKey}`);
    }
    return {
      schema: "cityscroll.merge-throughput.known-flake-rerun.v1",
      id: `pr-${observation.pull_request}-attempt-${observation.merge_group_attempt}-${observation.check}`,
      source_run_id: source.source_run_id,
      pull_request: observation.pull_request,
      check: observation.check,
      merge_group_attempt: observation.merge_group_attempt,
      sequence: observation.sequence,
      signature: {
        id: observation.signature?.id ?? null,
        registry_match: classification.exact_signature_match,
        class: observation.signature?.class ?? null,
        failure_signature: observation.signature?.failure_signature ?? null,
      },
      original: {
        result: observation.original.result,
        source_run_id: observation.original.source_run_id,
        duration_seconds: observation.original.duration_seconds,
        ejected: observation.original.ejected,
        input_identity: observation.original.input_identity,
        artifact_identity: observation.original.artifact_identity,
      },
      retry: observation.retry == null ? null : {
        result: observation.retry.result,
        source_run_id: observation.retry.source_run_id,
        runner: observation.retry.runner,
        job: observation.retry.job,
        duration_seconds: observation.retry.duration_seconds,
        input_identity: observation.retry.input_identity,
        artifact_identity: observation.retry.artifact_identity,
      },
      decision: classification,
      ejection_impact: {
        original_attempt_ejected: observation.original.ejected,
        telemetry_ejection_count: telemetryAttempt.ejection.count,
        telemetry_ejection_cause: telemetryAttempt.ejection.cause,
        telemetry_attempt_receipt_id: telemetryAttempt.id,
      },
      telemetry_join: {
        required_check_receipt_id: telemetryCheck.id,
        original_status: telemetryCheck.status,
        source_run_id: joined.telemetry.receipt.source_run_id,
        receipt_sha256: joined.telemetry.receipt.receipt_sha256,
      },
      declared_success_condition: {
        retry_result_success: observation.retry?.result === "success",
        identities_unchanged: classification.identities_unchanged,
        other_required_checks_green: observation.aggregate.other_required_checks_green,
        required_aggregate_green: classification.required_aggregate_green,
      },
    };
  });
}

function buildRates(receipts) {
  const attempted = receipts.filter((row) => row.decision.eligible).length;
  const cleared = receipts.filter((row) => row.decision.retry_cleared_failure).length;
  const failures = receipts.filter((row) => row.original.result === "failure").length;
  const escalated = receipts.filter((row) => row.decision.escalation).length;
  return {
    automatic_reruns: { value: attempted, numerator: attempted, denominator: receipts.length },
    original_failures: { value: failures, numerator: failures, denominator: receipts.length },
    retries_cleared: { value: cleared, numerator: cleared, denominator: attempted },
    rerun_clears_it_rate: {
      value: attempted ? cleared / attempted : null,
      numerator: cleared,
      denominator: attempted,
      measurement: attempted ? "derived" : "unknown",
      basis: attempted ? "retries that met the declared success condition divided by automatic reruns" : "no automatic rerun denominator",
    },
    escalated_real_failures: { value: escalated, numerator: escalated, denominator: receipts.length },
  };
}

export function buildKnownFlakeRerun({ registry, corpus, source }) {
  const signatures = validateRegistry(registry, corpus);
  validateSource(source, signatures);
  const joined = loadTelemetry(source);
  const receipts = buildRerunReceipts(source, signatures, joined);
  const rates = buildRates(receipts);
  const artifact = {
    schema: RECEIPT_SCHEMA,
    repository: source.repository,
    source_run_id: source.source_run_id,
    registry_schema: registry.schema,
    corpus_incident_id: registry.corpus.incident_id,
    telemetry: {
      source_run_id: joined.telemetry.receipt.source_run_id,
      receipt_sha256: joined.telemetry.receipt.receipt_sha256,
      required_check_receipts: joined.telemetry.checkReceipts.length,
      attempt_receipts: joined.telemetry.attemptReceipts.length,
    },
    policy: {
      max_automatic_reruns_per_pr_check_merge_group_attempt: 1,
      escalate_after_consistent_failures: 3,
      executor: "existing CI fresh-runner retry job",
    },
    receipts,
    rates,
    validation: "passed",
  };
  return { ...artifact, receipt_sha256: sha256(artifact) };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function parseArgs(argv) {
  const args = { fixture: null, output: null, check: false, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture") args.fixture = argv[++index];
    else if (value === "--output") args.output = argv[++index];
    else if (value === "--check") args.check = true;
    else if (value === "--write") args.write = true;
    else if (value === "--help") {
      console.log("Usage: node tools/known_flake_rerun.mjs --fixture DIR [--check | --write] [--output DIR]");
      process.exit(0);
    } else fail(`unknown argument: ${value}`);
  }
  if (!args.fixture) fail("--fixture DIR is required");
  if (args.check === args.write) fail("choose exactly one of --check or --write");
  return args;
}

function compareExpected(file, actual) {
  if (!fs.existsSync(file)) fail(`missing expected known-flake receipt: ${file}`);
  const expected = readJson(file);
  if (canonicalJson(expected) !== canonicalJson(actual)) fail(`known-flake receipt drift: ${file}`);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const fixture = path.resolve(args.fixture);
    const registry = readJson(path.resolve(ROOT, "data/known-flake-signatures.v1.json"));
    const corpus = readJson(path.resolve(ROOT, "data/incident-corpus.json"));
    const source = readJson(path.join(fixture, "known-flake-source.json"));
    const result = buildKnownFlakeRerun({ registry, corpus, source });
    const output = path.resolve(args.output ?? path.join(fixture, "expected"));
    const file = path.join(output, "known-flake-rerun.json");
    if (args.check) compareExpected(file, result);
    else writeJson(file, result);
    console.log(`known-flake rerun ${args.check ? "valid" : "written"}: ${result.receipt_sha256}`);
    return 0;
  } catch (error) {
    console.error(`known-flake rerun invalid: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
