import { createHash } from "node:crypto";

export const MTA_OPPORTUNITY_ADAPTER_SCHEMA = "cityscroll.mta_opportunity_adapter.v1";
export const MTA_PARENT_INSTITUTION_ID = "metropolitan-transportation-authority";

const NATIVE_SOURCES = new Set([
  "nys_contract_reporter",
  "mta_current_opportunities",
  "mta_bid_results",
]);

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function hash(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function normalizedRow(fixture) {
  const row = fixture?.source_row || {};
  return {
    source_system: fixture.source_system,
    source_dataset: fixture.source_dataset,
    source_record_id: fixture.source_record_id,
    observation_type: fixture.observation_type,
    publisher_institution_id: fixture.publisher_institution_id,
    procuring_institution_id: fixture.procuring_institution_id || null,
    agency: row.agency || row.agency_name || row.agency_division || null,
    source_agency_label: row.agency || row.agency_name || row.agency_division || null,
    source_vendor_name: row.bidder || row.bidder_name || null,
    contract_reporter_number: row.cr_number || row.contract_reporter_number || null,
    solicitation_id: row.solicitation_number || row.solicitation_id || row.auc_id || row.auction_id || null,
    event_id: row.event_number || row.event_id || row.event || row.solicitation_number || row.solicitation_id || row.auc_id || row.auction_id || null,
    title: row.title || row.description || row.auc_name || row.auction_name || null,
    purpose: row.purpose || row.description || null,
    amount: row.estimated_value || row.bid_amount || null,
    currency: row.currency || "USD",
    issue_date: row.issue_date || row.document_availability_date || null,
    due_date: row.due_date || row.opening_date || null,
    opening_date: row.opening_date || null,
    category: row.category || null,
    ad_type: row.ad_type || null,
    location: row.location || null,
    official_url: fixture.receipt?.url || null,
    mta_parent_institution_id: MTA_PARENT_INSTITUTION_ID,
    source_values: { ...row },
    source_receipt: { ...fixture.receipt },
  };
}

export function recordsFromMtaOpportunityFixtures(document = {}) {
  const fixtures = Array.isArray(document?.fixtures) ? document.fixtures : [];
  return fixtures.filter((fixture) => (
    fixture && typeof fixture === "object" && NATIVE_SOURCES.has(fixture.source_system)
  )).map((fixture) => {
    const row = normalizedRow(fixture);
    const rawResponse = fixture.raw_response || JSON.stringify(fixture.source_row || {});
    return {
      source_system: fixture.source_system,
      source_system_id: fixture.source_record_id,
      content_hash: fixture.receipt?.raw_response_sha256 || hash(rawResponse),
      normalized_snapshot: JSON.stringify(row),
      raw_snapshot: rawResponse,
      ingested_at: fixture.retrieved_at || fixture.receipt?.retrieved_at || null,
    };
  });
}

export function validateMtaOpportunityFixtures(document = {}) {
  const errors = [];
  for (const fixture of Array.isArray(document?.fixtures) ? document.fixtures : []) {
    if (!NATIVE_SOURCES.has(fixture?.source_system)) errors.push(`${fixture?.id}: source_system`);
    for (const field of ["id", "source_record_id", "observation_type", "publisher_institution_id", "source_row", "receipt"]) {
      if (fixture?.[field] == null) errors.push(`${fixture?.id || "fixture"}: missing ${field}`);
    }
    if (!text(fixture?.receipt?.url) || !text(fixture?.receipt?.raw_response_sha256)) {
      errors.push(`${fixture?.id || "fixture"}: incomplete receipt`);
    }
  }
  return errors;
}
