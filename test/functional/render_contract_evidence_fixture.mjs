#!/usr/bin/env node
/**
 * Render a deterministic procurement document fixture for the contract-evidence
 * browser harness. Writes one HTML document to the path in argv[2] or stdout.
 */
import { writeFileSync } from "node:fs";
import { buildCrossSourceCoverageLedger } from "../../site/cross_source_coverage_ledger.mjs";
import { renderProcurementDocument } from "../../site/procurement_document.mjs";

const PROCUREMENT_ID = "procurement:contract:CT107120258801626";

const observations = [
  {
    source_system: "city_record",
    source_system_id: "20240829105",
    source_observation_ref: "city_record:20240829105",
    ingested_at: "2026-08-18T19:46:32Z",
    snapshot: {
      short_title: "City Sanctuary Facility for Families with Children, Comfort Inn Sheepsheads Bay",
      agency_name: "Homeless Services",
      type_of_notice_description: "Award",
      start_date: "2024-08-29",
      pin: "07124E0044001",
    },
    normalized_snapshot: "",
    raw_snapshot: "",
    content_hash: "city-record-hash",
  },
  {
    source_system: "passport_public_contracts",
    source_system_id: "contract:07124E0044001:5050251",
    source_observation_ref: "passport_public_contracts:contract:07124E0044001:5050251",
    ingested_at: "2026-08-18T19:46:32Z",
    snapshot: {
      contract_id: "CT107120258801626",
      epin: "07124E0044001",
      title: "City Sanctuary Facility for Families with Children, Comfort Inn Sheepsheads Bay",
      vendor_name: "BHRAGS",
      agency_name: "Homeless Services",
      current_amount: "12500000",
      award_date: "2024-08-15",
      start_date: "2024-09-01",
      end_date: "2026-08-31",
    },
    normalized_snapshot: "",
    raw_snapshot: "",
    content_hash: "passport-hash",
  },
];

observations.forEach((row) => {
  row.normalized_snapshot = JSON.stringify(row.snapshot);
  row.raw_snapshot = JSON.stringify(row.snapshot);
});

const object = {
  procurement_id: PROCUREMENT_ID,
  title: "City Sanctuary Facility for Families with Children, Comfort Inn Sheepsheads Bay",
  source_observation_refs: observations.map((row) => row.source_observation_ref),
  identity_keys: {
    contract_ids: ["CT107120258801626"],
    epins: ["07124E0044001"],
  },
  stages: [
    { stage: "award", source_observation_refs: ["city_record:20240829105"] },
    { stage: "registered", source_observation_refs: ["passport_public_contracts:contract:07124E0044001:5050251"] },
  ],
  process_events: [
    {
      event_id: "award-1",
      state: "award",
      effective_at: "2024-08-15T12:00:00Z",
      source_system: "city_record",
    },
    {
      event_id: "registered-1",
      state: "registered",
      effective_at: "2024-09-01T12:00:00Z",
      source_system: "passport_public_contracts",
    },
  ],
};

const sourceStatus = {
  city_record: { status: "available", generated_at: "2026-08-18T20:00:00Z" },
  passport_public_contracts: { status: "available", generated_at: "2026-08-18T20:00:00Z" },
  checkbook_spending: { status: "unavailable", reason: "upstream_error" },
};

object.cross_source_coverage_ledger = buildCrossSourceCoverageLedger({
  object,
  observations,
  sourceStatus,
  sourceCoverage: null,
  aboResidual: { bridge: { status: "stopped_below_threshold", total: 50 } },
  lookups: {
    checkbook_spending: { state: "unavailable", as_of: "2026-08-18T20:00:00Z" },
    checkbook_contracts: {
      state: "checked-no-match",
      as_of: "2026-08-18T20:00:00Z",
      basis: "exact_contract_id",
      denominator: 2000,
      vintage: "2026-08-18",
      population: "Checkbook contracts in this snapshot",
    },
  },
  kind: "procurement",
});

const html = renderProcurementDocument(object, observations, {
  currentHref: `/procurements/${encodeURIComponent(PROCUREMENT_ID)}`,
  sourceStatus,
  sourceCoverage: null,
  aboResidual: { bridge: { status: "stopped_below_threshold", total: 50 } },
});

if (!html) {
  console.error("renderProcurementDocument returned empty output");
  process.exit(1);
}

const out = process.argv[2];
if (out) writeFileSync(out, html);
else process.stdout.write(html);
