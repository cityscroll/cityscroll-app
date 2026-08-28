#!/usr/bin/env node

/**
 * Turn a source-backed merge-queue incident into a repeatable diagnosis and
 * repair loop.  This is deliberately a pure replay: observed_at comes from
 * the input and no current time, live queue state, or unverified inference is
 * introduced while building the artifacts.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickElderSeatHolder } from "./elder_merge_slot.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(ROOT, "tools", "merge_queue_policy.json");
const CORPUS_PATH = path.join(ROOT, "data", "incident-corpus.json");

const SOURCE_SCHEMA = "cityscroll.merge-throughput.jam-playbook.source.v1";
const PLAYBOOK_SCHEMA = "cityscroll.merge-throughput.jam-playbook.v1";
const CLASS_IDS = new Set([
  "arm-time-thrash",
  "flaky-shard-ejection",
  "generated-file-conflict",
  "live-external-coupling",
  "long-pole-serial-check",
  "runner-pool-contention",
  "shared-gate-rot",
]);
const MERGE_STATES = new Set([
  "BLOCKED",
  "BEHIND",
  "CLEAN",
  "CONFLICTING",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);

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

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label}: expected a non-empty string`);
  return value;
}

function requireIso(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail(`${label}: expected an ISO timestamp`);
  }
  return value;
}

function requireOid(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) fail(`${label}: expected a 40-character object id`);
}

function loadPolicy() {
  return readJson(POLICY_PATH);
}

function verifySourceDocuments(source) {
  if (!Array.isArray(source.source_documents) || source.source_documents.length === 0) {
    fail("source_documents must be non-empty");
  }
  return source.source_documents.map((document, index) => {
    const label = `source_documents[${index}]`;
    requireString(document.id, `${label}.id`);
    requireString(document.path, `${label}.path`);
    if (!/^[0-9a-f]{64}$/.test(document.sha256)) fail(`${label}.sha256: malformed digest`);
    const absolute = path.resolve(ROOT, document.path);
    if (!fs.existsSync(absolute)) fail(`${label}: source document is unavailable`);
    const actual = sha256(fs.readFileSync(absolute));
    if (actual !== document.sha256) fail(`${label}: source document digest drift`);
    return { ...document, verification: "verified" };
  });
}

function validatePolicy(policy) {
  const checks = policy?.required_status_checks;
  if (!Array.isArray(checks) || checks.length === 0 || new Set(checks).size !== checks.length) {
    fail("merge policy must declare unique required status checks");
  }
  if (policy.merge_queue?.grouping_strategy !== "ALLGREEN") fail("merge policy must retain ALLGREEN");
  if (policy.merge_queue?.max_entries_to_build !== 5) fail("merge policy build ceiling drifted from five");
  if (policy.merge_queue?.max_entries_to_merge !== 5) fail("merge policy merge ceiling drifted from five");
  if (policy.elder_slot?.policy_module !== "tools/elder_merge_slot.mjs") fail("elder policy module drifted");
  return checks;
}

function validateSource(source, policy) {
  if (source?.schema !== SOURCE_SCHEMA) fail(`invalid source schema: expected ${SOURCE_SCHEMA}`);
  requireString(source.repository, "repository");
  requireString(source.source_run_id, "source_run_id");
  requireIso(source.observed_at, "observed_at");
  const requiredChecks = validatePolicy(policy);
  verifySourceDocuments(source);

  const group = source.merge_group_log;
  if (!group || group.status !== "failure") fail("merge_group_log must record a failure before PR-local diagnosis");
  requireString(group.failure_signature, "merge_group_log.failure_signature");
  requireString(group.failed_check, "merge_group_log.failed_check");
  requireString(group.receipt, "merge_group_log.receipt");
  if (!Array.isArray(group.passed_shards)) fail("merge_group_log.passed_shards must be an array");

  const main = source.main_state;
  if (!main || !MERGE_STATES.has(String(main.merge_state_status).toUpperCase())) {
    fail("main_state.merge_state_status must be a known mergeStateStatus");
  }
  requireString(main.health, "main_state.health");
  requireIso(main.last_transition_at, "main_state.last_transition_at");
  if (!Number.isInteger(main.unknown_settling_window_minutes) || main.unknown_settling_window_minutes <= 0) {
    fail("main_state.unknown_settling_window_minutes must be a positive integer");
  }

  if (!Array.isArray(source.same_test_across_prs) || source.same_test_across_prs.length < 2) {
    fail("same_test_across_prs must contain at least two observations");
  }
  for (const [index, row] of source.same_test_across_prs.entries()) {
    requireString(row.check, `same_test_across_prs[${index}].check`);
    if (!Number.isInteger(row.pull_request) || row.pull_request <= 0) fail(`same_test_across_prs[${index}].pull_request must be positive`);
    requireString(row.outcome, `same_test_across_prs[${index}].outcome`);
    requireString(row.receipt, `same_test_across_prs[${index}].receipt`);
    requireString(row.attribution, `same_test_across_prs[${index}].attribution`);
  }

  if (!Array.isArray(source.pr_local_checks)) fail("pr_local_checks must be an array");
  const branch = source.queue_branch;
  if (!branch) fail("queue_branch is required");
  requireString(branch.ref, "queue_branch.ref");
  requireOid(branch.advertised_oid, "queue_branch.advertised_oid");
  const remote = branch.ls_remote;
  if (!remote || !["match", "mismatch", "unavailable"].includes(remote.status)) fail("queue_branch.ls_remote.status is invalid");
  requireString(remote.command, "queue_branch.ls_remote.command");
  if (!remote.command.startsWith("git ls-remote ")) fail("queue_branch.ls_remote.command must use git ls-remote");
  if (remote.status !== "unavailable") requireOid(remote.oid, "queue_branch.ls_remote.oid");
  if (remote.status === "match" && remote.oid !== branch.advertised_oid) fail("matching ls-remote receipt must match advertised queue branch oid");
  if (remote.status === "mismatch" && remote.oid === branch.advertised_oid) fail("mismatched ls-remote receipt cannot equal advertised queue branch oid");

  if (!Array.isArray(source.rearm_history)) fail("rearm_history must be an array");
  for (const [index, event] of source.rearm_history.entries()) {
    requireString(event.transition, `rearm_history[${index}].transition`);
    requireIso(event.at, `rearm_history[${index}].at`);
    requireString(event.receipt_id, `rearm_history[${index}].receipt_id`);
  }

  const delta = source.measured_delta;
  if (!delta?.before || !delta?.after) fail("measured_delta must contain before and after snapshots");
  for (const side of ["before", "after"]) {
    const row = delta[side];
    requireString(row.label, `measured_delta.${side}.label`);
    for (const field of ["successful_dequeues", "removal_events", "ejections"]) {
      if (!Number.isInteger(row[field]) || row[field] < 0) fail(`measured_delta.${side}.${field} must be a non-negative integer`);
    }
  }
  if (!delta.drain_tactic || delta.drain_tactic.minimum_successful_dequeues < 30) fail("measured_delta.drain_tactic must preserve the 30+ worked-example floor");
  requireString(delta.drain_tactic.evidence, "measured_delta.drain_tactic.evidence");

  if (!Array.isArray(source.elder_candidates)) fail("elder_candidates must be an array");
  if (source.required_check_observations?.length !== requiredChecks.length) fail("required_check_observations must cover every required check");
  const observedNames = source.required_check_observations.map((row) => row.name);
  if (canonicalJson(observedNames) !== canonicalJson(requiredChecks)) fail("required check observations must match the declared ruleset");
  for (const [index, row] of source.required_check_observations.entries()) {
    if (row.status !== "success") fail(`required_check_observations[${index}] must be successful for the controlled replay`);
    requireString(row.receipt, `required_check_observations[${index}].receipt`);
  }
  return { requiredChecks };
}

function findCorpusIncident(corpus, id) {
  const incident = corpus.incidents?.find((candidate) => candidate.id === id);
  if (!incident) fail(`corpus incident not found: ${id}`);
  if (!CLASS_IDS.has(incident.class)) fail(`corpus incident has unknown class: ${incident.class}`);
  return incident;
}

function verifyCorpusEvidence(source, corpus) {
  if (!Array.isArray(source.corpus_incident_ids) || source.corpus_incident_ids.length === 0) fail("corpus_incident_ids must be non-empty");
  const incidents = source.corpus_incident_ids.map((id) => findCorpusIncident(corpus, id));
  const primary = incidents[0];
  if (source.merge_group_log.receipt !== primary.affected_checks?.[0]?.receipt) {
    fail("merge-group log receipt must match the primary incident's affected-check receipt");
  }
  if (source.merge_group_log.failed_check !== primary.affected_checks?.[0]?.name) {
    fail("merge-group log check must match the primary incident's affected-check identity");
  }
  if (source.same_test_across_prs.some((observation) => observation.check !== source.merge_group_log.failed_check)) {
    fail("same-test comparison must use the merge-group failed-check identity");
  }
  for (const observation of source.same_test_across_prs) {
    const match = incidents
      .flatMap((incident) => incident.detection_story?.ejected_and_reserviced || [])
      .find((row) => row.pull_request === observation.pull_request);
    if (!match) fail(`same-test observation for PR #${observation.pull_request} is not in the cited corpus timelines`);
    if (match.timeline !== observation.timeline) fail(`timeline receipt drift for PR #${observation.pull_request}`);
    if (match.status !== observation.timeline_status) fail(`timeline status drift for PR #${observation.pull_request}`);
  }
  for (const ref of source.main_state.evidence_refs || []) {
    const cited = incidents.some((incident) => [
      ...(incident.root_cause?.evidence_refs || []),
      ...(incident.detection_story?.evidence_refs || []),
    ].includes(ref));
    if (!cited) fail(`main_state evidence is not cited by the incident corpus: ${ref}`);
  }
  const timelineRows = primary.detection_story.ejected_and_reserviced.filter((row) =>
    source.same_test_across_prs.some((observation) => observation.pull_request === row.pull_request));
  const timelineRemovalCount = timelineRows.reduce((count, row) => count + (Array.isArray(row.removed_at) ? row.removed_at.length : 1), 0);
  const baseline = corpus.queue_baseline;
  if (source.measured_delta.before.successful_dequeues !== 0
    || source.measured_delta.before.removal_events !== timelineRemovalCount
    || source.measured_delta.before.ejections !== timelineRemovalCount) {
    fail("before measured delta must be derived from the cited incident timelines");
  }
  if (source.measured_delta.after.successful_dequeues !== baseline.successful_dequeues_after_merge
    || source.measured_delta.after.removal_events !== baseline.removal_events_observed
    || source.measured_delta.after.ejections !== baseline.ejections) {
    fail("after measured delta must match the committed queue baseline");
  }
  if (source.measured_delta.drain_tactic.minimum_successful_dequeues > baseline.successful_dequeues_after_merge) {
    fail("drain tactic floor exceeds the cited successful-dequeue baseline");
  }
  return { incidents, primary };
}

function mergeStateMeaning(state) {
  return {
    CLEAN: "The branch is mergeable subject to required checks and reviews.",
    BLOCKED: "A required check, review, or branch-protection requirement blocks merging.",
    BEHIND: "The branch is behind its base and may take a guarded update when GitHub reports it safely updateable.",
    CONFLICTING: "The branch conflicts with its base; resolve the branch conflict before re-arming.",
    DIRTY: "The branch has a dirty tree or unresolved conflict and cannot be safely armed.",
    DRAFT: "The pull request is not eligible for the merge queue.",
    HAS_HOOKS: "Repository hooks are present; inspect the repository-specific mergeability result.",
    UNKNOWN: "GitHub has not settled or could not report mergeability; it is not a failure and is not permission to arm.",
    UNSTABLE: "The mergeability result is changing; wait for a stable result and do not arm.",
  }[state];
}

function assessSettling(main, observedAt) {
  const state = String(main.merge_state_status).toUpperCase();
  const elapsedMinutes = (Date.parse(observedAt) - Date.parse(main.last_transition_at)) / 60000;
  const settling = state === "UNKNOWN" && elapsedMinutes >= 0 && elapsedMinutes < main.unknown_settling_window_minutes;
  return {
    state,
    meaning: mergeStateMeaning(state),
    elapsed_since_transition_minutes: Math.round(elapsedMinutes * 100) / 100,
    settling_window_minutes: main.unknown_settling_window_minutes,
    settling,
    unknown: state === "UNKNOWN",
    unstable: state === "UNSTABLE",
  };
}

function queueGroundTruth(branch) {
  if (branch.ls_remote.status === "unavailable") {
    return { state: "unknown", basis: "git ls-remote receipt unavailable; do not infer branch freshness" };
  }
  if (branch.ls_remote.status === "match") {
    return { state: "match", advertised_oid: branch.advertised_oid, ls_remote_oid: branch.ls_remote.oid, basis: "exact object-id equality from git ls-remote" };
  }
  return { state: "mismatch", advertised_oid: branch.advertised_oid, ls_remote_oid: branch.ls_remote.oid, basis: "exact object-id mismatch from git ls-remote" };
}

function repeatedArmWithoutReceipt(history) {
  const byReceipt = new Map();
  for (const event of history) {
    if (!["rearm", "branch-lock"].includes(event.transition)) continue;
    const events = byReceipt.get(event.receipt_id) || [];
    events.push(event.transition);
    byReceipt.set(event.receipt_id, events);
  }
  const repeated = [...byReceipt.entries()].find(([, transitions]) => transitions.length > 1);
  return repeated ? { blocked: true, receipt_id: repeated[0], transitions: repeated[1] } : { blocked: false };
}

function classifyIncident(source, primaryIncident, settling, queue) {
  const steps = [
    {
      order: 1,
      name: "merge-group-log",
      result: "observed",
      evidence: source.merge_group_log.receipt,
      finding: `${source.merge_group_log.failed_check}: ${source.merge_group_log.failure_signature}`,
    },
    {
      order: 2,
      name: "same-test-across-prs",
      result: "correlated-not-causal",
      evidence: source.same_test_across_prs.map((row) => row.receipt),
      finding: "The cited timelines show repeated service loss for more than one pull request; they do not expose a per-removal failed-check payload.",
    },
    {
      order: 3,
      name: "broken-main-classification",
      result: source.main_state.health,
      evidence: source.main_state.evidence_refs,
      finding: source.main_state.health === "broken"
        ? "The source-backed fix identifies a shared clock/timezone gate condition rather than a PR-local change."
        : "The source does not establish a broken main baseline.",
    },
    {
      order: 4,
      name: "pr-local-check-diagnosis",
      result: source.pr_local_checks.length ? "deferred-until-shared-gate-is-cleared" : "not-needed-for-shared-gate-class",
      evidence: source.pr_local_checks.map((row) => row.receipt),
      finding: "Inspect PR-local checks only after the merge-group and shared-main questions are answered.",
    },
  ];

  const classId = primaryIncident.class;
  let nextAction = "Review the cited root-fix evidence and produce a fix card before re-arming.";
  if (settling.settling) nextAction = "Wait through the UNKNOWN settling window, then re-read mergeStateStatus and the queue branch receipt; do not arm.";
  else if (settling.unstable) nextAction = "Wait for a stable mergeStateStatus; do not arm while UNSTABLE.";
  else if (queue.state === "mismatch") nextAction = "Refresh the queue-branch receipt with git ls-remote before choosing update-branch or rebase.";

  return {
    class: {
      id: classId,
      label: primaryIncident.class,
      evidence_kind: primaryIncident.root_cause?.evidence_kind || "corpus incident classification",
      confidence: primaryIncident.root_cause?.confidence || "unknown",
      attribution: primaryIncident.detection_story?.attribution || "unknown",
    },
    next_action: nextAction,
    decision_tree: steps,
  };
}

function chooseBranchAction(state, queue, settling) {
  if (settling.settling || settling.unstable) return { action: "wait", reason: "mergeability is not stable" };
  if (state === "UNKNOWN") return { action: "wait", reason: "mergeStateStatus remains UNKNOWN after the settling window; obtain a fresh state receipt" };
  if (queue.state === "unknown") return { action: "verify-queue-branch", reason: "ls-remote did not establish branch identity" };
  if (queue.state === "mismatch") return { action: "verify-queue-branch", reason: "advertised and remote queue branch objects differ" };
  if (state === "BEHIND") return { action: "update-branch", reason: "GitHub reports a safely updateable branch; preserve the branch identity and obtain a new receipt" };
  if (["DIRTY", "CONFLICTING"].includes(state)) return { action: "rebase", reason: "the branch has a conflict or dirty tree; resolve it and obtain a new receipt" };
  if (state === "BLOCKED") return { action: "fix-required-check", reason: "a required protection requirement remains blocked" };
  return { action: "inspect", reason: "no safe update or rebase transition is established by the current evidence" };
}

function buildMeasuredDelta(source) {
  const before = source.measured_delta.before;
  const after = source.measured_delta.after;
  const beforeDenominator = before.successful_dequeues + before.ejections;
  const afterDenominator = after.successful_dequeues + after.ejections;
  const beforeYield = beforeDenominator ? before.successful_dequeues / beforeDenominator : null;
  const afterYield = afterDenominator ? after.successful_dequeues / afterDenominator : null;
  const delta = beforeYield == null || afterYield == null ? null : Math.round((afterYield - beforeYield) * 10000) / 10000;
  return {
    schema: "cityscroll.merge-throughput.measured-delta.v1",
    before: { ...before, service_yield: beforeYield },
    after: { ...after, service_yield: afterYield },
    service_yield_delta: {
      value: delta,
      measurement: delta == null ? "unknown" : "derived",
      basis: "successful post-merge dequeues divided by successful post-merge dequeues plus ejections",
      interpretation: "Directional only: the source cohorts and windows differ, so this is not a causal effect estimate.",
    },
    synchronized_batch_drain: {
      minimum_successful_dequeues: source.measured_delta.drain_tactic.minimum_successful_dequeues,
      observed_successful_dequeues_after_merge: after.successful_dequeues,
      grouping_strategy: "ALLGREEN",
      max_entries_to_build: 5,
      max_entries_to_merge: 5,
      min_entries_to_merge_wait_minutes: 5,
      evidence: source.measured_delta.drain_tactic.evidence,
    },
  };
}

function buildResult(source) {
  const policy = loadPolicy();
  const context = validateSource(source, policy);
  const corpus = readJson(CORPUS_PATH);
  const { incidents, primary } = verifyCorpusEvidence(source, corpus);
  const settling = assessSettling(source.main_state, source.observed_at);
  const queue = queueGroundTruth(source.queue_branch);
  const repeated = repeatedArmWithoutReceipt(source.rearm_history);
  const branchAction = chooseBranchAction(settling.state, queue, settling);
  const classification = classifyIncident(source, primary, settling, queue);
  const armReasons = [];
  if (settling.unstable) armReasons.push("mergeStateStatus is UNSTABLE");
  if (settling.unknown) armReasons.push(settling.settling
    ? "mergeStateStatus is UNKNOWN inside the settling window"
    : "mergeStateStatus remains UNKNOWN after the settling window");
  if (!settling.unknown && !settling.unstable && settling.state !== "CLEAN") {
    armReasons.push(`mergeStateStatus is ${settling.state}; complete the branch action before arming`);
  }
  if (queue.state !== "match") armReasons.push("queue-branch git ls-remote ground truth is not an exact match");
  if (repeated.blocked) armReasons.push("re-arm/branch-lock transitions repeat without a new receipt");
  if (source.required_check_observations.some((row) => row.status !== "success")) armReasons.push("a required check is not successful");
  const elder = pickElderSeatHolder(source.elder_candidates, policy.elder_slot, Date.parse(source.observed_at));
  const policyProof = {
    required_checks: context.requiredChecks,
    required_checks_unchanged: canonicalJson(context.requiredChecks) === canonicalJson(policy.required_status_checks),
    grouping_strategy: policy.merge_queue.grouping_strategy,
    allgreen_unchanged: policy.merge_queue.grouping_strategy === "ALLGREEN",
    elder_anti_starvation: {
      policy_module: policy.elder_slot.policy_module,
      enabled: policy.elder_slot.enabled,
      reserve_next_slot_for_elder: policy.elder_slot.reserve_next_slot_for_elder,
      seat_holder: elder.seat,
      reason: elder.reason,
    },
  };
  const detectorReceipt = {
    schema: "cityscroll.merge-throughput.jam-detector-receipt.v1",
    detector: "merge-group-first-jam-classifier",
    source_run_id: source.source_run_id,
    observed_at: source.observed_at,
    incident_ids: incidents.map((incident) => incident.id),
    evidence: {
      merge_group_log: source.merge_group_log.receipt,
      same_test_across_prs: source.same_test_across_prs.map((row) => row.receipt),
      main_fix: source.main_state.evidence_refs,
    },
    classification: classification.class,
    attribution_boundary: "Timeline removal is observed service loss; it is not by itself proof of a named root cause.",
    validation: "passed",
  };
  const primaryRootCause = primary.root_cause;
  const fixCard = {
    schema: "cityscroll.merge-throughput.jam-fix-card.v1",
    action: "root-fix",
    class: classification.class.id,
    title: primary.fix_pr.title,
    fix_reference: {
      pull_request: primary.fix_pr.number,
      url: primary.fix_pr.url,
      commit: primary.fix_pr.commit,
      merged_at: primary.fix_pr.merged_at,
      checks_at_merge: primary.fix_pr.checks_at_merge,
    },
    root_cause: {
      summary: primaryRootCause.summary,
      evidence_kind: primaryRootCause.evidence_kind,
      confidence: primaryRootCause.confidence,
      evidence_refs: primaryRootCause.evidence_refs,
    },
    verification: "Re-run the clock boundary and UTC/America-New_York byte-identity checks, then obtain a fresh merge-group receipt before re-arming.",
    approval_required: false,
  };
  const measuredDelta = buildMeasuredDelta(source);
  const armGuard = {
    can_arm: armReasons.length === 0,
    reasons: armReasons,
    settling,
    queue_branch: queue,
    repeated_transition_guard: repeated,
    branch_action: branchAction,
  };
  const artifactBase = {
    schema: PLAYBOOK_SCHEMA,
    repository: source.repository,
    source_run_id: source.source_run_id,
    observed_at: source.observed_at,
    source_documents: verifySourceDocuments(source),
    classify: classification,
    detector_receipt: detectorReceipt,
    fix_card: fixCard,
    measured_delta: measuredDelta,
    arm_guard: armGuard,
    policy_proof: policyProof,
    validation: "passed",
  };
  return {
    ...artifactBase,
    playbook_sha256: sha256(artifactBase),
  };
}

function outputFiles(result) {
  return {
    "playbook.json": result,
    "classify.json": result.classify,
    "detector-receipt.json": result.detector_receipt,
    "fix-card.json": result.fix_card,
    "measured-delta.json": result.measured_delta,
  };
}

function compareOutputs(directory, result) {
  for (const [name, expected] of Object.entries(outputFiles(result))) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) fail(`missing jam-playbook artifact: ${file}`);
    if (canonicalJson(readJson(file)) !== canonicalJson(expected)) fail(`jam-playbook artifact drift: ${name}`);
  }
}

function writeOutputs(directory, result) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(outputFiles(result))) writeJson(path.join(directory, name), value);
}

function fixturePaths(fixture) {
  const nested = path.join(fixture, "jam-playbook", "source.json");
  return fs.existsSync(nested)
    ? { source: nested, output: path.join(fixture, "jam-playbook", "expected") }
    : { source: path.join(fixture, "source.json"), output: path.join(fixture, "expected") };
}

function parseArgs(argv) {
  const args = { fixture: null, check: false, write: false, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fixture") args.fixture = argv[++index];
    else if (value === "--output") args.output = argv[++index];
    else if (value === "--check") args.check = true;
    else if (value === "--write") args.write = true;
    else if (value === "--help") {
      console.log("Usage: node tools/merge_jam_playbook.mjs --fixture DIR [--check | --write] [--output DIR]");
      process.exit(0);
    } else fail(`unknown argument: ${value}`);
  }
  if (!args.fixture) fail("--fixture DIR is required");
  if (args.check === args.write) fail("choose exactly one of --check or --write");
  return args;
}

export function buildJamPlaybook(source) {
  return buildResult(source);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const fixture = fixturePaths(path.resolve(args.fixture));
    const result = buildResult(readJson(fixture.source));
    const output = path.resolve(args.output ?? fixture.output);
    if (args.check) compareOutputs(output, result);
    else writeOutputs(output, result);
    console.log(`merge-jam playbook ${args.check ? "valid" : "written"}: ${result.playbook_sha256}`);
    return 0;
  } catch (error) {
    console.error(`merge-jam playbook invalid: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
