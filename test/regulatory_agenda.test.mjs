import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REGULATORY_AGENDA_ITEM_SCHEMA,
  agendaExtractionChecks,
  agendaSchedulePrecision,
  buildAgencyHorizon,
  buildAgendaRulemakingBridge,
  extractRegulatoryAgendaItems,
  parseRegulatoryAgendaIndex,
} from "../site/regulatory_agenda.mjs";
import { renderRegulatoryAgendaDocument } from "../site/regulatory_agenda_document.mjs";
import pagesEdge, { edgeRequestKind } from "../site/pages_edge.mjs";
import agendaArtifact from "../site/data/regulatory_agenda.json" with { type: "json" };

const INDEX = `<script>var agency_agendas = ${JSON.stringify([{
  submitting_agency: "DOT",
  file_button: '<a href="https://rules.cityofnewyork.us/wp-content/uploads/2026/05/DOT-CAPA-REGULATORY-AGENDA-FY-2027-Final.pdf">DOT - Annual Regulatory Agenda FY2027</a>',
  publish_date: "May 01, 2026",
}])};</script>`;

const PDF_TEXT = `CAPA REGULATORY AGENDA FY 2027
DEPARTMENT OF TRANSPORTATION
1.
SUBJECT: Cyclist Permission to Deviate from Some Traffic Control Devices
A. Anticipated contents: Amend section 4-12(p) allowing cyclists to follow pedestrian control signals.
B. Reason: Enhance safety for cyclists.
C. Objectives: To formalize existing behavior and provide consistency.
D. Legal basis: Section 2903(a) of the New York City Charter.
E. Other relevant laws: Section 19-195.1 of the NYC Administrative Code.
F. Types of individuals and entities likely to be affected: Cyclists, drivers, and the general public.
G. Approximate schedule: Second Quarter of FY 2027.
`;

test("regulatory agenda index materializes agency PDFs as source documents", () => {
  const index = parseRegulatoryAgendaIndex(INDEX, { retrievedAt: "2026-08-28T00:00:00Z" });
  assert.equal(index.document_count, 1);
  assert.equal(index.documents[0].agency, "Transportation");
  assert.equal(index.documents[0].fiscal_year, "FY2027");
  assert.equal(index.documents[0].publisher_document.endsWith("DOT-CAPA-REGULATORY-AGENDA-FY-2027-Final.pdf"), true);
  assert.equal(index.documents[0].retrieval_status, "available");
});

test("agenda PDF fields are source-qualified and explicitly anticipated", () => {
  const index = parseRegulatoryAgendaIndex(INDEX);
  const [item] = extractRegulatoryAgendaItems(PDF_TEXT, index.documents[0]);
  assert.equal(item.schema, REGULATORY_AGENDA_ITEM_SCHEMA);
  assert.equal(item.object_type, "regulatory-agenda-item");
  assert.equal(item.lifecycle_stage, "anticipated");
  assert.equal(item.formal_rulemaking, false);
  assert.equal(item.agency, "Transportation");
  assert.equal(item.fiscal_year, "FY2027");
  assert.match(item.subject, /Cyclist Permission/);
  assert.match(item.anticipated_content, /4-12/);
  assert.match(item.justification, /safety/);
  assert.match(item.legal_basis, /2903/);
  assert.match(item.affected_groups, /Cyclists/);
  assert.match(item.approximate_schedule, /Second Quarter/);
  assert.equal(item.field_availability.subject, "published");
  assert.equal(item.field_availability.publisher_document, "published");
  assert.equal(item.field_availability.publisher_page, "not_yet_acquired");
  assert.match(item.source.document_url, /DOT-CAPA/);
  assert.match(item.canonical_href, /regulatory-agenda-item/);
});

test("agenda extraction checks report per-field availability and retrieval failures", () => {
  const index = parseRegulatoryAgendaIndex(INDEX);
  const items = extractRegulatoryAgendaItems(PDF_TEXT, index.documents[0]);
  const checks = agendaExtractionChecks({ documents: [...index.documents, { retrieval_status: "failed" }], items, index });
  assert.deepEqual(checks.agencies_represented, ["Transportation"]);
  assert.equal(checks.structured_items, 1);
  assert.equal(checks.field_availability.subject.published, 1);
  assert.equal(checks.field_availability.publisher_document.published, 1);
  assert.equal(checks.field_availability.publisher_page.not_yet_acquired, 1);
  assert.equal(checks.schedule_precision.quarter, 1);
  assert.equal(checks.documents.retrieval_failures, 1);
});

test("schedule precision is reported independently from agenda item counts", () => {
  assert.deepEqual(agendaSchedulePrecision([
    { approximate_schedule: "2027-03-04" },
    { approximate_schedule: "Third Quarter of FY 2027" },
    { approximate_schedule: "Spring 2028" },
    { approximate_schedule: "Schedule not stated" },
    { approximate_schedule: "" },
  ]), {
    date: 1,
    month: 0,
    quarter: 1,
    season: 1,
    fiscal_year: 0,
    unspecified: 1,
    not_stated: 1,
  });
});

test("horizon projection remains an anticipated lane with an explicit non-proceeding meaning", () => {
  const index = parseRegulatoryAgendaIndex(INDEX);
  const items = extractRegulatoryAgendaItems(PDF_TEXT, index.documents[0]);
  const horizon = buildAgencyHorizon(items, { agency: "Transportation", now: "2026-08-28" });
  assert.equal(horizon.stage, "anticipated");
  assert.match(horizon.meaning, /not a formal rulemaking proceeding/);
  assert.equal(horizon.agencies[0].items[0].lifecycle_stage, "anticipated");
});

test("topic similarity never publishes an agenda-to-rulemaking edge", () => {
  const index = parseRegulatoryAgendaIndex(INDEX);
  const [item] = extractRegulatoryAgendaItems(PDF_TEXT, index.documents[0]);
  const bridge = buildAgendaRulemakingBridge([item], [{
    rulemaking_id: "rulemaking:dot:bicycle-racks",
    agency: "Transportation",
    title: "Cyclist permission rules",
    notice_date: "2026-08-12",
  }]);
  assert.equal(bridge.links.length, 0);
  assert.equal(bridge.candidates.length, 1);
  assert.equal(bridge.candidates[0].public_edge, false);
  assert.equal(bridge.metrics.unlinked_but_plausible_count, 1);
});

test("agenda items have a canonical document route separate from rulemaking", async () => {
  const item = agendaArtifact.agenda_items[0];

  assert.equal(
    edgeRequestKind(`https://cityscroll.org${item.canonical_href}`),
    "regulatory-agenda-item",
  );
  assert.notEqual(edgeRequestKind("https://cityscroll.org/rules/agenda/not-an-agenda-item/"), "regulatory-agenda-item");
  const html = renderRegulatoryAgendaDocument(item);
  assert.match(html, /data-civic-object-kind="regulatory-agenda-item"/);
  assert.match(html, /Anticipated planning signal/);
  assert.match(html, /Open agenda PDF/);

  const response = await pagesEdge.fetch(new Request(`https://cityscroll.org${item.canonical_href}`), {
    ASSETS: { fetch: async () => new Response("asset") },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /data-agenda-item-id/);
});
