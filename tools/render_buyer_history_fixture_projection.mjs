#!/usr/bin/env node
/**
 * Render the retained buyer-history source slices into a registered-contract
 * projection document, using the production normalizer and projection.
 *
 * The browser journey needs a population whose registration timing is actually
 * measurable, and it must be the same arithmetic the site ships rather than a
 * hand-built stand-in. This reads the retained real Checkbook records in
 * test/fixtures and emits a document shaped exactly like
 * site/data/analytics_registered_contracts.json, so the journey can serve it to
 * the real page and assert the counts the acceptance ledger records.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeCheckbookContractRows } from "../warehouse/lib/checkbook_contracts.mjs";
import { ANALYTICAL_PROJECTION_SCHEMA } from "../site/analytical_projection_contract.mjs";
import {
  normalizeAnalyticalContractRow,
  registrationTimingSummary,
} from "../site/analytical_projection.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLICES = join(ROOT, "test/fixtures/buyer_contracting_history_fy2026_slices.json");
const DESTINATIONS = join(ROOT, "test/fixtures/buyer_contracting_history_exact_destinations.json");

function sourceRows(document) {
  return document.slices.map((values) => {
    const record = Object.fromEntries(document.fields.map((field, index) => [field, values[index]]));
    return {
      id: record.prime_contract_id,
      vendor: record.prime_vendor,
      agency: record.prime_contracting_agency,
      pin: record.prime_contract_pin,
      status: "registered",
      vendorRecordType: record.vendor_record_type,
      subVendor: record.sub_vendor,
      awardMethod: record.prime_contract_award_method,
      documentCode: record.document_code,
      ocaNumber: record.prime_oca_number,
      industry: record.prime_contract_industry,
      purpose: record.prime_contract_purpose,
      contractType: record.prime_contract_type,
      contractVersion: record.prime_contract_version,
      parentContractId: record.parent_contract_id,
      current: Number.parseFloat(record.prime_contract_current_amount) || 0,
      original: Number.parseFloat(record.prime_contract_original_amount) || 0,
      spent: Number.parseFloat(record.prime_vendor_spent_to_date) || 0,
      start: record.prime_contract_start_date,
      end: record.prime_contract_end_date,
      registered: record.prime_contract_registration_date,
      mwbe: record.prime_vendor_mwbe_category,
      subs: record.contract_includes_sub_vendors,
      sourceFiscalYears: [record.year],
    };
  });
}

const output = resolve(process.argv[2] || join(ROOT, ".artifacts/buyer-history/analytics_registered_contracts.json"));
const document = JSON.parse(readFileSync(SLICES, "utf8"));
const destinations = JSON.parse(readFileSync(DESTINATIONS, "utf8")).destinations || {};
const normalized = normalizeCheckbookContractRows(sourceRows(document));
const rows = normalized.rows.map(normalizeAnalyticalContractRow).filter(Boolean).map((row) => {
  const exact = destinations[row.prime_contract_id];
  return Array.isArray(exact) && exact.length ? { ...row, exact_destinations: exact } : row;
});
const observedAt = document.source.observed_at;
const payload = {
  schema: "cityscroll.analytics_registered_contracts.v1",
  projection_contract: ANALYTICAL_PROJECTION_SCHEMA,
  generated_at: observedAt,
  snapshot_date: String(observedAt).slice(0, 10),
  population_definition: document.source.population_note,
  dimensions: ["agency", "prime_vendor", "registration_fiscal_year", "contract_amount_band", "award_method", "industry", "registration_timing"],
  measures: ["unique_contract_count", "eligible_contract_count", "retroactive_contract_count"],
  registration_timing_summary: registrationTimingSummary(rows),
  source_population: {
    source_tag: "checkbook-contracts",
    observed_at: observedAt,
    normalized_unique_contracts: rows.length,
    source_fiscal_years: ["2026"],
  },
  rows,
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(payload)}\n`);
console.log(`buyer history fixture projection: contracts=${rows.length} output=${output}`);
