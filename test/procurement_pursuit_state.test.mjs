// procurement-pursuit-decision, Card "PPD-06": a vendor records the pursuit
// decision they already made for one matter, privately, with no ranking,
// scoring, or filtering effect on any list. See
// site/procurement_pursuit_state.mjs for the full contract and the negative
// rules this card enforces.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PROCUREMENT_PURSUIT_STATE_SCHEMA,
  PURSUIT_DECISIONS,
  PURSUIT_REASON_CODES,
  PURSUIT_STATE_PROVENANCE_LABEL,
  PURSUIT_STATE_REGISTER,
  isPursuitStateProvenanceLabel,
  isPersonalStateRegisterLabel,
  isKnownPursuitDecision,
  isKnownPursuitReasonCode,
  matterRefFromRow,
  recordPursuitDecision,
  pursuitStateFor,
  clearPursuitDecision,
  pursuitBadge,
  resurfacePursuitState,
  renderPursuitStateNoteHtml,
} from "../site/procurement_pursuit_state.mjs";

import * as pursuitStateModule from "../site/procurement_pursuit_state.mjs";
import { PURSUIT_FIELD_STATUS } from "../site/procurement_pursuit_snapshot.mjs";

// A minimal, in-memory Storage-like object -- exactly the shape
// search_recent_history.mjs's own tests use to give each test an isolated
// browser store, and (for A4) to give two different vendors two genuinely
// separate scopes.
class FakeStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

function store() {
  return new FakeStorage();
}

// ---- A1: a vendor records a matter as under review, pursued, passed, or a partnering candidate ----

test("A1: every decision in the closed vocabulary can be recorded and read back", () => {
  for (const decision of PURSUIT_DECISIONS) {
    const s = store();
    const stored = recordPursuitDecision(s, { matter_ref: `procurement:${decision}`, decision });
    assert.ok(stored, `expected ${decision} to record`);
    assert.equal(stored.decision, decision);
    const read = pursuitStateFor(s, `procurement:${decision}`);
    assert.equal(read.decision, decision);
  }
});

test("A1: the closed decision set is exactly the four named outcomes", () => {
  assert.deepEqual(
    [...PURSUIT_DECISIONS].sort(),
    ["partnering_candidate", "passed", "pursuing", "under_review"].sort(),
  );
});

test("A1: an unrecognized decision is rejected -- nothing is recorded", () => {
  const s = store();
  const result = recordPursuitDecision(s, { matter_ref: "procurement:1", decision: "should_bid" });
  assert.equal(result, null);
  assert.equal(pursuitStateFor(s, "procurement:1"), null);
});

test("A1: an empty or missing matter_ref is rejected -- nothing is recorded", () => {
  const s = store();
  assert.equal(recordPursuitDecision(s, { matter_ref: "", decision: "pursuing" }), null);
  assert.equal(recordPursuitDecision(s, { decision: "pursuing" }), null);
});

// ---- A2: an optional structured reason accompanies the recorded decision ----

test("A2: every reason code in the closed vocabulary is accepted and read back", () => {
  const s = store();
  for (const reasonCode of PURSUIT_REASON_CODES) {
    const stored = recordPursuitDecision(s, {
      matter_ref: `procurement:${reasonCode}`,
      decision: "pursuing",
      reason_code: reasonCode,
    });
    assert.equal(stored.reason_code, reasonCode);
  }
});

test("A2: a decision recorded with no reason code stores reason_code as null, not fabricated", () => {
  const s = store();
  const stored = recordPursuitDecision(s, { matter_ref: "procurement:1", decision: "under_review" });
  assert.equal(stored.reason_code, null);
});

test("A2: an unrecognized reason code is dropped to null without failing the decision write", () => {
  const s = store();
  const stored = recordPursuitDecision(s, {
    matter_ref: "procurement:1",
    decision: "passed",
    reason_code: "not_a_real_reason",
  });
  assert.ok(stored);
  assert.equal(stored.decision, "passed");
  assert.equal(stored.reason_code, null);
});

test("A2: a short free-text note is preserved, trimmed, and bounded", () => {
  const s = store();
  const stored = recordPursuitDecision(s, {
    matter_ref: "procurement:1",
    decision: "pursuing",
    note: "  Good fit for our small-business certification.  ",
  });
  assert.equal(stored.note, "Good fit for our small-business certification.");

  const longNote = "x".repeat(10000);
  const stored2 = recordPursuitDecision(s, { matter_ref: "procurement:2", decision: "pursuing", note: longNote });
  assert.ok(stored2.note.length < longNote.length);
});

test("A2: pursuitBadge surfaces the decision and reason in readable wording", () => {
  const record = recordPursuitDecision(store(), {
    matter_ref: "procurement:1",
    decision: "partnering_candidate",
    reason_code: "relationship",
  });
  const badge = pursuitBadge(record);
  assert.match(badge.text, /Partnering candidate/i);
  assert.match(badge.text, /relationship/);
  assert.equal(badge.decision, "partnering_candidate");
  assert.equal(badge.reason_code, "relationship");
});

// ---- A3: a recorded decision is visible when the matter reappears in a later alert or listing ----

test("A3: resurfacePursuitState annotates a matching row with the vendor's own recorded decision", () => {
  const s = store();
  recordPursuitDecision(s, { matter_ref: "procurement:epin-2026-07", decision: "pursuing", reason_code: "timing" });

  // Fixture rows shaped the way procurement_alert_atom.mjs / procurement_process_watch.mjs
  // already produce them -- identified by procurement_id, not a bespoke key.
  const laterAlertRows = [
    { procurement_id: "procurement:epin-2026-07", title: "Playground reconstruction", agency: "Parks" },
    { procurement_id: "procurement:other", title: "Unrelated notice", agency: "DOT" },
  ];

  const resurfaced = resurfacePursuitState(laterAlertRows, s);
  assert.equal(resurfaced.length, 2);
  assert.ok(resurfaced[0].pursuit_state, "the matter with a recorded decision must carry pursuit_state");
  assert.match(resurfaced[0].pursuit_state.text, /pursuing/i);
  assert.equal(resurfaced[1].pursuit_state, undefined, "an unrelated matter must carry no pursuit_state key at all");
});

test("A3: resurfacing a City Record row keyed by request_id (no procurement object yet) still resolves", () => {
  const s = store();
  recordPursuitDecision(s, { matter_ref: "20260701001", decision: "under_review" });
  const rows = [{ request_id: "20260701001", short_title: "Solicitation notice" }];
  const [resurfaced] = resurfacePursuitState(rows, s);
  assert.ok(resurfaced.pursuit_state);
  assert.equal(resurfaced.pursuit_state.decision, "under_review");
});

test("A3: renderPursuitStateNoteHtml renders the badge text and returns empty for no badge", () => {
  const record = recordPursuitDecision(store(), { matter_ref: "procurement:1", decision: "passed" });
  const html = renderPursuitStateNoteHtml(pursuitBadge(record));
  assert.match(html, /You marked this passed/i);
  assert.equal(renderPursuitStateNoteHtml(null), "");
});

// ---- A4: the state is private to the vendor who recorded it ----

test("A4: a decision recorded in one store is invisible from a second, separate store", () => {
  const vendorA = store();
  const vendorB = store();
  recordPursuitDecision(vendorA, { matter_ref: "procurement:1", decision: "pursuing" });

  assert.ok(pursuitStateFor(vendorA, "procurement:1"));
  assert.equal(pursuitStateFor(vendorB, "procurement:1"), null);
});

test("A4: resurfacing the same rows against a second vendor's store shows no annotation", () => {
  const vendorA = store();
  const vendorB = store();
  recordPursuitDecision(vendorA, { matter_ref: "procurement:1", decision: "passed", note: "Too small for us" });

  const rows = [{ procurement_id: "procurement:1", title: "Shared listing" }];
  const [seenByA] = resurfacePursuitState(rows, vendorA);
  const [seenByB] = resurfacePursuitState(rows, vendorB);

  assert.ok(seenByA.pursuit_state);
  assert.equal(seenByB.pursuit_state, undefined);
});

test("A4: clearing a decision in one store never touches another store's record for the same matter", () => {
  const vendorA = store();
  const vendorB = store();
  recordPursuitDecision(vendorA, { matter_ref: "procurement:1", decision: "pursuing" });
  recordPursuitDecision(vendorB, { matter_ref: "procurement:1", decision: "passed" });

  clearPursuitDecision(vendorA, "procurement:1");

  assert.equal(pursuitStateFor(vendorA, "procurement:1"), null);
  assert.equal(pursuitStateFor(vendorB, "procurement:1").decision, "passed");
});

// ---- A5: the state is never presented as a published fact or a signal about the procurement ----

test("A5: the personal-state register is a distinct token from the published-fact and procurement-signal registers", () => {
  assert.equal(PURSUIT_STATE_REGISTER.PERSONAL, "personal-state");
  assert.notEqual(PURSUIT_STATE_REGISTER.PERSONAL, PURSUIT_STATE_REGISTER.PUBLISHED_FACT);
  assert.notEqual(PURSUIT_STATE_REGISTER.PERSONAL, PURSUIT_STATE_REGISTER.PROCUREMENT_SIGNAL);
});

test("A5: every badge this module produces carries the personal-state register and user-supplied provenance", () => {
  const record = recordPursuitDecision(store(), { matter_ref: "procurement:1", decision: "pursuing" });
  const badge = pursuitBadge(record);
  assert.ok(isPersonalStateRegisterLabel(badge.register));
  assert.ok(isPursuitStateProvenanceLabel(badge.provenance));
});

test("A5: this module's provenance token is never the published-fact grammar's own token", () => {
  // procurement_pursuit_snapshot.mjs's PURSUIT_FIELD_STATUS values (observed,
  // derived, user_provided, not_observed, unavailable) are a different
  // system's published-fact vocabulary -- never interchangeable with this
  // module's own "user-supplied" token.
  for (const value of Object.values(PURSUIT_FIELD_STATUS)) {
    assert.equal(isPursuitStateProvenanceLabel(value), false, `${value} must not pass as pursuit-state provenance`);
    assert.equal(isPersonalStateRegisterLabel(value), false, `${value} must not pass as the personal-state register`);
  }
  assert.equal(PURSUIT_STATE_PROVENANCE_LABEL, "user-supplied");
});

test("A5 negative fixture: a renderer that relabels a badge with the published-fact register fails the exported check", () => {
  const record = recordPursuitDecision(store(), { matter_ref: "procurement:1", decision: "pursuing" });
  const badge = pursuitBadge(record);
  const mislabeled = { ...badge, register: PURSUIT_STATE_REGISTER.PUBLISHED_FACT };
  assert.equal(isPersonalStateRegisterLabel(mislabeled.register), false);
  assert.equal(isPersonalStateRegisterLabel(badge.register), true, "the real badge must still pass");
});

test("A5: pursuitBadge refuses a record that does not carry this module's own provenance token", () => {
  const tampered = { matter_ref: "procurement:1", decision: "pursuing", provenance: "observed" };
  assert.equal(pursuitBadge(tampered), null);
});

test("A5: a stored record from a hand-edited or legacy store outside the closed vocabulary is dropped, never resurfaced", () => {
  const s = store();
  s.setItem(
    "crol_procurement_pursuit_state_v1",
    JSON.stringify({
      schema: PROCUREMENT_PURSUIT_STATE_SCHEMA,
      records: [
        { matter_ref: "procurement:1", decision: "should_bid", provenance: "user-supplied", recorded_at: "2026-01-01T00:00:00Z" },
        { matter_ref: "procurement:2", decision: "pursuing", provenance: "observed", recorded_at: "2026-01-01T00:00:00Z" },
      ],
    }),
  );
  assert.equal(pursuitStateFor(s, "procurement:1"), null);
  assert.equal(pursuitStateFor(s, "procurement:2"), null);
});

// ---- A6: no ranking, scoring, or filtering beyond the recording vendor's own view ----

test("A6: the module exposes no ranking, scoring, sorting, or filtering function", () => {
  const bannedNamePattern = /rank|score|weight|^sort|^filter/i;
  for (const exportName of Object.keys(pursuitStateModule)) {
    assert.doesNotMatch(exportName, bannedNamePattern, `${exportName} looks like a ranking/scoring/filtering export`);
  }
});

test("A6: resurfacePursuitState never reorders, adds, or drops rows -- only annotates in place", () => {
  const s = store();
  recordPursuitDecision(s, { matter_ref: "procurement:2", decision: "pursuing" });
  const rows = [
    { procurement_id: "procurement:1" },
    { procurement_id: "procurement:2" },
    { procurement_id: "procurement:3" },
  ];
  const resurfaced = resurfacePursuitState(rows, s);
  assert.equal(resurfaced.length, rows.length);
  assert.deepEqual(resurfaced.map((row) => row.procurement_id), rows.map((row) => row.procurement_id));
});

test("A6: pursuitStateFor never affects list ordering -- reading state for a matter does not touch the store", () => {
  const s = store();
  recordPursuitDecision(s, { matter_ref: "procurement:1", decision: "pursuing" });
  recordPursuitDecision(s, { matter_ref: "procurement:2", decision: "passed" });
  const before = s.getItem("crol_procurement_pursuit_state_v1");
  pursuitStateFor(s, "procurement:1");
  pursuitStateFor(s, "procurement:2");
  pursuitStateFor(s, "procurement:does-not-exist");
  const after = s.getItem("crol_procurement_pursuit_state_v1");
  assert.equal(before, after);
});

test("A6: no result carries a score, weight, or rank field", () => {
  const record = recordPursuitDecision(store(), { matter_ref: "procurement:1", decision: "pursuing" });
  const badge = pursuitBadge(record);
  const json = JSON.stringify({ record, badge });
  assert.doesNotMatch(json, /"score"/i);
  assert.doesNotMatch(json, /"weight"/i);
  assert.doesNotMatch(json, /"rank"/i);
});

// ---- Negative rule: never infer a decision the vendor did not record ----

test("negative rule: an unrecorded matter has no pursuit state -- never defaulted or inferred", () => {
  const s = store();
  assert.equal(pursuitStateFor(s, "procurement:never-recorded"), null);
  const [row] = resurfacePursuitState([{ procurement_id: "procurement:never-recorded" }], s);
  assert.equal(row.pursuit_state, undefined);
});

// ---- Overwrite behavior ----

test("recording a new decision for the same matter overwrites the vendor's prior record", () => {
  const s = store();
  recordPursuitDecision(s, { matter_ref: "procurement:1", decision: "under_review" });
  recordPursuitDecision(s, { matter_ref: "procurement:1", decision: "pursuing", reason_code: "capacity" });
  const current = pursuitStateFor(s, "procurement:1");
  assert.equal(current.decision, "pursuing");
  assert.equal(current.reason_code, "capacity");
});

// ---- matter_ref identity resolution ----

test("matterRefFromRow prefers an explicit matter_ref, then procurement_id, then request_id", () => {
  assert.equal(matterRefFromRow({ matter_ref: "m1", procurement_id: "p1", request_id: "r1" }), "m1");
  assert.equal(matterRefFromRow({ procurement_id: "p1", request_id: "r1" }), "p1");
  assert.equal(matterRefFromRow({ request_id: "r1" }), "r1");
  assert.equal(matterRefFromRow({}), null);
});

// ---- Vocabulary helpers ----

test("isKnownPursuitDecision / isKnownPursuitReasonCode reject values outside the closed vocabularies", () => {
  assert.equal(isKnownPursuitDecision("pursuing"), true);
  assert.equal(isKnownPursuitDecision("bidding"), false);
  assert.equal(isKnownPursuitReasonCode("capability_fit"), true);
  assert.equal(isKnownPursuitReasonCode("we_like_it"), false);
});
