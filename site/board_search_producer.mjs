/** Canonical Community Board SearchDocuments from the constellation registry. */

import { SEARCH_TEXT_MAX_LENGTH } from "./search_document_contract.mjs";
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
    summary: `${identity.borough} Community District ${identity.district}.`,
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
