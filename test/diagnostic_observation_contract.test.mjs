/**
 * Contract tests for the private repair-observation projection.
 *
 * The projection exists because resident explanation and operational
 * observability are different jobs over the same evidence. These tests hold
 * both halves of that claim at once: the operator record must carry enough to
 * repair a source, and the public projections must carry none of it.
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
  JOIN_REASON_CONDITIONS,
  REPAIR_DISPOSITIONS,
  REPAIR_OBSERVATION_CONDITIONS,
  REPAIR_OBSERVATION_CONDITION_IDS,
  REPAIR_OBSERVATION_OPERATOR_FIELDS,
  REPAIR_OBSERVATION_SCHEMA,
  buildCommunityBoardRepairObservations,
  buildJoinRepairObservations,
  buildRepairObservation,
  groupRepairObservations,
  mergeRepairObservations,
  repairCodeRevision,
  repairObservationFingerprint,
  repairObservationLeakFindings,
  repairObservationSet,
  repairWorkObservations,
  validateRepairObservation,
} from "../tools/repair_observations.mjs";
import { ROOT, communityBoardRepairObservations } from "../tools/data_source_graph.mjs";
import {
  buildResidentCopyBoundaryCorpus,
  checkResidentCopyBoundary,
  inspectResidentCopyBoundary,
} from "../tools/resident_copy_boundary.mjs";
import {
  buildCommunityBoardConstellationView,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import { joinCommunityBoardSourceRecords } from "../site/community_board_source_join.mjs";
import {
  buildPublicSourceHealthProjection,
  publicSourceHealthProjectionLeaks,
  validatePublicSourceHealthProjection,
} from "../site/source_health_public_projection.mjs";

const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const CONTRACT = { id: "board-sources", code_references: [{ path: "site/community_board_source_adapters.mjs" }] };
const OBSERVED_AT = "2026-08-25T01:57:25.541Z";

/**
 * One materialized source-role receipt per condition the card names. These are
 * the shapes tools/build_community_board_meeting_index.mjs writes, trimmed to
 * the fields the projection reads.
 */
const RECEIPT_FIXTURES = Object.freeze({
  "unsupported format": {
    board_id: "fixture-cb-01",
    role: "upcoming_meetings",
    source_url: "https://example.gov/fixture-cb-01/calendar",
    adapter: null,
    state: "unsupported-format",
    state_reason: "source_not_checked",
    observed_receipt: { status: "unknown", fetch_status: null },
    materialized_record_count: 0,
  },
  "failed check": {
    board_id: "fixture-cb-02",
    role: "upcoming_meetings",
    source_url: "https://example.gov/fixture-cb-02/calendar",
    adapter: "html_pdf_v1",
    state: "unavailable",
    state_reason: "http_error",
    observed_receipt: { status: "unknown", fetch_status: "503" },
    materialized_record_count: 0,
  },
  "unsearched scope": {
    board_id: "fixture-cb-03",
    role: "minutes",
    source_url: "https://example.gov/fixture-cb-03/minutes",
    adapter: "html_pdf_v1",
    state: "not-yet-checked",
    state_reason: "source_not_checked",
    observed_receipt: { status: "unknown", fetch_status: null },
    materialized_record_count: 0,
  },
  "expected empty": {
    board_id: "fixture-cb-04",
    role: "minutes",
    source_url: "https://example.gov/fixture-cb-04/minutes",
    adapter: "html_pdf_v1",
    state: "checked-empty",
    state_reason: "no_explicit_records",
    observed_receipt: { status: "ok", fetch_status: "200" },
    materialized_record_count: 0,
  },
  "policy exempt": {
    board_id: "fixture-cb-05",
    role: "minutes",
    source_url: null,
    adapter: null,
    state: "not-yet-checked",
    state_reason: "no_explicit_source_observed",
    observed_receipt: { status: "unknown", fetch_status: null },
    materialized_record_count: 0,
  },
  healthy: {
    board_id: "fixture-cb-06",
    role: "upcoming_meetings",
    source_url: "https://example.gov/fixture-cb-06/calendar",
    adapter: "google_calendar_v1",
    state: "indexed",
    state_reason: null,
    observed_receipt: { status: "ok", fetch_status: "200" },
    materialized_record_count: 4,
  },
});

const INVENTORY_FIXTURE = {
  boards: Object.values(RECEIPT_FIXTURES).map((receipt) => ({
    id: receipt.board_id,
    upcoming: {
      publisher: "Fixture publisher",
      verification: { receipt_ref: `site/data/fixtures/${receipt.board_id}.json` },
    },
    minutes: {
      publisher: "Fixture publisher",
      verification: { receipt_ref: `site/data/fixtures/${receipt.board_id}.json` },
    },
  })),
};

function projectFixtures(receipts = Object.values(RECEIPT_FIXTURES)) {
  return buildCommunityBoardRepairObservations({
    index: { generated_at: OBSERVED_AT, receipts },
    inventory: INVENTORY_FIXTURE,
    contract: CONTRACT,
    codeRevision: "fixture-revision",
    indexPath: "site/data/fixture_index.json",
  });
}

function observationFor(label) {
  const [row] = projectFixtures([RECEIPT_FIXTURES[label]]);
  return row;
}

// --- A1 · distinct deterministic conditions from fixtures -------------------

test("A1 unsupported format, a failed check, an unsearched scope and an unresolved identity are four distinct conditions", () => {
  const unsupported = observationFor("unsupported format");
  const failed = observationFor("failed check");
  const unsearched = observationFor("unsearched scope");

  // An unresolved identity comes from the join seam rather than a source
  // receipt: records were retrieved, but the exact identity the join needs is
  // absent, so a fourth condition is required to describe it.
  const [unresolved] = buildJoinRepairObservations({
    joins: [joinCommunityBoardSourceRecords(
      { board_id: "fixture-cb-07", event_date: "2026-09-14" },
      [{ board_id: "fixture-cb-07", date: "2026-09-14", record_kind: "event", source_record_id: "fixture-record-1", observed_receipt: { status: "ok", observed_at: OBSERVED_AT } }],
      { asOf: OBSERVED_AT },
    )],
    contract: CONTRACT,
    observedAt: OBSERVED_AT,
  });

  assert.equal(unsupported.condition.id, "source-format-unsupported");
  assert.equal(failed.condition.id, "source-retrieval-failed");
  assert.equal(unsearched.condition.id, "scope-not-searched");
  assert.equal(unresolved.condition.id, "record-identity-unresolved");
  assert.equal(unresolved.condition.detail_code, "publisher_identifier_missing");

  const conditions = [unsupported, failed, unsearched, unresolved].map((row) => row.condition.id);
  assert.equal(new Set(conditions).size, 4, "each named failure keeps its own condition");
  const fingerprints = [unsupported, failed, unsearched, unresolved].map((row) => row.fingerprint);
  assert.equal(new Set(fingerprints).size, 4, "each named failure keeps its own identity");
});

test("A1 the same fixtures replay to byte-identical observations", () => {
  assert.deepEqual(projectFixtures(), projectFixtures());
});

test("A1 a healthy source role produces no observation at all", () => {
  assert.deepEqual(projectFixtures([RECEIPT_FIXTURES.healthy]), []);
});

test("A1 the projection reads receipts, never a rendered resident string", () => {
  const source = readFileSync(join(ROOT, "tools/repair_observations.mjs"), "utf8");
  const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:crypto"], "the contract depends on no renderer");
  for (const scraper of ["innerHTML", "textContent", "querySelector", "matchAll(/<", "replace(/<[^>]"]) {
    assert.equal(source.includes(scraper), false, `no markup parsing (${scraper})`);
  }
});

// --- A2 · stable identity ---------------------------------------------------

test("A2 a repeated observation keeps its fingerprint across timing, counts, vintage and code revision", () => {
  const first = observationFor("failed check");
  const [second] = buildCommunityBoardRepairObservations({
    index: {
      generated_at: "2026-09-02T11:00:00.000Z",
      receipts: [{ ...RECEIPT_FIXTURES["failed check"], materialized_record_count: 9, observed_receipt: { status: "unknown", fetch_status: "500" } }],
    },
    inventory: INVENTORY_FIXTURE,
    contract: CONTRACT,
    codeRevision: "a-different-revision",
    indexPath: "site/data/fixture_index.json",
  });
  assert.equal(second.fingerprint, first.fingerprint);
  assert.notEqual(second.last_observed_at, first.last_observed_at);
  assert.notEqual(second.revision.code_revision, first.revision.code_revision);
});

test("A2 presentation copy cannot move a fingerprint", () => {
  const base = {
    source_contract_id: CONTRACT.id,
    source_id: "fixture-cb-02:upcoming_meetings",
    scope_kind: "community_board_source_role",
    scope_id: "fixture-cb-02:upcoming_meetings",
    condition: "source-retrieval-failed",
  };
  // Everything a reader would ever see moves; the identity does not.
  const reworded = buildRepairObservation({
    ...base,
    body_id: "fixture-cb-02",
    role: "upcoming_meetings",
    origin_url: "https://example.gov/moved-page",
    publisher: "Renamed publisher",
    detail_code: "gateway_timeout",
    evidence_locator: "site/data/fixture_index.json#/receipts/41",
    observed_at: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(reworded.fingerprint, repairObservationFingerprint(base));
  assert.equal(reworded.fingerprint, observationFor("failed check").fingerprint);
});

test("A2 a different source, scope or condition is a different record", () => {
  const base = {
    source_contract_id: CONTRACT.id,
    source_id: "fixture-cb-02:upcoming_meetings",
    scope_kind: "community_board_source_role",
    scope_id: "fixture-cb-02:upcoming_meetings",
    condition: "source-retrieval-failed",
  };
  const variants = [
    repairObservationFingerprint(base),
    repairObservationFingerprint({ ...base, source_contract_id: "another-contract" }),
    repairObservationFingerprint({ ...base, source_id: "fixture-cb-02:minutes" }),
    repairObservationFingerprint({ ...base, scope_id: "fixture-cb-09:upcoming_meetings" }),
    repairObservationFingerprint({ ...base, condition: "source-format-unsupported" }),
  ];
  assert.equal(new Set(variants).size, variants.length);
  for (const value of variants) assert.match(value, /^[a-f0-9]{64}$/);
});

test("A2 repeated passes deduplicate into one record that keeps its first sighting", () => {
  const first = projectFixtures();
  const later = buildCommunityBoardRepairObservations({
    index: { generated_at: "2026-09-02T11:00:00.000Z", receipts: Object.values(RECEIPT_FIXTURES) },
    inventory: INVENTORY_FIXTURE,
    contract: CONTRACT,
    codeRevision: "fixture-revision",
    indexPath: "site/data/fixture_index.json",
  });
  const merged = mergeRepairObservations(first, later, { observedAt: "2026-09-02T11:00:00.000Z" });
  assert.equal(merged.length, first.length, "no second row for a second sighting");
  for (const row of merged) {
    assert.equal(row.first_observed_at, OBSERVED_AT);
    assert.equal(row.last_observed_at, "2026-09-02T11:00:00.000Z");
    assert.equal(row.observation_count, 2);
    assert.equal(row.resolved, false);
  }
  // A condition that stops being observed is retained and marked resolved,
  // never silently dropped.
  const cleared = mergeRepairObservations(merged, projectFixtures([RECEIPT_FIXTURES["failed check"]]));
  const stillFailing = cleared.filter((row) => !row.resolved);
  assert.equal(stillFailing.length, 1);
  assert.equal(stillFailing[0].condition.id, "source-retrieval-failed");
  assert.equal(cleared.length, merged.length);
});

test("A2 a repeated symptom groups into one repair with an affected-scope count", () => {
  const shared = ["fixture-cb-11", "fixture-cb-12", "fixture-cb-13"].map((boardId) => ({
    ...RECEIPT_FIXTURES["failed check"],
    board_id: boardId,
  }));
  const groups = groupRepairObservations(projectFixtures(shared));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].condition, "source-retrieval-failed");
  assert.equal(groups[0].adapter, "html_pdf_v1");
  assert.equal(groups[0].affected_scopes, 3);
  assert.equal(new Set(groups[0].fingerprints).size, 3);
});

test("A2 the code revision moves with the owning code and not with anything else", () => {
  const owning = [{ path: "site/a.mjs", text: "one" }, { path: "site/b.mjs", text: "two" }];
  assert.equal(repairCodeRevision(owning), repairCodeRevision([...owning].reverse()));
  assert.notEqual(repairCodeRevision(owning), repairCodeRevision([{ path: "site/a.mjs", text: "one changed" }, owning[1]]));
  assert.equal(repairCodeRevision([]), null);
});

// --- A3 · retained and excluded fields --------------------------------------

test("A3 every observation retains timing, revision, scope and evidence", () => {
  for (const row of projectFixtures()) {
    assert.equal(row.schema, REPAIR_OBSERVATION_SCHEMA);
    assert.ok(row.first_observed_at, "first seen");
    assert.ok(row.last_observed_at, "last seen");
    assert.equal(row.revision.source_vintage, OBSERVED_AT);
    assert.equal(row.revision.code_revision, "fixture-revision");
    assert.equal(row.scope.kind, "community_board_source_role");
    assert.ok(row.scope.body_id && row.scope.role, "affected scope");
    assert.match(row.evidence.locator, /^site\/data\/fixture_index\.json#\/receipts\/\d+$/);
    assert.ok(row.evidence.receipt_ref, "evidence receipt reference");
    assert.ok(row.owner.source_contract_id, "owner");
    assert.ok(row.owner.code_paths.length, "owning code");
    assert.deepEqual(validateRepairObservation(row), []);
  }
});

test("A3 credentials, cookies, reporter text and private payloads have no field to travel in", () => {
  const [row] = buildCommunityBoardRepairObservations({
    index: {
      generated_at: OBSERVED_AT,
      receipts: [{
        ...RECEIPT_FIXTURES["failed check"],
        // Everything below is present on the read side and must not survive
        // the allowlist: the record is constructed field by field, never
        // redacted in place.
        request_headers: { Authorization: "Bearer fixture-token-value", Cookie: "cs_visitor=fixture" },
        raw_body: "<html>the entire retrieved page</html>",
        reporter_text: "a resident wrote in to say the calendar looks broken",
        source_payload: { records: [{ title: "private source record" }] },
        observed_receipt: { status: "unknown", fetch_status: "503", raw_body: "<html>...</html>" },
      }],
    },
    inventory: INVENTORY_FIXTURE,
    contract: CONTRACT,
    codeRevision: "fixture-revision",
    indexPath: "site/data/fixture_index.json",
  });
  const serialized = JSON.stringify(row);
  for (const secret of ["Bearer", "Authorization", "cs_visitor", "<html>", "resident wrote in", "private source record"]) {
    assert.equal(serialized.includes(secret), false, `${secret} is absent from the record`);
  }
  assert.deepEqual(Object.keys(row).sort(), [
    "condition", "evidence", "first_observed_at", "fingerprint", "last_observed_at",
    "observation_count", "owner", "revision", "schema", "scope", "source",
  ].sort());
});

test("A3 an invented credential-shaped field is rejected rather than carried", () => {
  const valid = observationFor("failed check");
  for (const [field, value] of [
    ["session_token", "fixture"],
    ["cookie", "cs_visitor=fixture"],
    ["reporter_note", "a resident said the page was broken"],
    ["response_body", "<html></html>"],
  ]) {
    const findings = validateRepairObservation({ ...valid, evidence: { ...valid.evidence, [field]: value } });
    assert.ok(findings.length, `${field} is refused`);
  }
  assert.ok(validateRepairObservation({
    ...valid,
    owner: { ...valid.owner, publisher: "Authorization: Bearer fixture" },
  }).length, "a credential-shaped value is refused even in an allowed field");
});

test("A3 a condition or scope outside the closed vocabulary fails closed", () => {
  assert.throws(() => buildRepairObservation({ condition: "looks-wrong", scope_kind: "community_board_source_role" }), /unknown repair condition/);
  assert.throws(() => buildRepairObservation({ condition: "source-retrieval-failed", scope_kind: "made-up-scope" }), /unknown repair scope kind/);
  assert.throws(() => buildRepairObservation({
    condition: "source-retrieval-failed",
    scope_kind: "community_board_source_role",
    source_contract_id: "c",
    source_id: "s",
    scope_id: "s",
  }), /evidence locator is required/);
});

// --- A4 · non-repair conditions ---------------------------------------------

test("A4 an expected-empty source and a policy-exempt source are not repair work", () => {
  const empty = observationFor("expected empty");
  const exempt = observationFor("policy exempt");
  assert.equal(empty.condition.id, "checked-no-records");
  assert.equal(empty.condition.disposition, "expected-absence");
  assert.equal(exempt.condition.id, "source-not-published");
  assert.equal(exempt.condition.disposition, "source-policy-limitation");
  assert.deepEqual(repairWorkObservations([empty, exempt]), []);
  const repairs = repairWorkObservations(projectFixtures());
  assert.deepEqual(repairs.map((row) => row.condition.id).sort(), [
    "scope-not-searched",
    "source-format-unsupported",
    "source-retrieval-failed",
  ]);
});

test("A4 a missing record alone is never an engineering defect", () => {
  // No counterpart notice, and two records whose explicit identities differ:
  // both are correct outcomes of an exact join, not defects.
  const absent = buildJoinRepairObservations({
    joins: [
      joinCommunityBoardSourceRecords({ board_id: "fixture-cb-08", event_date: "2026-09-14" }, [], { asOf: OBSERVED_AT }),
      joinCommunityBoardSourceRecords(
        { board_id: "fixture-cb-09", event_date: "2026-09-14", publisher_identifier: "EVENT-A" },
        [{ board_id: "fixture-cb-09", date: "2026-09-14", publisher_identifier: "EVENT-B", record_kind: "event", source_record_id: "fixture-record-2", observed_receipt: { status: "ok", observed_at: OBSERVED_AT } }],
        { asOf: OBSERVED_AT },
      ),
    ],
    contract: CONTRACT,
    observedAt: OBSERVED_AT,
  });
  assert.deepEqual(absent.map((row) => row.condition.id).sort(), ["no-counterpart-record", "records-do-not-correspond"]);
  assert.deepEqual(repairWorkObservations(absent), []);
});

test("A4 no condition wording makes an adverse claim about a publisher", () => {
  const detail = Object.values(REPAIR_OBSERVATION_CONDITIONS).map((entry) => entry.detail).join(" ").toLowerCase();
  for (const adverse of ["fail to publish", "neglect", "refus", "non-compliant", "noncompliant", "violat", "at fault", "should have published"]) {
    assert.equal(detail.includes(adverse), false, `condition prose avoids "${adverse}"`);
  }
  assert.equal(REPAIR_OBSERVATION_CONDITION_IDS.length, Object.keys(REPAIR_OBSERVATION_CONDITIONS).length);
  for (const entry of Object.values(REPAIR_OBSERVATION_CONDITIONS)) {
    assert.ok(REPAIR_DISPOSITIONS.includes(entry.disposition));
  }
  // Every join reason resolves to a declared condition, so a new reason cannot
  // fall through into a defect by default.
  for (const condition of Object.values(JOIN_REASON_CONDITIONS)) {
    assert.ok(REPAIR_OBSERVATION_CONDITION_IDS.includes(condition), condition);
  }
});

// --- A5 · the two projections stay apart ------------------------------------

test("A5 the rendered Community Board document carries none of the operator fields", () => {
  const sources = {
    sourceRegistry: readJson("site/data/non_council_outcome_sources/source_registry.json"),
    sourceInventory: readJson("site/data/non_council_outcome_sources/board_source_inventory.json"),
    scorecard: readJson("site/data/community_board_minutes_scorecard.json"),
    geography: readJson("site/data/community_board_geography_lookup.json"),
  };
  const observations = communityBoardRepairObservations(readJson("site/data/source_contracts.json")).observations;
  assert.ok(observations.length, "committed receipts project at least one observation");
  for (const boardId of ["manhattan-cb-03", "brooklyn-cb-02", "manhattan-cb-06"]) {
    const html = renderCommunityBoardConstellationDocument(buildCommunityBoardConstellationView(boardId, sources));
    assert.deepEqual(
      repairObservationLeakFindings(html, { label: `community-board-document:${boardId}`, observations }),
      [],
    );
  }
});

test("A5 the public source-health projection carries none of the operator fields", () => {
  const registry = readJson("site/data/source_contracts.json");
  const observations = readJson("site/data/source_health_observations.json");
  const projection = buildPublicSourceHealthProjection(registry, observations);
  assert.deepEqual(validatePublicSourceHealthProjection(projection, registry), []);
  assert.deepEqual(publicSourceHealthProjectionLeaks(projection), []);
  assert.deepEqual(repairObservationLeakFindings(projection, { label: "public source health" }), []);
  assert.deepEqual(
    repairObservationLeakFindings(readJson("site/data/source_health_public.json"), { label: "site/data/source_health_public.json" }),
    [],
  );
});

test("A5 the private consumer can inspect the evidence the public projections withhold", () => {
  const registry = readJson("site/data/source_contracts.json");
  const { observations, observedAt, sourceVintage } = communityBoardRepairObservations(registry);
  const set = repairObservationSet(observations, { observedAt, sourceVintage });
  assert.equal(set.visibility, "private");
  assert.equal(set.consumer, "authenticated desk");
  assert.equal(set.counts.total, observations.length);
  assert.equal(set.counts.repair + set.counts["expected-absence"] + set.counts["source-policy-limitation"], set.counts.total);
  assert.ok(set.groups.length, "repeated symptoms group for the consumer");
  const findings = repairObservationLeakFindings(set, { label: "desk export", observations });
  assert.ok(findings.some((row) => row.kind === "operator-field"), "the private export does carry the operator fields");
  assert.ok(findings.some((row) => row.kind === "fingerprint"), "and the fingerprints that identify them");
  for (const row of observations) {
    assert.deepEqual(validateRepairObservation(row), []);
    assert.ok(row.evidence.locator, "an operator can find the receipt behind the record");
  }
});

test("A5 a leaked observation is caught by the rendered resident boundary, not just by this contract", () => {
  const observation = observationFor("failed check");
  // The shape a regression would take: the operator record rendered into the
  // resident document as a diagnostic block.
  const leaked = [
    '<section class="board-sources"><h2>Source diagnostics</h2>',
    '<ul><li class="node-record"><div class="node-record-main"><strong>Upcoming meetings</strong></div>',
    `<span class="muted node-muted">${observation.condition.id} · ${observation.condition.disposition}`,
    ` · fingerprint ${observation.fingerprint} · detail_code ${observation.condition.detail_code}</span></li></ul></section>`,
  ].join("");
  const leaks = repairObservationLeakFindings(leaked, { label: "leaked-observation", observations: [observation] });
  assert.ok(leaks.some((row) => row.kind === "condition"));
  assert.ok(leaks.some((row) => row.kind === "fingerprint"));
  assert.ok(leaks.some((row) => row.kind === "operator-field"));
  const boundaryFindings = inspectResidentCopyBoundary(leaked, {
    fixture: "leaked-repair-observation",
    file: "site/community_board_constellation.mjs",
    renderer: "renderCommunityBoardConstellationDocument",
    state: "error",
  });
  assert.ok(boundaryFindings.length, "the preceding card's rendered boundary still rejects the same markup");
});

test("A5 the shipped resident corpus stays clean under both gates", () => {
  const observations = communityBoardRepairObservations(readJson("site/data/source_contracts.json")).observations;
  assert.deepEqual(checkResidentCopyBoundary(), [], "the preceding card's gate is not weakened");
  for (const fixture of buildResidentCopyBoundaryCorpus()) {
    assert.deepEqual(
      repairObservationLeakFindings(fixture.html, { label: fixture.id, observations }),
      [],
      fixture.id,
    );
  }
});

test("A5 the operator field list is complete against the record it describes", () => {
  const serialized = JSON.stringify(observationFor("failed check"));
  for (const field of ["fingerprint", "disposition", "detail_code", "first_observed_at", "last_observed_at", "observation_count", "code_revision"]) {
    assert.ok(REPAIR_OBSERVATION_OPERATOR_FIELDS.includes(field), `${field} is declared operator-only`);
    assert.ok(serialized.includes(field), `${field} is actually on the record`);
  }
});
