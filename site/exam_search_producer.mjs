/** Canonical Civil Service Exam SearchDocuments from staffing_exams.json. */

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

export const EXAM_SEARCH_PRODUCER_SCHEMA = "cityscroll.exam_search_producer.v1";
export const EXAM_SEARCH_PRODUCER = "civil_service_exam_search_document.v1";
export const EXAM_SEARCH_READ_MODEL_SCHEMA_VERSION = 6;
const ADMINISTERING_AGENCY = "Department of Citywide Administrative Services";

function identityFor(row = {}) {
  const examNumber = cleanSearchText(row.exam_number, 20);
  return /^\d{4}$/.test(examNumber) ? {
    examNumber,
    ref: `exam:${examNumber}`,
    href: `/exams/${encodeURIComponent(examNumber)}/`,
  } : null;
}

export function projectExamSearchDocument(row = {}, { artifact = {} } = {}) {
  if (artifact.schema_version !== EXAM_SEARCH_READ_MODEL_SCHEMA_VERSION) {
    return failedSearchProjection("not_indexed", "unsupported_staffing_exam_read_model", ["read_model"]);
  }
  const identity = identityFor(row);
  if (!identity) {
    return failedSearchProjection("unclassified", "unresolved_civil_service_exam_identity", ["object_ref"]);
  }
  const title = cleanSearchText(row.title, 500);
  if (!title) return failedSearchProjection("not_indexed", "missing_exam_title", ["title"]);
  const sourceIds = uniqueSearchText(row.sources, 160);
  if (!sourceIds.length) {
    return failedSearchProjection("not_indexed", "missing_exam_source_observation", ["source_observation_refs"]);
  }
  const refs = sourceIds.map((source) => `${source}:exam:${identity.examNumber}`).slice(0, 100);
  const schedule = uniqueSearchText([
    row.schedule_status,
    row.application_start,
    row.application_end,
    row.application_mode,
    row.filing_method,
  ]);
  const searchFields = uniqueSearchText([
    title,
    identity.examNumber,
    row.title_code,
    row.title_code_family,
    ADMINISTERING_AGENCY,
    "DCAS",
    row.eligibility,
    row.interest_area,
    ...schedule,
  ]);

  return admitProjectedSearchDocument({
    object_ref: identity.ref,
    object_type: "civil_service_exam",
    domain: "staffing",
    canonical_href: identity.href,
    title,
    summary: schedule.length ? schedule.join(" · ") : null,
    search_text: searchFields.join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH),
    source_family: "dcas_staffing_exams",
    source_observation_refs: refs,
    process_role: null,
    classification: {
      method: "canonical_staffing_exam",
      basis: "publisher exam number in the versioned staffing exam read model",
    },
    provenance: {
      producer: EXAM_SEARCH_PRODUCER,
      read_model_schema_version: artifact.schema_version,
      administering_agency: ADMINISTERING_AGENCY,
      source_freshness: {
        generated_at: artifact.generated_at || null,
        data_current_as_of: artifact.data_current_as_of || null,
      },
      source_catalog: (artifact.sources || []).filter((source) => sourceIds.includes(source?.id)),
      lifecycle: {
        schedule_status: cleanSearchText(row.schedule_status, 80) || "unknown",
        application_start: cleanSearchText(row.application_start, 20) || null,
        application_end: cleanSearchText(row.application_end, 20) || null,
        eligibility: cleanSearchText(row.eligibility, 80) || null,
      },
      search_text_fields: searchFields,
    },
  }, "publisher_exam_number");
}

export function buildExamSearchDocuments(artifact = {}) {
  const exams = Array.isArray(artifact?.exams) ? artifact.exams : [];
  if (artifact.schema_version !== EXAM_SEARCH_READ_MODEL_SCHEMA_VERSION) {
    return unavailableSearchProducerCorpus({
      schema: EXAM_SEARCH_PRODUCER_SCHEMA,
      producer: EXAM_SEARCH_PRODUCER,
      objectType: "civil_service_exam",
      domain: "staffing",
      reason: "unsupported_staffing_exam_read_model",
      totalCount: exams.length,
    });
  }
  const outcomes = [...exams]
    .sort((left, right) => String(left?.exam_number).localeCompare(String(right?.exam_number), "en-US"))
    .map((row) => freezeSearchValue({
      exam_number: row?.exam_number || null,
      ...projectExamSearchDocument(row, { artifact }),
    }));
  return searchProducerCorpus({
    schema: EXAM_SEARCH_PRODUCER_SCHEMA,
    producer: EXAM_SEARCH_PRODUCER,
    objectType: "civil_service_exam",
    domain: "staffing",
    outcomes,
    reasons: {
      matched: "staffing_exam_read_model_indexed",
      empty: "staffing_exam_read_model_has_no_entries",
      partial: "some_exam_entries_failed_admission",
      not_indexed: "no_exam_entries_passed_admission",
    },
  });
}
