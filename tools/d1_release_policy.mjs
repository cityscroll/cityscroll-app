#!/usr/bin/env node

/**
 * Validate the checked-in D1 release policy and the workflow wiring that
 * makes it the ordinary release contract (D1-10).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RELEASE_POLICY_PATH,
  loadReleasePolicy,
  validateReleasePolicy,
} from "./d1_canary.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const DEFAULT_WORKFLOW_PATH = resolve(ROOT, ".github/workflows/deploy-worker.yml");
export const REQUIRED_PUSH_PATHS = Object.freeze([
  "worker/**",
  "capabilities/**",
  "entity_resolution/**",
  "ontology/**",
  "site/**",
  "tools/**",
  "warehouse/**",
  ".github/workflows/deploy-worker.yml",
]);

export class D1ReleasePolicyError extends Error {
  constructor(detail) {
    super(`d1 release policy: ${detail}`);
    this.name = "D1ReleasePolicyError";
  }
}

function fail(detail) {
  throw new D1ReleasePolicyError(detail);
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}

function requireKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key} is not a known field`);
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) fail(`${field} must be a positive integer`);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") fail(`${field} must be a non-empty string`);
}

/** The D1-10 additions are required on the checked-in policy, not merely allowed by D1-08. */
export function validateAdoptedReleasePolicy(policy) {
  validateReleasePolicy(policy);

  requirePlainObject(policy.budget_guardrail, "policy.budget_guardrail");
  requireKnownKeys(policy.budget_guardrail, ["window", "measurements", "thresholds", "escalation_contact", "escalation"], "policy.budget_guardrail");
  requireNonEmptyString(policy.budget_guardrail.window, "policy.budget_guardrail.window");

  requirePlainObject(policy.budget_guardrail.measurements, "policy.budget_guardrail.measurements");
  requireKnownKeys(policy.budget_guardrail.measurements, ["rows_written", "batch_count", "generation_count"], "policy.budget_guardrail.measurements");
  const expectedMeasurements = {
    rows_written: ["totals.observed_writes", "sum"],
    batch_count: ["totals.batch_count", "sum"],
    generation_count: ["generation", "count_non_null"],
  };
  for (const [name, [field, aggregation]] of Object.entries(expectedMeasurements)) {
    const measurement = policy.budget_guardrail.measurements[name];
    requirePlainObject(measurement, `policy.budget_guardrail.measurements.${name}`);
    requireKnownKeys(measurement, ["receipt_field", "aggregation"], `policy.budget_guardrail.measurements.${name}`);
    if (measurement.receipt_field !== field) fail(`policy.budget_guardrail.measurements.${name}.receipt_field must be ${field}`);
    if (measurement.aggregation !== aggregation) fail(`policy.budget_guardrail.measurements.${name}.aggregation must be ${aggregation}`);
  }

  requirePlainObject(policy.budget_guardrail.thresholds, "policy.budget_guardrail.thresholds");
  requireKnownKeys(policy.budget_guardrail.thresholds, ["rows_written", "batch_count", "generation_count"], "policy.budget_guardrail.thresholds");
  for (const name of Object.keys(expectedMeasurements)) requirePositiveInteger(policy.budget_guardrail.thresholds[name], `policy.budget_guardrail.thresholds.${name}`);
  requireNonEmptyString(policy.budget_guardrail.escalation_contact, "policy.budget_guardrail.escalation_contact");
  requirePlainObject(policy.budget_guardrail.escalation, "policy.budget_guardrail.escalation");
  requireKnownKeys(policy.budget_guardrail.escalation, ["on", "stop"], "policy.budget_guardrail.escalation");
  requireNonEmptyString(policy.budget_guardrail.escalation.on, "policy.budget_guardrail.escalation.on");
  requireNonEmptyString(policy.budget_guardrail.escalation.stop, "policy.budget_guardrail.escalation.stop");

  requirePlainObject(policy.incremental_publication, "policy.incremental_publication");
  requireKnownKeys(policy.incremental_publication, ["enabled", "disable_input", "recovery", "ordinary_path"], "policy.incremental_publication");
  if (policy.incremental_publication.enabled !== true) fail("policy.incremental_publication.enabled must be true");
  if (policy.incremental_publication.disable_input !== "disable_incremental_publication") {
    fail("policy.incremental_publication.disable_input must be disable_incremental_publication");
  }
  requireNonEmptyString(policy.incremental_publication.recovery, "policy.incremental_publication.recovery");
  if (policy.incremental_publication.ordinary_path !== "delta_upsert_only") {
    fail("policy.incremental_publication.ordinary_path must be delta_upsert_only");
  }
  return policy;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workflowPushPaths(workflow) {
  const pushStart = workflow.indexOf("\n  push:");
  if (pushStart < 0) fail("workflow is missing on.push");
  const pathsStart = workflow.indexOf("\n    paths:", pushStart);
  if (pathsStart < 0) fail("workflow is missing on.push.paths");
  const end = workflow.indexOf("\n  workflow_dispatch:", pathsStart);
  const block = workflow.slice(pathsStart, end < 0 ? workflow.length : end);
  return REQUIRED_PUSH_PATHS.filter((path) => new RegExp(`^\\s*-\\s*[\\\"']?${escaped(path)}[\\\"']?\\s*$`, "m").test(block));
}

function stepIndex(workflow, marker) {
  const index = workflow.indexOf(marker);
  if (index < 0) fail(`workflow is missing ${marker}`);
  return index;
}

/**
 * Check the workflow's static order and its no-rebuild ordinary path. GitHub
 * evaluates the path filter before the job; this check proves the remaining
 * D1 gate order inside the workflow file.
 */
export function validateWorkflowWiring(workflow) {
  const paths = workflowPushPaths(workflow);
  if (paths.length !== REQUIRED_PUSH_PATHS.length) {
    fail(`workflow path filters are missing: ${REQUIRED_PUSH_PATHS.filter((path) => !paths.includes(path)).join(", ")}`);
  }
  const order = [
    "- name: Validate D1 release policy",
    "- name: Compute D1 deploy fingerprint",
    "- name: Gate D1 publication",
    "- name: Snapshot D1 publication watermarks",
    "- name: Claim D1 publication generation",
    "- name: Build D1 search, OCP, and entity-intelligence read models",
    "- name: Publish D1 search, OCP, and entity-intelligence read models",
    "- name: Record D1 publication receipt",
  ].map((marker) => stepIndex(workflow, marker));
  if (order.some((value, index) => index > 0 && value <= order[index - 1])) {
    fail("workflow D1 steps are not wired in policy order");
  }
  if (!/id: d1-deploy-fingerprint[\s\S]*run:\s+node tools\/d1_deploy_fingerprint\.mjs fingerprint/.test(workflow)) {
    fail("workflow fingerprint step is not wired to d1_deploy_fingerprint.mjs fingerprint");
  }
  if (!/id: d1-publication-gate[\s\S]*node tools\/d1_deploy_fingerprint\.mjs decide/.test(workflow)) {
    fail("workflow publication gate is not wired to d1_deploy_fingerprint.mjs decide");
  }
  if (!/if:\s+steps\.d1-publication-gate\.outputs\.should-publish\s*==\s*'true'/.test(workflow)) {
    fail("workflow D1 write steps are not gated by the fingerprint decision");
  }
  const ordinaryPath = workflow.slice(stepIndex(workflow, "- name: Build D1 search"), stepIndex(workflow, "- name: Record D1 publication receipt"));
  if (/d1_explicit_rebuild\.mjs|--mode\s+rebuild/.test(ordinaryPath)) {
    fail("ordinary D1 publication path references an explicit rebuild");
  }
  if (!workflow.includes("disable_incremental_publication")) fail("workflow is missing the rollback feature-flag input");
  return { paths, order };
}

export function checkReleasePolicy({ policyPath = DEFAULT_RELEASE_POLICY_PATH, workflowPath = DEFAULT_WORKFLOW_PATH } = {}) {
  if (!existsSync(workflowPath)) fail(`workflow does not exist: ${workflowPath}`);
  const policy = validateAdoptedReleasePolicy(loadReleasePolicy(policyPath));
  const wiring = validateWorkflowWiring(readFileSync(workflowPath, "utf8"));
  return { policy_path: policyPath, workflow_path: workflowPath, policy, wiring };
}

export function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) fail(`unknown argument ${argument}`);
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      args[name] = true;
    } else {
      args[name] = next;
      index += 1;
    }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.check !== true) fail("usage: --check [--policy <path>] [--workflow <path>]");
  const result = checkReleasePolicy({
    policyPath: resolve(ROOT, args.policy || DEFAULT_RELEASE_POLICY_PATH),
    workflowPath: resolve(ROOT, args.workflow || DEFAULT_WORKFLOW_PATH),
  });
  console.log(`d1 release policy: valid (${result.wiring.paths.length} push path filters, ordered fingerprint gate)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
