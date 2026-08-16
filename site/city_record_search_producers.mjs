/**
 * City Record syntax adapters for canonical civic-object search producers.
 *
 * Publisher sections select an upstream producer; they never assign a search
 * type. Procurement identity comes from the notice-object projection's exact
 * identifier gate. Rules identity comes from the bounded Rules read model and
 * its City Record stage builder. Search admission happens only after one of
 * those object projections succeeds.
 */

import {
  noticeEvidenceTarget,
  projectNoticeObjectTarget,
} from "./notice_object_links.mjs";
import { cityRecordRuleStageRecord } from "./rule_stage.mjs";
import {
  SEARCH_DOCUMENT_SCHEMA,
  SEARCH_TEXT_MAX_LENGTH,
  admitSearchDocument,
} from "./search_document_contract.mjs";

export const CITY_RECORD_SEARCH_PRODUCER_SCHEMA = "cityscroll.city_record_search_producer.v1";

const RULE_STAGE_TO_PROCESS_ROLE = Object.freeze({
  proposed: "proposal",
  "comment-open": "public_process",
  hearing: "public_process",
  "comment-closed": "public_process",
  adopted: "adoption",
  effective: "effective",
});

function compactText(values, max) {
  return values
    .map((value) => String(value ?? "").replace(/<[^>]*>/g, " "))
    .join(" ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function requestId(row) {
  const id = compactText([
    row?.request_id || row?.requestId || row?.notice_id,
  ], 100).replace(/^notice:/i, "");
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function ruleProjectionRow(row) {
  const id = requestId(row);
  const evidenceSchema = compactText([row?.rule_evidence?.schema], 160);
  const sourceSystem = compactText([row?.source_system], 80).toLowerCase();
  if (
    !id
    || sourceSystem !== "city_record"
    || evidenceSchema !== "cityscroll.rule_evidence_stamp.v1"
  ) return null;
  return row;
}

/** Index only rows already admitted by the canonical bounded Rules projection. */
export function buildCityRecordRuleProjectionIndex(snapshot = {}) {
  const rows = Array.isArray(snapshot) ? snapshot : snapshot?.rows;
  const index = new Map();
  for (const candidate of Array.isArray(rows) ? rows : []) {
    const row = ruleProjectionRow(candidate);
    if (!row) continue;
    index.set(requestId(row), row);
  }
  return index;
}

function ruleObjectProjection(observation, ruleIndex) {
  const id = requestId(observation);
  const projected = id && ruleIndex instanceof Map ? ruleIndex.get(id) : null;
  if (!projected) return null;

  // Stage semantics remain owned by the existing City Record Rules builder.
  // A rule-evidence lifecycle stamp fills only the builder's explicit unknown.
  const stageRecord = cityRecordRuleStageRecord(projected);
  const evidenceStage = compactText([projected.rule_evidence?.lifecycle_status], 80).toLowerCase();
  const stage = stageRecord?.stage
    || ({ proposal: "proposed", adoption: "adopted", effective: "effective" }[evidenceStage])
    || null;
  return {
    object_ref: `rulemaking:notice:${id}`,
    object_type: "rulemaking",
    domain: "rules",
    canonical_href: `/browse/rules/?q=${encodeURIComponent(id)}`,
    process_role: RULE_STAGE_TO_PROCESS_ROLE[stage] || null,
  };
}

function procurementObjectProjection(observation) {
  const projection = projectNoticeObjectTarget({
    ...observation,
    section_name: observation?.section_name || observation?.section,
    type_of_notice_description:
      observation?.type_of_notice_description || observation?.notice_type,
    description: observation?.description || observation?.snippet,
  });
  if (
    projection.state !== "matched"
    || !["procurement", "contract"].includes(projection.target?.kind)
  ) return null;
  const id = compactText([projection.target.id], 160);
  if (!id) return null;
  return {
    object_ref: id.startsWith("procurement:") ? id : `procurement:${id}`,
    object_type: "procurement",
    domain: "contracts",
    canonical_href: projection.target.href,
    process_role: "award",
  };
}

/**
 * Resolve a notice observation to a canonical procurement or rule object.
 * Every miss retains an explicit evidence-only receipt.
 */
export function projectCityRecordSearchObject(observation = {}, { ruleIndex = new Map() } = {}) {
  const id = requestId(observation);
  const evidence = noticeEvidenceTarget(id);
  if (!evidence) {
    return Object.freeze({
      schema: CITY_RECORD_SEARCH_PRODUCER_SCHEMA,
      outcome: "not_indexed",
      producer: null,
      object: null,
      evidence_refs: Object.freeze([]),
      evidence_hrefs: Object.freeze([]),
      receipt: Object.freeze({ reason: "invalid_notice_identity" }),
    });
  }

  const procurement = procurementObjectProjection(observation);
  if (procurement) {
    return Object.freeze({
      schema: CITY_RECORD_SEARCH_PRODUCER_SCHEMA,
      outcome: "indexed",
      producer: "city_record_procurement_object",
      object: Object.freeze(procurement),
      evidence_refs: Object.freeze([`notice:${id}`]),
      evidence_hrefs: Object.freeze([evidence.href]),
      receipt: Object.freeze({
        reason: "stable_procurement_identifier",
        projection: "cityscroll.notice_object_link.v1",
      }),
    });
  }

  const rule = ruleObjectProjection(observation, ruleIndex);
  if (rule) {
    return Object.freeze({
      schema: CITY_RECORD_SEARCH_PRODUCER_SCHEMA,
      outcome: "indexed",
      producer: "city_record_rule_object",
      object: Object.freeze(rule),
      evidence_refs: Object.freeze([`notice:${id}`]),
      evidence_hrefs: Object.freeze([evidence.href]),
      receipt: Object.freeze({
        reason: "materialized_rule_projection",
        projection: "site/data/rules_domain_observations.json",
      }),
    });
  }

  return Object.freeze({
    schema: CITY_RECORD_SEARCH_PRODUCER_SCHEMA,
    outcome: "evidence_only",
    producer: null,
    object: null,
    evidence_refs: Object.freeze([`notice:${id}`]),
    evidence_hrefs: Object.freeze([evidence.href]),
    receipt: Object.freeze({ reason: "no_canonical_procurement_or_rule_projection" }),
  });
}

function attachmentEvidenceRefs(observation, id) {
  const refs = [];
  for (const attachment of Array.isArray(observation?.attachments) ? observation.attachments : []) {
    if (attachment?.text_status !== "extracted" && attachment?.tables_status !== "extracted") continue;
    const documentId = compactText([attachment?.document_id], 80);
    if (!documentId || !/^[A-Za-z0-9._:-]{1,80}$/.test(documentId)) continue;
    refs.push(`attachment:${id}:${documentId}`);
  }
  return [...new Set(refs)];
}

/** Produce an admitted SearchDocument after canonical object classification. */
export function materializeCityRecordSearchDocument(observation = {}, options = {}) {
  const produced = projectCityRecordSearchObject(observation, options);
  if (produced.outcome === "not_indexed") return null;

  const id = requestId(observation);
  const title = compactText([
    observation.title || observation.short_title || `Notice ${id}`,
  ], 500);
  const summary = compactText([
    observation.snippet || observation.description,
    observation.additional_description_1,
  ], 1_200) || null;
  const attachmentText = compactText([observation.attachment_text], SEARCH_TEXT_MAX_LENGTH);
  const attachmentTablesText = compactText(
    [observation.attachment_tables_text],
    SEARCH_TEXT_MAX_LENGTH,
  );
  const searchText = compactText([
    title,
    summary,
    observation.additional_description_2,
    observation.additional_description_3,
    attachmentText,
    attachmentTablesText,
    observation.haystack,
  ], SEARCH_TEXT_MAX_LENGTH) || title;
  const searchTextSources = [
    "notice",
    ...(attachmentText ? ["attachment_text"] : []),
    ...(attachmentTablesText ? ["attachment_tables_text"] : []),
  ];
  const attachmentRefs = attachmentEvidenceRefs(observation, id);
  const evidenceOnly = produced.outcome === "evidence_only";
  const object = evidenceOnly ? {
    object_ref: `notice:${id}`,
    object_type: "unclassified",
    domain: null,
    canonical_href: produced.evidence_hrefs[0],
    process_role: null,
  } : produced.object;
  const classificationMethod = evidenceOnly
    ? "fail_closed"
    : produced.producer === "city_record_rule_object"
      ? "canonical_rule_projection"
      : "canonical_procurement_projection";

  const admitted = admitSearchDocument({
    schema: SEARCH_DOCUMENT_SCHEMA,
    ...object,
    title,
    summary,
    search_text: searchText,
    source_family: "city_record_notice",
    source_observation_refs: produced.evidence_refs,
    classification: {
      method: classificationMethod,
      basis: produced.receipt.projection
        ? `${produced.receipt.projection}:${produced.receipt.reason}`
        : produced.receipt.reason,
    },
    provenance: {
      producer: "city_record_search_document.v1",
      object_producer: produced.producer,
      projection_receipt: produced.receipt,
      evidence_hrefs: produced.evidence_hrefs,
      search_text_sources: searchTextSources,
      attachment_evidence_refs: attachmentRefs,
    },
  }, { outcome: produced.outcome });
  if (!admitted.document) return null;
  return Object.freeze({
    ...admitted.document,
    outcome: admitted.outcome,
    coverage_state: "matched",
  });
}
