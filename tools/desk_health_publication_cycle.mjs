#!/usr/bin/env node

import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const CONTRACT_PATH = "data/desk-health-publication-cycle.v1.json";
export const PUBLICATION_CYCLE_SCHEMA = "cityscroll.desk_health_publication_cycle.v1";
export const PUBLICATION_RECEIPT_SCHEMA = "cityscroll.desk_publication_receipt.v1";
export const PUBLICATION_CYCLE_EXTENSION_VERSION = 1;

export const FAILING_STAGES = Object.freeze([
  "missing-trigger",
  "rejected-heartbeat",
  "collector-failure",
  "frozen-publication",
]);

const HOUR_MS = 60 * 60 * 1000;

export function loadPublicationCycleContract(root = ROOT) {
  return JSON.parse(readFileSync(join(root, CONTRACT_PATH), "utf8"));
}

export function hourMs(hours) {
  const value = Number(hours);
  return Number.isFinite(value) && value > 0 ? value * HOUR_MS : null;
}

function validAt(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}

export function cycleClock(value, basis = null) {
  const at = validAt(value);
  return at
    ? { at, state: "KNOWN", basis: basis || "reported_timestamp" }
    : { at: null, state: "UNKNOWN", basis: null };
}

export function retainLastSuccess(prior, next, succeeded) {
  if (succeeded === true && next?.state === "KNOWN") return next;
  if (prior?.state === "KNOWN") return prior;
  return cycleClock(null);
}

export function classifyPublicationEvent(event = {}) {
  const kind = String(event.kind || event.type || "");
  if (kind === "pull-request" || kind === "pr-created" || event.pull_request_opened === true) {
    return {
      publication: false,
      backlog: true,
      reason: "opening-a-pull-request-is-not-publication",
    };
  }
  if (event.status === "succeeded" && event.destination) {
    return { publication: true, backlog: false, reason: null };
  }
  return { publication: false, backlog: false, reason: event.reason || "publication-not-succeeded" };
}

function parseNow(value) {
  const at = validAt(value instanceof Date ? value.toISOString() : value);
  if (!at) throw new Error("publication cycle evaluation requires a valid now timestamp");
  return at;
}

function budgetsFrom(contract, overrides = {}) {
  const budgets = { ...(contract?.budgets || {}), ...overrides };
  const monitor = hourMs(budgets.monitor_interval_hours);
  const grace = hourMs(budgets.missed_monitor_grace_hours);
  const publication = hourMs(budgets.publication_target_hours_after_completed_cycle);
  if (monitor == null || monitor > 24 * HOUR_MS) {
    throw new Error("monitor interval must be declared and no slower than 24 hours");
  }
  if (grace == null || grace !== 2 * HOUR_MS) {
    throw new Error("missed-monitor grace must be declared as two hours");
  }
  if (publication == null || publication !== 2 * HOUR_MS) {
    throw new Error("publication target must be declared as two hours after a completed evidence cycle");
  }
  return {
    monitor_interval_hours: budgets.monitor_interval_hours,
    missed_monitor_grace_hours: budgets.missed_monitor_grace_hours,
    publication_target_hours_after_completed_cycle: budgets.publication_target_hours_after_completed_cycle,
    monitor_ms: monitor,
    grace_ms: grace,
    publication_ms: publication,
    overdue_monitor_ms: monitor + grace,
  };
}

/**
 * Operator-service clocks for the Desk evidence-publication chain.
 * Publisher vintage is an input, never overwritten by a monitoring success.
 */
export function evaluatePublicationCycle(input = {}, contract = loadPublicationCycleContract()) {
  const now = parseNow(input.now);
  const nowMs = Date.parse(now);
  const budgets = budgetsFrom(contract, input.budgets);
  const isolated = input.isolated === true;
  const evidenceClass = isolated
    ? "isolated"
    : (input.evidence_class || "live-production-read");
  const prior = input.prior || {};
  const collectionStatus = String(input.collection?.status || "unknown");
  const collectionSucceeded = collectionStatus === "succeeded";
  const publicationEvent = classifyPublicationEvent(input.publication || {});
  const publicationSucceeded = publicationEvent.publication === true;

  const lastMonitorAttempt = cycleClock(
    input.monitor_attempt?.at || input.heartbeat?.attempted_at,
    input.monitor_attempt?.basis || "monitor-attempt",
  );
  const lastSuccessfulObservation = retainLastSuccess(
    cycleClock(prior.last_successful_observation?.at, prior.last_successful_observation?.basis),
    cycleClock(input.collection?.completed_at, "successful-observation"),
    collectionSucceeded,
  );
  const evidenceRevision = collectionSucceeded
    ? (input.evidence_revision || prior.evidence_revision || null)
    : (prior.evidence_revision || input.evidence_revision || null);
  const lastSuccessfulPublication = retainLastSuccess(
    cycleClock(prior.last_successful_desk_publication?.at, prior.last_successful_desk_publication?.basis),
    cycleClock(input.publication?.completed_at, "successful-desk-publication"),
    publicationSucceeded,
  );

  const reasons = [];
  let failingStage = null;

  if (input.heartbeat?.rejected === true) {
    failingStage = "rejected-heartbeat";
    reasons.push("heartbeat-rejected");
  } else if (collectionStatus === "failed") {
    failingStage = "collector-failure";
    reasons.push("collector-failed");
  } else if (input.trigger?.installed !== true && !lastMonitorAttempt.at) {
    failingStage = "missing-trigger";
    reasons.push(input.scheduler_input?.present === false
      ? "scheduler-input-missing"
      : "trigger-missing");
  } else if (collectionSucceeded && !publicationSucceeded) {
    const completed = Date.parse(input.collection?.completed_at || "");
    if (input.publication?.status === "failed") {
      failingStage = "frozen-publication";
      reasons.push("publication-failed");
    } else if (Number.isFinite(completed) && nowMs - completed > budgets.publication_ms) {
      failingStage = "frozen-publication";
      reasons.push("publication-overdue");
    }
  }

  if (
    lastMonitorAttempt.at
    && nowMs - Date.parse(lastMonitorAttempt.at) > budgets.overdue_monitor_ms
    && failingStage !== "rejected-heartbeat"
    && failingStage !== "collector-failure"
  ) {
    failingStage = failingStage || "missing-trigger";
    reasons.push("monitor-overdue");
  }

  if (input.scheduler_input?.present === false) {
    reasons.push("scheduler-input-missing-is-not-stopped-collector");
  }
  if (input.unrelated_deployment?.status === "succeeded") {
    reasons.push("unrelated-deployment-is-not-publication");
  }
  if (publicationEvent.backlog) {
    reasons.push(publicationEvent.reason);
  }
  if (collectionSucceeded && input.publisher_vintage_changed === false) {
    reasons.push("unchanged-data-advances-observation-not-publisher-vintage");
  }

  const sourceReceipts = Array.isArray(input.source_receipts) ? input.source_receipts : [];
  const markedCurrent = [...new Set(sourceReceipts
    .filter((row) => row?.status === "succeeded")
    .map((row) => row.source_id)
    .filter(Boolean))];

  return {
    schema: PUBLICATION_CYCLE_SCHEMA,
    isolated,
    evidence_class: evidenceClass,
    observed_at: now,
    budgets: {
      monitor_interval_hours: budgets.monitor_interval_hours,
      missed_monitor_grace_hours: budgets.missed_monitor_grace_hours,
      publication_target_hours_after_completed_cycle: budgets.publication_target_hours_after_completed_cycle,
    },
    trigger: input.trigger || contract.installed_trigger,
    run_identity: input.run_identity || null,
    destination: input.destination || contract.destination,
    publication_dependency: input.publication_dependency || contract.publication_dependency,
    backlog: {
      open_data_pull_requests: input.backlog?.open_data_pull_requests || [],
      pending_outbox: Number(input.backlog?.pending_outbox) || 0,
      note: "Opening a pull request is not successful publication.",
      ...(publicationEvent.backlog ? { last_event: publicationEvent.reason } : {}),
    },
    clocks: {
      last_monitor_attempt: lastMonitorAttempt,
      last_successful_observation: lastSuccessfulObservation,
      evidence_revision: evidenceRevision,
      last_successful_desk_publication: lastSuccessfulPublication,
    },
    publisher_vintage: cycleClock(input.publisher_vintage?.at, input.publisher_vintage?.basis || "publisher_updated"),
    failing_stage: failingStage,
    reasons: [...new Set(reasons)],
    last_good_retained: Boolean(
      !publicationSucceeded && lastSuccessfulPublication.state === "KNOWN",
    ),
    sources_marked_current_by_one_receipt: markedCurrent,
    checks_current_with_old_publisher: Boolean(
      input.checks_current === true && input.publisher_vintage_stale === true,
    ),
  };
}

/**
 * Independent observer: uses the cycle clocks, never the generator's self-report
 * alone, and keeps the named failing stage.
 */
export function independentWatchdogFinding(cycle, options = {}) {
  const now = parseNow(options.now || cycle?.observed_at);
  const nowMs = Date.parse(now);
  const contract = options.contract || loadPublicationCycleContract();
  const budgets = budgetsFrom(contract, cycle?.budgets);
  const isolated = options.isolated === true || cycle?.isolated === true;
  const lastMonitor = cycle?.clocks?.last_monitor_attempt;
  const lastObservation = cycle?.clocks?.last_successful_observation;
  const lastPublication = cycle?.clocks?.last_successful_desk_publication;
  const findings = [];
  const notes = [];
  let failingStage = cycle?.failing_stage || null;

  if (!lastMonitor?.at) {
    failingStage = failingStage || "missing-trigger";
    findings.push("monitor attempt is missing");
  } else if (nowMs - Date.parse(lastMonitor.at) > budgets.overdue_monitor_ms) {
    failingStage = failingStage || "missing-trigger";
    findings.push("missed monitor cycle");
  }

  if (lastObservation?.at && !lastPublication?.at) {
    if (nowMs - Date.parse(lastObservation.at) > budgets.publication_ms) {
      failingStage = "frozen-publication";
      findings.push("publication overdue after a completed evidence cycle");
    }
  } else if (
    lastObservation?.at
    && lastPublication?.at
    && Date.parse(lastPublication.at) + budgets.publication_ms < Date.parse(lastObservation.at)
    && nowMs - Date.parse(lastObservation.at) > budgets.publication_ms
  ) {
    failingStage = "frozen-publication";
    findings.push("publication did not advance after a completed evidence cycle");
  }

  if (cycle?.checks_current_with_old_publisher) {
    notes.push("old publisher vintage is not a monitor failure while checks are current");
  }

  return {
    schema: "cityscroll.desk_publication_watchdog_finding.v1",
    isolated,
    evidence_class: isolated ? "isolated" : (options.evidence_class || "live-production-read"),
    observer: options.observer || contract.installed_trigger.independent_watchdog,
    observed_at: now,
    ok: findings.length === 0 && !failingStage,
    failing_stage: failingStage,
    findings,
    notes,
    named_failing_stage_preserved: failingStage || null,
  };
}

export function publicationReceiptFromCycle(cycle, extras = {}) {
  return {
    schema: PUBLICATION_RECEIPT_SCHEMA,
    run_identity: cycle.run_identity,
    destination: cycle.destination,
    evidence_revision: cycle.clocks.evidence_revision,
    failing_stage: cycle.failing_stage,
    clocks: cycle.clocks,
    isolated: cycle.isolated === true,
    ...extras,
  };
}

export function writePublicationCycleReceipt(path, cycle, extras = {}) {
  // determinism-lint: allow write non-check graph materialization only
  mkdirSync(dirname(path), { recursive: true });
  const receipt = publicationReceiptFromCycle(cycle, extras);
  // determinism-lint: allow write non-check graph materialization only
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export function readPublicationCycleReceipt(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = {
    check: false,
    write: null,
    now: null,
    fromGraph: null,
    runId: null,
    result: "succeeded",
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") args.check = true;
    else if (argv[index] === "--write") {
      args.write = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--now") {
      args.now = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--from-graph") {
      args.fromGraph = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--run-id") {
      args.runId = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--result") {
      args.result = argv[index + 1];
      index += 1;
    } else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return args;
}

function cycleFromGraph(path, args, contract, now) {
  const graph = JSON.parse(readFileSync(path, "utf8"));
  const prior = graph.publication_cycle || {};
  const succeeded = args.result === "succeeded";
  return evaluatePublicationCycle({
    now,
    trigger: { installed: true },
    monitor_attempt: { at: now, basis: "pages-build-monitor-attempt" },
    collection: { status: succeeded ? "succeeded" : "failed", completed_at: now },
    publication: succeeded
      ? {
        status: "succeeded",
        completed_at: now,
        destination: contract.destination.operator_visible,
      }
      : { status: "failed" },
    evidence_revision: graph.sources_hash || prior.clocks?.evidence_revision,
    run_identity: args.runId || process.env.GITHUB_RUN_ID || null,
    prior: {
      last_successful_observation: prior.clocks?.last_successful_observation,
      last_successful_desk_publication: prior.clocks?.last_successful_desk_publication,
      evidence_revision: prior.clocks?.evidence_revision,
    },
  }, contract);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const contract = loadPublicationCycleContract();
  budgetsFrom(contract);
  if (args.check) {
    console.log("desk health publication cycle contract is current");
    return;
  }
  // determinism-lint: allow clock receipt timestamp only outside --check
  const now = args.now || new Date().toISOString();
  const cycle = args.fromGraph
    ? cycleFromGraph(args.fromGraph, args, contract, now)
    : evaluatePublicationCycle({ now, trigger: { installed: true } }, contract);
  if (args.write) writePublicationCycleReceipt(args.write, cycle, {
    workflow: process.env.GITHUB_WORKFLOW || "Deploy Cloudflare Pages",
    source_revision: process.env.GITHUB_SHA || null,
    result: args.result,
  });
  console.log(JSON.stringify({
    schema: cycle.schema,
    failing_stage: cycle.failing_stage,
    run_identity: cycle.run_identity,
    evidence_revision: cycle.clocks.evidence_revision,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try { main(); } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
