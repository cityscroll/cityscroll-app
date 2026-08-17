/** Canonical Land SearchDocuments from the bounded ZAP project warehouse lookup. */

import { landProjectDisplayTitle } from "./display_title.mjs";
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

export const LAND_SEARCH_PRODUCER_SCHEMA = "cityscroll.land_search_producer.v1";
export const LAND_SEARCH_PRODUCER = "zap_land_use_project_search_document.v1";
export const LAND_SEARCH_READ_MODEL_SCHEMA_VERSION = 1;

export function projectLandSearchDocument(row = {}, { artifact = {} } = {}) {
  if (artifact.schema_version !== LAND_SEARCH_READ_MODEL_SCHEMA_VERSION || artifact.dataset_id !== "hgx4-8ukb") {
    return failedSearchProjection("not_indexed", "unsupported_zap_project_read_model", ["read_model"]);
  }
  const projectId = cleanSearchText(row.project_id, 80);
  if (!projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    return failedSearchProjection("unclassified", "unresolved_zap_project_identity", ["object_ref"]);
  }
  const title = cleanSearchText(landProjectDisplayTitle(row), 500);
  const fields = uniqueSearchText([
    title,
    projectId,
    row.project_name,
    row.public_status,
    row.project_status,
    row.ulurp_numbers,
    row.borough,
    row.community_district,
    row.actions,
    row.current_milestone,
    row.primary_applicant,
  ]);
  return admitProjectedSearchDocument({
    object_ref: `land_use_project:${projectId}`,
    object_type: "land_use_project",
    domain: "zoning",
    canonical_href: `/browse/zoning/#land/${encodeURIComponent(projectId)}`,
    title,
    summary: uniqueSearchText([
      row.borough,
      row.community_district,
      row.public_status,
      row.current_milestone,
    ]).join(" · ") || null,
    search_text: fields.join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH),
    source_family: "nyc_open_data_zap_projects",
    source_observation_refs: [`nyc_open_data:hgx4-8ukb:${projectId}`],
    process_role: cleanSearchText(row.current_milestone, 160) || null,
    classification: {
      method: "publisher_zap_project_id",
      basis: "project_id in the bounded ZAP Open Data warehouse lookup",
    },
    provenance: {
      producer: LAND_SEARCH_PRODUCER,
      dataset_id: artifact.dataset_id,
      source_system: artifact.source,
      materialized_at: artifact.materialized_at || null,
      source_row_key: projectId,
      search_text_fields: fields,
    },
  }, "publisher_zap_project_id");
}

export function buildLandSearchDocuments(artifact = {}) {
  const rows = Array.isArray(artifact?.rows) ? artifact.rows : [];
  if (artifact.schema_version !== LAND_SEARCH_READ_MODEL_SCHEMA_VERSION || artifact.dataset_id !== "hgx4-8ukb") {
    return unavailableSearchProducerCorpus({
      schema: LAND_SEARCH_PRODUCER_SCHEMA,
      producer: LAND_SEARCH_PRODUCER,
      objectType: "land_use_project",
      domain: "zoning",
      reason: "unsupported_zap_project_read_model",
      totalCount: rows.length,
    });
  }
  const outcomes = [...rows]
    .sort((left, right) => String(left?.project_id).localeCompare(String(right?.project_id), "en-US"))
    .map((row) => freezeSearchValue({
      project_id: row?.project_id || null,
      ...projectLandSearchDocument(row, { artifact }),
    }));
  return searchProducerCorpus({
    schema: LAND_SEARCH_PRODUCER_SCHEMA,
    producer: LAND_SEARCH_PRODUCER,
    objectType: "land_use_project",
    domain: "zoning",
    outcomes,
    reasons: {
      matched: "zap_project_read_model_indexed",
      empty: "zap_project_read_model_has_no_entries",
      partial: "some_zap_projects_failed_admission",
      not_indexed: "no_zap_projects_passed_admission",
    },
  });
}
