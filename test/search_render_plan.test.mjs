import assert from "node:assert/strict";
import test from "node:test";

import { buildSearchRenderPlan, SEARCH_RENDER_FAMILIES } from "../site/search_render_plan.mjs";
import { SEARCH_FRONT_DOOR_SCOPES } from "../site/search_front_door_scope.mjs";

function keywordRecord({ ref, family, title, href }) {
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: ref,
    object_type: family,
    domain: family,
    canonical_href: href,
    title,
  };
}

function keywordPayload(records, { statuses = {} } = {}) {
  return {
    schema: "cityscroll.keyword_search_response.v1",
    match_mode: "keyword",
    lanes: SEARCH_RENDER_FAMILIES.map((id) => ({
      id,
      status: statuses[id] || (records.some((r) => r.domain === id) ? "matched" : "empty"),
    })),
    results: records,
  };
}

function semanticCandidate({ family, id, title, href = null }) {
  return {
    candidate_id: id,
    civic_object_family: family,
    source: { canonical_href: href, title },
    passage: { text: null },
    matched_terms: [],
  };
}

function semanticEnvelope(candidatesByFamily) {
  return {
    state: "typed",
    groups: SEARCH_RENDER_FAMILIES.map((id) => ({
      id,
      candidates: candidatesByFamily[id] || [],
    })),
  };
}

test("combined mode lists the canonical federated result before semantic enrichment in a lane", () => {
  const keyword = keywordPayload([
    keywordRecord({ ref: "procurement:1", family: "contracts", title: "Federated contract", href: "/contracts/1" }),
  ]);
  const semantic = semanticEnvelope({
    contracts: [semanticCandidate({ family: "contracts", id: "sem:1", title: "Semantic passage", href: "/notices/1" })],
  });
  const plan = buildSearchRenderPlan({ state: "combined", keyword, semantic, keywordCoverage: null });
  const contracts = plan.families.find((f) => f.id === "contracts");
  assert.equal(contracts.items.length, 2);
  assert.equal(contracts.items[0].kind, "keyword", "the federated/keyword result must render first");
  assert.equal(contracts.items[1].kind, "semantic", "the semantic candidate is enrichment appended after it");
  assert.deepEqual(plan.rows.map((row) => row.kind), ["keyword", "semantic"]);
  assert.deepEqual(plan.rows.map((row) => row.rank), [1, 2]);
});

test("combined mode still dedupes a semantic candidate that restates the same canonical result", () => {
  const keyword = keywordPayload([
    keywordRecord({ ref: "procurement:1", family: "contracts", title: "Federated contract", href: "/contracts/1" }),
  ]);
  const semantic = semanticEnvelope({
    contracts: [semanticCandidate({ family: "contracts", id: "sem:1", title: "Same record", href: "/contracts/1" })],
  });
  const plan = buildSearchRenderPlan({ state: "combined", keyword, semantic, keywordCoverage: null });
  const contracts = plan.families.find((f) => f.id === "contracts");
  assert.equal(contracts.items.length, 1);
  assert.equal(contracts.items[0].kind, "keyword");
});

test("semantic-only mode (no keyword authority to defer to) still renders its own candidates", () => {
  const semantic = semanticEnvelope({
    contracts: [semanticCandidate({ family: "contracts", id: "sem:1", title: "Semantic only", href: "/notices/1" })],
  });
  const plan = buildSearchRenderPlan({ state: "semantic", keyword: null, semantic, keywordCoverage: null });
  const contracts = plan.families.find((f) => f.id === "contracts");
  assert.deepEqual(contracts.items.map((item) => item.kind), ["semantic"]);
});

test("an unscoped (all-sources) search treats every family as requested", () => {
  const keyword = keywordPayload([]);
  const plan = buildSearchRenderPlan({ state: "legacy", payload: keyword, coverage: null });
  assert.equal(plan.families.every((family) => family.in_scope), true);
  assert.equal(plan.outcome, "empty");
});

test("a Contracts-scoped search never marks an out-of-scope family as incomplete or partial", () => {
  // The federated provider reports every unrequested lens's family as
  // "not_covered" — honest for an all-sources search, but an explicit
  // Contracts-only narrowing never asked those families anything, so they
  // must not drag the outcome down to "partial".
  const keyword = keywordPayload(
    [keywordRecord({ ref: "procurement:1", family: "contracts", title: "Contract", href: "/contracts/1" })],
    { statuses: { meetings: "not_covered", land: "not_covered", rules: "not_covered", exams: "not_covered", "people-organizations": "not_covered" } },
  );
  const plan = buildSearchRenderPlan(
    { state: "legacy", payload: keyword, coverage: null },
    { scope: SEARCH_FRONT_DOOR_SCOPES.contracts },
  );
  assert.equal(plan.outcome, "matched");
  assert.deepEqual(plan.incomplete_families, []);
  const contracts = plan.families.find((f) => f.id === "contracts");
  assert.equal(contracts.in_scope, true);
  assert.equal(contracts.count, 1);
  const meetings = plan.families.find((f) => f.id === "meetings");
  assert.equal(meetings.in_scope, false);
  assert.equal(meetings.count, 0);
});

test("a Contracts-scoped search still reports partial honestly when Contracts itself degrades", () => {
  const keyword = keywordPayload([], { statuses: { contracts: "unknown" } });
  const plan = buildSearchRenderPlan(
    { state: "legacy", payload: keyword, coverage: null },
    { scope: SEARCH_FRONT_DOOR_SCOPES.contracts },
  );
  assert.equal(plan.outcome, "partial");
  assert.deepEqual(plan.incomplete_families, ["contracts"]);
});

test("a Contracts-scoped search suppresses out-of-scope semantic enrichment too", () => {
  const keyword = keywordPayload([
    keywordRecord({ ref: "procurement:1", family: "contracts", title: "Contract", href: "/contracts/1" }),
  ]);
  const semantic = semanticEnvelope({
    meetings: [semanticCandidate({ family: "meetings", id: "sem:1", title: "Off-scope passage" })],
  });
  const plan = buildSearchRenderPlan(
    { state: "combined", keyword, semantic, keywordCoverage: null },
    { scope: SEARCH_FRONT_DOOR_SCOPES.contracts },
  );
  const meetings = plan.families.find((f) => f.id === "meetings");
  assert.equal(meetings.items.length, 0);
  assert.equal(meetings.in_scope, false);
});

test("an unavailable execution marks every requested family incomplete under the active scope", () => {
  const plan = buildSearchRenderPlan(
    { state: "unavailable" },
    { scope: SEARCH_FRONT_DOOR_SCOPES.contracts },
  );
  assert.deepEqual(plan.incomplete_families, ["contracts"]);
  assert.equal(plan.outcome, "unavailable");
});
