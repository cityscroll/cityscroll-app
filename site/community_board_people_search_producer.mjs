/** Canonical Community Board person SearchDocuments from grounded role edges. */

import {
  communityBoardPersonId,
  communityBoardPersonObject,
  promoteCommunityBoardPersonRoleEdge,
} from "./community_board_relations.mjs";
import {
  admitProjectedSearchDocument,
  cleanSearchText,
  failedSearchProjection,
  freezeSearchValue,
  searchProducerCorpus,
  unavailableSearchProducerCorpus,
  uniqueSearchText,
} from "./search_producer_support.mjs";
import { communityBoardPageHref } from "./community_board_links.mjs";
import { SEARCH_TEXT_MAX_LENGTH } from "./search_document_contract.mjs";

export const COMMUNITY_BOARD_PERSON_SEARCH_PRODUCER_SCHEMA = "cityscroll.community_board_person_search_producer.v1";
export const COMMUNITY_BOARD_PERSON_SEARCH_PRODUCER = "community_board_person_search_document.v1";
export const COMMUNITY_BOARD_PEOPLE_SOURCE_SCHEMA = "cityscroll.community_board_people.v1";

const ROLE_LABELS = Object.freeze({
  appointed_member: "Board member",
  board_chair: "Board chair",
  board_officer: "Board officer",
  committee_chair: "Committee chair",
  committee_member: "Committee member",
  public_committee_member: "Public committee member",
  district_manager: "District Manager",
  staff: "Community Board staff",
});

const BOROUGHS = Object.freeze({
  bronx: "Bronx",
  brooklyn: "Brooklyn",
  manhattan: "Manhattan",
  queens: "Queens",
  "staten-island": "Staten Island",
});

function peopleRows(lookup = {}) {
  return Object.entries(lookup?.boards || {}).flatMap(([boardId, board]) => (
    (Array.isArray(board?.relationships) ? board.relationships : [])
      .map((row) => ({ ...row, board_id: row.board_id || boardId }))
  ));
}

function boardContext(boardIdValue, boardLookup = {}) {
  const id = cleanSearchText(boardIdValue, 100).toLowerCase();
  const match = id.match(/^(bronx|brooklyn|manhattan|queens|staten-island)-cb-(\d{2})$/);
  if (!match) return null;
  const boardRow = boardLookup?.by_id?.[id]
    || boardLookup?.nodes?.find((candidate) => candidate?.id === `community-board:${id}`)
    || {};
  const borough = BOROUGHS[match[1]];
  const district = String(Number(match[2]));
  return {
    id,
    borough,
    district,
    name: cleanSearchText(boardRow.display_name || boardRow.name, 500) || `${borough} Community Board ${district}`,
  };
}

function sourceReference(edge, board, publisherId) {
  const documentId = cleanSearchText(edge?.source_document?.id, 240) || "source-document";
  return `community_board_person_role:${board.id}:${publisherId}:${documentId}:${edge.relation}`;
}

function committeeContext(ref, committeeRegistry = {}) {
  const match = cleanSearchText(ref, 320).match(/^community-board-committee:([^:]+):(.+)$/);
  if (!match) return null;
  const row = (Array.isArray(committeeRegistry?.committees) ? committeeRegistry.committees : [])
    .find((candidate) => candidate?.board_id === match[1] && candidate?.committee_id === match[2]);
  return row ? {
    name: cleanSearchText(row.publisher_name, 300),
    aliases: Array.isArray(row.aliases) ? row.aliases : [],
    topic_facets: Array.isArray(row.topic_facets) ? row.topic_facets : [],
  } : null;
}

function identityFor(person, board) {
  const objectRef = communityBoardPersonId(board.id, person.publisher_person_id);
  return objectRef && objectRef === person.id ? objectRef : null;
}

function projectPerson(person, {
  boardLookup = {},
  committeeRegistry = {},
} = {}) {
  const board = boardContext(person.board_id, boardLookup);
  const objectRef = board ? identityFor(person, board) : null;
  const name = cleanSearchText(person.person_name, 500);
  if (!board || !objectRef || !name) {
    return failedSearchProjection("unclassified", "unresolved_grounded_community_board_person_identity", ["object_ref"]);
  }
  const roles = uniqueSearchText(person.roles || [], 80);
  const roleLabels = uniqueSearchText(roles.map((role) => ROLE_LABELS[role] || "Community Board person"), 160);
  const committees = [...(person.committee_refs || [])]
    .map((ref) => committeeContext(ref, committeeRegistry))
    .filter(Boolean);
  const committeeNames = uniqueSearchText([
    ...(person.committee_names || []),
    ...committees.map((committee) => committee.name),
  ], 300);
  const aliases = uniqueSearchText(person.aliases || [], 300);
  const topicFacets = uniqueSearchText(committees.flatMap((committee) => committee.topic_facets || []), 100)
    .map((facet) => facet.toLocaleLowerCase("en-US"));
  const sourceRefs = uniqueSearchText(person.source_observation_refs || [], 240);
  const discoveryRole = roleLabels[0] || "Community Board person";
  const searchText = uniqueSearchText([
    name,
    ...aliases,
    ...roleLabels,
    board.name,
    `Community Board ${board.district}`,
    `${name} ${board.name}`,
    ...committeeNames,
    ...topicFacets,
    "Community Board person",
    "appointed local advisory body",
    board.borough,
    `Community District ${board.district}`,
  ], SEARCH_TEXT_MAX_LENGTH).join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH);
  return admitProjectedSearchDocument({
    object_ref: objectRef,
    object_type: "community-board-person",
    domain: "people",
    canonical_href: communityBoardPageHref(board.id),
    title: name,
    summary: `${discoveryRole} · ${board.name} · Community Board person.`,
    search_text: searchText,
    source_family: "community_board_people",
    source_observation_refs: sourceRefs,
    process_role: roles.join(", ") || null,
    classification: {
      method: "grounded_community_board_person_role_projection",
      basis: "exact publisher person identity qualified by its parent Community Board and promoted role evidence",
    },
    provenance: {
      producer: COMMUNITY_BOARD_PERSON_SEARCH_PRODUCER,
      source_system: "community_board_publisher",
      board_id: board.id,
      board_name: board.name,
      borough: board.borough,
      district: board.district,
      publisher_person_id: person.publisher_person_id,
      reviewed_aliases: aliases,
      role_keys: roles,
      role_labels: roleLabels,
      publisher_committee_names: committeeNames,
      topic_facets: topicFacets,
      institution_label: `${board.name} · Community Board person`,
      institution_context: "Appointed local advisory body",
      parent_labels: [board.name],
      identity_basis: person.identity_basis,
      lifecycle: {
        state: "current",
        observed_on: person.observed_on || null,
      },
      match_fields: {
        display_name: name,
        aliases,
        role_labels: roleLabels,
        board_labels: [board.name, `Community Board ${board.district}`],
        committee_names: committeeNames,
        topic_facets: topicFacets,
      },
    },
  }, "exact_grounded_community_board_person_identity");
}

/** Build one person document per board-qualified publisher identity. */
export function buildCommunityBoardPersonSearchDocuments(lookup = {}, {
  boardLookup = {},
  geography = boardLookup,
  committeeRegistry = {},
} = {}) {
  const rows = peopleRows(lookup);
  const byIdentity = new Map();
  for (const observation of rows) {
    const edge = promoteCommunityBoardPersonRoleEdge(observation);
    if (!edge.promoted) continue;
    const object = communityBoardPersonObject(observation);
    if (!object) continue;
    const key = object.id;
    const existing = byIdentity.get(key) || {
      ...object,
      board_id: observation.board_id,
      roles: new Set(),
      committee_refs: new Set(),
      committee_names: new Set(),
      aliases: new Set(),
      source_observation_refs: new Set(),
      identity_basis: object.identity_basis,
    };
    existing.roles.add(edge.role);
    const committeeRef = [edge.from, edge.to, edge.organization_ref]
      .find((value) => String(value || "").startsWith("community-board-committee:"));
    if (committeeRef) {
      existing.committee_refs.add(committeeRef);
      const committee = committeeContext(committeeRef, committeeRegistry);
      if (committee?.name) existing.committee_names.add(committee.name);
    }
    for (const alias of Array.isArray(observation.aliases) ? observation.aliases : []) existing.aliases.add(alias);
    existing.source_observation_refs.add(sourceReference(edge, boardContext(observation.board_id, geography), object.publisher_person_id));
    byIdentity.set(key, existing);
  }
  if (!rows.length) {
    return unavailableSearchProducerCorpus({
      schema: COMMUNITY_BOARD_PERSON_SEARCH_PRODUCER_SCHEMA,
      producer: COMMUNITY_BOARD_PERSON_SEARCH_PRODUCER,
      objectType: "community-board-person",
      domain: "people",
      reason: "community_board_people_has_no_relationships",
    });
  }
  const outcomes = [...byIdentity.values()]
    .map((person) => projectPerson({
      ...person,
      observed_on: lookup.observed_on || null,
      roles: [...person.roles],
      committee_refs: [...person.committee_refs],
      committee_names: [...person.committee_names],
      aliases: [...person.aliases],
      source_observation_refs: [...person.source_observation_refs],
    }, { boardLookup: geography, committeeRegistry }))
    .sort((left, right) => String(left.document?.object_ref || "").localeCompare(String(right.document?.object_ref || ""), "en-US"));
  return searchProducerCorpus({
    schema: COMMUNITY_BOARD_PERSON_SEARCH_PRODUCER_SCHEMA,
    producer: COMMUNITY_BOARD_PERSON_SEARCH_PRODUCER,
    objectType: "community-board-person",
    domain: "people",
    outcomes: outcomes.map((result) => freezeSearchValue({
      person_id: result.document?.object_ref || null,
      ...result,
    })),
    reasons: {
      matched: "grounded_community_board_people_indexed",
      empty: "community_board_people_has_no_relationships",
      partial: "some_grounded_community_board_people_failed_admission",
      not_indexed: "no_grounded_community_board_people_passed_admission",
    },
  });
}

export function materializeCommunityBoardPersonSearchDocument(person, options = {}) {
  return projectPerson(person, options);
}

// Plural alias mirrors the source artifact's people collection terminology
// while retaining the singular civic object type in every document.
export const buildCommunityBoardPeopleSearchDocuments = buildCommunityBoardPersonSearchDocuments;
export const projectCommunityBoardPersonSearchDocument = materializeCommunityBoardPersonSearchDocument;
