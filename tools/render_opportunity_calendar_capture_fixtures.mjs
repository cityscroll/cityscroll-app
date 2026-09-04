#!/usr/bin/env node
// Renders the real CBICS-07 production output — renderProcurementDocument()
// and renderPropertyCommercialDetail() over the shared opportunity-bundle
// pipeline — for a fixed set of named capture cases, and prints
// {label: html} JSON to stdout. Used only by
// tools/capture_opportunity_calendar_evidence.py; nothing here is a served
// route or a build artifact.
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { procurementProcessEvents } from "../site/procurement_process_events.mjs";
import {
  buildPropertyOpportunityRecord,
  opportunityMonthHTML,
  opportunityOccurrences,
} from "../site/opportunity_calendar.mjs";
import { extractPropertyTimedEvents } from "../site/property_timed_events.mjs";
import { renderPropertyCommercialDetail } from "../site/property_commercial_ui.mjs";

const TODAY = "2026-07-10";

const PROCUREMENT_ID = "procurement:epin-2026-07";
const RFX_REF = "passport_public_rfx:rfx:EPIN-2026-07:1001";
const SOLICITATION_REF = "city_record:20260701001";

function rfxObservation(snapshot = {}) {
  return {
    source_observation_ref: RFX_REF,
    source_system: "passport_public_rfx",
    source_system_id: "rfx:EPIN-2026-07:1001",
    ingested_at: "2026-07-01T10:00:00Z",
    snapshot: {
      rfp_id: "1001",
      epin: "EPIN-2026-07",
      procurement_name: "Playground reconstruction",
      agency: "Department of Parks and Recreation",
      rfx_status: "Released",
      release_date: "07/01/2026",
      due_date: "08/05/2026",
      official_url: "https://passport.example/rfx/1001",
      ...snapshot,
    },
  };
}

function cityRecordObservation(snapshot = {}) {
  return {
    source_observation_ref: SOLICITATION_REF,
    source_system: "city_record",
    source_system_id: "20260701001",
    ingested_at: "2026-07-02T10:00:00Z",
    snapshot: {
      request_id: "20260701001",
      short_title: "Playground reconstruction solicitation",
      type_of_notice_description: "Solicitation Notice",
      additional_description_1: "Pre-bid conference: 07/22/2026 at 10:00 a.m. Questions deadline: 07/29/2026.",
      ...snapshot,
    },
  };
}

function procurementDocumentHTML(refs, observations) {
  const object = { procurement_id: PROCUREMENT_ID, source_observation_refs: refs, identity_keys: { epins: ["EPIN-2026-07"] } };
  object.process_events = procurementProcessEvents(object, observations);
  return renderProcurementDocument(object, observations, { today: TODAY });
}

const PROPERTY_REQUEST_ID = "20260701002";
const DENSE_PROPERTY_BODY = "A public hearing will be held on July 7, 2026 at 11:00 a.m. concerning the sale of "
  + "city-owned real property. Show Dates: July 8, 2026 at 10:00 a.m. and July 10, 2026 at 10:00 a.m. "
  + "Sealed bids will be received no later than July 15, 2026 at 2:00 p.m. "
  + "Individuals requesting sign language interpreters must do so in writing no later than "
  + "five (5) business days prior to the public hearing.";
const SPARSE_PROPERTY_BODY = "Sealed bids will be received no later than July 15, 2026 at 2:00 p.m.";

function propertyDetailHTML(requestId, shortTitle, body, { extraLowConfidence = false } = {}) {
  const row = { request_id: requestId, short_title: shortTitle, additional_description_1: body };
  const events = extractPropertyTimedEvents(row);
  if (extraLowConfidence) {
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
  }
  const record = buildPropertyOpportunityRecord(events, {
    requestId,
    shortTitle,
    noticeBody: body,
    sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${requestId}`,
    canonicalUrl: `https://cityscroll.org/notices/${requestId}`,
  });
  const { occurrences } = opportunityOccurrences([record]);
  const detail = renderPropertyCommercialDetail({
    item: { category: "real_property", label: "City-owned property", confidence: "high", evidence: "notice body", source: "notice_body" },
    timed_events: events,
    participation: { steps: events.map((event) => event.source_span?.text).filter(Boolean).map((text) => ({ kind: "show_or_inspection", text })) },
  }, {
    t: (key) => key,
    escape: (value) => String(value ?? ""),
    fallbackSaleSignals: () => true,
    timedEventsHTML: () => `<div class="property-commercial-timed-events" aria-label="Dated events">${
      events.map((event) => `<time class="tag">${event.kind} · ${String(event.deadline || event.start || "").slice(0, 10)}</time>`).join("")
    }</div>`,
    opportunityMonthHTML: () => opportunityMonthHTML(occurrences, {
      today: TODAY,
      fullListHref: `https://cityscroll.org/notices/${requestId}`,
      fullListLabel: "See all dated events",
    }),
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${shortTitle} · CityScroll</title>
<link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css">
<link rel="stylesheet" href="/property.css"><link rel="stylesheet" href="/compact_calendar.css">
</head><body><main class="node-document" data-civic-object-kind="property" style="max-width:720px;margin:0 auto;padding:24px">
<header class="node-hero"><p class="ftype">Property disposition</p><h1>${shortTitle}</h1></header>
<section aria-labelledby="ncommercial-heading"><h2 id="ncommercial-heading">Commercial details</h2>
<div id="ncommercial">${detail}</div></section>
</main></body></html>`;
}

const cases = {
  "procurement-dense": procurementDocumentHTML([RFX_REF, SOLICITATION_REF], [rfxObservation(), cityRecordObservation()]),
  "procurement-sparse": procurementDocumentHTML([RFX_REF], [rfxObservation()]),
  "procurement-exclusion": procurementDocumentHTML([RFX_REF], [rfxObservation({ due_date: "08/05/2026", derived: true, confidence: 0.3 })]),
  "property-dense": propertyDetailHTML(PROPERTY_REQUEST_ID, "Sale of city-owned property — Bronx", DENSE_PROPERTY_BODY),
  "property-sparse": propertyDetailHTML("20260701099", "Sale of city-owned property — Queens", SPARSE_PROPERTY_BODY),
  "property-exclusion": propertyDetailHTML(PROPERTY_REQUEST_ID, "Sale of city-owned property — Bronx", DENSE_PROPERTY_BODY, { extraLowConfidence: true }),
};

process.stdout.write(JSON.stringify(cases));
