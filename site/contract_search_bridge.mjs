/** Pure adapter from procurement SearchDocuments to Contracts Browse rows. */

import { admitSearchDocument } from "./search_document_contract.mjs";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function requestIdFromRefs(refs) {
  for (const ref of Array.isArray(refs) ? refs : []) {
    const match = clean(ref, 240).match(/^(?:notice|ocp_award|city_record):([A-Za-z0-9_-]{1,80})$/);
    if (match) return match[1];
  }
  return null;
}

function procurementId(document) {
  const id = clean(document?.object_ref, 320);
  return id.startsWith("procurement:") ? id : null;
}

function stagesFor(document, carried) {
  const stages = Array.isArray(carried?.procurement_stages)
    ? carried.procurement_stages.map((stage) => clean(stage, 80)).filter(Boolean)
    : [clean(carried?.primary_stage || document?.process_role, 80)].filter(Boolean);
  return [...new Set(stages)];
}

/** Project a source-independent Browse row. request_id is optional evidence. */
export function contractSearchDocumentToMoneyRow(candidate = {}) {
  if (
    candidate?.outcome !== "indexed"
    || candidate?.object_type !== "procurement"
    || candidate?.domain !== "contracts"
  ) return null;
  const admitted = admitSearchDocument(candidate, { outcome: "indexed" });
  if (!admitted.document) return null;
  const document = admitted.document;
  const id = procurementId(document);
  if (!id) return null;
  const legacyPin = /^procurement:[^:]+$/.test(id) ? id.slice("procurement:".length) : null;
  const carried = document.provenance?.browse_record;
  if (carried != null && (!carried || typeof carried !== "object" || Array.isArray(carried))) return null;
  if (carried?.procurement_id && clean(carried.procurement_id, 320) !== id) return null;
  if (carried?.canonical_href && clean(carried.canonical_href, 600) !== document.canonical_href) return null;
  if (legacyPin && carried?.pin && clean(carried.pin, 160).toUpperCase() !== legacyPin.toUpperCase()) return null;
  const stages = stagesFor(document, carried);
  if (!stages.length) return null;
  const requestId = clean(carried?.request_id, 100) || requestIdFromRefs(document.source_observation_refs);
  const noticeEvidence = Array.isArray(document.provenance?.notice_evidence)
    ? document.provenance.notice_evidence
    : Array.isArray(carried?.notice_evidence) ? carried.notice_evidence : [];
  return Object.freeze({
    procurement_id: id,
    canonical_href: document.canonical_href,
    procurement_stages: Object.freeze(stages),
    primary_stage: clean(carried?.primary_stage || document.process_role, 80) || stages.at(-1),
    source_observation_refs: document.source_observation_refs,
    ...(requestId ? { request_id: requestId } : {}),
    start_date: clean(carried?.start_date, 40) || null,
    agency_name: clean(carried?.agency_name, 240) || null,
    short_title: clean(carried?.short_title, 500) || document.title,
    pin: clean(carried?.pin, 160) || legacyPin,
    contract_id: clean(carried?.contract_id, 160) || null,
    contract_amount: carried?.contract_amount ?? null,
    vendor_name: clean(carried?.vendor_name, 240) || null,
    selection_method_description: clean(carried?.selection_method_description, 240) || null,
    additional_description_1: document.summary,
    notice_evidence: Object.freeze(noticeEvidence),
    source_system: clean(carried?.source_system, 120) || document.source_family,
    source_systems: Object.freeze(Array.isArray(carried?.source_systems) ? carried.source_systems : []),
    search_document: document,
  });
}

/** Add canonical query hits without replacing richer resident rows. */
export function mergeContractSearchRows(baseRows = [], documents = []) {
  const rows = Array.isArray(baseRows) ? [...baseRows] : [];
  const seenCanonicalIds = new Set(rows.map((row) => clean(row?.procurement_id, 320)).filter(Boolean));
  const seenRequestIds = new Set(rows.map((row) => clean(row?.request_id, 100)).filter(Boolean));
  for (const document of Array.isArray(documents) ? documents : []) {
    const row = contractSearchDocumentToMoneyRow(document);
    if (!row || seenCanonicalIds.has(row.procurement_id)) continue;
    if (!row.procurement_id && row.request_id && seenRequestIds.has(row.request_id)) continue;
    seenCanonicalIds.add(row.procurement_id);
    if (row.request_id) seenRequestIds.add(row.request_id);
    rows.push(row);
  }
  return Object.freeze(rows);
}

/** Add canonical rows while retaining every field from a matching City Record row. */
export function mergeCanonicalProcurementBrowseRows(baseRows = [], canonicalRows = []) {
  const rows = Array.isArray(baseRows) ? [...baseRows] : [];
  const indexByRequestId = new Map(rows.map((row, index) => [clean(row?.request_id, 100), index])
    .filter(([id]) => id));
  const seenCanonicalIds = new Set(rows.map((row) => clean(row?.procurement_id, 320)).filter(Boolean));
  for (const canonical of Array.isArray(canonicalRows) ? canonicalRows : []) {
    const id = clean(canonical?.procurement_id, 320);
    if (!id || seenCanonicalIds.has(id)) continue;
    const requestId = clean(canonical?.request_id, 100);
    const existingIndex = requestId ? indexByRequestId.get(requestId) : null;
    if (Number.isInteger(existingIndex)) {
      rows[existingIndex] = Object.freeze({ ...rows[existingIndex], ...canonical });
    } else {
      rows.push(Object.freeze({ ...canonical }));
    }
    seenCanonicalIds.add(id);
  }
  return Object.freeze(rows);
}
