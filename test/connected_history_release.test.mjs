/**
 * Release read-back for the fixed six-case connected-history dossier.
 *
 *   node --test test/connected_history_release.test.mjs
 *
 * Hermetic: the retained production read-back is re-derived from committed
 * bytes, every checker is driven by a mutation that must make it fire, and the
 * runner is exercised against a loopback origin. Nothing here writes a tracked
 * file or reaches the network.
 */

import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ACCEPTANCE_CONDITIONS,
  ACCEPTANCE_LETTERS,
  ACCEPTANCE_RULE,
  CAPABILITIES,
  CB15_FAMILY,
  DOSSIER_FAMILIES,
  JOURNEY_VIEWPORTS,
  PRODUCTION_HOSTS,
  RECORD_FIELDS,
  RELEASE_DELIVERY,
  RELEASE_READBACK_SCHEMA,
  SERVED_DATA,
  auditAdmittedFalsePositives,
  deriveAcceptance,
  deriveLetter,
  evaluateCapability,
  nextScheduledCheck,
  scheduledCycleStatus,
} from "../tools/lib/connected_history_release.mjs";
import { MEASURED_INPUTS, RETAINED_PATH } from "../tools/check_connected_history_release.mjs";
import { retainedMeasurementStatus } from "../tools/repository_revision.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const readBytes = (path) => readFileSync(join(ROOT, path));
const readJson = (path) => JSON.parse(readBytes(path).toString("utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => structuredClone(value);

function committedArtifacts() {
  const artifacts = {};
  for (const [key, path] of Object.entries(SERVED_DATA)) artifacts[key] = readJson(`site${path}`);
  artifacts.parcel_shards = artifacts.parcel_manifest.shards.map((shard) => readJson(`site/data/site_lifecycle/${shard}`));
  artifacts.parcel_population = readJson("warehouse/receipts/proof/site_lifecycle_population_latest.json");
  return artifacts;
}

function passingJourneys() {
  const captures = [];
  for (const family of DOSSIER_FAMILIES) {
    for (const viewport of JOURNEY_VIEWPORTS) {
      captures.push({
        case: `${family}-${viewport.name}`,
        family_id: family,
        viewport: { ...viewport },
        render_sha256: "a".repeat(64),
        runtime: {
          query: family,
          horizontal_overflow: false,
          positive_tabindex_count: 0,
          official_source_destination: "https://www.nyc.gov/",
          continue_destination: "https://cityscroll.org/search/",
        },
      });
    }
  }
  return { browser: "Chromium", captures };
}

const PRODUCTION_CONTEXT = Object.freeze({
  data: {},
  served_revision: RELEASE_DELIVERY.landed_commit,
  code_revision: RELEASE_DELIVERY.landed_commit,
  evidence_class: "deployed_production_read_back",
});

function capability(id) {
  return CAPABILITIES.find((definition) => definition.id === id);
}

function statusOf(id, artifacts) {
  return evaluateCapability(capability(id), artifacts, PRODUCTION_CONTEXT).observed;
}

function isAncestor(ancestor, descendant) {
  return ancestor === descendant
    || spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: ROOT, stdio: "ignore" }).status === 0;
}

test("the fixed dossier is closed: six families, eight delivered capabilities, one delivery pin", () => {
  assert.equal(DOSSIER_FAMILIES.length, 6);
  assert.equal(CAPABILITIES.length, 8);
  assert.equal(new Set(CAPABILITIES.map((definition) => definition.id)).size, 8);
  for (const definition of CAPABILITIES) {
    assert.ok(definition.families.every((family) => DOSSIER_FAMILIES.includes(family)), definition.id);
    assert.match(definition.delivered_by.alias, /^c[a-f0-9]{12}$/);
  }
  assert.ok(DOSSIER_FAMILIES.includes(CB15_FAMILY));
  assert.match(RELEASE_DELIVERY.landed_commit, /^[a-f0-9]{40}$/);
  assert.ok(isAncestor(RELEASE_DELIVERY.landed_commit, "HEAD"), "release delivery is in this tree's history");
});

test("A1: every capability passes on the committed dossier materializations", () => {
  const artifacts = { ...committedArtifacts(), journeys: passingJourneys() };
  for (const definition of CAPABILITIES) {
    const record = evaluateCapability(definition, artifacts, PRODUCTION_CONTEXT);
    assert.deepEqual(record.observed.failures, [], definition.id);
    assert.equal(record.observed.status, "passed", definition.id);
    for (const field of RECORD_FIELDS) assert.notEqual(record[field], undefined, `${definition.id}.${field}`);
    assert.ok(record.expected_native_ids.length > 0, definition.id);
  }
});

test("A1 positive controls: each capability check fires on a violating mutation", () => {
  const base = { ...committedArtifacts(), journeys: passingJourneys() };
  const mutate = (fn) => {
    const artifacts = clone(base);
    fn(artifacts);
    return artifacts;
  };
  const cases = [
    ["frozen-evaluation-baseline", (a) => { a.cohort.sample.push({ subject_id: "land:project:2025X0262" }); }, /named dossier subjects entered/],
    ["frozen-evaluation-baseline", (a) => { a.cohort.judgments[0].judged_before_tuning = false; }, /after tuning/],
    ["retained-dossier-documents", (a) => { a.documents.observations[0].requested_url = "https://example.org/substitute"; }, /hosts outside the dossier/],
    ["retained-dossier-documents", (a) => { a.documents.observations.find((row) => !row.retained).reason = null; }, /without a retained reason/],
    ["typed-history-relations", (a) => { a.relations.relations = a.relations.relations.filter((row) => row.family_id !== "franklin-avenue"); }, /expected dossier relations absent/],
    ["typed-history-relations", (a) => {
      const negative = a.relations.rejections.find((row) => row.candidate_id === "negative-31st-street-vs-avenue");
      a.relations.relations.push({ ...a.relations.relations[0], from: negative.from, to: negative.to, warrant_method: negative.basis, candidate_id: "admitted-negative" });
    }, /negative controls admitted/],
    ["typed-history-relations", (a) => { a.relations.relations[0].identities_merged = true; }, /merge identities/],
    ["typed-history-relations", (a) => { a.relations.relations[0].parcel_identity = "3073670011"; }, /parcel identity silently resolved/],
    ["time-scoped-roles", (a) => { a.roles.observations.push({ ...a.roles.observations[0], role: "formal_board_action" }); }, /formal board actions admitted/],
    ["dated-history-states", (a) => {
      const row = a.time.observations.find((entry) => entry.observation_id === "kingsbridge-operation-forecast-2018");
      row.event_class = "realized";
    }, /unrealized forecast/],
    ["dated-history-states", (a) => { a.time.dossier_outcomes[0].substitute_family_used = true; }, /substitute temporal families/],
    ["parcel-history-reader", (a) => { a.parcel_shards[0].generation = "0".repeat(64); }, /another generation/],
    ["parcel-history-reader", (a) => { a.parcel_shards = []; }, /parcel shards/],
    ["board-coverage-census", (a) => { a.coverage.snapshots.post_change.boards.pop(); }, /58 boards, not 59/],
    ["board-coverage-census", (a) => { a.coverage.evaluation.post_change.precision.status = "estimated"; }, /zero-denominator/],
    ["board-coverage-census", (a) => { a.coverage = null; }, /missing or not a JSON object/],
    ["search-history-discovery", (a) => { a.journeys.captures = a.journeys.captures.filter((row) => row.case !== "lighthouse-point-narrow-touch"); }, /lighthouse-point-narrow-touch is absent/],
    ["search-history-discovery", (a) => { a.journeys.captures[0].runtime.horizontal_overflow = true; }, /did not meet its runtime assertions/],
    ["search-history-discovery", (a) => { a.journeys.captures.push({ ...a.journeys.captures[0], family_id: "replacement-corridor" }); }, /outside the fixed dossier/],
    ["search-history-discovery", (a) => { a.journeys = null; }, /not measured/],
  ];
  for (const [id, fn, expected] of cases) {
    const observed = statusOf(id, mutate(fn));
    assert.equal(observed.status, "failed", `${id} ${expected}`);
    assert.match(observed.failures.join("\n"), expected, id);
  }
});

test("A2: admitted false-positive joins are found, withheld, and their original failure preserved", () => {
  const artifacts = committedArtifacts();
  const clean = auditAdmittedFalsePositives(artifacts);
  assert.equal(clean.status, "none_found");
  assert.deepEqual(clean.admitted_false_positives, []);

  const judged = clone(artifacts);
  const original = {
    subject_id: "land:application:C200184ZMK",
    judgment: "no_relation",
    relation: "explicitly_references",
    rationale: "synthetic positive control",
  };
  judged.cohort.judgments.push(clone(original));
  const fired = auditAdmittedFalsePositives(judged);
  assert.equal(fired.status, "withheld");
  assert.deepEqual(fired.withheld_relations, ["land:application:C230356ZMK explicitly_references land:application:C200184ZMK"]);
  assert.deepEqual(fired.admitted_false_positives[0].evidence, original, "the original evaluation failure is preserved verbatim");

  const collided = clone(artifacts);
  const negative = collided.relations.rejections[0];
  collided.relations.relations.push({ ...collided.relations.relations[0], from: negative.from, to: negative.to, source_span: null });
  assert.equal(auditAdmittedFalsePositives(collided).admitted_false_positives[0].basis, "retained_rejection_of_same_pair");

  // A rejected basis beside an independently quoted warrant for the same pair is not a false positive.
  const franklin = artifacts.relations.rejections.find((row) => row.basis === "same_applicant");
  assert.ok(artifacts.relations.relations.some((row) => row.from === franklin.from && row.to === franklin.to));
});

test("A3/A5: the scheduled cycle stays open until a served run, a non-CB15 journey and unchanged bytes are observed", () => {
  const deployed = "2026-09-29T00:00:00Z";
  const observedAt = "2026-09-29T02:00:00Z";
  const servedRun = {
    run_id: 1,
    event: "schedule",
    created_at: "2026-09-29T07:13:00Z",
    conclusion: "success",
    pull_request: 1,
    merge_commit: "b".repeat(40),
    served_contains_merge: true,
  };
  const workflow = (runs) => [{ workflow: "connected-history-cycle.yml", runs }];
  const input = (overrides) => ({
    release_deployed_at: deployed,
    observed_at: "2026-09-30T12:00:00Z",
    observations: workflow([servedRun]),
    journeys_passed_after_cycle: ["kingsbridge-armory", CB15_FAMILY],
    unchanged_history_bytes: true,
    ...overrides,
  });

  const none = scheduledCycleStatus(input({ observed_at: observedAt, observations: workflow([]) }));
  assert.equal(none.status, "open");
  assert.equal(none.next_check_at, "2026-09-29T07:13:00.000Z");
  assert.equal(none.readback_deadline, "2026-10-06T00:00:00.000Z");
  assert.equal(scheduledCycleStatus(input({ observations: null })).status, "open");
  assert.equal(
    scheduledCycleStatus(input({ observations: workflow([{ ...servedRun, created_at: "2026-09-28T07:13:00Z" }]) })).status,
    "open",
    "a run that started before the release deployment never counts",
  );
  assert.equal(scheduledCycleStatus(input({ observations: workflow([{ ...servedRun, event: "workflow_dispatch" }]) })).status, "open");
  assert.equal(scheduledCycleStatus(input({ observations: workflow([{ ...servedRun, served_contains_merge: false }]) })).status, "open");
  assert.equal(scheduledCycleStatus(input({ journeys_passed_after_cycle: [CB15_FAMILY] })).status, "open");
  assert.equal(scheduledCycleStatus(input({ unchanged_history_bytes: false })).status, "open");
  assert.equal(scheduledCycleStatus(input({ observations: workflow([]), observed_at: "2026-10-07T00:00:00Z" })).status, "overdue");

  const observed = scheduledCycleStatus(input({}));
  assert.equal(observed.status, "observed");
  assert.deepEqual(observed.non_cb15_journeys_after_cycle, ["kingsbridge-armory"]);
  assert.equal(observed.served_cycle_receipt, null);
  assert.equal(nextScheduledCheck("2026-09-29T07:00:00Z"), "2026-09-29T07:13:00.000Z");
  assert.equal(nextScheduledCheck("2026-09-29T07:20:00Z"), "2026-09-30T07:13:00.000Z");

  // The served cycle receipt is retained as read, and it never decides the status.
  const servedReceipt = { url: "/data/connected_history_cycle.json", sha256: "c".repeat(64), run_id: "github-actions:1:1", github_run_id: 1, outcome: "unchanged" };
  const withReceipt = scheduledCycleStatus(input({ served_cycle_receipt: servedReceipt }));
  assert.deepEqual(withReceipt.served_cycle_receipt, servedReceipt);
  assert.equal(withReceipt.status, "observed");
  assert.equal(scheduledCycleStatus(input({ observations: workflow([]), served_cycle_receipt: servedReceipt })).status, "open");
});

test("acceptance is derived from facts and never met from a rehearsal", () => {
  const artifacts = { ...committedArtifacts(), journeys: passingJourneys() };
  const readback = (evidenceClass, cycleStatus) => ({
    evidence_class: evidenceClass,
    delivery: { served_contains_delivery: true },
    capabilities: CAPABILITIES.map((definition) => evaluateCapability(definition, artifacts, { ...PRODUCTION_CONTEXT, evidence_class: evidenceClass })),
    false_positive_audit: auditAdmittedFalsePositives(artifacts),
    scheduled_cycle: { status: cycleStatus },
  });
  const production = deriveAcceptance(readback("deployed_production_read_back", "open"));
  assert.deepEqual(production, { A1: "met", A2: "met", A3: "open", A4: "write_through_unobserved", A5: "open", A6: "met" });
  assert.equal(deriveAcceptance(readback("deployed_production_read_back", "observed")).A3, "met");
  assert.equal(deriveAcceptance(readback("deployed_production_read_back", "overdue")).A5, "overdue");
  const rehearsal = deriveAcceptance(readback("local_origin_rehearsal", "observed"));
  assert.equal(rehearsal.A1, "open");
  assert.equal(rehearsal.A2, "open");

  const failedJourney = readback("deployed_production_read_back", "open");
  failedJourney.capabilities.find((record) => record.id === "search-history-discovery").observed.status = "failed";
  assert.equal(deriveAcceptance(failedJourney).A1, "open");
});

function productionReadback({ cycle = { status: "open" } } = {}) {
  const artifacts = { ...committedArtifacts(), journeys: passingJourneys() };
  return {
    evidence_class: "deployed_production_read_back",
    delivery: { served_contains_delivery: true },
    capabilities: CAPABILITIES.map((definition) => evaluateCapability(definition, artifacts, PRODUCTION_CONTEXT)),
    false_positive_audit: auditAdmittedFalsePositives(artifacts),
    scheduled_cycle: clone(cycle),
  };
}

const OBSERVED_CYCLE = Object.freeze({
  status: "observed",
  observed_cycle: { workflow: "connected-history-cycle.yml", run_id: 1, merge_commit: "b".repeat(40) },
});

function conditionValues(readback) {
  return Object.fromEntries(Object.entries(ACCEPTANCE_CONDITIONS).map(([name, condition]) => [name, condition(readback)]));
}

test("A4 names its unobservable write-through instead of reading met", () => {
  const complete = productionReadback({ cycle: OBSERVED_CYCLE });
  assert.equal(deriveAcceptance(complete).A4, "write_through_unobserved", "every in-repo fact present");
  assert.match(
    ACCEPTANCE_LETTERS.A4.clauses.find((clause) => clause.unobservable).unobservable,
    /realization records live outside this repository/,
  );

  // Facts that claim a write-through are not observations of one.
  const claimed = productionReadback({ cycle: OBSERVED_CYCLE });
  claimed.realization_record = { target: "realization-record", realized_outcomes: ["delivered"], coverage_limits: ["complete"] };
  claimed.write_through = true;
  assert.equal(deriveAcceptance(claimed).A4, "write_through_unobserved");

  // Each in-repo clause, broken alone, turns the letter open.
  const withoutOutcome = productionReadback({ cycle: OBSERVED_CYCLE });
  delete withoutOutcome.capabilities[0].realized_outcome;
  assert.equal(deriveAcceptance(withoutOutcome).A4, "open", "a record without a realized outcome");

  const withoutLimits = productionReadback({ cycle: OBSERVED_CYCLE });
  withoutLimits.capabilities.find((record) => record.id === "board-coverage-census").unresolved_limits = [];
  assert.equal(deriveAcceptance(withoutLimits).A4, "open", "the coverage limits are dropped");

  const separateUpdate = productionReadback({ cycle: OBSERVED_CYCLE });
  separateUpdate.capabilities[0].destination = "/weekly-update/";
  assert.equal(deriveAcceptance(separateUpdate).A4, "open", "a record points at a separate update");
});

test("no combination of in-repo facts can make A4 read met", () => {
  const names = Object.keys(ACCEPTANCE_CONDITIONS);
  const states = new Set();
  for (let mask = 0; mask < 2 ** names.length; mask += 1) {
    const values = Object.fromEntries(names.map((name, index) => [name, Boolean(mask & (1 << index))]));
    states.add(deriveLetter("A4", values));
  }
  assert.deepEqual([...states].sort(), ["open", "write_through_unobserved"]);
});

test("every acceptance letter is derived from conditions that cover each of its clauses", () => {
  const letters = Object.keys(ACCEPTANCE_LETTERS);
  assert.deepEqual(letters, ["A1", "A2", "A3", "A4", "A5", "A6"]);
  assert.deepEqual(Object.keys(deriveAcceptance(productionReadback())), letters);
  const referenced = new Set();
  for (const [letter, definition] of Object.entries(ACCEPTANCE_LETTERS)) {
    // The clause spans quote the letter and, between them, leave only connectives.
    let rest = definition.letter;
    for (const clause of definition.clauses) {
      assert.ok(rest.includes(clause.span), `${letter}: "${clause.span}" is not an unclaimed span of its letter`);
      rest = rest.replace(clause.span, " ");
    }
    const leftover = rest.split(/[\s;,.]+/).filter(Boolean);
    assert.deepEqual(leftover.filter((word) => !["and", "or", "then"].includes(word)), [], `${letter} has clause text no rule covers`);

    for (const clause of definition.clauses) {
      const observable = Array.isArray(clause.conditions) && clause.conditions.length > 0;
      const declared = typeof clause.unobservable === "string" && clause.unobservable.length > 0;
      assert.ok(observable !== declared, `${letter}: "${clause.span}" names conditions or an unobservable half, exactly one`);
      for (const name of clause.conditions || []) {
        assert.equal(typeof ACCEPTANCE_CONDITIONS[name], "function", `${letter} reads unknown condition ${name}`);
        referenced.add(name);
      }
    }
    const unobservable = definition.clauses.some((clause) => clause.unobservable);
    if (unobservable) assert.ok(!["met", "open", "overdue"].includes(definition.unobserved), `${letter} names a distinct unobserved state`);
    if (definition.overdue) referenced.add(definition.overdue);

    // With every condition true the letter reads met, or its named state when a half is unobservable.
    const all = Object.fromEntries(Object.keys(ACCEPTANCE_CONDITIONS).map((name) => [name, true]));
    if (definition.overdue) all[definition.overdue] = false;
    assert.equal(deriveLetter(letter, all), unobservable ? definition.unobserved : "met", letter);
    // Each condition a clause names actually gates the letter.
    for (const name of new Set(definition.clauses.flatMap((clause) => clause.conditions || []))) {
      assert.ok(["open", "overdue"].includes(deriveLetter(letter, { ...all, [name]: false })), `${letter} ignores ${name}`);
    }
  }
  assert.deepEqual(Object.keys(ACCEPTANCE_CONDITIONS).filter((name) => !referenced.has(name)), [], "no condition is outside the letters");
});

test("acceptance conditions: each holds on a complete production read-back and fires on a violating mutation", () => {
  const base = productionReadback({ cycle: OBSERVED_CYCLE });
  const holding = conditionValues(base);
  assert.deepEqual(Object.keys(holding).filter((name) => holding[name] !== (name !== "scheduled_cycle_overdue")), []);
  assert.deepEqual(deriveAcceptance(base), { A1: "met", A2: "met", A3: "met", A4: "write_through_unobserved", A5: "met", A6: "met" });

  const record = (readback, id) => readback.capabilities.find((entry) => entry.id === id);
  const mutations = {
    production_origin: (r) => { r.evidence_class = "local_origin_rehearsal"; },
    complete_records: (r) => { r.capabilities[0].vintage = null; },
    all_capabilities_passed: (r) => { r.capabilities[1].observed.status = "failed"; },
    six_journeys_passed: (r) => { record(r, "search-history-discovery").observed.result.families_passed.pop(); },
    false_positives_withheld: (r) => { r.false_positive_audit = { status: "withheld", admitted_false_positives: [{ relation: "x" }], withheld_relations: [] }; },
    scheduled_cycle_classified: (r) => { r.scheduled_cycle = {}; },
    no_citywide_completeness_claim: (r) => { record(r, "board-coverage-census").unresolved_limits = ["does not measure or equalize civic activity"]; },
    no_equal_activity_claim: (r) => { record(r, "board-coverage-census").unresolved_limits = ["does not claim citywide completeness"]; },
    outcomes_reported: (r) => { r.capabilities[2].unresolved_limits = "none"; },
    destinations_are_existing_routes: (r) => { r.capabilities[3].destination = "/weekly-update/"; },
    scheduled_cycle_observed: (r) => { r.scheduled_cycle.status = "open"; },
    scheduled_cycle_overdue: (r) => { r.scheduled_cycle.status = "overdue"; },
    observed_cycle_receipt: (r) => { delete r.scheduled_cycle.observed_cycle; },
    dossier_only: (r) => { record(r, "search-history-discovery").observed.result.expected += 1; },
  };
  assert.deepEqual(Object.keys(mutations).sort(), Object.keys(ACCEPTANCE_CONDITIONS).sort());
  for (const [name, mutate] of Object.entries(mutations)) {
    const readback = clone(base);
    mutate(readback);
    assert.equal(ACCEPTANCE_CONDITIONS[name](readback), !holding[name], `${name} fires`);
  }
});

test("retained production read-backs re-derive from committed bytes and a descendant of the delivery", () => {
  const retainedPath = join(ROOT, RETAINED_PATH);
  assert.ok(existsSync(retainedPath), "the release read-back has been retained");
  const text = readFileSync(retainedPath, "utf8");
  assert.doesNotMatch(text, /(?:\/Users\/|\/private\/|\/var\/folders\/|local_path|screenshot_directory)/);
  const retained = JSON.parse(text);
  assert.equal(retained.schema, RELEASE_READBACK_SCHEMA);
  assert.equal(retained.image_binaries_committed, false);
  assert.deepEqual(retained.measurement_provenance.inputs.map((input) => input.path), [...MEASURED_INPUTS]);
  const provenance = retainedMeasurementStatus(ROOT, retained.measurement_provenance);
  assert.equal(provenance.ok, true, `${provenance.reason}: ${provenance.changedInputs.join(", ")}`);
  assert.ok(retained.readbacks.length > 0);

  const committed = committedArtifacts();
  for (const readback of retained.readbacks) {
    assert.ok(PRODUCTION_HOSTS.includes(new URL(readback.origin).hostname));
    assert.equal(readback.evidence_class, "deployed_production_read_back");
    assert.equal(readback.delivery.landed_commit, RELEASE_DELIVERY.landed_commit);
    assert.ok(isAncestor(RELEASE_DELIVERY.landed_commit, readback.served.revision), "served revision contains the delivery");
    assert.ok(isAncestor(readback.code_revision, "HEAD"), "code revision is in this tree's history");
    const derived = deriveAcceptance(readback);
    if (readback.acceptance_rule === ACCEPTANCE_RULE) {
      assert.deepEqual(readback.acceptance, derived, "acceptance is derived, not declared");
    } else {
      // Retained before the clause table: it differs from the current rule only
      // where that rule was strengthened, and the record itself is not rewritten.
      assert.equal(readback.acceptance_rule, undefined);
      assert.deepEqual({ ...readback.acceptance, A4: derived.A4 }, derived, "only A4 changed with the rule");
      assert.equal(readback.acceptance.A4, "met");
      assert.equal(derived.A4, "write_through_unobserved");
    }

    // Served bytes equal to the committed bytes reproduce every observed result.
    const sameBytes = Object.keys(SERVED_DATA).every((key) => readback.data[key]?.sha256 === sha256(readBytes(`site${SERVED_DATA[key]}`)));
    if (sameBytes) {
      const artifacts = { ...committed, journeys: readback.journeys };
      const context = {
        data: readback.data,
        served_revision: readback.served.revision,
        code_revision: readback.code_revision,
        evidence_class: readback.evidence_class,
      };
      for (const definition of CAPABILITIES) {
        const record = readback.capabilities.find((entry) => entry.id === definition.id);
        assert.deepEqual(record, evaluateCapability(definition, artifacts, context), definition.id);
      }
      assert.deepEqual(readback.false_positive_audit, auditAdmittedFalsePositives(committed));
    }
    const cycle = readback.scheduled_cycle;
    if (cycle.status !== "observed") {
      assert.match(cycle.next_check_at, /^\d{4}-\d{2}-\d{2}T/, "an open cycle records its next check");
      assert.equal(readback.acceptance.A3, "open");
    }
  }
});

function startOrigin({ revision, htmlFor = [] }) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    if (path === "/artifact-manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ source_commit_sha: revision, deployment_at: "2026-09-29T00:00:00.000Z" }));
      return;
    }
    if (htmlFor.includes(path)) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>CityScroll</title>");
      return;
    }
    if (path.startsWith("/data/")) {
      try {
        const bytes = readBytes(`site${path}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(bytes);
      } catch {
        response.writeHead(404);
        response.end();
      }
      return;
    }
    response.writeHead(404);
    response.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function runRunner(base, extra = []) {
  const scratch = mkdtempSync(join(tmpdir(), "history-release-test-"));
  try {
    const result = await run(
      process.execPath,
      ["tools/check_connected_history_release.mjs", "--base-url", base, "--no-browser", "--no-schedule", ...extra],
      { cwd: ROOT, env: { ...process.env, TMPDIR: scratch }, maxBuffer: 16 * 1024 * 1024 },
    ).then((value) => ({ code: 0, ...value }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
    return result;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("A3 runner: a loopback origin is a rehearsal, and a served build without the delivery is refused", async () => {
  const retainedBefore = existsSync(join(ROOT, RETAINED_PATH)) ? sha256(readBytes(RETAINED_PATH)) : null;
  const contains = await startOrigin({ revision: RELEASE_DELIVERY.landed_commit, htmlFor: [SERVED_DATA.coverage] });
  try {
    const result = await runRunner(contains.base);
    assert.equal(result.code, 0, result.stderr);
    const readback = JSON.parse(result.stdout);
    assert.equal(readback.evidence_class, "local_origin_rehearsal");
    assert.equal(readback.delivery.served_contains_delivery, true);
    const byId = new Map(readback.capabilities.map((record) => [record.id, record]));
    assert.equal(byId.get("typed-history-relations").observed.status, "passed");
    assert.equal(byId.get("parcel-history-reader").observed.status, "passed");
    assert.equal(byId.get("board-coverage-census").observed.status, "failed", "an HTML fallback is not a served census");
    assert.match(readback.data.coverage.error, /not a served JSON materialization/);
    assert.equal(byId.get("search-history-discovery").observed.status, "failed");
    assert.equal(readback.acceptance.A1, "open");
    assert.equal(readback.scheduled_cycle.status, "open");

    const write = await runRunner(contains.base, ["--write"]);
    assert.equal(write.code, 2);
    assert.match(write.stderr, /only a deployed production read-back is retained/);
  } finally {
    contains.server.close();
  }

  const parent = spawnSync("git", ["rev-parse", `${RELEASE_DELIVERY.landed_commit}^`], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  const lacks = await startOrigin({ revision: parent });
  try {
    const result = await runRunner(lacks.base);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /does not contain release delivery/);
  } finally {
    lacks.server.close();
  }
  const retainedAfter = existsSync(join(ROOT, RETAINED_PATH)) ? sha256(readBytes(RETAINED_PATH)) : null;
  assert.equal(retainedAfter, retainedBefore, "the runner never rewrites the retained record from a test");
});
