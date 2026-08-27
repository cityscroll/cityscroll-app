/** Canonical Community Board SearchDocuments from the constellation registry. */

import { SEARCH_TEXT_MAX_LENGTH } from "./search_document_contract.mjs";
import {
  communityBoardCommitteeId,
  normalizeCommunityBoardCommitteeRegistry,
} from "./community_board_committees.mjs";
import { communityBoardCommitteePageHref } from "./community_board_links.mjs";
import {
  admitProjectedSearchDocument,
  cleanSearchText,
  failedSearchProjection,
  freezeSearchValue,
  searchProducerCorpus,
  unavailableSearchProducerCorpus,
  uniqueSearchText,
} from "./search_producer_support.mjs";

export const BOARD_SEARCH_PRODUCER_SCHEMA = "cityscroll.board_search_producer.v1";
export const BOARD_SEARCH_PRODUCER = "community_board_search_document.v1";
export const COMMUNITY_BOARD_COMMITTEE_SEARCH_PRODUCER_SCHEMA = "cityscroll.community_board_committee_search_producer.v1";
export const COMMUNITY_BOARD_COMMITTEE_SEARCH_PRODUCER = "community_board_committee_search_document.v1";
const READ_MODEL_SCHEMA = "cityscroll.community_board_constellation.v1";
const READ_MODEL_METHOD = "community_board_constellation_v1";
const BOROUGHS = Object.freeze({
  bronx: "Bronx",
  brooklyn: "Brooklyn",
  manhattan: "Manhattan",
  queens: "Queens",
  "staten-island": "Staten Island",
});

function identityFor(idValue, row = {}) {
  const id = cleanSearchText(idValue, 100).toLowerCase();
  const match = id.match(/^(bronx|brooklyn|manhattan|queens|staten-island)-cb-(\d{2})$/);
  if (!match || row.body_id !== id) return null;
  const href = `/community-boards/${encodeURIComponent(id)}/`;
  if (row.path !== href) return null;
  return {
    id,
    ref: `community-board:${id}`,
    href,
    borough: BOROUGHS[match[1]],
    district: String(Number(match[2])),
  };
}

function boardAliases(identity) {
  return uniqueSearchText([
    `Community Board ${identity.district}, ${identity.borough}`,
    `${identity.borough} Community Board ${identity.district}`,
    `${identity.borough} CB${identity.district}`,
    `CB${identity.district} ${identity.borough}`,
  ]);
}

export function projectBoardSearchDocument(id, row = {}, { lookup = {} } = {}) {
  if (lookup.schema !== READ_MODEL_SCHEMA || lookup.method !== READ_MODEL_METHOD) {
    return failedSearchProjection("not_indexed", "unsupported_community_board_read_model", ["read_model"]);
  }
  const identity = identityFor(id, row);
  if (!identity) {
    return failedSearchProjection("unclassified", "unresolved_community_board_identity", ["object_ref"]);
  }
  const title = cleanSearchText(row.display_name, 500);
  if (!title) return failedSearchProjection("not_indexed", "missing_community_board_name", ["title"]);
  const aliases = boardAliases(identity);
  const relationLabels = uniqueSearchText((Array.isArray(row.edge_summary) ? row.edge_summary : [])
    .filter((edge) => edge?.state === "matched")
    .flatMap((edge) => [edge.relation_label, edge.target_name]));

  return admitProjectedSearchDocument({
    object_ref: identity.ref,
    object_type: "community_board",
    domain: "places",
    canonical_href: identity.href,
    title,
    summary: `${title} · Community Board · appointed local advisory body.`,
    search_text: uniqueSearchText([title, identity.id, ...aliases, ...relationLabels])
      .join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH),
    source_family: "community_board_constellation",
    source_observation_refs: [`community_board_registry:${identity.id}`],
    process_role: null,
    classification: {
      method: "canonical_community_board_registry",
      basis: "borough-qualified community-board registry identity; bare board numbers are not identities",
    },
    provenance: {
      producer: BOARD_SEARCH_PRODUCER,
      read_model_schema: lookup.schema,
      read_model_method: lookup.method,
      read_model_generated_at: lookup.generated_at || null,
      borough: identity.borough,
      district: identity.district,
      aliases,
      coverage: {
        matched_categories: Number(row.summary?.matched_categories) || 0,
        category_count: Number(row.summary?.category_count) || 0,
        relation_states: (row.edge_summary || []).map((edge) => ({
          relation: edge.relation_label || edge.edge_type || null,
          state: edge.state || "unknown",
          observed_at: edge.provenance?.observed_at || null,
        })),
      },
    },
  }, "borough_qualified_community_board_identity");
}

export function buildBoardSearchDocuments(lookup = {}) {
  if (lookup.schema !== READ_MODEL_SCHEMA || lookup.method !== READ_MODEL_METHOD
    || !lookup.by_id || typeof lookup.by_id !== "object" || Array.isArray(lookup.by_id)) {
    return unavailableSearchProducerCorpus({
      schema: BOARD_SEARCH_PRODUCER_SCHEMA,
      producer: BOARD_SEARCH_PRODUCER,
      objectType: "community_board",
      domain: "places",
      reason: "unsupported_community_board_read_model",
    });
  }
  const outcomes = Object.entries(lookup.by_id)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([id, row]) => freezeSearchValue({
      board_id: id,
      ...projectBoardSearchDocument(id, row, { lookup }),
    }));
  return searchProducerCorpus({
    schema: BOARD_SEARCH_PRODUCER_SCHEMA,
    producer: BOARD_SEARCH_PRODUCER,
    objectType: "community_board",
    domain: "places",
    outcomes,
    reasons: {
      matched: "community_board_registry_indexed",
      empty: "community_board_registry_has_no_entries",
      partial: "some_community_board_entries_failed_admission",
      not_indexed: "no_community_board_entries_passed_admission",
    },
  });
}

function committeeBoardContext(boardIdValue, boardLookup = {}) {
  const id = cleanSearchText(boardIdValue, 100).toLowerCase();
  const match = id.match(/^(bronx|brooklyn|manhattan|queens|staten-island)-cb-(\d{2})$/);
  if (!match) return null;
  const row = boardLookup?.by_id?.[id]
    || boardLookup?.nodes?.find((candidate) => candidate?.id === `community-board:${id}`)
    || {};
  const borough = BOROUGHS[match[1]];
  const district = String(Number(match[2]));
  const name = cleanSearchText(row.display_name || row.name, 500) || `${borough} Community Board ${district}`;
  return {
    id,
    name,
    borough,
    district,
    short_name: `Community Board ${district}`,
  };
}

function committeeSearchText(committee, board) {
  const topicFacets = uniqueSearchText(committee.topic_facets || [], 100);
  const publisherTopic = cleanSearchText(committee.publisher_name, 300)
    .replace(/(?:\s+committee)?(?:\s+meeting)?$/i, "")
    .trim();
  return uniqueSearchText([
    committee.publisher_name,
    ...committee.aliases,
    ...topicFacets,
    publisherTopic,
    board.name,
    `${publisherTopic} ${board.short_name}`,
    ...topicFacets.map((facet) => `${facet} ${board.short_name}`),
    "Community Board committee",
    "appointed local advisory body",
    board.borough,
    `Community District ${board.district}`,
  ], SEARCH_TEXT_MAX_LENGTH).join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH);
}

/** Project a reviewed, board-local committee into the shared SearchDocument contract. */
export function projectCommunityBoardCommitteeSearchDocument(committee = {}, {
  boardLookup = {},
  lookup = boardLookup,
} = {}) {
  const board = committeeBoardContext(committee.board_id, lookup);
  const publisherName = cleanSearchText(committee.publisher_name, 500);
  const committeeId = cleanSearchText(committee.committee_id, 120).toLowerCase();
  if (!board || !committeeId || !publisherName) {
    return failedSearchProjection("unclassified", "unresolved_board_local_committee_identity", ["object_ref"]);
  }
  const objectRef = communityBoardCommitteeId(board.id, committeeId);
  const aliases = uniqueSearchText(committee.aliases || [], 300);
  const topicFacets = uniqueSearchText(committee.topic_facets || [], 100)
    .map((facet) => facet.toLocaleLowerCase("en-US"));
  const sourceRef = `community_board_committee_registry:${board.id}:${committeeId}`;
  const canonicalHref = communityBoardCommitteePageHref(board.id, committeeId);
  return admitProjectedSearchDocument({
    object_ref: objectRef,
    object_type: "community-board-committee",
    domain: "people",
    canonical_href: canonicalHref,
    title: publisherName,
    summary: `${board.name} · Community Board committee · appointed local advisory body.`,
    search_text: committeeSearchText({ ...committee, aliases, topic_facets: topicFacets, publisher_name: publisherName }, board),
    source_family: "community_board_committee_registry",
    source_observation_refs: [sourceRef],
    process_role: null,
    classification: {
      method: "reviewed_board_local_committee_registry",
      basis: "exact reviewed publisher committee identity qualified by its parent Community Board",
    },
    provenance: {
      producer: COMMUNITY_BOARD_COMMITTEE_SEARCH_PRODUCER,
      source_system: "community_board_publisher",
      board_id: board.id,
      board_name: board.name,
      borough: board.borough,
      district: board.district,
      publisher_name: publisherName,
      publisher_identifier: committee.publisher_identifier || null,
      reviewed_aliases: aliases,
      topic_facets: topicFacets,
      source_url: committee.source_url || null,
      observed_on: committee.observed_on || null,
      institution_label: `${board.name} · Community Board committee`,
      institution_context: "Appointed local advisory body",
      parent_labels: [board.name],
    },
  }, "exact_reviewed_board_local_committee_identity");
}

/** Build one document per board-qualified committee; same names never share an object_ref. */
export function buildCommunityBoardCommitteeSearchDocuments(registry = {}, { boardLookup = {}, lookup = boardLookup } = {}) {
  const rows = normalizeCommunityBoardCommitteeRegistry(registry);
  if (!rows.length) {
    return unavailableSearchProducerCorpus({
      schema: COMMUNITY_BOARD_COMMITTEE_SEARCH_PRODUCER_SCHEMA,
      producer: COMMUNITY_BOARD_COMMITTEE_SEARCH_PRODUCER,
      objectType: "community-board-committee",
      domain: "people",
      reason: "community_board_committee_registry_has_no_entries",
    });
  }
  const outcomes = rows
    .sort((left, right) => `${left.board_id}:${left.committee_id}`.localeCompare(`${right.board_id}:${right.committee_id}`, "en-US"))
    .map((committee) => freezeSearchValue({
      committee_id: communityBoardCommitteeId(committee.board_id, committee.committee_id),
      ...projectCommunityBoardCommitteeSearchDocument(committee, { boardLookup: lookup, lookup }),
    }));
  return searchProducerCorpus({
    schema: COMMUNITY_BOARD_COMMITTEE_SEARCH_PRODUCER_SCHEMA,
    producer: COMMUNITY_BOARD_COMMITTEE_SEARCH_PRODUCER,
    objectType: "community-board-committee",
    domain: "people",
    outcomes,
    reasons: {
      matched: "reviewed_community_board_committee_registry_indexed",
      empty: "community_board_committee_registry_has_no_entries",
      partial: "some_community_board_committee_entries_failed_admission",
      not_indexed: "no_community_board_committee_entries_passed_admission",
    },
  });
}
