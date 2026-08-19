import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

import {
  projectAgencySearchDocument,
  buildAgencySearchDocuments,
} from "../site/agency_search_producer.mjs";
import { projectBoardSearchDocument } from "../site/board_search_producer.mjs";
import {
  communityBoardBodyId,
  communityBoardDisambiguation,
  parseCommunityBoardQuery,
} from "../site/community_board_search.mjs";
import { searchContractAwardDocuments } from "../site/contract_award_search_producer.mjs";
import {
  resolveKeywordQuery,
  matchKeywordDocument,
  searchKeywordDocuments,
} from "../site/keyword_matcher.mjs";
import {
  meetingCanonicalHref,
  normalizeCityRecordMeeting,
  normalizeCommunityBoardMeeting,
} from "../site/meeting_object_contract.mjs";
import { materializeMeetingSearchDocument } from "../site/meeting_search_producer.mjs";
import {
  materializePeopleSearchDocument,
  rankPeopleSearchDocuments,
} from "../site/people_search_producer.mjs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import {
  UNIVERSAL_SEARCH_LENS_IDS,
  federateUniversalSearch,
} from "../site/universal_search_federator.mjs";
import {
  buildUniversalSearchCoverageView,
  renderUniversalSearchCoverageHtml,
} from "../site/universal_search_coverage_receipt.mjs";
import { interpretEntityPhrase } from "../site/canonical_entity_interpretation.mjs";
import { projectAskCitedQuotes } from "../site/ask_cited_synthesis.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";
import { retrieveCitedPassages } from "../worker/src/cited_retrieval.mjs";
import {
  mergeUniversalSearchResults,
  publicSearchResult,
} from "../worker/src/search.mjs";

const require = createRequire(import.meta.url);
const { parseNL } = require("../site/nl_parse.js");

const GOLD = JSON.parse(readFileSync(
  new URL("./fixtures/universal_search_object_gold.json", import.meta.url),
  "utf8",
));
const AGENCIES = JSON.parse(readFileSync(
  new URL("../site/data/agency_constellation_lookup.json", import.meta.url),
  "utf8",
));
const AGENCY_IDENTITIES = JSON.parse(readFileSync(
  new URL("../site/data/agency_route_identity_report.json", import.meta.url),
  "utf8",
));
const OCP_AWARDS = JSON.parse(readFileSync(
  new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url),
  "utf8",
));

const GOLDEN_AXES = Object.freeze([
  "interpretation",
  "recall",
  "ranking",
  "type_domain",
  "canonical_route",
  "dedup",
  "coverage_honesty",
]);
const REQUIRED_CATEGORIES = Object.freeze([
  "exact_known_title",
  "canonical_entity_alias",
  "typo",
  "synonym",
  "attachment_only",
  "cross_source",
  "cross_lens",
  "ambiguous",
  "zero_result",
  "partial_coverage",
  "unindexed",
  "ranking_competition",
  "nl_ask",
  "cited_synthesis",
]);
const LA7_SEARCH_CANARY_PATHS = Object.freeze([
  "worker/src/search.mjs",
  "tools/build_keyword_search_index.mjs",
  "site/agency_search_producer.mjs",
]);
const SNAPSHOT_AS_OF = "2026-08-15T12:00:00Z";
const EDUCATION_FIXTURE_REF = "procurement:education-synonym-fixture";
const DECOY_VENDOR_REF = "procurement:decoy-vendor-mosquito";

function goldCase(id) {
  const row = GOLD.cases.find((candidate) => candidate.id === id);
  assert.ok(row, `missing gold case: ${id}`);
  return row;
}

function mosquitoDocument() {
  return publicSearchResult(goldCase("mosquito-procurement").source_observation);
}

function personDocument() {
  return materializePeopleSearchDocument(goldCase("canonical-person").source_observation, {
    sourceContract: "uvw5-9znb",
    retrievedAt: "2026-08-11T19:21:19.284Z",
    sourcePromoted: true,
  });
}

function parksAgencyDocument() {
  const row = goldCase("parks-agency");
  const result = projectAgencySearchDocument(
    row.source_observation.agency_id,
    row.source_observation,
    {
      lookup: {
        schema: "cityscroll.agency_constellation.v1",
        method: "agency_constellation_v1",
        er_match_basis: "agency_canonical_v1",
        generated_at: "2026-08-15T12:00:00Z",
        aliases: {},
        provenance: { intelligence_generated_at: "2026-08-15T10:00:00Z" },
      },
    },
  );
  assert.equal(result.outcome, "indexed");
  return { ...result.document, outcome: "indexed", coverage_state: "matched" };
}

function educationFixtureDocument() {
  const gold = mosquitoDocument();
  return {
    ...gold,
    object_ref: EDUCATION_FIXTURE_REF,
    title: "Education Department professional development",
    summary: "Education services award",
    search_text: "Education Department professional development Education services award",
    canonical_href: "/browse/contracts/?mode=award&q=education-synonym-fixture",
    source_observation_refs: ["notice:education-synonym-fixture"],
  };
}

function decoyVendorMosquitoDocument() {
  const gold = mosquitoDocument();
  return {
    ...gold,
    object_ref: DECOY_VENDOR_REF,
    title: "Catch basin maintenance",
    summary: "Vendor mosquito supplies",
    search_text: "Catch basin maintenance Vendor mosquito supplies",
    canonical_href: "/browse/contracts/?mode=award&q=decoy-vendor-mosquito",
    source_observation_refs: ["notice:decoy-vendor-mosquito"],
  };
}

function idaTitleDocument() {
  const gold = mosquitoDocument();
  return {
    ...gold,
    object_ref: "procurement:ida-hearing-fixture",
    title: "IDA public hearing",
    summary: "Industrial Development Agency public hearing",
    search_text: "IDA public hearing Industrial Development Agency public hearing",
    canonical_href: "/browse/contracts/?mode=award&q=ida-hearing-fixture",
    source_observation_refs: ["notice:ida-hearing-fixture"],
  };
}

function meetingDocuments() {
  const city = goldCase("city-record-meeting");
  const board = goldCase("community-board-meeting");
  const cityMeeting = normalizeCityRecordMeeting(city.source_observation);
  const boardMeeting = normalizeCommunityBoardMeeting(board.source_observation);
  return {
    city: materializeMeetingSearchDocument(cityMeeting),
    board: materializeMeetingSearchDocument(boardMeeting),
    readModel: buildSharedMeetingReadModel({
      cityRecordRows: [city.source_observation, { ...city.source_observation }],
      communityBoardIndex: {
        schema: "fixture",
        generated_at: "2026-08-14T12:00:00Z",
        rows: [board.source_observation, { ...board.source_observation }],
      },
      generatedAt: "2026-08-14T12:00:00Z",
      now: "2026-08-14T12:00:00Z",
    }),
  };
}

function boardDocumentsForNumber(number) {
  const gold = goldCase("community-board-entity");
  return communityBoardDisambiguation({ number, borough: null, ambiguous: true }).map((candidate) => {
    const result = projectBoardSearchDocument(candidate.bodyId, {
      ...gold.source_observation.row,
      body_id: candidate.bodyId,
      display_name: candidate.label,
      path: `/community-boards/${candidate.bodyId}/`,
    }, { lookup: gold.source_observation.lookup });
    assert.ok(result.document, candidate.bodyId);
    return { ...result.document, outcome: "indexed", coverage_state: "matched" };
  });
}

function matchFieldFor(document, query) {
  const resolved = resolveKeywordQuery(query);
  return matchKeywordDocument(document, resolved)?.field || "title";
}

function fixtureCandidate(document, query, localScore = 1) {
  return {
    document,
    local_score: localScore,
    match_fields: [{
      field: matchFieldFor(document, query),
      matched_term: query,
      source_observation_ref: document.source_observation_refs[0],
    }],
  };
}

function completeLens(candidates = [], overrides = {}) {
  return {
    async search() {
      return {
        candidates,
        coverage: {
          state: candidates.length ? "matched" : "empty",
          indexed_count: candidates.length,
          as_of: SNAPSHOT_AS_OF,
          source: "committed fixture read model",
          method: "fixture_exact_v1",
          ...overrides,
        },
      };
    },
  };
}

function keywordHits(documents, text, limit = 40) {
  return searchKeywordDocuments(documents, resolveKeywordQuery(text), { limit });
}

function objectIndex(documents) {
  return new Map((documents || []).map((document) => [document.object_ref, document]));
}

async function runCorpus(query) {
  const text = query.input.text;
  const resolved = resolveKeywordQuery(text);
  switch (query.corpus) {
    case "keyword_gold_mosquito": {
      const documents = [mosquitoDocument()];
      return { resolved, documents, hits: keywordHits(documents, text) };
    }
    case "people_hub": {
      const document = personDocument();
      return {
        resolved,
        documents: [document],
        hits: rankPeopleSearchDocuments([document], text),
        keywordHits: keywordHits([document], text),
      };
    }
    case "agency_constellation": {
      const goldDocument = parksAgencyDocument();
      const live = buildAgencySearchDocuments(AGENCIES, { identityReport: AGENCY_IDENTITIES });
      const documents = [goldDocument, ...live.documents];
      return { resolved, documents, hits: keywordHits(documents, text) };
    }
    case "education_only_fixture": {
      const documents = [educationFixtureDocument()];
      return { resolved, documents, hits: keywordHits(documents, text) };
    }
    case "attachment_enrichment": {
      const row = goldCase("attachment-enrichment");
      const baseline = publicSearchResult(row.source_observation);
      const enriched = {
        ...baseline,
        search_text: `${baseline.search_text} ${row.attachment_text}`,
      };
      return {
        resolved,
        documents: [enriched],
        baseline,
        enriched,
        baselineHits: keywordHits([baseline], text),
        hits: keywordHits([enriched], text),
      };
    }
    case "meeting_gold_pair": {
      const meetings = meetingDocuments();
      const documents = [meetings.city, meetings.board];
      return {
        resolved,
        documents,
        hits: keywordHits(documents, text),
        readModel: meetings.readModel,
      };
    }
    case "parks_agency_and_awards": {
      const agency = parksAgencyDocument();
      const awards = searchContractAwardDocuments(OCP_AWARDS, text, { limit: 8 }).documents;
      const response = await federateUniversalSearch({
        query: text,
        lenses: {
          agencies: completeLens([fixtureCandidate(agency, text, 1)]),
          notices: completeLens(awards.map((document, index) => fixtureCandidate(document, text, index + 1))),
        },
      });
      return {
        resolved,
        documents: [agency, ...awards],
        hits: response.results,
        federated: response,
      };
    }
    case "community_board_disambiguation": {
      const parsed = parseCommunityBoardQuery(text);
      const documents = boardDocumentsForNumber(parsed.number);
      return {
        resolved,
        parsed,
        documents,
        hits: documents,
        disambiguation: communityBoardDisambiguation(parsed),
      };
    }
    case "ida_title_document": {
      const documents = [idaTitleDocument()];
      return {
        resolved,
        documents,
        hits: keywordHits(documents, text),
        tidal: resolveKeywordQuery("tidal"),
        tidalMatch: matchKeywordDocument(documents[0], resolveKeywordQuery("tidal")),
      };
    }
    case "federator_all_empty": {
      const lenses = Object.fromEntries(UNIVERSAL_SEARCH_LENS_IDS.map((lensId) => (
        [lensId, completeLens()]
      )));
      const federated = await federateUniversalSearch({ query: text, lenses });
      return { resolved, documents: [], hits: [], federated };
    }
    case "federator_all_unindexed": {
      const federated = await federateUniversalSearch({ query: text, lenses: {} });
      return { resolved, documents: [], hits: [], federated };
    }
    case "federator_missing_people_stale_vendors": {
      const lenses = Object.fromEntries(UNIVERSAL_SEARCH_LENS_IDS.map((lensId) => (
        [lensId, completeLens()]
      )));
      delete lenses.people;
      lenses.vendors = completeLens([], {
        state: "stale",
        reason: "snapshot_expired",
        as_of: "2026-07-01T00:00:00Z",
      });
      const federated = await federateUniversalSearch({ query: text, lenses });
      return { resolved, documents: [], hits: [], federated };
    }
    case "gold_coverage_rows":
      return { resolved, documents: [], hits: [], coverageRows: GOLD.coverage };
    case "mosquito_ranking": {
      const gold = mosquitoDocument();
      const decoy = decoyVendorMosquitoDocument();
      const awards = searchContractAwardDocuments(OCP_AWARDS, text, { limit: 20 }).documents;
      const merged = mergeUniversalSearchResults([gold], awards);
      const federated = await federateUniversalSearch({
        query: text,
        lenses: {
          notices: completeLens([
            fixtureCandidate(gold, text, 1),
            fixtureCandidate(decoy, text, 1),
            ...awards.slice(0, 3).map((document, index) => fixtureCandidate(document, text, index + 2)),
          ]),
        },
      });
      return {
        resolved,
        documents: [gold, decoy, ...awards],
        hits: merged,
        federated,
        merged,
      };
    }
    case "cited_offline": {
      const cited = retrieveCitedPassages({ query: text });
      const citedQuotes = projectAskCitedQuotes(cited);
      return {
        resolved,
        documents: [],
        hits: [],
        cited,
        citedQuotes,
        quotedCitations: citedQuotes.quotes,
      };
    }
    case "nl_offline": {
      const parsed = parseNL(text);
      const clamped = sanitize("money", parsed);
      const mockedModel = sanitize("money", {
        keywords: ["construction"],
        minAmount: 500000,
        months: 3,
        excludeSpecial: true,
      });
      return {
        resolved,
        documents: [],
        hits: [],
        parsed,
        clamped,
        mockedModel,
      };
    }
    case "canonical_entity": {
      return {
        resolved,
        documents: [],
        hits: [],
        interpreted: interpretEntityPhrase(text),
      };
    }
    default:
      throw new Error(`unknown golden-query corpus: ${query.corpus}`);
  }
}

function byRef(world, ref) {
  return objectIndex(world.hits).get(ref)
    || objectIndex(world.documents).get(ref)
    || null;
}

function assertInterpretation(query, world) {
  const expected = query.expect.interpretation;
  if (expected.via === "canonical_entity") {
    const hit = world.interpreted;
    assert.ok(hit, `${query.id} missing interpretation`);
    if (expected.unresolved) {
      assert.equal(hit.status, "unresolved", `${query.id} should stay text`);
      assert.equal(hit.subject_ref, null, `${query.id} minted a subject_ref`);
      assert.equal(hit.canonical_id, null, `${query.id} minted a canonical_id`);
      assert.equal(hit.text, expected.text_remains, `${query.id} text`);
      return;
    }
    assert.equal(hit.status, "resolved", `${query.id} status`);
    assert.equal(hit.kind, expected.kind, `${query.id} kind`);
    assert.equal(hit.canonical_name, expected.canonical_name, `${query.id} canonical_name`);
    assert.equal(hit.canonical_id, expected.canonical_id, `${query.id} canonical_id`);
    assert.equal(hit.subject_ref, expected.subject_ref, `${query.id} subject_ref`);
    assert.match(hit.method, /^reviewed_agency_/, `${query.id} method ${hit.method}`);
    return;
  }
  if (expected.via === "parse_nl") {
    assert.equal(world.parsed.minAmount, expected.minAmount, `${query.id} minAmount`);
    assert.equal(world.parsed.months, expected.months, `${query.id} months`);
    assert.equal(world.parsed.excludeSpecial, expected.excludeSpecial, `${query.id} excludeSpecial`);
    for (const keyword of expected.keywords_include) {
      assert.ok(world.parsed.keywords.includes(keyword), `${query.id} keyword ${keyword}`);
    }
    assert.equal(world.clamped.minAmount, expected.minAmount, `${query.id} sanitized minAmount`);
    assert.equal(world.mockedModel.minAmount, expected.minAmount, `${query.id} mocked sanitize minAmount`);
    assert.equal(world.mockedModel.months, expected.months, `${query.id} mocked sanitize months`);
    return;
  }
  if (expected.via === "community_board") {
    assert.equal(world.parsed.number, expected.number, `${query.id} board number`);
    assert.equal(world.parsed.borough, expected.borough, `${query.id} borough`);
    assert.equal(world.parsed.ambiguous, expected.ambiguous, `${query.id} ambiguous`);
    return;
  }
  assert.deepEqual(world.resolved.canonical_tokens, expected.canonical_tokens, `${query.id} tokens`);
  if (expected.retrieval_groups) {
    assert.deepEqual(world.resolved.retrieval_groups, expected.retrieval_groups, `${query.id} retrieval groups`);
  }
  if (expected.structured_filters) {
    assert.deepEqual(world.resolved.structured_filters, expected.structured_filters, `${query.id} filters`);
  }
  if (Object.hasOwn(expected, "expansion")) {
    assert.equal(world.resolved.alias, expected.expansion, `${query.id} no expansion`);
  }
  if (expected.expansion_tokens) {
    assert.deepEqual(world.resolved.expansion_tokens, expected.expansion_tokens, `${query.id} expansion tokens`);
  }
  if (expected.expansion_receipt) {
    assert.equal(world.resolved.expansion?.receipt, expected.expansion_receipt, `${query.id} expansion receipt`);
  }
  if (expected.does_not_expand_to) {
    for (const token of expected.does_not_expand_to) {
      assert.equal(world.resolved.canonical_tokens.includes(token), false, `${query.id} expanded to ${token}`);
      assert.equal(
        (world.resolved.expansion_tokens || []).includes(token),
        false,
        `${query.id} synonym-expanded to ${token}`,
      );
    }
  }
  if (expected.tidal_tokens) {
    assert.deepEqual(world.tidal.canonical_tokens, expected.tidal_tokens, `${query.id} tidal tokens`);
    assert.deepEqual(world.tidal.structured_filters, {});
  }
}

function assertRecall(query, world) {
  const expected = query.expect.recall;
  const hitRefs = (world.hits || []).map((document) => document.object_ref);
  if (expected.expected === "miss") {
    assert.equal(world.hits.length, 0, `${query.id} expected miss`);
  }
  for (const ref of expected.must_include || []) {
    assert.ok(hitRefs.includes(ref), `${query.id} missing ${ref}: ${hitRefs.join(",")}`);
  }
  for (const ref of expected.must_not_include || []) {
    assert.equal(hitRefs.includes(ref), false, `${query.id} unexpectedly recalled ${ref}`);
  }
  if (expected.baseline_must_not_include) {
    const baselineRefs = world.baselineHits.map((document) => document.object_ref);
    for (const ref of expected.baseline_must_not_include) {
      assert.equal(baselineRefs.includes(ref), false, `${query.id} baseline leaked ${ref}`);
    }
  }
  if (expected.enriched_must_include) {
    for (const ref of expected.enriched_must_include) {
      assert.ok(hitRefs.includes(ref), `${query.id} attachment miss ${ref}`);
    }
  }
  if (expected.must_include_types) {
    const types = new Set((world.hits || []).map((document) => document.object_type));
    for (const type of expected.must_include_types) {
      assert.ok(types.has(type), `${query.id} missing type ${type}`);
    }
  }
  if (expected.min_distinct) {
    assert.ok(new Set(hitRefs).size >= expected.min_distinct, `${query.id} distinct hits`);
  }
  if (expected.must_include_citations || expected.must_not_invent_citations || expected.quotes_only) {
    const quotes = world.quotedCitations || [];
    const citationIds = quotes.map((quote) => quote.citation_id);
    for (const citationId of expected.must_include_citations || []) {
      assert.ok(citationIds.includes(citationId), `${query.id} missing citation ${citationId}`);
    }
    if (expected.join_state) {
      assert.ok(
        quotes.every((quote) => quote.exact_join_evidence.state === expected.join_state),
        `${query.id} unquoted or unmatched join`,
      );
    }
    if (expected.source_url) {
      assert.ok(
        quotes.some((quote) => quote.source.url === expected.source_url),
        `${query.id} missing official source URL`,
      );
    }
    if (expected.must_not_invent_citations) {
      assert.equal(quotes.length, (expected.must_include_citations || []).length, `${query.id} invented citations`);
    }
    if (expected.quotes_only) {
      assert.doesNotMatch(
        JSON.stringify(world.citedQuotes),
        /(?:answer|synthesis|action|legal_conclusion|graph_edge|relationship)/i,
        `${query.id} leaked synthesis`,
      );
    }
  }
}

function assertRanking(query, world) {
  const expected = query.expect.ranking;
  if (expected.lenses_remain_independent) {
    for (const lens of expected.lenses_remain_independent) {
      assert.ok(world.federated.coverage.by_lens[lens], `${query.id} missing lens ${lens}`);
      assert.ok(world.federated.coverage.by_lens[lens].matched_count > 0, `${query.id} empty lens ${lens}`);
    }
  }
  if (expected.candidate_count) {
    assert.equal(world.disambiguation.length, expected.candidate_count, `${query.id} candidate count`);
    assert.equal(world.hits.length, expected.candidate_count, `${query.id} projected boards`);
  }
  if (expected.does_not_hide_alternates) {
    const ids = world.disambiguation.map((row) => row.bodyId).sort();
    assert.deepEqual(ids, [
      "bronx-cb-03",
      "brooklyn-cb-03",
      "manhattan-cb-03",
      "queens-cb-03",
      "staten-island-cb-03",
    ].sort());
    assert.equal(communityBoardBodyId(3, "Brooklyn"), "brooklyn-cb-03");
  }
  if (expected.tidal_does_not_match_ida_title) {
    assert.equal(world.tidalMatch, null, `${query.id} tidal hit IDA title`);
  }
  if (expected.preferred_first) {
    assert.equal(world.merged[0].object_ref, expected.preferred_first, `${query.id} merge order`);
  }
  if (expected.title_outranks) {
    const ranked = world.federated.results.map((row) => row.object_ref);
    const winner = ranked.indexOf(expected.preferred_first);
    const loser = ranked.indexOf(expected.title_outranks);
    assert.ok(winner >= 0, `${query.id} title winner missing`);
    assert.ok(loser >= 0, `${query.id} search_text decoy missing`);
    assert.ok(winner < loser, `${query.id} title should outrank search_text`);
  }
}

function assertTypeDomain(query, world) {
  const expected = query.expect.type_domain;
  if (expected.structured_agency_filter) {
    assert.equal(world.resolved.structured_filters.agency_id, expected.structured_agency_filter);
    return;
  }
  if (expected.by_object_ref) {
    for (const [ref, contract] of Object.entries(expected.by_object_ref)) {
      const document = byRef(world, ref);
      assert.ok(document, `${query.id} missing ${ref} for type/domain`);
      assert.equal(document.object_type, contract.object_type, `${query.id} type ${ref}`);
      assert.equal(document.domain, contract.domain, `${query.id} domain ${ref}`);
    }
  }
  if (expected.procurement_domain) {
    const procurements = (world.hits || []).filter((document) => document.object_type === "procurement");
    assert.ok(procurements.length > 0, `${query.id} no procurement hits`);
    assert.ok(procurements.every((document) => document.domain === expected.procurement_domain));
  }
  if (!expected.object_type) return;
  const refs = query.expect.recall?.must_include
    || query.expect.recall?.enriched_must_include
    || (world.hits || []).map((document) => document.object_ref);
  assert.ok(refs.length > 0, `${query.id} no objects for type/domain`);
  for (const ref of refs) {
    const document = byRef(world, ref);
    assert.ok(document, `${query.id} missing ${ref}`);
    assert.equal(document.object_type, expected.object_type, `${query.id} type`);
    assert.equal(document.domain, expected.domain, `${query.id} domain`);
  }
}

function assertCanonicalRoute(query, world) {
  const expected = query.expect.canonical_route;
  if (typeof expected === "string") {
    const refs = query.expect.recall?.must_include
      || query.expect.recall?.enriched_must_include
      || [];
    assert.ok(refs.length > 0, `${query.id} route without target`);
    for (const ref of refs) {
      const document = byRef(world, ref);
      assert.ok(document, `${query.id} missing ${ref} for route`);
      assert.equal(document.canonical_href, expected, `${query.id} route`);
    }
    return;
  }
  for (const [ref, href] of Object.entries(expected)) {
    const document = byRef(world, ref);
    assert.ok(document, `${query.id} missing ${ref} for route`);
    assert.equal(document.canonical_href, href, `${query.id} route ${ref}`);
    if (ref.startsWith("meeting:")) {
      assert.equal(meetingCanonicalHref({ meeting_id: ref }), href);
    }
  }
}

function assertDedup(query, world) {
  const expected = query.expect.dedup;
  const refs = (world.hits || []).map((document) => document.object_ref);
  if (expected.keep_distinct) {
    for (const ref of expected.keep_distinct) {
      assert.ok(refs.includes(ref), `${query.id} dedup dropped ${ref}`);
    }
    assert.equal(new Set(expected.keep_distinct).size, expected.keep_distinct.length);
  }
  if (expected.same_title_date_does_not_collapse) {
    const titles = new Set(world.readModel.rows.map((row) => `${row.title}|${row.event_date}`));
    assert.equal(titles.size, 1);
    assert.deepEqual(world.readModel.rows.map((row) => row.meeting_id).sort(), [
      "meeting:city_record:20260814001",
      "meeting:community_board:event-abc-123",
    ]);
  }
  if (expected.agency_and_contracts_stay_distinct) {
    const types = new Set((world.hits || []).map((document) => `${document.object_type}:${document.object_ref}`));
    assert.ok([...types].some((key) => key.startsWith("agency:")));
    assert.ok([...types].some((key) => key.startsWith("procurement:")));
  }
  if (expected.keep_distinct_min) {
    assert.ok(new Set(refs).size >= expected.keep_distinct_min, `${query.id} collapsed competitors`);
  }
}

function assertCoverageHonesty(query, world) {
  const expected = query.expect.coverage_honesty;
  if (expected.producer) {
    const row = (world.coverageRows || GOLD.coverage).find((entry) => entry.producer === expected.producer);
    assert.ok(row, `${query.id} missing producer ${expected.producer}`);
    assert.equal(row.state, expected.state);
    assert.equal(row.reason, expected.reason);
    assert.notEqual(row.reason, "No matches");
    if (expected.zero_means === "no_coverage") {
      assert.notEqual(row.state, "empty", `${query.id} unindexed producer must not look empty`);
    }
    return;
  }
  const coverage = world.federated.coverage;
  const view = buildUniversalSearchCoverageView(coverage);
  const html = renderUniversalSearchCoverageHtml(coverage);
  assert.equal(coverage.snapshot.state, expected.snapshot_state, `${query.id} snapshot`);
  assert.equal(coverage.complete_count, expected.complete_count, `${query.id} complete_count`);
  if (expected.empty_means === "no_match_in_participating_lenses") {
    assert.equal(world.federated.results.length, 0);
    assert.equal(view.complete_count, 0);
    assert.equal(expected.zero_means, "no_match", `${query.id} honest empty is no-match`);
    assert.equal(coverage.all_lenses_participated, true, `${query.id} every lens participated`);
    assert.equal(view.match_count, 0);
    assert.match(html, />0 matches</);
    for (const lensId of UNIVERSAL_SEARCH_LENS_IDS) {
      assert.equal(coverage.by_lens[lensId].state, "empty", `${query.id} ${lensId}`);
    }
  }
  if (expected.zero_means === "no_coverage") {
    assert.equal(coverage.complete_count, null, `${query.id} complete_count must stay null`);
    assert.notEqual(coverage.snapshot.state, "complete", `${query.id} must not look complete`);
    assert.equal(view.match_count, coverage.observed_count, `${query.id} uses the observed match count`);
    assert.doesNotMatch(html, /Search coverage is incomplete|0 matches across all|Coverage by collection/);
  }
  if (expected.must_not_read_as) {
    assert.doesNotMatch(html, /0 matches across all/);
  }
  if (expected.incomplete_lenses) {
    assert.deepEqual(coverage.incomplete_lenses, expected.incomplete_lenses);
    assert.equal(coverage.by_lens.people.state, "not_indexed");
    assert.equal(coverage.by_lens.vendors.state, "stale");
  }
  if (expected.all_lenses_not_indexed) {
    assert.equal(coverage.all_lenses_participated, false, `${query.id} no lens participated`);
    for (const lensId of UNIVERSAL_SEARCH_LENS_IDS) {
      assert.equal(coverage.by_lens[lensId].state, "not_indexed", `${query.id} ${lensId}`);
    }
  }
}

const AXIS = {
  interpretation: assertInterpretation,
  recall: assertRecall,
  ranking: assertRanking,
  type_domain: assertTypeDomain,
  canonical_route: assertCanonicalRoute,
  dedup: assertDedup,
  coverage_honesty: assertCoverageHonesty,
};

test("golden-query suite is additive metadata beside existing gold cases", () => {
  assert.equal(GOLD.schema, "cityscroll.universal_search_object_gold.v1");
  assert.equal(GOLD.query_suite.schema, "cityscroll.search_quality.golden_query.v1");
  assert.deepEqual(GOLD.query_suite.axes, GOLDEN_AXES);
  assert.deepEqual(GOLD.cases.map((row) => row.id), GOLD.quality_report.object_contract.case_ids);
  assert.ok(Array.isArray(GOLD.queries));
  assert.ok(GOLD.queries.length >= REQUIRED_CATEGORIES.length);
  for (const category of REQUIRED_CATEGORIES) {
    assert.ok(
      GOLD.queries.some((query) => query.category === category),
      `missing golden-query category: ${category}`,
    );
  }
});

test("each golden query names only the axes it can fail", () => {
  const seen = new Set();
  for (const query of GOLD.queries) {
    assert.ok(query.id && !seen.has(query.id), `duplicate or empty query id: ${query.id}`);
    seen.add(query.id);
    assert.ok(query.eval.length > 0, query.id);
    for (const axis of query.eval) {
      assert.ok(GOLDEN_AXES.includes(axis), `${query.id} unknown axis ${axis}`);
    }
    for (const key of Object.keys(query.expect)) {
      assert.ok(query.eval.includes(key), `${query.id} expect.${key} is not in eval`);
    }
    if (query.category === "nl_ask") {
      assert.deepEqual(query.eval, ["interpretation"]);
      assert.equal(query.input.channel, "nl");
    }
    if (query.category === "cited_synthesis") {
      assert.equal(query.input.channel, "nl");
      assert.equal(query.eval.includes("recall"), true);
      assert.equal(query.eval.includes("interpretation"), false);
    }
    if (query.category === "ranking_competition") {
      assert.equal(query.eval.includes("interpretation"), false);
    }
  }
});

test("coverage-honesty twin cites the same LA7 search canaries", () => {
  const twin = GOLD.query_suite.coverage_honesty_twin;
  const listed = JSON.parse(readFileSync(
    new URL("../architecture/observer-canaries.json", import.meta.url),
    "utf8",
  ));
  assert.ok(twin);
  assert.equal(twin.feeds, "LA7");
  assert.equal(twin.observer_canaries, "architecture/observer-canaries.json");
  assert.deepEqual(twin.canary_paths, [...LA7_SEARCH_CANARY_PATHS]);
  for (const [index, path] of twin.canary_paths.entries()) {
    const canary = listed.canaries.find((row) => row.id === twin.canary_ids[index]);
    assert.ok(canary, twin.canary_ids[index]);
    assert.equal(canary.path, path);
  }
  const byCategory = Object.fromEntries(
    ["zero_result", "partial_coverage", "unindexed"].map((category) => [
      category,
      GOLD.queries.filter((query) => query.category === category),
    ]),
  );
  assert.ok(byCategory.zero_result.some((query) => query.id === "gq-zero-result"));
  assert.ok(byCategory.partial_coverage.some((query) => query.id === "gq-partial-coverage"));
  assert.ok(byCategory.unindexed.some((query) => query.id === "gq-unindexed-coverage"));
  assert.ok(byCategory.unindexed.some((query) => query.id === "gq-law-mandates-not-indexed"));
});

test("golden-query suite stays offline and does not import the live Ask client", () => {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const forbidden = [
    ["api", "anthro" + "pic", "com"].join("."),
    ["worker", "src", "nl.mjs"].join("/"),
    ["worker", "e2e", "nl.mjs"].join("/"),
  ];
  for (const token of forbidden) {
    assert.equal(source.includes(token), false, token);
  }
});

for (const query of GOLD.queries) {
  test(`golden query ${query.id} (${query.category})`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      throw new Error(`${query.id} must stay offline; unexpected fetch: ${url}`);
    };
    try {
      const world = await runCorpus(query);
      for (const axis of query.eval) {
        AXIS[axis](query, world);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
}
