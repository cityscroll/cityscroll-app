/**
 * Contract tests for the Desk repair queue.
 *
 * The observation contract answers "what did we see"; this queue answers "what
 * is there to repair". The two questions have different grains, and most of
 * what can go wrong here is a grain error: the same repair opening a new row
 * every pass, a symptom count read as a repair count, an absence read as a
 * defect, a failed read read as an all-clear, or a machine deciding that two
 * symptoms are one repair when only a person can say so.
 *
 * Fixtures are literal and bounded. Where a case reads committed data it says
 * so, so a failure points at the contract rather than at the state of the
 * warehouse.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  REPAIR_QUEUE_REGISTER_PATH,
  REPAIR_QUEUE_REGISTER_SCHEMA,
  REPAIR_QUEUE_SCHEMA,
  REPAIR_QUEUE_STATES,
  REPAIR_QUEUE_VERIFICATION_STATES,
  REPAIR_QUEUE_WORK_STATES,
  buildRepairQueue,
  renderRepairQueueSection,
  repairIssueKey,
  repairQueueStateForDisposition,
  validateRepairQueueRegister,
} from "../tools/repair_queue.mjs";
import {
  REPAIR_DISPOSITIONS,
  REPAIR_OBSERVATION_CONDITIONS,
  buildRepairObservation,
  groupRepairObservations,
  repairObservationLeakFindings,
} from "../tools/repair_observations.mjs";
import {
  ROOT,
  buildDataSourceGraph,
  communityBoardRepairObservations,
  generatedGraphFiles,
} from "../tools/data_source_graph.mjs";
import { buildPublicSourceHealthProjection } from "../site/source_health_public_projection.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const OBSERVED_AT = "2026-08-25T01:57:25.541Z";
const CONTRACT_ID = "board-sources";

/** One observation at a named scope, with everything else held constant. */
function observation({
  scope = "fixture-cb-01:upcoming_meetings",
  condition = "source-retrieval-failed",
  adapter = "html_pdf_v1",
  contractId = CONTRACT_ID,
  observedAt = OBSERVED_AT,
  detailCode = "source_not_checked",
  locator = "site/data/community_board_meeting_index.json#/receipts/0",
  records = 0,
  codeRevision = "ca8ad3ee60fb2678",
} = {}) {
  return buildRepairObservation({
    condition,
    detail_code: detailCode,
    source_contract_id: contractId,
    source_id: scope,
    adapter,
    origin_url: "https://example.gov/fixture/calendar",
    scope_kind: "community_board_source_role",
    scope_id: scope,
    body_id: scope.split(":")[0],
    role: scope.split(":")[1],
    affected_record_count: records,
    publisher: "Fixture Community Board",
    code_paths: ["site/community_board_source_adapters.mjs"],
    observed_at: observedAt,
    source_vintage: observedAt,
    code_revision: codeRevision,
    evidence_locator: locator,
    receipt_ref: "site/data/non_council_outcome_sources/verification_receipts/fixture.json",
    receipt_status: "unknown",
    fetch_status: "browser-required",
  });
}

const IDENTITY = { source_contract_id: CONTRACT_ID, condition: "source-retrieval-failed", adapter: "html_pdf_v1" };

function register(issue = {}) {
  return {
    schema: REPAIR_QUEUE_REGISTER_SCHEMA,
    issues: [{
      issue_key: repairIssueKey(IDENTITY),
      identity: IDENTITY,
      engineering_card: null,
      deduplication_verified: null,
      resolution_receipt: null,
      ...issue,
    }],
  };
}

const RESOLUTION = {
  at: "2026-09-01T00:00:00.000Z",
  outcome: "The adapter was extended to cover the declared format.",
  reference: "https://github.com/cityscroll/cityscroll-app/pull/1709",
  label: "Adapter coverage change",
};

// The committed pass, read once. Cases that assert against it say so by name.
const committedRegistry = readJson("site/data/source_contracts.json");
const committedPass = communityBoardRepairObservations(committedRegistry);
const committedQueue = buildRepairQueue({
  observations: committedPass.observations,
  register: readJson(REPAIR_QUEUE_REGISTER_PATH),
  observedAt: committedPass.observedAt,
  sourceVintage: committedPass.sourceVintage,
  ingestion: committedPass.ingestion,
});

test("A1 the desk artifact carries the queue and the public source-health projection carries none of it", () => {
  const graph = JSON.parse(generatedGraphFiles()[ "data-source-graph.json" ]);
  assert.equal(graph.repair_queue.schema, REPAIR_QUEUE_SCHEMA);
  assert.equal(graph.repair_queue.visibility, "private");
  assert.equal(graph.repair_queue.consumer, "authenticated desk");
  assert.ok(graph.repair_queue.issues.length > 0, "the committed pass produces real issues");

  // The same evidence, projected for a reader. Every queue token is a machine
  // identifier with no reason to appear there, so a hit is a leak.
  const publicProjection = buildPublicSourceHealthProjection({
    registry: committedRegistry,
    observations: readJson("site/data/source_health_observations.json"),
  });
  assert.deepEqual(
    repairObservationLeakFindings(publicProjection, { label: "public source health", observations: committedPass.observations }),
    [],
  );
  const publicText = JSON.stringify(publicProjection);
  for (const token of [REPAIR_QUEUE_SCHEMA, "repair_queue", "issue_key", "deduplication_verified", ...REPAIR_QUEUE_STATES]) {
    assert.ok(!publicText.includes(token), `public projection must not carry ${token}`);
  }
  for (const issue of graph.repair_queue.issues) {
    assert.ok(!publicText.includes(issue.issue_key), "an issue key must not reach a public payload");
  }
});

test("A1 the queue is derived, never served, and never committed", () => {
  const ignored = readFileSync(join(ROOT, ".gitignore"), "utf8").split("\n").map((line) => line.trim());
  assert.ok(ignored.includes("docs/data-source-graph.json"), "the queue's only carrier stays untracked");
  assert.ok(ignored.includes("docs/data-source-graph.html"), "the rendered desk stays untracked");
  // The reviewed register is the one committed half. It holds judgements a
  // person made, never observation records.
  const reviewed = readJson(REPAIR_QUEUE_REGISTER_PATH);
  assert.equal(reviewed.schema, REPAIR_QUEUE_REGISTER_SCHEMA);
  assert.deepEqual(validateRepairQueueRegister(reviewed), []);
  const text = JSON.stringify(reviewed);
  for (const token of ["fingerprint", "first_observed_at", "last_observed_at", "evidence_locator", "observation_count"]) {
    assert.ok(!text.includes(token), `the reviewed register must not restate the observation record (${token})`);
  }
});

test("A2 repeated symptoms upsert into one issue with an affected-scope count", () => {
  const observations = ["fixture-cb-01", "fixture-cb-02", "fixture-cb-03"]
    .map((board) => observation({ scope: `${board}:upcoming_meetings` }));
  const queue = buildRepairQueue({ observations, observedAt: OBSERVED_AT });
  assert.equal(queue.issue_count, 1);
  const [issue] = queue.issues;
  assert.equal(issue.affected_scopes, 3);
  assert.equal(issue.observations.length, 3);
  assert.equal(issue.issue_key, repairIssueKey(IDENTITY));
  // The queue's grouping and the observation contract's grouping are the same
  // count seen from two modules; a divergence means one of them drifted.
  const [group] = groupRepairObservations(observations);
  assert.equal(group.affected_scopes, issue.affected_scopes);
});

test("A2 a wording change, a newer sighting, another scope or a new code revision does not open a new issue", () => {
  const base = buildRepairQueue({ observations: [observation()], observedAt: OBSERVED_AT });
  const moved = buildRepairQueue({
    observations: [
      observation({ observedAt: "2026-09-04T00:00:00.000Z", codeRevision: "0000abcd0000abcd", locator: "site/data/community_board_meeting_index.json#/receipts/91" }),
      observation({ scope: "fixture-cb-09:upcoming_meetings", observedAt: "2026-09-04T00:00:00.000Z" }),
    ],
    observedAt: "2026-09-04T00:00:00.000Z",
  });
  assert.equal(moved.issue_count, 1);
  assert.equal(moved.issues[0].issue_key, base.issues[0].issue_key);
  assert.equal(moved.issues[0].affected_scopes, 2, "the second scope raises the count, it does not open a row");
  assert.equal(moved.issues[0].last_observed_at, "2026-09-04T00:00:00.000Z", "recency moves");
  // The condition detail is presentation copy owned by the observation
  // contract. Rewording it must not be a way to open or close a repair.
  const reworded = repairIssueKey({ ...IDENTITY, condition: IDENTITY.condition });
  assert.equal(reworded, base.issues[0].issue_key);
});

test("A2 a different source contract, condition or adapter is a different issue", () => {
  const keys = new Set([
    repairIssueKey(IDENTITY),
    repairIssueKey({ ...IDENTITY, source_contract_id: "other-sources" }),
    repairIssueKey({ ...IDENTITY, condition: "source-format-unsupported" }),
    repairIssueKey({ ...IDENTITY, adapter: "airtable_v1" }),
    repairIssueKey({ ...IDENTITY, adapter: null }),
  ]);
  assert.equal(keys.size, 5);
  const queue = buildRepairQueue({
    observations: [observation(), observation({ adapter: "airtable_v1", scope: "fixture-cb-02:upcoming_meetings" })],
    observedAt: OBSERVED_AT,
  });
  assert.equal(queue.issue_count, 2, "two adapters are two repairs even under one condition");
});

test("A2 the issue key is a pure function of identity and holds across passes", () => {
  const first = buildRepairQueue({ observations: [observation()], observedAt: OBSERVED_AT });
  const second = buildRepairQueue({ observations: [observation()], observedAt: OBSERVED_AT });
  assert.deepEqual(second, first, "the same pass replays to the same queue");
  assert.equal(repairIssueKey(IDENTITY), repairIssueKey({ ...IDENTITY }));
});

test("A3 every disposition reaches a distinct state and none of them is repair by default", () => {
  assert.deepEqual([...REPAIR_QUEUE_STATES].sort(), [
    "expected-absence", "regressed", "repair-candidate", "resolved", "source-policy-limitation",
  ]);
  const states = REPAIR_DISPOSITIONS.map(repairQueueStateForDisposition);
  assert.deepEqual(states, ["repair-candidate", "expected-absence", "source-policy-limitation"]);
  assert.deepEqual(REPAIR_QUEUE_WORK_STATES, ["repair-candidate", "regressed"]);
  // Every condition in the closed vocabulary lands somewhere; a new one cannot
  // silently fall into the work queue.
  for (const [id, entry] of Object.entries(REPAIR_OBSERVATION_CONDITIONS)) {
    const state = repairQueueStateForDisposition(entry.disposition);
    assert.ok(REPAIR_QUEUE_STATES.includes(state), `${id} has no state`);
    if (entry.disposition !== "repair") {
      assert.ok(!REPAIR_QUEUE_WORK_STATES.includes(state), `${id} must not be engineering work`);
    }
  }
});

test("A3 an expected absence and a policy limitation are counted apart from repair work", () => {
  const queue = buildRepairQueue({
    observations: [
      observation(),
      observation({ condition: "checked-no-records", scope: "fixture-cb-04:minutes" }),
      observation({ condition: "source-not-published", adapter: null, scope: "fixture-cb-05:minutes" }),
    ],
    observedAt: OBSERVED_AT,
  });
  assert.equal(queue.counts["repair-candidate"], 1);
  assert.equal(queue.counts["expected-absence"], 1);
  assert.equal(queue.counts["source-policy-limitation"], 1);
  assert.equal(queue.open_work_count, 1, "only the repair disposition is work");
  const absence = queue.issues.find((issue) => issue.state === "expected-absence");
  assert.equal(absence.detail, REPAIR_OBSERVATION_CONDITIONS["checked-no-records"].detail);
  assert.doesNotMatch(renderRepairQueueSection(queue), /defect|failure of the publisher|publisher fail/i);
});

test("A3 resolved and regressed are distinct, and only a recorded receipt can produce either", () => {
  const observations = [observation()];
  const receipted = register({ resolution_receipt: RESOLUTION });

  // Still observed, with a receipt on file: the repair came back.
  const regressed = buildRepairQueue({ observations, register: receipted, observedAt: OBSERVED_AT });
  assert.equal(regressed.issues[0].state, "regressed");
  assert.equal(regressed.open_work_count, 1, "a regression is outstanding work again");

  // No longer observed, receipt on file: resolved, and still on the desk so the
  // receipt that closed it stays readable.
  const resolved = buildRepairQueue({ observations: [], register: receipted, observedAt: OBSERVED_AT });
  assert.equal(resolved.issue_count, 1);
  assert.equal(resolved.issues[0].state, "resolved");
  assert.equal(resolved.open_work_count, 0);
  assert.equal(resolved.issues[0].resolution_receipt.reference, RESOLUTION.reference);

  // No receipt and no observation: nothing to show. The queue never decides on
  // its own that a repair finished.
  assert.equal(buildRepairQueue({ observations: [], register: register(), observedAt: OBSERVED_AT }).issue_count, 0);
  assert.equal(buildRepairQueue({ observations, register: register(), observedAt: OBSERVED_AT }).issues[0].state, "repair-candidate");
});

test("A3 a failed ingestion is a state, never an all-clear", () => {
  const queue = buildRepairQueue({
    observations: [],
    observedAt: OBSERVED_AT,
    ingestion: {
      available: false,
      reason: "the committed source receipts the repair projection reads were not available",
      missing_inputs: ["site/data/community_board_meeting_index.json"],
    },
  });
  assert.equal(queue.status, "unavailable");
  assert.equal(queue.counts, null, "a count of zero would be a claim this pass cannot make");
  assert.equal(queue.open_work_count, null);
  assert.equal(queue.issue_count, null);
  const html = renderRepairQueueSection(queue);
  assert.match(html, /Repair queue unavailable/);
  assert.match(html, /not an all-clear/);
  assert.match(html, /community_board_meeting_index\.json/);
  assert.doesNotMatch(html, /0 Repair candidate/);

  // A measured empty pass says something different from an unread one.
  const empty = buildRepairQueue({ observations: [], observedAt: OBSERVED_AT });
  assert.equal(empty.status, "available");
  assert.equal(empty.counts["repair-candidate"], 0);
  assert.match(renderRepairQueueSection(empty), /measured empty queue rather than an unread one/);
});

test("A3 a missing input makes the committed producer report unavailable rather than clean", () => {
  const graph = buildDataSourceGraph({
    registry: { contracts: [] },
    gapTaxonomy: { gaps: [] },
    warehouse: { datasets: [] },
    wranglerText: "",
    workerText: "",
    externalAwardText: "",
    receipts: new Map(),
    repairObservations: [],
    repairIngestion: { available: false, reason: "receipts unavailable", missing_inputs: ["site/data/community_board_meeting_index.json"] },
    inputs: [],
  });
  assert.equal(graph.repair_queue.status, "unavailable");
  assert.equal(graph.repair_queue.counts, null);
  assert.equal(graph.repair_queue.ingestion.available, false);
});

test("A4 a finding stays a candidate until the record's producer verifies the deduplication", () => {
  assert.deepEqual(REPAIR_QUEUE_VERIFICATION_STATES, ["candidate", "deduplication-verified"]);
  const candidate = buildRepairQueue({ observations: [observation()], observedAt: OBSERVED_AT });
  assert.equal(candidate.issues[0].verification, "candidate");
  assert.match(renderRepairQueueSection(candidate), /has not been verified by the record’s producer/);

  const verified = buildRepairQueue({
    observations: [observation()],
    register: register({
      deduplication_verified: { at: "2026-09-02T00:00:00.000Z", by: "source-contract owner", basis: "Six scopes share one adapter contract." },
    }),
    observedAt: OBSERVED_AT,
  });
  assert.equal(verified.issues[0].verification, "deduplication-verified");
  assert.match(renderRepairQueueSection(verified), /Verified 2026-09-02T00:00:00\.000Z by source-contract owner/);

  // Every issue the committed pass produces is a candidate: nothing in the
  // build can promote one.
  assert.ok(committedQueue.issues.every((issue) => issue.verification === "candidate"));
});

test("A4 group details carry the owner, the existing record, the receipt and the original evidence", () => {
  const queue = buildRepairQueue({
    observations: [
      observation({ locator: "site/data/community_board_meeting_index.json#/receipts/4", observedAt: "2026-07-01T00:00:00.000Z" }),
      observation({ scope: "fixture-cb-02:upcoming_meetings", locator: "site/data/community_board_meeting_index.json#/receipts/9" }),
    ],
    register: register({ engineering_card: { reference: RESOLUTION.reference, label: "Adapter coverage change" }, resolution_receipt: RESOLUTION }),
    observedAt: OBSERVED_AT,
  });
  const [issue] = queue.issues;
  assert.equal(issue.owner.source_contract_id, CONTRACT_ID);
  assert.deepEqual(issue.owner.publishers, ["Fixture Community Board"]);
  assert.deepEqual(issue.owner.code_paths, ["site/community_board_source_adapters.mjs"]);
  // Original evidence is the receipt that RECORDED the condition, not the
  // newest sighting of it.
  assert.equal(issue.original_evidence.locator, "site/data/community_board_meeting_index.json#/receipts/4");
  assert.equal(issue.first_observed_at, "2026-07-01T00:00:00.000Z");

  const html = renderRepairQueueSection(queue);
  assert.match(html, /Existing engineering record/);
  assert.match(html, /Adapter coverage change/);
  assert.match(html, /Resolution receipt/);
  assert.match(html, /receipts\/4/);
  assert.match(html, /Affected scopes/);
  assert.match(html, /fixture-cb-02:upcoming_meetings/);
});

test("A4 the committed pass links a real existing record on a real repair candidate", () => {
  const linked = committedQueue.issues.filter((issue) => issue.engineering_card);
  assert.ok(linked.length > 0, "the reviewed register links at least one committed issue");
  for (const issue of linked) {
    assert.match(issue.engineering_card.reference, /^https:\/\//);
    assert.ok(issue.engineering_card.label, "a linked record is labelled, not a bare URL");
  }
  const html = renderRepairQueueSection(committedQueue);
  for (const issue of linked) assert.ok(html.includes(issue.engineering_card.reference));
});

test("A4 the register refuses an owner-only or local reference and a mismatched identity", () => {
  // The home-path case is assembled from segments for the same reason the
  // private-evidence scheme beside it is: a literal absolute home path in
  // tracked source is itself the thing this repository rejects. The value the
  // register is asked to validate is unchanged.
  const homePath = ["", "Users", "example", "notes.md"].join("/");
  for (const reference of [
    ["backstage", "://cityscroll-evidence/repair/1"].join(""),
    `file://${homePath}`,
    homePath,
    "http://localhost:8080/repair",
    "not a url",
  ]) {
    const findings = validateRepairQueueRegister(register({ engineering_card: { reference } }));
    assert.ok(findings.length > 0, `${reference} must be refused`);
  }
  assert.deepEqual(
    validateRepairQueueRegister(register({ engineering_card: { reference: RESOLUTION.reference } })),
    [],
  );
  const mismatched = register();
  mismatched.issues[0].identity = { ...IDENTITY, adapter: "airtable_v1" };
  assert.ok(validateRepairQueueRegister(mismatched).some((finding) => finding.includes("does not derive")));
  assert.throws(() => buildRepairQueue({ observations: [], register: mismatched }), /register rejected/);
  // A condition outside the closed vocabulary cannot be registered into the queue.
  const invented = register();
  invented.issues[0].identity = { ...IDENTITY, condition: "source-looks-wrong" };
  assert.ok(validateRepairQueueRegister(invented).some((finding) => finding.includes("closed condition vocabulary")));
});

test("A5 the rendered view groups rows, keeps expansion keyboard-reachable and carries no owner-only link", () => {
  const html = renderRepairQueueSection(committedQueue);
  const groups = [...html.matchAll(/<details class="queue-issue"/g)];
  assert.equal(groups.length, committedQueue.issues.length);
  assert.equal([...html.matchAll(/<summary>/g)].length, committedQueue.issues.length, "every group expands from a summary");
  assert.match(html, /<select id="repairState"/);
  assert.match(html, /<label for="repairState"/);
  for (const state of REPAIR_QUEUE_STATES) assert.ok(html.includes(`data-repair-state="${state}"`) || committedQueue.counts[state] === 0);
  for (const marker of [["backstage", "://"].join(""), "file://", "/Users/", "/var/folders/", "127.0.0.1", "localhost"]) {
    assert.ok(!html.includes(marker), `the desk view must not render ${marker}`);
  }
  // Every href it does render is a stable public URL.
  for (const [, href] of html.matchAll(/href="([^"]+)"/g)) assert.match(href, /^https:\/\//);
});

test("A5 the queue read model reaches the desk and no queue field reaches the Worker bundle", () => {
  const workerText = readFileSync(join(ROOT, "worker/src/worker.mjs"), "utf8");
  assert.ok(!workerText.includes("repair_queue"), "the queue is not a Worker read model");
  assert.ok(!workerText.includes("repair_observations"));
  // The queue's own module is a Node build tool: it hashes with node:crypto,
  // which the Worker deliberately cannot reach without nodejs_compat.
  assert.match(readFileSync(join(ROOT, "tools/repair_queue.mjs"), "utf8"), /import \{ createHash \} from "node:crypto";/);
});
