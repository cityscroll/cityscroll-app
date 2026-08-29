/** SearchDocument projection over the observation-fed procurement read model. */

import { procurementCanonicalHref } from "./procurement_object_contract.mjs";
import {
  coverageInputFromProcurement,
  mapPublisherMethodFamily,
} from "./procurement_coverage_labels.mjs";
import { SHARED_PROCUREMENT_READ_MODEL_SCHEMA } from "./shared_procurement_read_model.mjs";
import {
  SEARCH_DOCUMENT_SCHEMA,
  SEARCH_TEXT_MAX_LENGTH,
  admitSearchDocument,
} from "./search_document_contract.mjs";
import { snapshotsForPublicAmount } from "./checkbook_passport_corroboration.mjs";

export const PROCUREMENT_SEARCH_PRODUCER_SCHEMA = "cityscroll.procurement_search_producer.v1";

const ROLE_ORDER = Object.freeze([
  "solicitation", "bid_opening_result", "intent_to_negotiate", "vendor_list", "intent_to_award",
  "award", "pending", "registered", "payment", "contract", "unknown",
]);

function clean(value, max = 500) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function first(rows, fields, max = 500) {
  for (const row of rows) {
    for (const field of fields) {
      const value = clean(row?.[field], max);
      if (value) return value;
    }
  }
  return null;
}

function numeric(rows, fields) {
  const value = first(rows, fields, 80);
  if (!value) return null;
  const number = Number(String(value).replace(/[$,]/g, ""));
  return Number.isFinite(number) ? number : null;
}

function observationIndex(readModel) {
  return new Map((Array.isArray(readModel?.observations) ? readModel.observations : [])
    .map((observation) => [observation?.source_observation_ref, observation]));
}

function orderedObservations(object, index) {
  const observations = (object?.source_observation_refs || [])
    .map((ref) => index.get(ref))
    .filter(Boolean);
  const priority = new Map([
    ["city_record", 0], ["passport_public_contracts", 1], ["passport_public_rfx", 2],
    ["checkbook_nycha_contracts", 3], ["checkbook_contracts", 4], ["checkbook_spending", 5],
    ["nys_contract_reporter", 6], ["mta_current_opportunities", 7], ["mta_bid_results", 8],
    ["mta_annual_contracts", 9], ["mta_cd_awards", 10],
  ]);
  return observations.sort((left, right) => (
    (priority.get(left.source_system) ?? 9) - (priority.get(right.source_system) ?? 9)
    || left.source_observation_ref.localeCompare(right.source_observation_ref)
  ));
}

function noticeEvidence(observations) {
  return observations.filter((entry) => entry.source_system === "city_record").map((entry) => {
    const row = entry.snapshot || {};
    return Object.freeze({
      request_id: clean(row.request_id || entry.source_system_id, 100),
      type_of_notice_description: clean(row.type_of_notice_description || row.type_of_notice, 120) || null,
      short_title: clean(row.short_title || row.title, 500) || null,
      additional_description_1: clean(row.additional_description_1 || row.description, 1_200) || null,
      contact_name: clean(row.contact_name, 240) || null,
      start_date: clean(row.start_date, 40) || null,
      href: `/notices/${encodeURIComponent(clean(row.request_id || entry.source_system_id, 100))}`,
    });
  }).filter((entry) => entry.request_id);
}

function stagesFor(object) {
  return (Array.isArray(object?.stages) ? object.stages : [])
    .map((entry) => clean(entry?.stage, 80))
    .filter(Boolean);
}

function processRole(stages) {
  return [...stages].sort((left, right) => (
    ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right) || left.localeCompare(right)
  )).at(-1) || null;
}

function coverageFields(object, observations) {
  const input = coverageInputFromProcurement(object, observations);
  const methodFamily = input.method_family || mapPublisherMethodFamily(input.publisher_method);
  return {
    ...(methodFamily ? { method_family: methodFamily } : {}),
    ...(input.procurement_category ? { procurement_category: input.procurement_category } : {}),
    ...(input.coverage_state && input.coverage_state !== "not_checked"
      ? { coverage_state: input.coverage_state }
      : {}),
  };
}

function browseRecord(object, observations, stages, evidence, facts) {
  const requestId = evidence.length === 1 ? evidence[0].request_id : null;
  const entityRefs = new Set();
  for (const observation of observations) {
    const row = observation.snapshot || {};
    for (const ref of Array.isArray(row.entity_refs_all) ? row.entity_refs_all : []) {
      if (typeof ref === "string" && ref.trim()) entityRefs.add(ref.trim());
    }
    if (row.procuring_institution_id) entityRefs.add(`agency:id:${row.procuring_institution_id}`);
    if (row.mta_parent_institution_id) entityRefs.add(`agency:id:${row.mta_parent_institution_id}`);
  }
  return Object.freeze({
    procurement_id: object.procurement_id,
    canonical_href: procurementCanonicalHref(object),
    procurement_stages: Object.freeze([...stages]),
    primary_stage: processRole(stages),
    source_observation_refs: Object.freeze([...object.source_observation_refs]),
    ...(requestId ? { request_id: requestId } : {}),
    start_date: facts.startDate,
    end_date: facts.endDate,
    agency_id: first(observations.map((entry) => entry.snapshot || {}), ["agency_id", "procuring_institution_id"], 200),
    agency_name: facts.agency,
    short_title: facts.title,
    pin: object.identity_keys?.epins?.[0] || null,
    contract_id: object.identity_keys?.contract_ids?.[0] || null,
    ...(object.identity_keys?.contract_reporter_numbers?.[0]
      ? { contract_reporter_number: object.identity_keys.contract_reporter_numbers[0] } : {}),
    ...(object.identity_keys?.solicitation_ids?.[0]
      ? { solicitation_id: object.identity_keys.solicitation_ids[0] } : {}),
    ...(object.identity_keys?.event_ids?.[0]
      ? { event_id: object.identity_keys.event_ids[0] } : {}),
    contract_amount: facts.amount,
    vendor_name: facts.vendor,
    official_url: first(observations.map((entry) => entry.snapshot || {}), ["official_url", "source_url"], 600),
    selection_method_description: facts.method,
    notice_evidence: Object.freeze(evidence),
    source_systems: Object.freeze([...new Set(observations.map((entry) => entry.source_system))]),
    ...(entityRefs.size ? { entity_refs_all: Object.freeze([...entityRefs].sort()) } : {}),
    ...coverageFields(object, observations),
  });
}

export function materializeProcurementSearchDocument(object = {}, readModel = {}) {
  if (object?.object_type !== "procurement" || !clean(object?.procurement_id, 320)) return null;
  if (!Array.isArray(object.source_observation_refs) || !object.source_observation_refs.length) return null;
  const observations = orderedObservations(object, observationIndex(readModel));
  if (!observations.length || observations.length !== object.source_observation_refs.length) return null;
  const rows = observations.map((entry) => entry.snapshot || {});
  const evidence = noticeEvidence(observations);
  const contractId = object.identity_keys?.contract_ids?.[0] || null;
  const epin = object.identity_keys?.epins?.[0] || null;
  const stages = stagesFor(object);
  const facts = {
    title: first(rows, ["short_title", "title", "description"], 500)
      || `Contract ${contractId || epin || object.procurement_id}`,
    agency: first(rows, ["agency_name", "agency"], 240),
    vendor: first(rows, ["vendor_name", "vendor", "prime_vendor", "payee_name"], 240),
    amount: numeric(
      snapshotsForPublicAmount(object, observations),
      ["contract_amount", "award_amount", "current_amount", "current", "amount", "check_amount"],
    ),
    startDate: first(rows, ["start_date", "award_date", "start", "registered", "registration_date", "issue_date", "date"], 40),
    endDate: first(rows, ["end_date", "end", "contract_end_date", "due_date", "closing_date", "opening_date"], 40),
    method: first(rows, ["selection_method_description", "procurement_method"], 240),
    program: first(rows, ["program"], 240),
    industry: first(rows, ["industry"], 120),
  };
  const summary = [facts.agency, facts.vendor, facts.amount == null ? null : `$${facts.amount.toLocaleString("en-US")}`]
    .filter(Boolean).join(" · ") || null;
  const searchText = clean([
    facts.title, summary, contractId, epin,
    object.identity_keys?.contract_reporter_numbers?.[0],
    object.identity_keys?.solicitation_ids?.[0], object.identity_keys?.event_ids?.[0],
    facts.method, facts.program, facts.industry, ...stages,
    ...evidence.map((entry) => entry.additional_description_1),
  ].filter(Boolean).join(" "), SEARCH_TEXT_MAX_LENGTH);
  const admitted = admitSearchDocument({
    schema: SEARCH_DOCUMENT_SCHEMA,
    object_ref: object.procurement_id,
    object_type: "procurement",
    domain: "contracts",
    canonical_href: procurementCanonicalHref(object),
    title: facts.title,
    summary,
    search_text: searchText,
    source_family: "shared_procurement_read_model",
    source_observation_refs: object.source_observation_refs,
    process_role: processRole(stages),
    classification: {
      method: "canonical_procurement_projection",
      basis: "observation-fed object with accepted exact identity edges",
    },
    provenance: {
      producer: "shared_procurement_search_document.v1",
      read_model_schema: SHARED_PROCUREMENT_READ_MODEL_SCHEMA,
      source_systems: [...new Set(observations.map((entry) => entry.source_system))],
      source_receipts: observations.map((entry) => ({
        source_observation_ref: entry.source_observation_ref,
        ingested_at: entry.ingested_at,
      })),
      notice_evidence: evidence,
      browse_record: browseRecord(object, observations, stages, evidence, facts),
      lifecycle: object.lifecycle,
      alias_object_refs: [...new Set([...(object.identity_keys?.epins || []).map((id) => `procurement:${id}`)])],
    },
  });
  return admitted.document ? Object.freeze({
    ...admitted.document,
    outcome: admitted.outcome,
    coverage_state: "matched",
  }) : null;
}

export function buildProcurementSearchDocuments(readModel = {}) {
  const rows = readModel?.schema === SHARED_PROCUREMENT_READ_MODEL_SCHEMA && Array.isArray(readModel.rows)
    ? readModel.rows : [];
  const documents = [];
  const seen = new Set();
  let notIndexed = 0;
  let duplicates = 0;
  for (const object of rows) {
    if (seen.has(object?.procurement_id)) {
      duplicates += 1;
      continue;
    }
    if (object?.procurement_id) seen.add(object.procurement_id);
    const document = materializeProcurementSearchDocument(object, readModel);
    if (document) documents.push(document);
    else notIndexed += 1;
  }
  const coverage = Object.freeze(Object.fromEntries(Object.entries(readModel?.sources || {}).map(([source, envelope]) => [
    source,
    Object.freeze({
      source_system: source,
      status: envelope?.status || "unavailable",
      available: envelope?.status === "available",
      generated_at: envelope?.generated_at || null,
      reason: envelope?.reason || null,
      source_row_count: envelope?.row_count ?? null,
    }),
  ])));
  return Object.freeze({
    schema: PROCUREMENT_SEARCH_PRODUCER_SCHEMA,
    generated_at: readModel?.generated_at || null,
    documents: Object.freeze(documents),
    coverage,
    counts: Object.freeze({ total: documents.length, not_indexed: notIndexed, exact_duplicates: duplicates }),
  });
}
