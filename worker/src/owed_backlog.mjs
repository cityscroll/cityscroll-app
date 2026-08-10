import { redactEmail } from "./lib/subscriptions.mjs";

export const OWED_BACKLOG_SCHEMA = "owed-backlog.v1";
export const DIGEST_SCHEDULE_HOUR_UTC = 13;

// Keep this query read-only and return only the oldest owed item for drill-in. The delivery
// window is ordered by its reservation/send timestamp so a later failed occasion is visible
// even when an earlier occasion was accepted.
export const OWED_BACKLOG_QUERY = `
  WITH owed AS (
    SELECT subscriber_id, COUNT(*) AS owed_count, MIN(first_owed_at) AS oldest_owed_at
    FROM digest_outbox_items
    WHERE status = 'owed'
    GROUP BY subscriber_id
  ),
  oldest AS (
    SELECT subscriber_id, lens, item_id,
      ROW_NUMBER() OVER (
        PARTITION BY subscriber_id
        ORDER BY first_owed_at ASC, watch_id ASC, item_id ASC
      ) AS row_number
    FROM digest_outbox_items
    WHERE status = 'owed'
  ),
  sent_summary AS (
    SELECT subscriber_id, MAX(sent_at) AS last_sent_at
    FROM digest_outbox_deliveries
    GROUP BY subscriber_id
  ),
  latest_delivery AS (
    SELECT subscriber_id, status,
      ROW_NUMBER() OVER (
        PARTITION BY subscriber_id
        ORDER BY COALESCE(sent_at, reserved_at) DESC, scheduled_day DESC, delivery_id DESC
      ) AS row_number
    FROM digest_outbox_deliveries
  )
  SELECT owed.subscriber_id, owed.owed_count, owed.oldest_owed_at,
    oldest.lens AS oldest_lens, oldest.item_id AS oldest_item_id,
    sent_summary.last_sent_at,
    latest_delivery.status AS last_delivery_status
  FROM owed
  JOIN oldest
    ON oldest.subscriber_id = owed.subscriber_id AND oldest.row_number = 1
  LEFT JOIN latest_delivery
    ON latest_delivery.subscriber_id = owed.subscriber_id AND latest_delivery.row_number = 1
  LEFT JOIN sent_summary
    ON sent_summary.subscriber_id = owed.subscriber_id
  ORDER BY owed.oldest_owed_at ASC, owed.subscriber_id ASC
`;

function asDate(value, fallback = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback) : date;
}

function utcBoundary(date) {
  return new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), DIGEST_SCHEDULE_HOUR_UTC,
  ));
}

export function scheduledTimes(now = new Date()) {
  const current = asDate(now);
  const today = utcBoundary(current);
  const next = current < today ? today : new Date(today.getTime() + 86400000);
  const previous = current < today ? new Date(today.getTime() - 86400000) : today;
  return {
    now: current,
    nextScheduledAt: next.toISOString(),
    previousScheduledAt: previous.toISOString(),
  };
}

function ageSeconds(value, now) {
  const oldest = new Date(value || "");
  if (Number.isNaN(oldest.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000));
}

function formatAge(seconds) {
  if (seconds == null) return "Unknown age";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Read the grouped owed rows from D1; this function never writes to either table. */
export async function readOwedBacklogRows(db) {
  const result = await db.prepare(OWED_BACKLOG_QUERY).all();
  return Array.isArray(result?.results) ? result.results : [];
}

/** Best-effort metadata enrichment from the live subscription records. */
export async function scanSubscriberMetadata(subs) {
  const bySubscriber = new Map();
  if (!subs) return { available: false, bySubscriber };
  let cursor;
  try {
    do {
      const page = await subs.list({ prefix: "sub:", cursor });
      for (const key of page.keys || []) {
        let record;
        try { record = JSON.parse(await subs.get(key.name)); } catch { continue; }
        if (!record?.subscriber_id) continue;
        const current = bySubscriber.get(record.subscriber_id) || {
          subscriber_label: record.email ? redactEmail(record.email) : record.subscriber_id,
          active_watch_count: 0,
        };
        if (record.email && current.subscriber_label === record.subscriber_id) {
          current.subscriber_label = redactEmail(record.email);
        }
        if (!record.paused) current.active_watch_count += 1;
        bySubscriber.set(record.subscriber_id, current);
      }
      cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
    return { available: true, bySubscriber };
  } catch {
    return { available: false, bySubscriber: new Map() };
  }
}

export function buildOwedBacklogBody(rows, { now = new Date(), subscriberMetadata = null } = {}) {
  const timing = scheduledTimes(now);
  const metadata = subscriberMetadata || { available: false, bySubscriber: new Map() };
  const previousBoundary = new Date(timing.previousScheduledAt).getTime();
  const subscribers = rows.map((row) => {
    const count = Number(row.owed_count) || 0;
    const oldestAgeSeconds = ageSeconds(row.oldest_owed_at, timing.now);
    const overdue = count > 0 && new Date(row.oldest_owed_at || "").getTime() < previousBoundary;
    const details = metadata.bySubscriber.get(row.subscriber_id);
    return {
      subscriber_id: row.subscriber_id,
      subscriber_label: details?.subscriber_label || row.subscriber_id,
      active_watch_count: metadata.available ? (details?.active_watch_count || 0) : null,
      owed_count: count,
      oldest_owed_at: row.oldest_owed_at || null,
      oldest_age_seconds: oldestAgeSeconds,
      oldest_age: formatAge(oldestAgeSeconds),
      oldest_lens: row.oldest_lens || null,
      oldest_item_id: row.oldest_item_id || null,
      last_sent_at: row.last_sent_at || null,
      last_delivery_status: row.last_delivery_status || null,
      next_scheduled_at: timing.nextScheduledAt,
      overdue,
    };
  });
  return {
    schema: OWED_BACKLOG_SCHEMA,
    generated_at: timing.now.toISOString(),
    next_scheduled_at: timing.nextScheduledAt,
    schedule: { hour_utc: DIGEST_SCHEDULE_HOUR_UTC },
    subscriber_metadata_available: metadata.available,
    summary: {
      subscriber_count: subscribers.length,
      owed_count: subscribers.reduce((total, row) => total + row.owed_count, 0),
      overdue_subscriber_count: subscribers.filter((row) => row.overdue).length,
    },
    subscribers,
  };
}

export async function readOwedBacklog(env, options = {}) {
  if (!env?.DB) return { available: false, error: "no-store" };
  try {
    const rows = await readOwedBacklogRows(env.DB);
    const metadata = await scanSubscriberMetadata(env.SUBS);
    return { available: true, ...buildOwedBacklogBody(rows, { ...options, subscriberMetadata: metadata }) };
  } catch {
    return { available: false, error: "read-failed" };
  }
}
