import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectProcurementFacts } from "../site/procurement_fact_projection.mjs";
import { renderProcurementDocument } from "../site/procurement_document.mjs";
import {
  paymentEvidenceFromLifecycle,
  reconcilePaymentCoverageProjection,
  resolveScopedPaymentSummary,
} from "../site/procurement_payment_place_context.mjs";
import procurementContractLifecycleMaterialization from "../site/data/procurement_contract_lifecycle.json" with { type: "json" };

const EMMONS_LIFECYCLE = JSON.parse(readFileSync(new URL(
  "./fixtures/exact-contract-payment-place/emmons_lifecycle.json",
  import.meta.url,
)));

const BHRAGS_RETAINED = JSON.parse(readFileSync(new URL(
  "./fixtures/exact-contract-payment-place/bhrags_retained_observations.json",
  import.meta.url,
)));

function bhragsObjectAndObservations() {
  return {
    object: BHRAGS_RETAINED.object,
    observations: BHRAGS_RETAINED.observations,
  };
}

function paidEntriesFrom(observations) {
  const projection = projectProcurementFacts({ identity_keys: {} }, observations);
  return projection.entries.filter((entry) => entry.kind === "paid_amount");
}

test("A1: scoped summary prefers lifecycle paid and keeps PASSPort paid plus encumbered distinct", () => {
  const { object, observations } = bhragsObjectAndObservations();
  const passport = observations.find((entry) => entry.source_system === "passport_public_contracts");
  assert.equal(passport.snapshot.paid_amount, 7319455.51);
  assert.equal(passport.snapshot.encumbered_amount, 7319455.52);
  assert.equal(passport.ingested_at, "2026-09-09T06:33:01.880Z");

  const evidence = paymentEvidenceFromLifecycle(EMMONS_LIFECYCLE);
  assert.equal(evidence.total_spent, 7385672.19);
  assert.equal(evidence.total_payments, 31);
  assert.equal(evidence.latest_payment_date, "2026-08-06");
  assert.equal(evidence.latest_payment_amount, 66216.68);
  assert.equal(evidence.acquisition_observed_at, "2026-09-14T13:10:41.533Z");

  const summary = resolveScopedPaymentSummary({
    paidEntries: paidEntriesFrom(observations),
    paymentEvidence: evidence,
    encumberedAmount: passport.snapshot.encumbered_amount,
  });
  assert.equal(summary.paidAmount, 7385672.19);
  assert.equal(summary.encumberedAmount, 7319455.52);
  assert.equal(summary.primary.scope, "exact_contract_lifecycle");
  assert.equal(summary.alternatePaidObservations.length >= 1, true);
  const retained = summary.alternatePaidObservations.find((entry) => (
    entry.source_system === "passport_public_contracts" && entry.value === 7319455.51
  ));
  assert.ok(retained, "old PASSPort paid observation must remain attributable");
  assert.equal(retained.observation_vintage, "2026-09-09T06:33:01.880Z");

  const html = renderProcurementDocument(object, observations, {
    contractLifecycleMaterialization: procurementContractLifecycleMaterialization,
  });
  assert.match(html, /Paid amount<\/dt><dd>\$7,385,672\.19/);
  assert.match(html, /data-payment-total-spent="7385672\.19"/);
  assert.match(html, /Encumbered amount<\/dt><dd>\$7,319,455\.52/);
  assert.doesNotMatch(html, /Paid amount<\/dt><dd>\$7,319,455\.51/);
  assert.match(html, /data-retained-paid-amount="7319455\.51"/);
  assert.match(html, /data-retained-paid-source="passport_public_contracts"/);
  assert.match(html, /data-retained-paid-vintage="2026-09-09T06:33:01\.880Z"/);
  assert.match(html, /data-payment-acquisition-at="2026-09-14T13:10:41\.533Z"/);
  assert.match(html, /data-latest-payment-amount="66216\.68"/);
  assert.match(html, /data-payment-total-count="31"/);
});

test("A2: analytics spending miss stays scoped and dated beside exact-contract payments", () => {
  const { object, observations } = bhragsObjectAndObservations();
  const html = renderProcurementDocument(object, observations, {
    contractLifecycleMaterialization: procurementContractLifecycleMaterialization,
  });
  const spending = html.match(/data-source-system="checkbook_spending"[\s\S]*?<\/li>/)?.[0] || "";
  assert.match(spending, /data-coverage-state="checked-no-match"/);
  assert.match(spending, /No exact match in analytics spending lookup/);
  assert.match(spending, /Checked 2026-08-26/);
  assert.match(spending, /separate analytics population, not exact-contract payments/);
  assert.doesNotMatch(spending, /data-coverage-state="corroborated"/);
  assert.doesNotMatch(html, /had no exact payment match in this snapshot/);
  assert.match(html, /data-procurement-payment-evidence="1"/);
  assert.match(html, /data-payment-total-spent="7385672\.19"/);

  const reconciled = reconcilePaymentCoverageProjection({
    sources: [{
      source_system: "checkbook_spending",
      source_name: "Checkbook NYC spending",
      state: "checked-no-match",
      state_label: "No exact match in this lookup",
      observation_context: "Checked 2026-08-26",
      consequential: true,
    }],
    claim_caveats: [{
      claim: "paid_amount",
      source_system: "checkbook_spending",
      state: "checked-no-match",
      text: "Checkbook NYC spending had no exact payment match in this snapshot. That is a miss in the lookup, not a paid total of zero.",
    }],
  }, paymentEvidenceFromLifecycle(EMMONS_LIFECYCLE));
  assert.equal(reconciled.claim_caveats.length, 0);
  assert.equal(reconciled.sources[0].state, "checked-no-match");
  assert.equal(reconciled.sources[0].state_label, "No exact match in analytics spending lookup");
  assert.match(reconciled.sources[0].observation_context, /Checked 2026-08-26/);
});

test("A3: zero, missing, newer-lower, incomparable, unavailable lifecycle, and absent dates", () => {
  // Explicit zero from lifecycle is kept (no truthiness skip).
  const zero = resolveScopedPaymentSummary({
    paidEntries: [{
      kind: "paid_amount",
      value: 100,
      source_system: "passport_public_contracts",
      source_observation_ref: "passport:old",
      observation_vintage: "2026-01-01T00:00:00.000Z",
    }],
    paymentEvidence: {
      total_spent: 0,
      total_payments: 0,
      payment_population: "exact contract_id spending rows",
      acquisition_observed_at: "2026-09-14T13:10:41.533Z",
      payment_as_of: "2026-08-06",
      payment_rows: [],
    },
  });
  assert.equal(zero.paidAmount, 0);
  assert.equal(zero.primary.scope, "exact_contract_lifecycle");

  // Missing paid stays missing.
  const missing = resolveScopedPaymentSummary({
    paidEntries: [],
    paymentEvidence: null,
  });
  assert.equal(missing.paidAmount, null);
  assert.equal(missing.primary, null);

  // Newer lower total due to corrections: vintage wins within one scope, not max value.
  const corrected = resolveScopedPaymentSummary({
    paidEntries: [
      {
        kind: "paid_amount",
        value: 900,
        source_system: "passport_public_contracts",
        source_observation_ref: "passport:older-higher",
        observation_vintage: "2026-01-01T00:00:00.000Z",
      },
      {
        kind: "paid_amount",
        value: 700,
        source_system: "passport_public_contracts",
        source_observation_ref: "passport:newer-lower",
        observation_vintage: "2026-08-01T00:00:00.000Z",
      },
    ],
    paymentEvidence: null,
  });
  assert.equal(corrected.paidAmount, 700);
  assert.notEqual(corrected.paidAmount, 900);

  // Incomparable periods / scopes without lifecycle: keep source-priority choice,
  // never max across scopes.
  const incomparable = resolveScopedPaymentSummary({
    paidEntries: [
      {
        kind: "paid_amount",
        value: 100,
        source_system: "passport_public_contracts",
        source_observation_ref: "passport:a",
        observation_vintage: "2026-01-01T00:00:00.000Z",
      },
      {
        kind: "paid_amount",
        value: 999999,
        source_system: "checkbook_contracts",
        source_observation_ref: "checkbook:b",
        observation_vintage: "2026-09-01T00:00:00.000Z",
      },
    ],
    paymentEvidence: null,
  });
  assert.equal(incomparable.paidAmount, 100);
  assert.notEqual(incomparable.paidAmount, 999999);

  // Unavailable lifecycle falls back to retained observation.
  const unavailable = resolveScopedPaymentSummary({
    paidEntries: [{
      kind: "paid_amount",
      value: 7319455.51,
      source_system: "passport_public_contracts",
      source_observation_ref: "passport:bhrags",
      observation_vintage: "2026-09-09T06:33:01.880Z",
    }],
    paymentEvidence: null,
  });
  assert.equal(unavailable.paidAmount, 7319455.51);
  assert.equal(unavailable.primary.scope, "retained_source_observation");

  // Absent dates do not invent or freshen vintages; older higher is not chosen by max.
  const undated = resolveScopedPaymentSummary({
    paidEntries: [
      {
        kind: "paid_amount",
        value: 50,
        source_system: "passport_public_contracts",
        source_observation_ref: "passport:first",
      },
      {
        kind: "paid_amount",
        value: 5000,
        source_system: "passport_public_contracts",
        source_observation_ref: "passport:second-undated-higher",
      },
    ],
    paymentEvidence: null,
  });
  assert.equal(undated.paidAmount, 50);
  assert.equal(undated.primary.observation_vintage, null);

  // Projection itself must not prefer max paid across same-priority undated rows.
  const projection = projectProcurementFacts({ identity_keys: {} }, [
    {
      source_system: "passport_public_contracts",
      source_observation_ref: "passport:first",
      ingested_at: "2026-02-01T00:00:00.000Z",
      snapshot: { paid_amount: 50, encumbered_amount: 60 },
    },
    {
      source_system: "passport_public_contracts",
      source_observation_ref: "passport:later-lower",
      ingested_at: "2026-08-01T00:00:00.000Z",
      snapshot: { paid_amount: 40, encumbered_amount: 60 },
    },
  ]);
  assert.equal(projection.facts.paidAmount, 40);
  assert.equal(projection.facts.encumberedAmount, 60);
  assert.equal(
    projection.entries.find((entry) => entry.kind === "paid_amount").observation_vintage,
    "2026-08-01T00:00:00.000Z",
  );
});
