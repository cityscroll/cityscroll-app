import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENCY_FISCAL_CONTEXT_METHOD,
  buildAgencyFiscalContext,
  fiscalContextForAgency,
  renderAgencyFiscalContextSection,
} from "../site/agency_fiscal_context.mjs";

const fiscalRows = [
  { canonical_agency_id: "parks-and-recreation", canonical_agency_name: "Parks and Recreation", source_agency_name: "Parks and Recreation", source_workbook_id: "ibo_agency_expenditures", source_workbook: "AgencyExpenditures.xlsx", source_sheet: "In $000's", source_vintage: "FY2022", source_cell: "A1", fiscal_year: 2022, measure: "total_department_expenditures", publisher_measure: "TOTAL DEPT.", value: 1200, value_in_usd: 1200000, unit: "USD_thousands", unit_label: "In $000's" },
  { canonical_agency_id: "parks-and-recreation", canonical_agency_name: "Parks and Recreation", source_agency_name: "Parks and Recreation", source_workbook_id: "ibo_agency_expenditures", source_workbook: "AgencyExpenditures.xlsx", source_sheet: "In $000's", source_vintage: "FY2022", source_cell: "A2", fiscal_year: 2022, measure: "personal_services", publisher_measure: "Personal Services", value: 500, value_in_usd: 500000, unit: "USD_thousands", unit_label: "In $000's" },
  { canonical_agency_id: "parks-and-recreation", canonical_agency_name: "Parks and Recreation", source_agency_name: "Parks and Recreation", source_workbook_id: "ibo_full_time_positions", source_workbook: "FullTimePositions.xlsx", source_sheet: "ALL FUNDS", source_vintage: "FY2022", source_cell: "A3", fiscal_year: 2022, measure: "full_time_positions", publisher_measure: "Total", value: 300, unit: "positions", unit_label: "ALL FUNDS" },
];

const contractRows = [
  { prime_contract_id: "CT-PARKS", agency: "Department of Parks and Recreation", registration_fiscal_year: 2025, current_registered_amount: 900, original_registered_amount: 800 },
  { prime_contract_id: "CT-BUILDINGS", agency: "Department of Buildings", registration_fiscal_year: 2025, current_registered_amount: 100, original_registered_amount: 90 },
  { prime_contract_id: "CT-UNMATCHED", agency: "An Agency Not In The Identity Registry", registration_fiscal_year: 2025, current_registered_amount: 50, original_registered_amount: 40 },
];

const paymentRows = [
  { agency: "Department of Parks and Recreation", fiscal_year: 2026, transaction_count: 2, actual_payment_amount: 125.5, contract_count: 1 },
];

function build(options = {}) {
  return buildAgencyFiscalContext({
    fiscalRows,
    registeredRows: contractRows,
    paymentRows,
    iboReceipt: { schema: "cityscroll.ibo_fiscal_history_receipt.v1", retrieval_timestamp: "2026-08-27T00:00:00Z" },
    contractProjection: { schema: "cityscroll.analytics_registered_contracts.v1", snapshot_date: "2026-08-26", population_definition: "one row per exact contract" },
    paymentProjection: { schema: "cityscroll.analytics_payments.v1", snapshot_date: "2026-08-26", population_definition: "independent Checkbook Spending population" },
    generatedAt: "fixture",
    ...options,
  });
}

test("exact canonical agency join preserves fiscal measures, scope, and provenance", () => {
  const context = build();
  const parks = fiscalContextForAgency(context, "parks-and-recreation");
  assert.equal(parks.status, "matched");
  assert.equal(parks.fiscal_history.source, "ibo_authoritative");
  assert.equal(parks.provenance.join_method, AGENCY_FISCAL_CONTEXT_METHOD);
  assert.deepEqual(parks.provenance.overlapping_fiscal_years, []);
  assert.deepEqual(parks.provenance.registered_contract_years, [2025]);
  assert.equal(parks.years.find((row) => row.fiscal_year === 2022).ibo_actual_expenditures, 1200000);
  assert.equal(parks.years.find((row) => row.fiscal_year === 2022).ibo_staffing, 300);
  assert.equal(parks.years.find((row) => row.fiscal_year === 2025).current_registered_value, 900);
  assert.equal(parks.years.find((row) => row.fiscal_year === 2026).actual_payment_amount, 125.5);
  assert.equal(parks.years.find((row) => row.fiscal_year === 2022).measure_provenance.ibo_actual_expenditures.source_workbook, "AgencyExpenditures.xlsx");
  assert.equal(parks.years.find((row) => row.fiscal_year === 2022).measure_provenance.ibo_actual_expenditures.source_vintage, "FY2022");
  assert.equal(context.sources.fiscal_history.publisher_vintage, "FY2022");
  assert.equal(context.ranking_snapshots.find((row) => row.metric === "ibo_actual_expenditures").fiscal_year, 2022);
  assert.ok(parks.rankings.registered_current_value);
});

test("authoritative IBO rows require a matched canonical identity and exclude aggregates", () => {
  const context = build({
    fiscalRows: [
      ...fiscalRows,
      {
        record_type: "agency_measure",
        canonical_agency_id: "buildings",
        agency_identity_status: "unresolved",
        fiscal_year: 2022,
        source_workbook_id: "ibo_agency_expenditures",
        measure: "total_department_expenditures",
        value: 999,
        value_in_usd: 999000,
      },
      {
        record_type: "citywide_reconciliation",
        canonical_agency_id: "parks-and-recreation",
        fiscal_year: 2022,
        source_workbook_id: "ibo_agency_expenditures",
        measure: "total_department_expenditures",
        value: 100000,
        value_in_usd: 100000000,
      },
    ],
  });
  assert.equal(fiscalContextForAgency(context, "Department of Buildings").status, "unknown");
  assert.equal(fiscalContextForAgency(context, "Parks and Recreation").years.filter((row) => row.ibo_actual_expenditures != null).length, 1);
});

test("legacy fiscal values are fallback-only and do not enter IBO rankings", () => {
  const context = build({
    fallbackFiscalRows: [{
      agency_id: "buildings",
      agency_name: "Buildings",
      fiscal_year: 2022,
      ibo_actual_expenditures: 700000,
      ibo_staffing: 70,
    }],
  });
  const buildings = fiscalContextForAgency(context, "Department of Buildings");
  assert.equal(buildings.status, "fallback");
  assert.equal(buildings.provenance.fiscal_history_source, "inference_derived_fallback");
  assert.equal(buildings.years.find((row) => row.fiscal_year === 2022).ibo_actual_expenditures, 700000);
  assert.equal(buildings.years.find((row) => row.fiscal_year === 2022).measure_provenance.ibo_actual_expenditures.lineage, "inference_derived_fallback");
  assert.equal(context.coverage.fallback_fiscal_join_count, 1);
  assert.equal(context.ranking_snapshots.find((row) => row.metric === "ibo_actual_expenditures").agency_count, 1);
  const html = renderAgencyFiscalContextSection(buildings);
  assert.match(html, /data-fiscal-context-status="fallback"/);
  assert.doesNotMatch(html, /Fiscal context: Unknown|inference_derived|inferred/);
});

test("an identity-known agency without IBO history is explicit unknown, not fabricated context", () => {
  const context = build();
  const buildings = fiscalContextForAgency(context, "Department of Buildings");
  assert.equal(buildings.status, "unknown");
  assert.equal(buildings.fiscal_history, null);
  assert.equal(buildings.years[0].ibo_actual_expenditures, null);
  assert.equal(buildings.years[0].ibo_staffing, null);
  const html = renderAgencyFiscalContextSection(buildings);
  assert.match(html, /Fiscal context: Unknown/);
  assert.match(html, /data-fiscal-context-status="unknown"/);
  assert.doesNotMatch(html, /IBO actual expenditures[^<]*\$0/);
});

test("unresolved agency labels never mint a fiscal join", () => {
  const context = build();
  assert.equal(fiscalContextForAgency(context, "An Agency Not In The Identity Registry"), null);
  assert.equal(context.coverage.unknown_fiscal_context_count, 1);
});

test("rendered context names separate measures and warns on non-overlapping years", () => {
  const html = renderAgencyFiscalContextSection(fiscalContextForAgency(build(), "Parks and Recreation"));
  assert.match(html, /Agency fiscal context/);
  assert.match(html, /data-fiscal-era="ibo-history"/);
  assert.match(html, /data-fiscal-era="procurement-payments"/);
  assert.match(html, /IBO Personal Services/);
  assert.match(html, /Current registered contract value/);
  assert.match(html, /Actual payments/);
  assert.match(html, /PASSPort Public procurement records/);
  assert.match(html, /Checkbook NYC.*Comptroller's spending ledger/);
  assert.match(html, /different accounting scopes/);
  assert.match(html, /A dash means the publisher does not report that measure for that year/);
  assert.equal((html.match(/agency-fiscal-context-footnote/g) || []).length, 1);
  assert.match(html, /descriptive, not causal/);
  assert.match(html, /composite outsourcing or efficiency score/);
  assert.doesNotMatch(html, /AP-\d+/);
  assert.doesNotMatch(html, />Unknown<\/span>/);
  assert.match(html, /data-fiscal-coverage="unknown"/);
  assert.match(html, /IBO New York City Fiscal History/);
  assert.match(html, /ap_agency=Department\+of\+Parks\+and\+Recreation/);

  const iboTable = html.match(/data-fiscal-era="ibo-history"[\s\S]*?<table[\s\S]*?<\/table>/)?.[0];
  const procurementTable = html.match(/data-fiscal-era="procurement-payments"[\s\S]*?<table[\s\S]*?<\/table>/)?.[0];
  assert.ok(iboTable);
  assert.ok(procurementTable);
  assert.doesNotMatch(iboTable, /Current registered contract value|Actual payments/);
  assert.doesNotMatch(procurementTable, /IBO actual expenditures|IBO staffing/);
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const text = row[1].replace(/<[^>]+>/g, " ");
    assert.ok((text.match(/—(?:\s+—)*/g) || []).length <= 1);
  }
});
