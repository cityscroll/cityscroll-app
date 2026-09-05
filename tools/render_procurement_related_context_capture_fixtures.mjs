#!/usr/bin/env node
// Renders the real production output for Card 4 (procurement-pursuit-decision)
// related context and benchmarks for a fixed set of named capture cases, and
// prints {label: html} JSON to stdout. Used only by
// tools/capture_procurement_related_context_evidence.py; nothing here is a
// served route or a build artifact, and no production module is changed by
// running it.
//
// Every case calls the real renderProcurementDocument() -- the exact function
// production /procurements/:id pages call -- reusing the same base
// solicitation fixture (Fixture A, Parks Playground reconstruction) PPD-03's
// own capture fixtures render, extended with opts.relatedContextCandidates /
// opts.relatedContextPopulationAmounts.
import { renderProcurementDocument } from "../site/procurement_document.mjs";

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
      additional_description_1: "Pre-bid conference: 07/22/2026 at 10:00 a.m. Questions deadline: 07/29/2026.",
      ...snapshot,
    },
  };
}

function population(size, { below = 0 } = {}) {
  const above = size - below;
  const amounts = [];
  for (let i = 0; i < above; i += 1) amounts.push(600000 + i);
  for (let i = 0; i < below; i += 1) amounts.push(400000 + i);
  return amounts;
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

const EXACT_PREDECESSOR_CANDIDATE = {
  id: "20220701001",
  epin: "EPIN-2026-07",
  short_title: "Playground reconstruction award",
  vendor_name: "Acme Builders",
  amount: 480000,
  award_date: "2022-05-01",
  href: "/procurements/procurement:epin:EPIN-2022-05",
};

const RESEMBLANCE_CANDIDATE = {
  id: "20230601001",
  agency_name: "Department of Parks and Recreation",
  short_title: "Playground reconstruction citywide phase one",
  vendor_name: "Beta Contracting",
  amount: 510000,
  award_date: "2023-06-01",
  href: "/procurements/procurement:contract:CT-BETA-1",
};

// ----- Case: both groups + a large-cohort percentile benchmark -----
function bothGroupsHtml() {
  return procurementDetailHtml({
    relatedContextCandidates: [EXACT_PREDECESSOR_CANDIDATE, RESEMBLANCE_CANDIDATE],
    relatedContextPopulationAmounts: population(39),
  });
}

// ----- Case: exact chain only, benchmark below the rank floor (omitted) -----
function exactOnlyHtml() {
  return procurementDetailHtml({
    relatedContextCandidates: [EXACT_PREDECESSOR_CANDIDATE],
    relatedContextPopulationAmounts: population(3),
  });
}

// ----- Case: related (resemblance) only, no exact chain -----
function relatedOnlyHtml() {
  return procurementDetailHtml({
    relatedContextCandidates: [RESEMBLANCE_CANDIDATE],
  });
}

// ----- Case: medium cohort -- rank shown, percentile withheld -----
function rankOnlyBenchmarkHtml() {
  return procurementDetailHtml({
    relatedContextCandidates: [EXACT_PREDECESSOR_CANDIDATE],
    relatedContextPopulationAmounts: population(38),
  });
}

// ----- Case: no candidates supplied -- no related-context section renders -----
function noneHtml() {
  return procurementDetailHtml({});
}

const cases = {
  "related-context-both-groups": bothGroupsHtml(),
  "related-context-exact-only": exactOnlyHtml(),
  "related-context-related-only": relatedOnlyHtml(),
  "related-context-rank-only-benchmark": rankOnlyBenchmarkHtml(),
  "related-context-none": noneHtml(),
};

process.stdout.write(JSON.stringify(cases));
