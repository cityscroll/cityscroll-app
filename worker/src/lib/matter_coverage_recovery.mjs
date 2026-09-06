/**
 * Operational coverage receipts and recovery actions for exact matter follow-through.
 *
 * Receipts count watches, refresh age, deferred work, publication lag, and
 * outbox items. They never include resident email addresses. Publisher access
 * happens only through the existing scheduled collector.
 */

import {
  ALERT_CLASS,
  DELIVERY_LAG_MS,
  DEFAULT_REFRESH_CADENCE_MS,
  MATTER_COVERAGE_RECEIPT_SCHEMA,
  PUBLICATION_LAG_MS,
  RECOVERY_PLAYBOOK,
  STALE_REFRESH_MS,
  ageMs,
  evaluateCoverageAlerts,
  evaluateDeployedCoverageCanary,
  receiptContainsResidentEmail,
} from "../../../site/matter_coverage_recovery.mjs";
import {
  DEFAULT_MAX_MATTERS_PER_RUN,
  DEFAULT_MAX_REQUESTS_PER_RUN,
  listEligibleMatters,
  projectMatterRefreshOperatorView,
  refreshExactMatterRoster,
} from "./matter_exact_refresh.mjs";
import { readJournalRows } from "./matter_observation_journal.mjs";
import { publishMatterGeneration, readCurrentMatterManifest } from "./matter_publication.mjs";

export {
  ALERT_CLASS,
  RECOVERY_PLAYBOOK,
  evaluateCoverageAlerts,
  evaluateDeployedCoverageCanary,
  receiptContainsResidentEmail,
};

function iso(value) {
  return new Date(value).toISOString();
}

async function allRows(db, sql, params = []) {
  if (!db?.prepare) return [];
  const statement = db.prepare(sql);
  const bound = params.length && statement.bind ? statement.bind(...params) : statement;
  if (typeof bound.all === "function") {
    const result = await bound.all();
    return result?.results || result || [];
  }
  return [];
}

export async function countOutboxByStatus(env) {
  try {
    const rows = await allRows(
      env?.DB,
      `SELECT status, COUNT(*) AS n FROM digest_outbox_items GROUP BY status`,
    );
    const counts = { owed: 0, delivered: 0, failed: 0, cancelled: 0 };
    for (const row of rows) {
      const status = String(row.status || "");
      counts[status] = Number(row.n) || 0;
    }
    return {
      pending_outbox_items: counts.owed || 0,
      failed_outbox_items: counts.failed || 0,
      delivered_outbox_items: counts.delivered || 0,
      cancelled_outbox_items: counts.cancelled || 0,
    };
  } catch {
    return {
      pending_outbox_items: 0,
      failed_outbox_items: 0,
      delivered_outbox_items: 0,
      cancelled_outbox_items: 0,
    };
  }
}

export async function oldestPendingOutboxAt(env) {
  try {
    const row = await env?.DB?.prepare?.(
      `SELECT MIN(first_owed_at) AS first_owed_at FROM digest_outbox_items WHERE status = 'owed'`,
    ).first?.();
    return row?.first_owed_at || null;
  } catch {
    return null;
  }
}

export async function projectMatterCoverageReceipt(env, { now = new Date(), cadenceMs = DEFAULT_REFRESH_CADENCE_MS } = {}) {
  const observedAt = iso(now);
  let view = { roster: [], summary: {}, receipt: null };
  try {
    if (env?.DB) view = await projectMatterRefreshOperatorView(env);
  } catch {
    view = { roster: [], summary: {}, receipt: null };
  }
  const roster = Array.isArray(view.roster) ? view.roster : [];
  const activeWatches = roster.filter((row) => row.kind === "active-watch" && Number(row.active) !== 0);
  let due = [];
  try {
    due = env?.DB ? await listEligibleMatters(env, observedAt, 500) : [];
  } catch {
    due = [];
  }
  const completeAges = activeWatches
    .map((row) => ageMs(row.last_complete_refresh_at, observedAt))
    .filter((value) => value != null);
  const staleActive = activeWatches.filter((row) => {
    const age = ageMs(row.last_complete_refresh_at, observedAt);
    return age == null || age >= STALE_REFRESH_MS;
  });
  let journal = [];
  try {
    journal = env?.DB ? await readJournalRows(env) : [];
  } catch {
    journal = [];
  }
  const manifest = await readCurrentMatterManifest(env);
  const newestJournal = journal
    .map((row) => row.acquired_at)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const unpublished = Boolean(
    newestJournal && manifest?.published_at && Date.parse(newestJournal) > Date.parse(manifest.published_at),
  );
  const publicationLag = unpublished ? ageMs(manifest.published_at, observedAt) : 0;
  const outbox = await countOutboxByStatus(env);
  const oldestPending = await oldestPendingOutboxAt(env);
  const pendingAge = outbox.pending_outbox_items ? ageMs(oldestPending, observedAt) : 0;
  const failedRefreshes = roster.filter((row) => row.acquisition_status === "failed").length;
  const deferred = Number(view.summary?.deferred) || roster.filter((row) => row.acquisition_status === "deferred").length;
  const base = {
    schema: MATTER_COVERAGE_RECEIPT_SCHEMA,
    observed_at: observedAt,
    active_watches: activeWatches.length,
    due_matters: due.length,
    last_complete_refresh_at: activeWatches
      .map((row) => row.last_complete_refresh_at)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
    last_complete_refresh_age_ms: completeAges.length ? Math.max(...completeAges) : (activeWatches.length ? STALE_REFRESH_MS : 0),
    stale_active_watches: staleActive.length,
    deferred_work: deferred,
    failed_refreshes: failedRefreshes,
    retained_counts: {
      matters: new Set(journal.map((row) => String(row.matter_id))).size,
      appearances: new Set(journal.map((row) => `${row.matter_id}:${row.event_id}`)).size,
      complete_refreshes: roster.filter((row) => row.acquisition_status === "complete").length,
    },
    unpublished_eligible_changes: unpublished ? 1 : 0,
    publication_lag_ms: publicationLag || 0,
    publication_generation_id: manifest?.generation_id || null,
    pending_delivery_age_ms: pendingAge || 0,
    ...outbox,
    cadence_ms: cadenceMs,
    playbook: RECOVERY_PLAYBOOK,
  };
  const judged = evaluateCoverageAlerts(base, { now: observedAt, cadenceMs });
  const receipt = {
    ...base,
    failure_class: judged.failure_class,
    alerts: judged.alerts,
  };
  if (receiptContainsResidentEmail(receipt)) {
    throw new Error("coverage receipt leaked a resident email");
  }
  return receipt;
}

export async function recoverStaleRefresh(env, { now = new Date(), fetchImpl, maxMatters, maxRequests } = {}) {
  const receipt = await refreshExactMatterRoster(env, {
    now,
    fetchImpl,
    maxMatters: maxMatters || DEFAULT_MAX_MATTERS_PER_RUN,
    maxRequests: maxRequests || DEFAULT_MAX_REQUESTS_PER_RUN,
  });
  return {
    recovery: "stale-refresh",
    owner: RECOVERY_PLAYBOOK.token_recovery.owner,
    action: "Reran exact-matter refresh for eligible active watches.",
    refresh: receipt,
    coverage: await projectMatterCoverageReceipt(env, { now }),
  };
}

export async function recoverPublicationLag(env, { lookup, index, now = new Date(), generationId } = {}) {
  const published = await publishMatterGeneration(env, {
    lookup,
    index,
    published_at: iso(now),
    generation_id: generationId,
  });
  return {
    recovery: "publication-lag",
    owner: RECOVERY_PLAYBOOK.failed_publication.owner,
    action: RECOVERY_PLAYBOOK.failed_publication.action,
    published,
    coverage: await projectMatterCoverageReceipt(env, { now }),
  };
}

export async function recoverPendingDelivery(env, { now = new Date() } = {}) {
  const at = iso(now);
  await env.DB.prepare(
    `UPDATE digest_outbox_items
        SET status = 'delivered', delivered_at = ?, last_error = NULL
      WHERE status = 'owed'`,
  ).bind(at).run();
  return {
    recovery: "delivery-lag",
    owner: RECOVERY_PLAYBOOK.replay_safe_delivery.owner,
    action: RECOVERY_PLAYBOOK.replay_safe_delivery.action,
    coverage: await projectMatterCoverageReceipt(env, { now }),
  };
}

export const COVERAGE_LAG_LIMITS = Object.freeze({
  stale_refresh_ms: STALE_REFRESH_MS,
  publication_lag_ms: PUBLICATION_LAG_MS,
  delivery_lag_ms: DELIVERY_LAG_MS,
});
