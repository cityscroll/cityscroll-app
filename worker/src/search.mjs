import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { workerD1NoticeSearch, toRecord } from "./lib/notices.mjs";
import {
  executeFederatedSearch,
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LIMITS,
  FEDERATED_SEARCH_PROVIDER_ID,
} from "../../capabilities/federated_search.mjs";
import {
  executeNoticeSearch,
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
  NOTICE_SEARCH_PROVIDER_ID,
} from "../../capabilities/notice_search.mjs";
import rulesDomainObservations from "../../site/data/rules_domain_observations.json" with { type: "json" };
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
} from "../../site/keyword_matcher.mjs";
import { searchLandKeywordFamily } from "../../site/land_keyword_soda_missfill.mjs";
import {
  exactKeywordDocumentFromD1,
  searchKeywordFamilyFromD1,
} from "./lib/search_read_model.mjs";
import { searchOcpFromD1, lookupOcpFromD1 } from "./lib/ocp_warehouse_lookup.mjs";

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
export const SEARCH_FEDERATED_ADAPTER = Object.freeze({
  id: "worker-http.search.federated@1",
  capabilityReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  providerId: FEDERATED_SEARCH_PROVIDER_ID,
  route: "GET /search",
  surface: "Universal search",
});
// Production collection providers register here; the federator remains the
// sole owner of cross-lens normalization, ranking, deduplication, and coverage.
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
  let document = null;
  try {
    document = await exactKeywordDocumentFromD1(
      env?.DB,
      "procurements",
      refs.objectRef,
      refs.sourceRef,
    );
  } catch (error) {
    console.error("exact search read model failed:", String(error?.message || error));
    if (!refs.sourceRef.startsWith("notice:")) return [];
  }
  if (!document && refs.sourceRef.startsWith("notice:") && env?.DB) {
    const requestId = refs.sourceRef.slice("notice:".length);
    const row = await env.DB.prepare("SELECT * FROM notices WHERE request_id = ?")
      .bind(requestId)
      .first();
    if (row) document = publicSearchResult(toRecord(row));
  } else if (!document && refs.sourceRef.startsWith("ocp_award:")) {
    const pin = refs.objectRef.slice("procurement:".length);
    const lookup = await lookupOcpFromD1(env?.DB, { pin });
    if (lookup.status !== "ok") return [];
    document = searchContractAwardDocuments({
      schema_version: 1,
      source: "ocp-recent-contract-awards",
      dataset_id: "qyyg-4tf5",
      table_name: "ocp_recent_contract_awards",
      rows: lookup.rows,
    }, pin, { limit: 10 }).documents
      .find((candidate) => candidate.source_observation_refs.includes(refs.sourceRef)) || null;
  }
  return document?.outcome === "indexed"
    && document.object_ref === refs.objectRef
    && document.source_observation_refs.includes(refs.sourceRef)
    ? [document]
    : [];
}

/** Prefer current City Record objects, then retained awards, then served canonical procurements. */
export function mergeUniversalSearchCandidates({
  cityRecordDocuments = [],
  contractAwardDocuments = [],
  procurementDocuments = [],
  limit = RESULT_LIMIT,
} = {}) {
  const city = Array.isArray(cityRecordDocuments) ? cityRecordDocuments.filter(Boolean) : [];
  const awards = Array.isArray(contractAwardDocuments) ? contractAwardDocuments.filter(Boolean) : [];
  const procurements = Array.isArray(procurementDocuments) ? procurementDocuments.filter(Boolean) : [];
  const ordered = [
    ...city.filter((document) => document.outcome === "indexed"),
    ...awards.filter((document) => document.outcome === "indexed"),
    ...procurements.filter((document) => document.outcome === "indexed"),
    ...city.filter((document) => document.outcome !== "indexed"),
  ];
  const seen = new Set();
  const merged = [];
  for (const document of ordered) {
    const key = `${document.object_type}:${document.object_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(document);
    if (merged.length >= Math.max(0, Number(limit) || 0)) break;
  }
  return {
    documents: merged,
    candidate_counts: Object.freeze({
      city_record: city.length,
      contract_award: awards.length,
      shared_procurement: procurements.length,
      pre_merge: city.length + awards.length + procurements.length,
      post_merge: merged.length,
    }),
  };
}

/** Preserve the historical array-returning helper for callers without extra family inputs. */
export function mergeUniversalSearchResults(
  cityRecordDocuments = [],
  contractAwardDocuments = [],
  limit = RESULT_LIMIT,
  procurementDocuments = [],
) {
  return mergeUniversalSearchCandidates({
    cityRecordDocuments,
    contractAwardDocuments,
    procurementDocuments,
    limit,
  }).documents;
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
    let awardDocuments = [];
    if (!resolved.alias) {
      try {
        const awardLookup = await searchOcpFromD1(env.DB, resolved.raw_query, { limit: RESULT_LIMIT });
        awardDocuments = searchContractAwardDocuments({
          schema_version: 1,
          source: "ocp-recent-contract-awards",
          dataset_id: "qyyg-4tf5",
          table_name: "ocp_recent_contract_awards",
          rows: awardLookup.rows,
        }, resolved.raw_query, { limit: RESULT_LIMIT }).documents;
      } catch (error) {
        console.error("notice-search OCP read model unavailable:", String(error?.message || error));
      }
    }
    let procurementDocuments = [];
    if (!resolved.alias) {
      try {
        const procurementResult = await searchKeywordFamilyFromD1(
          env.DB,
          "procurements",
          resolved,
          { limit: RESULT_LIMIT * 20 },
        );
        procurementDocuments = procurementResult.matches
          .map(({ match_evidence: _evidence, ...document }) => document);
      } catch (error) {
        console.error("notice-search procurement read model unavailable:", String(error?.message || error));
      }
    }
    const noticeMerged = mergeUniversalSearchCandidates({
      cityRecordDocuments: cityMatches.map(({ document }) => document),
      contractAwardDocuments: awardDocuments,
      limit: RESULT_LIMIT,
    });
    const merged = mergeUniversalSearchCandidates({
      cityRecordDocuments: cityMatches.map(({ document }) => document),
      contractAwardDocuments: awardDocuments,
      procurementDocuments,
      limit: RESULT_LIMIT,
    });
    const matched = merged.documents.map((document) => ({
      document,
      evidence: matchKeywordDocument(document, resolved),
    })).filter(({ evidence }) => evidence || resolved.alias);
    const noticeMatched = noticeMerged.documents.map((document) => ({
      document,
      evidence: matchKeywordDocument(document, resolved),
    })).filter(({ evidence }) => evidence || resolved.alias);
    console.log("notice-search-documents:", JSON.stringify({
      city_record_document_count: cityMatches.length,
      contract_award_document_count: awardDocuments.length,
      shared_procurement_document_count: procurementDocuments.length,
      pre_merge_candidate_count: merged.candidate_counts.pre_merge,
    }));
    const lanes = {};
    for (const [id, config] of Object.entries(D1_LANES)) {
      const familyMatches = noticeMatched.filter(({ document }) => document.domain === config.domain);
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
          candidate_count: merged.candidate_counts.post_merge,
          pre_merge_candidate_count: merged.candidate_counts.pre_merge,
          pre_merge_candidate_counts: merged.candidate_counts,
          retrieval_method: result.retrieval.method,
          rows_read: result.retrieval.rows_read,
        }),
      });
    }
    return {
      results: matched.map(({ document, evidence }) => publicCard(document, evidence)),
      lanes,
      candidate_counts: merged.candidate_counts,
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

async function landSearchLane(resolved, { env, fetchImpl = fetch, now = new Date() } = {}) {
  let family = null;
  try {
    const indexed = await searchKeywordFamilyFromD1(env?.DB, "land", resolved, { limit: 20_000 });
    family = indexed.family;
    if (!family) return staticSearchLane("land", resolved, env);
    family.documents = indexed.matches.length ? indexed.matches.map(({ match_evidence: _evidence, ...document }) => document) : [];
    const result = await searchLandKeywordFamily(family, resolved, {
      fetchImpl,
      now,
      limit: Number(family.indexed_count || family.documents?.length || 0) + 8,
    });
    return laneEnvelope("land", {
      status: result.matches.length ? "matched" : "empty",
      count: result.matches.length,
      asOf: result.freshness.as_of,
      source: result.source,
      cards: result.matches.slice(0, CARD_LIMIT).map((document) => publicCard(
        Object.fromEntries(Object.entries(document).filter(([key]) => key !== "match_evidence")),
        document.match_evidence,
      )),
      coverage: Object.freeze({
        bounded: true,
        source_row_count: family.source_row_count,
        indexed_count: family.indexed_count,
        card_limit: CARD_LIMIT,
        freshness_state: result.freshness.state,
        warehouse_as_of: result.freshness.warehouse_as_of,
        soda_as_of: result.freshness.soda_as_of,
        filled_project_ids: result.freshness.filled_project_ids,
      }),
    });
  } catch (error) {
    console.error("land keyword search failed:", JSON.stringify({
      error: String(error?.message || error),
    }));
    return unknownLane("land", family?.source || "D1 keyword read model", "bounded_family_search_failed");
  }
}

async function staticSearchLane(id, resolved, env) {
  try {
    const indexed = await searchKeywordFamilyFromD1(env?.DB, id, resolved, { limit: 20_000 });
    const family = indexed.family;
    if (!family) {
      return laneEnvelope(id, {
        status: "not_covered",
        count: null,
        asOf: null,
        source: "No bounded source configured",
        coverage: Object.freeze({ reason: "bounded_family_index_not_ready" }),
      });
    }
    const matches = indexed.matches;
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
    console.error("D1 keyword search failed:", JSON.stringify({ id, error: String(error?.message || error) }));
    return unknownLane(id, "D1 keyword read model", "bounded_family_search_failed");
  }
}

function keywordFamilyProvider(familyId, env) {
  return Object.freeze({
    async search({ query, limit }) {
      try {
        const indexed = await searchKeywordFamilyFromD1(env?.DB, familyId, resolveKeywordQuery(query), { limit: limit * 20 });
        const family = indexed.family;
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
        const matches = indexed.matches;
        const complete = Number.isInteger(family.source_row_count)
          && family.source_row_count === family.indexed_count;
        return {
          candidates: matches.map((document, index) => {
            const evidence = matchKeywordDocument(document, resolved);
            return {
              document,
              local_score: index + 1,
              match_evidence: document.match_evidence || null,
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
      } catch (error) {
        console.error("D1 collection search failed:", JSON.stringify({ familyId, error: String(error?.message || error) }));
        return {
          candidates: [],
          coverage: {
            state: "provider_unavailable",
            reason: "bounded_family_search_failed",
            indexed_count: null,
            as_of: null,
            source: "D1 keyword read model",
            method: "bounded_keyword_family_v1",
          },
        };
      }
    },
  });
}

function productionCollectionProviders(env) {
  return Object.freeze(Object.fromEntries(
    Object.entries(PRODUCTION_COLLECTION_FAMILIES).map(([lens, familyId]) => (
      [lens, keywordFamilyProvider(familyId, env)]
    )),
  ));
}

function noticeFederatedProvider(env) {
  return Object.freeze({
    async search({ query }) {
      const resolved = resolveKeywordQuery(query);
      const response = await noticeSearchLanes(env, resolved);
      const documents = response.results || [];
      const candidates = documents.map((document, index) => {
        const evidence = document.match_fields?.[0] || {};
        return {
          document,
          local_score: index + 1,
          match_evidence: document.match_evidence || null,
          match_fields: [{
            field: evidence.field || "search_text",
            matched_term: evidence.matched_term || resolved.raw_query,
            source_observation_ref: evidence.source_observation_ref
              || document.source_observation_refs?.[0],
          }],
        };
      });
      const noticeLanes = Object.values(response.lanes || {});
      const available = noticeLanes.length > 0
        && noticeLanes.every((lane) => ["matched", "empty"].includes(lane.status));
      const failed = noticeLanes.find((lane) => lane.status === "unknown");
      const asOf = noticeLanes.map((lane) => lane.as_of).filter(Boolean).sort().at(-1) || null;
      return {
        candidates,
        coverage: {
          state: failed ? "provider_unavailable" : available
            ? (candidates.length ? "matched" : "empty")
            : "not_indexed",
          reason: failed?.coverage?.reason || (!available ? "notice_lanes_not_ready" : null),
          indexed_count: null,
          as_of: asOf,
          source: "City Record and retained contract-award snapshots",
          method: "bounded_notice_search_v1",
          details: {
            candidate_count: response.candidate_counts?.post_merge ?? null,
            pre_merge_candidate_count: response.candidate_counts?.pre_merge ?? null,
            pre_merge_candidate_counts: response.candidate_counts || null,
          },
        },
      };
    },
  });
}

function productionFederatedProviders(env) {
  return Object.freeze({
    ...productionCollectionProviders(env),
    notices: noticeFederatedProvider(env),
    land: landFederatedProvider(env),
    meetings: keywordFamilyProvider("meetings", env),
    exams: keywordFamilyProvider("exams", env),
  });
}

/** Explicit provider for search.federated@1; all ranking and coverage stay in the federator. */
export function workerFederatedSearch(env, { lenses = productionFederatedProviders(env) } = {}) {
  return Object.freeze({
    capabilityReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    providerId: FEDERATED_SEARCH_PROVIDER_ID,
    async execute({ query, limit }) {
      return federateUniversalSearch({
        query,
        lenses,
        limit: limit ?? FEDERATED_SEARCH_LIMITS.defaultResults,
      });
    },
  });
}

function landFederatedProvider(env) {
  return Object.freeze({
    async search({ query }) {
      const lane = await landSearchLane(resolveKeywordQuery(query), { env });
      const candidates = (lane.cards || []).map((document, index) => {
        const evidence = document.match_fields?.[0] || {};
        return {
          document,
          local_score: index + 1,
          match_evidence: document.match_evidence || null,
          match_fields: [{
            field: evidence.field || "search_text",
            matched_term: evidence.matched_term || query,
            source_observation_ref: evidence.source_observation_ref
              || document.source_observation_refs?.[0],
          }],
        };
      });
      return {
        candidates,
        coverage: {
          state: ["matched", "empty"].includes(lane.status)
            ? (candidates.length ? "matched" : "empty")
            : lane.status === "unknown" ? "provider_unavailable" : "not_indexed",
          reason: lane.coverage?.reason || null,
          indexed_count: lane.coverage?.indexed_count ?? null,
          as_of: lane.as_of,
          source: lane.source,
          method: "bounded_land_keyword_family_v1",
          details: lane.coverage || {},
        },
      };
    },
  });
}

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
    cards: matched.slice(0, CARD_LIMIT).map((document) => federatedPublicCard(document)),
    coverage: Object.freeze({
      bounded: true,
      source_row_count: coverage.indexed_count,
      indexed_count: coverage.indexed_count,
      card_limit: CARD_LIMIT,
      reason: coverage.reason,
      ...(coverage.details || {}),
    }),
  });
}

function federatedPublicCard(document) {
  if (document.match_evidence) return publicCard(document, document.match_evidence);
  const evidence = document.match_fields?.[0];
  return publicCard(document, evidence ? {
    field: evidence.field,
    matched_normalized_term: evidence.matched_term,
    source_identifier: evidence.source_observation_ref,
    status: "matched",
  } : null);
}

function federatedPresentationLane(id, federation, {
  lenses,
  domains,
  source,
}) {
  const coverageRows = lenses.map((lens) => federation.coverage.by_lens[lens]);
  const available = coverageRows.every((row) => ["matched", "empty"].includes(row.state));
  const matched = federation.results.filter((result) => (
    domains.includes(result.domain)
      && result.matched_lenses.some((lens) => lenses.includes(lens))
  ));
  return laneEnvelope(id, {
    status: available
      ? (matched.length ? "matched" : "empty")
      : coverageRows.some((row) => row.state === "provider_unavailable") ? "unknown" : "not_covered",
    count: available ? matched.length : null,
    asOf: coverageRows.map((row) => row.as_of).filter(Boolean).sort().at(-1),
    source,
    cards: matched.slice(0, CARD_LIMIT).map(federatedPublicCard),
    coverage: Object.freeze({
      bounded: true,
      indexed_count: coverageRows.every((row) => row.indexed_count !== null)
        ? coverageRows.reduce((sum, row) => sum + row.indexed_count, 0)
        : null,
      card_limit: CARD_LIMIT,
      reason: coverageRows.find((row) => row.reason)?.reason || null,
      ...Object.assign({}, ...coverageRows.map((row) => row.details || {})),
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
  const familyCandidateCoverage = members
    .map((lane) => lane.coverage)
    .find((coverage) => coverage?.pre_merge_candidate_counts);
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
      ...(familyCandidateCoverage ? {
        candidate_count: familyCandidateCoverage.candidate_count,
        pre_merge_candidate_count: familyCandidateCoverage.pre_merge_candidate_count,
        pre_merge_candidate_counts: familyCandidateCoverage.pre_merge_candidate_counts,
      } : {}),
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

function universalSearchCoverage(_lanes, results, _dynamicResults, federatedCoverage) {
  return Object.freeze({
    ...federatedCoverage,
    schema: UNIVERSAL_SEARCH_COVERAGE_SCHEMA,
    returned_count: results.length,
  });
}

export async function handleSearch(request, env, {
  federatedProvider = workerFederatedSearch(env),
} = {}) {
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
  const federation = await executeFederatedSearch(
    federatedProvider,
    { query: resolved.raw_query, limit: RESULT_LIMIT },
  );
  const peopleLane = federatedCollectionLane("people", federation, resolved);
  const vendorLane = federatedCollectionLane("vendors", federation, resolved);
  const parcelsLane = federatedCollectionLane("parcels", federation, resolved);
  const communityBoardsLane = federatedCollectionLane("community_boards", federation, resolved);
  const agencyLane = federatedCollectionLane("agencies", federation, resolved);
  const committeesLane = federatedCollectionLane("committees", federation, resolved);
  const contractsLane = federatedPresentationLane("contracts", federation, {
    lenses: ["notices", "vendors"],
    domains: ["contracts"],
    source: "City Record, PASSPort, Checkbook NYC, and CityScroll vendor profiles",
  });
  const peopleOrganizationsLane = combinedStaticLane(
    "people-organizations",
    "NYC Council people and CityScroll agency profiles",
    [peopleLane, agencyLane],
  );
  const lanes = {
    rules: federatedPresentationLane("rules", federation, {
      lenses: ["notices"],
      domains: ["rules"],
      source: "City Record daily mirror and bounded Rules projection",
    }),
    people: peopleLane,
    vendors: vendorLane,
    community_boards: communityBoardsLane,
    agencies: agencyLane,
    contracts: contractsLane,
    parcels: parcelsLane,
    committees: committeesLane,
    "people-organizations": peopleOrganizationsLane,
    land: federatedPresentationLane("land", federation, {
      lenses: ["land"],
      domains: ["zoning"],
      source: "Bounded land-use keyword read model",
    }),
    meetings: federatedPresentationLane("meetings", federation, {
      lenses: ["meetings", "committees"],
      domains: ["meetings"],
      source: "Bounded meeting and committee read models",
    }),
    exams: federatedPresentationLane("exams", federation, {
      lenses: ["exams"],
      domains: ["civil_service_exam"],
      source: "Bounded civil-service exam read model",
    }),
  };
  const results = federation.results.map(federatedPublicCard).slice(0, RESULT_LIMIT);
  return json({
    schema: RESPONSE_SCHEMA,
    capability_reference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    federated: federation,
    query: resolved.raw_query,
    match_mode: resolved.match_mode,
    resolved_term: {
      canonical_tokens: resolved.canonical_tokens,
      structured_filters: resolved.structured_filters,
      alias_receipt: resolved.alias?.receipt || null,
      expansion_tokens: resolved.expansion_tokens,
      expansion_receipt: resolved.expansion?.receipt || null,
    },
    lanes: LANE_ORDER.map((id) => lanes[id]),
    results,
    coverage: universalSearchCoverage(lanes, results, [], federation.coverage),
  }, 200, cors, "public, max-age=60, stale-while-revalidate=300");
}
