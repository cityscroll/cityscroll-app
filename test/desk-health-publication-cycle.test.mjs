import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
  PUBLICATION_RECEIPT_SCHEMA,
  classifyPublicationEvent,
  consecutiveUnattendedPublicationCycles,
  evaluatePublicationCycle,
  independentWatchdogFinding,
  isQualifyingUnattendedPublicationReceipt,
  loadPublicationCycleContract,
  publicationReceiptQualificationFindings,
  retainLastSuccess,
  cycleClock,
} from "../tools/desk_health_publication_cycle.mjs";
import {
  EVIDENCE_DIR_RELATIVE,
  HISTORICAL_ENVELOPE_NAME,
  PUBLICATION_RECEIPT_ZIP_PATH,
  SCHEMA as PRODUCTION_OBSERVATION_SCHEMA,
  captureDeskPublicationProductionRead,
  checkRetainedProductionObservations,
  datedEnvelopeName,
  evaluateProductionObservationCurrency,
  evidenceDir,
  loadNewestDatedProductionObservation,
  publicationReceiptArtifactName,
  scheduledCyclesFromObservation,
} from "../tools/capture_desk_publication_production_read.mjs";
import { zipJsonFiles } from "../tools/lib/zip_json.mjs";

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
  const { envelope: production } = loadNewestDatedProductionObservation(evidenceDir(ROOT));
  const manifest = JSON.parse(readFileSync(join(ROOT, "docs/evidence/desk-health-publication-liveness/capture-manifest.json"), "utf8"));
  const checked = checkRetainedProductionObservations(evidenceDir(ROOT));
  assert.equal(production.schema, PRODUCTION_OBSERVATION_SCHEMA);
  assert.equal(production.evidence_class, "live-production-read");
  assert.equal(production.isolated, false);
  assert.equal(production.consecutive_unattended_observer_cycles.length, 2);
  assert.ok(production.consecutive_unattended_observer_cycles.every((row) => row.event === "schedule"));
  assert.ok(Array.isArray(production.consecutive_unattended_publication_cycles));
  if (production.consecutive_unattended_publication_cycles.length) {
    assert.deepEqual(
      production.consecutive_unattended_publication_cycles,
      consecutiveUnattendedPublicationCycles(production.consecutive_unattended_publication_cycles),
    );
    assert.ok(production.consecutive_unattended_publication_cycles.every(isQualifyingUnattendedPublicationReceipt));
  } else {
    assert.match(production.publication_receipt_retention.empty_reason, /retain|receipt|clock|event/i);
  }
  assert.equal(
    existsSync(join(ROOT, EVIDENCE_DIR_RELATIVE, "production-watchdog-read-2026-09-10.json")),
    true,
  );
  const lastSuccess = production.publication_dependency_and_backlog.scheduled_pages_publication.last_successful_scheduled_run;
  assert.equal(lastSuccess.event, "schedule");
  assert.equal(lastSuccess.conclusion, "success");
  assert.equal(typeof lastSuccess.head_sha, "string");
  assert.match(lastSuccess.url, /^https:\/\/github\.com\/cityscroll\/cityscroll-app\/actions\/runs\//);
  assert.equal(checked.envelope.observed_at, production.observed_at);
  assert.equal(manifest.evidence_class, "isolated-consumer-render");
  assert.ok(manifest.captures.some((row) => row.isolated === true));
  assert.ok(manifest.captures.every((row) => typeof row.render_content_sha256 === "string"));
});

function githubRun(id, { event = "schedule", conclusion = "success", created_at, head_sha = "abc123def456" } = {}) {
  return {
    id,
    event,
    conclusion,
    created_at,
    head_sha,
    html_url: `https://github.com/cityscroll/cityscroll-app/actions/runs/${id}`,
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || "";
      },
    },
    async json() {
      return body;
    },
  };
}

function stubProductionFetch({
  pages,
  watchdogs,
  refresh = [],
  artifactZips = {},
  scheduler = { status: 200, body: { ok: true, scheduler_ok: true, publication_ok: true, failing_stage: null, alert: null, publication_heartbeat: { workflow: "Deploy Cloudflare Pages", run_id: "1003", result: "succeeded" } } },
  destination = { status: 302, location: "https://cityscroll-desk.cloudflareaccess.com/cdn-cgi/access/login/desk.cityscroll.org?meta=secret" },
  adminKey = "specimen-admin-key",
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", authorization: options.headers?.Authorization || null });
    const parsed = new URL(url);
    if (parsed.pathname.includes("deploy-cloudflare-pages.yml/runs")) {
      return jsonResponse({ workflow_runs: pages });
    }
    if (parsed.pathname.includes("reliability-watchdogs.yml/runs")) {
      return jsonResponse({ workflow_runs: watchdogs });
    }
    if (parsed.pathname.includes("first-class-refresh.yml/runs")) {
      return jsonResponse({ workflow_runs: refresh });
    }
    const runArtifacts = parsed.pathname.match(/\/actions\/runs\/([^/]+)\/artifacts$/);
    if (runArtifacts) {
      const runId = runArtifacts[1];
      const zip = artifactZips[runId];
      return jsonResponse({
        artifacts: zip
          ? [{ id: Number(runId), name: publicationReceiptArtifactName(runId), expired: false }]
          : [],
      });
    }
    const artifactZip = parsed.pathname.match(/\/actions\/artifacts\/([^/]+)\/zip$/);
    if (artifactZip) {
      const zip = artifactZips[artifactZip[1]];
      if (!zip) return jsonResponse({ message: "Not Found" }, 404);
      return {
        ok: true,
        status: 200,
        headers: { get() { return ""; } },
        async json() { return {}; },
        async arrayBuffer() { return zip; },
      };
    }
    if (parsed.pathname === "/admin/reliability/scheduler") {
      assert.equal(options.headers?.Authorization, `Bearer ${adminKey}`);
      return jsonResponse(scheduler.body, scheduler.status);
    }
    if (parsed.hostname === "desk.cityscroll.org") {
      return jsonResponse({}, destination.status, { location: destination.location });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls };
}

function qualifyingPublicationReceipt(id, {
  monitor,
  observation,
  publication,
  event = "schedule",
  isolated = false,
  failingStage = null,
  extras = {},
} = {}) {
  return {
    schema: PUBLICATION_RECEIPT_SCHEMA,
    isolated,
    event,
    run_identity: String(id),
    destination: "https://desk.cityscroll.org/data-sources",
    evidence_revision: `rev-${id}`,
    failing_stage: failingStage,
    clocks: {
      last_monitor_attempt: { at: monitor, state: "KNOWN", basis: "monitor-attempt" },
      last_successful_observation: { at: observation, state: "KNOWN", basis: "successful-observation" },
      evidence_revision: `rev-${id}`,
      last_successful_desk_publication: { at: publication, state: "KNOWN", basis: "successful-desk-publication" },
    },
    ...extras,
  };
}

function collapsedPublicationReceipt(id, at) {
  return {
    schema: PUBLICATION_RECEIPT_SCHEMA,
    isolated: false,
    run_identity: String(id),
    destination: {
      operator_visible: "https://desk.cityscroll.org/data-sources",
      artifact: "docs/data-source-graph.json",
    },
    evidence_revision: `rev-${id}`,
    failing_stage: null,
    clocks: {
      last_monitor_attempt: { at, state: "KNOWN", basis: "pages-build-monitor-attempt" },
      last_successful_observation: { at, state: "KNOWN", basis: "successful-observation" },
      evidence_revision: `rev-${id}`,
      last_successful_desk_publication: { at, state: "KNOWN", basis: "successful-desk-publication" },
    },
    workflow: "Deploy Cloudflare Pages",
    result: "succeeded",
  };
}

function artifactZipFor(receipt) {
  return zipJsonFiles([{ name: PUBLICATION_RECEIPT_ZIP_PATH, json: receipt }]);
}

test("production observation capture is deterministic given injected inputs and never records credentials", async () => {
  const pages = [
    githubRun(1003, { created_at: "2026-09-09T14:31:29Z", head_sha: "bdd8f02b7a7352a45ca66cbb523c8240f7c68fb2" }),
    githubRun(1002, { created_at: "2026-09-08T14:30:10Z", head_sha: "67adff8bb8331df0cdfd3be1ee380815206f0b0e" }),
    githubRun(1001, { created_at: "2026-09-07T15:48:33Z", head_sha: "1113e0eeb6cee1b79145c9c4cee07e267e03e076" }),
  ];
  const watchdogs = [
    githubRun(2002, { created_at: "2026-09-10T01:29:04Z" }),
    githubRun(2001, { created_at: "2026-09-09T23:31:02Z" }),
  ];
  const { fetchImpl } = stubProductionFetch({ pages, watchdogs });
  const input = {
    now: "2026-09-10T12:00:00.000Z",
    fetchImpl,
    adminKey: "specimen-admin-key",
    githubToken: "specimen-github-token",
  };
  const first = await captureDeskPublicationProductionRead(input);
  const second = await captureDeskPublicationProductionRead(input);
  assert.deepEqual(first, second);
  assert.equal(first.publication_dependency_and_backlog.scheduled_pages_publication.last_successful_scheduled_run.run_id, "1003");
  assert.equal(first.publication_dependency_and_backlog.scheduled_pages_publication.consecutive_successful_scheduled_runs.length, 3);
  assert.deepEqual(first.consecutive_unattended_publication_cycles, []);
  assert.equal(first.publication_receipt_retention.retrieved_count, 0);
  assert.match(first.publication_receipt_retention.empty_reason, /No per-run/);
  assert.equal(first.watchdog_read.publication_ok, true);
  assert.equal(first.publication_dependency_and_backlog.private_destination_check.access_protected, true);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /specimen-admin-key|specimen-github-token|cloudflareaccess/i);
  assert.match(first.watchdog_read.note, /Observer cycles do not count as publication/);
});

test("a stale envelope older than the two most recent scheduled cycles is reported as stale rather than as zero successes", () => {
  const historical = JSON.parse(readFileSync(join(ROOT, EVIDENCE_DIR_RELATIVE, HISTORICAL_ENVELOPE_NAME), "utf8"));
  const twoRecent = [
    githubRun(34364169860, { created_at: "2026-09-09T14:31:29Z" }),
    githubRun(34238662276, { created_at: "2026-09-08T14:30:10Z" }),
  ];
  const stale = evaluateProductionObservationCurrency(historical, { scheduledCycles: twoRecent });
  assert.equal(stale.status, "stale");
  assert.notEqual(stale.status, "zero-successes");
  assert.match(stale.reason, /predates the two most recent scheduled publication cycles/);

  const zero = evaluateProductionObservationCurrency({
    observed_at: "2026-09-10T12:00:00.000Z",
    publication_dependency_and_backlog: {
      scheduled_pages_publication: { last_successful_scheduled_run: null, consecutive_successful_scheduled_runs: [] },
    },
  }, { scheduledCycles: twoRecent });
  assert.equal(zero.status, "zero-successes");

  const { envelope: newest } = loadNewestDatedProductionObservation(evidenceDir(ROOT));
  const againstNewest = evaluateProductionObservationCurrency(historical, {
    scheduledCycles: scheduledCyclesFromObservation(newest),
  });
  assert.equal(againstNewest.status, "stale");
  assert.notEqual(againstNewest.status, "zero-successes");
});

test("the publication-cycle reader accepts only retained receipts with ordered clocks, a two-hour window, 26-hour consecutiveness, unique run identity, and schedule events", () => {
  const first = qualifyingPublicationReceipt("1001", {
    monitor: "2026-09-07T10:00:00.000Z",
    observation: "2026-09-07T10:10:00.000Z",
    publication: "2026-09-07T10:25:00.000Z",
  });
  const second = qualifyingPublicationReceipt("1002", {
    monitor: "2026-09-08T10:00:00.000Z",
    observation: "2026-09-08T10:10:00.000Z",
    publication: "2026-09-08T10:25:00.000Z",
  });
  const third = qualifyingPublicationReceipt("1003", {
    monitor: "2026-09-09T10:00:00.000Z",
    observation: "2026-09-09T10:10:00.000Z",
    publication: "2026-09-09T10:25:00.000Z",
  });
  const accepted = consecutiveUnattendedPublicationCycles([third, first, second]);
  assert.deepEqual(accepted, [first, second, third]);
  assert.ok(accepted.every(isQualifyingUnattendedPublicationReceipt));
  assert.equal(new Set(accepted.map((row) => row.run_identity)).size, 3);
  assert.ok(accepted.every((row) => row.event === "schedule"));

  const inverted = qualifyingPublicationReceipt("2001", {
    monitor: "2026-09-09T10:30:00.000Z",
    observation: "2026-09-09T10:10:00.000Z",
    publication: "2026-09-09T10:25:00.000Z",
  });
  assert.ok(publicationReceiptQualificationFindings(inverted).some((item) => /ordered/.test(item)));

  const latePublication = qualifyingPublicationReceipt("2002", {
    monitor: "2026-09-09T10:00:00.000Z",
    observation: "2026-09-09T10:10:00.000Z",
    publication: "2026-09-09T13:10:00.000Z",
  });
  assert.ok(publicationReceiptQualificationFindings(latePublication).some((item) => /two hours/.test(item)));

  const pushEvent = qualifyingPublicationReceipt("2003", {
    monitor: "2026-09-09T10:00:00.000Z",
    observation: "2026-09-09T10:10:00.000Z",
    publication: "2026-09-09T10:25:00.000Z",
    event: "push",
  });
  assert.ok(publicationReceiptQualificationFindings(pushEvent).some((item) => /event=schedule/.test(item)));

  const collapsed = collapsedPublicationReceipt("2004", "2026-09-09T14:48:21.111Z");
  const collapsedFindings = publicationReceiptQualificationFindings(collapsed);
  assert.ok(collapsedFindings.some((item) => /event=schedule/.test(item)));
  assert.ok(collapsedFindings.some((item) => /collapses collection and publication/.test(item)));
  assert.equal(isQualifyingUnattendedPublicationReceipt(collapsed), false);

  const gapAfterSecond = qualifyingPublicationReceipt("1004", {
    monitor: "2026-09-11T12:00:00.000Z",
    observation: "2026-09-11T12:10:00.000Z",
    publication: "2026-09-11T12:25:00.000Z",
  });
  assert.deepEqual(
    consecutiveUnattendedPublicationCycles([first, second, gapAfterSecond]),
    [gapAfterSecond],
  );

  const duplicate = qualifyingPublicationReceipt("1003", {
    monitor: "2026-09-09T11:00:00.000Z",
    observation: "2026-09-09T11:10:00.000Z",
    publication: "2026-09-09T11:25:00.000Z",
  });
  const unique = consecutiveUnattendedPublicationCycles([first, second, third, duplicate]);
  assert.equal(unique.filter((row) => row.run_identity === "1003").length, 1);
});

test("production observation capture emits retained publication receipts verbatim and leaves the array empty when clocks are collapsed", async () => {
  const pages = [
    githubRun(1003, { created_at: "2026-09-09T14:31:29Z", head_sha: "bdd8f02b7a7352a45ca66cbb523c8240f7c68fb2" }),
    githubRun(1002, { created_at: "2026-09-08T14:30:10Z", head_sha: "67adff8bb8331df0cdfd3be1ee380815206f0b0e" }),
    githubRun(1001, { created_at: "2026-09-07T15:48:33Z", head_sha: "1113e0eeb6cee1b79145c9c4cee07e267e03e076" }),
  ];
  const watchdogs = [
    githubRun(2002, { created_at: "2026-09-10T01:29:04Z" }),
    githubRun(2001, { created_at: "2026-09-09T23:31:02Z" }),
  ];
  const qualifying = [
    qualifyingPublicationReceipt("1001", {
      monitor: "2026-09-07T15:50:00.000Z",
      observation: "2026-09-07T16:00:00.000Z",
      publication: "2026-09-07T16:05:00.000Z",
      extras: { workflow: "Deploy Cloudflare Pages" },
    }),
    qualifyingPublicationReceipt("1002", {
      monitor: "2026-09-08T14:40:00.000Z",
      observation: "2026-09-08T15:00:00.000Z",
      publication: "2026-09-08T15:10:00.000Z",
      extras: { workflow: "Deploy Cloudflare Pages" },
    }),
    qualifyingPublicationReceipt("1003", {
      monitor: "2026-09-09T14:40:00.000Z",
      observation: "2026-09-09T14:50:00.000Z",
      publication: "2026-09-09T14:55:00.000Z",
      extras: { workflow: "Deploy Cloudflare Pages" },
    }),
  ];
  const { fetchImpl } = stubProductionFetch({
    pages,
    watchdogs,
    artifactZips: {
      1001: artifactZipFor(qualifying[0]),
      1002: artifactZipFor(qualifying[1]),
      1003: artifactZipFor(qualifying[2]),
    },
  });
  const envelope = await captureDeskPublicationProductionRead({
    now: "2026-09-10T12:00:00.000Z",
    fetchImpl,
    adminKey: "specimen-admin-key",
    githubToken: "specimen-github-token",
  });
  assert.equal(envelope.consecutive_unattended_publication_cycles.length, 3);
  assert.deepEqual(envelope.consecutive_unattended_publication_cycles, qualifying);
  assert.equal(envelope.publication_receipt_retention.retrieved_count, 3);
  assert.equal(envelope.publication_receipt_retention.qualifying_count, 3);
  assert.equal(envelope.publication_receipt_retention.empty_reason, undefined);

  const collapsed = [
    collapsedPublicationReceipt("1001", "2026-09-07T16:00:57.097Z"),
    collapsedPublicationReceipt("1002", "2026-09-08T15:39:08.830Z"),
    collapsedPublicationReceipt("1003", "2026-09-09T14:48:21.111Z"),
  ];
  const collapsedFetch = stubProductionFetch({
    pages,
    watchdogs,
    artifactZips: {
      1001: artifactZipFor(collapsed[0]),
      1002: artifactZipFor(collapsed[1]),
      1003: artifactZipFor(collapsed[2]),
    },
  }).fetchImpl;
  const empty = await captureDeskPublicationProductionRead({
    now: "2026-09-10T12:00:00.000Z",
    fetchImpl: collapsedFetch,
    adminKey: "specimen-admin-key",
    githubToken: "specimen-github-token",
  });
  assert.deepEqual(empty.consecutive_unattended_publication_cycles, []);
  assert.equal(empty.publication_receipt_retention.retrieved_count, 3);
  assert.equal(empty.publication_receipt_retention.qualifying_count, 0);
  assert.match(empty.publication_receipt_retention.empty_reason, /event=schedule/);
  assert.match(empty.publication_receipt_retention.empty_reason, /collapses collection and publication/);
  assert.doesNotMatch(JSON.stringify(empty), /specimen-admin-key|specimen-github-token|cloudflareaccess/i);
});

test("a same-day capture keeps the earlier dated envelope as history", () => {
  assert.equal(
    datedEnvelopeName("2026-09-10T05:14:00.000Z", ["production-watchdog-read-2026-09-10.json"]),
    "production-watchdog-read-2026-09-10T0514.json",
  );
  assert.equal(
    datedEnvelopeName("2026-09-11T00:00:00.000Z", ["production-watchdog-read-2026-09-10.json"]),
    "production-watchdog-read-2026-09-11.json",
  );
});
