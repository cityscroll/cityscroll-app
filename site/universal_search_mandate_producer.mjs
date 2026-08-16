/**
 * SearchDocuments for first-class enacted-law mandates.
 *
 * This producer accepts only the independent law-mandate lookup. A notice may
 * be retained as evidence for a warranted mandate, but it cannot create or
 * classify one.
 */

import {
  AGENCY_OBLIGATIONS_CERTIFICATION,
  AGENCY_OBLIGATIONS_METHOD,
  AGENCY_OBLIGATIONS_SCHEMA,
} from "./agency_obligations.mjs";
import { mandateObjectTarget, noticeEvidenceTarget } from "./notice_object_links.mjs";
import { SEARCH_DOCUMENT_SCHEMA, admitSearchDocument } from "./search_document_contract.mjs";

export const UNIVERSAL_SEARCH_MANDATE_PRODUCER_SCHEMA =
  "cityscroll.universal_search_mandate_producer.v1";
export const UNIVERSAL_SEARCH_MANDATE_PRODUCER =
  "universal_search_mandate_producer.v1";

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function immutableCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(immutableCopy));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, immutableCopy(nested)]),
  ));
}

function validLookup(lookup) {
  return lookup?.schema === AGENCY_OBLIGATIONS_SCHEMA
    && lookup?.method === AGENCY_OBLIGATIONS_METHOD
    && lookup?.certification_basis === AGENCY_OBLIGATIONS_CERTIFICATION
    && lookup?.by_agency
    && typeof lookup.by_agency === "object"
    && !Array.isArray(lookup.by_agency);
}

function lookupRows(lookup) {
  return Object.values(lookup.by_agency).flatMap((bucket) => (
    Array.isArray(bucket?.obligations) ? bucket.obligations : []
  ));
}

function omittedUnmatchedCount(lookup, materializedCount) {
  const total = Number(lookup?.summary?.obligation_count);
  const matched = Number(lookup?.summary?.matched_obligation_count);
  const unmatched = Number(lookup?.summary?.unmatched_obligation_count);
  if (
    !Number.isSafeInteger(total)
    || !Number.isSafeInteger(matched)
    || !Number.isSafeInteger(unmatched)
    || total < 0
    || matched !== materializedCount
    || unmatched < 0
    || total !== matched + unmatched
  ) return 0;
  return unmatched;
}

function certifiedQuote(row) {
  return row?.certification?.status === "auto_certified"
    && row.certification.basis === AGENCY_OBLIGATIONS_CERTIFICATION
    && row.certification.quote_verified === true;
}

function matterId(row) {
  const direct = clean(row?.matter_id, 80);
  const source = clean(row?.source?.matter_id, 80);
  const id = direct || source;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) return null;
  if (direct && source && direct !== source) return null;
  return id;
}

function noticeEvidence(row) {
  const raw = Array.isArray(row?.notice_evidence_refs) ? row.notice_evidence_refs : [];
  const targets = [];
  const seen = new Set();
  for (const value of raw) {
    const match = clean(value, 100).match(/^notice:([A-Za-z0-9_-]{1,80})$/i);
    if (!match) continue;
    const target = noticeEvidenceTarget(match[1]);
    const ref = target ? `notice:${target.id}` : null;
    if (!target || seen.has(ref)) continue;
    seen.add(ref);
    targets.push({ ref, href: target.href });
  }
  return targets;
}

function candidateFor(row, target, lawMatterId) {
  const evidence = noticeEvidence(row);
  const duty = clean(row.duty_text || row.required_action || row.expected_event, 700);
  const agency = clean(row.agency_name || row.agency_id || row.subject_name || row.subject_id, 200);
  const citation = clean(row.citation || row.source?.citation, 240);
  const deliverable = clean(row.deliverable_type || row.observation?.expected_event, 160);
  const recurrence = clean(row.recurrence, 80);
  const deadlineText = clean(row.deadline?.text || row.deadline_text, 300);
  const deadlineDate = clean(row.deadline?.computed_date || row.deadline_date, 40);
  const fileNumber = clean(row.file_number || row.source?.file_number, 80);
  const lawNumber = clean(row.law_number_display || row.source?.law_number_display, 80);
  const legistarHref = clean(row.source?.legistar_url || row.source_href, 600);
  const lawTextHref = clean(row.source?.law_text_url, 600);

  return {
    schema: SEARCH_DOCUMENT_SCHEMA,
    object_ref: `mandate:${target.id}`,
    object_type: "mandate",
    domain: "mandates",
    canonical_href: target.href,
    title: duty,
    summary: [agency, citation].filter(Boolean).join(" · ") || null,
    search_text: [
      duty,
      agency,
      deliverable,
      citation,
      fileNumber,
      lawNumber,
      recurrence,
      deadlineText,
      deadlineDate,
      lawMatterId,
    ].filter(Boolean).join(" "),
    source_family: "enacted_law_mandate",
    source_observation_refs: [`law:${lawMatterId}`],
    process_role: deliverable || null,
    classification: {
      method: "law_derived_mandate_projection",
      basis: "enacted_law_lookup+deontic_object_gate+quote_verification",
    },
    provenance: {
      producer: UNIVERSAL_SEARCH_MANDATE_PRODUCER,
      law_matter_id: lawMatterId,
      citation: citation || null,
      file_number: fileNumber || null,
      law_number_display: lawNumber || null,
      legistar_href: legistarHref || null,
      law_text_href: lawTextHref || null,
      certification: {
        status: row.certification.status,
        basis: row.certification.basis,
        quote_verified: true,
      },
      notice_evidence_refs: evidence.map(({ ref }) => ref),
      evidence_hrefs: evidence.map(({ href }) => href),
    },
  };
}

function projectionEnvelope({ documents = [], sourceCount = 0, reasons = {}, lookup = null, reason = null }) {
  const indexedCount = documents.length;
  const notIndexedCount = Object.values(reasons).reduce((sum, count) => sum + count, 0);
  const state = reason
    ? "not_indexed"
    : sourceCount === 0
      ? "empty"
      : indexedCount === 0
        ? "not_indexed"
        : notIndexedCount > 0
          ? "partial"
          : "matched";
  return immutableCopy({
    schema: UNIVERSAL_SEARCH_MANDATE_PRODUCER_SCHEMA,
    source_schema: lookup?.schema || null,
    generated_at: lookup?.generated_at || null,
    as_of: lookup?.as_of || null,
    source_receipt: lookup?.source_receipt || null,
    documents,
    coverage: {
      state,
      counts: {
        source: sourceCount,
        indexed: indexedCount,
        not_indexed: notIndexedCount,
      },
      not_indexed_reasons: reasons,
      ...(reason ? { reason } : {}),
    },
  });
}

/**
 * Project an enacted-law mandate lookup into validated SearchDocuments.
 * Rows that fail quote certification or the existing mandate object gate remain
 * explicit in coverage and never reach the search admission boundary.
 */
export function projectMandateSearchDocuments(lookup = {}) {
  if (!validLookup(lookup)) {
    return projectionEnvelope({ reason: "invalid_law_mandate_lookup" });
  }

  const rows = lookupRows(lookup);
  const documents = [];
  const seen = new Set();
  const reasons = Object.create(null);
  const reject = (reason) => {
    reasons[reason] = (reasons[reason] || 0) + 1;
  };
  const omitted = omittedUnmatchedCount(lookup, rows.length);
  if (omitted) reasons.subject_not_resolved = omitted;

  for (const row of rows) {
    if (!certifiedQuote(row)) {
      reject("quote_not_verified");
      continue;
    }
    const lawMatterId = matterId(row);
    const target = lawMatterId ? mandateObjectTarget(row) : null;
    if (!target) {
      reject("mandate_gate_failed");
      continue;
    }
    const objectRef = `mandate:${target.id}`;
    if (seen.has(objectRef)) {
      reject("duplicate_object_ref");
      continue;
    }
    const admitted = admitSearchDocument(candidateFor(row, target, lawMatterId), {
      outcome: "indexed",
    });
    if (!admitted.document) {
      reject("search_document_contract_failed");
      continue;
    }
    seen.add(objectRef);
    documents.push(admitted.document);
  }

  return projectionEnvelope({
    documents,
    sourceCount: rows.length + omitted,
    reasons: Object.fromEntries(Object.entries(reasons).sort(([left], [right]) => left.localeCompare(right))),
    lookup,
  });
}
