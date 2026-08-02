// Immutable Legistar meeting observations for entity-resolution replay.
// Meeting-outcomes materialization still folds Events / EventItems / Votes /
// Attachments into the public KV view; when dual-write is enabled the raw
// publisher rows are retained independently under stable source keys.
// Shadow only: public meeting-outcomes reads do not consume these rows.

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
  sourceRecordDualWriteEnabled,
} from "./source_records.mjs";

export const LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG = "LEGISTAR_SOURCE_RECORD_DUAL_WRITE";
export const LEGISTAR_EVENTS_SOURCE_SYSTEM = "nyc_legistar_events";
export const LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM = "nyc_legistar_event_items";
export const LEGISTAR_VOTES_SOURCE_SYSTEM = "nyc_legistar_votes";
export const LEGISTAR_ATTACHMENTS_SOURCE_SYSTEM = "nyc_legistar_attachments";

/** D1 batch size for observation inserts (bound statements stay under request limits). */
export const LEGISTAR_SOURCE_RECORD_BATCH = 40;

function normPart(value, fallback = "unknown") {
  const s = String(value ?? "").trim();
  return s || fallback;
}

function readFirst(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === 0 || value === false) return value;
    if (value !== null && value !== undefined) {
      const text = String(value).trim();
      if (text !== "") return text;
    }
  }
  return null;
}

/**
 * Publisher-stable identity for one Legistar Event row.
 * Shape: event:<EventId>
 */
export function legistarEventSourceSystemId(row) {
  const id = normPart(
    readFirst(row, ["EventId", "eventId", "Event_ID", "id"]),
    "no-event-id",
  );
  return `event:${id}`;
}

/**
 * Publisher-stable identity for one Legistar EventItem row.
 * Shape: event-item:<EventItemId>
 */
export function legistarEventItemSourceSystemId(row) {
  const id = normPart(
    readFirst(row, ["EventItemId", "EventItemID", "AgendaItemId", "id"]),
    "no-event-item-id",
  );
  return `event-item:${id}`;
}

/**
 * Publisher-stable identity for one person-level Legistar vote row.
 * Shape: vote:<EventItemId>:<PersonId>
 */
export function legistarVoteSourceSystemId(row) {
  const itemId = normPart(
    readFirst(row, ["EventItemId", "EventItemID", "agenda_item_id", "itemId"]),
    "no-event-item-id",
  );
  const personId = normPart(
    readFirst(row, ["PersonId", "PersonID", "person_id", "personId"]),
    "no-person-id",
  );
  return `vote:${itemId}:${personId}`;
}

/**
 * Publisher-stable identity for one Legistar attachment row.
 * Shape: attachment:<EventItemId>:<AttachmentId>
 */
export function legistarAttachmentSourceSystemId(row) {
  const itemId = normPart(
    readFirst(row, ["EventItemId", "EventItemID", "agenda_item_id", "itemId"]),
    "no-event-item-id",
  );
  const attachId = normPart(
    readFirst(row, [
      "MatterAttachmentId",
      "AttachmentId",
      "AttachmentID",
      "Id",
      "id",
    ]),
    "no-attachment-id",
  );
  return `attachment:${itemId}:${attachId}`;
}

async function writeStreamChunks(env, insert, sourceSystem, idFn, rows, ingestedAt) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) {
    return { source_system: sourceSystem, written: 0, skipped: "empty", failed: false };
  }

  let written = 0;
  try {
    for (let i = 0; i < list.length; i += LEGISTAR_SOURCE_RECORD_BATCH) {
      const chunk = list.slice(i, i + LEGISTAR_SOURCE_RECORD_BATCH);
      const stmts = await Promise.all(chunk.map(async (row) => {
        const snapshot = { ...row };
        return insert.bind(
          sourceSystem,
          idFn(row),
          await computeSourceRecordHash(snapshot),
          JSON.stringify(snapshot),
          JSON.stringify(snapshot),
          ingestedAt,
        );
      }));
      await env.DB.batch(stmts);
      written += chunk.length;
    }
    return { source_system: sourceSystem, written, skipped: null, failed: false };
  } catch (err) {
    const message = String(err?.message || err || "batch-failed");
    console.error(
      "legistar source_records dual-write failed:",
      sourceSystem,
      `written_before_fail=${written}`,
      message,
    );
    return {
      source_system: sourceSystem,
      written,
      skipped: null,
      failed: true,
      error: message,
    };
  }
}

/**
 * Fail-soft dual-write of raw Legistar meeting rows into source_records.
 * Never throws; never blocks meeting-outcomes KV materialization.
 * Streams are isolated so one failed bag cannot zero another stream's writes.
 *
 * @param {object} env
 * @param {{ events?: object[], eventItems?: object[], votes?: object[], attachments?: object[] }} bags
 * @param {string} [ingestedAt]
 * @returns {Promise<{
 *   written: number,
 *   skipped: string|null,
 *   failed: boolean,
 *   streams: Array<{source_system: string, written: number, skipped: string|null, failed: boolean, error?: string}>
 * }>}
 */
export async function dualWriteLegistarObservations(env, bags = {}, ingestedAt) {
  if (!sourceRecordDualWriteEnabled(env, LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { written: 0, skipped: "flag-off", failed: false, streams: [] };
  }
  if (!env?.DB) return { written: 0, skipped: "no-db", failed: false, streams: [] };

  let insert;
  try {
    insert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
  } catch {
    return { written: 0, skipped: "no-schema", failed: false, streams: [] };
  }

  const streamDefs = [
    {
      sourceSystem: LEGISTAR_EVENTS_SOURCE_SYSTEM,
      rows: bags.events,
      idFn: legistarEventSourceSystemId,
    },
    {
      sourceSystem: LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM,
      rows: bags.eventItems,
      idFn: legistarEventItemSourceSystemId,
    },
    {
      sourceSystem: LEGISTAR_VOTES_SOURCE_SYSTEM,
      rows: bags.votes,
      idFn: legistarVoteSourceSystemId,
    },
    {
      sourceSystem: LEGISTAR_ATTACHMENTS_SOURCE_SYSTEM,
      rows: bags.attachments,
      idFn: legistarAttachmentSourceSystemId,
    },
  ];

  const at = ingestedAt || new Date().toISOString();
  const streams = [];
  for (const def of streamDefs) {
    // Isolate each stream so a single bag failure cannot roll back others.
    // eslint-disable-next-line no-await-in-loop
    const result = await writeStreamChunks(env, insert, def.sourceSystem, def.idFn, def.rows, at);
    streams.push(result);
  }

  const written = streams.reduce((sum, s) => sum + (s.written || 0), 0);
  const failed = streams.some((s) => s.failed);
  const allEmpty = streams.every((s) => s.skipped === "empty" || s.written === 0);
  let skipped = null;
  if (!written && !failed && allEmpty) skipped = "empty";
  if (!written && failed) skipped = "failed";

  if (failed) {
    console.error(
      "legistar source_records dual-write summary:",
      JSON.stringify({ written, failed, streams }),
    );
  }

  return { written, skipped, failed, streams };
}
