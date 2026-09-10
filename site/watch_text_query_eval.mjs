/**
 * Shared precise-watch evaluation over an admitted field projection.
 *
 * Every supported procurement renderer (D1 notices, CROL-negative snapshot
 * rows, previews that reuse those materializations) calls this scan so
 * inclusion, exclusion, and field evidence cannot drift by adapter. Candidate
 * retrieval may over-fetch; the v1 predicate in `watch_text_query.mjs` decides
 * membership, and that decision is applied before the displayed or delivered
 * limit. Ranking and new publishers are out of scope.
 */

import {
  explainTextQuery,
  matchesTextQuery,
  textQueryCandidateTermGroups,
} from "./watch_text_query.mjs";

export const PROCUREMENT_TEXT_QUERY_EVAL = Object.freeze({
  schema: "cityscroll.watch_text_query_eval.v1",
  resultLimit: 25,
  scanBudget: 500,
  pageSize: 100,
});

export const TEXT_QUERY_EVAL_STATUS = Object.freeze({
  complete: "complete",
  incomplete: "incomplete",
  unavailable: "unavailable",
});

/** Notice-backed rows: title + cleaned description. Structured facets stay filters. */
export function projectProcurementNoticeFields(row = {}) {
  return [
    { name: "title", value: row.short_title || row.title || null },
    { name: "description", value: row.additional_description_1 || row.description || null },
  ];
}

/**
 * Procurement objects without a City Record notice: published title, agency,
 * vendor, and identifiers as *separate* fields so a phrase cannot be
 * manufactured by concatenating them. Identity remains procurement_id.
 */
export function projectProcurementObjectFields(row = {}) {
  return [
    { name: "title", value: row.short_title || row.title || null },
    { name: "agency", value: row.agency_name || row.agency || null },
    { name: "vendor", value: row.vendor_name || row.vendor || null },
    { name: "pin", value: row.pin || null },
    { name: "contract_id", value: row.contract_id || null },
    { name: "procurement_id", value: row.procurement_id || null },
  ];
}

export function procurementRecordIdentity(row = {}) {
  return row.request_id || row.procurement_id || row.digest_id || null;
}

export function comparePublicationThenId(left, right) {
  const dateL = String(left?.start_date || "").slice(0, 10);
  const dateR = String(right?.start_date || "").slice(0, 10);
  const byDate = dateR.localeCompare(dateL);
  if (byDate) return byDate;
  return String(procurementRecordIdentity(left) || "").localeCompare(String(procurementRecordIdentity(right) || ""));
}

function namedValues(namedFields) {
  return namedFields.map((field) => field?.value);
}

export function decideProcurementTextQuery(row, expression, projectFields) {
  const named = projectFields(row);
  const evidence = explainTextQuery(named, expression);
  return {
    match: evidence.match,
    identity: procurementRecordIdentity(row),
    evidence,
    fields: named,
  };
}

/**
 * Scan already-projected records: sort by publication date then id, apply the
 * v1 predicate, and take `limit` *accepted* rows. Hitting `scanBudget` before
 * the source is exhausted returns `incomplete` plus a continuation. Missing
 * records are `unavailable`, not a completed empty set. `markSeenIds` contains
 * only accepted identities — unseen (unscanned) candidates are never listed.
 */
export function evaluateProjectedRecords(records, {
  expression,
  projectFields,
  limit = PROCUREMENT_TEXT_QUERY_EVAL.resultLimit,
  scanBudget = PROCUREMENT_TEXT_QUERY_EVAL.scanBudget,
  cursor = null,
  clock = null,
} = {}) {
  if (!Array.isArray(records)) {
    return {
      status: TEXT_QUERY_EVAL_STATUS.unavailable,
      reason: "missing_materialization",
      rows: [],
      scanned: 0,
      continuation: null,
      markSeenIds: [],
      clock,
      candidate_term_groups: textQueryCandidateTermGroups(expression),
    };
  }

  const ordered = [...records].sort(comparePublicationThenId);
  const accepted = [];
  let scanned = 0;
  const startOffset = Number.isInteger(cursor?.offset) && cursor.offset > 0 ? cursor.offset : 0;

  for (let index = startOffset; index < ordered.length; index += 1) {
    const row = ordered[index];
    if (scanned >= scanBudget) {
      return {
        status: TEXT_QUERY_EVAL_STATUS.incomplete,
        reason: "scan_budget",
        rows: accepted,
        scanned,
        continuation: { offset: index, scanned },
        markSeenIds: accepted.map(procurementRecordIdentity).filter(Boolean),
        clock,
        candidate_term_groups: textQueryCandidateTermGroups(expression),
      };
    }
    scanned += 1;
    const decision = decideProcurementTextQuery(row, expression, projectFields);
    if (!decision.match) continue;
    accepted.push({
      ...row,
      text_query_evidence: decision.evidence,
    });
    if (accepted.length >= limit) break;
  }

  const exhausted = startOffset + scanned >= ordered.length;
  const filled = accepted.length >= limit;
  return {
    status: exhausted || filled ? TEXT_QUERY_EVAL_STATUS.complete : TEXT_QUERY_EVAL_STATUS.incomplete,
    reason: exhausted || filled ? null : "scan_budget",
    rows: accepted,
    scanned,
    continuation: exhausted || filled ? null : { offset: startOffset + scanned, scanned },
    markSeenIds: accepted.map(procurementRecordIdentity).filter(Boolean),
    clock,
    candidate_term_groups: textQueryCandidateTermGroups(expression),
  };
}

export function evaluateNoticeRecords(records, options) {
  return evaluateProjectedRecords(records, {
    ...options,
    projectFields: projectProcurementNoticeFields,
  });
}

export function evaluateProcurementObjectRecords(records, options) {
  return evaluateProjectedRecords(records, {
    ...options,
    projectFields: projectProcurementObjectFields,
  });
}

export function recordMatchesProcurementTextQuery(row, expression, projectFields) {
  return matchesTextQuery(namedValues(projectFields(row)), expression);
}

/**
 * Records that satisfy every required group but are rejected by an exclusion.
 * Used by the optional preview disclosure; never attached to delivered digests.
 */
export function collectExcludedProjectedRecords(records, {
  expression,
  projectFields,
  limit = 8,
  scanBudget = PROCUREMENT_TEXT_QUERY_EVAL.scanBudget,
} = {}) {
  if (!Array.isArray(records)) {
    return { status: TEXT_QUERY_EVAL_STATUS.unavailable, rows: [], scanned: 0 };
  }
  const ordered = [...records].sort(comparePublicationThenId);
  const excluded = [];
  let scanned = 0;
  for (const row of ordered) {
    if (scanned >= scanBudget || excluded.length >= limit) break;
    scanned += 1;
    const decision = decideProcurementTextQuery(row, expression, projectFields);
    if (decision.match) continue;
    if (!decision.evidence?.exclusion) continue;
    if (decision.evidence.groups?.length && decision.evidence.groups.some((group) => !group)) continue;
    excluded.push({
      ...row,
      text_query_evidence: decision.evidence,
    });
  }
  return {
    status: TEXT_QUERY_EVAL_STATUS.complete,
    rows: excluded,
    scanned,
  };
}

export function collectExcludedNoticeRecords(records, options) {
  return collectExcludedProjectedRecords(records, {
    ...options,
    projectFields: projectProcurementNoticeFields,
  });
}
