import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PROCUREMENT_RELATED_CONTEXT_SCHEMA,
  RELATED_CONTEXT_GROUP,
  RELATED_CONTEXT_AMOUNT_BENCHMARK_POLICY,
  classifyHistoryCandidate,
  exactIdentityBasis,
  resemblanceBasis,
  buildAmountBenchmark,
  buildRelatedProcurementContext,
  renderRelatedProcurementContextHtml,
} from "../site/procurement_related_context.mjs";
import { AWARD_RANK_SMALL_N_POLICY } from "../site/comparative_award_rank.mjs";

const AGENCY = "Department of Parks and Recreation";

function subject(overrides = {}) {
  return {
    id: "REQ-CURRENT",
    epin: "846-2026-0001",
    pin: "846-2026-0001",
    agency_name: AGENCY,
    short_title: "Playground reconstruction citywide phase two",
    amount: 500000,
    ...overrides,
  };
}

// ---- A2 / negative rule: exact identity only, never textual similarity ----

test("exactIdentityBasis: shared contract id is exact", () => {
  const basis = exactIdentityBasis({ contract_id: "CT-1" }, { contract_id: "ct-1" });
  assert.equal(basis, "exact_contract_id");
});

test("exactIdentityBasis: shared EPIN/PIN is exact", () => {
  const basis = exactIdentityBasis({ epin: "846-2026-0001" }, { pin: "846-2026-0001" });
  assert.equal(basis, "exact_epin");
});

test("exactIdentityBasis: renewal-suffix PIN widening is an explicit predecessor link", () => {
  // Same convention as worker/src/lib/lineage.mjs pinBase(): a trailing
  // R0\d+ suffix denotes a renewal of the base PIN, a declared numbering
  // convention, not a text-similarity guess.
  const basis = exactIdentityBasis({ pin: "846-2026-0001" }, { pin: "846-2026-0001R0001" });
  assert.equal(basis, "exact_predecessor_link");
});

test("exactIdentityBasis: an explicit caller-declared predecessor field is exact", () => {
  const basis = exactIdentityBasis(
    { pin: "846-2026-0002", predecessor_pin: "846-2020-0001" },
    { pin: "846-2020-0001" },
  );
  assert.equal(basis, "exact_predecessor_link");
});

test("exactIdentityBasis: near-identical title text alone is never exact", () => {
  const basis = exactIdentityBasis(
    subject(),
    { agency_name: AGENCY, short_title: "Playground reconstruction citywide phase two", pin: "999-0000-9999" },
  );
  assert.equal(basis, null, "an identical title with no shared identifier must never resolve as exact");
});

test("classifyHistoryCandidate: exact identity always wins even when the title also resembles", () => {
  const result = classifyHistoryCandidate(
    subject(),
    { epin: "846-2026-0001", agency_name: AGENCY, short_title: "Playground reconstruction citywide phase two" },
  );
  assert.equal(result.group, RELATED_CONTEXT_GROUP.EXACT);
});

test("classifyHistoryCandidate: different agency never resembles regardless of title overlap", () => {
  const result = classifyHistoryCandidate(
    subject(),
    { agency_name: "Department of Transportation", short_title: "Playground reconstruction citywide phase two", pin: "999-9999" },
  );
  assert.equal(result.group, null);
});

test("resemblanceBasis: same agency plus meaningful title overlap is resemblance, not exact", () => {
  const basis = resemblanceBasis(
    subject(),
    { agency_name: AGENCY, short_title: "Playground reconstruction citywide phase one" },
  );
  assert.ok(basis, "expected a resemblance match");
  assert.equal(basis.basis, "title_overlap");
});

test("resemblanceBasis: weak title overlap does not qualify", () => {
  const basis = resemblanceBasis(
    subject(),
    { agency_name: AGENCY, short_title: "Street resurfacing annual contract" },
  );
  assert.equal(basis, null);
});

// ---- A1: two visibly and semantically distinct groups ----

test("buildRelatedProcurementContext: exact and related candidates land in separate, correctly labeled groups", () => {
  const view = buildRelatedProcurementContext({
    subject: subject(),
    candidates: [
      { id: "REQ-PRIOR", epin: "846-2026-0001", vendor_name: "Acme Builders", amount: 480000, award_date: "2022-05-01", short_title: "Playground reconstruction citywide phase two" },
      { id: "REQ-RESEMBLE", agency_name: AGENCY, vendor_name: "Beta Contracting", amount: 510000, award_date: "2023-06-01", short_title: "Playground reconstruction citywide phase one" },
    ],
  });
  assert.ok(view);
  assert.equal(view.schema, PROCUREMENT_RELATED_CONTEXT_SCHEMA);
  assert.equal(view.exact_chain.length, 1);
  assert.equal(view.exact_chain[0].vendor_name, "Acme Builders");
  assert.equal(view.related.length, 1);
  assert.equal(view.related[0].vendor_name, "Beta Contracting");
  assert.equal(view.related[0].resemblance, true);
  assert.equal(view.exact_chain[0].resemblance, undefined, "an exact-chain entry must never carry a resemblance flag");
});

test("buildRelatedProcurementContext: a candidate matching only by title never enters the exact chain (A2)", () => {
  const view = buildRelatedProcurementContext({
    subject: subject(),
    candidates: [
      { id: "REQ-TWIN", agency_name: AGENCY, short_title: "Playground reconstruction citywide phase two", vendor_name: "Copycat Co", amount: 495000 },
    ],
  });
  assert.ok(view);
  assert.equal(view.exact_chain.length, 0);
  assert.equal(view.related.length, 1, "an identical title with no shared identifier belongs in the related group, never the exact chain");
});

test("buildRelatedProcurementContext: the subject never matches itself", () => {
  const view = buildRelatedProcurementContext({
    subject: subject(),
    candidates: [{ id: "REQ-CURRENT", epin: "846-2026-0001", agency_name: AGENCY, short_title: "Playground reconstruction citywide phase two" }],
  });
  assert.equal(view, null);
});

test("buildRelatedProcurementContext: returns null when nothing is classified and no benchmark applies", () => {
  const view = buildRelatedProcurementContext({ subject: subject(), candidates: [] });
  assert.equal(view, null);
});

// ---- A4 / A5: cohort-boundary reuse of the existing small-n policy ----

test("the amount-benchmark policy constants are the imported, unchanged comparative-award-rank policy", () => {
  assert.equal(RELATED_CONTEXT_AMOUNT_BENCHMARK_POLICY, AWARD_RANK_SMALL_N_POLICY);
  assert.equal(RELATED_CONTEXT_AMOUNT_BENCHMARK_POLICY.minimum_rank_count, 10);
  assert.equal(RELATED_CONTEXT_AMOUNT_BENCHMARK_POLICY.minimum_percentile_count, 40);
});

function population(size, { below = 0 } = {}) {
  // Builds a population of `size` amounts around 500000 so the subject
  // (also 500000) lands at a known rank; `below` places that many amounts
  // below the subject's own amount.
  const above = size - below;
  const amounts = [];
  for (let i = 0; i < above; i += 1) amounts.push(600000 + i);
  for (let i = 0; i < below; i += 1) amounts.push(400000 + i);
  return amounts;
}

test("small cohort (below the rank floor) is omitted entirely", () => {
  // 8 population + subject = 9 total, below minimum_rank_count (10).
  const benchmark = buildAmountBenchmark(500000, population(8));
  assert.equal(benchmark, null);
});

test("cohort exactly at the rank floor still counts a full cohort (9 population + subject = 10)", () => {
  const benchmark = buildAmountBenchmark(500000, population(9));
  assert.ok(benchmark);
  assert.equal(benchmark.status, "rank_only");
  assert.equal(benchmark.percentile, null);
  assert.equal(benchmark.cohort_size, 10);
});

test("medium cohort (at or above the rank floor, below the percentile floor) exposes rank only, percentile withheld", () => {
  // 38 population + subject = 39 total, below minimum_percentile_count (40).
  const benchmark = buildAmountBenchmark(500000, population(38));
  assert.ok(benchmark);
  assert.equal(benchmark.status, "rank_only");
  assert.equal(benchmark.percentile, null);
  assert.equal(benchmark.cohort_size, 39);
  assert.match(benchmark.label, /percentile withheld/);
});

test("large cohort (at the percentile floor) exposes a percentile", () => {
  // 39 population + subject = 40 total, at minimum_percentile_count (40).
  const benchmark = buildAmountBenchmark(500000, population(39));
  assert.ok(benchmark);
  assert.equal(benchmark.status, "percentile");
  assert.equal(benchmark.cohort_size, 40);
  assert.equal(typeof benchmark.percentile, "number");
});

test("amount benchmark rank/percentile is computed against the position of the subject amount", () => {
  // Population of 49 amounts all higher than the subject -> subject ranks
  // last (50th of 50).
  const benchmark = buildAmountBenchmark(100, population(49, { below: 0 }).map(() => 999999));
  assert.ok(benchmark);
  assert.equal(benchmark.cohort_size, 50);
  assert.equal(benchmark.rank, 50);
  assert.equal(benchmark.percentile, 2); // (50 - 49) / 50 * 100
});

test("amount benchmark ignores a non-positive or missing subject amount", () => {
  assert.equal(buildAmountBenchmark(0, population(50)), null);
  assert.equal(buildAmountBenchmark(null, population(50)), null);
  assert.equal(buildAmountBenchmark(undefined, population(50)), null);
});

// ---- A6: substantiated related history renders inline, beneath the snapshot ----

test("renderRelatedProcurementContextHtml: renders a non-empty inline section when data is present", () => {
  const view = buildRelatedProcurementContext({
    subject: subject(),
    candidates: [
      { id: "REQ-PRIOR", epin: "846-2026-0001", vendor_name: "Acme Builders", amount: 480000, award_date: "2022-05-01", href: "/procurements/procurement:epin:846-2026-0001" },
    ],
    populationAmounts: population(39),
  });
  const html = renderRelatedProcurementContextHtml(view);
  assert.match(html, /data-related-context="1"/);
  assert.match(html, /Exact procurement history/);
  assert.match(html, /Acme Builders/);
  assert.match(html, /Larger than [\d.]+% of 40 comparable awards/);
});

test("renderRelatedProcurementContextHtml: returns empty string for a null view", () => {
  assert.equal(renderRelatedProcurementContextHtml(null), "");
});

test("renderRelatedProcurementContextHtml: exact and related sections are visibly distinct DOM groups", () => {
  const view = buildRelatedProcurementContext({
    subject: subject(),
    candidates: [
      { id: "REQ-PRIOR", epin: "846-2026-0001", vendor_name: "Acme Builders", amount: 480000, award_date: "2022-05-01" },
      { id: "REQ-RESEMBLE", agency_name: AGENCY, vendor_name: "Beta Contracting", amount: 510000, award_date: "2023-06-01", short_title: "Playground reconstruction citywide phase one" },
    ],
  });
  const html = renderRelatedProcurementContextHtml(view);
  assert.match(html, /data-related-context-group="exact"/);
  assert.match(html, /data-related-context-group="related"/);
  const exactIndex = html.indexOf('data-related-context-group="exact"');
  const relatedIndex = html.indexOf('data-related-context-group="related"');
  assert.ok(exactIndex >= 0 && relatedIndex >= 0 && exactIndex !== relatedIndex);
});

// ---- A3 / negative rule: never call a related vendor an incumbent ----

test("renderRelatedProcurementContextHtml: never uses the word 'incumbent' for a resemblance-only group", () => {
  const view = buildRelatedProcurementContext({
    subject: subject(),
    candidates: [
      { id: "REQ-RESEMBLE", agency_name: AGENCY, vendor_name: "Beta Contracting", amount: 510000, award_date: "2023-06-01", short_title: "Playground reconstruction citywide phase one" },
    ],
  });
  const html = renderRelatedProcurementContextHtml(view);
  assert.equal(view.exact_chain.length, 0);
  assert.doesNotMatch(html, /incumbent/i);
});

test("renderRelatedProcurementContextHtml: never uses the word 'incumbent' even alongside an exact chain", () => {
  const view = buildRelatedProcurementContext({
    subject: subject(),
    candidates: [
      { id: "REQ-PRIOR", epin: "846-2026-0001", vendor_name: "Acme Builders", amount: 480000, award_date: "2022-05-01" },
      { id: "REQ-RESEMBLE", agency_name: AGENCY, vendor_name: "Beta Contracting", amount: 510000, award_date: "2023-06-01", short_title: "Playground reconstruction citywide phase one" },
    ],
  });
  const html = renderRelatedProcurementContextHtml(view);
  assert.doesNotMatch(html, /incumbent/i);
});

test("a benchmark below the rank floor is never reported, even when candidates are present", () => {
  const view = buildRelatedProcurementContext({
    subject: subject(),
    candidates: [{ id: "REQ-PRIOR", epin: "846-2026-0001", vendor_name: "Acme Builders", amount: 480000, award_date: "2022-05-01" }],
    populationAmounts: population(3), // 3 + subject = 4, well under the floor of 10
  });
  assert.ok(view);
  assert.equal(view.amount_benchmark, null);
  const html = renderRelatedProcurementContextHtml(view);
  assert.doesNotMatch(html, /related-context-benchmark/);
});
