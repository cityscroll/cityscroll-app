/**
 * Confirmation, baseline, removal, and delivery gating for exact matter watches.
 *
 * Confirmation is transactional with watch activation: the retained observations
 * already present become the baseline, so they produce zero catch-up updates.
 * Delivery enqueueing stays feature-gated until end-to-end activation.
 */

import { computeSourceRecordHash } from "./source_records.mjs";
import { cancelOwedItemsForWatch } from "./digest_outbox.mjs";
import {
  councilMatterDigestRows,
  defaultRetainedMatterRoster,
  exactCouncilMatterWatch,
  matterWatchDeliveryEnabled,
  parseCouncilMatterRef,
  resolveExactCouncilMatterWatch,
} from "../../../site/council_matter_watch.mjs";
import {
  councilMatterUpdateDigestRows,
  reduceCouncilMatterWatchUpdates,
} from "../../../site/council_matter_watch_change.mjs";

export {
  matterWatchDeliveryEnabled,
  resolveExactCouncilMatterWatch,
};

const INSERT_BASELINE_SQL = `INSERT INTO matter_watch_baseline (
  baseline_id, watch_id, subscriber_id, matter_ref, matter_scope_version,
  baseline_acquired_at, observation_ids_json, confirmed_at, status, removed_at, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?)`;

const SELECT_ACTIVE_SQL = `SELECT * FROM matter_watch_baseline
 WHERE subscriber_id = ? AND matter_ref = ? AND status = 'active' LIMIT 1`;

const SELECT_WATCH_SQL = `SELECT * FROM matter_watch_baseline
 WHERE watch_id = ? AND status = 'active' LIMIT 1`;

const DEACTIVATE_SQL = `UPDATE matter_watch_baseline
   SET status = 'removed', removed_at = ?
 WHERE watch_id = ? AND status = 'active'`;

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function baselineFromRow(row) {
  if (!row) return null;
  return {
    baseline_id: row.baseline_id,
    watch_id: row.watch_id,
    subscriber_id: row.subscriber_id,
    matter_ref: row.matter_ref,
    matter_scope_version: Number(row.matter_scope_version),
    baseline_acquired_at: row.baseline_acquired_at,
    observation_ids: parseJson(row.observation_ids_json, []),
    confirmed_at: row.confirmed_at,
    status: row.status,
    removed_at: row.removed_at || null,
  };
}

async function first(db, sql, params = []) {
  const statement = db.prepare(sql);
  const bound = statement.bind ? statement.bind(...params) : statement;
  if (typeof bound.first === "function") return bound.first();
  const result = await bound.all?.();
  return result?.results?.[0] || null;
}

export async function readJournalObservationsForMatter(env, matterRef) {
  const parsed = parseCouncilMatterRef(matterRef);
  if (!parsed || !env?.DB?.prepare) return [];
  const rows = await env.DB.prepare(
    `SELECT observation_id, matter_id, event_id, native_event_item_id, publisher_action_id,
            event_time, observed_at, acquired_at, semantic_revision, title, action_name,
            notice_references_json, vote_binding_status, vote_event_item_id, superseded_by
       FROM matter_observation_journal
      WHERE source_system IN ('legistar', 'nyc_legistar_matter_bootstrap')
        AND tenant = ? AND matter_id = ?
      ORDER BY acquired_at ASC, event_time ASC, observation_id ASC`,
  ).bind(parsed.tenant, parsed.matter_id).all();
  return rows?.results || [];
}

export function baselineFromObservations(observations = [], { now = new Date().toISOString() } = {}) {
  const ids = observations.map((row) => row.observation_id).filter(Boolean);
  const acquired = observations.map((row) => row.acquired_at).filter(Boolean).sort();
  return {
    observation_ids: ids,
    baseline_acquired_at: acquired.at(-1) || now,
  };
}

export async function confirmExactMatterWatch(env, record, {
  roster = defaultRetainedMatterRoster(),
  now = new Date().toISOString(),
  observations = null,
} = {}) {
  const watch = resolveExactCouncilMatterWatch({ lens: record.lens, filter: record.filter }, { roster });
  if (watch.status !== "ok") {
    const error = new Error(watch.reason || "unsupported exact matter scope");
    error.code = "unsupported-scope";
    error.watch = watch;
    throw error;
  }
  if (!record.subscriber_id || !record.watch_id) {
    const error = new Error("exact matter confirmation requires subscriber and watch identity");
    error.code = "missing-identity";
    throw error;
  }
  const existing = env?.DB?.prepare
    ? baselineFromRow(await first(env.DB, SELECT_ACTIVE_SQL, [record.subscriber_id, watch.matter_ref]))
    : null;
  if (existing) {
    return { created: false, baseline: existing, watch };
  }
  const journalRows = observations || await readJournalObservationsForMatter(env, watch.matter_ref);
  const snapshot = baselineFromObservations(journalRows, { now });
  const baselineId = await computeSourceRecordHash({
    watch_id: record.watch_id,
    subscriber_id: record.subscriber_id,
    matter_ref: watch.matter_ref,
    confirmed_at: now,
  });
  const baseline = {
    baseline_id: baselineId,
    watch_id: record.watch_id,
    subscriber_id: record.subscriber_id,
    matter_ref: watch.matter_ref,
    matter_scope_version: watch.watch_scope_version,
    baseline_acquired_at: snapshot.baseline_acquired_at,
    observation_ids: snapshot.observation_ids,
    confirmed_at: now,
    status: "active",
    removed_at: null,
  };
  if (env?.DB?.batch) {
    await env.DB.batch([
      env.DB.prepare(INSERT_BASELINE_SQL).bind(
        baseline.baseline_id,
        baseline.watch_id,
        baseline.subscriber_id,
        baseline.matter_ref,
        baseline.matter_scope_version,
        baseline.baseline_acquired_at,
        JSON.stringify(baseline.observation_ids),
        baseline.confirmed_at,
        "active",
        null,
        now,
      ),
    ]);
  } else if (env?.DB?.prepare) {
    await env.DB.prepare(INSERT_BASELINE_SQL).bind(
      baseline.baseline_id,
      baseline.watch_id,
      baseline.subscriber_id,
      baseline.matter_ref,
      baseline.matter_scope_version,
      baseline.baseline_acquired_at,
      JSON.stringify(baseline.observation_ids),
      baseline.confirmed_at,
      "active",
      null,
      now,
    ).run();
  }
  return { created: true, baseline, watch };
}

export async function removeExactMatterWatch(env, record, { now = new Date().toISOString() } = {}) {
  const watchId = record?.watch_id;
  if (!watchId) return { removed: false, cancelled: 0 };
  if (env?.DB?.prepare) {
    await env.DB.prepare(DEACTIVATE_SQL).bind(now, watchId).run();
  }
  let cancelled = 0;
  if (env?.DB) {
    try {
      const result = await cancelOwedItemsForWatch(env.DB, { watchId, reason: "cancelled:watch-removed" });
      cancelled = result?.cancelled || 0;
    } catch {
      cancelled = 0;
    }
  }
  return { removed: true, cancelled };
}

export async function eligibleMatterWatchRows(env, record, {
  observations = null,
  asOf = null,
} = {}) {
  const watch = exactCouncilMatterWatch({ lens: record.lens, filter: record.filter });
  if (watch.status !== "ok") return [];
  const baseline = env?.DB?.prepare
    ? baselineFromRow(await first(env.DB, SELECT_WATCH_SQL, [record.watch_id]))
    : record.matter_watch_baseline || null;
  const deliveryEnabled = matterWatchDeliveryEnabled(env);
  const journalRows = observations || await readJournalObservationsForMatter(env, watch.matter_ref);
  const mapped = journalRows.map((row) => ({ ...row, matter_id: watch.matter_id }));
  if (!deliveryEnabled) {
    return councilMatterDigestRows({
      matter_ref: watch.matter_ref,
      observations: mapped,
      baseline,
      confirmed: true,
      deliveryEnabled,
    });
  }
  return councilMatterUpdateDigestRows(reduceCouncilMatterWatchUpdates({
    matter_ref: watch.matter_ref,
    observations: mapped,
    baseline,
    asOf,
  }));
}

export function compileExactCouncilMatter(sub, todayISO) {
  const watch = exactCouncilMatterWatch(sub);
  if (!watch.attempted) return undefined;
  if (watch.status !== "ok") {
    return {
      url: null,
      params: {},
      idField: "alert_id",
      kind: "unsupported",
      unsupported: true,
      reason: watch.reason,
      soda: false,
      nativeReader: null,
    };
  }
  return {
    url: null,
    params: {},
    idField: "matter_update_key",
    kind: "council-matter",
    unsupported: false,
    soda: false,
    nativeReader: "matter-observation-journal",
    matter_ref: watch.matter_ref,
    routeReadModel: {
      kind: "council-matter",
      matter_ref: watch.matter_ref,
      matter_id: watch.matter_id,
      todayISO,
      filter: watch.filter,
      watch_id: sub?.watch_id || null,
      subscriber_id: sub?.subscriber_id || null,
    },
  };
}

export function d1DispatchExactCouncilMatter(sub) {
  const watch = exactCouncilMatterWatch(sub);
  if (!watch.attempted) return null;
  if (watch.status !== "ok") {
    return { unsupported: true, reason: watch.reason, soda: false, opts: null };
  }
  return {
    unsupported: false,
    nativeReader: "matter-observation-journal",
    soda: false,
    opts: null,
    kind: "council-matter",
    matter_ref: watch.matter_ref,
  };
}

export function sodaQueryContainsMatterField(query) {
  if (!query || typeof query !== "object") return false;
  const blob = JSON.stringify(query.params || query.opts || {});
  return /\bmatter(_ref|_id)?\b/i.test(blob);
}

export { exactCouncilMatterWatch };
