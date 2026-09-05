/**
 * LDP-26: a bounded, source-qualified filing sequence over the LDP-23/LDP-24
 * filing contracts and the LDP-02/LDP-13 environmental facts, consumed as-is.
 *
 * Verify: node --test test/land_filing_sequence.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FILING_SEQUENCE_EVENT_KINDS,
  FILING_SEQUENCE_CLOCK_KINDS,
  FILING_SEQUENCE_CONFLICT_STATES,
  LAND_FILING_SEQUENCE_DIGEST_LIMIT,
  applicabilityAssertedEvents,
  bestSupportedAvailability,
  buildFilingSequenceDigest,
  buildFilingSequenceEvent,
  certifiedOrReferredNoticeEvents,
  detectPackageVersionGaps,
  documentSupersededEvents,
  environmentalIdentityObservedEvent,
  environmentalMilestoneObservedEvents,
  filingSequenceEventId,
  materializeLandFilingSequence,
  noticeOfReceiptEvents,
  packageVersionObservedEvents,
  reportFirstObservedEvents,
  reportNotTimelyFiledNoticeEvents,
  summarizeFilingSequenceObservations,
} from "../warehouse/lib/land_filing_sequence.mjs";
import {
  FORBIDDEN_FILING_OBSERVATION_SYNONYMS,
  buildLandUseFilingDocument,
  buildLandUseFilingObligation,
  landUseFilingObligationId,
  racialEquityReportGoverningAuthority,
} from "../ontology/land_use_filing.mjs";

const PROJECT_ID = "2025Q0247";
const PROJECT_REF = `project:${PROJECT_ID}`;
const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-03-01T00:00:00.000Z";
const T2 = "2026-06-01T00:00:00.000Z";
const T3 = "2026-09-01T00:00:00.000Z";

const GOVERNING_AUTHORITY = [racialEquityReportGoverningAuthority()];

function obligation(overrides = {}) {
  return buildLandUseFilingObligation({
    obligation_id: landUseFilingObligationId({ project_ref: PROJECT_REF, obligation_type: "racial_equity_report" }),
    project_ref: PROJECT_REF,
    obligation_type: "racial_equity_report",
    governing_authority: GOVERNING_AUTHORITY,
    applicability: { state: "unknown" },
    fulfillment: { state: "not_checked" },
    observed_at: T0,
    available_to_public_at: T0,
    materialized_at: T0,
    source_id: "zap-api-outcomes",
    source_record_id: PROJECT_ID,
    source_vintage: T0,
    normalization_version: "ldp23-v1",
    ...overrides,
  });
}

function document(overrides = {}) {
  return buildLandUseFilingDocument({
    project_ref: PROJECT_REF,
    document_type: "filed_land_use_package",
    publisher_document_id: "pkg-1",
    original_name: "Filed LU Package.pdf",
    first_observed_at: T0,
    available_to_public_at: T0,
    retrieval_status: "not_attempted",
    classification: { method: "explicit_publisher_type_or_group", evidence: ["dcp-packagetype"], confidence: "high" },
    ...overrides,
  });
}

function zapRow(overrides = {}) {
  return {
    project_id: PROJECT_ID,
    app_filed_date: "2025-06-24",
    noticed_date: null,
    certified_referred: null,
    ulurp_numbers: "250308MMK",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Module self-check: no exported vocabulary word is a forbidden       */
/* filing-observation synonym.                                        */
/* ------------------------------------------------------------------ */

test("no event kind, clock kind, or conflict state equals a forbidden filing-observation synonym", () => {
  const vocabulary = [...FILING_SEQUENCE_EVENT_KINDS, ...FILING_SEQUENCE_CLOCK_KINDS, ...FILING_SEQUENCE_CONFLICT_STATES];
  for (const word of FORBIDDEN_FILING_OBSERVATION_SYNONYMS) {
    assert.ok(!vocabulary.includes(word), `vocabulary must not include forbidden synonym "${word}"`);
  }
});

test("summarizeFilingSequenceObservations never exposes a readiness/completeness-shaped key", () => {
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, materializedAt: T0 });
  const summary = summarizeFilingSequenceObservations(sequence);
  for (const key of Object.keys(summary)) {
    for (const word of FORBIDDEN_FILING_OBSERVATION_SYNONYMS) {
      assert.ok(!key.toLowerCase().includes(word), `summary key "${key}" must not resemble forbidden synonym "${word}"`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* buildFilingSequenceEvent: clock/availability invariants             */
/* ------------------------------------------------------------------ */

test("buildFilingSequenceEvent requires observed_at and clock_kind='unknown' to agree", () => {
  assert.throws(() => buildFilingSequenceEvent({
    project_ref: PROJECT_REF,
    event_kind: "application_filed",
    publisher: { source_id: "x" },
    source_record_id: PROJECT_ID,
    clock_kind: "unknown",
    observed_at: T0,
    confidence: "high",
  }), /clock_kind 'unknown'/);
  assert.throws(() => buildFilingSequenceEvent({
    project_ref: PROJECT_REF,
    event_kind: "application_filed",
    publisher: { source_id: "x" },
    source_record_id: PROJECT_ID,
    clock_kind: "publisher_asserted_calendar_date",
    observed_at: null,
    confidence: "high",
  }), /clock_kind 'unknown'/);
});

test("buildFilingSequenceEvent forbids available_to_public_at without observed_at, and forbids conflict_state 'none' with a null clock", () => {
  assert.throws(() => buildFilingSequenceEvent({
    project_ref: PROJECT_REF,
    event_kind: "application_filed",
    publisher: { source_id: "x" },
    source_record_id: PROJECT_ID,
    clock_kind: "unknown",
    observed_at: null,
    available_to_public_at: T0,
    confidence: "unknown",
  }), /available_to_public_at cannot be set/);
  assert.throws(() => buildFilingSequenceEvent({
    project_ref: PROJECT_REF,
    event_kind: "application_filed",
    publisher: { source_id: "x" },
    source_record_id: PROJECT_ID,
    clock_kind: "unknown",
    observed_at: null,
    conflict_state: "none",
    confidence: "unknown",
  }), /conflict_state cannot be 'none'/);
});

test("bestSupportedAvailability picks the later of the observed clock and the source vintage", () => {
  assert.equal(bestSupportedAvailability({ observedAt: T0, sourceVintage: T1 }), T1);
  assert.equal(bestSupportedAvailability({ observedAt: T1, sourceVintage: T0 }), T1);
  assert.equal(bestSupportedAvailability({ observedAt: T0, sourceVintage: null }), T0);
  assert.equal(bestSupportedAvailability({ observedAt: null, sourceVintage: null }), null);
});

test("filingSequenceEventId is deterministic for the same project/kind/disambiguator", () => {
  const a = filingSequenceEventId({ project_ref: PROJECT_REF, event_kind: "application_filed", disambiguator: "app_filed_date" });
  const b = filingSequenceEventId({ project_ref: PROJECT_REF, event_kind: "application_filed", disambiguator: "app_filed_date" });
  assert.equal(a, b);
});

/* ------------------------------------------------------------------ */
/* Negative test: a missing source date (absent vs. malformed)         */
/* ------------------------------------------------------------------ */

test("a wholly absent application_filed source date yields no event -- honest absence, not a fabricated one", () => {
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, zapRow: zapRow({ app_filed_date: null }), materializedAt: T0 });
  assert.ok(!sequence.events.some((e) => e.event_kind === "application_filed"));
});

test("a present but malformed application_filed date yields an explicit unresolved-clock event, never silently dropped", () => {
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, zapRow: zapRow({ app_filed_date: "not-a-real-date" }), materializedAt: T0 });
  const event = sequence.events.find((e) => e.event_kind === "application_filed");
  assert.ok(event, "the event must exist even though its clock is unresolved");
  assert.equal(event.observed_at, null);
  assert.equal(event.clock_kind, "unknown");
  assert.equal(event.conflict_state, "unresolved_clock");
  assert.ok(sequence.order.unresolved_clock_event_ids.includes(event.event_id));
  assert.ok(!sequence.order.ordered_event_ids.includes(event.event_id), "an unresolved clock must not receive a sequence position");
});

/* ------------------------------------------------------------------ */
/* Negative test: a notice of receipt appearing after a later event    */
/* ------------------------------------------------------------------ */

test("a notice of receipt observed after certification is ordered honestly by its own clock, not forced into a fixed procedural slot", () => {
  const documents = [
    document({ document_type: "notice_of_receipt", publisher_document_id: "receipt-1", original_name: "Notice of Receipt.pdf", first_observed_at: T2, available_to_public_at: T2, classification: { method: "title_token_plus_markers", evidence: ["notice of receipt"], confidence: "medium" } }),
  ];
  const sequence = materializeLandFilingSequence({
    projectId: PROJECT_ID,
    zapRow: zapRow({ certified_referred: "2026-02-01" }),
    documents,
    materializedAt: T3,
  });
  const receiptEvent = sequence.events.find((e) => e.event_kind === "notice_of_receipt_observed");
  const certifiedEvent = sequence.events.find((e) => e.event_kind === "application_certified_or_referred");
  const order = sequence.order.ordered_event_ids;
  assert.ok(order.indexOf(certifiedEvent.event_id) < order.indexOf(receiptEvent.event_id), "the sequence must reflect the true, later position of the receipt notice");
});

/* ------------------------------------------------------------------ */
/* Negative test: a third package version without a second             */
/* ------------------------------------------------------------------ */

test("a third package version observed without a second is kept, not fabricated or rejected, and the gap is recorded as an observation", () => {
  const documents = [
    document({ publisher_document_id: "pkg-v1", first_observed_at: T0, available_to_public_at: T0, version_ordinal: 1 }),
    document({ publisher_document_id: "pkg-v3", first_observed_at: T2, available_to_public_at: T2, version_ordinal: 3, supersedes: null }),
  ];
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, documents, materializedAt: T3 });
  const packageEvents = sequence.events.filter((e) => e.event_kind === "package_version_observed");
  assert.equal(packageEvents.length, 2, "both observed versions remain distinct events");
  assert.deepEqual(packageEvents.map((e) => e.detail.version_ordinal).sort(), [1, 3]);
  assert.ok(sequence.warnings.some((w) => w.includes("gap")), "the gap must be recorded as a warning, never silently filled in");

  const summary = summarizeFilingSequenceObservations(sequence);
  assert.equal(summary.observed_package_version_count, 2, "the count reflects what was actually observed, not the highest ordinal seen");
});

test("detectPackageVersionGaps returns null when versions are contiguous or fewer than two are observed", () => {
  assert.equal(detectPackageVersionGaps([{ version_ordinal: 1 }]), null);
  assert.equal(detectPackageVersionGaps([{ version_ordinal: 1 }, { version_ordinal: 2 }]), null);
  assert.match(detectPackageVersionGaps([{ version_ordinal: 1 }, { version_ordinal: 4 }]), /gap/);
});

/* ------------------------------------------------------------------ */
/* Negative test: a report first observed after certification (A9)    */
/* ------------------------------------------------------------------ */

test("a report first observed after a known certification clock remains a later observation, never backdated, and is surfaced as a pure observation", () => {
  const documents = [
    document({ document_type: "racial_equity_report", publisher_document_id: "rer-1", original_name: "Racial Equity Report.pdf", first_observed_at: T3, available_to_public_at: T3, classification: { method: "title_token_plus_markers", evidence: ["racial equity report"], confidence: "medium" } }),
  ];
  const sequence = materializeLandFilingSequence({
    projectId: PROJECT_ID,
    zapRow: zapRow({ certified_referred: "2026-02-01" }),
    documents,
    materializedAt: T3,
  });
  const reportEvent = sequence.events.find((e) => e.event_kind === "report_first_observed");
  assert.equal(reportEvent.observed_at, T3, "the report keeps its true, later clock");

  const summary = summarizeFilingSequenceObservations(sequence);
  assert.equal(summary.report_observed_relative_to_certification, "after");
});

test("a report first observed before a known certification clock is surfaced as 'before', purely as an observation", () => {
  const documents = [
    document({ document_type: "racial_equity_report", publisher_document_id: "rer-1", original_name: "Racial Equity Report.pdf", first_observed_at: T0, available_to_public_at: T0, classification: { method: "title_token_plus_markers", evidence: ["racial equity report"], confidence: "medium" } }),
  ];
  const sequence = materializeLandFilingSequence({
    projectId: PROJECT_ID,
    zapRow: zapRow({ certified_referred: "2026-02-01" }),
    documents,
    materializedAt: T3,
  });
  const summary = summarizeFilingSequenceObservations(sequence);
  assert.equal(summary.report_observed_relative_to_certification, "before");
});

/* ------------------------------------------------------------------ */
/* Negative test: a non-ULURP historic-district path                   */
/* ------------------------------------------------------------------ */

test("a non-ULURP historic-district project materializes only what it actually has, without inventing noticing or certification events", () => {
  const row = zapRow({ ulurp_numbers: null, noticed_date: null, certified_referred: null, app_filed_date: "2026-01-15" });
  const sequence = materializeLandFilingSequence({ projectId: "2026K0199", zapRow: row, materializedAt: T3 });
  assert.equal(sequence.events.filter((e) => e.event_kind === "application_filed").length, 1);
  assert.equal(sequence.events.filter((e) => e.event_kind === "application_noticed").length, 0);
  assert.equal(sequence.events.filter((e) => e.event_kind === "application_certified_or_referred").length, 0);
});

/* ------------------------------------------------------------------ */
/* Negative test: an absent environmental record (A4/A5)               */
/* ------------------------------------------------------------------ */

test("an absent environmental record yields no environmental events and no fabricated CEQR identity, with an explicit warning", () => {
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, zapRow: zapRow(), ceqrJoin: null, materializedAt: T0 });
  assert.equal(sequence.events.filter((e) => e.event_kind.startsWith("environmental_")).length, 0);
  assert.ok(sequence.warnings.some((w) => w.includes("no CEQR reconciliation join")));
});

test("environmentalIdentityObservedEvent returns null when the ZAP CEQR field is not present, never guessing from title or action text", () => {
  const row = zapRow({ project_name: "26DCP139X-looking title but no retained field" });
  const event = environmentalIdentityObservedEvent({ projectRef: PROJECT_REF, zapRow: row, zapSourceVintage: T0 });
  assert.equal(event, null);
});

/* ------------------------------------------------------------------ */
/* Negative test: an explicit source conflict                          */
/* ------------------------------------------------------------------ */

test("an obligation's own source_conflict applicability state is carried through as an explicit conflict, not resolved by this module", () => {
  const ob = obligation({
    applicability: {
      state: "source_conflict",
      publisher_assertion: { source_field: "dcp-applicability", source_value: "conflicting", observed_at: T0 },
    },
  });
  const events = applicabilityAssertedEvents([ob]);
  assert.equal(events.length, 1);
  assert.equal(events[0].conflict_state, "source_conflict");
});

test("a ZAP-asserted CEQR identity that disagrees with the CEQR reconciliation join is flagged source_conflict, not silently preferred either way", () => {
  const row = zapRow({ ceqr_number: "26DCP139X" });
  const event = environmentalIdentityObservedEvent({ projectRef: PROJECT_REF, zapRow: row, zapSourceVintage: T0, ceqrKey: "26DCP140X" });
  assert.equal(event.conflict_state, "source_conflict");
  assert.equal(event.detail.ceqr_number, "26DCP139X");
  assert.equal(event.detail.reconciliation_ceqr_key, "26DCP140X");
});

/* ------------------------------------------------------------------ */
/* Negative test: changed publisher timestamps across reruns           */
/* ------------------------------------------------------------------ */

test("a rerun with a changed publisher timestamp reflects the current asserted value; this module holds no cross-run state of its own", () => {
  const first = materializeLandFilingSequence({ projectId: PROJECT_ID, zapRow: zapRow({ app_filed_date: "2025-06-24" }), materializedAt: T0 });
  const second = materializeLandFilingSequence({ projectId: PROJECT_ID, zapRow: zapRow({ app_filed_date: "2025-07-01" }), materializedAt: T1 });
  const firstEvent = first.events.find((e) => e.event_kind === "application_filed");
  const secondEvent = second.events.find((e) => e.event_kind === "application_filed");
  assert.equal(firstEvent.event_id, secondEvent.event_id, "identity is stable across reruns");
  assert.notEqual(firstEvent.observed_at, secondEvent.observed_at, "the currently asserted value is reflected, not a stale cached one");
});

/* ------------------------------------------------------------------ */
/* Negative test: multiple certification-like notices                  */
/* ------------------------------------------------------------------ */

test("multiple certification-or-referral notice documents are each kept as their own event and flagged, never collapsed to one fact", () => {
  const documents = [
    document({ document_type: "notice_of_certification_or_referral", publisher_document_id: "notice-1", original_name: "Notice of Certification.pdf", first_observed_at: T1, available_to_public_at: T1, classification: { method: "title_token_plus_markers", evidence: ["notice of certification"], confidence: "medium" } }),
    document({ document_type: "notice_of_certification_or_referral", publisher_document_id: "notice-2", original_name: "Amended Notice of Certification.pdf", first_observed_at: T2, available_to_public_at: T2, classification: { method: "title_token_plus_markers", evidence: ["amended notice"], confidence: "medium" } }),
  ];
  const events = certifiedOrReferredNoticeEvents(documents);
  assert.equal(events.length, 2);

  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, documents, materializedAt: T3 });
  const certifiedEvents = sequence.events.filter((e) => e.event_kind === "application_certified_or_referred");
  assert.equal(certifiedEvents.length, 2);
  assert.ok(certifiedEvents.every((e) => e.conflict_state === "source_conflict"), "two notices observed on different dates disagree about when certification/referral happened");
  assert.ok(sequence.warnings.some((w) => w.includes("certification-or-referral observations")));
});

test("two certification-or-referral notices observed on the same clock are flagged multiple_candidates rather than source_conflict", () => {
  const documents = [
    document({ document_type: "notice_of_certification_or_referral", publisher_document_id: "notice-1", original_name: "Notice of Certification.pdf", first_observed_at: T1, available_to_public_at: T1, classification: { method: "title_token_plus_markers", evidence: ["notice of certification"], confidence: "medium" } }),
    document({ document_type: "notice_of_certification_or_referral", publisher_document_id: "notice-2", original_name: "Duplicate Notice of Certification.pdf", first_observed_at: T1, available_to_public_at: T1, classification: { method: "title_token_plus_markers", evidence: ["notice of certification"], confidence: "medium" } }),
  ];
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, documents, materializedAt: T3 });
  const certifiedEvents = sequence.events.filter((e) => e.event_kind === "application_certified_or_referred");
  assert.equal(certifiedEvents.length, 2);
  assert.ok(certifiedEvents.every((e) => e.conflict_state === "multiple_candidates"));
});

test("a ZAP-asserted certified_referred date that disagrees with a notice document's own clock is flagged source_conflict for both", () => {
  const documents = [
    document({ document_type: "notice_of_certification_or_referral", publisher_document_id: "notice-1", original_name: "Notice of Certification.pdf", first_observed_at: T2, available_to_public_at: T2, classification: { method: "title_token_plus_markers", evidence: ["notice of certification"], confidence: "medium" } }),
  ];
  const sequence = materializeLandFilingSequence({
    projectId: PROJECT_ID,
    zapRow: zapRow({ certified_referred: "2026-01-01" }),
    documents,
    materializedAt: T3,
  });
  const certifiedEvents = sequence.events.filter((e) => e.event_kind === "application_certified_or_referred");
  assert.equal(certifiedEvents.length, 2);
  assert.ok(certifiedEvents.every((e) => e.conflict_state === "source_conflict"));
});

/* ------------------------------------------------------------------ */
/* Package version / supersession inspectability (A3)                  */
/* ------------------------------------------------------------------ */

test("supersession stays inspectable: superseded and superseding package versions both remain first-class events", () => {
  const v1 = document({ publisher_document_id: "pkg-v1", first_observed_at: T0, available_to_public_at: T0, version_ordinal: 1 });
  const v2 = document({ publisher_document_id: "pkg-v1", first_observed_at: T1, available_to_public_at: T1, version_ordinal: 2, supersedes: v1.document_id, supersession_basis: "re-observed with a new hash" });
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, documents: [v1, v2], materializedAt: T3 });
  const packageEvents = sequence.events.filter((e) => e.event_kind === "package_version_observed");
  assert.equal(packageEvents.length, 2, "the collapsed-latest-only view never applies to the warehouse-side event set");
  const supersededEvents = documentSupersededEvents([v1, v2]);
  assert.equal(supersededEvents.length, 1);
  assert.equal(supersededEvents[0].detail.supersedes, v1.document_id);
  assert.equal(supersededEvents[0].observed_at, T1, "the superseding fact keeps its own true, later clock");
});

/* ------------------------------------------------------------------ */
/* Bounded digest (A10)                                                */
/* ------------------------------------------------------------------ */

test("buildFilingSequenceDigest bounds only the digest; the warehouse-side event set stays unbounded and inspectable", () => {
  const documents = Array.from({ length: LAND_FILING_SEQUENCE_DIGEST_LIMIT + 10 }, (_, i) => document({
    publisher_document_id: `pkg-${i + 1}`,
    original_name: `Package ${i + 1}.pdf`,
    first_observed_at: new Date(Date.parse(T0) + i * 86_400_000).toISOString(),
    available_to_public_at: new Date(Date.parse(T0) + i * 86_400_000).toISOString(),
    version_ordinal: i + 1,
  }));
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, documents, materializedAt: T3 });
  assert.equal(sequence.events.length, LAND_FILING_SEQUENCE_DIGEST_LIMIT + 10, "the full warehouse manifest of events is never truncated");

  const digest = buildFilingSequenceDigest(sequence);
  assert.equal(digest.events.length, LAND_FILING_SEQUENCE_DIGEST_LIMIT);
  assert.equal(digest.truncated, true);
  assert.equal(digest.total_ordered_event_count, LAND_FILING_SEQUENCE_DIGEST_LIMIT + 10);
});

test("buildFilingSequenceDigest is not truncated when the sequence is within the bound", () => {
  const sequence = materializeLandFilingSequence({ projectId: PROJECT_ID, zapRow: zapRow(), materializedAt: T0 });
  const digest = buildFilingSequenceDigest(sequence);
  assert.equal(digest.truncated, false);
  assert.equal(digest.events.length, sequence.order.ordered_event_ids.length);
});

/* ------------------------------------------------------------------ */
/* Never translating observation into readiness/completeness           */
/* ------------------------------------------------------------------ */

test("report_not_timely_filed_notice carries the obligation's already-validated non-blocking procedural effect, never a fresh judgement", () => {
  const ob = obligation({
    fulfillment: {
      state: "publisher_identifies_not_timely_filed",
      document_refs: [],
      publisher_assertion: { source_field: "dcp-status", source_value: "not timely filed", observed_at: T1 },
    },
  });
  const events = reportNotTimelyFiledNoticeEvents([ob]);
  assert.equal(events.length, 1);
  assert.equal(events[0].legal_effect.certification_blocker, false);
});

test("a filed package document alone never produces a report_first_observed or notice event -- document_type governs event_kind exactly", () => {
  const packageDoc = document();
  assert.equal(reportFirstObservedEvents([packageDoc], []).length, 0);
  assert.equal(noticeOfReceiptEvents([packageDoc]).length, 0);
  assert.equal(packageVersionObservedEvents([packageDoc]).length, 1);
});

test("no environmental milestone acquisition happens here -- rows are consumed exactly as LDP-13's reconciliation already shaped them", () => {
  const ceqrJoin = {
    ceqr_key: "26DCP139X",
    milestones: {
      rows: [
        { source_record_id: "m-1", milestone_name: "Draft Scope of Work", milestone_date: "2026-02-01", extends_zap_milestone: true, exact_duplicate: false },
        { source_record_id: "m-1", milestone_name: "Draft Scope of Work", milestone_date: "2026-02-01", extends_zap_milestone: true, exact_duplicate: true },
      ],
    },
  };
  const events = environmentalMilestoneObservedEvents({ projectRef: PROJECT_REF, ceqrJoin });
  assert.equal(events.length, 2, "both rows remain distinct events, never deduplicated here");
  assert.equal(events[1].conflict_state, "multiple_candidates", "an exact-duplicate row from the reconciliation is flagged, not silently dropped");
});
