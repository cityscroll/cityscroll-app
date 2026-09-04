#!/usr/bin/env node
// Renders the real production output — renderProcurementDocument() over the
// Card 2 opportunity-window derivation — for a fixed set of named capture
// cases, and prints {label: html} JSON to stdout. Used only by
// tools/capture_procurement_opportunity_window_evidence.py; nothing here is a
// served route or a build artifact, and no production module is changed by
// running it.
//
// Case 1 reuses Fixture A from
// test/fixtures/procurement_pursuit_decision/fixture-ledger.json exactly
// (exact PASSPort release_date -> due_date). Case 2 is Fixture A's
// City-Record-only variant named in the commissioned card (City Record
// publication -> due_date, no exact RFx release). Case 3 is a solicitation
// that carries a PASSPort observation but no due date. Cases 4 and 5 pair a
// published window with the two non-default rule floors from
// solicitation_procurement_method.mjs (§6-129 and accelerated procurement).
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { procurementProcessEvents } from "../site/procurement_process_events.mjs";

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

function detailHtml(refs, observations) {
  const object = {
    procurement_id: PROCUREMENT_ID,
    source_observation_refs: refs,
    identity_keys: { epins: ["EPIN-2026-07"] },
  };
  object.process_events = procurementProcessEvents(object, observations);
  return renderProcurementDocument(object, observations, { today: TODAY });
}

// ----- Case 1: Fixture A — exact PASSPort release -> due (response_window) -----
function responseWindowHtml() {
  return detailHtml([RFX_REF, SOLICITATION_REF], [rfxObservation(), cityRecordObservation()]);
}

// ----- Case 2: Fixture A's City-Record-only variant (notice_to_due_window) -----
function noticeToDueWindowHtml() {
  return detailHtml(
    [SOLICITATION_REF],
    [cityRecordObservation({ start_date: "2026-07-02", due_date: "2026-08-05" })],
  );
}

// ----- Case 3: a PASSPort observation with no due date (Window unavailable) -----
function windowUnavailableHtml() {
  return detailHtml([RFX_REF], [rfxObservation({ due_date: null })]);
}

// ----- Case 4: response window paired with the §6-129 27-day rule floor -----
function section6129FloorHtml() {
  return detailHtml([RFX_REF, SOLICITATION_REF], [
    rfxObservation(),
    cityRecordObservation({
      section_name: "Procurement",
      additional_description_1:
        "Pre-bid conference: 07/22/2026 at 10:00 a.m. Questions deadline: 07/29/2026. "
        + "This procurement is subject to participation goals for M/WBE firms under Admin. Code Section 6-129.",
    }),
  ]);
}

// ----- Case 5: a short response window paired with the accelerated 3-business-day floor -----
function acceleratedFloorHtml() {
  return detailHtml([RFX_REF, SOLICITATION_REF], [
    rfxObservation({ due_date: "07/06/2026" }),
    cityRecordObservation({
      section_name: "Procurement",
      additional_description_1:
        "This solicitation is being conducted pursuant to the Accelerated Procurement Method, "
        + "Section 3-07 of the New York City Procurement Policy Board (PPB) Rules.",
    }),
  ]);
}

const cases = {
  "procurement-detail-response-window": responseWindowHtml(),
  "procurement-detail-notice-to-due-window": noticeToDueWindowHtml(),
  "procurement-detail-window-unavailable": windowUnavailableHtml(),
  "procurement-detail-window-6129-floor": section6129FloorHtml(),
  "procurement-detail-window-accelerated-floor": acceleratedFloorHtml(),
};

process.stdout.write(JSON.stringify(cases));
