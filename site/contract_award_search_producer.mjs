/** Canonical procurement-award SearchDocuments from the complete OCP award materialization. */

import { procurementObjectTarget } from "./notice_object_links.mjs";
import { rankSearchDocuments, SEARCH_TEXT_MAX_LENGTH } from "./search_document_contract.mjs";
import {
  admitProjectedSearchDocument,
  cleanSearchText,
  failedSearchProjection,
  freezeSearchValue,
  searchProducerCorpus,
  unavailableSearchProducerCorpus,
  uniqueSearchText,
} from "./search_producer_support.mjs";

export const CONTRACT_AWARD_SEARCH_PRODUCER_SCHEMA = "cityscroll.contract_award_search_producer.v1";
export const CONTRACT_AWARD_SEARCH_PRODUCER = "contract_award_search_document.v1";
const OCP_LOOKUP_SCHEMA_VERSION = 1;
const OCP_SOURCE = "ocp-recent-contract-awards";
const OCP_DATASET_ID = "qyyg-4tf5";
const OCP_TABLE_NAME = "ocp_recent_contract_awards";
const CONTRACT_CONCEPT_TERMS = new Set(["award", "awards", "contract", "contracts", "procurement"]);
const SEARCHABLE_ROW_CACHE = new WeakMap();

function requestId(value) {
  const id = cleanSearchText(value, 100);
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

function procurementIdentifier(value) {
  const id = cleanSearchText(value, 160).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{5,79}$/.test(id) || !/\d/.test(id)) return null;
  if (/^(?:N\/?A|NONE|UNKNOWN|NOINFOFOUND|NOPINFOUND|NOTAVAILABLE|TBD)$/.test(id)) return null;
  return id;
}

function supportedLookup(lookup) {
  return lookup?.schema_version === OCP_LOOKUP_SCHEMA_VERSION
    && (
      lookup?.source === OCP_SOURCE
      || (lookup?.dataset_id === OCP_DATASET_ID && lookup?.table_name === OCP_TABLE_NAME)
    )
    && Array.isArray(lookup?.rows);
}

function evidenceFor(options, id) {
  const source = options?.evidenceByRequestId;
  if (source instanceof Map) return source.get(id) ?? null;
  if (source && typeof source === "object" && !Array.isArray(source)) return source[id] ?? null;
  return null;
}

function latestRow(rows) {
  return [...rows].sort((left, right) => (
    String(right?.start_date || "").localeCompare(String(left?.start_date || ""))
    || String(right?.request_id || "").localeCompare(String(left?.request_id || ""))
  ))[0] || {};
}

function browseRecord(row, pin) {
  return freezeSearchValue({
    request_id: requestId(row?.request_id),
    start_date: cleanSearchText(row?.start_date, 40) || null,
    agency_name: cleanSearchText(row?.agency_name, 240) || null,
    type_of_notice_description: "Award",
    short_title: cleanSearchText(row?.short_title, 500) || null,
    pin,
    contract_amount: cleanSearchText(row?.contract_amount, 80) || null,
    vendor_name: cleanSearchText(row?.vendor_name, 240) || null,
    source_system: OCP_SOURCE,
  });
}

function summaryFor(row) {
  const parts = [
    cleanSearchText(row?.agency_name, 240),
    cleanSearchText(row?.vendor_name, 240),
    cleanSearchText(row?.contract_amount, 80),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Project one exact OCP contract identity. Evidence enrichment is optional metadata. */
export function projectContractAwardSearchDocument(row = {}, options = {}) {
  if (cleanSearchText(row?.type_of_notice_description, 80).toLowerCase() !== "award") {
    return failedSearchProjection("unsupported", "source_row_is_not_an_award", ["type_of_notice_description"]);
  }
  const pin = procurementIdentifier(row?.pin);
  if (!pin) {
    return failedSearchProjection("not_indexed", "missing_stable_procurement_identifier", ["pin"]);
  }
  const rows = (Array.isArray(options.relatedRows) ? options.relatedRows : [row])
    .filter((candidate) => procurementIdentifier(candidate?.pin) === pin);
  const selected = latestRow(rows.length ? rows : [row]);
  const ids = uniqueSearchText(rows.map((candidate) => requestId(candidate?.request_id)), 100);
  if (!ids.length) {
    return failedSearchProjection("not_indexed", "missing_source_observation_identity", ["request_id"]);
  }
  const target = procurementObjectTarget(pin);
  if (!target) {
    return failedSearchProjection("not_indexed", "canonical_procurement_route_unavailable", ["canonical_href"]);
  }
  const title = cleanSearchText(selected?.short_title, 500);
  if (!title) return failedSearchProjection("not_indexed", "missing_award_title", ["title"]);

  const evidence = ids.map((id) => evidenceFor(options, id)).filter(Boolean);
  const evidenceMetadata = evidence.length === 0 ? null : evidence.length === 1 ? evidence[0] : evidence;
  const searchText = uniqueSearchText([
    ...rows.map((candidate) => candidate?.short_title),
    pin,
    ...rows.map((candidate) => candidate?.agency_name),
    ...rows.map((candidate) => candidate?.vendor_name),
    ...rows.map((candidate) => candidate?.contract_amount),
    "contract award",
  ], SEARCH_TEXT_MAX_LENGTH).join(" ").slice(0, SEARCH_TEXT_MAX_LENGTH);

  return admitProjectedSearchDocument({
    object_ref: `procurement:${pin}`,
    object_type: "procurement",
    domain: "contracts",
    canonical_href: target.href,
    title,
    summary: summaryFor(selected),
    search_text: searchText,
    source_family: OCP_SOURCE,
    source_observation_refs: ids.map((id) => `ocp_award:${id}`),
    process_role: "award",
    classification: {
      method: "exact_ocp_procurement_identifier",
      basis: "OCP award row with one stable publisher PIN",
    },
    provenance: {
      producer: CONTRACT_AWARD_SEARCH_PRODUCER,
      read_model_schema_version: options.lookup?.schema_version ?? null,
      read_model_source: options.lookup?.source || OCP_SOURCE,
      source_dataset_id: options.lookup?.dataset_id || OCP_DATASET_ID,
      source_table_name: options.lookup?.table_name || OCP_TABLE_NAME,
      read_model_materialized_at: options.lookup?.materialized_at || null,
      source_record_ids: ids,
      evidence_metadata: evidenceMetadata,
      browse_record: browseRecord(selected, pin),
    },
  }, "stable_ocp_procurement_identifier");
}

function groupedRows(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const pin = procurementIdentifier(row?.pin);
    const key = pin ? `pin:${pin}` : `unresolved:${index}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.values()];
}

/** Materialize the supplied OCP corpus with explicit partial-coverage receipts. */
export function buildContractAwardSearchDocuments(lookup = {}, options = {}) {
  if (!supportedLookup(lookup)) {
    return unavailableSearchProducerCorpus({
      schema: CONTRACT_AWARD_SEARCH_PRODUCER_SCHEMA,
      producer: CONTRACT_AWARD_SEARCH_PRODUCER,
      objectType: "procurement",
      domain: "contracts",
      reason: "unsupported_ocp_award_read_model",
      totalCount: Array.isArray(lookup?.rows) ? lookup.rows.length : 0,
    });
  }
  const outcomes = groupedRows(lookup.rows).map((rows) => freezeSearchValue({
    source_request_ids: rows.map((row) => requestId(row?.request_id)).filter(Boolean),
    ...projectContractAwardSearchDocument(rows[0], {
      ...options,
      lookup,
      relatedRows: rows,
    }),
  }));
  return searchProducerCorpus({
    schema: CONTRACT_AWARD_SEARCH_PRODUCER_SCHEMA,
    producer: CONTRACT_AWARD_SEARCH_PRODUCER,
    objectType: "procurement",
    domain: "contracts",
    outcomes,
    reasons: {
      empty: "ocp_award_read_model_has_no_entries",
      matched: "ocp_award_read_model_indexed",
      partial: "some_ocp_awards_lack_stable_contract_identity",
      not_indexed: "no_ocp_awards_admitted",
    },
  });
}

function queryParts(query) {
  const normalized = cleanSearchText(query, 240).toLowerCase();
  return {
    normalized,
    terms: normalized.split(/\s+/).filter(Boolean),
  };
}

function rowText(row) {
  return [
    row?.pin,
    row?.short_title,
    row?.agency_name,
    row?.vendor_name,
    row?.contract_amount,
    row?.type_of_notice_description,
  ].map((value) => cleanSearchText(value, 500).toLowerCase()).filter(Boolean).join(" ");
}

function searchableRows(lookup) {
  let rows = SEARCHABLE_ROW_CACHE.get(lookup);
  if (!rows) {
    rows = lookup.rows.map((row) => ({ row, text: rowText(row) }));
    SEARCHABLE_ROW_CACHE.set(lookup, rows);
  }
  return rows;
}

function rawScore(row, query) {
  const pin = cleanSearchText(row?.pin, 160).toLowerCase();
  const title = cleanSearchText(row?.short_title, 500).toLowerCase();
  const agency = cleanSearchText(row?.agency_name, 240).toLowerCase();
  const vendor = cleanSearchText(row?.vendor_name, 240).toLowerCase();
  if (pin === query) return 1_000;
  if (title === query) return 900;
  if (title.startsWith(query)) return 750;
  if (title.includes(query)) return 650;
  if (vendor.includes(query)) return 500;
  if (agency.includes(query)) return 400;
  return 100;
}

/** Query the complete retained OCP award corpus before SearchDocument admission. */
export function searchContractAwardDocuments(lookup = {}, query = "", { limit = 40, ...options } = {}) {
  const { normalized, terms } = queryParts(query);
  if (!supportedLookup(lookup) || !normalized || !terms.length) {
    return buildContractAwardSearchDocuments(supportedLookup(lookup) ? { ...lookup, rows: [] } : lookup, options);
  }
  const candidateLimit = Math.max(Number(limit) || 40, 1) * 4;
  const lexicalTerms = terms.filter((term) => !CONTRACT_CONCEPT_TERMS.has(term));
  const candidates = lexicalTerms.length
    ? searchableRows(lookup).filter(({ text }) => lexicalTerms.every((term) => text.includes(term)))
    : searchableRows(lookup).slice(-candidateLimit);
  const matched = candidates
    .map(({ row }) => ({ row, score: rawScore(row, normalized) }))
    .sort((left, right) => (
      right.score - left.score
      || String(right.row?.start_date || "").localeCompare(String(left.row?.start_date || ""))
      || String(left.row?.request_id || "").localeCompare(String(right.row?.request_id || ""))
    ))
    .slice(0, candidateLimit)
    .map(({ row }) => row);
  const corpus = buildContractAwardSearchDocuments({ ...lookup, rows: matched }, options);
  if (!corpus.documents.length) return corpus;
  const ranked = rankSearchDocuments(corpus.documents, (document) => rawScore({
    pin: document.object_ref.replace(/^procurement:/, ""),
    short_title: document.title,
    agency_name: document.provenance?.browse_record?.agency_name,
    vendor_name: document.provenance?.browse_record?.vendor_name,
  }, normalized))
    .slice(0, Math.max(Number(limit) || 40, 1))
    .map((document) => ({ ...document, outcome: "indexed", coverage_state: "matched" }));
  return freezeSearchValue({ ...corpus, documents: ranked });
}
