/** Canonical SearchDocuments for retained public consultation rounds. */
import { materializeConsultations } from "./consultation_acquisition.mjs";
import { CONSULTATION_PILOT_SEEDS } from "./consultation_publisher_adapters.mjs";
import { admitProjectedSearchDocument, cleanSearchText, freezeSearchValue, searchProducerCorpus, unavailableSearchProducerCorpus, uniqueSearchText } from "./search_producer_support.mjs";

export const CONSULTATION_SEARCH_PRODUCER_SCHEMA = "cityscroll.consultation_search_producer.v1";
export const CONSULTATION_SEARCH_PRODUCER = "public_consultation_search_document.v1";
export const CONSULTATION_SEARCH_OBJECT_TYPE = "consultation";
export const CONSULTATION_SEARCH_DOMAIN = "participation";

function sourceRefs(record) {
  return uniqueSearchText([
    ...(record.sources || []).map((source) => source.observation || source.id || source.url),
    ...(record.channels || []).map((channel) => channel.id || channel.url),
  ], 240).map((ref) => `consultation:${ref}`);
}

export function projectConsultationSearchDocument(record = {}) {
  const id = cleanSearchText(record.id, 160);
  const title = cleanSearchText(record.title, 500);
  const refs = sourceRefs(record);
  if (!id || !title) return { outcome: "unclassified", document: null, reason: "unresolved_consultation_identity" };
  if (!refs.length) return { outcome: "not_indexed", document: null, reason: "missing_consultation_source_observation" };
  const geography = record.geography?.labels || [record.place];
  const deadline = record.deadline?.value ? `deadline ${record.deadline.value}` : "no response date published";
  const lifecycle = record.deadline?.historical ? "closed" : "current";
  const fields = uniqueSearchText([title, record.category, record.organizer, record.purpose, ...geography, deadline]);
  return admitProjectedSearchDocument({
    object_ref: `consultation:${id}`, object_type: CONSULTATION_SEARCH_OBJECT_TYPE, domain: CONSULTATION_SEARCH_DOMAIN,
    canonical_href: `/consultations/${encodeURIComponent(id)}/`, title,
    summary: [record.organizer, geography.filter(Boolean).join(", "), deadline].filter(Boolean).join(" · "),
    search_text: fields.join(" "), source_family: "retained_public_consultations", source_observation_refs: refs,
    classification: { method: "canonical_consultation_round", basis: "retained organizer-linked consultation round identity" },
    provenance: {
      producer: CONSULTATION_SEARCH_PRODUCER, source_system: "retained consultation materialization",
      source_freshness: { generated_at: record.observed_at || null }, lifecycle: { state: lifecycle, deadline: record.deadline || null },
      consultation: { organizer: record.organizer || null, geography, category: record.category || null }, search_text_fields: fields,
    },
  }, "retained_consultation_round");
}

const DEFAULT_CONSULTATIONS = Object.freeze([
  ...materializeConsultations().consultations,
  ...CONSULTATION_PILOT_SEEDS.filter((record) => ["cb14-community-budget-fy2028", "bloomingdale-library-and-housing"].includes(record.id)),
]);

const INDEXED_CONSULTATION_IDS = new Set([
  "dot-fast-buses-central-brooklyn",
  "dot-secure-bike-parking",
  "cb14-community-budget-fy2028",
  "bloomingdale-library-and-housing",
]);

function mergeFirstWinsConsultationOutcome(kept, incoming) {
  if (!kept?.document || !incoming?.document) return kept;
  const mergedRefs = uniqueSearchText([
    ...(kept.document.source_observation_refs || []),
    ...(incoming.document.source_observation_refs || []),
  ], 240);
  return freezeSearchValue({
    ...kept,
    document: {
      ...kept.document,
      source_observation_refs: mergedRefs,
    },
  });
}

export function buildConsultationSearchDocuments(records = DEFAULT_CONSULTATIONS) {
  const rows = Array.isArray(records) ? records : [];
  if (!rows.length) return unavailableSearchProducerCorpus({ schema: CONSULTATION_SEARCH_PRODUCER_SCHEMA, producer: CONSULTATION_SEARCH_PRODUCER, objectType: CONSULTATION_SEARCH_OBJECT_TYPE, domain: CONSULTATION_SEARCH_DOMAIN, reason: "consultation_materialization_empty" });
  // First outcome for an identity wins its public fields; later duplicate rows
  // contribute only their source/channel references onto that retained document.
  const keptIndexByRef = new Map();
  const outcomes = [];
  for (const record of rows.filter((row) => INDEXED_CONSULTATION_IDS.has(row?.id))) {
    const outcome = freezeSearchValue(projectConsultationSearchDocument(record));
    const objectRef = outcome.document?.object_ref;
    if (!objectRef) {
      outcomes.push(outcome);
      continue;
    }
    if (!keptIndexByRef.has(objectRef)) {
      keptIndexByRef.set(objectRef, outcomes.length);
      outcomes.push(outcome);
      continue;
    }
    const index = keptIndexByRef.get(objectRef);
    outcomes[index] = mergeFirstWinsConsultationOutcome(outcomes[index], outcome);
  }
  return searchProducerCorpus({ schema: CONSULTATION_SEARCH_PRODUCER_SCHEMA, producer: CONSULTATION_SEARCH_PRODUCER, objectType: CONSULTATION_SEARCH_OBJECT_TYPE, domain: CONSULTATION_SEARCH_DOMAIN, outcomes, reasons: { matched: "retained_consultation_rounds_indexed", empty: "consultation_materialization_has_no_rounds", partial: "some_consultation_rounds_failed_admission", not_indexed: "no_consultation_round_passed_admission" } });
}
