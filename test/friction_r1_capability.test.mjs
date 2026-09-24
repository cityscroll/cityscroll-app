/**
 * Typed source deadlines: response due dates stay explicit and source-qualified.
 *
 * An opening date never fills due_date. Conflicting current authoritative
 * assertions stay unresolved. Stale fixture disagreement is labeled honestly.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { exactInstitutionFollow } from "../site/institution_follow_scope.mjs";
import {
  DEADLINE_EVIDENCE_CLASS,
  DEADLINE_PRECISION,
  DEADLINE_RESOLUTION_STATUS,
  DEADLINE_SEMANTIC_KIND,
  resolveTypedSourceDeadlines,
} from "../site/typed_source_deadline.mjs";
import {
  recordsFromMtaOpportunityFixtures,
  validateMtaOpportunityFixtures,
} from "../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { testClockISOString } from "./helpers/test_clock.mjs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

const MTA_FIXTURES = read("warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json");
const DEADLINE_FIXTURES = read("warehouse/fixtures/authority-native-procurement/typed-source-deadlines.v1.json");

function fixtureById(id) {
  return DEADLINE_FIXTURES.fixtures.find((row) => row.id === id);
}

function normalizedBySourceId(records, sourceRecordId) {
  const record = records.find((row) => row.source_system_id === sourceRecordId);
  assert.ok(record, `missing normalized record ${sourceRecordId}`);
  return JSON.parse(record.normalized_snapshot);
}

test("A1 retained 2138505 keeps Oct 2 response deadline; S48020 keeps Oct 16 opening without a response deadline", () => {
  const clock = testClockISOString();
  assert.match(clock, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(validateMtaOpportunityFixtures(MTA_FIXTURES), []);

  const records = recordsFromMtaOpportunityFixtures(MTA_FIXTURES);
  const contractReporter = normalizedBySourceId(records, "contract-reporter:2138505");
  const current = normalizedBySourceId(records, "mta-current:S48020:0000541781");

  assert.equal(contractReporter.due_date, "10/2/2026");
  assert.equal(contractReporter.opening_date, null);
  assert.equal(
    contractReporter.typed_deadlines.response_deadline.status,
    DEADLINE_RESOLUTION_STATUS.RESOLVED,
  );
  assert.equal(contractReporter.typed_deadlines.response_deadline.chosen.date, "2026-10-02");
  assert.equal(
    contractReporter.typed_deadlines.response_deadline.chosen.semantic_kind,
    DEADLINE_SEMANTIC_KIND.RESPONSE_DEADLINE,
  );

  assert.equal(current.opening_date, "10/16/2026");
  assert.equal(current.due_date, null, "opening must not manufacture a response deadline");
  assert.equal(
    current.typed_deadlines.response_deadline.status,
    DEADLINE_RESOLUTION_STATUS.ABSENT,
  );
  assert.equal(
    current.typed_deadlines.bid_opening.status,
    DEADLINE_RESOLUTION_STATUS.RESOLVED,
  );
  assert.equal(current.typed_deadlines.bid_opening.chosen.date, "2026-10-16");
  assert.equal(
    current.source_values.opening_date,
    "10/16/2026",
    "raw opening text remains on source_values",
  );
  assert.equal(current.source_values.due_date, undefined);
});

test("A2 current DOB 20260707026 resolves Aug 25 1 p.m. as due and retains 2 p.m. opening separately", () => {
  const current = fixtureById("dob-20260707026-current");
  assert.ok(current);
  const resolution = resolveTypedSourceDeadlines(current.assertions);

  assert.equal(resolution.response_deadline.status, DEADLINE_RESOLUTION_STATUS.RESOLVED);
  assert.equal(resolution.response_deadline.chosen.date, "2026-08-25");
  assert.equal(resolution.response_deadline.chosen.wall_time, "13:00:00");
  assert.equal(resolution.response_deadline.chosen.precision, DEADLINE_PRECISION.EXACT_TIME);
  assert.equal(resolution.response_deadline.chosen.timezone, "America/New_York");

  assert.equal(resolution.bid_opening.status, DEADLINE_RESOLUTION_STATUS.RESOLVED);
  assert.equal(resolution.bid_opening.chosen.date, "2026-08-25");
  assert.equal(resolution.bid_opening.chosen.wall_time, "14:00:00");
  assert.equal(resolution.bid_opening.chosen.precision, DEADLINE_PRECISION.EXACT_TIME);
  assert.notEqual(
    resolution.response_deadline.chosen.value,
    resolution.bid_opening.chosen.value,
    "due and opening remain distinct assertions",
  );
});

test("A3 older DOB Aug 18 fixture is stale conflicting test evidence, not official amendment history", () => {
  const stale = fixtureById("dob-20260707026-stale-passport-join-cases");
  const current = fixtureById("dob-20260707026-current");
  const combined = resolveTypedSourceDeadlines([
    ...stale.assertions,
    ...current.assertions,
  ]);

  const staleRows = combined.response_deadline.stale_conflicting_test_evidence;
  assert.equal(staleRows.length, 1);
  assert.equal(staleRows[0].date, "2026-08-18");
  assert.equal(
    staleRows[0].evidence_class,
    DEADLINE_EVIDENCE_CLASS.STALE_CONFLICTING_TEST_EVIDENCE,
  );
  assert.equal(
    staleRows[0].status,
    DEADLINE_RESOLUTION_STATUS.RESOLVED,
    "the stale row still parses, but it is not current authority",
  );

  // Current authoritative due remains Aug 25; the stale Aug 18 row does not
  // enter a supersession chain and is not presented as amendment history.
  assert.equal(combined.response_deadline.status, DEADLINE_RESOLUTION_STATUS.RESOLVED);
  assert.equal(combined.response_deadline.chosen.date, "2026-08-25");
  assert.equal(
    combined.assertions.some((row) => row.supersedes_assertion_id === staleRows[0].assertion_id),
    false,
  );
  assert.match(
    String(stale.assertions[0].note || ""),
    /not an official amendment history/i,
  );
});

test("A4 synthetic revised deadline supersedes only its proven earlier version; conflicts/invalid/unknown-tz stay distinct", () => {
  const supersession = resolveTypedSourceDeadlines(
    fixtureById("synthetic-response-deadline-supersession").assertions,
  );
  assert.equal(supersession.response_deadline.status, DEADLINE_RESOLUTION_STATUS.RESOLVED);
  assert.equal(supersession.response_deadline.chosen.date, "2026-09-08");
  assert.equal(supersession.response_deadline.chosen.wall_time, "15:00:00");
  const prior = supersession.assertions.find((row) => row.assertion_id === "synthetic:record-1:due_date:v1");
  assert.equal(prior.status, DEADLINE_RESOLUTION_STATUS.SUPERSEDED);
  assert.equal(prior.synthetic_mutation, true);

  const competing = resolveTypedSourceDeadlines(
    fixtureById("synthetic-competing-current-assertions").assertions,
  );
  assert.equal(
    competing.response_deadline.status,
    DEADLINE_RESOLUTION_STATUS.UNRESOLVED_CONFLICT,
  );
  assert.equal(competing.response_deadline.chosen, null);
  assert.equal(competing.response_deadline.current_authoritative.length, 2);

  const edge = resolveTypedSourceDeadlines(
    fixtureById("synthetic-invalid-and-unknown-timezone").assertions,
  );
  const invalid = edge.assertions.find((row) => row.assertion_id === "synthetic:record-3:invalid-due");
  const unknownTz = edge.assertions.find((row) => row.assertion_id === "synthetic:record-4:unknown-tz-due");
  const unproven = edge.assertions.find((row) => row.assertion_id === "synthetic:record-5:normalized-only");
  assert.equal(invalid.status, DEADLINE_RESOLUTION_STATUS.UNRESOLVED_INVALID);
  assert.equal(unknownTz.status, DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNKNOWN_TIMEZONE);
  assert.equal(unknownTz.date, "2026-09-20");
  assert.equal(unknownTz.wall_time, "16:30:00");
  assert.equal(unproven.status, DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNPROVEN_SEMANTICS);
});

test("A5 raw acquisition through real normalizer + materialization rebuild drops opening-derived due_date and keeps exact-follow identity", () => {
  assert.deepEqual(validateMtaOpportunityFixtures(MTA_FIXTURES), []);
  const sourceRecords = recordsFromMtaOpportunityFixtures(MTA_FIXTURES);
  const model = buildSharedProcurementReadModel({
    sourceRecords,
    generatedAt: MTA_FIXTURES.retrieved_at,
  });

  const openingDerivedDue = [];
  for (const observation of model.observations || []) {
    const snap = observation?.snapshot;
    if (!snap || typeof snap !== "object") continue;
    const opening = snap.opening_date ?? snap.source_values?.opening_date ?? null;
    const due = snap.due_date ?? null;
    if (opening && due && String(opening) === String(due) && snap.source_values?.due_date == null) {
      openingDerivedDue.push({
        ref: observation.source_observation_ref,
        due,
        opening,
      });
    }
  }
  assert.deepEqual(
    openingDerivedDue,
    [],
    "no retained observation may carry an opening-derived due_date",
  );

  const s48020 = model.rows.find((row) => row.procurement_id === "procurement:solicitation:S48020");
  const cr2138505 = model.rows.find((row) => (
    row.procurement_id === "procurement:contract_reporter_number:2138505"
  ));
  assert.ok(s48020);
  assert.ok(cr2138505);

  const s48020Obs = (model.observations || []).find((row) => (
    row.source_observation_ref === "mta_current_opportunities:mta-current:S48020:0000541781"
  ));
  assert.ok(s48020Obs);
  assert.equal(s48020Obs.snapshot.due_date, null);
  assert.equal(s48020Obs.snapshot.opening_date, "10/16/2026");

  const crObs = (model.observations || []).find((row) => (
    row.source_observation_ref === "nys_contract_reporter:contract-reporter:2138505"
  ));
  assert.ok(crObs);
  assert.equal(crObs.snapshot.due_date, "10/2/2026");

  // Existing exact-follow identity for the MTA parent and Construction &
  // Development body remains stable across the rebuild.
  const mta = exactInstitutionFollow("metropolitan-transportation-authority");
  const mtaCd = exactInstitutionFollow("mta-construction-and-development");
  assert.equal(mta.status, "ok");
  assert.equal(mtaCd.status, "ok");
  assert.equal(mta.subject_ref, "agency:id:metropolitan-transportation-authority");
  assert.equal(mtaCd.subject_ref, "agency:id:mta-construction-and-development");
  assert.equal(mta.method, "exact_institution_follow_v1");
  assert.equal(mtaCd.method, "exact_institution_follow_v1");
});
