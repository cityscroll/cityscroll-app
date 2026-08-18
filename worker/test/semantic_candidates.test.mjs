import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/worker.mjs";
import {
  SEMANTIC_CANDIDATE_RESPONSE_SCHEMA,
  handleSemanticCandidates,
  retrieveTypedCandidates,
} from "../src/semantic_candidates.mjs";

const NOTICE_SCHEMA = readFileSync(new URL("../migrations/0001_notices.sql", import.meta.url), "utf8");
const FACTS_SCHEMA = readFileSync(new URL("../migrations/0010_notice_facts.sql", import.meta.url), "utf8");
const FTS_SCHEMA = readFileSync(new URL("../migrations/0016_notice_fts.sql", import.meta.url), "utf8");
const WRANGLER = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(NOTICE_SCHEMA);
  sqlite.exec(FACTS_SCHEMA);
  sqlite.prepare(`INSERT INTO notices
    (request_id, section, agency, type_of_notice, short_title, description,
     start_date, haystack, document_urls, n_documents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 0)`)
    .run(
      "20260715041",
      "Agency Rules",
      "Buildings",
      "Notice",
      "Amendments to Rules Relating to the Energy Conservation Code",
      "Energy conservation requirements.",
      "2026-07-23",
      "amendments rules energy conservation code buildings",
    );
  sqlite.exec(FTS_SCHEMA);
  return {
    sqlite,
    DB: {
      prepare(sql) {
        const statement = sqlite.prepare(sql);
        let args = [];
        const wrapper = {
          bind(...values) { args = values; return wrapper; },
          async all() { return { results: statement.all(...args), meta: { rows_read: 1 } }; },
          async first() { return statement.get(...args) ?? null; },
        };
        return wrapper;
      },
    },
  };
}

test("typed candidate retrieval uses the committed manifest and exact source passages", () => {
  const response = retrieveTypedCandidates({
    query: "energy conservation",
    filters: { source_family: "city_record_notice" },
    limit: 5,
  });

  assert.equal(response.schema, SEMANTIC_CANDIDATE_RESPONSE_SCHEMA);
  assert.equal(response.query, "energy conservation");
  assert.equal(response.method, "lexical_fallback_v1");
  assert.equal(response.corpus.schema, "cityscroll.semantic_retrieval.corpus_manifest.v1");
  assert.equal(response.corpus.manifest_version, 1);
  assert.match(response.corpus.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(response.index.schema, "cityscroll.semantic_retrieval.source_passage_map.v1");
  assert.match(response.index.version, /^[a-f0-9]{64}$/);
  assert.deepEqual(response.hard_scope, {
    state: "applied",
    filters: { source_family: "city_record_notice" },
  });
  assert.equal(response.coverage.state, "partial");
  assert.ok(response.candidates.length > 0);

  const target = response.candidates.find((candidate) => (
    candidate.source.id === "city_record_notice:20260715041"
  ));
  assert.ok(target);
  assert.deepEqual({
    candidate_id: target.candidate_id,
    civic_object_family: target.civic_object_family,
    source_id: target.source.id,
    source_family: target.source.family,
    source_url: target.source.url,
    source_canonical_href: target.source.canonical_href,
    matched_terms: target.matched_terms,
    passage_id: target.passage.id,
    passage_text: target.passage.text,
    method: target.method,
    coverage_state: target.coverage_state,
  }, {
    candidate_id: "city_record_notice:20260715041:p0001",
    civic_object_family: "rules",
    source_id: "city_record_notice:20260715041",
    source_family: "city_record_notice",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260715041",
    source_canonical_href: "/notices/20260715041",
    matched_terms: ["energy", "conservation"],
    passage_id: "city_record_notice:20260715041:p0001",
    passage_text: "Amendments to Rules Relating to the Energy Conservation Code\nBuildings\nAgency Rules",
    method: "lexical_fallback_v1",
    coverage_state: "partial",
  });

  const publicJson = JSON.stringify(response);
  assert.doesNotMatch(publicJson, /cosine|confidence|legal_conclusion|graph_edge|score/i);
});

test("hard source, geography, and date filters apply before candidate ranking", () => {
  const excluded = retrieveTypedCandidates({
    query: "energy conservation",
    filters: {
      source_family: "city_record_notice",
      body_id: "manhattan-cb-06",
      published_from: "2026-07-01",
      published_to: "2026-07-31",
    },
    limit: 5,
  });
  assert.equal(excluded.hard_scope.state, "applied");
  assert.deepEqual(excluded.candidates, []);

  const attachmentOnly = retrieveTypedCandidates({
    query: "Cannonsville watershed",
    filters: { source_family: "attachment_text" },
    limit: 5,
  });
  assert.equal(attachmentOnly.candidates.length, 2);
  assert.ok(attachmentOnly.candidates.every((candidate) => candidate.source.family === "attachment_text"));
});

test("GET /search/candidates stays separate from the six-family keyword response", async () => {
  const { sqlite, DB } = database();
  try {
    const candidateResponse = await worker.fetch(new Request(
      "https://api.cityscroll.org/search/candidates?q=energy%20conservation&source_family=city_record_notice",
      { headers: { Origin: "https://cityscroll.org" } },
    ), { DB }, {});
    assert.equal(candidateResponse.status, 200);
    assert.equal((await candidateResponse.json()).schema, SEMANTIC_CANDIDATE_RESPONSE_SCHEMA);

    const lexicalResponse = await worker.fetch(
      new Request("https://api.cityscroll.org/search?q=energy%20conservation"),
      { DB },
      {},
    );
    const lexical = await lexicalResponse.json();
    assert.equal(lexical.schema, "cityscroll.keyword_search_response.v1");
    assert.equal(lexical.match_mode, "keyword");
    assert.equal(lexical.lanes.length, 7);
    assert.ok(Array.isArray(lexical.results));
    assert.equal(Object.hasOwn(lexical, "candidates"), false);
  } finally {
    sqlite.close();
  }
});

test("kill switch, cancellation, timeout, cache failure, and provider failure return the existing lexical response", async () => {
  const { sqlite, DB } = database();
  try {
    const lexical = await worker.fetch(
      new Request("https://api.cityscroll.org/search?q=energy%20conservation"),
      { DB },
      {},
    );
    const expectedBody = await lexical.text();

    const scenarios = [
      {
        name: "kill switch",
        env: { DB, SEMANTIC_CANDIDATES_ENABLED: "false" },
        options: {},
      },
      {
        name: "cache failure",
        env: { DB },
        options: { retrieve: async () => { throw new Error("candidate cache unavailable"); } },
      },
      {
        name: "provider failure",
        env: { DB },
        options: { retrieve: async () => { throw new Error("candidate provider unavailable"); } },
      },
      {
        name: "timeout",
        env: { DB },
        options: { retrieve: () => new Promise(() => {}), timeoutMs: 1 },
      },
    ];

    for (const scenario of scenarios) {
      const response = await handleSemanticCandidates(
        new Request("https://api.cityscroll.org/search/candidates?q=energy%20conservation"),
        scenario.env,
        scenario.options,
      );
      assert.equal(response.status, 200, scenario.name);
      assert.equal(await response.text(), expectedBody, scenario.name);
    }

    const controller = new AbortController();
    controller.abort();
    const cancelled = await handleSemanticCandidates(
      new Request("https://api.cityscroll.org/search/candidates?q=energy%20conservation", {
        signal: controller.signal,
      }),
      { DB },
    );
    assert.equal(cancelled.status, 200);
    assert.equal(await cancelled.text(), expectedBody);
  } finally {
    sqlite.close();
  }
});

test("candidate endpoint rejects invalid scope rather than weakening it", async () => {
  const invalidFamily = await handleSemanticCandidates(new Request(
    "https://api.cityscroll.org/search/candidates?q=energy&source_family=not-a-family",
  ), {});
  assert.equal(invalidFamily.status, 400);
  assert.deepEqual(await invalidFamily.json(), { ok: false, reason: "invalid-source-family" });

  const invalidDate = await handleSemanticCandidates(new Request(
    "https://api.cityscroll.org/search/candidates?q=energy&published_from=yesterday",
  ), {});
  assert.equal(invalidDate.status, 400);
  assert.deepEqual(await invalidDate.json(), { ok: false, reason: "invalid-published-from" });

  const impossibleDate = await handleSemanticCandidates(new Request(
    "https://api.cityscroll.org/search/candidates?q=energy&published_to=2026-02-31",
  ), {});
  assert.equal(impossibleDate.status, 400);
  assert.deepEqual(await impossibleDate.json(), { ok: false, reason: "invalid-published-to" });
});

test("production and beta declare the typed-candidate kill switch", () => {
  assert.equal((WRANGLER.match(/SEMANTIC_CANDIDATES_ENABLED = "true"/g) || []).length, 2);
});
