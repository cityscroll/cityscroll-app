import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProcurementSourceLookupProjection,
  buildProcurementSourceLookupReceipt,
} from "../site/procurement_source_lookup_receipt.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const FIXTURE_CLOCK = "2026-09-15T12:00:00.000Z";

const obs = (system, id, snapshot) => ({ source_system: system, source_system_id: id, source_observation_ref: `${system}:${id}`, snapshot });

test("exact Checkbook analytical evidence is retained without changing identity", () => {
  const receipt = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:CT107120258801626", identity_keys: { contract_ids: ["CT107120258801626"], epins: ["84124P0003001"] } },
    observations: [obs("passport_public_contracts", "contract:84124P0003001:CT107120258801626", { contract_id: "CT107120258801626", epin: "84124P0003001" })],
    materializations: { analytics_registered_contracts: { status: "available", snapshot_date: "2026-09-09", generated_at: "2026-09-09T06:33:01Z", rows: [{ prime_contract_id: "CT107120258801626", pin: "84124P0003001" }] } },
    generatedAt: "2026-09-14T00:00:00Z",
  });
  const checkbook = receipt.sources.find((row) => row.source_system === "checkbook_contracts");
  assert.equal(checkbook.state, "corroborated");
  assert.deepEqual(checkbook.matched_analytical_row_refs, ["checkbook_contracts:row:CT107120258801626"]);
  assert.equal(checkbook.snapshot_vintage, "2026-09-09");
  assert.equal(checkbook.key_normalization, "uppercase alphanumeric characters");
  assert.equal(checkbook.denominator, 1);
  assert.equal(checkbook.usable_key_count, 1);
  assert.equal(checkbook.source_acquisition_at, "2026-09-09T06:33:01Z");
});

test("unavailable sources and ordinary NYC ABO objects stay unresolved or inapplicable", () => {
  const receipt = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:DHS-1", identity_keys: { contract_ids: ["DHS-1"] } },
    observations: [obs("passport_public_contracts", "dhs", { contract_id: "DHS-1", agency: "Department of Homeless Services" })],
    materializations: { checkbook_spending: { status: "unavailable", generated_at: "2026-09-14T00:00:00Z" } },
    generatedAt: "2026-09-14T00:00:00Z",
  });
  assert.equal(receipt.sources.find((row) => row.source_system === "checkbook_spending").state, "unavailable");
  assert.equal(receipt.sources.find((row) => row.source_system === "nys_abo_awards").applicability, "not-applicable");
  assert.equal(receipt.sources.find((row) => row.source_system === "nys_abo_awards").state, "not-applicable");
  assert.equal(receipt.sources.find((row) => row.source_system === "nys_abo_awards").lookup_as_of, undefined);
});

test("duplicate representations corroborate one identity and retain all references", () => {
  const receipt = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:CT-1", identity_keys: { contract_ids: ["CT-1"] } },
    observations: [obs("checkbook_contracts", "a", { contract_id: "CT-1" }), obs("checkbook_contracts", "b", { contract_id: "CT-1" })],
    generatedAt: "2026-09-14T00:00:00Z",
  });
  const checkbook = receipt.sources.find((row) => row.source_system === "checkbook_contracts");
  assert.equal(checkbook.state, "corroborated");
  assert.deepEqual(checkbook.matched_source_observation_refs, ["checkbook_contracts:a", "checkbook_contracts:b"]);
  assert.deepEqual(checkbook.matched_identity_keys, ["contract:CT1"]);
});

test("distinct exact contract identities sharing a PIN remain ambiguous", () => {
  const receipt = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:PIN-COLLISION", identity_keys: { epins: ["PIN-1"] } },
    observations: [
      obs("passport_public_contracts", "a", { contract_id: "FMS-1", epin: "PIN-1" }),
      obs("passport_public_contracts", "b", { contract_id: "FMS-2", epin: "PIN-1" }),
    ],
    generatedAt: "2026-09-14T00:00:00Z",
  });
  const passport = receipt.sources.find((row) => row.source_system === "passport_public_contracts");
  assert.equal(passport.state, "ambiguous");
  assert.deepEqual(passport.matched_identity_keys, ["contract:FMS1", "contract:FMS2"]);
  assert.deepEqual(passport.matched_source_observation_refs, ["passport_public_contracts:a", "passport_public_contracts:b"]);
});

test("A1 named assertion: S&P, AHA, and QUIZIZZ duplicate representations corroborate one contract", () => {
  for (const contractId of ["CT110220271400991", "AHA-TRAINING-1", "QUIZIZZ-1"]) {
    const receipt = buildProcurementSourceLookupReceipt({
      object: { procurement_id: `procurement:contract:${contractId}`, identity_keys: { contract_ids: [contractId] } },
      observations: [
        obs("checkbook_contracts", `${contractId}:source`, { contract_id: contractId }),
        obs("checkbook_contracts", `${contractId}:payment-1`, { contract_id: contractId, payment_id: "PAY-1" }),
        obs("checkbook_contracts", `${contractId}:payment-2`, { contract_id: contractId, payment_id: "PAY-2" }),
      ],
      materializations: {
        analytics_registered_contracts: {
          status: "available",
          rows: [{ prime_contract_id: contractId }],
        },
      },
      generatedAt: FIXTURE_CLOCK,
    });
    const checkbook = receipt.sources.find((row) => row.source_system === "checkbook_contracts");
    assert.equal(checkbook.state, "corroborated", contractId);
    assert.deepEqual(checkbook.matched_identity_keys, [`contract:${contractId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`], contractId);
    assert.equal(checkbook.matched_source_observation_refs.length, 3, contractId);
    assert.equal(checkbook.matched_analytical_row_refs.length, 1, contractId);

    const payments = buildProcurementSourceLookupReceipt({
      object: { procurement_id: `procurement:contract:${contractId}`, identity_keys: { contract_ids: [contractId] } },
      observations: [
        obs("checkbook_spending", `${contractId}:payment-1`, { contract_id: contractId, payment_id: "PAY-1" }),
        obs("checkbook_spending", `${contractId}:payment-2`, { contract_id: contractId, payment_id: "PAY-2" }),
      ],
      materializations: {
        analytics_payments: {
          status: "available",
          rows: [{ prime_contract_id: contractId, document_id: "PAY-1" }, { prime_contract_id: contractId, document_id: "PAY-2" }],
        },
      },
      generatedAt: FIXTURE_CLOCK,
    });
    const spending = payments.sources.find((row) => row.source_system === "checkbook_spending");
    assert.equal(spending.state, "corroborated", `${contractId} payments`);
    assert.deepEqual(spending.matched_identity_keys, [`contract:${contractId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`], `${contractId} payments`);
    assert.equal(spending.matched_source_observation_refs.length, 2, `${contractId} payments`);
  }
});

test("A2 named assertion: base/revision actions stay attributable and PASSPort ctr_id 5778239 corroborates", () => {
  return withPinnedClock(FIXTURE_CLOCK, () => {
    const receipt = buildProcurementSourceLookupReceipt({
      object: {
        procurement_id: "procurement:contract:AHA-5778239",
        identity_keys: { contract_ids: ["5778239"] },
      },
      observations: [
        obs("passport_public_contracts", "base", { contract_id: "5778239", record_kind: "base" }),
        obs("passport_public_contracts", "revision", { contract_id: "5778239", record_kind: "revision" }),
      ],
      generatedAt: FIXTURE_CLOCK,
    });
    const passport = receipt.sources.find((row) => row.source_system === "passport_public_contracts");
    assert.equal(passport.state, "corroborated");
    assert.deepEqual(passport.matched_identity_keys, ["contract:5778239"]);
    assert.deepEqual(passport.matched_source_observation_refs, ["passport_public_contracts:base", "passport_public_contracts:revision"]);
  });
});

test("A3 named assertion: missing QUIZIZZ identifier is not an exhaustive City Record negative", () => {
  const receipt = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:QUIZIZZ-NO-PIN", identity_keys: {} },
    materializations: {
      city_record: {
        status: "available",
        population: "City Record notices with a published contract identifier",
        denominator: 1516,
        usable_key_count: 1498,
        source_acquisition_at: FIXTURE_CLOCK,
        lookup_as_of: FIXTURE_CLOCK,
      },
    },
    generatedAt: FIXTURE_CLOCK,
    lookupAsOf: FIXTURE_CLOCK,
  });
  const cityRecord = receipt.sources.find((row) => row.source_system === "city_record");
  assert.equal(cityRecord.state, "not-checked");
  assert.deepEqual(cityRecord.queried_keys, []);
  assert.equal(cityRecord.denominator, 1516);
  assert.equal(cityRecord.population, "City Record notices with a published contract identifier");
  assert.equal(cityRecord.lookup_as_of, undefined);
});

test("A4 named assertion: missing identifier, stale snapshot, failed source, and no-match remain distinct cases", () => {
  const missing = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:MISSING", identity_keys: {} },
    materializations: { city_record: { status: "available", lookup_as_of: FIXTURE_CLOCK } },
    generatedAt: FIXTURE_CLOCK,
  });
  assert.equal(missing.sources.find((row) => row.source_system === "city_record").state, "not-checked");

  const stale = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:STALE", identity_keys: { contract_ids: ["STALE"] } },
    materializations: { passport_public_contracts: { status: "stale", snapshot_date: "2026-09-01" } },
    generatedAt: FIXTURE_CLOCK,
  });
  assert.equal(stale.sources.find((row) => row.source_system === "passport_public_contracts").state, "stale");

  const failed = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:FAILED", identity_keys: { contract_ids: ["FAILED"] } },
    materializations: { checkbook_contracts: { status: "unavailable", generated_at: FIXTURE_CLOCK } },
    generatedAt: FIXTURE_CLOCK,
  });
  assert.equal(failed.sources.find((row) => row.source_system === "checkbook_contracts").state, "unavailable");

  const noMatch = buildProcurementSourceLookupReceipt({
    object: { procurement_id: "procurement:contract:NO-MATCH", identity_keys: { contract_ids: ["NO-MATCH"] } },
    observations: [],
    materializations: {
      checkbook_contracts: { status: "available", rows: [], lookup_as_of: FIXTURE_CLOCK },
    },
    generatedAt: FIXTURE_CLOCK,
  });
  const checkbook = noMatch.sources.find((row) => row.source_system === "checkbook_contracts");
  assert.equal(checkbook.state, "checked-no-match");
  assert.equal(checkbook.lookup_as_of, FIXTURE_CLOCK);
  assert.equal(checkbook.denominator, null);
  assert.equal(checkbook.population, null);
});

test("A9 named assertion: aggregate receipt states reconcile to the applicable object-source population", () => {
  const projection = buildProcurementSourceLookupProjection({
    objects: [
      { procurement_id: "procurement:contract:CT-1", identity_keys: { contract_ids: ["CT-1"] } },
      { procurement_id: "procurement:contract:CT-2", identity_keys: { contract_ids: ["CT-2"] } },
    ],
    observations: [
      obs("checkbook_contracts", "one", { contract_id: "CT-1" }),
      obs("checkbook_contracts", "two-a", { contract_id: "CT-2" }),
      obs("checkbook_contracts", "two-b", { contract_id: "CT-2" }),
    ],
    materializations: {
      checkbook_contracts: { status: "available", snapshot_date: "2026-09-14", generated_at: "2026-09-14T00:00:00Z" },
      checkbook_spending: { status: "unavailable", generated_at: "2026-09-14T00:00:00Z" },
      passport_public_contracts: { status: "stale", snapshot_date: "2026-09-01" },
    },
    generatedAt: "2026-09-14T00:00:00Z",
  });
  assert.deepEqual(
    Object.keys(projection.counts).sort(),
    ["ambiguous", "checked-no-match", "corroborated", "not-applicable", "not-checked", "stale", "unavailable"].sort(),
  );
  assert.equal(projection.duplicate_key_count, 0);
  assert.equal(projection.missing_key_count, 2);
  assert.equal(projection.applicable_object_source_population.object_count, 2);
  assert.equal(
    projection.applicable_object_source_population.state_count_total,
    projection.applicable_object_source_population.applicable_object_source_count,
  );
  assert.equal(projection.applicable_object_source_population.reconciles, true);
});
