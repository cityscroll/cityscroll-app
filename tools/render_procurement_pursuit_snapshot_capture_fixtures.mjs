#!/usr/bin/env node
// Renders the real production output for Card 3 (procurement-pursuit-decision)
// pursuit snapshot for a fixed set of named capture cases, and prints
// {label: html} JSON to stdout. Used only by
// tools/capture_procurement_pursuit_snapshot_evidence.py; nothing here is a
// served route or a build artifact, and no production module is changed by
// running it.
//
// The canonical-object cases (complete, sparse, superseded, award control)
// call the real renderProcurementDocument() -- the exact function
// production /procurements/:id pages call. The notice-row cases (partial,
// cancelled) reuse the real buildPursuitSnapshot()/renderPursuitSnapshotHtml()
// composer -- the exact functions site/app/money-history.mjs calls -- inside
// a minimal standalone page shell, since money-history.mjs itself renders
// client-side into a live DOM rather than returning a string.
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { procurementProcessEvents } from "../site/procurement_process_events.mjs";
import { buildPursuitSnapshot, renderPursuitSnapshotHtml } from "../site/procurement_pursuit_snapshot.mjs";
import { recordsFromMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { readFileSync } from "node:fs";

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

function procurementDetailHtml(refs, observations) {
  const object = {
    procurement_id: PROCUREMENT_ID,
    source_observation_refs: refs,
    identity_keys: { epins: ["EPIN-2026-07"] },
  };
  object.process_events = procurementProcessEvents(object, observations);
  return renderProcurementDocument(object, observations, { today: TODAY });
}

// ----- Case: complete (Fixture A, dense exact-join solicitation) -----
function completeHtml() {
  return procurementDetailHtml([RFX_REF, SOLICITATION_REF], [rfxObservation(), cityRecordObservation()]);
}

// ----- Case: sparse (Fixture D, real MTA S48020 native canonical object) -----
function sparseHtml() {
  const fixtures = JSON.parse(readFileSync(
    new URL("../warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json", import.meta.url),
    "utf8",
  ));
  const model = buildSharedProcurementReadModel({
    sourceRecords: recordsFromMtaOpportunityFixtures(fixtures),
    generatedAt: fixtures.retrieved_at,
  });
  const object = model.rows.find((row) => row.procurement_id === "procurement:solicitation:S48020");
  return renderProcurementDocument(object, model.observations, { today: TODAY });
}

// ----- Case: superseded (Fixture A's canonical procurement, a later PASSPort
// round with a later due date -- the snapshot must reflect only the current
// round, never the earlier due date) -----
function supersededHtml() {
  const laterRound = rfxObservation({ due_date: "09/15/2026" });
  return procurementDetailHtml([RFX_REF, SOLICITATION_REF], [laterRound, cityRecordObservation()]);
}

// ----- Case: award control (Fixture E as a canonical object) -- must never
// render a pursuit snapshot -----
function awardControlHtml() {
  const ref = "city_record:20260703001";
  const object = { procurement_id: "procurement:contract:AWD1", source_observation_refs: [ref] };
  const observations = [{
    source_observation_ref: ref,
    source_system: "city_record",
    source_system_id: "20260703001",
    ingested_at: "2026-07-03T10:00:00Z",
    snapshot: {
      request_id: "20260703001",
      short_title: "Playground reconstruction award",
      type_of_notice_description: "Award",
      agency_name: "Department of Parks and Recreation",
      contract_amount: 250000,
      vendor_name: "Acme Builders",
    },
  }];
  return renderProcurementDocument(object, observations, { today: TODAY });
}

// ----- Notice-row cases (money-history.mjs surface): a minimal standalone
// shell around the exact composer output, since money-history.mjs renders
// into a live DOM rather than returning a string. -----
function noticeDetailHtml(row, { title, kicker }) {
  const snapshot = buildPursuitSnapshot(row, {
    cityscroll_url: row.request_id ? `https://cityscroll.org/notices/${row.request_id}` : null,
  });
  const snapshotHtml = renderPursuitSnapshotHtml(snapshot);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · CityScroll</title>
<link rel="stylesheet" href="/brand.css"><link rel="stylesheet" href="/civic-documents.css">
<link rel="stylesheet" href="/procurement_pursuit_snapshot.css">
</head><body><main class="node-document" style="max-width:720px;margin:0 auto;padding:24px">
<header class="node-hero"><p class="ftype">${kicker}</p><h1>${title}</h1></header>
${snapshotHtml || '<p data-no-pursuit-snapshot="1">No pursuit snapshot rendered for this notice type.</p>'}
<section class="node-section"><h2>Paper trail</h2><p>Existing lifecycle and contract facts remain below the snapshot, unchanged by this card.</p></section>
</main></body></html>`;
}

// ----- Case: partial (Fixture B, actionable City Record solicitation) -----
function partialHtml() {
  return noticeDetailHtml({
    short_title: "Computer-Assisted Mass Appraisal (CAMA) Modern Solution",
    type_of_notice_description: "Solicitation",
    agency_name: "Finance",
    due_date: "2026-08-17T14:00:00.000",
    request_id: "REQ-CAMA-1",
  }, { title: "Computer-Assisted Mass Appraisal (CAMA) Modern Solution", kicker: "Solicitation · Finance" });
}

// ----- Case: cancelled (Fixture B's identity, cancelled -- no snapshot) -----
function cancelledHtml() {
  return noticeDetailHtml({
    short_title: "Computer-Assisted Mass Appraisal (CAMA) Modern Solution",
    type_of_notice_description: "Cancellation",
    agency_name: "Finance",
    due_date: "2026-08-17T14:00:00.000",
    request_id: "REQ-CAMA-1",
  }, { title: "Computer-Assisted Mass Appraisal (CAMA) Modern Solution", kicker: "Cancellation · Finance" });
}

const cases = {
  "pursuit-snapshot-complete": completeHtml(),
  "pursuit-snapshot-partial": partialHtml(),
  "pursuit-snapshot-sparse": sparseHtml(),
  "pursuit-snapshot-cancelled": cancelledHtml(),
  "pursuit-snapshot-superseded": supersededHtml(),
  "pursuit-snapshot-award-control": awardControlHtml(),
};

process.stdout.write(JSON.stringify(cases));
