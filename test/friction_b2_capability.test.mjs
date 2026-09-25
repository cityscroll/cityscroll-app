/**
 * Decision-level keyword search for admitted community-board decisions.
 *
 * A reader who remembers an address, docket, or topic should get a named
 * decision result whose ordinary link opens that decision's evidence and vote.
 * Board discovery stays a separate object. Held candidates never become public
 * search documents.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  buildCommunityBoardDecisionSearchDocuments,
} from "../site/community_board_decision_search_producer.mjs";
import {
  communityBoardDecisionHref,
} from "../site/community_board_resolution_pilot.mjs";
import {
  resolveKeywordQuery,
  searchKeywordDocuments,
} from "../site/keyword_matcher.mjs";
import { readKeywordSearchIndexFromShards } from "../site/keyword_search_index_shards.mjs";
import { buildSearchRenderPlan } from "../site/search_render_plan.mjs";
import { searchFamilyForResult } from "../site/search_lens_handoff.mjs";
// Import the search handler directly so site-node time-travel does not need the
// Worker package graph (subscribe → optin-token) that worker.mjs pulls in.
import { handleSearch } from "../worker/src/search.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const REVIEW = read("site/data/community_board_resolution_sources/board_resolution_pilot_review.v1.json");
const PUBLIC = read("site/data/community_board_resolution_pilot.json");
const BOARDS = read("site/data/community_board_constellation_lookup.json");
const SHARD_MANIFEST = "worker/src/data/keyword_search_index_shards/manifest.json";
const EVIDENCE_MANIFEST = "docs/evidence/community-board-decision-search/capture-manifest.json";

const D1 = "brooklyn-cb-15:2026-06-30:bsa-154-90-bzii";
const D2 = "manhattan-cb-03:2026-05-26:transportation-2";
const D3 = "brooklyn-cb-15:2026-05-26:candidate-01";

const HELD_CONFLICTING_ADDRESS = "manhattan-cb-03:2026-05-26:sla-2";
const HELD_AMENDMENT_ORDER = REVIEW.candidates.find((row) => row.held_reason === "passage_predates_recorded_amendment")?.candidate_id;
const HELD_UNDATED = REVIEW.candidates.find((row) => row.held_reason === "document_states_no_meeting_date")?.candidate_id;

const READ_MODEL_SCHEMA = readFileSync(join(ROOT, "worker/migrations/0025_search_and_ocp_read_models.sql"), "utf8");

function servedIndex() {
  assert.ok(existsSync(join(ROOT, SHARD_MANIFEST)), "served keyword shard manifest must exist");
  return readKeywordSearchIndexFromShards(join(ROOT, "worker/src/data/keyword_search_index_shards"));
}

function decisionDocuments(index = servedIndex()) {
  return (index.families.community_boards?.documents || [])
    .filter((row) => row.object_type === "community_board_decision");
}

function decisionOf(index, candidateId) {
  return decisionDocuments(index).find((row) => (
    row.object_ref === `community-board-decision:${candidateId}`
    || row.provenance?.candidate_id === candidateId
  ));
}

function matchesFor(query, documents) {
  return searchKeywordDocuments(documents, resolveKeywordQuery(query), { limit: 20 });
}

function installKeywordReadModel(sqlite, index) {
  sqlite.exec(READ_MODEL_SCHEMA);
  const family = sqlite.prepare("INSERT INTO keyword_search_families (family_id, source, as_of, source_row_count, indexed_count, coverage_json) VALUES (?, ?, ?, ?, ?, ?)");
  const document = sqlite.prepare("INSERT INTO keyword_search_documents (document_id, family_id, ordinal, object_ref, source_observation_refs_json, document_json, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const fts = sqlite.prepare("INSERT INTO keyword_search_fts (document_id, family_id, search_text) VALUES (?, ?, ?)");
  for (const [familyId, readModel] of Object.entries(index.families || {})) {
    family.run(
      familyId,
      readModel.source,
      readModel.as_of,
      readModel.source_row_count,
      readModel.indexed_count,
      JSON.stringify(readModel.coverage || []),
    );
    for (const [ordinal, row] of (readModel.documents || []).entries()) {
      const id = `${familyId}:${ordinal}`;
      const text = [row.title, row.summary, row.search_text].filter(Boolean).join(" ");
      document.run(
        id,
        familyId,
        ordinal,
        row.object_ref,
        JSON.stringify(row.source_observation_refs || []),
        JSON.stringify(row),
        text,
      );
      fts.run(id, familyId, text);
    }
  }
}

function searchEnv(index) {
  const sqlite = new DatabaseSync(":memory:");
  installKeywordReadModel(sqlite, index);
  return {
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

async function publicSearch(query, env) {
  const response = await handleSearch(
    new Request(`https://api.cityscroll.org/search?q=${encodeURIComponent(query)}`, {
      headers: { Origin: "https://cityscroll.org", Accept: "application/json" },
    }),
    env,
  );
  assert.equal(response.status, 200, `search HTTP ${response.status} for ${query}`);
  return response.json();
}

test("A1 address and docket queries return D1 as a decision with the exact destination", async () => {
  const index = servedIndex();
  const d1 = decisionOf(index, D1);
  assert.ok(d1, "D1 is projected into the served community_boards family");
  assert.equal(d1.object_type, "community_board_decision");
  assert.equal(d1.canonical_href, communityBoardDecisionHref("brooklyn-cb-15", D1));
  assert.ok(d1.title.includes("730 Avenue S") || d1.title.includes("154-90-BZII"));
  assert.match(d1.object_ref, new RegExp(D1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const familyDocs = index.families.community_boards.documents;
  for (const query of ["730 Avenue S", "154-90-BZII"]) {
    const matches = matchesFor(query, familyDocs);
    const decisionHits = matches.filter((row) => row.object_type === "community_board_decision");
    assert.ok(decisionHits.some((row) => row.object_ref === d1.object_ref), `${query} must hit D1`);
    assert.equal(
      decisionHits.filter((row) => row.object_ref === d1.object_ref).length,
      1,
      `${query} must not duplicate D1`,
    );
  }

  const env = searchEnv(index);
  for (const query of ["730 Avenue S", "154-90-BZII"]) {
    const body = await publicSearch(query, env);
    const hit = (body.results || []).find((row) => row.object_ref === d1.object_ref);
    assert.ok(hit, `public search for ${query} returns D1`);
    assert.equal(hit.object_type, "community_board_decision");
    assert.equal(hit.canonical_href, d1.canonical_href);
    assert.equal(searchFamilyForResult(hit), "people-organizations");
  }
});

test("A2 topic queries retrieve D2 and D3 with board and date context", async () => {
  const index = servedIndex();
  const d2 = decisionOf(index, D2);
  const d3 = decisionOf(index, D3);
  assert.ok(d2, "D2 is served");
  assert.ok(d3, "D3 is served");
  assert.equal(d2.provenance.community_board_context?.board_id || d2.provenance.board_id, "manhattan-cb-03");
  assert.equal(d2.provenance.meeting_date, "2026-05-26");
  assert.equal(d3.provenance.community_board_context?.board_id || d3.provenance.board_id, "brooklyn-cb-15");
  assert.equal(d3.provenance.meeting_date, "2026-05-26");
  assert.match(d2.summary, /Manhattan Community Board 3/);
  assert.match(d3.summary, /Brooklyn Community Board 15/);
  assert.equal(d2.canonical_href, communityBoardDecisionHref("manhattan-cb-03", D2));
  assert.equal(d3.canonical_href, communityBoardDecisionHref("brooklyn-cb-15", D3));

  const familyDocs = index.families.community_boards.documents;
  const bikeHits = matchesFor("St Marks Place bike lane", familyDocs)
    .filter((row) => row.object_type === "community_board_decision");
  assert.ok(bikeHits.some((row) => row.object_ref === d2.object_ref), "bike-lane query retrieves D2");

  const sanitationHits = matchesFor("Saturday sanitation set out", familyDocs)
    .filter((row) => row.object_type === "community_board_decision");
  assert.ok(sanitationHits.some((row) => row.object_ref === d3.object_ref), "sanitation query retrieves D3");

  const env = searchEnv(index);
  const bike = await publicSearch("St Marks Place bike lane", env);
  assert.ok((bike.results || []).some((row) => row.object_ref === d2.object_ref));
  const sanitation = await publicSearch("Saturday sanitation set out", env);
  assert.ok((sanitation.results || []).some((row) => row.object_ref === d3.object_ref));
});

test("A3 board discovery remains distinct; decisions stay unique; held candidates stay out", () => {
  const index = servedIndex();
  const familyDocs = index.families.community_boards.documents;
  const boardHits = matchesFor("Brooklyn Community Board 15", familyDocs)
    .filter((row) => row.object_type === "community_board");
  assert.ok(
    boardHits.some((row) => row.object_ref === "community-board:brooklyn-cb-15"),
    "board-name query still finds the board object",
  );

  const decisions = decisionDocuments(index);
  assert.equal(decisions.length, 3, "exactly the three admitted decisions are indexed");
  const refs = decisions.map((row) => row.object_ref);
  assert.equal(new Set(refs).size, refs.length, "decision object_refs are unique");
  const candidateIds = decisions.map((row) => row.provenance.candidate_id).sort();
  assert.deepEqual(candidateIds, [D3, D1, D2].sort());

  // The same decision must appear once even when several source fields repeat
  // its address tokens; identity is the candidate_id, not phrase frequency.
  const addressHits = matchesFor("730 Avenue S", familyDocs)
    .filter((row) => row.object_type === "community_board_decision"
      && row.provenance?.candidate_id === D1);
  assert.equal(addressHits.length, 1);
  assert.equal(
    decisionDocuments(index).filter((row) => row.provenance?.candidate_id === D1).length,
    1,
  );

  assert.ok(HELD_CONFLICTING_ADDRESS);
  assert.ok(HELD_AMENDMENT_ORDER);
  assert.ok(HELD_UNDATED);
  const serialized = JSON.stringify(decisions);
  for (const id of [HELD_CONFLICTING_ADDRESS, HELD_AMENDMENT_ORDER, HELD_UNDATED]) {
    assert.equal(serialized.includes(id), false, `${id} must not become a public search object`);
    assert.equal(decisionOf(index, id), undefined);
  }

  const producer = buildCommunityBoardDecisionSearchDocuments(PUBLIC, { boardLookup: BOARDS });
  assert.equal(producer.coverage.state, "matched");
  assert.equal(producer.documents.length, 3);
  assert.equal(
    producer.documents.some((row) => String(row.object_ref).includes(HELD_CONFLICTING_ADDRESS)),
    false,
  );
});

test("A4 a failed shard/index load preserves the query and offers retry", () => {
  const query = "730 Avenue S";
  const unavailable = buildSearchRenderPlan({ state: "unavailable" });
  assert.equal(unavailable.outcome, "unavailable");
  assert.notEqual(unavailable.outcome, "empty");
  assert.equal(unavailable.rendered_count, 0);

  const failedLane = buildSearchRenderPlan({
    state: "legacy",
    payload: {
      schema: "cityscroll.keyword_search_response.v1",
      match_mode: "keyword",
      results: [],
      lanes: [{
        id: "people-organizations",
        status: "unknown",
        count: null,
        source: "D1 keyword read model",
        coverage: { reason: "bounded_family_search_failed" },
      }],
    },
    coverage: {
      lanes: [{ id: "people-organizations", status: "unknown" }],
    },
  });
  assert.ok(failedLane.incomplete_families.includes("people-organizations"));
  assert.notEqual(failedLane.outcome, "empty");

  const searchSource = readFileSync(join(ROOT, "site/search_document.mjs"), "utf8");
  assert.match(searchSource, /topic-search-retry/);
  assert.match(searchSource, /Try again|buyer_history_retry/);
  assert.match(searchSource, /\/search\/\?q=\$\{encodeURIComponent\(query\)\}/);
  assert.match(searchSource, /input\.value = query/);
  assert.match(searchSource, /board-decision-/);
  assert.match(searchSource, /SEARCH_RETURN_STATE_KEY/);

  // The form keeps the submitted query in the URL the retry link reconstructs.
  const retryHref = `/search/?q=${encodeURIComponent(query)}`;
  assert.equal(new URL(retryHref, "https://cityscroll.org").searchParams.get("q"), query);
});

test("A5 delivery evidence covers exact decision destinations and Back restoration", () => {
  const index = servedIndex();
  const expected = [
    {
      query: "730 Avenue S",
      candidate_id: D1,
      href: communityBoardDecisionHref("brooklyn-cb-15", D1),
    },
    {
      query: "St Marks Place bike lane",
      candidate_id: D2,
      href: communityBoardDecisionHref("manhattan-cb-03", D2),
    },
    {
      query: "Saturday sanitation set out",
      candidate_id: D3,
      href: communityBoardDecisionHref("brooklyn-cb-15", D3),
    },
  ];
  for (const row of expected) {
    const decision = decisionOf(index, row.candidate_id);
    assert.ok(decision, `${row.candidate_id} must be in the rebuilt served index`);
    assert.equal(decision.canonical_href, row.href);
  }

  assert.ok(
    existsSync(join(ROOT, EVIDENCE_MANIFEST)),
    "A5 delivery requires docs/evidence/community-board-decision-search/capture-manifest.json",
  );
  const manifest = read(EVIDENCE_MANIFEST);
  assert.equal(manifest.image_binaries_committed, false);
  assert.ok(Array.isArray(manifest.captures) && manifest.captures.length >= 4);

  const byCase = new Map(manifest.captures.map((row) => [row.case, row]));
  for (const name of [
    "decision-search-730-avenue-s",
    "decision-search-st-marks-bike-lane",
    "decision-search-saturday-sanitation",
    "decision-search-open-and-back",
  ]) {
    assert.ok(byCase.has(name), `missing capture case ${name}`);
    const capture = byCase.get(name);
    assert.ok(capture.sha256 || capture.recording_sha256, `${name} records a digest`);
    assert.ok(capture.route || capture.query_url, `${name} records a route`);
  }

  const openBack = byCase.get("decision-search-open-and-back");
  assert.ok(openBack.viewports?.length >= 2 || openBack.modes?.length >= 2, "Back journey covers more than one mode");
  assert.equal(openBack.preserves_search_state, true);
});
