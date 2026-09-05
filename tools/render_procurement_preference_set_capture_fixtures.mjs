#!/usr/bin/env node
// Renders the real production output for card "PPD-05"
// (procurement-pursuit-decision) "matches your stated preferences" list for a
// fixed set of named capture cases, and prints {label: html} JSON to stdout.
// Used only by tools/capture_procurement_preference_set_evidence.py; nothing
// here is a served route or a build artifact, and no production module is
// changed by running it.
//
// Every case calls the real renderProcurementDocument() -- the exact function
// production /procurements/:id pages call -- reusing the same base
// solicitation fixture (Fixture A, Parks Playground reconstruction) the
// pursuit-snapshot and related-context capture fixtures already render,
// extended with a caller-supplied `preferenceMatch` (the real
// site/procurement_preference_set.mjs explainMatch() output).
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import { normalizePreferenceSet, explainMatch } from "../site/procurement_preference_set.mjs";

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
      agency_name: "Department of Parks and Recreation",
      contract_amount: 500000,
      category_description: "Construction/Construction Services",
      selection_method_description: "Competitive Sealed Bidding",
      additional_description_1: "Pre-bid conference: 07/22/2026 at 10:00 a.m. Questions deadline: 07/29/2026.",
      ...snapshot,
    },
  };
}

function procurementDetailHtml(opts = {}) {
  const object = {
    procurement_id: PROCUREMENT_ID,
    source_observation_refs: [RFX_REF, SOLICITATION_REF],
    identity_keys: { epins: ["EPIN-2026-07"] },
  };
  const observations = [rfxObservation(), cityRecordObservation()];
  return renderProcurementDocument(object, observations, { today: TODAY, ...opts });
}

// The record the vendor's own preference set is explained against. Mirrors
// exactly the published facts the two observations above resolve to on
// procurement detail -- this tool never invents a fact the page itself would
// not already show.
const EXPLAIN_RECORD = {
  agency_name: "Department of Parks and Recreation",
  category_description: "Construction/Construction Services",
  short_title: "Playground reconstruction solicitation",
  additional_description_1: "Rebuild playground equipment and surfacing citywide.",
  contract_amount: 500000,
  selection_method_description: "Competitive Sealed Bidding",
  due_date: "2026-08-05",
};

// ----- Case: a preference set with satisfied reasons renders the list -----
function preferenceMatchedHtml() {
  const preferences = normalizePreferenceSet({
    agencies: ["Department of Parks and Recreation"],
    capabilityKeywords: ["playground"],
    minAmount: 100000,
    maxAmount: 900000,
  });
  const preferenceMatch = explainMatch({ record: EXPLAIN_RECORD, preferences });
  return procurementDetailHtml({ preferenceMatch });
}

// ----- Case: a stated preference this record does not satisfy renders nothing -----
function preferenceUnsatisfiedHtml() {
  const preferences = normalizePreferenceSet({ agencies: ["Department of Transportation"] });
  const preferenceMatch = explainMatch({ record: EXPLAIN_RECORD, preferences });
  return procurementDetailHtml({ preferenceMatch });
}

// ----- Case: no preference set supplied -- no section renders -----
function preferenceNoneHtml() {
  return procurementDetailHtml({});
}

const cases = {
  "preference-match-satisfied": preferenceMatchedHtml(),
  "preference-match-unsatisfied": preferenceUnsatisfiedHtml(),
  "preference-match-none": preferenceNoneHtml(),
};

process.stdout.write(JSON.stringify(cases));
