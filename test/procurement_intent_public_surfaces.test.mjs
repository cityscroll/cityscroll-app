import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { buildProspectiveProcess } from "../ontology/procurement_intent.mjs";
import { matchHistoricalIntent } from "../warehouse/lib/procurement_intent_realization_matcher.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import {
  PROCUREMENT_INTENT_EVIDENCE_STATES,
  PROCUREMENT_INTENT_LIFECYCLE_STATUS,
  PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH,
  authorizationFromShadowAggregate,
  defaultCopyContainsPipelineStatus,
  evaluateIntentSignalAdmission,
  meetingIntentSurfaceHtmlFromOptions,
  procurementIntentSurfaceHtmlFromOptions,
  projectMeetingIntentSurface,
  projectProcurementIntentSurface,
  publicSurfaceAuthorizationAdmitted,
  readProductionShadowObservation,
  renderMeetingIntentSurfaceHtml,
  renderProcurementIntentSurfaceHtml,
} from "../site/procurement_intent_public_surfaces.mjs";

const fixtures = JSON.parse(readFileSync(
  new URL("./fixtures/procurement_intent_radar/gold_fixtures.v0.json", import.meta.url),
  "utf8",
));
const shadowFixture = JSON.parse(readFileSync(
  new URL("../warehouse/fixtures/procurement-intent-radar/shadow_mode.v1.json", import.meta.url),
  "utf8",
));

const caseById = (id) => fixtures.cases.find((item) => item.id === id);
const COMPASS = caseById("compass-dycd-2025-05-19");
const HRA = caseById("hra-dv-beds-2024-10-09");

const COMPASS_SOLICITATIONS = [
  {
    source_system: "city_record",
    source_system_id: "26026P0003",
    epin: "26026P0003",
    published_at: "2025-10-01",
    agency: "DYCD",
    title: "COMPASS Programs in Public Schools",
    procurement_method: "RFP",
    citation_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20250915017",
  },
  {
    source_system: "city_record",
    source_system_id: "26026P0004",
    epin: "26026P0004",
    published_at: "2025-10-01",
    agency: "Department of Youth and Community Development",
    title: "COMPASS Center-Based and Non-Public School Site Programs",
    procurement_method: "RFP",
  },
];

const SHELTER_SOLICITATION = {
  source_system: "passport",
  source_system_id: "06925P0010",
  epin: "06925P0010",
  published_at: "2025-03-07",
  agency: "HRA / DSS",
  title: "DVS 94 beds Emergency Shelter and Support Services Open Ended RFx",
  description: "Emergency shelter for domestic violence survivors, single adults and families.",
  procurement_method: "RFx",
};

const ADMITTED_AUTHORIZATION = {
  product_promotion_allowed: true,
  retained_production_observations_present: true,
  resolved_production_observation_count: 24,
  publication_authorized_at: "2026-09-01",
  source_path: PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH,
  reason: "production_observations_authorized",
};

const COMPLETE_COVERAGE = {
  searched: true,
  window_closed: true,
  complete: true,
  sources_checked: ["city_record", "passport"],
};

test("public intent surfaces only statically import browser-published modules", () => {
  const siteRoot = new URL("../site/", import.meta.url);
  const pending = [new URL("procurement_intent_public_surfaces.mjs", siteRoot)];
  const visited = new Set();
  const imports = /\b(?:import|export)\s+(?:[^"']*?\sfrom\s+)?["'](\.[^"']+)["']/gu;

  while (pending.length) {
    const moduleUrl = pending.pop();
    if (visited.has(moduleUrl.href)) continue;
    visited.add(moduleUrl.href);

    const source = readFileSync(moduleUrl, "utf8");
    for (const match of source.matchAll(imports)) {
      const target = new URL(match[1], moduleUrl);
      assert.ok(
        target.href.startsWith(siteRoot.href),
        `${moduleUrl.pathname} imports unpublished browser dependency ${target.pathname}`,
      );
      pending.push(target);
    }
  }
});

function processFor(fixtureCase) {
  return buildProspectiveProcess({
    source: fixtureCase.source,
    assertion: fixtureCase.expected_future_action_assertion,
  });
}

function matchFor(fixtureCase, solicitations) {
  const process = processFor(fixtureCase);
  return {
    process,
    match: matchHistoricalIntent({
      process_ref: process.process_ref,
      stated_intent: process.stated_intent,
    }, solicitations),
  };
}

test("admitted meeting surface ships What officials said may happen next", () => {
  const { process, match } = matchFor(COMPASS, COMPASS_SOLICITATIONS);
  const projection = projectMeetingIntentSurface({
    process,
    match,
    observations: COMPASS_SOLICITATIONS,
    authorization: ADMITTED_AUTHORIZATION,
    observation_coverage: COMPLETE_COVERAGE,
    now: "2025-10-02",
  });
  assert.equal(projection.admission.admitted, true);
  assert.equal(projection.view.heading, "What officials said may happen next");
  assert.equal(projection.view.lifecycle_status, PROCUREMENT_INTENT_LIFECYCLE_STATUS.REALIZED);
  assert.match(projection.view.status_label, /Solicitation published/);
  assert.equal(projection.view.advance_signal_days, 135);

  const html = renderMeetingIntentSurfaceHtml(projection);
  assert.match(html, /What officials said may happen next/);
  assert.match(html, /data-procurement-intent-surface="meeting"/);
  assert.match(html, /Source fact/);
  assert.match(html, /CityScroll interpretation/);
  assert.match(html, /Later observation/);
  assert.equal(defaultCopyContainsPipelineStatus(html), false);
});

test("admitted procurement surface ships First public signal and Advance signal days", () => {
  const { process, match } = matchFor(COMPASS, COMPASS_SOLICITATIONS);
  const projection = projectProcurementIntentSurface({
    process,
    match,
    observations: COMPASS_SOLICITATIONS,
    authorization: ADMITTED_AUTHORIZATION,
    observation_coverage: COMPLETE_COVERAGE,
    now: "2025-10-02",
  });
  assert.equal(projection.admission.admitted, true);
  assert.equal(projection.view.heading, "First public signal");
  assert.match(projection.view.first_public_signal_label, /First public signal/);
  assert.equal(projection.view.advance_signal_label, "Advance signal: 135 days");
  assert.equal(projection.view.advance_signal_days, 135);
  assert.equal(projection.view.realizations.length, 2);

  const html = renderProcurementIntentSurfaceHtml(projection);
  assert.match(html, /First public signal/);
  assert.match(html, /Advance signal: 135 days/);
  assert.match(html, /26026P0003/);
  assert.match(html, /26026P0004/);
  assert.equal(defaultCopyContainsPipelineStatus(html), false);
});

test("held authorization suppresses every public panel", () => {
  const { process, match } = matchFor(HRA, [SHELTER_SOLICITATION]);
  const held = {
    product_promotion_allowed: false,
    retained_production_observations_present: false,
    resolved_production_observation_count: 0,
    reason: "publication_authorization_held",
  };
  assert.equal(publicSurfaceAuthorizationAdmitted(held), false);

  const meeting = projectMeetingIntentSurface({
    process,
    match,
    observations: [SHELTER_SOLICITATION],
    authorization: held,
    observation_coverage: COMPLETE_COVERAGE,
    now: "2025-03-08",
  });
  const procurement = projectProcurementIntentSurface({
    process,
    match,
    observations: [SHELTER_SOLICITATION],
    authorization: held,
    observation_coverage: COMPLETE_COVERAGE,
    now: "2025-03-08",
  });
  assert.equal(meeting.admission.admitted, false);
  assert.equal(procurement.admission.admitted, false);
  assert.equal(meeting.view, null);
  assert.equal(procurement.view, null);
  assert.deepEqual(meeting.admission.hold_reasons, ["publication_authorization_held"]);
  assert.equal(renderMeetingIntentSurfaceHtml(meeting), "");
  assert.equal(renderProcurementIntentSurfaceHtml(procurement), "");
});

test("source fact, interpretation, and later observation stay visually distinct", () => {
  const { process, match } = matchFor(HRA, [SHELTER_SOLICITATION]);
  const projection = projectProcurementIntentSurface({
    process,
    match,
    observations: [SHELTER_SOLICITATION],
    authorization: ADMITTED_AUTHORIZATION,
    observation_coverage: COMPLETE_COVERAGE,
    now: "2025-03-08",
  });
  assert.deepEqual(projection.view.evidence.evidence_states, [...PROCUREMENT_INTENT_EVIDENCE_STATES]);

  const html = renderProcurementIntentSurfaceHtml(projection);
  assert.match(html, /data-evidence-state="source_fact"/);
  assert.match(html, /data-evidence-state="cityscroll_interpretation"/);
  assert.match(html, /data-evidence-state="later_observation"/);
  assert.match(html, /Source fact/);
  assert.match(html, /CityScroll interpretation/);
  assert.match(html, /Later observation/);

  // Assertion-time source/interpretation registers never name the later EPIN.
  assert.doesNotMatch(projection.view.source_fact_copy, /06925P0010/);
  assert.doesNotMatch(projection.view.interpretation_copy, /06925P0010/);
  assert.doesNotMatch(projection.view.evidence.source_fact.span_text, /06925P0010/);
  assert.match(projection.view.later_observation_copy, /06925P0010/);
  assert.doesNotMatch(html, /predicted HRA would issue|known prediction|CityScroll predicted/i);
});

test("absent enrichment leaves the ordinary meeting document usable", () => {
  const meeting = {
    meeting_id: "meeting:test:intent-fallback",
    title: "Budget hearing",
    source_system: "city_record",
    event_date: "2025-05-19T10:00:00-04:00",
    source_event_id: "council:hearing:2025-05-19:dycd-fy2026-executive-budget",
  };
  const html = renderMeetingDocument(meeting, {}, { currentHref: "/meetings/meeting:test:intent-fallback/" });
  assert.match(html, /Budget hearing/);
  assert.doesNotMatch(html, /What officials said may happen next/);
  assert.doesNotMatch(html, /data-procurement-intent-surface/);
  assert.equal(meetingIntentSurfaceHtmlFromOptions({}, meeting), "");
  assert.equal(procurementIntentSurfaceHtmlFromOptions({}, { procurement_id: "procurement:city_record:26026P0003" }), "");
});

test("meeting document renders the admitted panel through the production options seam", () => {
  const { process, match } = matchFor(COMPASS, COMPASS_SOLICITATIONS);
  const meeting = {
    meeting_id: "meeting:test:compass",
    title: "DYCD executive budget hearing",
    source_system: "city_record",
    event_date: "2025-05-19T10:00:00-04:00",
    source_event_id: process.source_record.source_event_id,
  };
  const html = renderMeetingDocument(meeting, {}, {
    currentHref: "/meetings/meeting:test:compass/",
    procurementIntentAuthorization: ADMITTED_AUTHORIZATION,
    procurementIntentSignals: [{
      process,
      match,
      observations: COMPASS_SOLICITATIONS,
      observation_coverage: COMPLETE_COVERAGE,
    }],
    today: "2025-10-02",
  });
  assert.match(html, /What officials said may happen next/);
  assert.match(html, /data-procurement-intent-surface="meeting"/);
  assert.match(html, /DYCD executive budget hearing/);
  assert.equal(defaultCopyContainsPipelineStatus(html), false);
});

test("procurement document renders First public signal through the production options seam", () => {
  const { process, match } = matchFor(COMPASS, COMPASS_SOLICITATIONS);
  const object = {
    procurement_id: "procurement:city_record:26026P0003",
    identity_keys: { epins: ["26026P0003"] },
    title: "COMPASS Programs in Public Schools",
  };
  const html = renderProcurementDocument(object, [], {
    today: "2025-10-02",
    procurementIntentAuthorization: ADMITTED_AUTHORIZATION,
    procurementIntentSignals: [{
      process,
      match,
      observations: COMPASS_SOLICITATIONS,
      observation_coverage: COMPLETE_COVERAGE,
    }],
  });
  assert.match(html, /First public signal/);
  assert.match(html, /Advance signal: 135 days/);
  assert.match(html, /data-procurement-intent-surface="procurement"/);
  assert.match(html, /COMPASS Programs in Public Schools/);
  assert.equal(defaultCopyContainsPipelineStatus(html), false);
});

test("overdue is suppressed when observation coverage is incomplete", () => {
  const process = processFor(HRA);
  const admission = evaluateIntentSignalAdmission({
    authorization: ADMITTED_AUTHORIZATION,
    process,
    match: { realized_by: [] },
    observations: [],
    observation_coverage: {
      searched: false,
      window_closed: false,
      complete: false,
      sources_checked: [],
      reason: "search_not_finished",
    },
    now: "2025-03-01",
  });
  assert.equal(admission.admitted, true);
  assert.equal(admission.lifecycle_status, PROCUREMENT_INTENT_LIFECYCLE_STATUS.OBSERVATION_INCOMPLETE);
  assert.ok(admission.hold_reasons.includes("overdue_suppressed_incomplete_observations"));

  const projection = projectMeetingIntentSurface({
    process,
    match: { realized_by: [] },
    observations: [],
    authorization: ADMITTED_AUTHORIZATION,
    observation_coverage: {
      searched: false,
      window_closed: false,
      complete: false,
    },
    now: "2025-03-01",
  });
  assert.equal(projection.view.lifecycle_status, PROCUREMENT_INTENT_LIFECYCLE_STATUS.OBSERVATION_INCOMPLETE);
  assert.equal(projection.view.status_label, "Awaiting publication");
  assert.doesNotMatch(renderMeetingIntentSurfaceHtml(projection), /Overdue relative to the stated window/);
});

test("complete observation coverage can admit an overdue status", () => {
  const process = processFor(HRA);
  const projection = projectProcurementIntentSurface({
    process,
    match: { realized_by: [] },
    observations: [],
    authorization: ADMITTED_AUTHORIZATION,
    observation_coverage: COMPLETE_COVERAGE,
    now: "2025-03-01",
  });
  assert.equal(projection.admission.admitted, true);
  assert.equal(projection.view.lifecycle_status, PROCUREMENT_INTENT_LIFECYCLE_STATUS.OVERDUE);
  assert.match(projection.view.status_label, /Overdue/);
  assert.match(renderProcurementIntentSurfaceHtml(projection), /Overdue relative to the stated window/);
});

test("fixture shadow aggregate cannot authorize public panels", () => {
  const authorization = authorizationFromShadowAggregate(shadowFixture, {
    source_path: "warehouse/fixtures/procurement-intent-radar/shadow_mode.v1.json",
  });
  assert.equal(authorization.product_promotion_allowed, false);
  assert.equal(authorization.retained_production_observations_present, false);
  assert.equal(publicSurfaceAuthorizationAdmitted(authorization), false);

  assert.throws(
    () => readProductionShadowObservation(shadowFixture, {
      source_path: "warehouse/fixtures/procurement-intent-radar/shadow_mode.v1.json",
      merge_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    /fixture-only|refusing/i,
  );
  assert.throws(
    () => readProductionShadowObservation(null, {
      merge_commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    }),
    /absent/i,
  );
});

test("production observation receipt pins the merge commit and reports authorization", () => {
  const productionLike = {
    ...shadowFixture,
    visibility: "measurement",
    input_coverage: {
      ...shadowFixture.input_coverage,
      role: "production_arrival_stream",
      recurrent_corpus_claim: true,
      limitation: "Retained production arrival stream for measurement.",
    },
    promotion: {
      status: "authorized",
      product_promotion_allowed: true,
      gates: {
        ...shadowFixture.promotion.gates,
        recurrent_arrival_corpus: {
          observed_source_observations: 40,
          threshold: "a recurrent retained arrival corpus",
          passed: true,
        },
      },
      reason: "production observations authorized for measurement readback",
    },
    intents: Array.from({ length: 24 }, (_, index) => ({
      intent_id: `intent-${index}`,
      state: "resolved",
      resolution_state: "resolved",
    })),
  };
  const receipt = readProductionShadowObservation(productionLike, {
    source_path: PROCUREMENT_INTENT_PRODUCTION_AGGREGATE_PATH,
    merge_commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    min_resolved: 20,
  });
  assert.equal(receipt.merge_commit, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(receipt.retained_data_present, true);
  assert.equal(receipt.resolved_production_observation_count, 24);
  assert.equal(receipt.product_promotion_allowed, true);
  assert.equal(publicSurfaceAuthorizationAdmitted(receipt.authorization), true);
});

test("reuses watch-continuity evidence states and existing matcher seams without a dashboard route", () => {
  const { process, match } = matchFor(COMPASS, COMPASS_SOLICITATIONS);
  assert.equal(match.realized_by.length, 2);
  const projection = projectMeetingIntentSurface({
    process,
    match,
    observations: COMPASS_SOLICITATIONS,
    authorization: ADMITTED_AUTHORIZATION,
    observation_coverage: COMPLETE_COVERAGE,
    now: "2025-10-02",
  });
  assert.deepEqual(projection.view.evidence.evidence_states, [
    "source_fact",
    "cityscroll_interpretation",
    "later_observation",
  ]);
  assert.equal(projection.view.evidence.cityscroll_interpretation.provisional_subject_ref, process.process_ref);
  assert.equal(process.predictions.occurrence.predicted_event_kind, "procurement.notice_published");
  assert.doesNotMatch(renderMeetingIntentSurfaceHtml(projection), /dashboard|intent radar home|standalone/i);
});
