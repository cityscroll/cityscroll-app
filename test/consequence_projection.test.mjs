/**
 * PHC-00 — shared consequence projection contract.
 *
 *   node --test test/consequence_projection.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BODY_ROLES,
  CONSEQUENCE_PROJECTION_SCHEMA,
  PARTICIPATION_MODES,
  PROCEEDING_KINDS,
  RECORD_DESTINATIONS,
  buildConsequenceProjection,
  contractCommentConsequence,
  councilHearingConsequence,
  emptyConsequenceProjection,
  landHearingConsequence,
  meetingConsequence,
  ruleConsequence,
} from "../site/consequence_projection.mjs";

const gold = JSON.parse(
  readFileSync(new URL("./fixtures/consequence_projection/gold_fixtures.v0.json", import.meta.url), "utf8"),
);

function projectionFor(fixtureCase) {
  return buildConsequenceProjection(fixtureCase.domain, fixtureCase.record || {}, fixtureCase.opts || {});
}

function evidenceFields(projection) {
  return new Set(projection.evidence.map((entry) => entry.field));
}

test("every gold fixture case matches its expected projection shape (PHC-00-A6 snapshot coverage)", () => {
  for (const fixtureCase of gold.cases) {
    const projection = projectionFor(fixtureCase);
    const expected = fixtureCase.expected;

    assert.equal(projection.schema, CONSEQUENCE_PROJECTION_SCHEMA, `${fixtureCase.id}: schema`);
    assert.equal(projection.proceeding_kind, expected.proceeding_kind, `${fixtureCase.id}: proceeding_kind`);
    assert.equal(projection.body_role, expected.body_role, `${fixtureCase.id}: body_role`);
    assert.equal(!!projection.pending_question, expected.pending_question_present, `${fixtureCase.id}: pending_question presence`);
    assert.deepEqual(
      [...projection.participation_modes].sort(),
      [...expected.participation_modes].sort(),
      `${fixtureCase.id}: participation_modes`,
    );
    assert.equal(projection.record_destination, expected.record_destination, `${fixtureCase.id}: record_destination`);
    assert.equal(!!projection.next_official_action, expected.next_official_action_present, `${fixtureCase.id}: next_official_action presence`);
    if (expected.next_official_action_status) {
      assert.equal(projection.next_official_action.status, expected.next_official_action_status, `${fixtureCase.id}: next_official_action.status`);
    }
    assert.ok(
      projection.evidence.length >= expected.min_evidence_count,
      `${fixtureCase.id}: expected at least ${expected.min_evidence_count} evidence entries, got ${projection.evidence.length}`,
    );
    if (expected.unknown_reason) {
      assert.equal(projection.unknown_reason, expected.unknown_reason, `${fixtureCase.id}: unknown_reason`);
    }

    // Every enum value returned is one of the contract's own values.
    assert.ok(PROCEEDING_KINDS.includes(projection.proceeding_kind), `${fixtureCase.id}: proceeding_kind is in PROCEEDING_KINDS`);
    assert.ok(BODY_ROLES.includes(projection.body_role), `${fixtureCase.id}: body_role is in BODY_ROLES`);
    for (const mode of projection.participation_modes) {
      assert.ok(PARTICIPATION_MODES.includes(mode), `${fixtureCase.id}: ${mode} is in PARTICIPATION_MODES`);
    }
    if (projection.record_destination) {
      assert.ok(RECORD_DESTINATIONS.includes(projection.record_destination), `${fixtureCase.id}: record_destination is in RECORD_DESTINATIONS`);
    }
  }
});

test("PHC-00-A1: every non-null assertion carries at least one evidence entry naming a source_url or an exact join basis", () => {
  for (const fixtureCase of gold.cases) {
    const projection = projectionFor(fixtureCase);
    const fields = evidenceFields(projection);

    if (projection.pending_question) {
      assert.ok(fields.has("pending_question"), `${fixtureCase.id}: pending_question needs evidence`);
    }
    if (projection.body_role !== "unknown") {
      assert.ok(fields.has("body_role"), `${fixtureCase.id}: body_role needs evidence`);
    }
    for (const mode of projection.participation_modes) {
      assert.ok(fields.has(`participation_modes:${mode}`), `${fixtureCase.id}: participation_modes:${mode} needs evidence`);
    }
    if (projection.record_destination) {
      assert.ok(fields.has("record_destination"), `${fixtureCase.id}: record_destination needs evidence`);
    }
    if (projection.next_official_action) {
      assert.ok(fields.has("next_official_action"), `${fixtureCase.id}: next_official_action needs evidence`);
    }
    for (const entry of projection.evidence) {
      assert.ok(entry.basis, `${fixtureCase.id}: evidence entry for ${entry.field} has a basis`);
      assert.ok(entry.source_url || entry.basis.includes("join"), `${fixtureCase.id}: evidence entry for ${entry.field} names a source_url or an exact join basis`);
    }
  }
});

test("PHC-00-A2: a partial projection still exposes the fields that are known", () => {
  const partial = gold.cases.find((c) => c.id === "partial-land-hearing-role-known-outcome-unknown");
  const projection = projectionFor(partial);
  assert.equal(projection.record_destination, null);
  assert.equal(projection.next_official_action, null);
  // But body_role and the observed venue signal are not suppressed by those absences.
  assert.equal(projection.body_role, "conditional_decision_maker");
  assert.deepEqual([...projection.participation_modes], ["attend_in_person"]);
});

test("PHC-00-A3: watch never implies join_remote; join_remote never implies register_to_testify; public_meeting never implies testimony", () => {
  for (const fixtureCase of gold.cases) {
    const projection = projectionFor(fixtureCase);
    const modes = new Set(projection.participation_modes);
    if (modes.has("watch")) {
      const watchEvidence = projection.evidence.find((e) => e.field === "participation_modes:watch");
      const joinEvidence = projection.evidence.find((e) => e.field === "participation_modes:join_remote");
      if (modes.has("join_remote")) {
        assert.notEqual(watchEvidence.basis, joinEvidence.basis, `${fixtureCase.id}: watch and join_remote must carry independent evidence`);
      }
    }
    if (modes.has("join_remote") && modes.has("register_to_testify")) {
      const joinEvidence = projection.evidence.find((e) => e.field === "participation_modes:join_remote");
      const testifyEvidence = projection.evidence.find((e) => e.field === "participation_modes:register_to_testify");
      assert.notEqual(joinEvidence.basis, testifyEvidence.basis, `${fixtureCase.id}: join_remote and register_to_testify must carry independent evidence`);
    }
    if (projection.proceeding_kind === "public_meeting") {
      assert.ok(!modes.has("register_to_testify"), `${fixtureCase.id}: a public_meeting must never carry register_to_testify without its own evidence`);
    }
  }
});

test("PHC-00-A4: a venue plus a generic, non-recognized link never becomes join_remote or watch", () => {
  const guard = gold.cases.find((c) => c.id === "guard-a3-a4-venue-plus-generic-link-never-becomes-join-remote");
  const projection = projectionFor(guard);
  assert.deepEqual([...projection.participation_modes], ["attend_in_person"]);
  assert.ok(!projection.participation_modes.includes("join_remote"));
  assert.ok(!projection.participation_modes.includes("watch"));
});

test("PHC-00-A4 (recognized platform contrast): a recognized video-conference join URL does produce join_remote", () => {
  const full = gold.cases.find((c) => c.id === "full-rule-hearing-recognized-zoomgov-join");
  const projection = projectionFor(full);
  assert.deepEqual([...projection.participation_modes], ["join_remote"]);
  const evidence = projection.evidence.find((e) => e.field === "participation_modes:join_remote");
  assert.match(evidence.source_url, /zoomgov\.com/);
});

test("PHC-00-A5: remote attendance never changes affected_area — the projection carries no affected_area field at all", () => {
  for (const fixtureCase of gold.cases) {
    const projection = projectionFor(fixtureCase);
    assert.equal(Object.hasOwn(projection, "affected_area"), false, `${fixtureCase.id}: projection must not carry affected_area`);
  }
  // A record's own affected_area, if any, is untouched by building a projection over it.
  const cbCase = gold.cases.find((c) => c.id === "partial-community-board-meeting-hybrid-venue-no-minutes-yet");
  const recordWithArea = { ...cbCase.record, affected_area: { scope: "local", boroughs: ["Brooklyn"] } };
  meetingConsequence(recordWithArea);
  assert.deepEqual(recordWithArea.affected_area, { scope: "local", boroughs: ["Brooklyn"] });
});

test("PHC-00-A6: the unknown fixture invents no copy — every text-bearing field is null and evidence is empty", () => {
  const unknown = gold.cases.find((c) => c.id === "unknown-mixed-hearings-and-meetings-section-no-invented-copy");
  const projection = projectionFor(unknown);
  assert.equal(projection.proceeding_kind, "unknown");
  assert.equal(projection.pending_question, null);
  assert.equal(projection.body_role, "unknown");
  assert.deepEqual([...projection.participation_modes], []);
  assert.equal(projection.record_destination, null);
  assert.equal(projection.next_official_action, null);
  assert.deepEqual([...projection.evidence], []);
  assert.equal(projection.unknown_reason, "unresolved_meeting_family");
});

test("emptyConsequenceProjection is the honest default with no evidence and no guessed fields", () => {
  const empty = emptyConsequenceProjection("no_source_record");
  assert.equal(empty.proceeding_kind, "unknown");
  assert.equal(empty.body_role, "unknown");
  assert.equal(empty.pending_question, null);
  assert.equal(empty.record_destination, null);
  assert.equal(empty.next_official_action, null);
  assert.deepEqual([...empty.participation_modes], []);
  assert.deepEqual([...empty.evidence], []);
  assert.equal(empty.unknown_reason, "no_source_record");
});

test("an unrecognized domain returns the honest unknown projection rather than guessing", () => {
  const projection = buildConsequenceProjection("not_a_real_domain", {}, {});
  assert.equal(projection.proceeding_kind, "unknown");
  assert.equal(projection.unknown_reason, "unrecognized_domain");
});

test("a council hearing without a meeting_id returns the honest unknown projection", () => {
  const projection = councilHearingConsequence({ decides: "Something" });
  assert.equal(projection.unknown_reason, "missing_meeting_id");
});

test("a land hearing without a valid land_authority_summary returns the honest unknown projection", () => {
  const projection = landHearingConsequence({ summary: null });
  assert.equal(projection.unknown_reason, "missing_land_authority_summary");
  const wrongSchema = landHearingConsequence({ summary: { schema: "something.else.v1", project_id: "x" } });
  assert.equal(wrongSchema.unknown_reason, "missing_land_authority_summary");
});

test("returned projections are frozen (immutable snapshot contract)", () => {
  const projection = ruleConsequence({}, {});
  assert.throws(() => { projection.body_role = "decision_maker"; });
  assert.throws(() => { projection.evidence.push({}); });
  assert.throws(() => { projection.participation_modes.push("watch"); });
});

test("a rule notice with neither hearing nor comment-window signals stays an honest unknown proceeding_kind", () => {
  const projection = ruleConsequence({ title: "A rule with no published participation channel" }, { today: "2026-08-20" });
  assert.equal(projection.proceeding_kind, "unknown");
  assert.equal(projection.body_role, "decision_maker");
  assert.deepEqual([...projection.participation_modes], []);
});

test("contractCommentConsequence never produces attend_in_person, join_remote, or watch", () => {
  const projection = contractCommentConsequence({
    request_id: "SYN-CONTRACT-0002",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/SYN-CONTRACT-0002",
    comment_url: "https://a856-cityrecord.nyc.gov/RequestDetail/SYN-CONTRACT-0002",
    comment_by_date: "2026-11-01",
  });
  for (const mode of projection.participation_modes) {
    assert.ok(["submit_written"].includes(mode), `contract comment produced an unexpected mode: ${mode}`);
  }
});
