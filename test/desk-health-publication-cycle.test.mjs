import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DATA_SOURCE_GRAPH_SCHEMA_VERSION,
  DESK_CONSUMER_CONTRACT_PATH,
  JSON_OUTPUT,
  ROOT,
  buildDataSourceGraph,
  generatedGraphFiles,
  renderGraphHtml,
} from "../tools/data_source_graph.mjs";
import {
  CONTRACT_PATH,
  FAILING_STAGES,
  PUBLICATION_CYCLE_EXTENSION_VERSION,
  classifyPublicationEvent,
  evaluatePublicationCycle,
  independentWatchdogFinding,
  loadPublicationCycleContract,
  retainLastSuccess,
  cycleClock,
} from "../tools/desk_health_publication_cycle.mjs";

const NOW = "2026-09-06T12:00:00.000Z";
const contract = loadPublicationCycleContract();
const graph = JSON.parse(generatedGraphFiles()[JSON_OUTPUT]);
const html = generatedGraphFiles()[JSON_OUTPUT] && renderGraphHtml(graph);
const deskContract = JSON.parse(readFileSync(join(ROOT, DESK_CONSUMER_CONTRACT_PATH), "utf8"));
const workflow = readFileSync(join(ROOT, ".github/workflows/deploy-cloudflare-pages.yml"), "utf8");
const watchdogs = readFileSync(join(ROOT, ".github/workflows/reliability-watchdogs.yml"), "utf8");
const pagesBuild = readFileSync(join(ROOT, "tools/build_cloudflare_pages.mjs"), "utf8");
const runner = readFileSync(join(ROOT, "tools/external_schedule_runner.mjs"), "utf8");
const reliability = readFileSync(join(ROOT, "worker/src/reliability_watchdogs.mjs"), "utf8");

function cycle(overrides = {}) {
  return evaluatePublicationCycle({
    now: NOW,
    trigger: { installed: true },
    monitor_attempt: { at: "2026-09-06T10:15:00.000Z" },
    collection: { status: "succeeded", completed_at: "2026-09-06T10:20:00.000Z" },
    publication: {
      status: "succeeded",
      completed_at: "2026-09-06T10:25:00.000Z",
      destination: "https://desk.cityscroll.org/data-sources",
    },
    evidence_revision: "rev-current",
    run_identity: "github-actions:deploy-cloudflare-pages:run-1",
    ...overrides,
  });
}

test("operator-service budgets are declared separately from publisher freshness", () => {
  assert.equal(contract.schema, "cityscroll.desk_health_publication_cycle.v1");
  assert.equal(contract.kind, "operator-service-budgets");
  assert.equal(contract.distinct_from, "publisher-freshness");
  assert.ok(contract.budgets.monitor_interval_hours <= 24);
  assert.equal(contract.budgets.missed_monitor_grace_hours, 2);
  assert.equal(contract.budgets.publication_target_hours_after_completed_cycle, 2);
  assert.equal(contract.destination.operator_visible, "https://desk.cityscroll.org/data-sources");
  assert.equal(contract.installed_trigger.collection_and_graph.schedule, "15 10 * * *");
  assert.equal(contract.installed_trigger.independent_watchdog.schedule, "50 * * * *");
  assert.match(contract.publication_dependency, /pull request is a publication dependency|backlog/i);
  assert.doesNotMatch(JSON.stringify(contract), /pull request is successful publication/i);
});

test("Desk graph publishes four distinct publication-cycle clocks inside the additive envelope", () => {
  assert.equal(DATA_SOURCE_GRAPH_SCHEMA_VERSION, 4);
  assert.equal(graph.schema_version, 4);
  assert.equal(graph.extensions.publication_cycle, PUBLICATION_CYCLE_EXTENSION_VERSION);
  assert.equal(deskContract.extensions.publication_cycle.version, 1);
  const clocks = graph.publication_cycle.clocks;
  assert.ok(clocks.last_monitor_attempt);
  assert.ok(clocks.last_successful_observation);
  assert.ok("evidence_revision" in clocks);
  assert.ok(clocks.last_successful_desk_publication);
  assert.notEqual(graph.publication_cycle.clocks.last_monitor_attempt, graph.current_as_of);
  assert.match(html, /id="publicationCycle"/);
  assert.match(html, /Last monitor attempt/);
  assert.match(html, /Last successful observation/);
  assert.match(html, /Evidence revision/);
  assert.match(html, /Last successful Desk publication/);
});

test("unchanged-data success advances observation liveness without changing publisher vintage", () => {
  const priorVintage = "2024-05-06T00:00:00.000Z";
  const result = cycle({
    publisher_vintage: { at: priorVintage },
    publisher_vintage_changed: false,
    collection: { status: "succeeded", completed_at: "2026-09-06T11:00:00.000Z" },
    prior: {
      last_successful_observation: { at: "2026-09-05T10:20:00.000Z" },
    },
  });
  assert.equal(result.clocks.last_successful_observation.at, "2026-09-06T11:00:00.000Z");
  assert.equal(result.publisher_vintage.at, priorVintage);
  assert.ok(result.reasons.includes("unchanged-data-advances-observation-not-publisher-vintage"));
});

test("a failed attempt never overwrites last success", () => {
  const priorObservation = cycleClock("2026-09-05T10:20:00.000Z", "successful-observation");
  const priorPublication = cycleClock("2026-09-05T10:25:00.000Z", "successful-desk-publication");
  const failed = cycle({
    collection: { status: "failed", completed_at: "2026-09-06T11:00:00.000Z" },
    publication: { status: "failed", completed_at: "2026-09-06T11:05:00.000Z" },
    prior: {
      last_successful_observation: priorObservation,
      last_successful_desk_publication: priorPublication,
    },
  });
  assert.equal(failed.clocks.last_successful_observation.at, priorObservation.at);
  assert.equal(failed.clocks.last_successful_desk_publication.at, priorPublication.at);
  assert.equal(failed.clocks.last_monitor_attempt.at, "2026-09-06T10:15:00.000Z");
  assert.equal(failed.last_good_retained, true);
  assert.equal(failed.failing_stage, "collector-failure");
  assert.deepEqual(
    retainLastSuccess(priorObservation, cycleClock("2026-09-06T11:00:00.000Z"), false),
    priorObservation,
  );
});

test("one new receipt cannot mark every source current", () => {
  const result = cycle({
    source_receipts: [
      { source_id: "checkbook-contracts", status: "succeeded" },
      { source_id: "nyc-council-legistar", status: "unknown" },
    ],
  });
  assert.deepEqual(result.sources_marked_current_by_one_receipt, ["checkbook-contracts"]);
  assert.equal(result.sources_marked_current_by_one_receipt.includes("nyc-council-legistar"), false);
});

test("an old historical publisher is not a monitor failure when checks are current", () => {
  const result = cycle({
    checks_current: true,
    publisher_vintage_stale: true,
    publisher_vintage: { at: "2019-01-01T00:00:00.000Z" },
  });
  assert.equal(result.failing_stage, null);
  assert.equal(result.checks_current_with_old_publisher, true);
  const finding = independentWatchdogFinding(result, { now: NOW });
  assert.ok(finding.notes.some((item) => /old publisher vintage is not a monitor failure/.test(item)));
  assert.equal(finding.failing_stage, null);
  assert.equal(finding.ok, true);
});

test("missing external scheduler input is not proof of a stopped collector", () => {
  const result = evaluatePublicationCycle({
    now: NOW,
    trigger: { installed: false },
    scheduler_input: { present: false },
  });
  assert.equal(result.failing_stage, "missing-trigger");
  assert.ok(result.reasons.includes("scheduler-input-missing"));
  assert.ok(result.reasons.includes("scheduler-input-missing-is-not-stopped-collector"));
});

test("opening a pull request is backlog, not successful publication", () => {
  assert.deepEqual(classifyPublicationEvent({ kind: "pull-request", status: "succeeded" }), {
    publication: false,
    backlog: true,
    reason: "opening-a-pull-request-is-not-publication",
  });
  const result = cycle({
    publication: { kind: "pull-request", status: "succeeded", completed_at: NOW },
  });
  assert.equal(result.clocks.last_successful_desk_publication.at, null);
  assert.equal(result.backlog.last_event, "opening-a-pull-request-is-not-publication");
});

test("missing trigger, rejected heartbeat, collector failure, frozen publication, unrelated deployment, and recovery", () => {
  const missing = evaluatePublicationCycle({
    now: NOW,
    trigger: { installed: false },
    isolated: true,
  });
  assert.equal(missing.failing_stage, "missing-trigger");
  assert.equal(missing.isolated, true);
  assert.equal(missing.evidence_class, "isolated");

  const rejected = cycle({
    isolated: true,
    heartbeat: { rejected: true, attempted_at: NOW },
    publication: { status: "failed" },
    prior: { last_successful_desk_publication: { at: "2026-09-05T10:25:00.000Z" } },
  });
  assert.equal(rejected.failing_stage, "rejected-heartbeat");
  assert.equal(rejected.clocks.last_successful_desk_publication.at, "2026-09-05T10:25:00.000Z");

  const collector = cycle({
    isolated: true,
    collection: { status: "failed", completed_at: NOW },
  });
  assert.equal(collector.failing_stage, "collector-failure");

  const frozen = cycle({
    isolated: true,
    collection: { status: "succeeded", completed_at: "2026-09-06T08:00:00.000Z" },
    publication: { status: "unknown" },
  });
  assert.equal(frozen.failing_stage, "frozen-publication");
  assert.ok(frozen.reasons.includes("publication-overdue"));

  const unrelated = cycle({
    isolated: true,
    collection: { status: "succeeded", completed_at: "2026-09-06T08:00:00.000Z" },
    publication: { status: "unknown" },
    unrelated_deployment: { status: "succeeded", at: "2026-09-06T11:00:00.000Z" },
  });
  assert.equal(unrelated.failing_stage, "frozen-publication");
  assert.ok(unrelated.reasons.includes("unrelated-deployment-is-not-publication"));

  const recovered = cycle({
    isolated: true,
    prior: {
      last_successful_observation: { at: "2026-09-05T10:20:00.000Z" },
      last_successful_desk_publication: { at: "2026-09-05T10:25:00.000Z" },
    },
  });
  assert.equal(recovered.failing_stage, null);
  assert.equal(recovered.clocks.last_successful_desk_publication.at, "2026-09-06T10:25:00.000Z");
  assert.deepEqual(FAILING_STAGES, [
    "missing-trigger",
    "rejected-heartbeat",
    "collector-failure",
    "frozen-publication",
  ]);
});

test("the independent existing watchdog detects a missed-cycle specimen within the declared budget", () => {
  const frozen = cycle({
    isolated: true,
    collection: { status: "succeeded", completed_at: "2026-09-05T08:00:00.000Z" },
    publication: { status: "unknown" },
    monitor_attempt: { at: "2026-09-05T08:00:00.000Z" },
    prior: { last_successful_desk_publication: { at: "2026-08-07T15:11:15.000Z" } },
  });
  assert.equal(frozen.failing_stage, "frozen-publication");
  const finding = independentWatchdogFinding(frozen, {
    now: NOW,
    isolated: true,
    evidence_class: "isolated",
  });
  assert.equal(finding.isolated, true);
  assert.equal(finding.evidence_class, "isolated");
  assert.equal(finding.ok, false);
  assert.equal(finding.failing_stage, "frozen-publication");
  assert.equal(finding.named_failing_stage_preserved, "frozen-publication");
  assert.ok(finding.findings.some((item) => /publication/.test(item)));
  const budgetHours = contract.budgets.monitor_interval_hours + contract.budgets.missed_monitor_grace_hours;
  assert.ok(budgetHours <= 26);
});

test("publication failure retains prior valid evidence with an overdue or failed publication condition", () => {
  const result = cycle({
    publication: { status: "failed", completed_at: NOW },
    prior: { last_successful_desk_publication: { at: "2026-08-07T15:11:15.000Z" } },
    collection: { status: "succeeded", completed_at: "2026-09-06T08:00:00.000Z" },
  });
  assert.equal(result.last_good_retained, true);
  assert.equal(result.clocks.last_successful_desk_publication.at, "2026-08-07T15:11:15.000Z");
  assert.equal(result.failing_stage, "frozen-publication");
  const page = renderGraphHtml(buildDataSourceGraph({
    registry: { contracts: [] },
    healthObservations: { generated_at: NOW, observations: [] },
    publicationCycle: result,
    inputs: [],
  }));
  assert.match(page, /last valid evidence|last-good|publication is overdue|publication failed/i);
  assert.doesNotMatch(page, /Current as of September 6, 2026.*publication failed/s);
});

test("existing scheduled rails collect, stage, and independently watch the publication cycle", () => {
  assert.match(workflow, /cron:\s*"15 10 \* \* \*"/);
  assert.match(workflow, /desk-health-publication-cycle/);
  assert.match(workflow, /data-source-graph-/);
  assert.match(workflow, /cycle":"desk-publication"|desk-publication/);
  assert.match(watchdogs, /cron:\s*"50 \* \* \* \*"/);
  assert.match(watchdogs, /admin\/reliability\/scheduler/);
  assert.match(pagesBuild, /desk_health_publication_cycle/);
  assert.match(pagesBuild, /appendOutput\("data-source-graph-dir"/);
  assert.match(runner, /evaluatePublicationCycle|publication_cycle/);
  assert.match(reliability, /DESK_PUBLICATION_HEARTBEAT/);
  assert.match(reliability, /frozen-publication/);
  assert.doesNotMatch(workflow, /on:\s*\n\s+schedule:[\s\S]*desk-publication-liveness-cron/);
});

test("a fixture graph can attach an isolated publication-cycle specimen without minting live timestamps", () => {
  const isolated = cycle({ isolated: true, now: "2026-09-06T12:00:00.000Z" });
  const built = buildDataSourceGraph({
    registry: { contracts: [{
      id: "publication-cycle-fixture",
      name: "Publication cycle fixture",
      owner: "Fixture publisher",
      status: "live",
      landing_page: "https://example.test/source",
      publisher_cadence: "Historical",
      delivery_tier: "build-time",
      product_freshness: "Retained snapshot.",
      used_for: "Isolated publication-cycle fixture.",
    }] },
    publicationCycle: isolated,
    inputs: [],
  });
  assert.equal(built.publication_cycle.isolated, true);
  assert.equal(built.publication_cycle.evidence_class, "isolated");
  assert.equal(built.publication_cycle.observed_at, "2026-09-06T12:00:00.000Z");
  assert.equal(built.publication_cycle.clocks.evidence_revision, "rev-current");
});

test("keyboard-reachable publication status keeps last-good copy and a 44px recovery control", () => {
  assert.match(html, /id="publicationCycle"/);
  assert.match(html, /id="publicationRecovery"/);
  assert.match(html, /min-height:44px/);
  assert.match(html, /The next scheduled cycle retries publication/);
});

test("production watchdog evidence is a live read and isolated fixtures stay labeled isolated", () => {
  const production = JSON.parse(readFileSync(join(ROOT, "docs/evidence/desk-health-publication-liveness/production-watchdog-read.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(ROOT, "docs/evidence/desk-health-publication-liveness/capture-manifest.json"), "utf8"));
  assert.equal(production.evidence_class, "live-production-read");
  assert.equal(production.isolated, false);
  assert.equal(production.consecutive_unattended_observer_cycles.length, 2);
  assert.ok(production.consecutive_unattended_observer_cycles.every((row) => row.event === "schedule"));
  assert.equal(manifest.evidence_class, "isolated-consumer-render");
  assert.ok(manifest.captures.some((row) => row.isolated === true));
  assert.ok(manifest.captures.every((row) => typeof row.render_content_sha256 === "string"));
});
