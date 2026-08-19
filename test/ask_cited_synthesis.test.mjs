import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ASK_CITED_QUOTES_KEYS,
  ASK_CITED_QUOTES_SCHEMA,
  projectAskCitedQuotes,
  renderAskCitedQuotesHtml,
} from "../site/ask_cited_synthesis.mjs";
import {
  projectCitedRetrievalResponse,
  retrieveCitedPassages,
} from "../worker/src/cited_retrieval.mjs";
import { retrieveTypedCandidates } from "../worker/src/semantic_candidates.mjs";

const SOURCE = readFileSync(new URL("../site/ask_cited_synthesis.mjs", import.meta.url), "utf8");
const ENERGY_CITATION = "city_record_notice:20260715041:p0001";
const ENERGY_SOURCE_URL = "https://a856-cityrecord.nyc.gov/RequestDetail/20260715041";

function assertQuoteOnly(view) {
  assert.equal(view.schema, ASK_CITED_QUOTES_SCHEMA);
  assert.deepEqual(Object.keys(view), [...ASK_CITED_QUOTES_KEYS]);
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.quotes));
  assert.doesNotMatch(
    JSON.stringify(view),
    /(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship)/i,
  );
  for (const quote of view.quotes) {
    assert.equal(quote.exact_join_evidence.state, "matched");
    assert.match(quote.source.url, /^https?:\/\//);
    assert.equal(quote.citation_id, quote.passage.id);
    assert.ok(quote.passage.text.trim());
  }
}

test("Ask quotes only exact-join matched passages from cited retrieval", () => {
  const cited = retrieveCitedPassages({ query: "energy conservation", limit: 5 });
  const view = projectAskCitedQuotes(cited);
  assertQuoteOnly(view);
  assert.equal(view.query, "energy conservation");
  assert.ok(view.quotes.some((quote) => quote.citation_id === ENERGY_CITATION));
  const energy = view.quotes.find((quote) => quote.citation_id === ENERGY_CITATION);
  assert.equal(energy.source.url, ENERGY_SOURCE_URL);
  assert.equal(energy.source.canonical_href, "/notices/20260715041");
  assert.match(energy.passage.text, /Energy Conservation Code/);
});

test("unknown-join and drifted evidence stay unquoted", () => {
  const candidates = retrieveTypedCandidates({
    query: "energy conservation",
    filters: { source_family: "city_record_notice" },
    limit: 1,
  });
  const unknown = projectCitedRetrievalResponse(candidates, {
    passageMap: {
      schema: candidates.index.schema,
      map_sha256: candidates.index.version,
      by_candidate_id: {},
      sources: [],
      passages: [],
    },
  });
  const unknownView = projectAskCitedQuotes(unknown);
  assertQuoteOnly(unknownView);
  assert.equal(unknownView.quotes.length, 0);
  assert.equal(unknownView.coverage.quoted_count, 0);
  assert.ok(unknownView.coverage.omitted_unknown_count >= 1);

  candidates.index.version = "0".repeat(64);
  const drifted = projectAskCitedQuotes(projectCitedRetrievalResponse(candidates));
  assertQuoteOnly(drifted);
  assert.equal(drifted.quotes.length, 0);
});

test("a miss does not invent citations", () => {
  const view = projectAskCitedQuotes(retrieveCitedPassages({
    query: "zzzz-not-a-real-civic-topic-xyzzy",
    limit: 5,
  }));
  assertQuoteOnly(view);
  assert.deepEqual(view.quotes, []);
  assert.equal(view.coverage.quoted_count, 0);
});

test("quote card HTML quotes the passage and names the official source", () => {
  const view = projectAskCitedQuotes(retrieveCitedPassages({ query: "energy conservation" }));
  const html = renderAskCitedQuotesHtml(view, {
    t: (key) => ({
      ask_cited_quotes_heading: "Quoted from official records",
      topic_search_official_source: "Official source",
    }[key] || key),
    escape: (value) => String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/"/g, "&quot;"),
  });
  assert.match(html, /data-ask-cited="1"/);
  assert.match(html, /Quoted from official records/);
  assert.match(html, /Energy Conservation Code/);
  assert.match(html, /\/notices\/20260715041/);
  assert.match(html, /RequestDetail\/20260715041/);
  assert.doesNotMatch(html, /legal conclusion|relationship|the city requires/i);
  assert.equal(renderAskCitedQuotesHtml({ schema: ASK_CITED_QUOTES_SCHEMA, quotes: [] }), "");
});

test("the projector stays a quote card and does not synthesize answers", () => {
  assert.match(SOURCE, /quote matched citations/i);
  assert.match(SOURCE, /Unknown-join/);
  assert.doesNotMatch(SOURCE, /inferred edge|the city requires/i);
});
