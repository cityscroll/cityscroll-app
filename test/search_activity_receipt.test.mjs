/**
 * SAH-01 — browser half of the search-execution receipt.
 *
 * These tests exercise the render plan the canonical Search document paints from,
 * so a receipt is compared against the document's real render inputs rather than
 * against scraped DOM. `search_document.mjs` calls `buildSearchRenderPlan` and then
 * iterates that plan's families — the drift guard at the bottom of this file keeps
 * that true, which is what makes the plan a valid stand-in for the rendered page.
 *
 * verify: node --test test/search_activity_receipt.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  SEARCH_ACTIVITY_FAMILIES,
  SEARCH_ACTIVITY_MAX_RESULT_ROWS,
  SEARCH_ACTIVITY_SAFE_LINK_ROOTS,
  SEARCH_EXECUTION_RECEIPT_SCHEMA,
  isSafeSearchActivityLink,
  normalizeSearchExecutionSubmission,
} from "../capabilities/search_activity.mjs";
import { buildSearchRenderPlan } from "../site/search_render_plan.mjs";
import {
  buildSearchExecutionSubmission,
  searchActivityScope,
  submitSearchExecutionReceipt,
} from "../site/search_activity_receipt.mjs";
import { isSafeSearchCanonicalRoute } from "../site/search_document_contract.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- fixtures: the shapes `/search` and `/search/candidates` actually return ----

function lane(id, status = "available") {
  return { id, status, count: null, as_of: "2026-08-30", source: `${id} read model`, coverage: {} };
}

function keywordRecord({ ref, type, domain, title, route }) {
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: ref,
    object_type: type,
    entity_type: type,
    domain,
    lens: domain,
    title,
    source_route: route,
    source_observation_refs: [`${ref}:obs`],
    match_fields: [{ field: "title", matched_term: "rats", source_observation_ref: `${ref}:obs` }],
  };
}

/** A `rats` search: one Contract and one Meeting are what the document renders. */
const RATS_KEYWORD_PAYLOAD = {
  schema: "cityscroll.keyword_search_response.v1",
  match_mode: "keyword",
  query: "rats",
  lanes: SEARCH_ACTIVITY_FAMILIES.map((id) => lane(id)),
  results: [
    keywordRecord({
      ref: "procurement:rats-abatement-2026",
      type: "procurement",
      domain: "contracts",
      title: "Rodent (rats) abatement services",
      route: "/contracts/rats-abatement-2026",
    }),
    keywordRecord({
      ref: "meeting:cb3-rats-hearing",
      type: "meeting",
      domain: "meetings",
      title: "Public hearing on rats and refuse",
      route: "/meetings/cb3-rats-hearing",
    }),
  ],
  coverage: { schema: "cityscroll.universal_search_coverage.v1", returned_count: 2 },
};

/** A `CB3` search: the community-board rows the document renders, with ranks. */
const CB3_KEYWORD_PAYLOAD = {
  schema: "cityscroll.keyword_search_response.v1",
  match_mode: "keyword",
  query: "CB3",
  lanes: SEARCH_ACTIVITY_FAMILIES.map((id) => lane(id)),
  results: [
    keywordRecord({
      ref: "community_board:manhattan-cb3",
      type: "community_board",
      domain: "places",
      title: "Manhattan Community Board 3",
      route: "/community-boards/manhattan-cb3",
    }),
    keywordRecord({
      ref: "community-board-committee:manhattan-cb3-land-use",
      type: "community-board-committee",
      domain: "places",
      title: "Manhattan CB3 Land Use Committee",
      route: "/committees/manhattan-cb3-land-use",
    }),
  ],
  coverage: { schema: "cityscroll.universal_search_coverage.v1", returned_count: 2 },
};

function emptyPayload() {
  return {
    schema: "cityscroll.keyword_search_response.v1",
    match_mode: "keyword",
    lanes: SEARCH_ACTIVITY_FAMILIES.map((id) => lane(id)),
    results: [],
    coverage: { schema: "cityscroll.universal_search_coverage.v1", returned_count: 0 },
  };
}

function partialPayload() {
  return {
    ...RATS_KEYWORD_PAYLOAD,
    lanes: SEARCH_ACTIVITY_FAMILIES.map((id) => (
      id === "meetings" ? lane(id, "unknown") : lane(id)
    )),
  };
}

function submissionFor(plan, query) {
  return buildSearchExecutionSubmission(plan, {
    query,
    scope: {},
    now: new Date("2026-09-01T12:00:00.000Z"),
  });
}

// ---- A1: the `rats` receipt carries the rows the document actually rendered ----

test("A1: a rats search records exactly the Contract and Meeting rows rendered", () => {
  const plan = buildSearchRenderPlan({
    state: "legacy",
    payload: RATS_KEYWORD_PAYLOAD,
    coverage: RATS_KEYWORD_PAYLOAD.coverage,
  });

  // The document renders lane by lane in family order; the plan is that order.
  assert.deepEqual(plan.rows.map((row) => row.reference), [
    "procurement:rats-abatement-2026",
    "meeting:cb3-rats-hearing",
  ]);
  assert.deepEqual(plan.rows.map((row) => row.family), ["contracts", "meetings"]);
  assert.deepEqual(plan.rows.map((row) => row.rank), [1, 2]);
  assert.deepEqual(plan.rows.map((row) => row.canonical_href), [
    "/contracts/rats-abatement-2026",
    "/meetings/cb3-rats-hearing",
  ]);
  assert.equal(plan.outcome, "matched");
  assert.equal(plan.rendered_count, 2);

  const submission = submissionFor(plan, "rats");
  const normalized = normalizeSearchExecutionSubmission(submission);
  assert.ok(normalized.ok, `expected a valid receipt, got ${normalized.reason}`);
  assert.equal(normalized.value.schema, SEARCH_EXECUTION_RECEIPT_SCHEMA);
  assert.equal(normalized.value.query.raw, "rats");
  assert.equal(normalized.value.query.normalized, "rats");
  assert.equal(normalized.value.search_path, "/search/");
  assert.deepEqual(normalized.value.family_counts, {
    contracts: 1,
    "people-organizations": 0,
    land: 0,
    rules: 0,
    meetings: 1,
    exams: 0,
  });
  assert.deepEqual(normalized.value.results.map((row) => row.title), [
    "Rodent (rats) abatement services",
    "Public hearing on rats and refuse",
  ]);
  assert.deepEqual(normalized.value.results.map((row) => row.entity_type), ["procurement", "meeting"]);
  assert.equal(normalized.value.producers.search_schema, "cityscroll.keyword_search_response.v1");
});

// ---- A2: CB3, empty, partial, and unavailable stay distinct ----

test("A2: a CB3 search preserves the displayed community-board rows and ranks", () => {
  const plan = buildSearchRenderPlan({
    state: "legacy",
    payload: CB3_KEYWORD_PAYLOAD,
    coverage: CB3_KEYWORD_PAYLOAD.coverage,
  });
  assert.equal(plan.outcome, "matched");
  assert.deepEqual(plan.rows.map((row) => [row.rank, row.reference, row.family]), [
    [1, "community_board:manhattan-cb3", "people-organizations"],
    [2, "community-board-committee:manhattan-cb3-land-use", "people-organizations"],
  ]);
  const normalized = normalizeSearchExecutionSubmission(submissionFor(plan, "CB3"));
  assert.ok(normalized.ok, `expected a valid receipt, got ${normalized.reason}`);
  assert.equal(normalized.value.family_counts["people-organizations"], 2);
  assert.deepEqual(normalized.value.results.map((row) => row.canonical_href), [
    "/community-boards/manhattan-cb3",
    "/committees/manhattan-cb3-land-use",
  ]);
});

test("A2: empty, partial, and unavailable executions carry distinct outcomes", () => {
  const empty = buildSearchRenderPlan({
    state: "legacy", payload: emptyPayload(), coverage: emptyPayload().coverage,
  });
  assert.equal(empty.outcome, "empty");
  assert.equal(empty.rendered_count, 0);
  assert.deepEqual(empty.incomplete_families, []);

  const partial = buildSearchRenderPlan({
    state: "legacy", payload: partialPayload(), coverage: partialPayload().coverage,
  });
  assert.equal(partial.outcome, "partial");
  assert.deepEqual(partial.incomplete_families, ["meetings"]);
  // A partly covered search still records what the reader could actually see.
  assert.equal(partial.rendered_count, 2);

  const unavailable = buildSearchRenderPlan({ state: "unavailable" });
  assert.equal(unavailable.outcome, "unavailable");
  assert.equal(unavailable.rendered_count, 0);
  assert.deepEqual(unavailable.incomplete_families, [...SEARCH_ACTIVITY_FAMILIES]);

  for (const [plan, query] of [[empty, "zzzz"], [partial, "rats"], [unavailable, "rats"]]) {
    const normalized = normalizeSearchExecutionSubmission(submissionFor(plan, query));
    assert.ok(normalized.ok, `expected a valid receipt, got ${normalized.reason}`);
    assert.equal(normalized.value.outcome, plan.outcome);
  }
});

test("A2: a keyword producer outage leaves every family incomplete, not empty", () => {
  const plan = buildSearchRenderPlan({ state: "semantic", semantic: { groups: [] }, keyword: null });
  assert.equal(plan.outcome, "partial");
  assert.deepEqual(plan.incomplete_families, [...SEARCH_ACTIVITY_FAMILIES]);
});

// ---- A5: strict, bounded validation ----

test("A5: unknown fields are rejected rather than quietly dropped", () => {
  const plan = buildSearchRenderPlan({
    state: "legacy", payload: RATS_KEYWORD_PAYLOAD, coverage: RATS_KEYWORD_PAYLOAD.coverage,
  });
  const base = submissionFor(plan, "rats");
  assert.equal(normalizeSearchExecutionSubmission({ ...base, visitor_id: "v1_forged" }).reason, "unknown_field");
  assert.equal(normalizeSearchExecutionSubmission({ ...base, traffic_class: "production" }).reason, "unknown_field");
  assert.equal(
    normalizeSearchExecutionSubmission({ ...base, query: { raw: "rats", normalized: "rats", extra: 1 } }).reason,
    "unknown_field",
  );
  assert.equal(
    normalizeSearchExecutionSubmission({
      ...base,
      results: [{ ...base.results[0], subscriber_id: "subscriber:abc" }],
    }).reason,
    "unknown_field",
  );
});

test("A5: excessive result lists, malformed references, and bad ranks are rejected", () => {
  const plan = buildSearchRenderPlan({
    state: "legacy", payload: RATS_KEYWORD_PAYLOAD, coverage: RATS_KEYWORD_PAYLOAD.coverage,
  });
  const base = submissionFor(plan, "rats");

  const oversized = Array.from({ length: SEARCH_ACTIVITY_MAX_RESULT_ROWS + 1 }, (_value, index) => ({
    ...base.results[0], rank: index + 1, reference: `procurement:${index}`,
  }));
  assert.equal(
    normalizeSearchExecutionSubmission({ ...base, results: oversized, rendered_count: oversized.length }).reason,
    "too_many_results",
  );

  for (const href of ["https://evil.example/x", "//evil.example/x", "/etc/passwd", "/contracts/../../secret"]) {
    const malformed = { ...base, results: [{ ...base.results[0], canonical_href: href }], rendered_count: 1,
      family_counts: { ...base.family_counts, meetings: 0 } };
    assert.equal(
      normalizeSearchExecutionSubmission(malformed).reason,
      "result_reference",
      `expected ${href} to be rejected`,
    );
  }

  const misranked = { ...base, results: [{ ...base.results[1], rank: 1 }, { ...base.results[0], rank: 1 }] };
  assert.equal(normalizeSearchExecutionSubmission(misranked).reason, "result_rank");

  const miscounted = { ...base, rendered_count: 99 };
  assert.equal(normalizeSearchExecutionSubmission(miscounted).reason, "rendered_count");

  const inconsistentFamilies = { ...base, family_counts: { contracts: 2, meetings: 0 } };
  assert.equal(normalizeSearchExecutionSubmission(inconsistentFamilies).reason, "family_counts");

  const lyingOutcome = { ...base, outcome: "empty" };
  assert.equal(normalizeSearchExecutionSubmission(lyingOutcome).reason, "outcome");

  assert.equal(normalizeSearchExecutionSubmission({ ...base, search_path: "/browse/" }).reason, "search_path");
  assert.equal(normalizeSearchExecutionSubmission({ ...base, occurred_at: "yesterday" }).reason, "occurred_at");
  assert.equal(normalizeSearchExecutionSubmission("not-an-object").reason, "not_an_object");
});

test("A5: accepted canonical links stay in lockstep with the Search renderer", () => {
  for (const root of SEARCH_ACTIVITY_SAFE_LINK_ROOTS) {
    const route = `${root}example-record`;
    const rendererAccepts = isSafeSearchCanonicalRoute(route)
      || isSafeSearchCanonicalRoute(route, { evidenceOnly: true });
    assert.equal(
      isSafeSearchActivityLink(route),
      rendererAccepts,
      `${route} must be accepted by the receipt exactly when the renderer links it`,
    );
  }
  assert.equal(isSafeSearchActivityLink("/unlisted-root/thing"), false);
});

// ---- A6: fail-soft intake never changes Search ----

test("A6: intake failure, rejection, and absence are all silent to the caller", async () => {
  const plan = buildSearchRenderPlan({
    state: "legacy", payload: RATS_KEYWORD_PAYLOAD, coverage: RATS_KEYWORD_PAYLOAD.coverage,
  });
  const submission = submissionFor(plan, "rats");

  const thrown = await submitSearchExecutionReceipt(submission, {
    origins: ["https://api.cityscroll.org"],
    fetchImpl: () => { throw new Error("network down"); },
  });
  assert.equal(thrown, "failed");

  const rejectedPromise = await submitSearchExecutionReceipt(submission, {
    origins: ["https://api.cityscroll.org"],
    fetchImpl: () => Promise.reject(new Error("refused")),
  });
  assert.equal(rejectedPromise, "failed");

  const rejected = await submitSearchExecutionReceipt(submission, {
    origins: ["https://api.cityscroll.org"],
    fetchImpl: async () => ({ ok: false, status: 400 }),
  });
  assert.equal(rejected, "rejected");

  assert.equal(await submitSearchExecutionReceipt(submission, { origins: [] }), "skipped");
  assert.equal(await submitSearchExecutionReceipt(null, { origins: ["https://api.cityscroll.org"] }), "skipped");
});

test("A6: a submitted receipt is credentialed, bounded, and posted to /search-activity", async () => {
  const plan = buildSearchRenderPlan({
    state: "legacy", payload: RATS_KEYWORD_PAYLOAD, coverage: RATS_KEYWORD_PAYLOAD.coverage,
  });
  const calls = [];
  const status = await submitSearchExecutionReceipt(submissionFor(plan, "rats"), {
    origins: ["https://api.cityscroll.org", "https://fallback.example"],
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 202 }; },
  });
  assert.equal(status, "stored");
  assert.equal(calls.length, 1, "one settled execution submits exactly one receipt");
  assert.equal(calls[0].url, "https://api.cityscroll.org/search-activity");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.keepalive, true);
});

test("no query means nothing to observe", () => {
  const plan = buildSearchRenderPlan({ state: "unavailable" });
  assert.equal(buildSearchExecutionSubmission(plan, { query: "   " }), null);
  assert.equal(buildSearchExecutionSubmission(null, { query: "rats" }), null);
});

test("place context travels as bounded scope, not as free-form fields", () => {
  const scope = searchActivityScope(new URLSearchParams(
    "boro=manhattan&cd=3&council=1&neighborhood=Lower%20East%20Side&scope=cb&secret=leak",
  ));
  assert.deepEqual(scope, {
    boro: "manhattan",
    cd: "3",
    council: "1",
    neighborhood: "Lower East Side",
    scope: "cb",
  });
  const plan = buildSearchRenderPlan({
    state: "legacy", payload: RATS_KEYWORD_PAYLOAD, coverage: RATS_KEYWORD_PAYLOAD.coverage,
  });
  const submission = buildSearchExecutionSubmission(plan, { query: "rats", scope });
  assert.ok(normalizeSearchExecutionSubmission(submission).ok);
  assert.equal(
    normalizeSearchExecutionSubmission({ ...submission, scope: { boro: "manhattan", note: "x" } }).reason,
    "unknown_field",
  );
});

// ---- drift guard: the document must paint from the same plan it reports ----

test("the Search document paints from the render plan it observes", () => {
  const source = readFileSync(join(ROOT, "site/search_document.mjs"), "utf8");
  assert.match(source, /import \{ buildSearchRenderPlan \} from "\.\/search_render_plan\.mjs";/);
  assert.match(source, /const plan = buildSearchRenderPlan\(lastResponse\);/);
  assert.match(source, /paintResults\(root, plan\);/);
  assert.match(source, /observeSearchExecution\(query, plan\);/);
  // Each renderer must consume plan.families rather than regroup results itself.
  for (const renderer of ["renderResults", "renderSemanticResults", "renderCombinedResults"]) {
    const body = source.slice(source.indexOf(`function ${renderer}(`));
    assert.match(
      body.slice(0, body.indexOf("\n}\n")),
      /plan\.families/,
      `${renderer} must render from the plan, not from its own grouping`,
    );
  }
});
