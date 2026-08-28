#!/usr/bin/env node

/**
 * Score required merge gates against the MT-1 telemetry contract.
 *
 * The audit keeps missing observations unknown.  It uses completed check
 * intervals for runner cost and the portion of each interval that is not
 * overlapped by a sibling required check as the gate's serialized
 * contribution to attempt wall time.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTelemetry,
  canonicalJson,
  sha256,
} from "./merge_throughput_telemetry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY_PATH = path.join(ROOT, "tools", "merge_queue_policy.json");
const AUDIT_SCHEMA = "cityscroll.merge-throughput.gate-audit.v1";
const ENTRY_SCHEMA = "cityscroll.merge-throughput.gate-audit-entry.v1";

const GATE_DEFINITIONS = {
  "Unit tests (site + worker)": {
    protected_failure_class: "application-correctness-regression",
    replacement_check_or_monitor: "Targeted unit tests remain required for changed site/worker paths; retain the full unit suite as the monitor.",
  },
  "Accessibility + language gate (axe on every PR)": {
    protected_failure_class: "browser-accessibility-or-language-regression",
    replacement_check_or_monitor: "Path-filtered axe/language coverage for browser-facing changes, with the existing unit/static language checks retained.",
  },
  "Reading-level ratchet gate (readable-or-else)": {
    protected_failure_class: "reader-facing-readability-regression",
    replacement_check_or_monitor: "A changed-copy readability monitor covering modified resident-facing text, with an explicit review receipt for exceptions.",
  },
};

const WATERMARK_FINDING = {
  gate_id: "architecture-watermark-serialization",
  name: "architecture/generated/watermark.json",
  kind: "serialization-point",
  required: false,
  protected_failure_class: "architecture-evidence-freshness",
  evidence: {
    producer: "node tools/reconcile_architecture.mjs --write-watermark",
    shared_target: "architecture/generated/watermark.json",
    mechanism: "The reviewed watermark is one generated file. Concurrent architecture-affecting changes each rewrite the same target, so independent PRs contend during rebase or merge.",
    observed_prs: [
      { number: 1329, conflict_count: { lower_bound: 1, upper_bound: 2, measurement: "observed" } },
      { number: 1354, conflict_count: { lower_bound: 1, upper_bound: 2, measurement: "observed" } },
      { number: 1357, conflict_count: { lower_bound: 1, upper_bound: 2, measurement: "observed" } },
      { number: 1359, conflict_count: { lower_bound: 1, upper_bound: 2, measurement: "observed" } },
    ],
    repository_refs: [
      "0c7818a4c84a048a37e85bcd24fa758ebad9e466",
      "ffed31cb03bdacac23e3eb96b8ce6716943b8869",
      "tools/reconcile_architecture.mjs",
      ".github/workflows/architecture-reconciliation.yml",
    ],
  },
  metrics: {
    jam_incidents: {
      value: 4,
      measurement: "measured",
      basis: "four PRs with the observed watermark conflict pattern",
      denominator: 4,
    },
    rebase_churn_events: {
      lower_bound: 4,
      upper_bound: 8,
      measurement: "measured-range",
      basis: "one to two conflicts reported for each of four observed PRs",
      denominator: 4,
    },
    elapsed_runner_minutes: {
      value: null,
      measurement: "unknown",
      basis: "the repository evidence records conflict/rebase churn, not runner duration",
      denominator: 0,
    },
    flake_rate: {
      value: null,
      measurement: "unknown",
      basis: "a conflict is not a rerun-cleared check failure",
      denominator: 0,
    },
    serialization: {
      state: "measured",
      target_count: 1,
      basis: "one shared generated target is written by the watermark command",
      contribution: "concurrent writers serialize on the target during merge/rebase",
    },
  },
  recommendation: {
    action: "propose-remediation",
    confidence: "high",
    reliability_non_regression_condition: "Architecture reconciliation must still verify current facts, frozen canaries, and the reviewed baseline before delivery.",
    retained_replacement_check_or_monitor: "Keep architecture reconciliation and frozen-canary replay as the required monitor while changing only the artifact ownership shape.",
    options: [
      {
        id: "merge-neutral-watermark",
        tradeoff: "Derive the compact watermark from a reviewed baseline without rewriting it on every content PR; reduces conflicts most directly, but makes baseline advancement an explicit release action.",
      },
      {
        id: "per-module-split",
        tradeoff: "Partition watermark facts by module or canary owner; enables independent merges, but adds aggregation and cross-module consistency work.",
      },
      {
        id: "merge-driver",
        tradeoff: "Use a deterministic custom merge driver for the generated file; preserves the current shape, but hides conflict resolution in tooling and needs strong proof that no reviewed fact is dropped.",
      },
    ],
  },
};

function fail(message) {
  throw new Error(message);
}

function metric(value, measurement, basis, extra = {}) {
  return { value, measurement, basis, ...extra };
}

function unknownMetric(basis) {
  return metric(null, "unknown", basis, { denominator: 0 });
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function loadPolicy() {
  return JSON.parse(fs.readFileSync(POLICY_PATH, "utf8"));
}

function interval(check) {
  if (!check.started_at || !check.completed_at) return null;
  const start = Date.parse(check.started_at);
  const end = Date.parse(check.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return { start, end };
}

function overlap(start, end, otherStart, otherEnd) {
  return Math.max(0, Math.min(end, otherEnd) - Math.max(start, otherStart));
}

function exclusiveDuration(target, siblings) {
  if (target.end <= target.start) return 0;
  const boundaries = new Set([target.start, target.end]);
  for (const sibling of siblings) {
    boundaries.add(Math.max(target.start, sibling.start));
    boundaries.add(Math.min(target.end, sibling.end));
  }
  const points = [...boundaries].filter((point) => point >= target.start && point <= target.end).sort((a, b) => a - b);
  let exclusive = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const midpoint = start + (end - start) / 2;
    const siblingCovers = siblings.some((sibling) => midpoint >= sibling.start && midpoint < sibling.end);
    if (!siblingCovers) exclusive += end - start;
  }
  return exclusive;
}

function serialMetrics(source, gateName, completedChecks) {
  const timed = completedChecks.filter((check) => interval(check));
  if (!timed.length) {
    return {
      state: "unknown",
      exclusive_elapsed_runner_minutes: unknownMetric("no completed source interval for this gate"),
      overlap_elapsed_runner_minutes: unknownMetric("no completed source interval for this gate"),
      attempts_with_timing: unknownMetric("no completed source interval for this gate"),
    };
  }

  let exclusiveMs = 0;
  let overlapMs = 0;
  for (const check of timed) {
    const target = interval(check);
    const siblings = source.checks
      .filter((candidate) => candidate.pull_request === check.pull_request
        && candidate.attempt === check.attempt
        && candidate.name !== gateName)
      .map(interval)
      .filter(Boolean);
    const durationMs = target.end - target.start;
    const exclusive = exclusiveDuration(target, siblings);
    exclusiveMs += exclusive;
    overlapMs += durationMs - exclusive;
  }
  return {
    state: "measured",
    exclusive_elapsed_runner_minutes: metric(round(exclusiveMs / 60000), "measured", "completed gate intervals not overlapped by a sibling required check", { denominator: timed.length }),
    overlap_elapsed_runner_minutes: metric(round(overlapMs / 60000), "measured", "completed gate interval overlapped by a sibling required check", { denominator: timed.length }),
    attempts_with_timing: metric(timed.length, "measured", "completed source intervals", { denominator: timed.length }),
  };
}

function recommendationFor({ completed, failures, flakeRate, ejectionAttempts, durationMinutes, hasObservations }) {
  const base = {
    retained_replacement_check_or_monitor: null,
    reliability_non_regression_condition: "The retained check or monitor must preserve the named failure class at no worse observed failure detection and must not weaken ALLGREEN composition.",
  };
  if (!hasObservations) {
    return {
      ...base,
      action: "insufficient-evidence",
      confidence: "none",
      reason: "No source observation exists for this required check; unavailable MT-1 receipts are not a zero-cost or zero-catch result.",
    };
  }
  if (failures.length > 0 && flakeRate != null && flakeRate >= 0.5 && failures.length < completed.length / 2) {
    return {
      ...base,
      action: "path-filter",
      confidence: "medium",
      reason: "The observed failures clear on later attempts often enough to make broad execution a service-loss candidate; preserve targeted coverage before narrowing paths.",
    };
  }
  if (failures.length === 0 && completed.length >= 5 && durationMinutes >= 15) {
    return {
      ...base,
      action: "de-require",
      confidence: "low",
      reason: "The window has enough completed observations to open a de-require review, but the protected class still needs an explicit replacement monitor.",
    };
  }
  return {
    ...base,
    action: "retain-required",
    confidence: failures.length >= completed.length / 2 ? "high" : "medium",
    reason: ejectionAttempts > 0
      ? "Observed catches or ejection-linked failures justify retaining required protection until a separately approved replacement proves equivalent coverage."
      : "The window does not establish a safe removal or path boundary.",
  };
}

function buildGateEntry(source, telemetry, name, policyIndex) {
  const definition = GATE_DEFINITIONS[name] ?? {
    protected_failure_class: "unclassified-required-check-failure",
    replacement_check_or_monitor: "A reviewed replacement monitor for this newly declared required check.",
  };
  const rows = source.checks.filter((check) => check.name === name);
  const completed = rows.filter((check) => check.status === "success" || check.status === "failure");
  const failures = completed.filter((check) => check.status === "failure");
  const timed = completed.filter((check) => interval(check));
  const durationSeconds = timed.reduce((sum, check) => sum + (interval(check).end - interval(check).start) / 1000, 0);
  const durationMinutes = durationSeconds / 60;
  const matchingGauge = telemetry.checkGauges.find((gauge) => gauge.required_check === name);
  const flakeRate = matchingGauge?.flake_rate?.value ?? null;
  const ejectionAttempts = new Set(failures
    .filter((check) => source.attempts.some((attempt) => attempt.pull_request === check.pull_request
      && attempt.attempt === check.attempt && attempt.ejection_cause))
    .map((check) => `${check.pull_request}:${check.attempt}`)).size;
  const serialization = serialMetrics(source, name, completed);
  const recommendation = recommendationFor({
    completed,
    failures,
    flakeRate,
    ejectionAttempts,
    durationMinutes,
    hasObservations: rows.length > 0,
  });
  recommendation.retained_replacement_check_or_monitor = definition.replacement_check_or_monitor;

  const catchCount = completed.length > 0
    ? metric(failures.length, "measured", "completed failure conclusions", { numerator: failures.length, denominator: completed.length })
    : unknownMetric(rows.length ? "required check has no completed source observations" : "required check has no source observations");
  const runnerMinutes = timed.length
    ? metric(round(durationMinutes), "measured", "sum of completed check intervals", { denominator: timed.length })
    : unknownMetric(rows.length ? "no completed duration observation" : "required check has no source observations");
  const catchPerMinute = catchCount.value != null && runnerMinutes.value > 0
    ? metric(round(catchCount.value / runnerMinutes.value), "derived", "real catches divided by elapsed runner minutes", { numerator: catchCount.value, denominator: runnerMinutes.value })
    : unknownMetric("catch-per-cost requires measured catches and runner minutes");
  const rankClass = recommendation.action === "path-filter" ? 3
    : recommendation.action === "de-require" ? 2
      : recommendation.action === "retain-required" ? 1 : 0;

  return {
    schema: ENTRY_SCHEMA,
    gate_id: `required-check-${policyIndex + 1}`,
    name,
    kind: "required-check",
    required: true,
    protected_failure_class: definition.protected_failure_class,
    sample_window: source.window,
    denominators: {
      attempts_total: source.attempts.length,
      source_check_observations: rows.length,
      completed_check_observations: completed.length,
      duration_observations: timed.length,
      failure_observations: failures.length,
    },
    metrics: {
      catches: catchCount,
      elapsed_runner_minutes: runnerMinutes,
      ejection_jam_incidents: completed.length
        ? metric(ejectionAttempts, "measured", "ejected attempts carrying this required-check failure identity", { denominator: failures.length })
        : unknownMetric(rows.length ? "required check has no completed source observations to attribute an ejection" : "required check has no source observations to attribute an ejection"),
      flake_rate: matchingGauge?.flake_rate ?? unknownMetric("required check has no MT-1 flake denominator"),
      rerun_clears_it_rate: matchingGauge?.rerun_clears_it_rate ?? unknownMetric("required check has no MT-1 rerun denominator"),
      serialization,
      catch_per_runner_minute: catchPerMinute,
    },
    recommendation: {
      ...recommendation,
      rank_class: rankClass,
    },
  };
}

function validatePolicyAlignment(source, policy) {
  const declared = policy.required_status_checks;
  if (!Array.isArray(declared) || declared.length === 0) fail("merge policy has no required status checks");
  if (canonicalJson(declared) !== canonicalJson(source.required_checks)) {
    fail("fixture required_checks do not match tools/merge_queue_policy.json");
  }
  for (const name of declared) {
    if (typeof name !== "string" || !name.trim()) fail("merge policy contains an empty required check");
  }
}

export function buildGateAudit(source) {
  const policy = loadPolicy();
  validatePolicyAlignment(source, policy);
  const telemetry = buildTelemetry(source);
  const entries = policy.required_status_checks.map((name, index) => buildGateEntry(source, telemetry, name, index));
  const ranked = [...entries].sort((a, b) => {
    if (b.recommendation.rank_class !== a.recommendation.rank_class) return b.recommendation.rank_class - a.recommendation.rank_class;
    const aScore = a.metrics.catch_per_runner_minute.value ?? -1;
    const bScore = b.metrics.catch_per_runner_minute.value ?? -1;
    return bScore - aScore || a.gate_id.localeCompare(b.gate_id);
  }).map((entry, index) => ({ gate_id: entry.gate_id, name: entry.name, action: entry.recommendation.action, rank: index + 1 }));
  const candidateCards = entries
    .filter((entry) => ["path-filter", "de-require"].includes(entry.recommendation.action))
    .map((entry) => ({
      schema: "cityscroll.merge-throughput.gate-candidate-card.v1",
      card_id: `${entry.gate_id}-${entry.recommendation.action}`,
      gate_id: entry.gate_id,
      name: entry.name,
      action: entry.recommendation.action,
      protected_failure_class: entry.protected_failure_class,
      sample_window: entry.sample_window,
      evidence: {
        denominators: entry.denominators,
        catches: entry.metrics.catches,
        elapsed_runner_minutes: entry.metrics.elapsed_runner_minutes,
        ejection_jam_incidents: entry.metrics.ejection_jam_incidents,
        flake_rate: entry.metrics.flake_rate,
        serialization: entry.metrics.serialization,
      },
      retained_replacement_check_or_monitor: entry.recommendation.retained_replacement_check_or_monitor,
      reliability_non_regression_condition: entry.recommendation.reliability_non_regression_condition,
      confidence: entry.recommendation.confidence,
      rationale: entry.recommendation.reason,
      approval_required: true,
    }));
  const receiptBase = {
    schema: AUDIT_SCHEMA,
    telemetry_schema: telemetry.receipt.telemetry_schema,
    repository: source.repository,
    source_run_id: source.source_run_id,
    sample_window: source.window,
    policy: {
      path: "tools/merge_queue_policy.json",
      required_status_checks: policy.required_status_checks,
      grouping_strategy: policy.merge_queue.grouping_strategy,
      allgreen_unchanged: policy.merge_queue.grouping_strategy === "ALLGREEN",
      required_protection_unchanged: true,
    },
    gates: entries,
    ranked_recommendations: ranked,
    candidate_cards: candidateCards,
    supplemental_findings: [WATERMARK_FINDING],
    validation: "passed",
  };
  return {
    ...receiptBase,
    audit_sha256: sha256(receiptBase),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function outputFiles(audit) {
  return {
    "gate-audit.json": audit,
  };
}

function writeOutputs(directory, audit) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(outputFiles(audit))) {
    fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
  }
}

function compareOutputs(directory, audit) {
  for (const [name, expected] of Object.entries(outputFiles(audit))) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) fail(`missing expected gate-audit artifact: ${file}`);
    if (canonicalJson(readJson(file)) !== canonicalJson(expected)) fail(`gate-audit artifact drift: ${name}`);
  }
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
      console.log("Usage: node tools/merge_gate_audit.mjs --fixture DIR [--check | --write] [--output DIR]");
      process.exit(0);
    } else fail(`unknown argument: ${value}`);
  }
  if (!args.fixture) fail("--fixture DIR is required");
  if (args.check === args.write) fail("choose exactly one of --check or --write");
  return args;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const fixture = path.resolve(args.fixture);
    const source = readJson(path.join(fixture, "source.json"));
    const audit = buildGateAudit(source);
    const output = path.resolve(args.output ?? path.join(fixture, "expected"));
    if (args.check) compareOutputs(output, audit);
    else writeOutputs(output, audit);
    console.log(`merge-gate audit ${args.check ? "valid" : "written"}: ${audit.audit_sha256}`);
    return 0;
  } catch (error) {
    console.error(`merge-gate audit invalid: ${error.message}`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
