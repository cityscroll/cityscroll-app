import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONTRACT_SUBSTANCE_SCHEMA,
  EVIDENCE_ROLES,
  FACT_KINDS,
  PROJECTOR_VERSION,
  RESIDENT_VENDOR_PROMISE_LABEL,
  STANDING_LABELS,
  UNRESOLVED_REASONS,
  applyAmendment,
  assessPassageForProjection,
  buildContractSubstanceDocument,
  deskUnresolvedRows,
  normalizeCitation,
  projectContractSubstance,
  projectObligation,
  projectPriceTerm,
  projectScopeFact,
  refuseManufacturedRate,
  residentClaimLabel,
  residentPositiveAssertions,
  resolveConflictingPassages,
  unresolvedFromAccessObservations,
} from "../site/procurement_contract_substance.mjs";
import {
  ACCESS_STATES,
  FIXED_CONTRACT_IDS,
} from "../site/procurement_contract_substance_access.mjs";

const MATERIALIZED = JSON.parse(readFileSync(
  new URL("../site/data/procurement_contract_substance.json", import.meta.url),
  "utf8",
));

const PUBLIC_HASH = `sha256:${"cd".repeat(32)}`;
const CONTRACT_ID = "CT107120258801626";

function citationBase(overrides = {}) {
  return {
    contract_id: CONTRACT_ID,
    source_document_id: "doc-executed-scope-1",
    content_hash: PUBLIC_HASH,
    publication_date: "2024-08-29",
    locator: "page 3 / section 2.1 Scope of Services",
    excerpt: "The Contractor shall provide home care services to eligible residents within the service area during the contract term.",
    public_url: "https://www.nyc.gov/assets/example/executed-contract.pdf",
    document_role: EVIDENCE_ROLES.EXECUTED_SCOPE,
    ...overrides,
  };
}

function scopeCandidate(overrides = {}) {
  return {
    ...citationBase(),
    subject: "home care services",
    action: "provide",
    object: "eligible residents",
    exclusions: "services outside the named service area",
    period: "2024-09-01 to 2027-08-31",
    ...overrides,
  };
}

function priceCandidate(overrides = {}) {
  return {
    ...citationBase({
      source_document_id: "doc-pricing-1",
      document_role: EVIDENCE_ROLES.PRICING_SCHEDULE,
      locator: "page 12 / Rate Schedule A",
      excerpt: "Unit price: $45.00 per attendant hour, not to exceed 40 hours per week.",
    }),
    payment_basis: "unit_price",
    description: "attendant hour",
    quantity: 1,
    unit: "hour",
    rate: 45,
    maximum: null,
    period: "contract term",
    option_period: "one 12-month option",
    conditions: "not to exceed 40 hours per week",
    ...overrides,
  };
}

function obligationCandidate(overrides = {}) {
  return {
    ...citationBase({
      source_document_id: "doc-obligation-1",
      document_role: EVIDENCE_ROLES.EXECUTED_OBLIGATION,
      locator: "page 5 / section 4.2 Deliverables",
      excerpt: "The vendor shall deliver monthly staffing reports to the Agency by the tenth business day of each month.",
    }),
    obligated_party: "vendor",
    action: "deliver",
    deliverable: "monthly staffing reports",
    quantity: 1,
    frequency: "monthly",
    deadline: "tenth business day of each month",
    period: "contract term",
    condition: "reports must identify assigned attendants",
    ...overrides,
  };
}

test("A1: scope rows carry subject, action/object, exclusions, period, role, locator, excerpt, document identity/hash, and contract identity", () => {
  const result = projectScopeFact(scopeCandidate());
  assert.equal(result.ok, true);
  const fact = result.fact;
  assert.equal(fact.kind, FACT_KINDS.SCOPE_FACT);
  assert.equal(fact.contract_id, CONTRACT_ID);
  assert.equal(fact.subject, "home care services");
  assert.equal(fact.action, "provide");
  assert.equal(fact.object, "eligible residents");
  assert.equal(fact.exclusions, "services outside the named service area");
  assert.equal(fact.period, "2024-09-01 to 2027-08-31");
  assert.equal(fact.document_role, EVIDENCE_ROLES.EXECUTED_SCOPE);
  assert.equal(fact.locator, "page 3 / section 2.1 Scope of Services");
  assert.match(fact.excerpt, /home care services/);
  assert.equal(fact.source_document_id, "doc-executed-scope-1");
  assert.equal(fact.content_hash, PUBLIC_HASH);
  assert.equal(fact.standing_label, STANDING_LABELS.EXECUTED);
  assert.equal(fact.resident_assertion, true);
});

test("A2: pricing rows preserve payment basis and available components without deriving missing ones", () => {
  const full = projectPriceTerm(priceCandidate());
  assert.equal(full.ok, true);
  assert.equal(full.fact.payment_basis, "unit_price");
  assert.equal(full.fact.description, "attendant hour");
  assert.equal(full.fact.quantity, 1);
  assert.equal(full.fact.unit, "hour");
  assert.equal(full.fact.rate, 45);
  assert.equal(full.fact.maximum, null);
  assert.equal(full.fact.period, "contract term");
  assert.equal(full.fact.option_period, "one 12-month option");
  assert.equal(full.fact.conditions, "not to exceed 40 hours per week");

  // Missing rate stays null rather than being invented from a total.
  const partial = projectPriceTerm(priceCandidate({
    rate: null,
    quantity: 10,
    unit: "hour",
    contract_total: 450,
  }));
  assert.equal(partial.ok, true);
  assert.equal(partial.fact.rate, null);
  assert.equal(partial.fact.quantity, 10);
  assert.equal(partial.fact.unit, "hour");
});

test("A3: obligation rows preserve party, action, deliverable, quantity/frequency, deadline/period, condition; only executed roles say the vendor promised", () => {
  const result = projectObligation(obligationCandidate());
  assert.equal(result.ok, true);
  const fact = result.fact;
  assert.equal(fact.obligated_party, "vendor");
  assert.equal(fact.action, "deliver");
  assert.equal(fact.deliverable, "monthly staffing reports");
  assert.equal(fact.quantity, 1);
  assert.equal(fact.frequency, "monthly");
  assert.equal(fact.deadline, "tenth business day of each month");
  assert.equal(fact.period, "contract term");
  assert.equal(fact.condition, "reports must identify assigned attendants");
  assert.equal(fact.standing_label, STANDING_LABELS.VENDOR_PROMISED);
  assert.equal(fact.document_role, EVIDENCE_ROLES.EXECUTED_OBLIGATION);

  const solicitationAsPromise = projectObligation(obligationCandidate({
    document_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
    standing_label: STANDING_LABELS.VENDOR_PROMISED,
  }));
  assert.equal(solicitationAsPromise.ok, false);
  assert.equal(solicitationAsPromise.fact, null);
  assert.equal(solicitationAsPromise.unresolved.reason, UNRESOLVED_REASONS.DISQUALIFIED_SOURCE);
  assert.equal(
    solicitationAsPromise.unresolved.details?.refused_role,
    EVIDENCE_ROLES.SOLICITATION_SCOPE,
  );
});

test("A4: solicitation/RFx is advertised or requested, never executed; descriptions, titles, payments, and evaluations cannot create obligations", () => {
  const advertised = projectScopeFact(scopeCandidate({
    document_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
    source_document_id: "doc-rfx-1",
    excerpt: "The City requests proposals for home care services as described in this solicitation.",
  }));
  assert.equal(advertised.ok, true);
  assert.equal(advertised.fact.standing_label, STANDING_LABELS.ADVERTISED);
  assert.notEqual(advertised.fact.standing_label, STANDING_LABELS.EXECUTED);
  assert.notEqual(advertised.fact.standing_label, STANDING_LABELS.VENDOR_PROMISED);

  const refusals = [
    { document_role: "project_description" },
    { document_role: "contract_title" },
    { document_role: "payment_row" },
    { document_role: EVIDENCE_ROLES.PERFORMANCE_EVALUATION },
    { document_role: EVIDENCE_ROLES.INVOICE_OR_ACCEPTANCE },
  ];
  for (const refusal of refusals) {
    const result = projectObligation(obligationCandidate(refusal));
    assert.equal(result.ok, false, JSON.stringify(refusal));
    assert.equal(result.unresolved.reason, UNRESOLVED_REASONS.DISQUALIFIED_SOURCE);
    assert.equal(result.fact, null);
  }
});

test("A5: totals are never divided to invent unit prices; amendments link to the affected term and retain the prior version", () => {
  assert.deepEqual(
    refuseManufacturedRate({
      derive_rate_from_total: true,
      contract_total: 1000,
      quantity: 10,
    }),
    [UNRESOLVED_REASONS.MANUFACTURED_RATE],
  );
  assert.deepEqual(
    refuseManufacturedRate({
      rate_source: "total_divided_by_payments",
      contract_total: 1000,
    }),
    [UNRESOLVED_REASONS.MANUFACTURED_RATE],
  );
  assert.deepEqual(
    refuseManufacturedRate({
      derived_rate: { total: 900, divisor: 30, operation: "divide" },
    }),
    [UNRESOLVED_REASONS.MANUFACTURED_RATE],
  );

  const manufactured = projectPriceTerm(priceCandidate({
    rate: 100,
    rate_was_derived: true,
    contract_total: 1000,
    quantity: 10,
  }));
  assert.equal(manufactured.ok, false);
  assert.equal(manufactured.unresolved.reason, UNRESOLVED_REASONS.MANUFACTURED_RATE);

  const prior = projectPriceTerm(priceCandidate({
    fact_id: "price:prior:v1",
    rate: 40,
    version: "1",
  }));
  assert.equal(prior.ok, true);

  const amended = applyAmendment({
    prior: prior.fact,
    amendment: priceCandidate({
      fact_id: "price:amended:v2",
      rate: 45,
      locator: "page 1 / Amendment 1 Rate Schedule",
      excerpt: "Amendment 1 revises the attendant hour rate to $45.00.",
      source_document_id: "doc-amendment-1",
      publication_date: "2025-01-15",
    }),
  });
  assert.equal(amended.ok, true);
  assert.equal(amended.prior.fact_id, "price:prior:v1");
  assert.equal(amended.prior.rate, 40);
  assert.equal(amended.prior.superseded_by_fact_id, "price:amended:v2");
  assert.equal(amended.amended.supersedes_fact_id, "price:prior:v1");
  assert.equal(amended.amended.rate, 45);
  assert.equal(amended.amended.standing_label, STANDING_LABELS.AMENDED);
  assert.equal(amended.amended.document_role, EVIDENCE_ROLES.AMENDMENT);
  // Prior version is retained, not erased.
  assert.equal(amended.prior.status, "admitted");
  assert.equal(amended.prior.resident_assertion, true);
});

test("A6: empty text, low-quality extraction, and conflicting passages produce Desk unresolved rows with no positive resident assertion; no OCR engine is added", () => {
  const empty = assessPassageForProjection({ text: "" });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, UNRESOLVED_REASONS.EMPTY_TEXT_LAYER);

  const unreadable = assessPassageForProjection({
    text: "",
    ocr_required: true,
    ocr_engine_available: false,
  });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, UNRESOLVED_REASONS.UNREADABLE_NO_OCR);
  assert.equal(unreadable.quality.measured, false);

  const lowQuality = projectScopeFact(scopeCandidate({
    excerpt: "@@@ ### $$$ %%% ��� □□□ ~~~~",
  }));
  assert.equal(lowQuality.ok, false);
  assert.equal(lowQuality.unresolved.reason, UNRESOLVED_REASONS.LOW_QUALITY_EXTRACTION);
  assert.equal(lowQuality.unresolved.desk_reviewable, true);
  assert.equal(lowQuality.unresolved.resident_assertion, false);

  const conflict = resolveConflictingPassages([
    scopeCandidate({
      fact_id: "scope:a",
      excerpt: "The Contractor shall provide home care services on weekdays only.",
      action: "provide weekdays",
    }),
    scopeCandidate({
      fact_id: "scope:b",
      excerpt: "The Contractor shall provide home care services seven days per week.",
      action: "provide seven days",
      locator: "page 4 / section 2.1 Scope of Services",
    }),
  ], { kind: FACT_KINDS.SCOPE_FACT });
  assert.equal(conflict.admitted.length, 0);
  assert.equal(conflict.unresolved.length, 1);
  assert.equal(conflict.unresolved[0].reason, UNRESOLVED_REASONS.CONFLICTING_PASSAGES);
  assert.equal(conflict.unresolved[0].desk_reviewable, true);
  assert.equal(conflict.unresolved[0].resident_assertion, false);

  const document = buildContractSubstanceDocument({
    scopeFacts: [],
    priceTerms: [],
    obligations: [],
    unresolved: conflict.unresolved,
    generatedAt: "2026-09-18T19:15:00.000Z",
  });
  assert.equal(residentPositiveAssertions(document).length, 0);
  assert.equal(deskUnresolvedRows(document).length, 1);

  // No OCR engine is wired into this module.
  const source = readFileSync(new URL("../site/procurement_contract_substance.mjs", import.meta.url), "utf8");
  assert.ok(!/tesseract|pytesseract|google\.cloud\.vision|\btextract\b/i.test(source));

  // Materialized fixed-contract document has no positive assertions.
  assert.equal(MATERIALIZED.schema, CONTRACT_SUBSTANCE_SCHEMA);
  assert.deepEqual(MATERIALIZED.fixed_contract_ids, [...FIXED_CONTRACT_IDS]);
  assert.equal(MATERIALIZED.scope_facts.length, 0);
  assert.equal(MATERIALIZED.price_terms.length, 0);
  assert.equal(MATERIALIZED.obligations.length, 0);
  assert.ok(MATERIALIZED.unresolved.length >= 1);
  assert.equal(residentPositiveAssertions(MATERIALIZED).length, 0);
  for (const row of deskUnresolvedRows(MATERIALIZED)) {
    assert.equal(row.resident_assertion, false);
    assert.equal(row.desk_reviewable, true);
  }
});

test("A7: mutations removing document role, contract identity, page locator, and quantity/unit refuse unsupported wording and manufactured rates", () => {
  assert.equal(normalizeCitation(citationBase({ document_role: null })).ok, false);
  assert.equal(normalizeCitation(citationBase({ contract_id: "" })).ok, false);
  assert.equal(normalizeCitation(citationBase({ locator: "" })).ok, false);
  assert.ok(normalizeCitation(citationBase({ document_role: null })).missing.includes("document_role"));
  assert.ok(normalizeCitation(citationBase({ contract_id: null })).missing.includes("contract_identity"));
  assert.ok(normalizeCitation(citationBase({ locator: null })).missing.includes("page_locator"));

  assert.equal(projectScopeFact(scopeCandidate({ document_role: null })).ok, false);
  assert.equal(projectScopeFact(scopeCandidate({ contract_id: null })).ok, false);
  assert.equal(projectScopeFact(scopeCandidate({ locator: "" })).ok, false);

  assert.equal(projectPriceTerm(priceCandidate({
    quantity: 10,
    unit: null,
    require_quantity_unit_pair: true,
  })).ok, false);

  assert.equal(projectPriceTerm(priceCandidate({
    rate: 50,
    derived_rate: { total: 500, divisor: 10, operation: "divide" },
  })).ok, false);

  assert.equal(projectObligation(obligationCandidate({
    document_role: "title",
  })).ok, false);

  assert.equal(projectObligation(obligationCandidate({
    standing_label: STANDING_LABELS.VENDOR_PROMISED,
    document_role: EVIDENCE_ROLES.SOLICITATION_SCOPE,
  })).ok, false);

  const accessUnresolved = unresolvedFromAccessObservations([
    {
      contract_id: CONTRACT_ID,
      document_role: "executed_contract",
      access_state: ACCESS_STATES.ACCOUNT_GATED,
      checked_source_ids: ["passport-public"],
      observed_at: "2026-09-18T19:15:00.000Z",
    },
  ]);
  assert.equal(accessUnresolved.length, 1);
  assert.equal(accessUnresolved[0].reason, UNRESOLVED_REASONS.ACCESS_NOT_PUBLIC);
  assert.equal(accessUnresolved[0].resident_assertion, false);

  const projected = projectContractSubstance({
    scopeCandidates: [scopeCandidate()],
    priceCandidates: [priceCandidate()],
    obligationCandidates: [obligationCandidate()],
  });
  assert.equal(projected.scope_facts.length, 1);
  assert.equal(projected.price_terms.length, 1);
  assert.equal(projected.obligations.length, 1);
  assert.equal(projected.obligations[0].standing_label, STANDING_LABELS.VENDOR_PROMISED);
});

test("role-corpus A6: proposed, prior-term, bid, template, audit, title, payment, and project-summary evidence cannot produce What the vendor promised; rates are not manufactured by division", () => {
  const forbiddenRoles = [
    EVIDENCE_ROLES.PROPOSED_AGREEMENT,
    EVIDENCE_ROLES.PRIOR_TERM,
    EVIDENCE_ROLES.BID_TAB,
    EVIDENCE_ROLES.TEMPLATE_PRICING,
    EVIDENCE_ROLES.PERFORMANCE_EVALUATION,
    EVIDENCE_ROLES.TITLE,
    EVIDENCE_ROLES.PAYMENT,
    EVIDENCE_ROLES.PROJECT_SUMMARY,
  ];
  for (const role of forbiddenRoles) {
    const label = residentClaimLabel({
      document_role: role,
      standing_label: STANDING_LABELS.VENDOR_PROMISED,
    });
    assert.notEqual(label, RESIDENT_VENDOR_PROMISE_LABEL, role);
  }

  assert.equal(
    residentClaimLabel({
      document_role: EVIDENCE_ROLES.EXECUTED_OBLIGATION,
      standing_label: STANDING_LABELS.VENDOR_PROMISED,
    }),
    RESIDENT_VENDOR_PROMISE_LABEL,
  );

  for (const rateSource of [
    "total_divided_by_duration",
    "total_divided_by_capacity",
    "total_divided_by_meals",
    "total_divided_by_sites",
    "total_divided_by_payments",
  ]) {
    assert.deepEqual(
      refuseManufacturedRate({ rate_source: rateSource }),
      [UNRESOLVED_REASONS.MANUFACTURED_RATE],
      rateSource,
    );
  }

  const bid = projectPriceTerm(priceCandidate({
    document_role: EVIDENCE_ROLES.BID_TAB,
    source_document_id: "dcas-bid-tab-2000090",
    locator: "PDF page 1 / item 1",
    excerpt: "POT PAN & UTENSIL WASHER item 1 offered unit price 22287.0000000",
  }));
  assert.equal(bid.ok, true);
  assert.equal(bid.fact.standing_label, STANDING_LABELS.BID_OFFER);
  assert.equal(bid.fact.resident_claim_label, "Bid offer");
  assert.equal(bid.fact.projector_version, PROJECTOR_VERSION);
  assert.match(bid.fact.excerpt_hash, /^sha256:[a-f0-9]{64}$/);

  const audit = projectPriceTerm(priceCandidate({
    document_role: EVIDENCE_ROLES.PERFORMANCE_EVALUATION,
    source_document_id: "comptroller-docgo-audit-20248801671",
    locator: "section Audit Report / food caps",
    excerpt: "food was to be billed at an actual cost not to exceed $11 per meal or $33 per person per day",
    payment_basis: "not_to_exceed",
    maximum: 11,
    rate: null,
  }));
  assert.equal(audit.ok, true);
  assert.equal(audit.fact.standing_label, STANDING_LABELS.AUDIT_REPORTED);
  assert.equal(audit.fact.resident_claim_label, "The audit reports these contract terms");
});
