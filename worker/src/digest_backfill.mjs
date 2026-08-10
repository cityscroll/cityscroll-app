// Exact, no-send first payload for the carry-forward digest outbox.
//
// This module accepts source snapshots produced by a separate read-only replay,
// resolves one subscriber's existing watches, and writes only D1 outbox rows.
// It deliberately has no dependency on the digest/drain or provider modules.

import {
  enqueueEvaluatedSections,
  extractLensIdentity,
} from "./lib/digest_outbox.mjs";
import {
  deriveSubscriberId,
  deriveWatchId,
  ensureSubscriptionIdentity,
  normalizeEmail,
} from "./lib/subscriptions.mjs";

export const FIRST_PAYLOAD_ID = "cityscroll-carry-forward-45-v1";
export const FIRST_PAYLOAD_SOURCE_DATE = "2026-08-10";
export const FIRST_PAYLOAD_OWED_ORIGIN = "recovery-2026-08-10";
export const LEGACY_RECOVERY_ORIGIN = "legacy-recovery";
export const DELIVERED_LAND_PROJECT_ID = "2020Q0317";
export const DELIVERED_LAND_ITEM_ID = "land:project:2020Q0317";

export const FIRST_PAYLOAD_MANIFEST = Object.freeze({
  rules: Object.freeze([
    "20260804030", "20260728026", "20260715005", "20260715041", "20260715045",
    "20260714024", "20260714029", "20260713006", "20260714002", "20260708018",
    "20260708002", "20260710033", "20260707025", "20260706041", "20260706044",
    "20260701025", "20260626036", "20260626035", "20260626034", "20260624032",
    "20260624035", "20260622072", "20260618036", "20260618004", "20260617037",
  ]),
  meetings: Object.freeze([
    "20260723030", "20260716022", "20260709028", "20260618040", "20260721023",
    "20260710032", "20260706044", "20260723005", "20260727031", "20260729020",
    "20260729005", "20260713006", "20260729019", "20260708002", "20260715041",
    "20260714029", "20260709020", "20260714002", "20260723022", "20260728026",
  ]),
});

export class BackfillInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackfillInputError";
    this.status = 400;
  }
}

export class BackfillCoverageError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackfillCoverageError";
    this.status = 409;
  }
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function validIso(value, label) {
  const clean = text(value);
  if (!clean || Number.isNaN(Date.parse(clean))) throw new BackfillInputError(`${label} must be an ISO timestamp`);
  return clean;
}

function sameSet(actual, expected) {
  return actual.length === expected.length && actual.every((value) => expected.includes(value));
}

function snapshotEntry(entry, requestId, lens) {
  if (!entry || typeof entry !== "object") throw new BackfillInputError(`${lens} source snapshot is invalid`);
  const render = entry.render_snapshot ?? entry.renderSnapshot ?? entry.payload ?? entry.row;
  if (!render || typeof render !== "object" || Array.isArray(render)) {
    throw new BackfillInputError(`${lens} ${requestId} is missing a render snapshot`);
  }
  const row = { ...render };
  if (text(row.request_id) !== requestId) throw new BackfillInputError(`${lens} ${requestId} render snapshot identity mismatch`);
  const sourceDate = text(entry.source_date || row.source_date);
  if (!sourceDate) throw new BackfillInputError(`${lens} ${requestId} is missing its source date`);

  // Keep the source date in the durable render snapshot without changing the
  // source's display fields. The normal rollup ignores this audit-only field.
  row.backfill_source_date = sourceDate;
  if (lens === "rules") {
    const actionKey = text(entry.action_key || row.action_key || row.actionKey);
    if (actionKey) row.action_key = actionKey;
  }
  return row;
}

function snapshotSections(sourceSnapshots = {}) {
  const sections = [];
  for (const lens of ["rules", "meetings"]) {
    const expected = FIRST_PAYLOAD_MANIFEST[lens];
    const entries = Array.isArray(sourceSnapshots[lens]) ? sourceSnapshots[lens] : [];
    const actual = entries.map((entry) => text(entry?.request_id));
    if (!sameSet(actual, expected)) {
      throw new BackfillInputError(`${lens} snapshots must match the exact first-payload manifest`);
    }
    sections.push({
      lens,
      kind: lens,
      status: "success",
      freshRows: entries.map((entry) => snapshotEntry(entry, text(entry.request_id), lens)),
    });
  }
  return sections;
}

function coverageEvidence(evidence) {
  if (!evidence || evidence.reconciled !== true) {
    throw new BackfillCoverageError("land delivery coverage is not reconciled");
  }
  if (text(evidence.item_id) !== DELIVERED_LAND_ITEM_ID) {
    throw new BackfillCoverageError("land delivery evidence must name the delivered project tombstone");
  }
  const acceptedAt = validIso(evidence.provider_accepted_at, "provider_accepted_at");
  if (!text(evidence.evidence_ref)) throw new BackfillCoverageError("land delivery evidence reference is required");
  return acceptedAt;
}

/** Read and identity-resolve existing SUBS records; never writes to SUBS. */
export async function resolveBackfillWatches(records, ownerEmail) {
  const normalizedOwner = normalizeEmail(ownerEmail);
  if (!normalizedOwner) throw new BackfillInputError("owner_email is required");
  const subscriberId = await deriveSubscriberId(normalizedOwner);
  const matching = [];
  for (const candidate of Array.isArray(records) ? records : []) {
    const key = text(candidate?.key);
    const record = candidate?.record && typeof candidate.record === "object" ? candidate.record : candidate;
    if (!key || !record || normalizeEmail(record.email) !== normalizedOwner) continue;
    const { record: resolved } = await ensureSubscriptionIdentity(record, key);
    if (resolved.subscriber_id && resolved.subscriber_id !== subscriberId) {
      throw new BackfillInputError("owner subscription has an inconsistent subscriber identity");
    }
    const expectedWatchId = await deriveWatchId(key);
    if (resolved.watch_id && resolved.watch_id !== expectedWatchId) {
      throw new BackfillInputError("owner subscription has an inconsistent watch identity");
    }
    if (resolved.paused) continue;
    matching.push({ key, ...resolved, subscriber_id: subscriberId, watch_id: resolved.watch_id || expectedWatchId });
  }
  const byLens = (lens) => matching.filter((record) => record.lens === lens);
  for (const lens of ["rules", "meetings", "land"]) {
    if (byLens(lens).length !== 1) throw new BackfillInputError(`owner must resolve to exactly one active ${lens} watch`);
  }
  return {
    subscriberId,
    rules: byLens("rules")[0],
    meetings: byLens("meetings")[0],
    land: byLens("land")[0],
    matchedWatchCount: matching.length,
  };
}

/** Snapshot the relevant KV records for a single read-only backfill resolution. */
export async function readBackfillSubscriptions(store) {
  if (!store?.list || !store?.get) throw new BackfillInputError("SUBS store is required");
  const records = [];
  let cursor;
  do {
    let page;
    try {
      page = await store.list({ prefix: "sub:", cursor });
    } catch {
      throw new BackfillInputError("SUBS read failed");
    }
    for (const key of page.keys || []) {
      try {
        const record = JSON.parse(await store.get(key.name));
        if (record && typeof record === "object") records.push({ key: key.name, record });
      } catch {
        // A malformed unrelated subscription is not part of this account's
        // payload; the resolver still fails if the target cannot be found.
      }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return records;
}

function statement(db, sql, params = []) {
  const prepared = db.prepare(sql);
  return typeof prepared.bind === "function" ? prepared.bind(...params) : prepared;
}

async function first(db, sql, params = []) {
  const prepared = statement(db, sql, params);
  return typeof prepared.first === "function" ? await prepared.first() : null;
}

async function all(db, sql, params = []) {
  const prepared = statement(db, sql, params);
  const result = typeof prepared.all === "function" ? await prepared.all() : [];
  return Array.isArray(result?.results) ? result.results : (Array.isArray(result) ? result : []);
}

async function run(db, sql, params = []) {
  const prepared = statement(db, sql, params);
  return prepared.run ? await prepared.run() : null;
}

async function seedDeliveredLand(db, watch, subscriberId, acceptedAt) {
  const identity = extractLensIdentity("land", { project_id: DELIVERED_LAND_PROJECT_ID });
  const canonicalItemId = identity.itemId;
  const existing = await first(db, `
    SELECT watch_id, subscriber_id, item_id, status, delivered_at
      FROM digest_outbox_items
     WHERE watch_id = ? AND item_id IN (?, ?)
  `, [watch.watch_id, DELIVERED_LAND_ITEM_ID, canonicalItemId]);
  if (existing) {
    if (existing.item_id !== DELIVERED_LAND_ITEM_ID || existing.status !== "delivered" || existing.delivered_at !== acceptedAt) {
      throw new BackfillCoverageError("land delivery tombstone conflicts with existing outbox evidence");
    }
    return { seeded: false, itemId: DELIVERED_LAND_ITEM_ID };
  }
  await run(db, `
    INSERT INTO digest_outbox_items
      (watch_id, subscriber_id, item_id, lens, item_kind, payload_json,
       source_observed_at, first_owed_at, owed_origin, status, delivered_at)
    VALUES (?, ?, ?, 'land', 'land', ?, ?, ?, ?, 'delivered', ?)
    ON CONFLICT (watch_id, item_id) DO NOTHING
  `, [
    watch.watch_id,
    subscriberId,
    DELIVERED_LAND_ITEM_ID,
    JSON.stringify({ project_id: DELIVERED_LAND_PROJECT_ID, subject_ref: DELIVERED_LAND_ITEM_ID, backfill_source_date: FIRST_PAYLOAD_SOURCE_DATE }),
    FIRST_PAYLOAD_SOURCE_DATE,
    acceptedAt,
    LEGACY_RECOVERY_ORIGIN,
    acceptedAt,
  ]);
  const inserted = await first(db, `
    SELECT status, delivered_at FROM digest_outbox_items WHERE watch_id = ? AND item_id = ?
  `, [watch.watch_id, DELIVERED_LAND_ITEM_ID]);
  if (!inserted || inserted.status !== "delivered" || inserted.delivered_at !== acceptedAt) {
    throw new BackfillCoverageError("land delivery tombstone was not persisted");
  }
  return { seeded: true, itemId: DELIVERED_LAND_ITEM_ID };
}

async function countForSubscriber(db, subscriberId) {
  return first(db, `
    SELECT COUNT(*) AS total_count,
           SUM(CASE WHEN status = 'owed' THEN 1 ELSE 0 END) AS owed_count,
           SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_count
      FROM digest_outbox_items
     WHERE subscriber_id = ?
  `, [subscriberId]);
}

async function validateExistingRows(db, watches, sections, subscriberId, acceptedAt) {
  const expected = new Map();
  expected.set(`${watches.land.watch_id}\u0000${DELIVERED_LAND_ITEM_ID}`, { status: "delivered", deliveredAt: acceptedAt });
  for (const section of sections) {
    const watchId = watches[section.lens].watch_id;
    for (const row of section.freshRows) {
      const identity = extractLensIdentity({ lens: section.lens, row });
      expected.set(`${watchId}\u0000${identity.itemId}`, { status: "owed", deliveredAt: null });
    }
  }
  if (expected.size !== 46) throw new BackfillInputError("first-payload identities are not unique per watch");
  const existing = await all(db, `
    SELECT watch_id, item_id, status, delivered_at
      FROM digest_outbox_items
     WHERE subscriber_id = ?
  `, [subscriberId]);
  for (const row of existing) {
    const expectation = expected.get(`${row.watch_id}\u0000${row.item_id}`);
    if (!expectation || row.status !== expectation.status || row.delivered_at !== expectation.deliveredAt) {
      throw new BackfillInputError("existing subscriber outbox rows fall outside the exact first-payload set");
    }
  }
}

/**
 * Execute the exact first payload. All input/evidence checks happen before the
 * first D1 write. This function never evaluates a watch and never invokes a
 * delivery boundary.
 */
export async function runFirstPayloadBackfill({
  db,
  subscriptions,
  ownerEmail,
  sourceSnapshots,
  deliveryEvidence,
  firstOwedAt,
  payloadId = FIRST_PAYLOAD_ID,
} = {}) {
  if (payloadId !== FIRST_PAYLOAD_ID) throw new BackfillInputError("unsupported backfill payload");
  if (!db?.prepare) throw new BackfillInputError("D1 database is required");
  const owedAt = validIso(firstOwedAt, "first_owed_at");
  const watches = await resolveBackfillWatches(subscriptions, ownerEmail);
  const acceptedAt = coverageEvidence(deliveryEvidence);
  const sections = snapshotSections(sourceSnapshots);
  await validateExistingRows(db, watches, sections, watches.subscriberId, acceptedAt);
  const land = await seedDeliveredLand(db, watches.land, watches.subscriberId, acceptedAt);
  const enqueue = await enqueueEvaluatedSections(db, sections.map((section) => ({
    ...section,
    watch_id: watches[section.lens].watch_id,
    subscriber_id: watches.subscriberId,
    source_observed_at: FIRST_PAYLOAD_SOURCE_DATE,
    owed_origin: FIRST_PAYLOAD_OWED_ORIGIN,
  })), {
    sourceObservedAt: FIRST_PAYLOAD_SOURCE_DATE,
    now: owedAt,
    owedOrigin: FIRST_PAYLOAD_OWED_ORIGIN,
    subscriberId: watches.subscriberId,
  });
  const counts = await countForSubscriber(db, watches.subscriberId);
  if (Number(counts?.owed_count) !== 45 || Number(counts?.delivered_count) !== 1) {
    throw new BackfillInputError("backfill result must contain exactly 45 owed rows and one delivered tombstone");
  }
  return {
    payload_id: FIRST_PAYLOAD_ID,
    subscriber_id: watches.subscriberId,
    resolved_watch_ids: {
      rules: watches.rules.watch_id,
      meetings: watches.meetings.watch_id,
      land: watches.land.watch_id,
    },
    matched_watch_count: watches.matchedWatchCount,
    land_tombstone: land,
    sections: enqueue.sections,
    enqueued: enqueue.enqueued,
    duplicates: enqueue.duplicates,
    backlog: {
      total_count: Number(counts.total_count),
      owed_count: Number(counts.owed_count),
      delivered_count: Number(counts.delivered_count),
    },
  };
}
