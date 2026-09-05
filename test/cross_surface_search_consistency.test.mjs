// Cross-surface consistency gate for US-23.
//
// Full Search, Preview, Contracts Browse, and every migrated source Browse
// (US-19/US-20) are documented as projections of one shared federated
// envelope (`search.federated@1`): see `capabilities/federated_search.mjs`
// and `site/universal_search_federator.mjs`. This file is the deterministic
// metamorphic gate the ladder's README promises for US-23 — it feeds the
// exact same fixture lens documents into `handleSearch` once per surface
// request, using the paths each surface's own adapter builds, then asserts
// that canonical references, relative rank order, match evidence,
// provenance, freshness, and coverage state survive scope narrowing and
// per-surface bounds. Only documented projections are permitted:
//   - a narrower `scope` only changes WHICH candidates participate, never
//     the identity, evidence, or provenance of a candidate that does;
//   - Full Search groups multiple presentation-scope domains (`property`
//     and `zoning`) into one shared "land" family/lane — `searchFamilyForResult`,
//     the same classifier the render plan itself uses, is reused here rather
//     than re-derived, so this gate cannot silently drift from production
//     classification;
//   - Full Search's coarser outcome vocabulary folds a single unavailable
//     lens into "partial" (a family is "incomplete", not "unavailable",
//     unless the whole fetch failed), while Preview/Contracts Browse/source
//     Browse report a scope-level "unavailable" the moment any lens they
//     requested fails. Both are asserted explicitly below — this is a
//     documented granularity difference, not a divergence to gate on;
//   - Preview's homepage card cap (3) and each surface's own result bound
//     are presentation truncations of the same canonical prefix, never a
//     reordering or a different result.
//
// A surface that invents a candidate, reorders one relative to the shared
// envelope, drops its evidence/provenance, or collapses a documented
// coverage state into a different one fails this gate.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FEDERATED_SEARCH_CAPABILITY,
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LENS_IDS,
  FEDERATED_SEARCH_LIMITS,
  FEDERATED_SEARCH_PRESENTATION_SCOPES,
} from "../capabilities/federated_search.mjs";
import { federateUniversalSearch } from "../site/universal_search_federator.mjs";
import { handleSearch } from "../worker/src/search.mjs";
import { allSourcesFederatedSearchPath } from "../site/federated_search_client.mjs";
import { SEARCH_FRONT_DOOR_SCOPES, searchFrontDoorRequestPath } from "../site/search_front_door_scope.mjs";
import { buildSearchRenderPlan } from "../site/search_render_plan.mjs";
import { searchFamilyForResult } from "../site/search_lens_handoff.mjs";
import {
  previewFormFactorOutcome,
  previewFormFactorRequest,
} from "../site/preview_federated_form_factor.mjs";
import {
  contractScopedRetrievalOutcome,
  contractScopedRetrievalRequest,
} from "../site/contract_search_bridge.mjs";
import {
  BROWSE_SCOPED_ADAPTERS,
  browseScopedOutcome,
  browseScopedRequest,
  projectBrowseScopedRows,
} from "../site/browse_scoped_adapters.mjs";

const BROWSE_SOURCES = Object.freeze(["people", "property", "land", "rules", "meetings", "exams"]);

// One representative document per registered lens, spanning every domain a
// migrated Browse source or presentation scope actually filters on. The
// `notices` lens deliberately returns two documents in two different
// domains (a procurement notice and a rulemaking notice) — the same shape
// production uses — so this fixture also proves a single lens's candidates
// split correctly across Contracts and Rules without cross-contamination.
const UNIVERSE_SHAPE = Object.freeze({
  notices: Object.freeze([
    { objectType: "procurement", domain: "contracts", href: (ref) => `/procurements/${ref}/` },
    { objectType: "rulemaking", domain: "rules", href: (ref) => `/browse/rules/?q=${ref}` },
  ]),
  vendors: Object.freeze([{ objectType: "vendor", domain: "contracts", href: (ref) => `/vendors/${ref}/` }]),
  people: Object.freeze([{ objectType: "person", domain: "people", href: (ref) => `/officials/${ref}/` }]),
  agencies: Object.freeze([{ objectType: "agency", domain: "people", href: (ref) => `/agencies/${ref}/` }]),
  committees: Object.freeze([{ objectType: "committee", domain: "people", href: (ref) => `/committees/${ref}/` }]),
  community_boards: Object.freeze([{ objectType: "community_board", domain: "people", href: (ref) => `/community-boards/${ref}/` }]),
  exams: Object.freeze([{ objectType: "civil_service_exam", domain: "staffing", href: (ref) => `/exams/${ref}/` }]),
  parcels: Object.freeze([{ objectType: "parcel", domain: "property", href: (ref) => `/parcels/${ref}/` }]),
  land: Object.freeze([{ objectType: "land_use_project", domain: "zoning", href: (ref) => `/browse/zoning/#land/${ref}` }]),
  meetings: Object.freeze([{ objectType: "meeting", domain: "meetings", href: (ref) => `/meetings/${ref}/` }]),
});

function fixtureDocument(lens, index, { objectType, domain, href }) {
  const ref = `${lens}:fixture-${index}`;
  return {
    schema: "cityscroll.search_document.v1",
    object_ref: ref,
    object_type: objectType,
    domain,
    canonical_href: href(ref),
    title: `${objectType} fixture ${index}`,
    summary: `A representative ${objectType} fixture for the cross-surface consistency gate.`,
    search_text: `parks ${objectType} fixture ${index}`,
    source_family: `${lens}_consistency_fixture`,
    source_observation_refs: [`${lens}:obs-${index}`],
    classification: { method: "fixture", basis: "US-23 cross-surface consistency fixture" },
    provenance: { producer: `${lens}_consistency_fixture_producer.v1`, lifecycle: { state: "current" } },
  };
}

/** The full multi-domain document universe, or a named subset with lenses emptied out. */
function buildUniverse({ omit = [] } = {}) {
  const omitted = new Set(omit);
  const byLens = {};
  for (const [lens, shapes] of Object.entries(UNIVERSE_SHAPE)) {
    byLens[lens] = omitted.has(lens) ? [] : shapes.map((shape, index) => fixtureDocument(lens, index + 1, shape));
  }
  return byLens;
}

/**
 * One explicit `search.federated@1` provider over the fixture universe. Every
 * surface in a given case shares this exact provider, so a passing gate means
 * every surface answered the identical underlying question consistently —
 * not that two independently-built fixtures happened to agree.
 */
function buildProvider(universe, { failing = [], coverageOverrides = {} } = {}) {
  const failingSet = new Set(failing);
  const lenses = Object.fromEntries(FEDERATED_SEARCH_LENS_IDS.map((lens) => {
    const documents = universe[lens] || [];
    return [lens, {
      async search() {
        if (failingSet.has(lens)) throw new Error(`${lens} fixture provider failed`);
        const override = coverageOverrides[lens] || {};
        const state = override.state || (documents.length ? "matched" : "empty");
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
            as_of: override.as_of || "2026-09-01T00:00:00Z",
            source: `${lens} consistency fixture source`,
            method: "fixture_v1",
          },
        };
      },
    }];
  }));
  return {
    capabilityReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    providerId: FEDERATED_SEARCH_CAPABILITY.provider.id,
    execute(input) {
      return federateUniversalSearch({ query: input.query, lenses, limit: input.limit, scope: input.scope });
    },
  };
}

/** Drive the one worker entry point every surface's adapter ultimately calls. */
async function fetchSurface(path, provider) {
  const request = new Request(`https://api.cityscroll.org${path}`, { headers: { Accept: "application/json" } });
  const response = await handleSearch(request, {}, { federatedProvider: provider });
  assert.equal(response.status, 200, `${path} did not resolve`);
  return response.json();
}

/**
 * The shared canonical order a registered presentation scope is entitled to,
 * taken from the federator's own rank. A scope's domain allowlist alone is
 * not enough: a domain (e.g. `contracts`) can be reachable through more than
 * one lens (`notices` and `vendors`), and only the lenses actually in scope
 * would have been queried by a narrowed request — a lens outside the scope
 * never contributes a candidate, even when it shares a domain with one that is.
 */
function canonicalSequence(envelope, domains, lenses) {
  const allowDomains = new Set(domains);
  const allowLenses = new Set(lenses);
  return envelope.results.filter((result) => (
    allowDomains.has(result.domain) && result.matched_lenses.some((lens) => allowLenses.has(lens))
  ));
}

/** Every field a "documented projection only" comparison must preserve verbatim. */
function assertCanonicalSequenceMatch(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: candidate count diverged from the canonical envelope`);
  expected.forEach((canonical, index) => {
    const candidate = actual[index];
    assert.ok(candidate, `${label}: missing candidate at position ${index}`);
    assert.equal(candidate.object_ref, canonical.object_ref, `${label}: rank order diverged at position ${index}`);
    assert.equal(candidate.canonical_href, canonical.canonical_href, `${label}: canonical reference diverged for ${canonical.object_ref}`);
    assert.deepEqual(candidate.match_fields, canonical.match_fields, `${label}: match evidence diverged for ${canonical.object_ref}`);
    assert.deepEqual(candidate.source_observation_refs, canonical.source_observation_refs, `${label}: provenance source observations diverged for ${canonical.object_ref}`);
    assert.equal(candidate.provenance?.producer, canonical.provenance?.producer, `${label}: provenance producer diverged for ${canonical.object_ref}`);
  });
}

function asOfForLens(envelope, lens) {
  return envelope.coverage.by_lens[lens]?.as_of ?? null;
}

const QUERY = "parks";

test("Full Search, Preview, Contracts Browse, and every migrated Browse source project the same multi-domain federated envelope", async () => {
  const universe = buildUniverse();
  const provider = buildProvider(universe);
  const oracle = (await fetchSurface(allSourcesFederatedSearchPath(QUERY), provider)).federated;
  assert.ok(oracle.results.length >= 10, "fixture universe should span every registered lens");

  // Full Search, all sources: rows are grouped by the render plan's own family
  // classifier, so this gate rides on the same classification production uses
  // rather than re-deriving a domain-to-family table that could silently drift.
  const allSearchPayload = await fetchSurface(allSourcesFederatedSearchPath(QUERY), provider);
  const allSearchPlan = buildSearchRenderPlan(
    { state: "legacy", payload: allSearchPayload, coverage: allSearchPayload.coverage },
    { scope: SEARCH_FRONT_DOOR_SCOPES.all },
  );
  assert.equal(allSearchPlan.outcome, "matched");
  for (const family of allSearchPlan.families) {
    const canonicalForFamily = oracle.results.filter((result) => searchFamilyForResult(result) === family.id);
    assert.equal(family.items.length, canonicalForFamily.length, `Full Search family ${family.id} count diverged`);
    family.items.forEach((item, index) => {
      assert.equal(item.row.reference, canonicalForFamily[index].object_ref, `Full Search family ${family.id} rank order diverged`);
      assert.equal(item.row.canonical_href, canonicalForFamily[index].canonical_href, `Full Search family ${family.id} canonical reference diverged`);
    });
  }

  // Full Search, Contracts scope: the same registered presentation scope
  // Contracts Browse and Preview's Contracts narrowing both request.
  const contractsSearchPayload = await fetchSurface(
    searchFrontDoorRequestPath("contracts", QUERY),
    provider,
  );
  const contractsSearchPlan = buildSearchRenderPlan(
    { state: "legacy", payload: contractsSearchPayload, coverage: contractsSearchPayload.coverage },
    { scope: SEARCH_FRONT_DOOR_SCOPES.contracts },
  );
  const contractsCanonical = canonicalSequence(
    oracle,
    FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.domains,
    FEDERATED_SEARCH_PRESENTATION_SCOPES.contracts.lenses,
  );
  assert.equal(contractsSearchPlan.rendered_count, contractsCanonical.length);
  contractsSearchPlan.rows.forEach((row, index) => {
    assert.equal(row.reference, contractsCanonical[index].object_ref, "Full Search Contracts scope rank order diverged");
  });

  // Preview: all-sources shows the whole envelope; the Contracts narrowing
  // reuses the same registered scope Contracts Browse and Full Search use.
  const previewAllRequest = previewFormFactorRequest("all", QUERY);
  const previewAllPayload = await fetchSurface(previewAllRequest.path, provider);
  const previewAllOutcome = previewFormFactorOutcome("all", previewAllPayload, previewAllRequest);
  assert.equal(previewAllOutcome.outcome, "matched");
  assertCanonicalSequenceMatch(previewAllOutcome.documents, oracle.results, "Preview (all sources)");

  const previewContractsRequest = previewFormFactorRequest("contracts", QUERY);
  const previewContractsPayload = await fetchSurface(previewContractsRequest.path, provider);
  const previewContractsOutcome = previewFormFactorOutcome("contracts", previewContractsPayload, previewContractsRequest);
  assertCanonicalSequenceMatch(previewContractsOutcome.documents, contractsCanonical, "Preview (Contracts scope)");

  // Contracts Browse: the same registered scope, read through its own adapter.
  const contractsBrowseRequest = contractScopedRetrievalRequest({ query: QUERY });
  const contractsBrowsePayload = await fetchSurface(contractsBrowseRequest.path, provider);
  const contractsBrowseOutcome = contractScopedRetrievalOutcome(contractsBrowsePayload, contractsBrowseRequest);
  assert.equal(contractsBrowseOutcome.outcome, "matched");
  assertCanonicalSequenceMatch(contractsBrowseOutcome.documents, contractsCanonical, "Contracts Browse");

  // Every migrated source Browse: each requests only its own registered
  // scope's lenses, and each must return exactly that scope's canonical slice.
  for (const source of BROWSE_SOURCES) {
    const scope = FEDERATED_SEARCH_PRESENTATION_SCOPES[source];
    const request = browseScopedRequest(source, QUERY);
    assert.equal(request.capability_reference, FEDERATED_SEARCH_CAPABILITY_REFERENCE, `${source} Browse must request the registered capability`);
    assert.ok(request.path.startsWith("/search?"), `${source} Browse must retrieve through the shared federated route, not an invented one`);
    const payload = await fetchSurface(request.path, provider);
    const outcome = browseScopedOutcome(source, payload, request);
    const canonical = canonicalSequence(oracle, scope.domains, scope.lenses);
    assert.equal(outcome.outcome, "matched", `${source} Browse outcome`);
    assertCanonicalSequenceMatch(outcome.documents, canonical, `${source} Browse`);
    // A source's own registered lenses fully cover its documents' lens set;
    // a lens outside the scope must never have participated.
    for (const lens of FEDERATED_SEARCH_LENS_IDS) {
      if (scope.lenses.includes(lens)) continue;
      assert.equal(payload.federated.coverage.by_lens[lens].state, "out_of_scope", `${source} Browse must not query lens ${lens}`);
    }
  }
});

test("a query with zero matches anywhere reports 'empty' identically on every surface", async () => {
  const universe = buildUniverse({ omit: Object.keys(UNIVERSE_SHAPE) });
  const provider = buildProvider(universe);

  const searchPayload = await fetchSurface(allSourcesFederatedSearchPath(QUERY), provider);
  const plan = buildSearchRenderPlan(
    { state: "legacy", payload: searchPayload, coverage: searchPayload.coverage },
    { scope: SEARCH_FRONT_DOOR_SCOPES.all },
  );
  assert.equal(plan.outcome, "empty");
  assert.equal(plan.rendered_count, 0);

  const previewRequest = previewFormFactorRequest("all", QUERY);
  const previewPayload = await fetchSurface(previewRequest.path, provider);
  assert.equal(previewFormFactorOutcome("all", previewPayload, previewRequest).outcome, "empty");

  const contractsRequest = contractScopedRetrievalRequest({ query: QUERY });
  const contractsPayload = await fetchSurface(contractsRequest.path, provider);
  assert.equal(contractScopedRetrievalOutcome(contractsPayload, contractsRequest).outcome, "empty");

  for (const source of BROWSE_SOURCES) {
    const request = browseScopedRequest(source, QUERY);
    const payload = await fetchSurface(request.path, provider);
    assert.equal(browseScopedOutcome(source, payload, request).outcome, "empty", `${source} Browse`);
  }
});

test("a single degraded lens (partial coverage) surfaces as 'partial' only where that lens is in scope", async () => {
  const universe = buildUniverse();
  // "land" participates in the `land` Browse scope only — `property` Browse
  // (parcels lens) and Contracts Browse (notices/vendors) must be unaffected.
  const provider = buildProvider(universe, { coverageOverrides: { land: { state: "partial" } } });

  const searchPayload = await fetchSurface(allSourcesFederatedSearchPath(QUERY), provider);
  const plan = buildSearchRenderPlan(
    { state: "legacy", payload: searchPayload, coverage: searchPayload.coverage },
    { scope: SEARCH_FRONT_DOOR_SCOPES.all },
  );
  assert.equal(plan.outcome, "partial");
  assert.ok(plan.incomplete_families.includes("land"), "Full Search must disclose the land family as incomplete");

  const landRequest = browseScopedRequest("land", QUERY);
  const landPayload = await fetchSurface(landRequest.path, provider);
  const landOutcome = browseScopedOutcome("land", landPayload, landRequest);
  assert.equal(landOutcome.outcome, "partial");
  assert.equal(landOutcome.coverage_state, "partial");

  const propertyRequest = browseScopedRequest("property", QUERY);
  const propertyPayload = await fetchSurface(propertyRequest.path, provider);
  const propertyOutcome = browseScopedOutcome("property", propertyPayload, propertyRequest);
  assert.equal(propertyOutcome.outcome, "matched", "property Browse does not request the land lens and must be unaffected");

  const contractsRequest = contractScopedRetrievalRequest({ query: QUERY });
  const contractsPayload = await fetchSurface(contractsRequest.path, provider);
  assert.equal(contractScopedRetrievalOutcome(contractsPayload, contractsRequest).outcome, "matched");
});

test("a stale lens carries its exact freshness clock onto every surface that requested it, and nowhere else", async () => {
  const staleAsOf = "2026-01-01T00:00:00Z";
  const universe = buildUniverse();
  const provider = buildProvider(universe, { coverageOverrides: { meetings: { state: "stale", as_of: staleAsOf } } });
  const oracle = (await fetchSurface(allSourcesFederatedSearchPath(QUERY), provider)).federated;
  assert.equal(asOfForLens(oracle, "meetings"), staleAsOf);

  const searchPayload = await fetchSurface(allSourcesFederatedSearchPath(QUERY), provider);
  const plan = buildSearchRenderPlan(
    { state: "legacy", payload: searchPayload, coverage: searchPayload.coverage },
    { scope: SEARCH_FRONT_DOOR_SCOPES.all },
  );
  assert.equal(plan.outcome, "partial");
  assert.ok(plan.incomplete_families.includes("meetings"));

  const meetingsRequest = browseScopedRequest("meetings", QUERY);
  const meetingsPayload = await fetchSurface(meetingsRequest.path, provider);
  const meetingsOutcome = browseScopedOutcome("meetings", meetingsPayload, meetingsRequest);
  assert.equal(meetingsOutcome.outcome, "partial");
  assert.equal(meetingsOutcome.coverage_state, "stale");
  assert.equal(meetingsOutcome.as_of_by_lens.meetings, staleAsOf, "the stale lens's own clock must survive verbatim");

  // Rules Browse also requests the `notices` lens only — the stale meetings
  // lens is out of its scope and must not degrade it.
  const rulesRequest = browseScopedRequest("rules", QUERY);
  const rulesPayload = await fetchSurface(rulesRequest.path, provider);
  assert.equal(browseScopedOutcome("rules", rulesPayload, rulesRequest).outcome, "matched");
});

test("a failed lens reports 'unavailable' at the scope level, and Full Search's coarser vocabulary folds it into 'partial' rather than inventing an empty result", async () => {
  const universe = buildUniverse();
  const provider = buildProvider(universe, { failing: ["parcels"] });

  // Full Search has no "unavailable" state for a single failed lens: only a
  // total fetch failure produces that state. A partial lens outage is
  // disclosed as an incomplete family — never silently promoted to a false
  // "no results" statement, and never claimed as the scope-level
  // "unavailable" vocabulary Browse/Preview use. This is the one documented
  // vocabulary difference this gate must assert rather than flag.
  const searchPayload = await fetchSurface(allSourcesFederatedSearchPath(QUERY), provider);
  const plan = buildSearchRenderPlan(
    { state: "legacy", payload: searchPayload, coverage: searchPayload.coverage },
    { scope: SEARCH_FRONT_DOOR_SCOPES.all },
  );
  assert.equal(plan.outcome, "partial");
  assert.ok(plan.incomplete_families.includes("land"));

  const propertyRequest = browseScopedRequest("property", QUERY);
  const propertyPayload = await fetchSurface(propertyRequest.path, provider);
  const propertyOutcome = browseScopedOutcome("property", propertyPayload, propertyRequest);
  assert.equal(propertyOutcome.outcome, "unavailable");
  assert.equal(propertyOutcome.coverage_state, "provider_unavailable");
  assert.equal(propertyOutcome.documents.length, 0);
  assert.notEqual(propertyOutcome.outcome, "empty");

  const landRequest = browseScopedRequest("land", QUERY);
  const landPayload = await fetchSurface(landRequest.path, provider);
  assert.equal(browseScopedOutcome("land", landPayload, landRequest).outcome, "matched", "land Browse does not request the parcels lens and must be unaffected");

  const previewRequest = previewFormFactorRequest("all", QUERY);
  const previewPayload = await fetchSurface(previewRequest.path, provider);
  assert.equal(previewFormFactorOutcome("all", previewPayload, previewRequest).outcome, "partial", "Preview all-sources includes other matched lenses alongside the failed one");
});

test("a Browse source's local typed-filter projection never invents a candidate or discards its federated evidence", async () => {
  const universe = buildUniverse();
  const provider = buildProvider(universe);
  const oracle = (await fetchSurface(allSourcesFederatedSearchPath(QUERY), provider)).federated;
  const meetingsCanonical = canonicalSequence(
    oracle,
    FEDERATED_SEARCH_PRESENTATION_SCOPES.meetings.domains,
    FEDERATED_SEARCH_PRESENTATION_SCOPES.meetings.lenses,
  );
  assert.equal(meetingsCanonical.length, 1);
  const canonicalDocument = meetingsCanonical[0];

  const meetingsRequest = browseScopedRequest("meetings", QUERY);
  const meetingsPayload = await fetchSurface(meetingsRequest.path, provider);
  const meetingsOutcome = browseScopedOutcome("meetings", meetingsPayload, meetingsRequest);

  // A local retained row plus an unrelated local row with no federated match.
  const localRows = [
    { meeting_id: canonicalDocument.object_ref, title: "Locally retained meeting", affected_area: { scope: "Brooklyn" } },
    { meeting_id: "meeting:local-only-not-federated", title: "Local-only meeting record" },
  ];
  const projected = projectBrowseScopedRows(meetingsOutcome, localRows, (row) => row.meeting_id);

  assert.equal(projected.rows.length, 1, "only the row a federated candidate actually matched may appear");
  const [row] = projected.rows;
  assert.equal(row._scoped_search.object_ref, canonicalDocument.object_ref, "typed-filter projection must not invent a candidate identity");
  assert.deepEqual(row._scoped_search.match_fields, canonicalDocument.match_fields, "typed-filter projection must not discard match evidence");
  assert.equal(row._scoped_search.provenance?.producer, canonicalDocument.provenance.producer, "typed-filter projection must not discard provenance");
  assert.equal(row.affected_area.scope, "Brooklyn", "the local typed field is a presentation projection, not a federated field");
  assert.deepEqual(projected.unresolved_refs, [], "no local row was falsely matched, and the one unmatched local row is not fabricated into a result");
});

test("every migrated Browse source names the closed capability contract, not a private retrieval path", () => {
  for (const source of BROWSE_SOURCES) {
    const scope = BROWSE_SCOPED_ADAPTERS[source];
    assert.deepEqual(scope.lenses, FEDERATED_SEARCH_PRESENTATION_SCOPES[source].lenses);
    const request = browseScopedRequest(source, QUERY);
    assert.equal(request.capability_reference, FEDERATED_SEARCH_CAPABILITY_REFERENCE);
    assert.ok(request.result_bound <= FEDERATED_SEARCH_LIMITS.maximumResults);
  }
});

test("the cross-surface adapters read the shared federated envelope; none of them re-run federation", () => {
  const modules = [
    "../site/search_document.mjs",
    "../site/preview_federated_form_factor.mjs",
    "../site/contract_search_bridge.mjs",
    "../site/browse_scoped_adapters.mjs",
  ];
  for (const modulePath of modules) {
    const source = readFileSync(new URL(modulePath, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /federateUniversalSearch\(/,
      `${modulePath} must consume the capability's HTTP projection, not re-run cross-lens federation itself`,
    );
  }
});
