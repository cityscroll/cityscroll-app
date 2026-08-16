/** Canonical Committee SearchDocuments from the published Legistar committee graph. */

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

export const COMMITTEE_SEARCH_PRODUCER_SCHEMA = "cityscroll.committee_search_producer.v1";
export const COMMITTEE_SEARCH_PRODUCER = "committee_search_document.v1";
const READ_MODEL_SCHEMA = "cityscroll.committee_graph.v1";

function published(lookup) {
  return lookup?.publication === "published" && lookup?.gate?.gate?.publication_allowed === true;
}

function identityFor(node = {}) {
  const id = cleanSearchText(node.id, 160).match(/^committee:(\d+)$/)?.[1] || null;
  const bodyId = cleanSearchText(node.properties?.body_id, 80);
  if (!id || node.type !== "committee" || bodyId !== id) return null;
  return { id, ref: `committee:${id}`, href: `/committees/${encodeURIComponent(id)}/` };
}

function observationsFor(lookup, identity) {
  return (Array.isArray(lookup?.observations) ? lookup.observations : [])
    .filter((row) => row?.committee_id === identity.ref && String(row?.body_id) === identity.id);
}

function evidenceRefs(observations) {
  return uniqueSearchText(observations.map((row) => row?.source_row_hash
    ? `nyc_legistar_office_records:${row.source_row_hash}`
    : null), 240).sort().slice(0, 100);
}

export function projectCommitteeSearchDocument(node = {}, { lookup = {} } = {}) {
  if (lookup.schema !== READ_MODEL_SCHEMA || !published(lookup)) {
    return failedSearchProjection("not_indexed", "committee_graph_not_published", ["publication"]);
  }
  const identity = identityFor(node);
  if (!identity) {
    return failedSearchProjection("unclassified", "unresolved_exact_committee_identity", ["object_ref"]);
  }
  const title = cleanSearchText(node.name, 500);
  if (!title || cleanSearchText(node.properties?.body_name, 500) !== title) {
    return failedSearchProjection("unclassified", "inconsistent_committee_name", ["title"]);
  }
  const observations = observationsFor(lookup, identity);
  const refs = evidenceRefs(observations);
  if (!refs.length) {
    return failedSearchProjection("not_indexed", "missing_committee_source_observation", ["source_observation_refs"]);
  }
  const subject = title.replace(/^(?:standing\s+)?committee\s+on\s+/i, "").trim();
  const aliases = uniqueSearchText([
    subject && `${subject} Committee`,
    `New York City Council ${title}`,
  ]);
  const starts = observations.map((row) => cleanSearchText(row.valid_from, 20)).filter(Boolean).sort();
  const ends = observations.map((row) => cleanSearchText(row.valid_to, 20)).filter(Boolean).sort();

  return admitProjectedSearchDocument({
    object_ref: identity.ref,
    object_type: "committee",
    domain: "meetings",
    canonical_href: identity.href,
    title,
    summary: "New York City Council committee.",
    search_text: uniqueSearchText([title, ...aliases, "New York City Council"])
      .join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH),
    source_family: "nyc_legistar_committee_graph",
    source_observation_refs: refs,
    process_role: null,
    classification: {
      method: "canonical_committee_graph",
      basis: "exact Legistar OfficeRecordBodyId in the published committee graph",
    },
    provenance: {
      producer: COMMITTEE_SEARCH_PRODUCER,
      read_model_schema: lookup.schema,
      read_model_generated_at: lookup.generated_at || null,
      publisher_body_id: identity.id,
      parent_labels: ["New York City Council"],
      aliases,
      lifecycle: {
        earliest_observed_start: starts[0] || null,
        latest_observed_end: ends.at(-1) || null,
        open_ended_membership_observation: observations.some((row) => !cleanSearchText(row.valid_to, 20)),
      },
      source: node.provenance || null,
    },
  }, "exact_legistar_committee_identity");
}

export function buildCommitteeSearchDocuments(lookup = {}) {
  const nodes = Array.isArray(lookup?.nodes) ? lookup.nodes : [];
  if (lookup.schema !== READ_MODEL_SCHEMA || !published(lookup)) {
    return unavailableSearchProducerCorpus({
      schema: COMMITTEE_SEARCH_PRODUCER_SCHEMA,
      producer: COMMITTEE_SEARCH_PRODUCER,
      objectType: "committee",
      domain: "meetings",
      reason: lookup.schema === READ_MODEL_SCHEMA
        ? "committee_graph_not_published"
        : "unsupported_committee_read_model",
      totalCount: nodes.length,
    });
  }
  const outcomes = nodes
    .filter((node) => node?.type === "committee")
    .sort((left, right) => String(left.id).localeCompare(String(right.id), "en-US"))
    .map((node) => freezeSearchValue({
      committee_id: node.id,
      ...projectCommitteeSearchDocument(node, { lookup }),
    }));
  return searchProducerCorpus({
    schema: COMMITTEE_SEARCH_PRODUCER_SCHEMA,
    producer: COMMITTEE_SEARCH_PRODUCER,
    objectType: "committee",
    domain: "meetings",
    outcomes,
    reasons: {
      matched: "published_committee_graph_indexed",
      empty: "published_committee_graph_has_no_committees",
      partial: "some_committee_nodes_failed_admission",
      not_indexed: "no_committee_nodes_passed_admission",
    },
  });
}
