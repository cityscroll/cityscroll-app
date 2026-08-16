/** Canonical Parcel SearchDocuments from the exact-BBL property graph. */

import { bblReaderLabel } from "./bbl_reader.mjs";
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

export const PARCEL_SEARCH_PRODUCER_SCHEMA = "cityscroll.parcel_search_producer.v1";
export const PARCEL_SEARCH_PRODUCER = "parcel_search_document.v1";
const READ_MODEL_VERSION = "property_cross_domain_v1";
const EXACT_BBL_METHOD = "exact_bbl_v1";

function exactReadModel(crossDomain) {
  return crossDomain?.schema_version === 1
    && crossDomain?.version === READ_MODEL_VERSION
    && Array.isArray(crossDomain?.provenance?.methods)
    && crossDomain.provenance.methods.includes(EXACT_BBL_METHOD);
}

function identityFor(bblValue, row = {}) {
  const bbl = cleanSearchText(bblValue, 20);
  if (!/^\d{10}$/.test(bbl) || row.bbl !== bbl || row.parcel_ref !== `bbl:${bbl}`) return null;
  // `no_zap_match` is still an exact parcel identity; it describes the land
  // join's empty result and must not demote the source BBL to a possible match.
  if (row.status && !["matched", "observed", "no_zap_match"].includes(row.status)) return null;
  return { bbl, ref: `bbl:${bbl}`, href: `/parcels/${bbl}/` };
}

function residentRowsFor(snapshot, bbl) {
  return (Array.isArray(snapshot?.properties) ? snapshot.properties : []).filter((row) => (
    (row?.property_location?.bbls || []).includes(bbl)
    || (row?.property_location?.addresses || []).some((address) => address?.bbl === bbl)
    || (row?.disposition_join_keys || []).includes(`bbl:${bbl}`)
  ));
}

function addressLabels(row, residentRows) {
  return uniqueSearchText([
    ...(row?.ll48?.items || []).flatMap((item) => [item?.address, item?.label]),
    ...residentRows.flatMap((item) => (item?.property_location?.addresses || [])
      .filter((address) => address?.bbl === row.bbl)
      .map((address) => [address.label, address.borough].filter(Boolean).join(", "))),
  ]);
}

function sourceObservationRefs(row, residentRows) {
  return uniqueSearchText([
    ...(row?.property_notices || []).map((item) => item?.request_id ? `notice:${item.request_id}` : null),
    ...(row?.land_projects || []).map((item) => item?.project_id ? `project:${item.project_id}` : null),
    ...(row?.ll48?.items || []).map((item) => item?.provenance?.source_record_id || item?.id),
    ...residentRows.map((item) => item?.request_id ? `notice:${item.request_id}` : null),
  ], 240).slice(0, 100);
}

export function projectParcelSearchDocument(bbl, row = {}, options = {}) {
  const crossDomain = options.crossDomain || {};
  if (!exactReadModel(crossDomain)) {
    return failedSearchProjection("not_indexed", "unverified_parcel_read_model", ["read_model"]);
  }
  const identity = identityFor(bbl, row);
  if (!identity) {
    return failedSearchProjection("unclassified", "unresolved_exact_parcel_identity", ["object_ref"]);
  }
  const residents = residentRowsFor(options.residentSnapshot, identity.bbl);
  const addresses = addressLabels(row, residents);
  const projectIds = uniqueSearchText((row.land_projects || []).map((item) => item?.project_id), 80);
  const propertyIds = uniqueSearchText([
    ...(row.property_notices || []).map((item) => item?.request_id),
    ...residents.flatMap((item) => item?.disposition_join_keys || []),
  ], 160);
  const refs = sourceObservationRefs(row, residents);
  if (!refs.length) {
    return failedSearchProjection("not_indexed", "missing_parcel_source_observation", ["source_observation_refs"]);
  }
  const readerLabel = bblReaderLabel(identity.bbl);
  const title = addresses[0] || readerLabel;
  const linked = projectIds.length || propertyIds.length || (row.ll48?.items || []).length;
  const matchStates = linked ? ["exact", "verified"] : ["exact"];

  return admitProjectedSearchDocument({
    object_ref: identity.ref,
    object_type: "parcel",
    domain: "property",
    canonical_href: identity.href,
    title,
    summary: readerLabel,
    search_text: uniqueSearchText([
      title,
      readerLabel,
      identity.bbl,
      ...addresses,
      ...projectIds,
      ...propertyIds,
      ...residents.map((item) => item.short_title),
    ]).join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH),
    source_family: "property_cross_domain_exact_bbl",
    source_observation_refs: refs,
    process_role: null,
    classification: {
      method: "canonical_exact_bbl",
      basis: "ten-digit BBL with exact_bbl_v1 materialization; possible address matches excluded",
    },
    provenance: {
      producer: PARCEL_SEARCH_PRODUCER,
      read_model_version: crossDomain.version,
      read_model_generated_at: crossDomain.generated_at || null,
      resident_snapshot_generated_at: options.residentSnapshot?.generated_at || null,
      identity: { method: EXACT_BBL_METHOD, bbl: identity.bbl },
      match_states: matchStates,
      address_labels: addresses,
      linked_project_ids: projectIds,
      linked_property_ids: propertyIds,
      source_freshness: {
        property_feed: crossDomain.provenance?.property_feed?.source_generated_at || null,
        graph: crossDomain.generated_at || null,
      },
      coverage: crossDomain.coverage || {},
    },
  }, "exact_bbl_identity");
}

export function buildParcelSearchDocuments(crossDomain = {}, options = {}) {
  const rows = crossDomain?.by_bbl && typeof crossDomain.by_bbl === "object"
    && !Array.isArray(crossDomain.by_bbl)
    ? Object.entries(crossDomain.by_bbl)
    : [];
  if (!exactReadModel(crossDomain) || !crossDomain.by_bbl || Array.isArray(crossDomain.by_bbl)) {
    return unavailableSearchProducerCorpus({
      schema: PARCEL_SEARCH_PRODUCER_SCHEMA,
      producer: PARCEL_SEARCH_PRODUCER,
      objectType: "parcel",
      domain: "property",
      reason: "unverified_parcel_read_model",
      totalCount: rows.length,
    });
  }
  const outcomes = rows
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([bbl, row]) => freezeSearchValue({
      bbl,
      ...projectParcelSearchDocument(bbl, row, { ...options, crossDomain }),
    }));
  return searchProducerCorpus({
    schema: PARCEL_SEARCH_PRODUCER_SCHEMA,
    producer: PARCEL_SEARCH_PRODUCER,
    objectType: "parcel",
    domain: "property",
    outcomes,
    reasons: {
      matched: "exact_bbl_parcel_corpus_indexed",
      empty: "exact_bbl_parcel_corpus_has_no_entries",
      partial: "some_parcel_entries_failed_admission",
      not_indexed: "no_parcel_entries_passed_admission",
    },
  });
}
