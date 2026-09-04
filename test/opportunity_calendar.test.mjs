// CBICS-07 — procurement and property opportunity bundles on the shared
// compact month. This suite pins: the named procurement bundle (conference,
// questions, proposal) and property bundle (multiple showings plus bid
// deadline) rendering the correct month cells; exact source spans and official
// destinations staying reachable per cell; relative-rule-derived and
// low-confidence dates never entering confirmed cells; award, registration,
// conveyance, and payment history staying in the existing spine; sparse
// opportunities keeping their existing dated presentation with no calendar
// chrome; reschedule/cancellation identity; identity/source parity; and
// partial/unavailable degradation.

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCompactMonthView } from "../site/compact_calendar.mjs";
import {
  PROPERTY_OPPORTUNITY_EXCLUSION_REASONS,
  buildPropertyOpportunityRecord,
  opportunityMonthHTML,
  opportunityOccurrences,
  procurementOpportunityOccurrences,
  procurementOpportunityRecords,
} from "../site/opportunity_calendar.mjs";
import { extractPropertyTimedEvents } from "../site/property_timed_events.mjs";
import { renderPropertyCommercialDetail } from "../site/property_commercial_ui.mjs";
import { procurementProcessEvents } from "../site/procurement_process_events.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { procurementOpportunityWindow } from "../site/procurement_opportunity_window.mjs";

const PROCUREMENT_ID = "procurement:epin-2026-07";
const PROCUREMENT_URL = `https://cityscroll.org/procurements/${encodeURIComponent(PROCUREMENT_ID)}`;
const RFX_REF = "passport_public_rfx:rfx:EPIN-2026-07:1001";
const SOLICITATION_REF = "city_record:20260701001";
const SOLICITATION_SOURCE_URL = "https://a856-cityrecord.nyc.gov/RequestDetail/20260701001";
const RFX_SOURCE_URL = "https://passport.example/rfx/1001";
const TODAY = "2026-07-10";

function rfxObservation(snapshot = {}, ingestedAt = "2026-07-01T10:00:00Z") {
  return {
    source_observation_ref: RFX_REF,
    source_system: "passport_public_rfx",
    source_system_id: "rfx:EPIN-2026-07:1001",
    ingested_at: ingestedAt,
    snapshot: {
      rfp_id: "1001",
      epin: "EPIN-2026-07",
      procurement_name: "Playground reconstruction",
      agency: "Department of Parks and Recreation",
      rfx_status: "Released",
      release_date: "07/01/2026",
      due_date: "08/05/2026",
      official_url: RFX_SOURCE_URL,
      ...snapshot,
    },
  };
}

function cityRecordObservation(snapshot = {}, {
  ref = SOLICITATION_REF,
  ingestedAt = "2026-07-02T10:00:00Z",
} = {}) {
  return {
    source_observation_ref: ref,
    source_system: "city_record",
    source_system_id: ref.split(":")[1],
    ingested_at: ingestedAt,
    snapshot: {
      request_id: ref.split(":")[1],
      short_title: "Playground reconstruction solicitation",
      type_of_notice_description: "Solicitation Notice",
      additional_description_1: "Pre-bid conference: 07/22/2026 at 10:00 a.m. Questions deadline: 07/29/2026.",
      ...snapshot,
    },
  };
}

function procurementObject(refs = [RFX_REF, SOLICITATION_REF]) {
  return { procurement_id: PROCUREMENT_ID, source_observation_refs: refs };
}

function denseProcurementObservations() {
  return [rfxObservation(), cityRecordObservation()];
}

const PROPERTY_REQUEST_ID = "20260701002";
const PROPERTY_NOTICE_BODY = "A public hearing will be held on July 7, 2026 at 11:00 a.m. concerning the sale of "
  + "city-owned real property. Show Dates: July 8, 2026 at 10:00 a.m. and July 10, 2026 at 10:00 a.m. "
  + "Sealed bids will be received no later than July 15, 2026 at 2:00 p.m. "
  + "Individuals requesting sign language interpreters must do so in writing no later than "
  + "five (5) business days prior to the public hearing.";

function propertyNoticeRow(overrides = {}) {
  return {
    request_id: PROPERTY_REQUEST_ID,
    short_title: "Sale of city-owned property — Bronx",
    additional_description_1: PROPERTY_NOTICE_BODY,
    ...overrides,
  };
}

function propertyBundle(row = propertyNoticeRow(), options = {}) {
  const record = buildPropertyOpportunityRecord(extractPropertyTimedEvents(row), {
    requestId: row.request_id,
    shortTitle: row.short_title,
    noticeBody: row.additional_description_1,
    sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${row.request_id}`,
    canonicalUrl: `https://cityscroll.org/notices/${row.request_id}`,
    ...options,
  });
  return { record, bundle: opportunityOccurrences([record]) };
}

function daysOf(view) {
  return new Map(view.weeks.flat().map((day) => [day.date, day]));
}

/* ===== A1: the procurement opportunity bundle ===== */

test("A1: conference, questions, and proposal dates form the correct procurement bundle", () => {
  const { occurrences } = procurementOpportunityOccurrences(procurementObject(), denseProcurementObservations());
  assert.equal(occurrences.length, 3);

  const view = buildCompactMonthView(occurrences, { today: TODAY });
  assert.equal(view.render, true);
  assert.equal(view.month, "2026-07");

  const byDay = daysOf(view);
  const conference = byDay.get("2026-07-22");
  const questions = byDay.get("2026-07-29");
  const proposals = byDay.get("2026-08-05");
  assert.equal(conference.occurrence_count, 1);
  assert.equal(conference.visible_occurrences[0].kind, "milestone");
  assert.match(conference.visible_occurrences[0].title, /Pre-bid conference/);
  assert.equal(questions.occurrence_count, 1);
  assert.equal(questions.visible_occurrences[0].kind, "deadline");
  assert.match(questions.visible_occurrences[0].title, /Questions due/);
  assert.equal(proposals.occurrence_count, 1);
  assert.equal(proposals.visible_occurrences[0].kind, "deadline");
  assert.match(proposals.visible_occurrences[0].title, /Bids due/);
  // The August proposal deadline rides the same six-week grid as spillover.
  assert.equal(view.crosses_month_boundary, true);
  assert.ok(daysOf(view).has("2026-08-05"));
});

test("A1: a conference-plus-questions-only procurement is still the right bundle, never padded", () => {
  const object = procurementObject([SOLICITATION_REF]);
  const { occurrences } = procurementOpportunityOccurrences(object, [cityRecordObservation()]);
  assert.equal(occurrences.length, 2);
  const view = buildCompactMonthView(occurrences, { today: TODAY });
  assert.equal(view.render, false);
  assert.equal(view.reason, "sparse-too-few-occurrences");
});

/* ===== A2: the property opportunity bundle ===== */

test("A2: multiple showings plus a bid deadline form the correct property bundle", () => {
  const { bundle } = propertyBundle();
  assert.equal(bundle.occurrences.length, 4);

  const view = buildCompactMonthView(bundle.occurrences, { today: TODAY });
  assert.equal(view.render, true);
  assert.equal(view.month, "2026-07");

  const byDay = daysOf(view);
  assert.equal(byDay.get("2026-07-07").occurrence_count, 1);
  assert.equal(byDay.get("2026-07-07").visible_occurrences[0].title, "Public hearing");
  assert.equal(byDay.get("2026-07-08").occurrence_count, 1);
  assert.equal(byDay.get("2026-07-08").visible_occurrences[0].title, "Property showing");
  assert.equal(byDay.get("2026-07-10").occurrence_count, 1);
  assert.equal(byDay.get("2026-07-10").visible_occurrences[0].title, "Property showing");
  assert.equal(byDay.get("2026-07-15").occurrence_count, 1);
  assert.equal(byDay.get("2026-07-15").visible_occurrences[0].kind, "deadline");
  assert.equal(byDay.get("2026-07-15").visible_occurrences[0].title, "Bids due");
});

test("A2: an online auction window renders open and close boundary cells without a duplicate deadline", () => {
  const row = propertyNoticeRow({
    request_id: "20260701003",
    short_title: "Online public lease auction",
    additional_description_1: "Online bids will be accepted from July 1, 2026 until July 15, 2026. "
      + "Show Dates: July 8, 2026 at 10:00 a.m. and July 10, 2026 at 10:00 a.m.",
  });
  const { record, bundle } = propertyBundle(row);
  assert.deepEqual(
    bundle.occurrences.map((occurrence) => [occurrence.kind, occurrence.title, occurrence.date || occurrence.starts_at]),
    [
      ["window_open", "Online bidding opens", "2026-07-01"],
      ["window_close", "Online bidding closes", "2026-07-15"],
      ["event", "Property showing", "2026-07-08T10:00:00-04:00"],
      ["event", "Property showing", "2026-07-10T10:00:00-04:00"],
    ],
  );
  const twin = record.excluded_timed_events.find((entry) => entry.reason === "duplicate-of-window-close");
  assert.equal(twin.kind, "bid_deadline");
  assert.equal(twin.day, "2026-07-15");
});

/* ===== A3: source spans and official destinations stay reachable ===== */

test("A3: every cell reaches the canonical record and its official source destination", () => {
  const proc = procurementOpportunityOccurrences(procurementObject(), denseProcurementObservations());
  for (const occurrence of proc.occurrences) {
    assert.equal(occurrence.canonical_url, PROCUREMENT_URL);
    assert.ok([RFX_SOURCE_URL, SOLICITATION_SOURCE_URL].includes(occurrence.source.url));
  }
  const html = opportunityMonthHTML(proc.occurrences, { today: TODAY });
  assert.match(html, new RegExp(`href="${PROCUREMENT_URL}"`));
  assert.match(html, new RegExp(`href="${RFX_SOURCE_URL.replace(/\//g, "\\/")}"`));
  assert.match(html, new RegExp(`href="${SOLICITATION_SOURCE_URL.replace(/\//g, "\\/")}"`));

  const { bundle } = propertyBundle();
  const propertyHtml = opportunityMonthHTML(bundle.occurrences, { today: TODAY });
  for (const occurrence of bundle.occurrences) {
    assert.equal(occurrence.canonical_url, `https://cityscroll.org/notices/${PROPERTY_REQUEST_ID}`);
    assert.equal(occurrence.source.url, `https://a856-cityrecord.nyc.gov/RequestDetail/${PROPERTY_REQUEST_ID}`);
  }
  assert.match(propertyHtml, /href="https:\/\/cityscroll\.org\/notices\/20260701002"/);
  assert.match(propertyHtml, /href="https:\/\/a856-cityrecord\.nyc\.gov\/RequestDetail\/20260701002"/);
});

test("A3: property timed events keep their exact source spans beside the calendar", () => {
  const events = extractPropertyTimedEvents(propertyNoticeRow());
  const showing = events.find((event) => event.kind === "inspection_showing" && String(event.start).startsWith("2026-07-08"));
  assert.ok(showing, "the July 8 showing is extracted");
  assert.equal(showing.source_field, "additional_description_1");
  assert.equal(typeof showing.source_span.start, "number");
  assert.equal(typeof showing.source_span.end, "number");
  assert.match(showing.source_span.text, /Show Dates/i);
  // The span text remains quoted inside the rendered dated-event detail.
  const detail = renderPropertyCommercialDetail({
    item: { category: "real_property", label: "City-owned property", confidence: "high", evidence: "notice body", source: "notice_body" },
    timed_events: events,
    event_views: [],
    participation: { steps: [{ kind: "show_or_inspection", text: showing.source_span.text }] },
  }, {
    t: (key) => key,
    escape: (value) => String(value),
    fallbackSaleSignals: () => true,
    timedEventsHTML: () => '<div class="property-commercial-timed-events" aria-label="Dated events"><time class="tag">Bids due · 2026-07-15</time></div>',
    opportunityMonthHTML: () => '<div class="compact-month">month</div>',
  });
  const monthAt = detail.indexOf("property-commercial-opportunity-month");
  const datedAt = detail.indexOf("property-commercial-timed-events");
  assert.ok(monthAt >= 0 && datedAt >= 0 && monthAt < datedAt, "the month sits immediately before the dated events");
  assert.match(detail, /Show Dates/i);
});

/* ===== A4: derived and low-confidence dates never enter confirmed cells ===== */

test("A4: a relative-rule-derived accommodation deadline is excluded from confirmed cells", () => {
  const { record, bundle } = propertyBundle();
  const excluded = record.excluded_timed_events.find((entry) => entry.reason === "relative-rule-derived-date");
  assert.equal(excluded.kind, "accommodation_deadline");
  assert.equal(excluded.day, "2026-06-30");

  const view = buildCompactMonthView(bundle.occurrences, { today: TODAY });
  assert.equal(view.render, true);
  const occurrenceDays = view.weeks.flat().filter((day) => day.occurrence_count > 0).map((day) => day.date);
  assert.ok(!occurrenceDays.includes("2026-06-30"));
  assert.ok(!view.weeks.flat().some((day) =>
    day.date === "2026-06-30" && day.visible_occurrences.some((occurrence) => /Accommodation/i.test(occurrence.title))));
  // The derived deadline survives in the typed events (existing chips stay).
  const events = extractPropertyTimedEvents(propertyNoticeRow());
  assert.ok(events.some((event) => event.kind === "accommodation_deadline" && event.date_source === "derived_from_relative_rule"));
});

test("A4: a low-confidence property date is excluded with a closed-vocabulary reason", () => {
  const events = extractPropertyTimedEvents(propertyNoticeRow());
  events.push({
    schema: "cityscroll.property_timed_event.v1",
    kind: "bid_deadline",
    start: null,
    end: null,
    deadline: "2026-07-20",
    source_field: "additional_description_1",
    source_span: { start: 400, end: 420, text: "deposits due July 20, 2026" },
    confidence: "low",
    date_source: "literal",
  });
  const { record, bundle } = propertyBundle();
  void record;
  const lowRecord = buildPropertyOpportunityRecord(events, { requestId: PROPERTY_REQUEST_ID });
  const lowBundle = opportunityOccurrences([lowRecord]);
  assert.ok(!lowBundle.occurrences.some((occurrence) => occurrence.date === "2026-07-20"));
  const reason = lowRecord.excluded_timed_events.find((entry) => entry.reason === "low-confidence-date");
  assert.equal(reason.kind, "bid_deadline");
  assert.ok(PROPERTY_OPPORTUNITY_EXCLUSION_REASONS.includes("low-confidence-date"));
  void bundle;
});

test("A4: a low-confidence derived procurement deadline is excluded at the shared boundary", () => {
  const object = procurementObject([RFX_REF]);
  const observations = [rfxObservation({ due_date: "08/05/2026", derived: true, confidence: 0.3 })];
  const { occurrences, excluded } = procurementOpportunityOccurrences(object, observations);
  assert.equal(occurrences.length, 0);
  assert.equal(excluded[0].reason, "low-confidence-derived-deadline");
});

/* ===== A5: lifecycle history stays in the spine ===== */

test("A5: award, registration, and payment sources never produce opportunity occurrences", () => {
  const awardRef = "city_record:20261121001";
  const paymentRef = "checkbook_spending:pay:1";
  const contractRef = "passport_public_contracts:contract:EPIN-2026-07:CTR-1";
  const object = procurementObject([RFX_REF, awardRef, paymentRef, contractRef]);
  const observations = [
    rfxObservation(),
    {
      source_observation_ref: awardRef,
      source_system: "city_record",
      source_system_id: "20261121001",
      ingested_at: "2026-11-22T10:00:00Z",
      snapshot: {
        request_id: "20261121001",
        short_title: "Playground reconstruction award",
        type_of_notice_description: "Award",
        start_date: "2026-11-21",
      },
    },
    {
      source_observation_ref: paymentRef,
      source_system: "checkbook_spending",
      source_system_id: "pay:1",
      ingested_at: "2026-12-21T10:00:00Z",
      snapshot: { document_id: "CHK-1", check_amount: "$12,000.00", issue_date: "2026-12-20" },
    },
    {
      source_observation_ref: contractRef,
      source_system: "passport_public_contracts",
      source_system_id: "contract:EPIN-2026-07:CTR-1",
      ingested_at: "2026-12-05T10:00:00Z",
      snapshot: { ctr_id: "CTR-1", status: "Registered", registration_date: "2026-12-04" },
    },
  ];
  const { occurrences } = procurementOpportunityOccurrences(object, observations);
  // Only the RFx proposal deadline is an opportunity date.
  assert.deepEqual(occurrences.map((occurrence) => occurrence.date), ["2026-08-05"]);
  const days = occurrences.map((occurrence) => occurrence.date);
  assert.ok(!days.includes("2026-11-21"));
  assert.ok(!days.includes("2026-12-04"));
  assert.ok(!days.includes("2026-12-20"));
});

test("A5: a property result award stays out of the bundle", () => {
  const events = extractPropertyTimedEvents(propertyNoticeRow());
  events.push({
    schema: "cityscroll.property_timed_event.v1",
    kind: "result_award",
    start: null,
    end: null,
    deadline: "2026-07-28",
    source_field: "additional_description_1",
    source_span: { start: 430, end: 470, text: "apparent highest bidders will be identified by July 28, 2026" },
    confidence: "high",
    date_source: "literal",
  });
  const record = buildPropertyOpportunityRecord(events, { requestId: PROPERTY_REQUEST_ID });
  const bundle = opportunityOccurrences([record]);
  assert.ok(!bundle.occurrences.some((occurrence) => occurrence.date === "2026-07-28"));
  const excluded = record.excluded_timed_events.find((entry) => entry.reason === "lifecycle-result-award");
  assert.equal(excluded.kind, "result_award");
});

test("A5: a dense opportunity bundle never stretches across a multi-year lifecycle", () => {
  const { occurrences } = procurementOpportunityOccurrences(procurementObject(), denseProcurementObservations());
  const view = buildCompactMonthView(occurrences, { today: "2024-01-01" });
  assert.equal(view.render, true);
  assert.equal(view.month, "2026-07");
  assert.equal(view.grid_to.slice(0, 4), "2026");
});

/* ===== A6: sparse opportunities keep the existing presentation ===== */

test("A6: a sparse procurement renders no calendar chrome and keeps its observed events", () => {
  const object = procurementObject([RFX_REF]);
  const observations = [rfxObservation()];
  object.process_events = procurementProcessEvents(object, observations);
  const { occurrences } = procurementOpportunityOccurrences(object, observations);
  assert.equal(occurrences.length, 1);
  assert.equal(opportunityMonthHTML(occurrences, { today: TODAY }), "");

  const html = renderProcurementDocument(object, observations, { today: TODAY });
  assert.ok(html);
  assert.doesNotMatch(html, /procurement-opportunity-calendar/);
  assert.doesNotMatch(html, /compact-calendar\.css|compact_calendar\.css/);
  assert.match(html, /Observed events/);
});

test("A6: a sparse property notice keeps its dated-event chips without a month", () => {
  const row = propertyNoticeRow({
    additional_description_1: "Sealed bids will be received no later than July 15, 2026 at 2:00 p.m.",
  });
  const { bundle } = propertyBundle(row);
  assert.equal(bundle.occurrences.length, 1);
  assert.equal(opportunityMonthHTML(bundle.occurrences, { today: TODAY }), "");
  const detail = renderPropertyCommercialDetail({
    item: { category: "real_property", confidence: "high", evidence: "notice body", source: "notice_body" },
    timed_events: extractPropertyTimedEvents(row),
  }, {
    t: (key) => key,
    escape: (value) => String(value),
    fallbackSaleSignals: () => true,
    timedEventsHTML: () => '<div class="property-commercial-timed-events" aria-label="Dated events"></div>',
    opportunityMonthHTML: (commercial) => opportunityMonthHTML(
      opportunityOccurrences([buildPropertyOpportunityRecord(commercial.timed_events || [], { requestId: row.request_id })]).occurrences,
      { today: TODAY },
    ),
  });
  assert.doesNotMatch(detail, /property-commercial-opportunity-month/);
  assert.match(detail, /property-commercial-timed-events/);
});

/* ===== reschedule and cancellation identity ===== */

test("a rescheduled conference collapses onto one identity with the newest source state", () => {
  const amendedRef = "city_record:20260709001";
  const object = procurementObject([SOLICITATION_REF, amendedRef, RFX_REF]);
  const observations = [
    rfxObservation(),
    cityRecordObservation(),
    cityRecordObservation({
      pre_bid_conference_date: "07/29/2026",
      additional_description_1: "Questions deadline: 08/03/2026.",
    }, { ref: amendedRef, ingestedAt: "2026-07-09T10:00:00Z" }),
  ];
  const { occurrences } = procurementOpportunityOccurrences(object, observations);
  const conferences = occurrences.filter((occurrence) => occurrence.uid.endsWith(":pre_bid_conference"));
  assert.equal(conferences.length, 1);
  assert.equal(conferences[0].date, "2026-07-29");

  const view = buildCompactMonthView(occurrences, { today: TODAY });
  assert.equal(view.render, true);
  // The superseded July 22 conference date is gone; only the amended identity remains.
  assert.ok(!view.occurrence_days.includes("2026-07-22"));
  assert.ok(view.occurrence_days.includes("2026-07-29"));
  assert.equal(daysOf(view).get("2026-07-29").occurrence_count, 1);
});

test("a cancelled solicitation renders explicit cancelled cells, never silent removal", () => {
  const object = procurementObject([SOLICITATION_REF]);
  const observations = [cityRecordObservation({
    short_title: "Cancelled — Playground reconstruction solicitation",
    type_of_notice_description: "Cancelled Solicitation Notice",
    pre_bid_conference_date: "07/22/2026",
    questions_due_date: "07/29/2026",
    bid_deadline: "08/05/2026",
    additional_description_1: "",
  })];
  const { occurrences } = procurementOpportunityOccurrences(object, observations);
  assert.equal(occurrences.length, 3);
  assert.ok(occurrences.every((occurrence) => occurrence.lifecycle === "cancelled"));
  const html = opportunityMonthHTML(occurrences, { today: TODAY });
  assert.match(html, /compact-month-occ-flag-cancelled/);
  assert.match(html, /Cancelled/);
});

test("a cancelled property notice keeps its hearing date flagged, not erased", () => {
  const row = propertyNoticeRow({
    short_title: "Cancelled sale of city-owned property — Bronx",
  });
  const { bundle } = propertyBundle(row);
  assert.ok(bundle.occurrences.length >= 3);
  assert.ok(bundle.occurrences.every((occurrence) => occurrence.lifecycle === "cancelled"));
  const html = opportunityMonthHTML(bundle.occurrences, { today: TODAY });
  assert.match(html, /compact-month-occ-flag-cancelled/);
});

/* ===== identity and source parity ===== */

test("occurrences carry the owning record identity and never a foreign destination", () => {
  const proc = procurementOpportunityOccurrences(procurementObject(), denseProcurementObservations());
  for (const occurrence of proc.occurrences) {
    assert.equal(occurrence.object_ref, PROCUREMENT_ID);
    assert.ok(occurrence.uid.startsWith(`${PROCUREMENT_ID}:`));
  }
  const { bundle } = propertyBundle();
  for (const occurrence of bundle.occurrences) {
    assert.equal(occurrence.object_ref, `notice:${PROPERTY_REQUEST_ID}`);
    assert.ok(occurrence.uid.startsWith(`notice:${PROPERTY_REQUEST_ID}:`));
  }
});

test("out-of-scope observations and payment systems produce no opportunity records", () => {
  const paymentRef = "checkbook_spending:pay:9";
  const object = procurementObject([paymentRef, "unknown_system:x"]);
  const records = procurementOpportunityRecords(object, [
    { source_observation_ref: paymentRef, source_system: "checkbook_spending", snapshot: { issue_date: "2026-07-01" } },
    { source_observation_ref: "unknown_system:x", source_system: "unknown_system", snapshot: { due_date: "2026-07-01" } },
  ]);
  assert.equal(records.length, 0);
});

/* ===== partial and unavailable degradation ===== */

test("an RFx with no publisher due date degrades to sparse, not an invented deadline", () => {
  const object = procurementObject([RFX_REF]);
  const { occurrences } = procurementOpportunityOccurrences(object, [rfxObservation({ due_date: null })]);
  assert.equal(occurrences.length, 0);
  assert.equal(opportunityMonthHTML(occurrences, { today: TODAY }), "");
});

test("an object with no observation refs is unavailable, not empty-chrome", () => {
  const { occurrences } = procurementOpportunityOccurrences({ procurement_id: PROCUREMENT_ID }, []);
  assert.equal(occurrences.length, 0);
  assert.equal(opportunityMonthHTML(occurrences, { today: TODAY }), "");
});

test("undated property events never become occurrences", () => {
  const record = buildPropertyOpportunityRecord([
    { kind: "bid_deadline", start: null, end: null, deadline: null, source_span: { start: 0, end: 1, text: "x" }, confidence: "high", date_source: "literal" },
  ], { requestId: PROPERTY_REQUEST_ID });
  assert.equal(opportunityOccurrences([record]).occurrences.length, 0);
});

test("a property record without a request id refuses to build", () => {
  assert.equal(buildPropertyOpportunityRecord([], { requestId: "" }), null);
});

/* ===== document-level regressions ===== */

test("the procurement document mounts one opportunity month before Observed events", () => {
  const object = procurementObject();
  object.identity_keys = { epins: ["EPIN-2026-07"] };
  const observations = denseProcurementObservations();
  object.process_events = procurementProcessEvents(object, observations);
  const html = renderProcurementDocument(object, observations, { today: TODAY });
  assert.match(html, /id="procurement-opportunity-month"/);
  assert.match(html, /Opportunity dates/);
  assert.match(html, /compact-month-grid/);
  assert.match(html, /compact_calendar\.css/);
  const monthAt = html.indexOf('id="procurement-opportunity-month"');
  const eventsAt = html.indexOf('id="procurement-process"');
  assert.ok(monthAt >= 0 && eventsAt >= 0 && monthAt < eventsAt);
  // The lifecycle sections and official records survive beside the calendar.
  assert.match(html, /Observed events/);
  assert.match(html, /procurement-process-events/);
});

test("without an explicit today the procurement document renders no calendar", () => {
  const object = procurementObject();
  const observations = denseProcurementObservations();
  object.process_events = procurementProcessEvents(object, observations);
  const html = renderProcurementDocument(object, observations);
  assert.ok(html);
  assert.doesNotMatch(html, /procurement-opportunity-calendar/);
  assert.match(html, /Observed events/);
});

test("an ambiguous publisher date is withheld rather than guessed", () => {
  const object = procurementObject([RFX_REF]);
  const { occurrences } = procurementOpportunityOccurrences(object, [rfxObservation({ due_date: "Re-opened" })]);
  assert.equal(occurrences.length, 0);
});

test("publication-only notice timestamps never become opportunity occurrences", () => {
  const object = procurementObject([SOLICITATION_REF]);
  const observations = [cityRecordObservation({ additional_description_1: "Notice published in the City Record." })];
  const { occurrences } = procurementOpportunityOccurrences(object, observations);
  assert.equal(occurrences.length, 0);
});

/* ===== Card 2: procurement_opportunity_window.mjs shares this fixture and never
 * duplicates this module's date handling or crowds out its occurrences. ===== */

test("Card 2: the opportunity window and the opportunity-calendar bundle agree on Fixture A from the same object/observations", () => {
  const object = procurementObject();
  const observations = denseProcurementObservations();
  const window = procurementOpportunityWindow(object, observations);
  assert.equal(window.available, true);
  assert.equal(window.kind, "response_window");
  assert.equal(window.start_date, "2026-07-01");
  assert.equal(window.due_date, "2026-08-05");
  assert.equal(window.days, 35);

  // The same object/observations still produce the exact July 22 conference,
  // July 29 questions, and August 5 proposal-deadline calendar cells.
  const { occurrences } = procurementOpportunityOccurrences(object, observations);
  const view = buildCompactMonthView(occurrences, { today: TODAY });
  const byDay = daysOf(view);
  assert.ok(byDay.has("2026-07-22"));
  assert.ok(byDay.has("2026-07-29"));
  assert.ok(byDay.has("2026-08-05"));
});

test("Card 2: a City-Record-only object still keeps its calendar occurrences while the window becomes notice_to_due_window", () => {
  const object = procurementObject([SOLICITATION_REF]);
  const observations = [cityRecordObservation({ start_date: "2026-07-02", due_date: "2026-08-05" })];
  const window = procurementOpportunityWindow(object, observations);
  assert.equal(window.kind, "notice_to_due_window");
  assert.equal(window.days, 34);

  const { occurrences } = procurementOpportunityOccurrences(object, observations);
  const view = buildCompactMonthView(occurrences, { today: TODAY });
  const byDay = daysOf(view);
  assert.ok(byDay.has("2026-07-22"));
  assert.ok(byDay.has("2026-07-29"));
});

test("Card 2: the procurement document renders the Opportunity window section ahead of Opportunity dates", () => {
  const object = procurementObject();
  object.identity_keys = { epins: ["EPIN-2026-07"] };
  const observations = denseProcurementObservations();
  object.process_events = procurementProcessEvents(object, observations);
  const html = renderProcurementDocument(object, observations, { today: TODAY });
  assert.match(html, /id="procurement-opportunity-window"/);
  assert.match(html, /Published response window: 35 calendar days/);
  const windowAt = html.indexOf('id="procurement-opportunity-window"');
  const monthAt = html.indexOf('id="procurement-opportunity-month"');
  assert.ok(windowAt >= 0 && monthAt >= 0 && windowAt < monthAt);
});

test("Card 2: a solicitation with an incomplete boundary shows Window unavailable explicitly rather than vanishing", () => {
  const object = procurementObject([RFX_REF]);
  const observations = [rfxObservation({ due_date: null })];
  const html = renderProcurementDocument(object, observations, { today: TODAY });
  assert.match(html, /id="procurement-opportunity-window"/);
  assert.match(html, /Window unavailable/);
});

test("Card 2: an object with no PASSPort RFx or City Record observation at all renders no Opportunity window section", () => {
  const object = { procurement_id: "procurement:award-example", source_observation_refs: ["checkbook_contracts:c1"] };
  const observations = [{
    source_observation_ref: "checkbook_contracts:c1",
    source_system: "checkbook_contracts",
    snapshot: { contract_amount: 250000, vendor_name: "Acme Snow & Ice LLC", short_title: "Fixture award" },
  }];
  const html = renderProcurementDocument(object, observations, { today: TODAY });
  assert.doesNotMatch(html, /id="procurement-opportunity-window"/);
});
