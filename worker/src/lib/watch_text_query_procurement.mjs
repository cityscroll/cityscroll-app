/**
 * Procurement adapter for precise-watch evaluation.
 *
 * Scheduled digests keep using buildNoticesQuery (LIKE), never searchNotices/FTS.
 * Candidate SQL may over-fetch with a conservative token superset; the shared
 * v1 predicate in site/watch_text_query.mjs decides membership before the
 * result limit. CROL-negative snapshot rows keep procurement_id. Preview and
 * digest reads consume these owned materializations only — no publisher fetch.
 */

import { compileSub_d1, toDigestRow } from "./compile_d1.mjs";
import { buildNoticesQuery, isFtsUnavailable } from "./notices.mjs";
import {
  matchProcurementDigestRows,
  stampDigestIdentity,
  unionMoneyDigestRows,
  PROCUREMENT_DIGEST_LIMIT,
} from "../../../site/procurement_digest_compile.mjs";
import {
  PROCUREMENT_TEXT_QUERY_EVAL,
  TEXT_QUERY_EVAL_STATUS,
  decideProcurementTextQuery,
  evaluateNoticeRecords,
  projectProcurementNoticeFields,
  projectProcurementObjectFields,
} from "../../../site/watch_text_query_eval.mjs";
import {
  textQueryCandidateTermGroups,
  textQueryEvaluationSupported,
} from "../../../site/watch_text_query.mjs";

export const PRECISE_PROCUREMENT_ADAPTER = Object.freeze({
  notices: "d1-notices-like",
  snapshot: "procurement-snapshot",
  combined: "d1-notices-like+procurement-snapshot",
  unavailable: "unavailable",
});

function digestRowsFromD1(rows, postFilter) {
  let mapped = (Array.isArray(rows) ? rows : []).map(toDigestRow).map(stampDigestIdentity);
  if (typeof postFilter === "function") mapped = mapped.filter(postFilter);
  return mapped;
}

async function queryNoticePage(db, opts) {
  const { sql, params } = buildNoticesQuery(opts);
  const res = await db.prepare(sql).bind(...params).all();
  return res.results ?? res ?? [];
}

/**
 * Page the D1 notices mirror with structured filters plus a conservative
 * LIKE superset, then apply the shared predicate before the result limit.
 * Uses buildNoticesQuery only (the digest path); FTS is never consulted.
 */
export async function evaluateD1NoticeTextQuery(db, {
  opts,
  postFilter,
  expression,
  limit = PROCUREMENT_TEXT_QUERY_EVAL.resultLimit,
  scanBudget = PROCUREMENT_TEXT_QUERY_EVAL.scanBudget,
  pageSize = PROCUREMENT_TEXT_QUERY_EVAL.pageSize,
  cursor = null,
  clock = null,
} = {}) {
  if (!db) {
    return {
      status: TEXT_QUERY_EVAL_STATUS.unavailable,
      reason: "missing_materialization",
      adapter: PRECISE_PROCUREMENT_ADAPTER.unavailable,
      retrieval: "none",
      rows: [],
      scanned: 0,
      continuation: null,
      markSeenIds: [],
      clock,
    };
  }

  const pageLimit = Math.max(1, Math.min(pageSize, 100));
  let offset = Number.isInteger(cursor?.offset) && cursor.offset > 0 ? cursor.offset : 0;
  const collected = [];
  let scanned = 0;
  let exhausted = false;
  let retrieval = "legacy_like";

  try {
    while (scanned < scanBudget) {
      const take = Math.min(pageLimit, scanBudget - scanned);
      const pageOpts = {
        ...opts,
        termGroups: textQueryCandidateTermGroups(expression),
        orderBy: opts?.orderBy || "start_date",
        stablePaging: true,
        limit: take,
        offset,
      };
      const page = await queryNoticePage(db, pageOpts);
      if (!page.length) {
        exhausted = true;
        break;
      }
      collected.push(...page);
      scanned += page.length;
      offset += page.length;
      if (page.length < take) {
        exhausted = true;
        break;
      }
      const mappedSoFar = digestRowsFromD1(collected, postFilter);
      const acceptedSoFar = evaluateNoticeRecords(mappedSoFar, {
        expression,
        limit,
        scanBudget: mappedSoFar.length,
        clock,
      });
      if (acceptedSoFar.rows.length >= limit) break;
    }
  } catch (error) {
    if (isFtsUnavailable(error)) {
      retrieval = "legacy_like_fts_absent";
    } else {
      return {
        status: TEXT_QUERY_EVAL_STATUS.unavailable,
        reason: "d1_unavailable",
        adapter: PRECISE_PROCUREMENT_ADAPTER.unavailable,
        retrieval: "none",
        rows: [],
        scanned,
        continuation: null,
        markSeenIds: [],
        clock,
        error: String(error?.message || error),
      };
    }
  }

  const mapped = digestRowsFromD1(collected, postFilter);
  const evaluated = evaluateNoticeRecords(mapped, {
    expression,
    limit,
    scanBudget: mapped.length,
    clock,
  });
  const hitBudget = !exhausted && scanned >= scanBudget && evaluated.rows.length < limit;
  return {
    ...evaluated,
    status: hitBudget ? TEXT_QUERY_EVAL_STATUS.incomplete : evaluated.status,
    reason: hitBudget ? "scan_budget" : evaluated.reason,
    adapter: PRECISE_PROCUREMENT_ADAPTER.notices,
    retrieval,
    scanned,
    continuation: hitBudget ? { offset, scanned } : evaluated.continuation,
    clock,
  };
}

export async function evaluateMoneyTextQueryWatch({
  db = null,
  snapshot = null,
  sub,
  todayISO,
  limit = PROCUREMENT_DIGEST_LIMIT,
  scanBudget = PROCUREMENT_TEXT_QUERY_EVAL.scanBudget,
  cursor = null,
  clock = null,
  fetchImpl = null,
} = {}) {
  void fetchImpl; // owned materializations only; never a publisher fetch
  const expression = sub?.filter?.text_query;
  if (expression == null) {
    return {
      status: TEXT_QUERY_EVAL_STATUS.unavailable,
      reason: "missing_expression",
      adapter: PRECISE_PROCUREMENT_ADAPTER.unavailable,
      rows: [],
      scanned: 0,
      continuation: null,
      markSeenIds: [],
      clock,
    };
  }
  if (!textQueryEvaluationSupported(sub?.lens)) {
    return {
      status: TEXT_QUERY_EVAL_STATUS.unavailable,
      reason: "unsupported_lens",
      adapter: PRECISE_PROCUREMENT_ADAPTER.unavailable,
      rows: [],
      scanned: 0,
      continuation: null,
      markSeenIds: [],
      clock,
    };
  }

  const compiled = compileSub_d1(sub, todayISO);
  const snapshotHasRows = snapshot
    && ((Array.isArray(snapshot) && snapshot.length)
      || (Array.isArray(snapshot.rows) && snapshot.rows.length));
  let noticeEval = null;
  if (db && compiled?.opts) {
    noticeEval = await evaluateD1NoticeTextQuery(db, {
      opts: compiled.opts,
      postFilter: compiled.postFilter,
      expression,
      limit,
      scanBudget,
      cursor,
      clock,
    });
    if (noticeEval.status === TEXT_QUERY_EVAL_STATUS.unavailable) {
      if (!snapshotHasRows) return noticeEval;
      noticeEval = null;
    }
  } else if (db && !compiled?.opts && !sub?.filter?.procurement_id && !snapshotHasRows) {
    noticeEval = {
      status: TEXT_QUERY_EVAL_STATUS.unavailable,
      reason: "d1_unsupported_combination",
      adapter: PRECISE_PROCUREMENT_ADAPTER.unavailable,
      rows: [],
      scanned: 0,
      continuation: null,
      markSeenIds: [],
      clock,
    };
  }
  const snapshotRows = snapshotHasRows
    ? matchProcurementDigestRows(snapshot, sub.filter, {
      lens: sub.lens || "money",
      limit,
    }).map((row) => {
      const decision = decideProcurementTextQuery(row, expression, projectProcurementObjectFields);
      return stampDigestIdentity({ ...row, text_query_evidence: decision.evidence });
    })
    : [];

  const noticeRows = noticeEval?.rows || [];
  const merged = unionMoneyDigestRows(noticeRows, snapshotRows);

  if (!db && !snapshotHasRows) {
    return {
      status: TEXT_QUERY_EVAL_STATUS.unavailable,
      reason: "missing_materialization",
      adapter: PRECISE_PROCUREMENT_ADAPTER.unavailable,
      retrieval: "none",
      rows: [],
      scanned: 0,
      continuation: null,
      markSeenIds: [],
      clock,
    };
  }
  if (noticeEval?.status === TEXT_QUERY_EVAL_STATUS.unavailable && !snapshotHasRows) {
    return noticeEval;
  }

  const incomplete = noticeEval?.status === TEXT_QUERY_EVAL_STATUS.incomplete;
  const adapter = noticeEval && snapshotHasRows
    ? PRECISE_PROCUREMENT_ADAPTER.combined
    : noticeEval
      ? PRECISE_PROCUREMENT_ADAPTER.notices
      : PRECISE_PROCUREMENT_ADAPTER.snapshot;

  return {
    status: incomplete ? TEXT_QUERY_EVAL_STATUS.incomplete : TEXT_QUERY_EVAL_STATUS.complete,
    reason: incomplete ? "scan_budget" : null,
    adapter,
    retrieval: noticeEval?.retrieval || "snapshot",
    rows: merged,
    scanned: noticeEval?.scanned || snapshotRows.length,
    continuation: noticeEval?.continuation || null,
    markSeenIds: merged.map((row) => row.digest_id || row.request_id || row.procurement_id).filter(Boolean),
    clock,
    soda: false,
    fts: false,
    publisher_fetch: false,
    fields: projectProcurementNoticeFields({}),
  };
}

export { PROCUREMENT_TEXT_QUERY_EVAL, TEXT_QUERY_EVAL_STATUS };
