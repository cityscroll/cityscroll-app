// Digest temporal reconciliation.
//
// A source record has several clocks. Event time says when the civic action happens;
// publication time says when the publisher asserted it; recorded time says when this
// Worker observed/materialized it. None is a safe delivery identity. Delivery is keyed
// by the stable source record plus the actionable state, so late observations are sent
// once and publisher timestamp churn is idempotent.

function text(value) {
  return value == null ? "" : String(value).trim();
}

export function ruleActionKey(record) {
  if (!record?.request_id || record?.stage !== "comment-open") return null;
  const deadline = text(record?.nyc_rules?.comment_by_date);
  const url = text(record?.nyc_rules?.url);
  if (!deadline || !url) return null;
  return `temporal:rules:${record.request_id}:comment-open:${deadline}`;
}

function rulesByNotice(view) {
  const out = new Map();
  for (const record of (view?.rules || [])) {
    const key = ruleActionKey(record);
    if (key && record.request_id) out.set(String(record.request_id), { record, key });
  }
  return out;
}

function withRuleAction(row, match, view) {
  if (!match) return row;
  const rule = match.record.nyc_rules;
  return {
    ...row,
    temporal_action: {
      kind: "rules-comment-open",
      event_at: rule.comment_by_date,
      publication_at: rule.pub_date || null,
      recorded_at: view?.generated_at || null,
      url: rule.url,
    },
  };
}

/**
 * Reconcile query results against delivery state.
 *
 * The returned markSeenIds include both notice ids and semantic action ids. Callers
 * persist them only after a successful send, preserving the existing delivery watermark.
 */
export function reconcileTemporalCandidates({ lens, rows = [], seen = new Set(), rulesView = null, idField = "request_id" } = {}) {
  if (lens !== "rules") {
    return {
      fresh: rows.filter((row) => row?.[idField] && !seen.has(row[idField])),
      markSeenIds: rows.map((row) => row?.[idField]).filter(Boolean),
    };
  }

  const actions = rulesByNotice(rulesView);
  const fresh = [];
  const markSeenIds = [];
  for (const row of rows) {
    const id = text(row?.request_id);
    if (!id) continue;
    const action = actions.get(id) || null;
    const noticeIsFresh = !seen.has(id);
    const actionIsFresh = !!action && !seen.has(action.key);
    if (noticeIsFresh || actionIsFresh) fresh.push(withRuleAction(row, action, rulesView));
    markSeenIds.push(id);
    if (action) markSeenIds.push(action.key);
  }
  return { fresh, markSeenIds };
}
