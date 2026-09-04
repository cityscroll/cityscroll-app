import assert from "node:assert/strict";
import test from "node:test";

import {
  FEDERATED_SEARCH_LENS_IDS,
} from "../capabilities/federated_search.mjs";
import { federateUniversalSearch } from "../site/universal_search_federator.mjs";
import { scopedFederatedSearchPath, allSourcesFederatedSearchPath } from "../site/federated_search_client.mjs";
import { contractScopedRetrievalRequest } from "../site/contract_search_bridge.mjs";
import {
  PREVIEW_FORM_FACTOR_SCOPES,
  fetchPreviewFormFactor,
  previewFormFactorOutcome,
  previewFormFactorRequest,
  previewFormFactorScope,
  previewFullResultsHref,
} from "../site/preview_federated_form_factor.mjs";

function documentFor(lens, index = 1) {
  const shapes = {
    notices: ["procurement", "contracts", "/procurements/"],
    people: ["person", "people", "/officials/"],
    meetings: ["meeting", "meetings", "/meetings/"],
  };
  const [objectType, domain, hrefRoot] = shapes[lens] || shapes.people;
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: `${lens}:preview-${index}`,
    object_type: objectType,
    domain,
    canonical_href: `${hrefRoot}${encodeURIComponent(`${lens}:preview-${index}`)}/`,
    title: `parks ${lens} fixture ${index}`,
    summary: `A representative ${lens} fixture.`,
    search_text: `parks ${lens} fixture ${index}`,
    source_family: `${lens}_fixture`,
    source_observation_refs: [`${lens}:fixture-${index}`],
    classification: { method: "fixture", basis: "preview form-factor fixture" },
    provenance: { producer: `${lens}_fixture_producer`, lifecycle: { state: "current" } },
  };
}

function providersFor(documentsByLens, { state = "matched", throwFor = null } = {}) {
  return Object.fromEntries(FEDERATED_SEARCH_LENS_IDS.map((lens) => [lens, {
    search: async () => {
      if (throwFor?.has(lens)) throw new Error("provider offline");
      const documents = documentsByLens[lens] || [];
      return {
        candidates: documents.map((document, index) => ({
          document,
          local_score: index + 1,
          match_fields: [{
            field: "title",
            matched_term: "parks",
            source_observation_ref: document.source_observation_refs[0],
          }],
        })),
        coverage: {
          state,
          indexed_count: documents.length,
          as_of: "2026-09-02",
          source: `${lens} fixture source`,
          method: "fixture substring index",
        },
      };
    },
  }]));
}

async function allSourcesEnvelope(documentsByLens, options = {}) {
  return federateUniversalSearch({
    query: "parks",
    limit: 40,
    lenses: providersFor(documentsByLens, options),
  });
}

test("the preview registers exactly an all-sources default and the registered Contracts scope", () => {
  assert.deepEqual(Object.keys(PREVIEW_FORM_FACTOR_SCOPES), ["all", "contracts"]);
  assert.equal(PREVIEW_FORM_FACTOR_SCOPES.all.scope_mode, "all_registered_lenses");
  assert.equal(PREVIEW_FORM_FACTOR_SCOPES.all.lenses, null);
  assert.equal(PREVIEW_FORM_FACTOR_SCOPES.all.narrow_target, "contracts");
  assert.equal(PREVIEW_FORM_FACTOR_SCOPES.contracts.scope_mode, "allowlisted");
  assert.deepEqual([...PREVIEW_FORM_FACTOR_SCOPES.contracts.lenses], ["notices", "vendors"]);
  assert.equal(PREVIEW_FORM_FACTOR_SCOPES.contracts.narrow_target, "all");
  assert.throws(() => previewFormFactorScope("money"), /unknown registered Preview form-factor scope/);
});

test("initial preview requests the all-sources federation, never a scoped or Contracts-list path", () => {
  const request = previewFormFactorRequest("all", "  parks  ");
  assert.equal(request.capability_reference, "search.federated@1");
  assert.equal(request.query, "parks");
  assert.equal(request.path, "/search?q=parks");
  assert.equal(request.path, allSourcesFederatedSearchPath("parks"));
  assert.ok(!request.path.includes("scope="));
  assert.throws(() => previewFormFactorRequest("all", "   "), /requires a query/);
});

test("the Contracts scope serializes exactly the registered path Contracts Browse issues", () => {
  const request = previewFormFactorRequest("contracts", "parks");
  assert.equal(request.path, "/search?q=parks&scope=notices&scope=vendors");
  assert.equal(request.path, scopedFederatedSearchPath("parks", ["notices", "vendors"]));
  const bridge = contractScopedRetrievalRequest({ query: "parks" });
  assert.equal(request.path, bridge.path);
  assert.deepEqual([...request.scope.lenses], [...bridge.lenses]);
});

test("all-sources outcomes retain the canonical envelope's references, order, evidence, and bounds", async () => {
  const envelope = await allSourcesEnvelope({
    notices: [documentFor("notices", 1), documentFor("notices", 2), documentFor("notices", 3), documentFor("notices", 4)],
    meetings: [documentFor("meetings", 1)],
  });
  const outcome = previewFormFactorOutcome("all", { federated: envelope }, previewFormFactorRequest("all", "parks"));
  assert.equal(outcome.outcome, "matched");
  assert.equal(outcome.coverage.state, "complete");
  assert.equal(outcome.coverage.as_of, "2026-09-02");
  assert.deepEqual(outcome.documents, envelope.results);
  assert.deepEqual(
    outcome.documents.slice(0, 3).map((document) => [document.object_ref, document.rank]),
    envelope.results.slice(0, 3).map((document) => [document.object_ref, document.rank]),
  );
  assert.ok(outcome.documents.every((document) => Array.isArray(document.source_observation_refs)
    && document.source_observation_refs.length > 0
    && Array.isArray(document.match_fields)
    && typeof document.provenance?.producer === "string"));
  assert.deepEqual(outcome.requested_scope, envelope.requested_scope);
  assert.equal(outcome.requested_scope.mode, "all_registered_lenses");
  assert.equal(outcome.bounds.preview_limit, 3);
});

test("the Contracts scope projects the same query over only the registered Contracts lenses", async () => {
  const contractsEnvelope = await federateUniversalSearch({
    query: "parks",
    limit: 40,
    lenses: providersFor({ notices: [documentFor("notices", 1)] }),
    scope: { lenses: ["notices", "vendors"] },
  });
  const outcome = previewFormFactorOutcome("contracts", { federated: contractsEnvelope }, previewFormFactorRequest("contracts", "parks"));
  assert.equal(outcome.outcome, "matched");
  assert.deepEqual(outcome.documents, contractsEnvelope.results);
  assert.equal(outcome.requested_scope.mode, "allowlisted");
  assert.deepEqual(outcome.coverage.degraded_lenses, []);
});

test("partial coverage stays partial and visible whether or not rows matched", async () => {
  const partialEnvelope = await allSourcesEnvelope(
    { notices: [documentFor("notices", 1)] },
    { throwFor: new Set(["meetings"]) },
  );
  const partial = previewFormFactorOutcome("all", { federated: partialEnvelope }, previewFormFactorRequest("all", "parks"));
  assert.equal(partial.outcome, "partial");
  assert.equal(partial.coverage.state, "partial");
  assert.deepEqual(partial.coverage.unavailable_lenses, ["meetings"]);
  assert.equal(partial.documents.length, 1);

  const emptyPartialEnvelope = await allSourcesEnvelope({}, { throwFor: new Set(["meetings"]) });
  const emptyPartial = previewFormFactorOutcome("all", { federated: emptyPartialEnvelope }, previewFormFactorRequest("all", "parks"));
  assert.equal(emptyPartial.outcome, "partial");
  assert.equal(emptyPartial.coverage.state, "partial");
  assert.equal(emptyPartial.documents.length, 0);
});

test("a genuine zero-result federation is an empty outcome, not a failure", async () => {
  const envelope = await allSourcesEnvelope({});
  const outcome = previewFormFactorOutcome("all", { federated: envelope }, previewFormFactorRequest("all", "nothing"));
  assert.equal(outcome.outcome, "empty");
  assert.equal(outcome.coverage.state, "complete");
  assert.equal(outcome.documents.length, 0);
});

test("every requested provider failing is unavailable, distinct from empty", async () => {
  const envelope = await allSourcesEnvelope({}, { throwFor: new Set(FEDERATED_SEARCH_LENS_IDS) });
  const outcome = previewFormFactorOutcome("all", { federated: envelope }, previewFormFactorRequest("all", "parks"));
  assert.equal(outcome.outcome, "unavailable");
  assert.equal(outcome.coverage.state, "unavailable");
  const empty = previewFormFactorOutcome("all", await allSourcesEnvelope({}), previewFormFactorRequest("all", "nothing"));
  assert.notEqual(outcome.outcome, empty.outcome);
});

test("transport failures resolve unavailable, never empty", async () => {
  const cases = [
    async () => { throw new Error("HTTP 503"); },
    async () => ({ ok: false, status: 503 }),
    async () => ({ ok: true, json: async () => ({ schema: "not.a.payload" }) }),
    "not-a-function",
  ];
  for (const fetcher of cases) {
    const { request, outcome } = await fetchPreviewFormFactor("all", "parks", { fetcher });
    assert.equal(outcome.outcome, "unavailable", String(fetcher));
    assert.equal(outcome.documents.length, 0);
    assert.equal(request.path, "/search?q=parks");
    assert.ok(outcome.fallback.reason);
  }
});

test("a payload without a canonical envelope keeps rows and reports unreported coverage", () => {
  const rows = [documentFor("notices", 1)];
  const outcome = previewFormFactorOutcome("all", { results: rows }, previewFormFactorRequest("all", "parks"));
  assert.equal(outcome.outcome, "matched");
  assert.equal(outcome.coverage.state, "unreported");
  assert.equal(outcome.documents.length, 1);
});

test("full-result handoffs preserve the exact query for each visible scope", () => {
  assert.equal(previewFullResultsHref("all", "parks"), "/search/?q=parks");
  assert.equal(previewFullResultsHref("contracts", "parks"), "/browse/contracts/?q=parks");
  assert.equal(previewFullResultsHref("contracts", "  parks  "), "/browse/contracts/?q=parks");
  assert.throws(() => previewFullResultsHref("all", "  "), /requires a query/);
});

test("fetch issues the request the scope registered and returns the capability envelope whole", async () => {
  const seen = [];
  const envelope = await allSourcesEnvelope({ notices: [documentFor("notices", 1)] });
  const { request, outcome } = await fetchPreviewFormFactor("contracts", "parks", {
    fetcher: async (path) => {
      seen.push(path);
      return { ok: true, json: async () => ({ results: envelope.results, federated: envelope }) };
    },
  });
  assert.deepEqual(seen, ["/search?q=parks&scope=notices&scope=vendors"]);
  assert.equal(request.scope.id, "contracts");
  assert.equal(outcome.outcome, "matched");
  assert.deepEqual(outcome.documents, envelope.results);
});
