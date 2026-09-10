/**
 * Query-revision continuity for precise-watch edits and queued email.
 *
 * Atomic revision / cutoff strategy (this storage boundary: SUBS KV + D1 outbox):
 *
 * 1. Each saved watch may carry `query_revision`, a fingerprint of the
 *    canonical v1 `text_query`. Equivalent expressions share a fingerprint.
 *    Legacy watches without `text_query` have no revision and keep byte-stable
 *    identity. The fingerprint lives on the SUBS record, not the KV key.
 *
 * 2. Queued membership is the outbox primary key `(watch_id, item_id)`. An
 *    edit that changes the fingerprint re-evaluates *unsent* rows for THAT
 *    watch against the current expression, before any result limit:
 *      - still matching → keep owed, stamp the new revision
 *      - no longer matching → `status=cancelled` with structured reason
 *      - previously cancelled by query-revision and now matching → owed again
 *    Delivered rows are tombstones. Other watches and other accounts are
 *    untouched. Exclusion is never recorded as delivery.
 *
 * 3. Provider-submit cutoff (`QUERY_REVISION_CUTOFF`): the last read of the
 *    current query revision after evaluation/enqueue/attach and immediately
 *    before `reserveDeliveryOccasion` + `sendEmail`. A stale prepared batch is
 *    rebuilt; old content is not submitted. After the provider accepts a
 *    message there is no recall. Unchanged retries keep the reserved
 *    `delivery_id` as the Idempotency-Key.
 *
 * 4. Ordinary enqueue uses `ON CONFLICT DO NOTHING`, so a cancelled row is not
 *    resurrected by retry. Only an intentional later edit that makes the item
 *    eligible again moves `cancelled` → `owed` in place (the uniqueness
 *    constraint is not a permanent bar).
 */

import { canonicalTextQuery } from "../../../site/watch_text_query.mjs";
import {
  decideProcurementTextQuery,
  projectProcurementNoticeFields,
  projectProcurementObjectFields,
} from "../../../site/watch_text_query_eval.mjs";
import {
  QUERY_REVISION_CANCEL_REASON,
  cancelOwedItemForQueryRevision,
  cancelOwedItemsForWatch,
  listDeliveredItemIds,
  listWatchMembership,
  restoreQueryRevisionCancelledItem,
  stampOutboxQueryRevision,
} from "./digest_outbox.mjs";

export const QUERY_REVISION_SCHEMA = "cityscroll.watch_query_revision.v1";
/** Last current-revision read before reserve + provider submit. */
export const QUERY_REVISION_CUTOFF = "before-provider-submit";
export const QUERY_REVISION_SUPPRESSION = QUERY_REVISION_CANCEL_REASON;

/** Fingerprint of an admitted v1 expression; null when the watch has none. */
export function queryRevisionForFilter(filter) {
  const canonical = canonicalTextQuery(filter?.text_query, { structuredScope: true });
  if (!canonical) return null;
  return `qr:v1:${JSON.stringify(canonical)}`;
}

/**
 * Stamp `query_revision` on a SUBS record. Equivalent expressions keep the
 * same fingerprint, so a duplicate save is not a material revision change.
 */
export function stampWatchQueryRevision(record) {
  if (!record || typeof record !== "object") {
    return { record, changed: false, query_revision: null };
  }
  const previous = record.query_revision || null;
  const nextRevision = queryRevisionForFilter(record.filter);
  const next = { ...record };
  if (nextRevision) next.query_revision = nextRevision;
  else delete next.query_revision;
  return {
    record: next,
    changed: previous !== (next.query_revision || null),
    query_revision: next.query_revision || null,
  };
}

function payloadRow(item) {
  try {
    const parsed = JSON.parse(item?.payload_json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function projectFieldsForPayload(row) {
  if (row?.procurement_id && !row?.request_id) return projectProcurementObjectFields;
  return projectProcurementNoticeFields;
}

/** Decide whether one owed payload still matches the watch's current expression. */
export function owedPayloadMatchesExpression(row, expression) {
  if (!row || typeof row !== "object") return false;
  if (expression == null) return true;
  return decideProcurementTextQuery(row, expression, projectFieldsForPayload(row)).match;
}

function suppressionForItem(item, watch, decision) {
  const exclusion = decision?.evidence?.exclusion || null;
  return {
    schema: QUERY_REVISION_SCHEMA,
    reason: QUERY_REVISION_SUPPRESSION,
    watch_id: watch.watch_id,
    item_id: item.item_id,
    query_revision: watch.query_revision || queryRevisionForFilter(watch.filter),
    cutoff: QUERY_REVISION_CUTOFF,
    exclusion: exclusion
      ? {
          kind: exclusion.atom?.kind || null,
          value: exclusion.atom?.value || null,
          field: exclusion.field || null,
          passage: exclusion.passage || null,
        }
      : null,
  };
}

function decisionForPayload(row, expression) {
  if (!row || expression == null) return { match: true, evidence: { exclusion: null } };
  return decideProcurementTextQuery(row, expression, projectFieldsForPayload(row));
}

/**
 * Re-evaluate unsent membership for one watch against its current expression.
 * Never touches delivered rows, other watches, or other accounts.
 */
export async function reconcileWatchOwedMembership(db, { watch, now = null } = {}) {
  const result = {
    watch_id: watch?.watch_id || null,
    query_revision: watch?.query_revision || queryRevisionForFilter(watch?.filter) || null,
    cancelled: [],
    restored: [],
    kept: [],
    skipped: null,
  };
  if (!db?.prepare) {
    result.skipped = "no-db";
    return result;
  }
  if (!watch?.watch_id) {
    result.skipped = "no-watch";
    return result;
  }
  const expression = watch.filter?.text_query || null;
  if (!expression) {
    result.skipped = "no-expression";
    return result;
  }
  const revision = result.query_revision;
  const membership = await listWatchMembership(db, watch.watch_id);
  for (const item of membership) {
    if (item.status === "delivered") continue;
    const row = payloadRow(item);
    const decision = decisionForPayload(row, expression);
    if (item.status === "owed") {
      if (decision.match) {
        await stampOutboxQueryRevision(db, {
          watchId: item.watch_id,
          itemId: item.item_id,
          queryRevision: revision,
        });
        result.kept.push(item.item_id);
        continue;
      }
      const suppression = suppressionForItem(item, watch, decision);
      await cancelOwedItemForQueryRevision(db, {
        watchId: item.watch_id,
        itemId: item.item_id,
        queryRevision: revision,
        suppression,
      });
      result.cancelled.push({
        item_id: item.item_id,
        reason: QUERY_REVISION_SUPPRESSION,
        suppression,
      });
      continue;
    }
    if (item.status === "cancelled" && item.last_error === QUERY_REVISION_SUPPRESSION) {
      if (!decision.match) continue;
      const restored = await restoreQueryRevisionCancelledItem(db, {
        watchId: item.watch_id,
        itemId: item.item_id,
        queryRevision: revision,
        now,
      });
      if (restored) result.restored.push(item.item_id);
    }
  }
  return result;
}

function itemIdForRow(row) {
  if (!row || typeof row !== "object") return null;
  const transitionKey = row.procurement_process_watch?.transition?.transition_key
    || row.procurement_intent_watch?.update_key
    || row.matter_update_key
    || row.council_matter_watch?.update_key;
  if (transitionKey) return String(transitionKey);
  if (row.request_id) return `notice:${row.request_id}`;
  if (row.procurement_id) return String(row.procurement_id);
  if (row.project_id) return `land:${row.project_id}`;
  return null;
}

function filterDroppedRows(rows, dropItemIds, dropRequestIds) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const itemId = itemIdForRow(row);
    if (itemId && dropItemIds.has(itemId)) return false;
    if (row?.request_id && dropRequestIds.has(String(row.request_id))) return false;
    if (row?.procurement_id && dropRequestIds.has(String(row.procurement_id))) return false;
    return true;
  });
}

function applyMembershipToSection(section, recon, restoredRows) {
  const dropItemIds = new Set((recon.cancelled || []).map((row) => row.item_id));
  const dropRequestIds = new Set();
  for (const id of dropItemIds) {
    // Only notice-qualified outbox ids map onto request_id. Process-transition
    // and procurement-object identities must not suppress a later distinct event
    // that happens to share the same procurement_id.
    if (String(id).startsWith("notice:")) dropRequestIds.add(String(id).slice("notice:".length));
  }
  if (Array.isArray(section.outboxItems)) {
    section.outboxItems = section.outboxItems.filter((item) => !dropItemIds.has(item.item_id));
  }
  if (Array.isArray(section.freshRows)) {
    section.freshRows = filterDroppedRows(section.freshRows, dropItemIds, dropRequestIds);
    for (const row of restoredRows) {
      if (!section.freshRows.some((existing) => itemIdForRow(existing) === itemIdForRow(row))) {
        section.freshRows.push(row);
      }
    }
    section.new = section.freshRows.length;
    section.noticeIds = [...new Set(section.freshRows.map((row) => row.request_id || row.procurement_id).filter(Boolean))].slice(0, 100);
  }
  if (Array.isArray(section.awardCandidates)) {
    section.awardCandidates = filterDroppedRows(section.awardCandidates, dropItemIds, dropRequestIds);
    section.new = section.awardCandidates.length;
  }
}

async function reloadWatch(env, watch) {
  if (!watch?.key || !env?.SUBS?.get) return watch;
  try {
    const raw = await env.SUBS.get(watch.key);
    if (raw == null) return { ...watch, deleted: true };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return watch;
    return { ...watch, ...parsed, key: watch.key };
  } catch {
    return watch;
  }
}

/**
 * Provider-submit cutoff: re-read current revisions, reconcile unsent
 * membership, and strip stale attached rows before the batch is reserved
 * or submitted. Callers rebuild subject/HTML from the mutated sections.
 */
export async function applyPreparedDigestQueryRevisionCutoff(env, watches, sections, ctx = {}) {
  if (typeof ctx.onBeforeQueryRevisionCutoff === "function") {
    await ctx.onBeforeQueryRevisionCutoff({ watches, sections, cutoff: QUERY_REVISION_CUTOFF });
  }
  const current = [];
  for (const watch of Array.isArray(watches) ? watches : []) {
    current.push(await reloadWatch(env, watch));
  }
  const summary = {
    cutoff: QUERY_REVISION_CUTOFF,
    rebuilt: false,
    cancelled: [],
    restored: [],
    deleted: [],
  };
  const db = env?.DB || null;
  const byWatchId = new Map();
  for (const watch of current) {
    if (watch?.watch_id) byWatchId.set(watch.watch_id, watch);
  }
  for (const section of Array.isArray(sections) ? sections : []) {
    const watchId = section?.watchId || section?.watch_id;
    const watch = byWatchId.get(watchId);
    if (!watch || watch.deleted || watch.paused) {
      if (watch?.deleted && watchId && db) {
        await cancelOwedItemsForWatch(db, { watchId, reason: "cancelled:watch-removed" });
        summary.deleted.push(watchId);
      }
      if (watch?.deleted || watch?.paused) {
        section.skipped = watch.deleted ? "deleted" : "paused";
        section.status = "skipped";
        section.action = "none";
        section.freshRows = [];
        section.awardCandidates = [];
        section.outboxItems = [];
        section.new = 0;
        summary.rebuilt = true;
      }
      continue;
    }
    const expression = watch.filter?.text_query || null;
    let recon = { cancelled: [], restored: [], query_revision: queryRevisionForFilter(watch.filter) };
    if (expression) {
      recon = await reconcileWatchOwedMembership(db, {
        watch,
        now: ctx.now || ctx.today || null,
      });
    }
    const restoredRows = [];
    if (recon.restored.length && db) {
      const membership = await listWatchMembership(db, watch.watch_id);
      for (const item of membership) {
        if (item.status === "owed" && recon.restored.includes(item.item_id)) {
          const row = payloadRow(item);
          if (row) restoredRows.push(row);
        }
      }
    }
    if (expression && Array.isArray(section.freshRows)) {
      const before = section.freshRows.length;
      section.freshRows = section.freshRows.filter((row) => owedPayloadMatchesExpression(row, expression));
      if (section.freshRows.length !== before) summary.rebuilt = true;
    }
    const deliveredIds = db ? await listDeliveredItemIds(db, watch.watch_id) : [];
    const membership = db ? await listWatchMembership(db, watch.watch_id) : [];
    const cancelledIds = membership
      .filter((item) => item.status === "cancelled")
      .map((item) => item.item_id);
    const drop = [
      ...recon.cancelled,
      ...deliveredIds.map((item_id) => ({ item_id })),
      ...cancelledIds.map((item_id) => ({ item_id })),
    ];
    if (drop.length || recon.restored.length) {
      summary.rebuilt = true;
      summary.cancelled.push(...recon.cancelled);
      summary.restored.push(...recon.restored);
    }
    applyMembershipToSection(section, { cancelled: drop }, restoredRows);
    section.queryRevision = recon.query_revision;
  }
  return { watches: current, sections, ...summary };
}
