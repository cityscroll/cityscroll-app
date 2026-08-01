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

/**
 * Fail-soft dual-write of raw Legistar meeting rows into source_records.
 * Never throws; never blocks meeting-outcomes KV materialization.
 *
 * @param {object} env
 * @param {{ events?: object[], eventItems?: object[], votes?: object[], attachments?: object[] }} bags
 * @param {string} [ingestedAt]
 */
export async function dualWriteLegistarObservations(env, bags = {}, ingestedAt) {
  if (!sourceRecordDualWriteEnabled(env, LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { written: 0, skipped: "flag-off" };
  }
  if (!env?.DB) return { written: 0, skipped: "no-db" };

  let insert;
  try {
    insert = env.DB.prepare(SOURCE_RECORD_INSERT_SQL);
  } catch {
    return { written: 0, skipped: "no-schema" };
  }

  const streams = [
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
  let written = 0;
  try {
    for (const stream of streams) {
      const list = Array.isArray(stream.rows) ? stream.rows.filter(Boolean) : [];
      if (!list.length) continue;
      const stmts = await Promise.all(list.map(async (row) => {
        const snapshot = { ...row };
        return insert.bind(
          stream.sourceSystem,
          stream.idFn(row),
          await computeSourceRecordHash(snapshot),
          JSON.stringify(snapshot),
          JSON.stringify(snapshot),
          at,
        );
      }));
      await env.DB.batch(stmts);
      written += list.length;
    }
    return { written, skipped: written ? null : "empty" };
  } catch {
    return { written: 0, failed: true };
  }
}
