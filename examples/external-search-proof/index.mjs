#!/usr/bin/env node

// Independent consumer for the documented CityScroll search HTTP interface.
// Only platform modules are imported; the consumer does not depend on the
// site's source tree, worker implementation, or capability modules.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const DEFAULT_API_ORIGIN = "https://api.cityscroll.org";
export const SEARCH_HTTP_PATH = "/search";
export const CAPABILITY_REFERENCE = "search.federated@1";
export const FEDERATED_SCHEMA = "cityscroll.universal_search_federator.v1";
export const RESULT_SCHEMA = "cityscroll.universal_search_result.v1";
export const PROOF_SCHEMA = "cityscroll.external_search_proof.v1";
export const LENSES = Object.freeze([
  "notices",
  "people",
  "agencies",
  "vendors",
  "committees",
  "community_boards",
  "exams",
  "parcels",
  "land",
  "meetings",
]);
export const BOUNDS = Object.freeze({
  queryMaximumLength: 240,
  defaultResults: 40,
  maximumResults: 100,
  maximumCardsPerLane: 8,
});
export const COVERAGE_STATES = Object.freeze([
  "matched",
  "empty",
  "partial",
  "stale",
  "not_indexed",
  "provider_unavailable",
]);

const PRIVATE_FIELDS = new Set([
  "raw_snapshot",
  "normalized_snapshot",
  "content_hash",
  "evidence_json",
  "resolution_run_id",
  "review_status",
]);

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNoPrivateFields(value, path = "response") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_FIELDS.has(key)) throw new Error(`public response exposed forbidden field ${path}.${key}`);
    assertNoPrivateFields(child, `${path}.${key}`);
  }
}

function resultKey(result) {
  return `${result.object_type}:${result.object_ref}:${result.canonical_href}`;
}

function validateCoverage(coverage, label) {
  assertObject(coverage, `${label} coverage`);
  assertObject(coverage.by_lens, `${label} coverage.by_lens`);
  if (Object.keys(coverage.by_lens).length !== LENSES.length
      || LENSES.some((lens) => !coverage.by_lens[lens])) {
    throw new Error(`${label} coverage must enumerate all registered lenses`);
  }
  for (const lens of LENSES) {
    const row = coverage.by_lens[lens];
    if (row.lens !== lens || !COVERAGE_STATES.includes(row.state)) {
      throw new Error(`${label} coverage has an invalid ${lens} row`);
    }
    if (row.as_of !== null && row.as_of !== undefined && typeof row.as_of !== "string") {
      throw new Error(`${label} coverage ${lens} freshness must be a string or null`);
    }
  }
}

function validateFederatedResult(result, index) {
  assertObject(result, `federated result ${index}`);
  if (result.result_schema !== RESULT_SCHEMA
      || typeof result.object_ref !== "string"
      || typeof result.object_type !== "string"
      || typeof result.canonical_href !== "string"
      || !Array.isArray(result.source_observation_refs)
      || result.source_observation_refs.length === 0
      || !result.source_observation_refs.every((ref) => typeof ref === "string" && ref)
      || typeof result.provenance?.producer !== "string"
      || !Array.isArray(result.match_fields)
      || result.match_fields.length === 0) {
    throw new Error(`federated result ${index} is missing public identity, evidence, or provenance`);
  }
}

function validatePublicResponse(response, expectedQuery) {
  assertObject(response, "CityScroll search response");
  assertNoPrivateFields(response);
  if (response.capability_reference !== CAPABILITY_REFERENCE) {
    throw new Error(`expected documented ${CAPABILITY_REFERENCE} response`);
  }
  assertObject(response.federated, "federated response");
  if (response.federated.schema !== FEDERATED_SCHEMA
      || response.federated.query?.normalized !== expectedQuery
      || !Array.isArray(response.federated.results)
      || response.federated.results.length > BOUNDS.maximumResults) {
    throw new Error("federated response is outside the documented result contract");
  }
  validateCoverage(response.federated.coverage, "federated");
  response.federated.results.forEach(validateFederatedResult);
  if (!Array.isArray(response.results) || response.results.length > BOUNDS.maximumResults) {
    throw new Error("site search projection is outside the documented result bound");
  }
  response.results.forEach((result, index) => {
    assertObject(result, `site result ${index}`);
    if (typeof result.object_ref !== "string" || typeof result.object_type !== "string"
        || typeof result.canonical_href !== "string") {
      throw new Error(`site result ${index} is missing canonical identity or route`);
    }
  });
  validateCoverage(response.coverage, "site");
  for (const lane of response.lanes || []) {
    if (!Array.isArray(lane.cards) || lane.cards.length > BOUNDS.maximumCardsPerLane) {
      throw new Error(`site lane ${lane.id || "unknown"} exceeds the documented card bound`);
    }
  }
}

function compareSiteProjection(response) {
  const capabilityKeys = response.federated.results.map(resultKey);
  const siteKeys = response.results.map(resultKey);
  if (JSON.stringify(capabilityKeys) !== JSON.stringify(siteKeys)) {
    throw new Error("site projection changed the federated result identity or order");
  }
  return {
    equivalent: true,
    compared_fields: ["object_ref", "object_type", "canonical_href", "result_order"],
    result_count: capabilityKeys.length,
    result_keys: capabilityKeys,
  };
}

function summarizeCase(entry) {
  const query = String(entry.query || "").trim();
  if (!query || query.length > BOUNDS.queryMaximumLength) {
    throw new Error(`query must be non-empty and at most ${BOUNDS.queryMaximumLength} characters: ${query}`);
  }
  validatePublicResponse(entry.response, query);
  const comparison = compareSiteProjection(entry.response);
  const coverage = Object.fromEntries(LENSES.map((lens) => {
    const row = entry.response.federated.coverage.by_lens[lens];
    return [lens, {
      state: row.state,
      matched_count: row.matched_count ?? null,
      indexed_count: row.indexed_count ?? null,
      source: row.source ?? null,
      as_of: row.as_of ?? null,
    }];
  }));
  const provenance = entry.response.federated.results.map((result) => ({
    object_ref: result.object_ref,
    object_type: result.object_type,
    canonical_href: result.canonical_href,
    source_observation_refs: [...result.source_observation_refs],
    producer: result.provenance.producer,
    match_fields: result.match_fields.map(({ field, matched_term, source_observation_ref }) => ({
      field,
      matched_term,
      source_observation_ref,
    })),
  }));
  return {
    query,
    input: { http: `GET ${SEARCH_HTTP_PATH}?q=${encodeURIComponent(query)}` },
    output: {
      capability_schema: entry.response.federated.schema,
      result_count: comparison.result_count,
      result_keys: comparison.result_keys,
    },
    comparison,
    coverage,
    provenance,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function buildExternalSearchProof(fixture, { fixtureBytes = null } = {}) {
  assertObject(fixture, "external search fixture");
  if (fixture.schema !== "cityscroll.external_search_fixture.v1") {
    throw new Error("fixture schema is not the external search fixture contract");
  }
  if (fixture.source?.capability_reference !== CAPABILITY_REFERENCE
      || fixture.source?.route !== "GET /search") {
    throw new Error("fixture source is not the documented public search operation");
  }
  if (!Array.isArray(fixture.cases) || fixture.cases.length < 2) {
    throw new Error("the proof needs at least two representative queries");
  }
  const cases = fixture.cases.map(summarizeCase);
  return {
    schema: PROOF_SCHEMA,
    consumer: "external-search-proof",
    source: {
      interface: "documented public HTTP",
      capability_reference: CAPABILITY_REFERENCE,
      route: "GET /search",
      origin: fixture.source.origin,
      captured_at: fixture.source.captured_at,
      fixture_sha256: fixtureBytes ? sha256(fixtureBytes) : null,
    },
    bounds: {
      query_maximum_length: BOUNDS.queryMaximumLength,
      maximum_results: BOUNDS.maximumResults,
      maximum_cards_per_lane: BOUNDS.maximumCardsPerLane,
      cases: cases.length,
    },
    cases,
    stop_condition: "Reopen the parity workstream if this proof needs undocumented fields, private imports, rendered-page scraping, arbitrary queries, or a coupled new abstraction.",
  };
}

export async function fetchExternalSearchCase({ apiOrigin = DEFAULT_API_ORIGIN, query, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required");
  const normalized = String(query || "").trim();
  if (!normalized || normalized.length > BOUNDS.queryMaximumLength) {
    throw new Error(`query must be non-empty and at most ${BOUNDS.queryMaximumLength} characters`);
  }
  const url = new URL(SEARCH_HTTP_PATH, apiOrigin);
  url.searchParams.set("q", normalized);
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok) throw new Error(`CityScroll search returned HTTP ${response.status}`);
  validatePublicResponse(payload, normalized);
  return { url: url.toString(), response: payload };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--fixture", "--receipt", "--base-url", "--query"].includes(arg)) {
      args[arg.slice(2).replaceAll("-", "_")] = argv[++index];
    } else if (arg === "--json") {
      args.json = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.fixture) {
      const fixtureBytes = readFileSync(args.fixture);
      const proof = buildExternalSearchProof(JSON.parse(fixtureBytes), { fixtureBytes });
      if (args.receipt) writeFileSync(args.receipt, `${JSON.stringify(proof, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
    } else {
      const query = args.query || "parks";
      const result = await fetchExternalSearchCase({ apiOrigin: args.base_url || DEFAULT_API_ORIGIN, query });
      process.stdout.write(`${JSON.stringify({ query, source: result.url, result_count: result.response.results.length }, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`external search proof: ${error.message}\n`);
    process.exitCode = 1;
  }
}
