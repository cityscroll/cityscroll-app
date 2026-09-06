// Acceptance for the buyer contracting history at the pursuit decision.
//
// The expectations here are recomputed from retained real Checkbook source
// records rather than asserted from a hand-written example, so a regression in
// deduplication, date ownership, or scope filtering fails on real publisher
// shapes. The named contract ids and counts are offline regression
// expectations for that retained extract; they are not live-source gates and
// must never be required of a future refresh.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseContractTransactions } from "../worker/src/lib/checkbook_lifecycle.mjs";
import { normalizeCheckbookContractRows } from "../warehouse/lib/checkbook_contracts.mjs";
import {
  analyticalDrillThroughHref,
  filterAnalyticalContracts,
  normalizeAnalyticalContractRow,
  preserveAnalyticalProjectionQuery,
  registrationTimingSummary,
} from "../site/analytical_projection.mjs";
import { resolveAgencyIdentity } from "../site/agency_identity.mjs";
import {
  BUYER_CONTRACTING_HISTORY_SCHEMA,
  BUYER_HISTORY_REPAIR_GUARD,
  BUYER_HISTORY_TIMING_STATES,
  buyerContractingHistory,
  buyerContractingHistoryCase,
  buyerContractingHistoryFailure,
  buyerHistoryFingerprint,
  buyerHistoryRepairObservation,
} from "../site/buyer_contracting_history.mjs";
import { upsertRepairItem } from "../worker/src/lib/repair_queue.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const SLICES = readJson("./fixtures/buyer_contracting_history_fy2026_slices.json");
const LEDGER = readJson("./fixtures/buyer_contracting_history_fy2026_ledger.json");
const SOURCE_PAGE = readFileSync(new URL("./fixtures/buyer_contracting_history_source_page.xml", import.meta.url), "utf8");

/** Expand the columnar retained slices into the collector's row shape. */
function retainedSourceRows() {
  return SLICES.slices.map((values) => {
    const record = Object.fromEntries(SLICES.fields.map((field, index) => [field, values[index]]));
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

const NORMALIZED = normalizeCheckbookContractRows(retainedSourceRows());
const PROJECTION = NORMALIZED.rows.map(normalizeAnalyticalContractRow);
const cohort = (id) => LEDGER.cohorts.find((entry) => entry.id === id);
const boundary = (id) => LEDGER.boundary_contracts.find((entry) => entry.source_contract_id === id);
const contract = (id) => PROJECTION.find((row) => row.prime_contract_id === id);

describe("retained source population accounting", () => {
  it("collapses every published slice to one row per exact contract id", () => {
    // Counted independently of the normalizer's own report.
    const distinctIds = new Set(retainedSourceRows().map((row) => row.id));
    assert.equal(retainedSourceRows().length, SLICES.counts.slices);
    assert.equal(distinctIds.size, SLICES.counts.contracts);
    assert.equal(NORMALIZED.counts.unique_contracts, distinctIds.size);
    assert.equal(
      NORMALIZED.counts.duplicate_slices_collapsed,
      SLICES.counts.slices - SLICES.counts.contracts,
    );
    assert.equal(NORMALIZED.counts.prime_slices + NORMALIZED.counts.subvendor_slices, SLICES.counts.slices);
  });

  it("parses the retained publisher page and keeps both published dates", () => {
    const parsed = parseContractTransactions(SOURCE_PAGE);
    assert.equal(parsed.length, 30);
    for (const id of SLICES.retained_boundary_contracts) {
      const primes = parsed.filter((row) => row.id === id && row.vendorRecordType === "Prime Vendor");
      assert.equal(primes.length, 1, `${id} must publish exactly one prime observation`);
      assert.ok(primes[0].start, `${id} publishes a start date`);
      assert.ok(primes[0].registered, `${id} publishes a registration date`);
      assert.ok(primes[0].industry || primes[0].purpose, `${id} publishes source classification`);
    }
  });

  it("records the full-population accounting the retained pages reported", () => {
    // The bounded fixture cannot recompute the whole fiscal year, so the
    // published pagination stays auditable instead: the reported record count
    // and the retained page hashes are the evidence for the wider totals.
    assert.equal(LEDGER.source.reported_record_count, LEDGER.population.api_slices);
    assert.equal(
      LEDGER.pages.reduce((sum, page) => sum + page.returned, 0),
      LEDGER.population.api_slices,
    );
    assert.equal(
      LEDGER.population.api_slices - LEDGER.population.duplicate_slices_collapsed,
      LEDGER.population.unique_contracts,
    );
    assert.equal(LEDGER.population.prime_slices, LEDGER.population.unique_contracts);
    assert.equal(
      LEDGER.registration_timing.after_start_count + LEDGER.registration_timing.early_on_time_count,
      LEDGER.registration_timing.eligible_contract_count,
    );
    assert.equal(LEDGER.registration_timing.missing_date_contract_count, 0);
    assert.equal(LEDGER.population.already_in_committed_projection, LEDGER.population.unique_contracts);
    for (const page of LEDGER.pages) {
      assert.match(page.sha256, /^[0-9a-f]{64}$/);
      assert.ok(Date.parse(page.observed_at) > 0, "each page carries its own observation time");
    }
  });

  it("keeps the source observation separate from the code revision", () => {
    assert.ok(Date.parse(LEDGER.source.first_observed_at) <= Date.parse(LEDGER.source.last_observed_at));
    assert.notEqual(LEDGER.committed_projection_at_capture.snapshot_date, LEDGER.source.first_observed_at.slice(0, 10));
    // The defect this repair removes: a complete-looking population in which
    // the timing measure had no eligible row at all.
    assert.equal(LEDGER.committed_projection_at_capture.eligible_contract_count, 0);
    assert.ok(LEDGER.committed_projection_at_capture.registration_dates_after_snapshot_date > 0);
  });
});

describe("date ownership", () => {
  it("uses the prime observation and retains a conflicting subvendor slice", () => {
    const expected = boundary("CTA185620268804596");
    const row = contract("CTA185620268804596");
    assert.equal(row.start_date, expected.contract_start_date);
    assert.equal(row.start_date, "2025-11-01");
    assert.equal(row.registration_date, "2026-02-04");
    assert.equal(row.registration_lag_days, 95);
    assert.equal(row.date_ownership.owner, "prime_vendor_slice");
    assert.ok(row.date_ownership.conflicting_start_date_observations);
    assert.deepEqual(row.date_ownership.start_date_observations, ["2025-11-01", "2026-02-05"]);
    // The conflicting observation is retained, never selected, and never
    // silently overwritten by the subvendor slice.
    assert.ok(row.date_ownership.start_date_observations.includes("2026-02-05"));
  });

  it("counts one contract from ten source slices without clamping early timing", () => {
    const expected = boundary("CT184620268808401");
    assert.equal(expected.source_slice_count, 10);
    assert.equal(retainedSourceRows().filter((row) => row.id === "CT184620268808401").length, 10);
    assert.equal(PROJECTION.filter((row) => row.prime_contract_id === "CT184620268808401").length, 1);
    const row = contract("CT184620268808401");
    assert.equal(row.registration_lag_days, -76);
    assert.equal(row.registration_timing, "early_on_time");
  });

  it("reports cross-slice conflicts without turning them into prime-level conflicts", () => {
    assert.ok(NORMALIZED.blocked.ambiguous_start_date_contracts > 0);
    assert.equal(NORMALIZED.blocked.ambiguous_prime_start_date_contracts, 0);
    assert.equal(NORMALIZED.blocked.ambiguous_prime_registration_date_contracts, 0);
  });

  it("retains source classification and instrument boundaries on the projection row", () => {
    const row = contract("CT184620268808401");
    assert.equal(row.industry, "Construction Services");
    assert.ok(row.contract_purpose);
    assert.equal(row.document_code, "CT1");
    assert.equal(row.contract_version, "1");
    // A release and its master agreement stay separate instruments.
    assert.equal(contract("CTA185620268804596").prime_contract_id, "CTA185620268804596");
  });
});

describe("buyer history denominator", () => {
  for (const id of ["parks_all", "dot_all", "dhs_all"]) {
    it(`reproduces the ${id} reconciliation control`, () => {
      const expected = cohort(id);
      const history = buyerContractingHistory(PROJECTION, {
        agency: expected.buyer,
        registration_fiscal_year: expected.registration_fiscal_year,
      });
      assert.equal(history.schema, BUYER_CONTRACTING_HISTORY_SCHEMA);
      assert.equal(history.contract_count, expected.contract_count);
      assert.equal(history.timing.after_start_count, expected.after_start_count);
      assert.equal(history.timing.early_on_time_count, expected.early_on_time_count);
      assert.equal(history.timing.state, BUYER_HISTORY_TIMING_STATES.MEASURED);
      assert.equal(history.registration_fiscal_year, 2026);
      // Membership, not just a total.
      assert.deepEqual(
        history.cases.map((entry) => entry.source_contract_id).sort(),
        expected.contract_ids,
      );
    });
  }

  it("counts the whole matching population independently of optional joins", () => {
    const expected = cohort("parks_all");
    const history = buyerContractingHistory(PROJECTION, {
      agency: expected.buyer,
      registration_fiscal_year: 2026,
    });
    assert.equal(history.case_total, expected.contract_count);
    // Nothing in the counted population depends on a PASSPort or City Record
    // field being present on the row.
    assert.ok(history.cases.every((entry) => entry.source_contract_id));
    assert.ok(LEDGER.population.exact_procurement_browse_destinations < LEDGER.population.unique_contracts);
  });

  it("narrows the comparison instead of silently returning the buyer-wide count", () => {
    for (const id of ["parks_construction_bid", "parks_construction_bid_1m_10m", "dot_professional_rfp", "dhs_human_pqvl"]) {
      const expected = cohort(id);
      const history = buyerContractingHistory(PROJECTION, {
        agency: expected.buyer,
        registration_fiscal_year: expected.registration_fiscal_year,
        industry: expected.industry,
        award_method: expected.award_method,
        contract_amount_band: expected.contract_amount_band,
      });
      assert.equal(history.contract_count, expected.contract_count, id);
      assert.equal(history.timing.after_start_count, expected.after_start_count, id);
      assert.ok(history.scope_is_narrowed, id);
      assert.notEqual(history.contract_count, cohort(`${id.split("_")[0]}_all`)?.contract_count, id);
    }
  });

  it("keeps a small cohort a count of cases rather than a rate to project forward", () => {
    const expected = cohort("dot_professional_rfp");
    const history = buyerContractingHistory(PROJECTION, {
      agency: expected.buyer,
      registration_fiscal_year: 2026,
      industry: expected.industry,
      award_method: expected.award_method,
    });
    assert.equal(history.contract_count, 6);
    assert.equal(history.timing.after_start_count, 5);
    assert.equal(history.cases.length, 6);
    assert.match(history.timing.metric_meaning, /not an invoice delay/);
    assert.match(history.timing.metric_meaning, /not .*a prediction/s);
  });
});

describe("case records", () => {
  it("exposes every field a case needs from the buyer's own source record", () => {
    const expected = boundary("CT184120268807929");
    const record = buyerContractingHistoryCase(contract(expected.source_contract_id));
    assert.equal(record.buyer, expected.buyer);
    assert.equal(record.vendor, expected.vendor);
    assert.equal(record.source_contract_id, expected.source_contract_id);
    assert.equal(record.contract_start_date, expected.contract_start_date);
    assert.equal(record.registration_date, expected.registration_date);
    assert.equal(record.registration_lag_days, expected.registration_lag_days);
    assert.equal(record.registration_timing, "registered_after_start");
    assert.equal(record.registration_fiscal_year, 2026);
    assert.ok(record.purpose, "the published contract purpose is retained");
    assert.ok(Number.isFinite(record.current_registered_amount));
    // This case has no exact procurement or PASSPort destination at all.
    assert.equal(expected.exact_procurement_destinations, 0);
    assert.equal(expected.exact_passport_matches, 0);
  });

  it("keeps a case with no exact procurement destination fully inspectable", () => {
    const expected = boundary("CT184620268805367");
    assert.equal(expected.exact_procurement_destinations, 0);
    const record = buyerContractingHistoryCase(contract(expected.source_contract_id));
    assert.equal(record.contract_start_date, "2026-03-26");
    assert.equal(record.registration_date, "2026-04-01");
    assert.equal(record.registration_lag_days, 6);
    const late = cohort("parks_construction_bid").contract_ids;
    assert.ok(late.includes(expected.source_contract_id));
  });

  it("adds no enrichment section when an optional join is simply absent", () => {
    const record = buyerContractingHistoryCase(contract("CT184620268805367"));
    assert.ok(!Object.keys(record).some((key) => /warning|apology|missing_join/.test(key)));
    // Absent optional facts are null, never an invented placeholder.
    const sparse = buyerContractingHistoryCase({ prime_contract_id: "CT-SPARSE" });
    assert.equal(sparse.purpose, null);
    assert.equal(sparse.registration_timing, null);
    assert.equal(sparse.registration_lag_days, null);
  });
});

describe("identity", () => {
  it("resolves a known buyer alias to the same institution", () => {
    assert.equal(
      resolveAgencyIdentity("Department of Parks and Recreation").canonical_id,
      resolveAgencyIdentity("Parks and Recreation").canonical_id,
    );
  });

  it("never reads an unresolved buyer label as a clean zero-contract history", () => {
    const unresolved = resolveAgencyIdentity("Office of Administrative Trials and Hearings");
    assert.equal(unresolved.matched, false);
    // The population still holds this buyer's contracts under its source-owned
    // label, so an unmatched identity must not become "no contracts".
    const history = buyerContractingHistory(PROJECTION, {
      agency: "Office of Administrative Trials and Hearings",
      registration_fiscal_year: 2026,
    });
    assert.equal(history.state, "available");
    assert.equal(history.buyer.label, "Office of Administrative Trials and Hearings");
    assert.notEqual(history.timing.state, BUYER_HISTORY_TIMING_STATES.MEASURED);
  });

  it("keeps a separate publisher's contract out of the citywide cohort", () => {
    const excluded = LEDGER.excluded_records.find((entry) => entry.source_contract_id === "BA2335819");
    assert.ok(excluded);
    assert.equal(excluded.publisher, "NYCHA");
    assert.ok(!PROJECTION.some((row) => row.prime_contract_id === "BA2335819"));
    const everyBuyer = buyerContractingHistory(PROJECTION, { registration_fiscal_year: 2026 });
    assert.ok(!everyBuyer.cases.some((entry) => entry.source_contract_id === "BA2335819"));
  });
});

describe("unmeasurable and failed history", () => {
  const datelessPopulation = PROJECTION
    .filter((row) => row.agency === "Department of Transportation")
    .map((row) => ({ ...row, start_date: null, registration_lag_days: null, registration_timing: null }));

  it("reports the denominator and withholds the metric instead of reporting zero", () => {
    const history = buyerContractingHistory(datelessPopulation, {
      agency: "Department of Transportation",
      registration_fiscal_year: 2026,
    });
    assert.equal(history.contract_count, cohort("dot_all").contract_count);
    assert.equal(history.timing.state, BUYER_HISTORY_TIMING_STATES.NOT_MATERIALIZED);
    assert.equal(history.timing.after_start_count, null);
    assert.notEqual(history.timing.after_start_count, 0);
    assert.equal(history.timing.measurable, false);
    assert.equal(history.after_start_cases_href, null);
    assert.ok(history.all_cases_href.includes("ap_agency="));
    assert.ok(history.repair_observation);
  });

  it("distinguishes a genuinely empty buyer from an unmeasurable one", () => {
    const empty = buyerContractingHistory(PROJECTION, {
      agency: "Department Of Nothing At All",
      registration_fiscal_year: 2026,
    });
    assert.equal(empty.contract_count, 0);
    assert.equal(empty.timing.state, BUYER_HISTORY_TIMING_STATES.NO_CONTRACTS);
    assert.equal(empty.repair_observation, null);
  });

  it("separates an unreadable population from an empty one", () => {
    // A bundle of projections still resolves to an object when one of its
    // documents fails to load. Only a readable rows array is a population, so
    // an unreadable one must reach the failure state rather than filtering an
    // empty array into a confident count of zero.
    for (const unreadable of [null, undefined, {}, { rows: null }, { rows: "unavailable" }]) {
      const rows = Array.isArray(unreadable?.rows) ? unreadable.rows : null;
      const history = rows
        ? buyerContractingHistory(rows, { agency: "Department of Transportation", registration_fiscal_year: 2026 })
        : buyerContractingHistoryFailure({ agency: "Department of Transportation", registration_fiscal_year: 2026 });
      assert.equal(history.state, "unavailable", JSON.stringify(unreadable));
      assert.equal(history.contract_count, null);
    }
    // An empty but readable population is a real answer of zero.
    const empty = buyerContractingHistory([], { agency: "Department of Transportation", registration_fiscal_year: 2026 });
    assert.equal(empty.state, "available");
    assert.equal(empty.contract_count, 0);
  });

  it("keeps the buyer, the year, and a working retry when the source fails", () => {
    const failure = buyerContractingHistoryFailure({
      agency: "Department of Parks and Recreation",
      registration_fiscal_year: 2026,
      industry: "Construction Services",
      reason: "source-request-failed",
      detail: "projection request returned 503",
    });
    assert.equal(failure.state, "unavailable");
    assert.equal(failure.buyer.label, "Department of Parks and Recreation");
    assert.equal(failure.registration_fiscal_year, 2026);
    assert.equal(failure.scope.industry, "Construction Services");
    assert.equal(failure.retry.available, true);
    assert.equal(failure.retry.agency, "Department of Parks and Recreation");
    assert.equal(failure.retry.registration_fiscal_year, 2026);
    assert.equal(failure.retry.scope.industry, "Construction Services");
    // A failed request is never rendered as a count of zero.
    assert.equal(failure.contract_count, null);
    assert.notEqual(failure.contract_count, 0);
    assert.equal(failure.cases.length, 0);
    assert.equal(failure.case_total, null);
  });
});

describe("repair lineage", () => {
  it("fingerprints one shape of source defect, not one per reader", () => {
    const first = buyerHistoryFingerprint({ reason: "registration-timing-not-materialized", registration_fiscal_year: 2026 });
    const second = buyerHistoryFingerprint({ reason: "registration-timing-not-materialized", registration_fiscal_year: "2026" });
    assert.equal(first, second);
    assert.equal(first, "buyer-contracting-history:checkbook:fy2026:registration-timing-not-materialized");
    assert.notEqual(
      first,
      buyerHistoryFingerprint({ reason: "source-request-failed", registration_fiscal_year: 2026 }),
    );
    // The buyer and the reader's narrowed scope are deliberately excluded.
    const parks = buyerContractingHistory(
      PROJECTION.map((row) => ({ ...row, start_date: null, registration_lag_days: null, registration_timing: null })),
      { agency: "Department of Parks and Recreation", registration_fiscal_year: 2026 },
    );
    const dot = buyerContractingHistory(
      PROJECTION.map((row) => ({ ...row, start_date: null, registration_lag_days: null, registration_timing: null })),
      { agency: "Department of Transportation", registration_fiscal_year: 2026 },
    );
    assert.equal(parks.repair_observation.signature, dot.repair_observation.signature);
  });

  it("enters the existing repair queue once per fingerprint", async () => {
    const storage = new Map();
    const env = {
      ALERT_STATE: {
        get: async (key, type) => {
          const value = storage.get(key);
          return value == null ? null : type === "json" ? JSON.parse(value) : value;
        },
        put: async (key, value) => { storage.set(key, value); },
        delete: async (key) => { storage.delete(key); },
      },
    };
    const observation = buyerHistoryRepairObservation({
      reason: "registration-timing-not-materialized",
      registration_fiscal_year: 2026,
      contract_count: 12015,
    });
    assert.equal(observation.guard, BUYER_HISTORY_REPAIR_GUARD);
    assert.equal(observation.stage, "materialization");
    assert.equal(observation.findings.length, 1);
    const first = await upsertRepairItem(env, observation, { now: new Date("2026-09-06T01:00:00Z") });
    const second = await upsertRepairItem(env, observation, { now: new Date("2026-09-06T02:00:00Z") });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(second.item.repeat_count, 2);
    assert.equal(first.item.first_seen, second.item.first_seen);
    assert.equal([...storage.keys()].filter((key) => key.startsWith("ops:repair:item:")).length, 1);
  });
});

describe("drill-through", () => {
  it("carries the selected buyer, year, and comparison into the scoped list", () => {
    const expected = cohort("parks_construction_bid_1m_10m");
    const history = buyerContractingHistory(PROJECTION, {
      agency: expected.buyer,
      registration_fiscal_year: 2026,
      industry: expected.industry,
      award_method: expected.award_method,
      contract_amount_band: expected.contract_amount_band,
    });
    for (const href of [history.all_cases_href, history.after_start_cases_href]) {
      const query = new URLSearchParams(href.split("?", 2)[1]);
      assert.equal(query.get("ap_agency"), expected.buyer);
      assert.equal(query.get("ap_fy"), "2026");
      assert.equal(query.get("ap_industry"), expected.industry);
      assert.equal(query.get("ap_award_method"), expected.award_method);
      assert.equal(query.get("ap_amount_band"), expected.contract_amount_band);
    }
    assert.equal(new URLSearchParams(history.after_start_cases_href.split("?", 2)[1]).get("retroactive"), "true");
    assert.equal(new URLSearchParams(history.all_cases_href.split("?", 2)[1]).get("retroactive"), null);
  });

  it("resolves the drill-through back to exactly the counted cases", () => {
    const expected = cohort("dhs_human_pqvl");
    const history = buyerContractingHistory(PROJECTION, {
      agency: expected.buyer,
      registration_fiscal_year: 2026,
      industry: expected.industry,
      award_method: expected.award_method,
    });
    const query = new URLSearchParams(history.all_cases_href.split("?", 2)[1]);
    const reopened = filterAnalyticalContracts(PROJECTION, {
      agency: query.get("ap_agency"),
      registration_fiscal_year: query.get("ap_fy"),
      industry: query.get("ap_industry"),
      award_method: query.get("ap_award_method"),
    });
    assert.equal(registrationTimingSummary(reopened).total_contract_count, expected.contract_count);
    const afterStart = new URLSearchParams(history.after_start_cases_href.split("?", 2)[1]);
    const reopenedLate = filterAnalyticalContracts(PROJECTION, {
      agency: afterStart.get("ap_agency"),
      registration_fiscal_year: afterStart.get("ap_fy"),
      industry: afterStart.get("ap_industry"),
      award_method: afterStart.get("ap_award_method"),
      retroactive: afterStart.get("retroactive"),
    });
    assert.equal(reopenedLate.length, expected.after_start_count);
  });

  it("preserves the comparison across the shared scope hash on the way back", () => {
    const expected = cohort("parks_construction_bid");
    const history = buyerContractingHistory(PROJECTION, {
      agency: expected.buyer,
      registration_fiscal_year: 2026,
      industry: expected.industry,
      award_method: expected.award_method,
    });
    const source = `/browse/contracts/${history.all_cases_href.split("?", 2)[1] ? `?${history.all_cases_href.split("?", 2)[1]}` : ""}`;
    const preserved = preserveAnalyticalProjectionQuery(source, "#money");
    const query = new URLSearchParams(preserved.split("?", 2)[1]);
    assert.equal(query.get("ap_agency"), expected.buyer);
    assert.equal(query.get("ap_industry"), expected.industry);
    assert.equal(query.get("ap_award_method"), expected.award_method);
    assert.equal(query.get("ap_fy"), "2026");
  });

  it("does not merge a shared procurement identifier into one instrument", () => {
    // A shared PIN is a procurement family relationship, not a licence to copy
    // dates between two differently identified contract instruments.
    const href = analyticalDrillThroughHref({ agency: "Department of Transportation", registration_fiscal_year: 2026 });
    assert.ok(!href.includes("pin="));
    assert.ok(href.includes("ap_agency="));
  });
});
