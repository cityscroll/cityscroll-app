import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ABSENCE_REASONS,
  edgeSummaryStateCopy,
  normalizeEdgeSummaryRecord,
  renderEdgeSummaryRail,
} from "../site/edge_summary.mjs";
import {
  buildCommunityBoardConstellationView,
  buildCommunityBoardEdgeSummary,
  renderCommunityBoardConstellationDocument,
} from "../site/community_board_constellation.mjs";
import {
  buildCommunityBoardMoneyCardView,
  buildCommunityBoardMoneyReadModel,
  renderCommunityBoardMoneyCard,
} from "../site/community_board_money.mjs";
import {
  projectProcurementCoverageLabel,
  projectProcurementCoverageSignals,
} from "../site/procurement_coverage_labels.mjs";
import {
  admitComparativeFact,
  projectPublishedStorySignal,
} from "../site/comparative_signal_admission.mjs";
import { buildCommunityBoardConstellationMaterialization } from "../tools/build_community_board_constellation_documents.mjs";

const sourceRegistry = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/source_registry.json", import.meta.url)));
const sourceInventory = JSON.parse(readFileSync(new URL("../site/data/non_council_outcome_sources/board_source_inventory.json", import.meta.url)));
const scorecard = JSON.parse(readFileSync(new URL("../site/data/community_board_minutes_scorecard.json", import.meta.url)));
const geography = JSON.parse(readFileSync(new URL("../site/data/community_board_geography_lookup.json", import.meta.url)));
const sources = { sourceRegistry, sourceInventory, scorecard, geography };

// --- A2: five absence reasons remain distinct in the shared model ---------

test("A2: five absence reasons are distinct constants and survive normalization", () => {
  const reasons = Object.values(ABSENCE_REASONS);
  assert.equal(new Set(reasons).size, 5);
  assert.deepEqual(reasons.sort(), [
    "checked_no_record",
    "recorded_negative",
    "retrieval_failure",
    "unsearched",
    "valid_zero",
  ]);
  for (const reason of reasons) {
    const record = normalizeEdgeSummaryRecord({ state: "empty", target_kind: "meeting", absence_reason: reason });
    assert.equal(record.absence_reason, reason);
  }
  // An unrecognized value never masquerades as a real reason.
  assert.equal(normalizeEdgeSummaryRecord({ absence_reason: "not_a_real_reason" }).absence_reason, null);
  // Untagged records keep the prior, unchanged behavior (no regression).
  assert.equal(normalizeEdgeSummaryRecord({ state: "empty" }).absence_reason, null);
});

test("A2: recorded-negative and retrieval-failure produce distinct resident copy for the same unresolved state", () => {
  const retrievalFailure = { state: "unknown", absence_reason: ABSENCE_REASONS.RETRIEVAL_FAILURE };
  const unsearched = { state: "unknown", absence_reason: ABSENCE_REASONS.UNSEARCHED };
  const untaggedUnknown = { state: "unknown" };
  const recordedNegative = { state: "empty", target_kind: "meeting", absence_reason: ABSENCE_REASONS.RECORDED_NEGATIVE };
  const checkedNoRecord = { state: "empty", target_kind: "meeting" };

  const copies = [retrievalFailure, unsearched, untaggedUnknown, recordedNegative, checkedNoRecord].map(edgeSummaryStateCopy);
  assert.equal(new Set(copies).size, copies.length, `expected distinct copy, got ${JSON.stringify(copies)}`);
  assert.equal(edgeSummaryStateCopy(untaggedUnknown), "Records not shown");
  assert.equal(edgeSummaryStateCopy(retrievalFailure), "Could not be checked from the current source");
  assert.equal(edgeSummaryStateCopy(unsearched), "Not yet checked");
  assert.match(edgeSummaryStateCopy(recordedNegative), /Checked; the source records none/);
  assert.match(edgeSummaryStateCopy(checkedNoRecord), /No meetings or hearings linked yet/);
});

// --- A1: optional empty relations omit standing caveats; nothing else changes ---

test("A1: a redundant unknown rail entry disappears, but an informative one for the same fixture never does", () => {
  const withoutContext = [{ edge_type: "hosts_meeting", target_kind: "meeting", state: "unknown" }];
  const defaultHtml = renderEdgeSummaryRail(withoutContext, { heading: "Connected records" });
  assert.match(defaultHtml, /Records not shown/);

  const omittedHtml = renderEdgeSummaryRail(withoutContext, { heading: "Connected records", omitOptionalUnknown: true });
  assert.equal(omittedHtml, "");

  const matched = [{ edge_type: "hosts_meeting", target_kind: "meeting", state: "matched", count: 3, canonical_href: "/meetings/x", target_name: "Full Board" }];
  const withMatched = renderEdgeSummaryRail(matched, { heading: "Connected records", omitOptionalUnknown: true });
  assert.match(withMatched, /Available: 3 records/);
});

test("A1: the live board document keeps empty categories out of both the per-category list and the connected-objects rail", () => {
  const view = buildCommunityBoardConstellationView("bronx-cb-02", sources);
  const html = renderCommunityBoardConstellationDocument(view);
  const railSection = html.split('<section class="edge-summary-rail')[1] || "";
  assert.doesNotMatch(railSection, /Records not shown/);
  const categorySections = html.split('<section class="edge-summary-rail')[0];
  assert.doesNotMatch(categorySections, /<section[^>]+data-community-board-constellation-category="(committees|meetings|members|recommendations)"/);
  // A single bounded note still says which categories have nothing established yet.
  assert.match(html.replace(/<[^>]+>/g, ""), /Not yet established from checked sources:/);
});

// --- A2 / F2: task-aware absence in Community Board source coverage, without adapter vocabulary ---

test("A2/F2: board source coverage distinguishes retrieval failure, unsearched, and recorded-negative without pipeline vocabulary", () => {
  const { documents } = buildCommunityBoardConstellationMaterialization();
  const html = documents.map(([, doc]) => doc).join("\n");
  const residentHtml = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  assert.match(html, /data-source-absence-reason="retrieval_failure"/);
  assert.match(html, /data-source-absence-reason="unsearched"/);
  assert.match(html, /data-source-absence-reason="recorded_negative"/);
  // Raw pipeline vocabulary must not leak into visible or accessible copy —
  // the payload script (machine JSON, not rendered text) is exempt.
  assert.doesNotMatch(residentHtml, /Not ingested|format not supported/);
  assert.match(residentHtml, /This source could not be checked/);
  assert.match(residentHtml, /Not yet checked/);
  assert.match(residentHtml, /Checked; no dated records found/);
});

test("A2: a genuine zero source count and a checked-but-unmatched relation carry distinct reasons in the model", () => {
  const zeroSources = buildCommunityBoardConstellationView("brooklyn-cb-02", sources);
  const zeroCategory = zeroSources.categories.find((category) => category.id === "sources");
  assert.equal(zeroCategory.count, 0);
  assert.equal(zeroCategory.absence_reason, ABSENCE_REASONS.VALID_ZERO);

  const unmatched = buildCommunityBoardConstellationView("manhattan-cb-06", sources);
  const members = unmatched.categories.find((category) => category.id === "members");
  assert.equal(members.absence_reason, ABSENCE_REASONS.CHECKED_NO_RECORD);

  const edgeSummary = buildCommunityBoardEdgeSummary(unmatched);
  const memberEdge = edgeSummary.find((edge) => edge.target_kind === members.target_kind && edge.relation_label === "People");
  assert.ok(memberEdge, "expected a members edge in the community board edge summary");
});

// --- A3: fiscal-year distinctness, no manufactured balance, unresolved identity never becomes zero spending ---

const budget = {
  schema: "cityscroll.community_board_adopted_budget.v1",
  generated_at: "2026-08-27T00:00:00Z",
  source: { source_system: "expense_budget", pinned_slice: { fiscal_year: 2026 } },
  coverage: { accepted_board_facts: 1 },
  rows: [{ board_id: "test-board", fiscal_year: 2027, adopted_amount: 100000 }],
};
const payments = {
  schema: "cityscroll.community_board_payment_actuals.v1",
  generated_at: "2026-08-27T00:00:00Z",
  source: { source_system: "checkbook_payment_population", endpoint: "https://www.checkbooknyc.com/api" },
  fiscal_years: [2026],
  rows: [
    { board_id: "test-board", fiscal_year: 2026, posted_payment_amount: 5000, payment_count: 2, distinct_payee_count: 1, source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "posted_through_source_vintage" },
    { board_id: "no-identity-board", fiscal_year: 2026, posted_payment_amount: 0, payment_count: 0, distinct_payee_count: 0, source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "identity_unobserved" },
  ],
};

test("A3: budget and payment facts from different fiscal years stay separate and unblended", () => {
  const model = buildCommunityBoardMoneyReadModel({ boards: [{ board_id: "test-board" }], adoptedBudget: budget, paymentActuals: payments, generatedAt: "2026-08-27T00:00:00Z", now: "2026-08-27T00:00:00Z" });
  const card = buildCommunityBoardMoneyCardView(model, "test-board");
  assert.equal(card.state, "separate_fiscal_years");
  assert.equal(card.budget.fiscal_year, 2027);
  assert.equal(card.spending.fiscal_year, 2026);
  const html = renderCommunityBoardMoneyCard(card);
  assert.match(html, /FY2027/);
  assert.match(html, /FY2026/);
  assert.doesNotMatch(html, /remaining|balance|%/i);
});

test("A3: an unresolved payment identity never renders as zero spending, and is its own tagged reason", () => {
  const model = buildCommunityBoardMoneyReadModel({ boards: [{ board_id: "no-identity-board" }], adoptedBudget: null, paymentActuals: payments, generatedAt: "2026-08-27T00:00:00Z", now: "2026-08-27T00:00:00Z" });
  const card = buildCommunityBoardMoneyCardView(model, "no-identity-board");
  assert.equal(card.state, "unmatched_identity");
  assert.equal(card.spending, null);
  const html = renderCommunityBoardMoneyCard(card);
  assert.doesNotMatch(html, /\$0/);
});

test("A2/A3: a materialized zero payment result is tagged valid_zero and is distinct from an unresolved identity", () => {
  const zeroModel = buildCommunityBoardMoneyReadModel({
    boards: [{ board_id: "zero-board" }],
    adoptedBudget: null,
    paymentActuals: { ...payments, rows: [{ board_id: "zero-board", fiscal_year: 2026, posted_payment_amount: 0, payment_count: 0, distinct_payee_count: 0, source_vintage: { payment_issue_date_through: "2026-06-30" }, coverage_status: "empty_source_result" }] },
    generatedAt: "2026-08-27T00:00:00Z",
    now: "2026-08-27T00:00:00Z",
  });
  const zeroCard = buildCommunityBoardMoneyCardView(zeroModel, "zero-board");
  assert.equal(zeroCard.state, "empty_source_result");
  assert.equal(zeroCard.absence_reason, ABSENCE_REASONS.VALID_ZERO);

  const unavailableCard = buildCommunityBoardMoneyCardView(
    buildCommunityBoardMoneyReadModel({ boards: [{ board_id: "unknown-board" }], adoptedBudget: null, paymentActuals: null }),
    "unknown-board",
  );
  assert.equal(unavailableCard.state, "unavailable");
  assert.equal(unavailableCard.absence_reason, ABSENCE_REASONS.RETRIEVAL_FAILURE);
  assert.notEqual(zeroCard.absence_reason, unavailableCard.absence_reason);
});

// --- A4: procurement record-specific signals and comparative negative-control admission are preserved ---

test("A4: procurement coverage labels stay silent for unmapped methods and speak only for matched, informative predicates", () => {
  const silentSignal = projectProcurementCoverageLabel({ publisher_method: "SOME UNKNOWN METHOD", amount: 5000, procurement_category: "goods_and_non_construction_services", occurred_on: "2026-01-01" }, "award");
  assert.equal(silentSignal, null);

  const micropurchase = projectProcurementCoverageLabel({ publisher_method: "MICROPURCHASE", amount: 5000, procurement_category: "goods_and_non_construction_services", occurred_on: "2026-01-01" }, "award");
  assert.equal(micropurchase.kind, "targeted_small_purchase");
  assert.equal(micropurchase.is_compliance_verdict, false);

  const signals = projectProcurementCoverageSignals({ publisher_method: "MICROPURCHASE", amount: 5000, procurement_category: "goods_and_non_construction_services", occurred_on: "2026-01-01", stages: ["award"] });
  assert.equal(signals.labels.length, 1);
});

test("A4: a held comparative admission never leaks a public signal; an eligible one only publishes on request", () => {
  const heldFact = { schema: "not-a-real-schema" };
  const held = admitComparativeFact(heldFact);
  assert.equal(held.state, "held_semantics");
  assert.equal(held.public_signal, null);
  assert.equal(projectPublishedStorySignal(held), null);
});

// --- A5: a requested missing outcome keeps one scoped explanation without leaking raw hold codes ---

test("A5: the resident-facing minutes freshness sentence stays scoped and never leaks a raw pipeline code", () => {
  const { documents } = buildCommunityBoardConstellationMaterialization();
  const residentHtml = documents
    .map(([, doc]) => doc.replace(/<script[\s\S]*?<\/script>/gi, " "))
    .join("\n");
  assert.doesNotMatch(residentHtml, /unsupported-format|not-yet-checked|"receipt_state"/);
  assert.match(residentHtml, /Minutes archive could not be checked|Latest minutes|No dated minutes found in the checked source/);
});
