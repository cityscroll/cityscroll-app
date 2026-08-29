import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  ANALYTICAL_FACTS,
  PAYMENT_PROJECTION,
  REGISTERED_CONTRACT_PROJECTION,
  UNKNOWN_DIMENSION_LABEL,
  assertSupportedProjection,
  compatibleAnalyticalFilters,
} from "../site/analytical_projection_contract.mjs";
import {
  filterAnalyticalPayments,
  groupAnalyticalPayments,
  normalizeAnalyticalPaymentRow,
  paymentRelatedContractDrillThroughHref,
  paymentTransactionDrillThroughHref,
} from "../site/analytical_payment_projection.mjs";
import {
  cityRecordCoverage,
  analyticalDrillThroughHref,
  preserveAnalyticalProjectionQuery,
  contractAmountBand,
  filterAnalyticalContracts,
  groupAnalyticalContracts,
  normalizeAnalyticalContractRow,
  registrationLagDaysBetween,
  registrationTimingSummary,
  registrationFiscalYear,
  vendorConcentration,
} from "../site/analytical_projection.mjs";
import { classifyCheckbookCityRecordMatches, normalizeCheckbookContractRows } from "../warehouse/lib/checkbook_contracts.mjs";
import { migrateLegacyUrl } from "../site/route_migration.mjs";
import { routeHashFromScope, scopeFromRouteHash } from "../site/scope_v0.mjs";
import {
  PERFORMANCE_EVIDENCE_STATES,
  assertNoPerformanceOverclaim,
  filterPerformanceEvidenceCoverage,
  groupPerformanceEvidenceCoverage,
  performanceEvidenceCoverageSummary,
  performanceEvidenceDrillThroughHref,
  projectPerformanceEvidenceCoverage,
} from "../site/analytical_performance_evidence.mjs";

describe("registered contract analytical projection contract", () => {
  it("declares reader labels, source fields, and the registration-year guard", () => {
    assert.equal(REGISTERED_CONTRACT_PROJECTION.fact, "registered_contract");
    assert.equal(REGISTERED_CONTRACT_PROJECTION.measures.sum_current_registered_amount.reader_label, "Current registered contract value");
    assert.equal(REGISTERED_CONTRACT_PROJECTION.measures.sum_original_registered_amount.reader_label, "Original registered contract value");
    assert.equal(REGISTERED_CONTRACT_PROJECTION.measures.retroactive_share.aggregation, "retroactive_count / eligible_contract_count");
    assert.equal(REGISTERED_CONTRACT_PROJECTION.dimensions.registration_timing.source_field, "registration_date, start_date");
    assert.equal(REGISTERED_CONTRACT_PROJECTION.dimensions.registration_fiscal_year.source_field, "prime_contract_registration_date");
    assert.match(REGISTERED_CONTRACT_PROJECTION.guards.join(" "), /source_fiscal_years.*provenance/i);
    assert.equal(ANALYTICAL_FACTS.payment, PAYMENT_PROJECTION);
    assert.equal(PAYMENT_PROJECTION.measures.sum_actual_payment_amount.reader_label, "Actual payments");
    assert.equal(assertSupportedProjection({ fact: "payment", measure: "sum_actual_payment_amount", dimension: "agency" }).fact, "payment");
    assert.throws(() => assertSupportedProjection({ fact: "payment", measure: "sum_current_registered_amount" }), /Unsupported measure/);
    assert.throws(() => assertSupportedProjection({ measure: "sum_current_registered_amount", dimension: "industry" }), /Unsupported dimension/);
  });

  it("switches facts while preserving shared filters and reporting dropped filters", () => {
    const result = compatibleAnalyticalFilters("registered_contract", "payment", {
      agency: "DEPT OF PARKS & RECREATION",
      prime_vendor: "Vendor A",
      fiscal_year: 2026,
      contract_id: "CT-1",
      contract_amount_band: "Under $100,000",
      min_amount: 1000,
    });
    assert.deepEqual(result.filters, {
      agency: "DEPT OF PARKS & RECREATION",
      prime_vendor: "Vendor A",
      fiscal_year: 2026,
      contract_id: "CT-1",
    });
    assert.deepEqual(result.dropped, ["contract_amount_band", "min_amount"]);
  });

  it("derives NYC registration fiscal years and versioned amount bands", () => {
    assert.equal(registrationFiscalYear("2025-06-30"), 2025);
    assert.equal(registrationFiscalYear("2025-07-01"), 2026);
    assert.equal(registrationFiscalYear("not-a-date"), null);
    assert.equal(contractAmountBand(0), "Under $100,000");
    assert.equal(contractAmountBand(100000), "$100,000–$999,999");
    assert.equal(contractAmountBand(1000000), "$1 million–$9.99 million");
    assert.equal(contractAmountBand(null), null);
  });

  it("keeps null dimensions honest and aggregates each contract once", () => {
    const collapsed = normalizeCheckbookContractRows([
      { id: "CT-1", vendorRecordType: "Prime Vendor", agency: "Agency A", vendor: "Vendor A", current: 100, original: 90, registered: "2025-08-01", sourceFiscalYears: ["2025"] },
      { id: "CT-1", vendorRecordType: "Sub Vendor", agency: "Agency A", vendor: "Vendor A", current: 0, original: 0, registered: "2025-08-01", sourceFiscalYears: ["2026"] },
      { id: "CT-2", vendorRecordType: "Prime Vendor", agency: "Agency B", vendor: "Vendor B", current: 200, original: 180, registered: "2025-08-02", sourceFiscalYears: ["2026"] },
    ]);
    assert.equal(collapsed.rows.length, 2);
    assert.equal(collapsed.counts.duplicate_slices_collapsed, 1);
    const rows = collapsed.rows.map(normalizeAnalyticalContractRow);
    rows.find((row) => row.prime_contract_id === "CT-2").agency = null;
    const grouped = groupAnalyticalContracts(rows, { groupBy: "agency", measure: "current" });
    assert.equal(grouped.groups.find((group) => group.label === UNKNOWN_DIMENSION_LABEL).sum_current_registered_amount, 200);
    assert.equal(grouped.groups.reduce((sum, group) => sum + group.contract_count, 0), 2);
    const agencyA = grouped.groups.find((group) => group.label === "Agency A");
    assert.deepEqual(
      { count: agencyA.contract_count, sum_original: agencyA.sum_original_registered_amount, sum_current: agencyA.sum_current_registered_amount },
      { count: 1, sum_original: 90, sum_current: 100 },
    );
  });

  it("filters and emits an exact ordinary Contracts drill-through scope", () => {
    const rows = [
      normalizeAnalyticalContractRow({ id: "CT-A", agency: "Agency A", vendor: "Vendor A", current: 100, original: 90, registered: "2025-08-01" }),
      normalizeAnalyticalContractRow({ id: "CT-B", agency: "Agency B", vendor: "Vendor A", current: 200, original: 180, registered: "2026-08-01" }),
    ];
    const filtered = filterAnalyticalContracts(rows, { agency: "Agency A", registration_fiscal_year: 2027 });
    assert.equal(filtered.length, 0);
    const href = analyticalDrillThroughHref({ agency: "Agency A", prime_vendor: "Vendor A", registration_fiscal_year: 2026, min_amount: 1000 });
    assert.equal(href, "/browse/contracts/?mode=award&ap_agency=Agency+A&ap_vendor=Vendor+A&ap_fy=2026&ap_min=1000");
    assert.match(analyticalDrillThroughHref({ agency: "Agency A", city_record_match: "none" }), /ap_city_record_match=none/);
  });

  it("classifies the coverage fixture with an independently computed exact-PIN expectation", () => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/analytical_projection/city_record_coverage.json", import.meta.url)));
    const rows = fixture.registered_contracts;
    const awards = fixture.city_record_awards;
    const cityRecordPins = new Set(awards.filter((row) => String(row.start_date).slice(0, 10) >= "2025-01-01").map((row) => row.pin));
    const projected = classifyCheckbookCityRecordMatches(rows, awards);
    for (const row of projected) {
      const expected = !row.pin ? "cannot_evaluate_missing_pin" : cityRecordPins.has(row.pin) ? "exact" : "none";
      assert.equal(row.city_record_match, expected, row.prime_contract_id);
    }
    const coverage = cityRecordCoverage(projected);
    assert.deepEqual(
      [coverage.matched_contract_count, coverage.unmatched_contract_count, coverage.missing_pin_contract_count],
      [1, 1, 1],
    );
    const empty = cityRecordCoverage([]);
    assert.equal(empty.eligible_contract_count, 0);
    assert.equal(empty.match_rate, null);
    assert.equal(empty.evaluable_match_rate, null);
    assert.equal(empty.unmatched_contract_count, 0);
    assert.equal(empty.missing_pin_contract_count, 0);
  });

  it("keeps City Record coverage behind a closed methodology disclosure on Contracts", () => {
    const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
    const i18n = readFileSync(new URL("../site/i18n.js", import.meta.url), "utf8");
    const groupsIndex = html.indexOf('id="contracts-analytics-groups"');
    const coverageIndex = html.indexOf('id="contracts-analytics-coverage"');
    assert.ok(groupsIndex > 0 && coverageIndex > groupsIndex);
    assert.match(html, /<details class="contracts-analytics-coverage" id="contracts-analytics-coverage">/);
    assert.doesNotMatch(html, /id="contracts-analytics-coverage"[^>]*\sopen/);
    assert.match(html, /data-i18n="analytics_coverage_disclosure">Data coverage\/methodology</);
    assert.doesNotMatch(html, /legal noncompliance|city failed to publish|the City failed/i);
    assert.match(i18n, /CityScroll found or did not find an exact City Record award notice/);
    assert.doesNotMatch(i18n, /legal noncompliance|city failed to publish/i);
    assert.match(i18n, /analytics_coverage_empty: "No registered contracts in this selection were evaluated for an exact City Record notice."/);
  });

  it("computes vendor shares and top-N shares from the explicit scope denominator", () => {
    const rows = [
      normalizeAnalyticalContractRow({ id: "CT-A1", agency: "Agency A", vendor: "Vendor A", current: 100, original: 90, registered: "2025-08-01" }),
      normalizeAnalyticalContractRow({ id: "CT-A2", agency: "Agency A", vendor: "Vendor A", current: 50, original: 45, registered: "2025-08-02" }),
      normalizeAnalyticalContractRow({ id: "CT-B1", agency: "Agency A", vendor: "Vendor B", current: 50, original: 40, registered: "2025-08-03" }),
      normalizeAnalyticalContractRow({ id: "CT-U1", agency: "Agency A", vendor: null, current: 100, original: 80, registered: "2025-08-04" }),
    ];
    // Independent expectation: 150 + 50 + 100 = 300 selected-scope current value.
    const expectedDenominator = rows.reduce((sum, row) => sum + row.current_registered_amount, 0);
    const result = vendorConcentration(rows, { measure: "current" });
    const named = result.vendors.filter((vendor) => !vendor.unclassified);
    const unknown = result.vendors.find((vendor) => vendor.unclassified);
    assert.equal(result.denominator, expectedDenominator);
    assert.equal(result.denominator_contract_count, 4);
    assert.deepEqual(named.map((vendor) => [vendor.label, vendor.contract_count, vendor.registered_value]), [
      ["Vendor A", 2, 150],
      ["Vendor B", 1, 50],
    ]);
    assert.equal(unknown.registered_value, 100);
    assert.equal(named[0].share, 150 / 300);
    assert.equal(result.top_5_value, 200);
    assert.equal(result.top_5_share, 200 / 300);
    assert.equal(result.top_10_share, 200 / 300);
    assert.equal(result.vendors.reduce((sum, vendor) => sum + vendor.share, 0), 1);
    assert.equal(vendorConcentration(rows, { measure: "original" }).denominator, 255);
  });

  it("derives timing without treating missing dates as on time", () => {
    assert.equal(registrationLagDaysBetween("2025-04-08", "2025-04-10"), -2);
    assert.equal(registrationLagDaysBetween("2025-04-10", "2025-04-10"), 0);
    assert.equal(registrationLagDaysBetween("2025-04-21", "2025-04-10"), 11);
    assert.equal(registrationLagDaysBetween("2025-04-25", null), null);
    const fixture = JSON.parse(readFileSync("test/fixtures/analytical_registration_timing.json", "utf8"));
    const rows = fixture.rows.map(normalizeAnalyticalContractRow);
    assert.deepEqual(rows.map((row) => [row.prime_contract_id, row.registration_lag_days, row.registration_timing]), [
      ["CT-BEFORE", -2, "early_on_time"],
      ["CT-SAME-DAY", 0, "early_on_time"],
      ["CT-AFTER", 11, "retroactive"],
      ["CT-MISSING-START", null, null],
    ]);
    assert.deepEqual(registrationTimingSummary(rows), {
      total_contract_count: 4,
      eligible_contract_count: 3,
      missing_date_contract_count: 1,
      retroactive_contract_count: 1,
      early_on_time_contract_count: 2,
      retroactive_share: 1 / 3,
      missing_date_share: 1 / 4,
      median_lag_days: 0,
      p75_lag_days: 11,
      p90_lag_days: 11,
      excluded_row_count: 1,
    });
    assert.deepEqual(filterAnalyticalContracts(rows, { retroactive: "true" }).map((row) => row.prime_contract_id), ["CT-AFTER"]);
    assert.match(analyticalDrillThroughHref({ agency: "Department of Timing", retroactive: true }), /retroactive=true/);
  });

  it("matches the independently computed SQL timing fixture", () => {
    const fixture = JSON.parse(readFileSync("test/fixtures/analytical_registration_timing.json", "utf8"));
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE contracts (agency TEXT, start_date TEXT, registration_date TEXT)");
    const insert = db.prepare("INSERT INTO contracts (agency, start_date, registration_date) VALUES (?, ?, ?)");
    for (const row of fixture.rows) insert.run(row.agency, row.start || null, row.registered || null);
    const sql = readFileSync("test/fixtures/analytical_registration_timing.sql", "utf8");
    const sqlResult = db.prepare(sql).all();
    db.close();
    const rows = fixture.rows.map(normalizeAnalyticalContractRow);
    const expected = groupAnalyticalContracts(rows, { groupBy: "agency" }).groups[0];
    assert.equal(sqlResult.length, 1);
    const actual = sqlResult[0];
    assert.deepEqual(
      Object.fromEntries(["total_contract_count", "eligible_contract_count", "missing_date_contract_count", "retroactive_contract_count", "early_on_time_contract_count", "median_lag_days", "p75_lag_days", "p90_lag_days"].map((key) => [key, Number(actual[key])])),
      {
        total_contract_count: expected.total_contract_count,
        eligible_contract_count: expected.eligible_contract_count,
        missing_date_contract_count: expected.missing_date_contract_count,
        retroactive_contract_count: expected.retroactive_contract_count,
        early_on_time_contract_count: expected.early_on_time_contract_count,
        median_lag_days: expected.median_lag_days,
        p75_lag_days: expected.p75_lag_days,
        p90_lag_days: expected.p90_lag_days,
      },
    );
    assert.equal(Number(actual.retroactive_share), expected.retroactive_share);
    assert.equal(Number(actual.missing_date_share), expected.missing_date_share);
  });

  it("preserves linked agency and vendor scopes across the cold document-route handoff", () => {
    const raw = "#money?mode=award&ap_agency=Department+of+Design+and+Construction&ap_vendor=Vendor+A&ap_fy=2026&ap_amount_band=%24100%2C000%E2%80%93999%2C999&ap_min=1000&ap_max=2000";
    const scope = scopeFromRouteHash(raw);
    const normalized = routeHashFromScope(scope, { surface: "money" });
    assert.equal(normalized, "#money?mode=award");
    assert.equal(preserveAnalyticalProjectionQuery(raw, normalized), raw);
    assert.equal(
      migrateLegacyUrl(`/${raw}`).target,
      "/browse/contracts/?mode=award&ap_agency=Department+of+Design+and+Construction&ap_vendor=Vendor+A&ap_fy=2026&ap_amount_band=%24100%2C000%E2%80%93999%2C999&ap_min=1000&ap_max=2000",
    );

    const routingSource = readFileSync(new URL("../site/app/routing.mjs", import.meta.url), "utf8");
    assert.match(routingSource, /preserveAnalyticalProjectionQuery\("#"\+raw/);
    assert.match(routingSource, /ANALYTICAL_PROJECTION_QUERY_KEYS/);
  });
});

describe("actual payment analytical projection", () => {
  const rows = [
    normalizeAnalyticalPaymentRow({ transaction_id: "TX-1", agency: "DEPT OF PARKS & RECREATION", payee_name: "Vendor A", fiscal_year: 2026, contract_id: "CT-1", check_amount: "125.50" }),
    normalizeAnalyticalPaymentRow({ transaction_id: "TX-2", agency: "Department of Parks and Recreation", payee_name: "Vendor A", fiscal_year: 2026, contract_id: "CT-1", check_amount: "-25.50" }),
    normalizeAnalyticalPaymentRow({ transaction_id: "TX-3", agency: "Department of Alpha", payee_name: "Vendor B", fiscal_year: 2026, contract_id: "CT-2", check_amount: "200" }),
  ];

  it("uses Civic Graph agency normalization and retains reversal amounts", () => {
    const filtered = filterAnalyticalPayments(rows, { agency: "Parks and Recreation", prime_vendor: "Vendor A", fiscal_year: 2026 });
    assert.equal(filtered.length, 2);
    assert.equal(filterAnalyticalPayments(rows, { contract_id: "CT-1" }).length, 2);
    const grouped = groupAnalyticalPayments(filtered, { groupBy: "agency", measure: "amount" });
    assert.equal(grouped.groups[0].actual_payment_amount, 100);
    assert.equal(grouped.groups[0].transaction_count, 2);
  });

  it("offers separate transaction and related-contract drill-throughs", () => {
    const transactions = paymentTransactionDrillThroughHref({ agency: "Department of Alpha", prime_vendor: "Vendor B", fiscal_year: "FY2026" });
    assert.match(transactions, /ap_fact=payment/);
    assert.match(transactions, /ap_payment_view=transactions/);
    assert.match(transactions, /ap_agency=Department\+of\+Alpha/);
    assert.match(transactions, /ap_vendor=Vendor\+B/);
    const contracts = paymentRelatedContractDrillThroughHref({ agency: "Department of Alpha", prime_vendor: "Vendor B", fiscal_year: 2026, contract_id: "CT-2" });
    assert.equal(contracts, "/browse/contracts/?mode=award&ap_agency=Department+of+Alpha&ap_vendor=Vendor+B&ap_fy=2026&ap_contract_id=CT-2");
  });

  it("keeps the committed payment artifact separate from registered contracts", () => {
    const projection = JSON.parse(readFileSync("site/data/analytics_payments.json", "utf8"));
    assert.equal(projection.schema, "cityscroll.analytics_payments.v1");
    assert.equal(projection.fact, "payment");
    assert.equal(projection.source_population.source_receipt, "warehouse/receipts/proof/checkbook_payment_population_latest.json");
    assert.equal(projection.population.actual_payment_amount, 52327564799.68);
    assert.equal(projection.population.transaction_count, 1783465);
    assert.ok(statSync("site/data/analytics_payments.json").size < 24 * 1024 * 1024);
    assert.equal(projection.rows.find((row) => row.contract_id === "CT185620255400226")?.contract_count, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(projection, "current_registered_amount"), false);
  });
});

describe("committed analytical population artifact", () => {
  it("is a distinct-contract population artifact with an auditable receipt", () => {
    const projection = JSON.parse(readFileSync("site/data/analytics_registered_contracts.json", "utf8"));
    const receipt = JSON.parse(readFileSync("warehouse/receipts/proof/analytics_registered_contracts_population_latest.json", "utf8"));
    const ids = new Set(projection.rows.map((row) => row.prime_contract_id));
    assert.equal(projection.schema, "cityscroll.analytics_registered_contracts.v1");
    assert.equal(ids.size, projection.rows.length);
    assert.equal(ids.size, receipt.population.distinct_prime_contract_ids);
    assert.equal(receipt.materialization.table, "analytics_registered_contracts");
    assert.equal(receipt.materialization.request_time_database_queries, false);
    assert.doesNotMatch(receipt.materialization.reproducible_input, /(?:^|\/)Users\/[A-Za-z]|(?:^|\/)home\/[A-Za-z]|^~\//);
    assert.ok(receipt.dimension_profile.agency.distinct_count > 0);
    assert.ok(receipt.dimension_profile.prime_vendor.distinct_count > 0);
    assert.equal(projection.registration_timing_summary.total_contract_count, projection.rows.length);
    assert.equal(projection.registration_timing_summary.missing_date_contract_count, projection.rows.length);
    assert.equal(projection.registration_timing_summary.retroactive_share, null);
  });
});

describe("public performance-evidence coverage projection", () => {
  const contractRows = [
    { prime_contract_id: "CT-TERMS", agency: "Agency A", prime_vendor: "Vendor A", registration_fiscal_year: 2026, contract_amount_band: "Under $100,000", current_registered_amount: 100 },
    { prime_contract_id: "CT-EVALUATION", agency: "Agency A", prime_vendor: "Vendor B", registration_fiscal_year: 2026, contract_amount_band: "Under $100,000", current_registered_amount: 200 },
    { prime_contract_id: "CT-NONE", agency: "Agency B", prime_vendor: "Vendor C", registration_fiscal_year: 2027, contract_amount_band: "Under $100,000", current_registered_amount: 300 },
    { prime_contract_id: "CT-INVALID", agency: "Agency B", prime_vendor: "Vendor D", registration_fiscal_year: 2027, contract_amount_band: "Under $100,000", current_registered_amount: 400 },
  ];
  const evidence = JSON.parse(readFileSync(new URL("./fixtures/analytical_projection/performance_evidence.json", import.meta.url))).rows;

  it("counts exclusive evidence states while preserving exact source passages", () => {
    const projection = projectPerformanceEvidenceCoverage(contractRows, evidence, { snapshot_date: "2026-08-26" });
    const summary = performanceEvidenceCoverageSummary(projection.rows);
    assert.deepEqual(Object.fromEntries(Object.entries(summary.states).map(([state, value]) => [state, value.contract_count])), {
      [PERFORMANCE_EVIDENCE_STATES.TERMS]: 1,
      [PERFORMANCE_EVIDENCE_STATES.EVALUATION]: 1,
      [PERFORMANCE_EVIDENCE_STATES.NONE]: 2,
    });
    const terms = projection.rows.find((row) => row.prime_contract_id === "CT-TERMS");
    assert.equal(terms.evidence_items[0].source_passage.document_id, "rfx-terms-1");
    assert.equal(terms.evidence_items[0].source_passage.locator, "page 7, section 2.1");
    assert.equal(terms.evidence_items[0].source_passage.url, "https://example.nyc.gov/rfx/terms.pdf");
    const unresolved = projection.rows.find((row) => row.prime_contract_id === "CT-NONE");
    assert.equal(unresolved.evidence_state, PERFORMANCE_EVIDENCE_STATES.NONE);
    assert.equal(unresolved.unresolved, true);
    assert.deepEqual(unresolved.evidence_items, []);
  });

  it("keeps aggregate groups linked to their composing contracts", () => {
    const projection = projectPerformanceEvidenceCoverage(contractRows, evidence);
    const grouped = groupPerformanceEvidenceCoverage(projection.rows, { groupBy: "agency" });
    const agencyA = grouped.groups.find((group) => group.label === "Agency A");
    assert.deepEqual(agencyA.states[PERFORMANCE_EVIDENCE_STATES.TERMS].contract_ids, ["CT-TERMS"]);
    assert.deepEqual(agencyA.states[PERFORMANCE_EVIDENCE_STATES.EVALUATION].contract_ids, ["CT-EVALUATION"]);
    const href = performanceEvidenceDrillThroughHref({ agency: "Agency A", evidence_state: PERFORMANCE_EVIDENCE_STATES.TERMS });
    assert.equal(href, "/browse/contracts/?mode=award&ap_agency=Agency+A&ap_evidence_state=has-accessible-performance-terms");
    assert.equal(filterPerformanceEvidenceCoverage(projection.rows, { evidence_state: PERFORMANCE_EVIDENCE_STATES.NONE }).length, 2);
  });

  it("does not turn financial visibility or unresolved evidence into a performance claim", () => {
    const projection = projectPerformanceEvidenceCoverage(contractRows, evidence);
    assertNoPerformanceOverclaim(projection);
    assert.equal(projection.rows[0].financial_fact, "registered_contract");
    assert.equal(projection.rows[0].evidence_state, PERFORMANCE_EVIDENCE_STATES.TERMS);
    assert.equal(projection.rows.find((row) => row.prime_contract_id === "CT-INVALID").evidence_state, PERFORMANCE_EVIDENCE_STATES.NONE);
    assert.match(projection.absence_scope, /does not establish.*vendor failed.*outcome/i);
    assert.throws(() => assertNoPerformanceOverclaim({ evidence_state: PERFORMANCE_EVIDENCE_STATES.NONE, performance_score: 0 }), /forbidden field/);
  });

  it("rejects located evidence without an exact HTTPS source passage", () => {
    const projection = projectPerformanceEvidenceCoverage(
      [{ prime_contract_id: "CT-1", current_registered_amount: 10 }],
      [{ prime_contract_id: "CT-1", evidence_items: [{ kind: "performance_terms", source_passage: { url: "https://example.test/a.pdf", locator: "", excerpt: "missing locator" } }] }],
    );
    assert.equal(projection.rows[0].evidence_state, PERFORMANCE_EVIDENCE_STATES.NONE);
    assert.equal(projection.rows[0].unresolved, true);
  });
});
