import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CITED_PASSAGES_AVAILABILITY,
  CITED_PASSAGES_CAPABILITY_REFERENCE,
  CITED_PASSAGES_LIMITS,
  CITED_PASSAGES_PROVIDER_ID,
  CITED_PASSAGES_SOURCE_FAMILIES,
  executeCitedPassages,
} from "../../capabilities/cited_passages.mjs";
import {
  handleMcp,
  mcpCitedPassagesInput,
} from "../src/mcp.mjs";
import {
  handleCitedPassages,
  HTTP_CITED_PASSAGES_ADAPTER,
  retrieveCitedPassages,
  workerCitedPassages,
} from "../src/cited_retrieval.mjs";
import { SEMANTIC_SOURCE_FAMILIES } from "../src/semantic_candidates.mjs";

const EVIDENCE_RECEIPT = JSON.parse(readFileSync(
  new URL("../../artifacts/capability-spine/cs-04-cited-passages.json", import.meta.url),
  "utf8",
));

class MockKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, String(value)); }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function post(arguments_) {
  return new Request("https://api.cityscroll.org/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "203.0.113.44" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "retrieve_cited_passages", arguments: arguments_ },
    }),
  });
}

function assertEvidenceOnly(result) {
  assert.ok(result.citations.length <= CITED_PASSAGES_LIMITS.maximumResults);
  assert.doesNotMatch(
    JSON.stringify(result),
    /"(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship|score|cosine|confidence)(?:_|\")/i,
  );
  for (const citation of result.citations) {
    assert.equal(citation.citation_id, citation.passage.id);
    assert.equal(citation.exact_join_evidence.state, "matched");
    assert.equal(citation.exact_join_evidence.source_record_id, citation.source.id);
    assert.equal(citation.exact_join_evidence.passage_id, citation.passage.id);
  }
}

test("direct provider preserves stable citations for every frozen source family", async () => {
  assert.deepEqual(CITED_PASSAGES_SOURCE_FAMILIES, SEMANTIC_SOURCE_FAMILIES);
  assert.equal(EVIDENCE_RECEIPT.capability.reference, CITED_PASSAGES_CAPABILITY_REFERENCE);
  assert.deepEqual(EVIDENCE_RECEIPT.capability.source_families, CITED_PASSAGES_SOURCE_FAMILIES);
  assert.deepEqual(EVIDENCE_RECEIPT.capability.availability, CITED_PASSAGES_AVAILABILITY);

  const provider = workerCitedPassages();
  assert.equal(provider.capabilityReference, CITED_PASSAGES_CAPABILITY_REFERENCE);
  assert.equal(provider.providerId, CITED_PASSAGES_PROVIDER_ID);
  for (const fixture of EVIDENCE_RECEIPT.fixtures) {
    const input = {
      query: fixture.query,
      filters: { source_family: fixture.source_family },
      limit: fixture.limit,
    };
    const result = await executeCitedPassages(provider, input);
    assertEvidenceOnly(result);
    assert.equal(result.coverage.state, fixture.coverage_state);
    assert.equal(result.retrieval.corpus.manifest_sha256, fixture.corpus_manifest_sha256);
    assert.equal(result.retrieval.corpus.content_sha256, fixture.corpus_content_sha256);
    assert.equal(result.retrieval.index.version, fixture.passage_map_sha256);
    assert.equal(sha256(JSON.stringify(result)), fixture.response_sha256);
    assert.deepEqual(result.citations.map((citation) => ({
      citation_id: citation.citation_id,
      source_id: citation.source.id,
      source_url: citation.source.url,
      passage_text_sha256: sha256(citation.passage.text ?? ""),
      coverage_state: citation.coverage_state,
      freshness: citation.freshness,
      exact_join_evidence: citation.exact_join_evidence,
    })), fixture.citations);
  }
});

test("capability validation returns the existing response object without widening it", async () => {
  const input = {
    query: "energy conservation",
    filters: { source_family: "city_record_notice" },
    limit: 5,
  };
  const existing = retrieveCitedPassages(input);
  const provider = {
    capabilityReference: CITED_PASSAGES_CAPABILITY_REFERENCE,
    providerId: CITED_PASSAGES_PROVIDER_ID,
    async execute() { return existing; },
  };
  assert.equal(await executeCitedPassages(provider, input), existing);
  assert.deepEqual(Object.keys(existing), [
    "schema", "contract_version", "query", "retrieval", "hard_scope", "coverage", "citations",
  ]);
});

test("input and output boundaries fail closed on arbitrary scope, scores, joins, and over-limit results", async () => {
  const provider = workerCitedPassages();
  await assert.rejects(
    executeCitedPassages(provider, { query: "energy", filters: {}, answer: true }),
    /does not accept arbitrary field/,
  );
  await assert.rejects(
    executeCitedPassages(provider, { query: "energy", filters: { source_family: "invented" } }),
    /not part of the cited retrieval corpus/,
  );

  const input = { query: "energy conservation", filters: { source_family: "city_record_notice" }, limit: 5 };
  const direct = await executeCitedPassages(provider, input);
  const providerFor = (result) => ({
    capabilityReference: CITED_PASSAGES_CAPABILITY_REFERENCE,
    providerId: CITED_PASSAGES_PROVIDER_ID,
    async execute() { return result; },
  });
  await assert.rejects(
    executeCitedPassages(providerFor({ ...direct, score: 0.99 }), input),
    /forbidden semantics/,
  );
  await assert.rejects(
    executeCitedPassages(providerFor({ ...direct, query: "different query" }), input),
    /response contract drifted/,
  );
  await assert.rejects(
    executeCitedPassages(providerFor({
      ...direct,
      citations: direct.citations.map((citation) => ({
        ...citation,
        exact_join_evidence: { ...citation.exact_join_evidence, source_record_id: "inferred:source" },
      })),
    }), input),
    /exact join evidence is inconsistent/,
  );
  const unknownJoin = {
    ...direct,
    citations: direct.citations.map((citation) => ({
      ...citation,
      exact_join_evidence: {
        state: "unknown",
        method: null,
        candidate_id: citation.citation_id,
        source_record_id: null,
        passage_id: null,
      },
    })),
  };
  assert.equal(await executeCitedPassages(providerFor(unknownJoin), input), unknownJoin);

  const attachment = retrieveCitedPassages({
    query: "forest management",
    filters: { source_family: "attachment_text" },
    limit: 5,
  });
  await assert.rejects(
    executeCitedPassages(providerFor(attachment), {
      query: "forest management",
      filters: { source_family: "attachment_text" },
      limit: 1,
    }),
    /exceed the declared bound/,
  );
});

test("MCP structured content is byte-compatible with the direct provider", async () => {
  const arguments_ = {
    query: "energy conservation",
    source_family: "city_record_notice",
    limit: 5,
  };
  const direct = await executeCitedPassages(workerCitedPassages(), mcpCitedPassagesInput(arguments_));
  const mcp = await (await handleMcp(post(arguments_), {
    SUBS: new MockKV(),
    NL_METER: new MockKV(),
  })).json();
  assert.equal(JSON.stringify(mcp.result.structuredContent), JSON.stringify(direct));
  assert.equal(
    mcp.result.content[0].text,
    "Returned 1 source passage. Use the structured citations for source text and links.",
  );
  assertEvidenceOnly(mcp.result.structuredContent);
});

test("HTTP JSON and text adapters preserve the direct cited-passages semantics", async () => {
  const input = {
    query: "energy conservation",
    filters: { source_family: "city_record_notice" },
    limit: 5,
  };
  const direct = await executeCitedPassages(workerCitedPassages(), input);
  assert.equal(HTTP_CITED_PASSAGES_ADAPTER.capabilityReference, CITED_PASSAGES_CAPABILITY_REFERENCE);

  const jsonResponse = await handleCitedPassages(new Request(
    "https://api.cityscroll.org/cited-passages?q=energy%20conservation&source_family=city_record_notice&limit=5",
    { headers: { Accept: "application/json" } },
  ), {});
  assert.equal(jsonResponse.status, 200);
  assert.deepEqual(await jsonResponse.json(), direct);

  const textResponse = await handleCitedPassages(new Request(
    "https://api.cityscroll.org/cited-passages?q=energy%20conservation&source_family=city_record_notice&limit=5&format=text",
  ), {});
  assert.equal(textResponse.status, 200);
  assert.equal(await textResponse.text(), "Returned 1 source passage. Use the structured citations for source text and links.");
});
