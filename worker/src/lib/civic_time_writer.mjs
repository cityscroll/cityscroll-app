/**
 * Flag-gated production writer for civic-time event envelopes.
 *
 * Adapters in civic_time.mjs remain pure (derive envelopes only). This module
 * optionally appends those envelopes to D1 so history can accumulate. Default
 * is OFF: with the flag unset/false, behavior is identical to the pure seam.
 *
 * Flag: CIVIC_TIME_EVENT_WRITE must equal the string "true" (case-insensitive).
 * Default: off (unset or any other value).
 *
 * ADR invariants (docs/adr/civic-time-event-contract.md):
 * - Never invent published_at from processed_at
 * - Never invent valid clocks from observed_at
 * - Source-null clocks persist as SQL NULL (not empty string or processing time)
 *
 * Public product surfaces do not read this table yet.
 */

import {
  CIVIC_TIME_SCHEMA_VERSION,
  isRegisteredEventKind,
  validateEnvelope,
} from "./civic_time.mjs";

/** Env flag — must be the string "true" (case-insensitive) to enable writes. */
export const CIVIC_TIME_EVENT_WRITE_FLAG = "CIVIC_TIME_EVENT_WRITE";

/** Default for docs / wrangler: off unless explicitly set to "true". */
export const CIVIC_TIME_EVENT_WRITE_DEFAULT = "false";

/** Narrow change-set seam consumed by civic-time selective rematerialization. */
export const CIVIC_TIME_SOURCE_CHANGE_SCHEMA = "cityscroll.civic_time_source_change.v1";
export const PASSPORT_RFX_REVISION_CHANGE_CLASS = "passport_rfx_revision";

/** Required columns on civic_time_events (migration 0019 contract). */
export const CIVIC_TIME_EVENT_COLUMNS = Object.freeze([
  "event_id",
  "schema_version",
  "subject_ref",
  "event_kind",
  "valid_at",
  "valid_from",
  "valid_to",
  "published_at",
  "observed_at",
  "processed_at",
  "source_record_ref",
  "source_revision",
  "payload_hash",
  "materializer_name",
  "materializer_version",
  "run_id",
  "status",
  "confidence",
  "supersedes_event_id",
  "source_field",
  "envelope_json",
  "written_at",
]);

export const CIVIC_TIME_EVENT_INSERT_SQL = `INSERT OR IGNORE INTO civic_time_events
  (event_id, schema_version, subject_ref, event_kind,
   valid_at, valid_from, valid_to, published_at, observed_at, processed_at,
   source_record_ref, source_revision, payload_hash,
   materializer_name, materializer_version, run_id,
   status, confidence, supersedes_event_id, source_field,
   envelope_json, written_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** Clock fields that must never be filled from another clock at write time. */
export const WRITER_CLOCK_FIELDS = Object.freeze([
  "valid_at",
  "valid_from",
  "valid_to",
  "published_at",
  "observed_at",
  "processed_at",
]);

/**
 * @param {object} [env]
 * @returns {boolean}
 */
export function civicTimeEventWriteEnabled(env) {
  return String(env?.[CIVIC_TIME_EVENT_WRITE_FLAG] || "").toLowerCase() === "true";
}

/**
 * Normalize a clock for SQL: preserve source-null as null; never coerce.
 * Empty string is treated as null (adapters use null for unknown).
 * @param {unknown} value
 * @returns {string|null}
 */
export function clockOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function valueOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function materializerVersion(event) {
  const name = valueOrNull(event?.materializer_name);
  const version = valueOrNull(event?.materializer_version);
  return {
    materializer_name: name,
    materializer_version: version,
  };
}

/**
 * Describe the one supported invalidation trigger: a revised PASSPort RFx
 * observation for the same subject and event kind. Other source families stay
 * unclassified instead of being routed through an inferred dependency.
 */
export function buildCivicTimeSourceChange(previousEvent, currentEvent) {
  if (!previousEvent || !currentEvent) return null;
  const sourceRecordRef = valueOrNull(currentEvent.source_record_ref);
  if (!sourceRecordRef?.startsWith("passport-rfx:")) return null;
  if (valueOrNull(previousEvent.source_record_ref) !== sourceRecordRef) return null;

  const subjectRef = valueOrNull(currentEvent.subject_ref);
  const eventKind = valueOrNull(currentEvent.event_kind);
  if (!subjectRef || !eventKind) return null;
  if (valueOrNull(previousEvent.subject_ref) !== subjectRef) return null;
  if (valueOrNull(previousEvent.event_kind) !== eventKind) return null;

  const previousRevision = valueOrNull(previousEvent.source_revision);
  const currentRevision = valueOrNull(currentEvent.source_revision);
  if (!previousRevision || !currentRevision || previousRevision === currentRevision) return null;

  return Object.freeze({
    schema: CIVIC_TIME_SOURCE_CHANGE_SCHEMA,
    change_class: PASSPORT_RFX_REVISION_CHANGE_CLASS,
    scope: Object.freeze({
      source_record_ref: sourceRecordRef,
      subject_ref: subjectRef,
      event_kind: eventKind,
    }),
    versions: Object.freeze({
      previous: Object.freeze({
        source_revision: previousRevision,
        payload_hash: valueOrNull(previousEvent.payload_hash),
        ...materializerVersion(previousEvent),
      }),
      current: Object.freeze({
        source_revision: currentRevision,
        payload_hash: valueOrNull(currentEvent.payload_hash),
        ...materializerVersion(currentEvent),
      }),
    }),
    clocks: Object.freeze({
      source: Object.freeze({
        valid_at: clockOrNull(currentEvent.valid_at),
        valid_from: clockOrNull(currentEvent.valid_from),
        valid_to: clockOrNull(currentEvent.valid_to),
        published_at: clockOrNull(currentEvent.published_at),
        observed_at: clockOrNull(currentEvent.observed_at),
      }),
      processing: Object.freeze({
        previous_processed_at: clockOrNull(previousEvent.processed_at),
        source_processed_at: clockOrNull(currentEvent.processed_at),
      }),
    }),
  });
}

async function readPriorCivicTimeEvent(env, event) {
  if (!String(event?.source_record_ref || "").startsWith("passport-rfx:")) return null;
  return env.DB.prepare(
    `SELECT event_id, subject_ref, event_kind, valid_at, valid_from, valid_to,
            published_at, observed_at, processed_at, source_record_ref,
            source_revision, payload_hash, materializer_name, materializer_version
       FROM civic_time_events
      WHERE source_record_ref = ? AND subject_ref = ? AND event_kind = ?
      ORDER BY COALESCE(written_at, processed_at, observed_at, valid_at, published_at) DESC,
               event_id DESC
      LIMIT 1`,
  ).bind(event.source_record_ref, event.subject_ref, event.event_kind).first();
}

/**
 * Map one validated envelope to a D1 bind tuple. Does not invent clocks.
 * @param {object} event
 * @param {string} writtenAt
 * @returns {Array<string|number|null>}
 */
export function bindCivicTimeEventRow(event, writtenAt) {
  return [
    String(event.event_id),
    Number.isFinite(Number(event.schema_version))
      ? Number(event.schema_version)
      : CIVIC_TIME_SCHEMA_VERSION,
    String(event.subject_ref),
    String(event.event_kind),
    clockOrNull(event.valid_at),
    clockOrNull(event.valid_from),
    clockOrNull(event.valid_to),
    clockOrNull(event.published_at),
    clockOrNull(event.observed_at),
    clockOrNull(event.processed_at),
    String(event.source_record_ref),
    String(event.source_revision),
    String(event.payload_hash),
    String(event.materializer_name),
    String(event.materializer_version),
    String(event.run_id),
    event.status != null && String(event.status).trim() !== ""
      ? String(event.status)
      : null,
    Number.isFinite(Number(event.confidence)) ? Number(event.confidence) : null,
    event.supersedes_event_id != null && String(event.supersedes_event_id).trim() !== ""
      ? String(event.supersedes_event_id)
      : null,
    event.source_field != null && String(event.source_field).trim() !== ""
      ? String(event.source_field)
      : null,
    JSON.stringify(event),
    String(writtenAt),
  ];
}

/**
 * Reject write-path clock invention: publication must not equal processing when
 * the envelope had no publication; valid must not equal observation when the
 * envelope had no valid clock. Used by tests and as a defense-in-depth guard.
 *
 * @param {object} event - envelope as shaped by adapters
 * @param {object} rowClocks - { published_at, processed_at, valid_at, observed_at, ... }
 * @throws {TypeError} when a write would invent a clock
 */
export function assertWriterClockHonesty(event, rowClocks) {
  const srcPub = event?.published_at ?? null;
  const srcValid = event?.valid_at ?? null;
  const srcValidFrom = event?.valid_from ?? null;
  const srcValidTo = event?.valid_to ?? null;
  const srcObs = event?.observed_at ?? null;
  const srcProc = event?.processed_at ?? null;

  const rowPub = rowClocks?.published_at ?? null;
  const rowProc = rowClocks?.processed_at ?? null;
  const rowValid = rowClocks?.valid_at ?? null;
  const rowValidFrom = rowClocks?.valid_from ?? null;
  const rowValidTo = rowClocks?.valid_to ?? null;
  const rowObs = rowClocks?.observed_at ?? null;

  // Source-null publication must stay null — never copy processing into publication.
  if (srcPub == null && rowPub != null) {
    throw new TypeError("writer invented published_at without a source publication clock");
  }
  // Publication must not equal processing solely because processing was copied in.
  if (srcPub == null && rowProc != null && rowPub === rowProc) {
    throw new TypeError("writer copied processed_at into published_at");
  }

  // Source-null valid clocks must stay null — never copy observation into valid.
  if (srcValid == null && rowValid != null) {
    throw new TypeError("writer invented valid_at without a source valid clock");
  }
  if (srcValidFrom == null && rowValidFrom != null) {
    throw new TypeError("writer invented valid_from without a source valid clock");
  }
  if (srcValidTo == null && rowValidTo != null) {
    throw new TypeError("writer invented valid_to without a source valid clock");
  }
  if (srcValid == null && rowObs != null && rowValid === rowObs) {
    throw new TypeError("writer copied observed_at into valid_at");
  }

  // Preserve source-null observation/processing independently (no cross-fill).
  if (srcObs == null && rowObs != null) {
    throw new TypeError("writer invented observed_at without a source observation clock");
  }
  if (srcProc == null && rowProc != null) {
    throw new TypeError("writer invented processed_at without a source processing clock");
  }
}

/**
 * Prepare a row from an envelope: validate, bind, and check clock honesty.
 * Returns null when the event is not writable.
 *
 * @param {object} event
 * @param {string} writtenAt
 * @returns {{ binds: Array, clocks: object, event: object } | null}
 */
export function prepareCivicTimeEventWrite(event, writtenAt) {
  if (!event || typeof event !== "object") return null;
  if (!event.event_id || !isRegisteredEventKind(event.event_kind)) return null;
  try {
    validateEnvelope(event);
  } catch {
    return null;
  }

  const clocks = {
    valid_at: clockOrNull(event.valid_at),
    valid_from: clockOrNull(event.valid_from),
    valid_to: clockOrNull(event.valid_to),
    published_at: clockOrNull(event.published_at),
    observed_at: clockOrNull(event.observed_at),
    processed_at: clockOrNull(event.processed_at),
  };
  assertWriterClockHonesty(event, clocks);
  return {
    event,
    clocks,
    binds: bindCivicTimeEventRow(event, writtenAt),
  };
}

/**
 * Runtime safety net: CREATE TABLE IF NOT EXISTS matching migration 0019.
 * Production deploys apply migrations; this covers local/test and skipped applies.
 *
 * @param {object} env
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function ensureCivicTimeEventSchema(env) {
  if (!env?.DB) return { ok: false, reason: "no-db" };
  const statements = [
    `CREATE TABLE IF NOT EXISTS civic_time_events (
        event_id              TEXT PRIMARY KEY,
        schema_version        INTEGER NOT NULL,
        subject_ref           TEXT NOT NULL,
        event_kind            TEXT NOT NULL,
        valid_at              TEXT,
        valid_from            TEXT,
        valid_to              TEXT,
        published_at          TEXT,
        observed_at           TEXT,
        processed_at          TEXT,
        source_record_ref     TEXT NOT NULL,
        source_revision       TEXT NOT NULL,
        payload_hash          TEXT NOT NULL,
        materializer_name     TEXT NOT NULL,
        materializer_version  TEXT NOT NULL,
        run_id                TEXT NOT NULL,
        status                TEXT,
        confidence            REAL,
        supersedes_event_id   TEXT,
        source_field          TEXT,
        envelope_json         TEXT NOT NULL,
        written_at            TEXT NOT NULL
      )`,
    "CREATE INDEX IF NOT EXISTS idx_civic_time_events_subject ON civic_time_events(subject_ref, event_kind)",
    "CREATE INDEX IF NOT EXISTS idx_civic_time_events_kind ON civic_time_events(event_kind)",
    "CREATE INDEX IF NOT EXISTS idx_civic_time_events_source ON civic_time_events(source_record_ref, source_revision)",
  ];
  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
  return { ok: true };
}

/**
 * Persist civic-time envelopes when CIVIC_TIME_EVENT_WRITE is enabled.
 * Flag off / missing DB → no-op. Fail-soft: never throws to callers.
 * Idempotent on event_id (INSERT OR IGNORE).
 *
 * @param {object} env - Worker env (DB + optional CIVIC_TIME_EVENT_WRITE)
 * @param {object[]} events - envelopes from map*ToCivic / attachMoneyCivicEvents
 * @param {{ written_at?: string, now?: string }} [opts]
 * @returns {Promise<{ written: number, considered: number, skipped?: string, errors?: number, changes: object[] }>}
 */
export async function writeCivicTimeEvents(env, events, opts = {}) {
  if (!civicTimeEventWriteEnabled(env)) {
    return { written: 0, considered: 0, skipped: "flag-off", changes: [] };
  }
  if (!env?.DB) {
    return { written: 0, considered: 0, skipped: "no-db", changes: [] };
  }

  const list = Array.isArray(events) ? events : [];
  const writtenAt = opts.written_at || opts.now || new Date().toISOString();
  let considered = 0;
  let written = 0;
  let errors = 0;
  const changes = [];

  try {
    await ensureCivicTimeEventSchema(env);
  } catch {
    return { written: 0, considered: list.length, skipped: "schema-error", errors: 1, changes };
  }

  for (const event of list) {
    considered += 1;
    let prepared;
    try {
      prepared = prepareCivicTimeEventWrite(event, writtenAt);
    } catch {
      errors += 1;
      continue;
    }
    if (!prepared) continue;
    try {
      let previous = null;
      try {
        previous = await readPriorCivicTimeEvent(env, event);
      } catch {
        // Change detection is additive; a failed lookup must not suppress the
        // established append-only civic-time write.
      }
      await env.DB.prepare(CIVIC_TIME_EVENT_INSERT_SQL).bind(...prepared.binds).run();
      written += 1;
      const change = buildCivicTimeSourceChange(previous, event);
      if (change) changes.push(change);
    } catch {
      errors += 1;
    }
  }

  return { written, considered, errors, changes };
}

/**
 * Convenience: write civic_events from a lifecycle payload (Money production path).
 * Pure attach remains separate; this only persists when the flag is on.
 *
 * @param {object} env
 * @param {object} lifecycle - payload with optional civic_events[]
 * @param {{ written_at?: string, now?: string }} [opts]
 */
export async function writeLifecycleCivicEvents(env, lifecycle, opts = {}) {
  const events = Array.isArray(lifecycle?.civic_events) ? lifecycle.civic_events : [];
  return writeCivicTimeEvents(env, events, opts);
}
