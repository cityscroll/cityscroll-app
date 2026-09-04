import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAppendOnlyLog,
  buildReviewEventKey,
  CONTRADICTION_TYPES,
  detectContradictions,
  projectReviewStateAsOf,
  SeqraOntologyValidationError,
  sortReviewEvents,
  stringifyReviewState,
} from "../warehouse/lib/seqra_review_event_log.mjs";
import {
  CLEAN_REVIEW_EVENTS,
  CLEAN_REVIEW_FIXTURE_CUTOFFS,
  CLEAN_REVIEW_FIXTURE_KEYS,
  CONFLICTING_ACTION_KEY,
  CONFLICTING_DETERMINATIONS_EVENTS,
  CONFLICTING_DETERMINATIONS_FIXTURE_KEYS,
  FINAL_BEFORE_DRAFT_EVENTS,
  FINAL_BEFORE_DRAFT_FIXTURE_KEYS,
} from "../warehouse/fixtures/seqra-ontology/review_event_log_fixtures.mjs";

describe("SEQRA/CEQR append-only review event log", () => {
  it("accepts a well-formed batch of events and dedupes an identical repeat", () => {
    const log = buildAppendOnlyLog([...CLEAN_REVIEW_EVENTS, CLEAN_REVIEW_EVENTS[0]]);
    assert.equal(log.events.length, CLEAN_REVIEW_EVENTS.length);
  });

  it("throws SeqraOntologyValidationError, not a silent drop, on a malformed event", () => {
    const malformed = { ...CLEAN_REVIEW_EVENTS[0], event_type: "not_a_real_event_type" };
    assert.throws(() => buildAppendOnlyLog([malformed]), SeqraOntologyValidationError);
  });

  it("throws when the same event_key is reused for different content", () => {
    const collided = { ...CLEAN_REVIEW_EVENTS[1], event_key: CLEAN_REVIEW_EVENTS[0].event_key };
    assert.throws(() => buildAppendOnlyLog([CLEAN_REVIEW_EVENTS[0], collided]), SeqraOntologyValidationError);
  });

  it("event keys are deterministic: identical identity+content always produce the same key", () => {
    const a = buildReviewEventKey({
      reviewKey: "environmental_review:ceqr:26DCP001X", eventType: "public_hearing_held",
      effectiveAt: "2026-04-01T00:00:00.000Z", sourceId: "city_record", sourceRecordId: "r1", payload: {},
    });
    const b = buildReviewEventKey({
      reviewKey: "environmental_review:ceqr:26DCP001X", eventType: "public_hearing_held",
      effectiveAt: "2026-04-01T00:00:00.000Z", sourceId: "city_record", sourceRecordId: "r1", payload: {},
    });
    assert.equal(a, b);
  });

  it("sortReviewEvents is independent of input array order", () => {
    const forward = sortReviewEvents(CLEAN_REVIEW_EVENTS);
    const shuffled = sortReviewEvents([...CLEAN_REVIEW_EVENTS].reverse());
    assert.deepEqual(forward.map((e) => e.event_key), shuffled.map((e) => e.event_key));
  });
});

describe("SEQRA/CEQR as-of state projector: A1/A3 cutoff reproduction and replay-order independence", () => {
  it("reproduces the review's state at an arbitrary historical cutoff, excluding events not yet public", () => {
    const before = projectReviewStateAsOf(CLEAN_REVIEW_EVENTS, {
      reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY,
      cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.BEFORE_DEIS,
    });
    assert.equal(before.ok, true);
    assert.equal(before.current_stage, "final_scope_issued");
    assert.deepEqual(before.documents, {});

    const midway = projectReviewStateAsOf(CLEAN_REVIEW_EVENTS, {
      reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY,
      cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.AFTER_DEIS_BEFORE_FEIS,
    });
    assert.equal(midway.ok, true);
    assert.equal(midway.current_stage, "public_hearing_held");
    assert.ok(midway.documents[CLEAN_REVIEW_FIXTURE_KEYS.DEIS_KEY], "DEIS must be visible once published");
    assert.equal(midway.documents[CLEAN_REVIEW_FIXTURE_KEYS.DEIS_KEY].document_stage, "draft");
    assert.equal(Object.keys(midway.documents).length, 1, "FEIS must not leak before its own available_to_public_at");
    assert.equal(midway.determinations[CLEAN_REVIEW_FIXTURE_KEYS.DETERMINATION_KEY], undefined, "the determination must not leak before cutoff");

    const after = projectReviewStateAsOf(CLEAN_REVIEW_EVENTS, {
      reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY,
      cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.AFTER_DETERMINATION,
    });
    assert.equal(after.ok, true);
    assert.equal(after.current_stage, "final_determination_issued");
  });

  it("A5: draft and final documents coexist -- the FEIS never overwrites the DEIS row, it is linked by supersession", () => {
    const state = projectReviewStateAsOf(CLEAN_REVIEW_EVENTS, {
      reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY,
      cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.AFTER_DETERMINATION,
    });
    const deis = state.documents[CLEAN_REVIEW_FIXTURE_KEYS.DEIS_KEY];
    const feis = state.documents[CLEAN_REVIEW_FIXTURE_KEYS.FEIS_KEY];
    assert.ok(deis && feis, "both draft and final documents remain present in the projection");
    assert.equal(deis.document_stage, "draft");
    assert.equal(feis.document_stage, "final");
    assert.equal(deis.superseded_by_document_key, CLEAN_REVIEW_FIXTURE_KEYS.FEIS_KEY);
    // The topic assessment against the draft is also retained, not replaced --
    // a historical projection before the final document must still be able to
    // show the draft-stage assessment.
    const beforeFinal = projectReviewStateAsOf(CLEAN_REVIEW_EVENTS, {
      reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY,
      cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.AFTER_DEIS_BEFORE_FEIS,
    });
    assert.equal(beforeFinal.topics.shadows.state, "detailed_analysis");
    assert.equal(state.topics.shadows.state, "mitigated");
  });

  it("replaying the same events in reversed insertion order produces a byte-identical projection", () => {
    const forward = projectReviewStateAsOf(CLEAN_REVIEW_EVENTS, {
      reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY,
      cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.AFTER_DETERMINATION,
    });
    const reversed = projectReviewStateAsOf([...CLEAN_REVIEW_EVENTS].reverse(), {
      reviewKey: CLEAN_REVIEW_FIXTURE_KEYS.CLEAN_REVIEW_KEY,
      cutoff: CLEAN_REVIEW_FIXTURE_CUTOFFS.AFTER_DETERMINATION,
    });
    assert.equal(stringifyReviewState(forward), stringifyReviewState(reversed));
  });
});

describe("SEQRA/CEQR as-of state projector: A6 contradiction and impossible-sequence tests", () => {
  it("rejects a final document published before its draft, rather than producing a plausible current state", () => {
    const contradictions = detectContradictions(FINAL_BEFORE_DRAFT_EVENTS);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].type, CONTRADICTION_TYPES.FINAL_BEFORE_DRAFT);

    const projection = projectReviewStateAsOf(FINAL_BEFORE_DRAFT_EVENTS, {
      reviewKey: FINAL_BEFORE_DRAFT_FIXTURE_KEYS.FINAL_BEFORE_DRAFT_REVIEW_KEY,
      cutoff: "2026-12-31T00:00:00.000Z",
    });
    assert.equal(projection.ok, false);
    assert.equal(projection.contradictions[0].type, CONTRADICTION_TYPES.FINAL_BEFORE_DRAFT);
  });

  it("a final document published before its draft is not yet a visible contradiction before the final is public", () => {
    // Before the final's own available_to_public_at, only the projector's
    // cutoff-filtered view matters -- there is nothing contradictory yet
    // because the offending final event itself is not public.
    const projection = projectReviewStateAsOf(FINAL_BEFORE_DRAFT_EVENTS, {
      reviewKey: FINAL_BEFORE_DRAFT_FIXTURE_KEYS.FINAL_BEFORE_DRAFT_REVIEW_KEY,
      cutoff: "2025-12-31T00:00:00.000Z",
    });
    assert.equal(projection.ok, true);
    assert.deepEqual(projection.documents, {});
  });

  it("rejects two conflicting, unsuperseded determinations for one action", () => {
    const contradictions = detectContradictions(CONFLICTING_DETERMINATIONS_EVENTS);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].type, CONTRADICTION_TYPES.CONFLICTING_DETERMINATIONS);
    assert.equal(contradictions[0].event_keys.length, 2);

    const projection = projectReviewStateAsOf(CONFLICTING_DETERMINATIONS_EVENTS, {
      reviewKey: CONFLICTING_DETERMINATIONS_FIXTURE_KEYS.CONFLICTING_DETERMINATION_REVIEW_KEY,
      cutoff: "2026-12-31T00:00:00.000Z",
    });
    assert.equal(projection.ok, false);
  });

  it("an explicit supersession resolves what would otherwise be a conflicting-determination contradiction", () => {
    const [first, second] = CONFLICTING_DETERMINATIONS_EVENTS;
    const corrected = second.payload.determination_key
      ? [first, { ...second, payload: { ...second.payload, supersedes_determination_key: first.payload.determination_key } }]
      : [first, second];
    const contradictions = detectContradictions(corrected);
    assert.deepEqual(contradictions, []);

    const projection = projectReviewStateAsOf(corrected, {
      reviewKey: CONFLICTING_DETERMINATIONS_FIXTURE_KEYS.CONFLICTING_DETERMINATION_REVIEW_KEY,
      cutoff: "2026-12-31T00:00:00.000Z",
    });
    assert.equal(projection.ok, true);
    assert.equal(projection.determinations[first.payload.determination_key].superseded_by_determination_key, second.payload.determination_key);
  });

  it("two determinations for different actions with different outcomes are never flagged as conflicting", () => {
    const otherActionEvent = {
      ...CONFLICTING_DETERMINATIONS_EVENTS[1],
      payload: { ...CONFLICTING_DETERMINATIONS_EVENTS[1].payload, action_key: "action:dcp:zap:a_totally_different_action", determination_key: "determination:dcp:a_totally_different_action:2026-06-15" },
      event_key: buildReviewEventKey({
        reviewKey: CONFLICTING_DETERMINATIONS_EVENTS[1].review_key,
        eventType: "final_determination_issued",
        effectiveAt: CONFLICTING_DETERMINATIONS_EVENTS[1].effective_at,
        sourceId: CONFLICTING_DETERMINATIONS_EVENTS[1].source_id,
        sourceRecordId: "different-action",
        payload: { ...CONFLICTING_DETERMINATIONS_EVENTS[1].payload, action_key: "action:dcp:zap:a_totally_different_action" },
      }),
    };
    const contradictions = detectContradictions([CONFLICTING_DETERMINATIONS_EVENTS[0], otherActionEvent]);
    assert.deepEqual(contradictions, []);
    assert.notEqual(CONFLICTING_ACTION_KEY, "action:dcp:zap:a_totally_different_action");
  });
});
