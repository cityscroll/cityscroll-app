import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { workerD1NoticeSearch, toRecord } from "./lib/notices.mjs";
import {
  executeNoticeSearch,
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
  NOTICE_SEARCH_PROVIDER_ID,
} from "../../capabilities/notice_search.mjs";
import rulesDomainObservations from "../../site/data/rules_domain_observations.json" with { type: "json" };
import ocpAwardLookup from "./data/ocp_awards_warehouse_lookup.json" with { type: "json" };
import keywordSearchIndex from "./data/keyword_search_index.json" with { type: "json" };
import {
  buildCityRecordRuleProjectionIndex,
  materializeCityRecordSearchDocument,
} from "../../site/city_record_search_producers.mjs";
import { searchContractAwardDocuments } from "../../site/contract_award_search_producer.mjs";
import {
  UNIVERSAL_SEARCH_COVERAGE_SCHEMA,
  UNIVERSAL_SEARCH_LENS_IDS,
  federateUniversalSearch,
} from "../../site/universal_search_federator.mjs";
import {
  matchKeywordDocument,
  resolveKeywordQuery,
  searchKeywordDocuments,
} from "../../site/keyword_matcher.mjs";

const MAX_QUERY_LENGTH = 240;
const RESULT_LIMIT = 100;
const CARD_LIMIT = 8;
const RESPONSE_SCHEMA = "cityscroll.keyword_search_response.v1";
const LANE_ORDER = Object.freeze([
  "contracts",
  "people",
  "agencies",
  "people-organizations",
  "community_boards",
  "land",
  "rules",
  "meetings",
  "exams",
]);
const D1_LANES = Object.freeze({
  contracts: Object.freeze({ domain: "contracts", source: "City Record daily mirror" }),
  rules: Object.freeze({ domain: "rules", source: "City Record daily mirror and bounded Rules projection" }),
});
export const SEARCH_NOTICE_ADAPTER = Object.freeze({
  id: "worker-http.search.notice-lane@1",
  capabilityReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
  providerId: NOTICE_SEARCH_PROVIDER_ID,
  route: "GET /search",
  surface: "Universal search",
});
// Production collection providers register here. Follow-on collection wiring
// adds one lens-to-family entry without changing the federator contract.
const PRODUCTION_COLLECTION_FAMILIES = Object.freeze({
  people: "people",
  vendors: "vendors",
  parcels: "parcels",
  community_boards: "community_boards",
  agencies: "agencies",
  committees: "committees",
});
// Collection lenses that are not already represented in the six presentation
// lanes still contribute typed objects to the flat result list. People compose
// into people-organizations; Vendors compose into Contracts.
const EXTRA_RESULT_LANES = Object.freeze(
  Object.keys(PRODUCTION_COLLECTION_FAMILIES).filter((lens) => (
    !LANE_ORDER.includes(lens) && lens !== "people" && lens !== "vendors"
  )),
);

function cleanQuery(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

const RULE_PROJECTION_INDEX = buildCityRecordRuleProjectionIndex(rulesDomainObservations);

function exactContractRefs(url) {
  const objectRef = cleanQuery(url.searchParams.get("object_ref"));
  const sourceRef = cleanQuery(url.searchParams.get("source_ref"));
  if (!objectRef && !sourceRef) return null;
  if (
    !/^procurement:[^\s\u0000-\u001f]{4,300}$/.test(objectRef)
    || !/^(?:notice|ocp_award|city_record|passport_public_contracts|passport_public_rfx|checkbook_contracts|checkbook_spending):[^\u0000-\u001f]{1,220}$/.test(sourceRef)
  ) return Object.freeze({ invalid: true });
  return Object.freeze({ objectRef, sourceRef });
}

export function publicSearchResult(record, { ruleIndex = RULE_PROJECTION_INDEX } = {}) {
  return materializeCityRecordSearchDocument({
    ...record,
    section_name: record?.section_name || record?.section,
    type_of_notice_description: record?.type_of_notice_description || record?.notice_type,
    description: record?.description || record?.snippet,
  }, { ruleIndex });
}

async function exactContractDocuments(env, refs) {
  if (!refs || refs.invalid) return [];
  let document = keywordSearchIndex?.families?.procurements?.documents
    ?.find((candidate) => candidate.object_ref === refs.objectRef
      && candidate.source_observation_refs.includes(refs.sourceRef)) || null;
  if (!document && refs.sourceRef.startsWith("notice:") && env?.DB) {
    const requestId = refs.sourceRef.slice("notice:".length);
    const row = await env.DB.prepare("SELECT * FROM notices WHERE request_id = ?")
      .bind(requestId)
      .first();
    if (row) document = publicSearchResult(toRecord(row));
  } else if (!document && refs.sourceRef.startsWith("ocp_award:")) {
    const pin = refs.objectRef.slice("procurement:".length);
    document = searchContractAwardDocuments(ocpAwardLookup, pin, { limit: 10 }).documents
      .find((candidate) => candidate.source_observation_refs.includes(refs.sourceRef)) || null;
  }
  return document?.outcome === "indexed"
    && document.object_ref === refs.objectRef
    && document.source_observation_refs.includes(refs.sourceRef)
    ? [document]
    : [];
}

/** Prefer richer current City Record objects, then add retained award recall and notice evidence. */
export function mergeUniversalSearchResults(cityRecordDocuments = [], contractAwardDocuments = [], limit = RESULT_LIMIT) {
  const city = Array.isArray(cityRecordDocuments) ? cityRecordDocuments.filter(Boolean) : [];
  const awards = Array.isArray(contractAwardDocuments) ? contractAwardDocuments.filter(Boolean) : [];
  const ordered = [
    ...city.filter((document) => document.outcome === "indexed"),
    ...awards.filter((document) => document.outcome === "indexed"),
    ...city.filter((document) => document.outcome !== "indexed"),
  ];
  const seen = new Set();
  const merged = [];
  for (const document of ordered) {
    const key = `${document.object_type}:${document.object_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(document);
    if (merged.length >= limit) break;
  }
  return merged;
}

function json(body, status, cors, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function laneEnvelope(id, {
  status,
  count,
  asOf,
  source,
  cards = [],
  coverage = null,
}) {
  return Object.freeze({
    id,
    status,
    count,
    as_of: asOf || null,
    source,
    match_mode: "keyword",
    cards: Object.freeze(cards),
    coverage,
  });
}

function unknownLane(id, source, reason = "source_unavailable") {
  return laneEnvelope(id, {
    status: "unknown",
    count: null,
    asOf: null,
    source,
    coverage: Object.freeze({ reason }),
  });
}

function publicCard(document, evidence) {
  return Object.freeze({
    ...document,
    match_fields: evidence ? Object.freeze([Object.freeze({
      field: evidence.field,
      matched_term: evidence.matched_normalized_term,
      source_observation_ref: evidence.source_identifier,
    })]) : document.match_fields,
    match_evidence: evidence || null,
    keyword_evidence: Object.freeze(evidence ? {
      status: "matched",
      message: null,
    } : {
      status: "unavailable",
      message: "Keyword evidence unavailable for this source",
    }),
  });
}

async function noticeMirrorAsOf(db) {
  try {
    const row = await db.prepare("SELECT MAX(ingested_at) AS as_of FROM notices").first();
    return row?.as_of || null;
  } catch {
    return null;
  }
}

export function noticeSearchInputFromKeywordResolution(resolved) {
  return {
    termGroups: resolved.retrieval_groups,
    agency: resolved.structured_filters.agency,
    limit: RESULT_LIMIT,
  };
}

async function noticeSearchLanes(env, resolved) {
  if (!env?.DB) {
    return {
      results: [],
      lanes: Object.fromEntries(Object.entries(D1_LANES).map(([id, config]) => [
        id,
        unknownLane(id, config.source, "notice_mirror_unavailable"),
      ])),
    };
  }

  try {
    const result = await executeNoticeSearch(
      workerD1NoticeSearch(env.DB),
      noticeSearchInputFromKeywordResolution(resolved),
    );
    console.log("notice-search:", JSON.stringify({ route: "search", ...result.retrieval }));
    const asOf = await noticeMirrorAsOf(env.DB);
    const projected = result.results.map(publicSearchResult).filter(Boolean);
    const cityMatches = projected.map((document) => ({
      document,
      evidence: matchKeywordDocument(document, resolved),
    })).filter(({ evidence }) => evidence || resolved.alias);
    const awardDocuments = resolved.alias
      ? []
      : searchContractAwardDocuments(
        ocpAwardLookup,
        resolved.canonical_tokens.join(" "),
        { limit: RESULT_LIMIT },
      ).documents;
    const matched = mergeUniversalSearchResults(
      cityMatches.map(({ document }) => document),
      awardDocuments,
    ).map((document) => ({
      document,
      evidence: matchKeywordDocument(document, resolved),
    })).filter(({ evidence }) => evidence || resolved.alias);
    console.log("notice-search-documents:", JSON.stringify({
      city_record_document_count: cityMatches.length,
      contract_award_document_count: awardDocuments.length,
    }));
    const lanes = {};
    for (const [id, config] of Object.entries(D1_LANES)) {
      const familyMatches = matched.filter(({ document }) => document.domain === config.domain);
      const cards = familyMatches.slice(0, CARD_LIMIT).map(({ document, evidence }) => (
        publicCard(document, evidence)
      ));
      lanes[id] = laneEnvelope(id, {
        status: familyMatches.length ? "matched" : "empty",
        count: familyMatches.length,
        asOf,
        source: config.source,
        cards,
        coverage: Object.freeze({
          bounded: true,
          result_limit: RESULT_LIMIT,
          retrieval_method: result.retrieval.method,
          rows_read: result.retrieval.rows_read,
        }),
      });
    }
    return {
      results: matched.map(({ document, evidence }) => publicCard(document, evidence)),
      lanes,
    };
  } catch (error) {
    console.error("notice-search failed:", String(error?.message || error));
    return {
      results: [],
      lanes: Object.fromEntries(Object.entries(D1_LANES).map(([id, config]) => [
        id,
        unknownLane(id, config.source, "notice_search_failed"),
      ])),
    };
  }
}

function staticSearchLane(id, resolved) {
  const family = keywordSearchIndex?.families?.[id];
  if (!family) {
    return laneEnvelope(id, {
      status: "not_covered",
      count: null,
      asOf: null,
      source: "No bounded source configured",
      coverage: Object.freeze({ reason: "bounded_family_index_not_ready" }),
    });
  }
  try {
    const matches = searchKeywordDocuments(family.documents, resolved, {
      limit: family.documents.length,
    });
    return laneEnvelope(id, {
      status: matches.length ? "matched" : "empty",
      count: matches.length,
      asOf: family.as_of,
      source: family.source,
      cards: matches.slice(0, CARD_LIMIT).map((document) => publicCard(
        Object.fromEntries(Object.entries(document).filter(([key]) => key !== "match_evidence")),
        document.match_evidence,
      )),
      coverage: Object.freeze({
        bounded: true,
        source_row_count: family.source_row_count,
        indexed_count: family.indexed_count,
        card_limit: CARD_LIMIT,
      }),
    });
  } catch (error) {
    console.error("static keyword search failed:", JSON.stringify({ id, error: String(error?.message || error) }));
    return unknownLane(id, family.source, "bounded_family_search_failed");
  }
}

function keywordFamilyProvider(familyId) {
  return Object.freeze({
    async search({ query, limit }) {
      const family = keywordSearchIndex?.families?.[familyId];
      if (!family) {
        return {
          candidates: [],
          coverage: {
            state: "not_indexed",
            reason: "bounded_family_index_not_ready",
            indexed_count: null,
            as_of: null,
            source: "No bounded source configured",
            method: "bounded_keyword_family_v1",
          },
        };
      }
      const resolved = resolveKeywordQuery(query);
      const matches = searchKeywordDocuments(family.documents, resolved, { limit });
      const complete = Number.isInteger(family.source_row_count)
        && family.source_row_count === family.indexed_count;
      return {
        candidates: matches.map((document, index) => {
          const { match_evidence: evidence, ...searchDocument } = document;
          return {
            document: searchDocument,
            local_score: index + 1,
            match_fields: [{
              field: evidence.field,
              matched_term: evidence.matched_normalized_term,
              source_observation_ref: evidence.source_identifier,
            }],
          };
        }),
        coverage: {
          state: complete ? (matches.length ? "matched" : "empty") : "partial",
          reason: complete ? null : "bounded_family_index_incomplete",
          indexed_count: family.indexed_count,
          as_of: family.as_of,
          source: family.source,
          method: "bounded_keyword_family_v1",
        },
      };
    },
  });
}

const PRODUCTION_COLLECTION_PROVIDERS = Object.freeze(Object.fromEntries(
  Object.entries(PRODUCTION_COLLECTION_FAMILIES).map(([lens, familyId]) => (
    [lens, keywordFamilyProvider(familyId)]
  )),
));

function federatedCollectionLane(lens, federation, resolved) {
  const coverage = federation.coverage.by_lens[lens];
  const matched = federation.results.filter((result) => result.matched_lenses.includes(lens));
  const available = coverage.state === "matched" || coverage.state === "empty";
  return laneEnvelope(lens, {
    status: available
      ? (matched.length ? "matched" : "empty")
      : coverage.state === "provider_unavailable" ? "unknown" : "not_covered",
    count: available ? matched.length : null,
    asOf: coverage.as_of,
    source: coverage.source || "No bounded source configured",
    cards: matched.slice(0, CARD_LIMIT).map((document) => (
      publicCard(document, matchKeywordDocument(document, resolved))
    )),
    coverage: Object.freeze({
      bounded: true,
      source_row_count: coverage.indexed_count,
      indexed_count: coverage.indexed_count,
      card_limit: CARD_LIMIT,
      reason: coverage.reason,
    }),
  });
}

function combinedStaticLane(id, source, members) {
  const available = members.filter((lane) => ["matched", "empty"].includes(lane.status));
  const cards = [];
  const seen = new Set();
  for (const card of members.flatMap((lane) => lane.cards || [])) {
    const identities = [card.object_ref, ...(card.provenance?.alias_object_refs || [])].filter(Boolean);
    if (identities.some((identity) => seen.has(identity))) continue;
    identities.forEach((identity) => seen.add(identity));
    cards.push(card);
    if (cards.length >= CARD_LIMIT) break;
  }
  const count = available.length
    ? available.reduce((sum, lane) => sum + lane.count, 0)
    : null;
  const clocks = members.map((lane) => lane.as_of).filter(Boolean).sort();
  const sumCoverageCount = (key) => available.reduce((sum, lane) => {
    const value = lane.coverage?.[key];
    return Number.isInteger(value) ? sum + value : sum;
  }, 0);
  return laneEnvelope(id, {
    status: cards.length
      ? "matched"
      : available.length ? "empty" : members.some((lane) => lane.status === "unknown") ? "unknown" : "not_covered",
    count,
    asOf: clocks.at(-1) || null,
    source,
    cards,
    coverage: Object.freeze({
      bounded: true,
      source_row_count: sumCoverageCount("source_row_count"),
      indexed_count: sumCoverageCount("indexed_count"),
      card_limit: CARD_LIMIT,
    }),
  });
}

function flattenedResults(dynamicResults, lanes) {
  const seen = new Set();
  const results = [];
  for (const document of [
    ...(Array.isArray(dynamicResults) ? dynamicResults : []),
    ...[...LANE_ORDER, ...EXTRA_RESULT_LANES].flatMap((id) => lanes[id]?.cards || []),
  ]) {
    const identities = [document?.object_ref, ...(document?.provenance?.alias_object_refs || [])]
      .filter(Boolean).map((identity) => `${document?.object_type}:${identity}`);
    if (!document?.object_ref || identities.some((identity) => seen.has(identity))) continue;
    identities.forEach((identity) => seen.add(identity));
    results.push(document);
    if (results.length >= RESULT_LIMIT) break;
  }
  return results;
}

function universalSearchCoverage(lanes, results, dynamicResults, federatedCoverage) {
  const typeCount = (types) => results.filter((document) => types.includes(document.object_type)).length;
  const partialLens = (lens, familyId, types) => {
    const family = lanes[familyId];
    const available = family?.status === "matched" || family?.status === "empty";
    const matchedCount = available ? typeCount(types) : null;
    return {
      lens,
      participated: available,
      state: available ? "partial" : family?.status === "unknown" ? "provider_unavailable" : "not_indexed",
      reason: available ? "family_index_combines_multiple_universal_lenses" : family?.coverage?.reason || null,
      matched_count: matchedCount,
      candidate_count: matchedCount,
      invalid_candidate_count: available ? 0 : null,
      indexed_count: null,
      as_of: family?.as_of || null,
      source: family?.source || "No bounded source configured",
      method: "bounded_keyword_family_v1",
    };
  };
  const familiesMatchedLens = (lens, familyId, types) => {
    const family = lanes[familyId];
    const matchedCount = ["matched", "empty"].includes(family?.status) ? typeCount(types) : null;
    return {
      lens,
      participated: ["matched", "empty"].includes(family?.status),
      state: ["matched", "empty"].includes(family?.status)
        ? (matchedCount ? "matched" : "empty")
        : family?.status === "unknown" ? "provider_unavailable" : "not_indexed",
      reason: ["matched", "empty"].includes(family?.status) ? "family_index_combines_multiple_universal_lenses" : family?.coverage?.reason || null,
      matched_count: matchedCount,
      candidate_count: matchedCount,
      invalid_candidate_count: ["matched", "empty"].includes(family?.status) ? 0 : null,
      indexed_count: family?.coverage?.indexed_count ?? null,
      as_of: family?.as_of || null,
      source: family?.source || "No bounded source configured",
      method: "bounded_keyword_family_v1",
    };
  };
  const noticeFamilies = [lanes.contracts, lanes.rules];
  const noticeAvailable = noticeFamilies.every((family) => ["matched", "empty"].includes(family?.status));
  const noticeMatchedCount = noticeAvailable ? dynamicResults.length : null;
  const examFamily = lanes.exams;
  const examsAvailable = ["matched", "empty"].includes(examFamily?.status);
  const byLens = {
    notices: {
      lens: "notices",
      participated: noticeAvailable,
      state: noticeAvailable ? (noticeMatchedCount ? "matched" : "empty") : "provider_unavailable",
      reason: noticeAvailable ? null : "notice_family_unavailable",
      matched_count: noticeMatchedCount,
      candidate_count: noticeMatchedCount,
      invalid_candidate_count: noticeAvailable ? 0 : null,
      indexed_count: null,
      as_of: lanes.contracts?.as_of || lanes.rules?.as_of || null,
      source: "City Record and retained contract-award snapshots",
      method: "bounded_keyword_family_v1",
    },
    people: federatedCoverage.by_lens.people,
    agencies: familiesMatchedLens("agencies", "agencies", ["agency"]),
    vendors: federatedCoverage.by_lens.vendors,
    community_boards: federatedCoverage.by_lens.community_boards,
    committees: federatedCoverage.by_lens.committees,
    exams: {
      lens: "exams",
      participated: examsAvailable,
      state: examsAvailable ? (examFamily.count ? "matched" : "empty") : "not_indexed",
      reason: examsAvailable ? null : examFamily?.coverage?.reason || "exam_family_unavailable",
      matched_count: examsAvailable ? examFamily.count : null,
      candidate_count: examsAvailable ? examFamily.count : null,
      invalid_candidate_count: examsAvailable ? 0 : null,
      indexed_count: examFamily?.coverage?.indexed_count ?? null,
      as_of: examFamily?.as_of || null,
      source: examFamily?.source || "No bounded source configured",
      method: "bounded_keyword_family_v1",
    },
    parcels: federatedCoverage.by_lens.parcels,
  };
  const incompleteLenses = UNIVERSAL_SEARCH_LENS_IDS.filter((lens) => (
    !["matched", "empty"].includes(byLens[lens].state)
  ));
  return {
    schema: UNIVERSAL_SEARCH_COVERAGE_SCHEMA,
    all_lenses_participated: incompleteLenses.length === 0,
    complete_count: null,
    observed_count: results.length,
    total_matches: null,
    returned_count: results.length,
    by_entity_type: Object.fromEntries([...new Set(results.map((result) => result.object_type))]
      .map((type) => [type, typeCount([type])])),
    incomplete_lenses: incompleteLenses,
    snapshot: {
      state: "incomplete",
      as_of: null,
      as_of_by_lens: Object.fromEntries(UNIVERSAL_SEARCH_LENS_IDS.map((lens) => [lens, byLens[lens].as_of])),
    },
    by_lens: byLens,
  };
}

export async function handleSearch(request, env) {
  const origin = request.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, {
    methods: "GET, OPTIONS",
    headers: "Accept, Content-Type",
  });
  if (!isAllowedRequestOrigin(origin, env)) return json({ ok: false, reason: "origin" }, 403, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  const url = new URL(request.url);
  const exactRefs = exactContractRefs(url);
  if (exactRefs) {
    if (exactRefs.invalid) return json({ ok: false, reason: "invalid-exact-refs" }, 400, cors);
    const results = await exactContractDocuments(env, exactRefs);
    return json({
      schema: "cityscroll.exact_search_response.v1",
      match_mode: "exact_object_ref",
      object_ref: exactRefs.objectRef,
      source_ref: exactRefs.sourceRef,
      results,
    }, 200, cors, "public, max-age=60, stale-while-revalidate=300");
  }
  const query = cleanQuery(url.searchParams.get("q"));
  if (!query) return json({ ok: false, reason: "missing-query" }, 400, cors);
  const resolved = resolveKeywordQuery(query);
  const dynamic = await noticeSearchLanes(env, resolved);
  const collectionFederation = await federateUniversalSearch({
    query: resolved.raw_query,
    lenses: PRODUCTION_COLLECTION_PROVIDERS,
    limit: RESULT_LIMIT,
  });
  const peopleLane = federatedCollectionLane("people", collectionFederation, resolved);
  const vendorLane = federatedCollectionLane("vendors", collectionFederation, resolved);
  const parcelsLane = federatedCollectionLane("parcels", collectionFederation, resolved);
  const communityBoardsLane = federatedCollectionLane("community_boards", collectionFederation, resolved);
  const agencyLane = federatedCollectionLane("agencies", collectionFederation, resolved);
  const committeesLane = federatedCollectionLane("committees", collectionFederation, resolved);
  const contractsMirror = dynamic.lanes.contracts;
  const procurementLane = staticSearchLane("procurements", resolved);
  const contractsMirrorAvailable = ["matched", "empty"].includes(contractsMirror?.status);
  // Keep an unavailable notice mirror honest as unknown unless a Vendor hit
  // can still publish through the Contracts presentation lane.
  const contractsLane = contractsMirrorAvailable || vendorLane.cards.length || procurementLane.cards.length
    ? combinedStaticLane(
      "contracts",
      "City Record, PASSPort, Checkbook NYC, and CityScroll vendor profiles",
      [contractsMirror, vendorLane, procurementLane],
    )
    : contractsMirror;
  const peopleOrganizationsLane = combinedStaticLane(
    "people-organizations",
    "NYC Council people and CityScroll agency profiles",
    [peopleLane, agencyLane],
  );
  const lanes = {
    ...dynamic.lanes,
    people: peopleLane,
    vendors: vendorLane,
    community_boards: communityBoardsLane,
    agencies: agencyLane,
    contracts: contractsLane,
    procurements: procurementLane,
    parcels: parcelsLane,
    committees: committeesLane,
    "people-organizations": peopleOrganizationsLane,
    land: staticSearchLane("land", resolved),
    meetings: staticSearchLane("meetings", resolved),
    exams: staticSearchLane("exams", resolved),
  };
  const results = flattenedResults(dynamic.results, lanes);
  return json({
    schema: RESPONSE_SCHEMA,
    query: resolved.raw_query,
    match_mode: resolved.match_mode,
    resolved_term: {
      canonical_tokens: resolved.canonical_tokens,
      structured_filters: resolved.structured_filters,
      alias_receipt: resolved.alias?.receipt || null,
    },
    lanes: LANE_ORDER.map((id) => lanes[id]),
    results,
    coverage: universalSearchCoverage(lanes, results, dynamic.results, collectionFederation.coverage),
  }, 200, cors, "public, max-age=60, stale-while-revalidate=300");
}
