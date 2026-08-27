/**
 * Presentation-neutral calendar projection.
 *
 * Producers decide whether a source fact is something that happens, is due,
 * opens, closes, or is a milestone.  Consumers (ICS today, other calendar
 * formats later) only serialize the resulting occurrence.
 */

export const CALENDAR_OCCURRENCE_SCHEMA = "cityscroll.calendar_occurrence.v1";

export const CALENDAR_OCCURRENCE_KINDS = Object.freeze([
  "event",
  "deadline",
  "window_open",
  "window_close",
  "milestone",
]);

export const CALENDAR_OCCURRENCE_STATUSES = Object.freeze([
  "scheduled",
  "cancelled",
  "completed",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function validDate(value) {
  const result = text(value);
  if (!result) return null;
  if (ISO_DATE.test(result)) {
    const parsed = new Date(`${result}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === result ? result : null;
  }
  if (!ISO_DATE_TIME.test(result)) return null;
  return Number.isNaN(new Date(result).getTime()) ? null : result;
}

function safeUrl(value) {
  const result = text(value);
  if (!result) return null;
  try {
    const url = new URL(result);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function sourceValue(input) {
  if (input.source && typeof input.source === "object") return input.source;
  const url = safeUrl(input.source_url || input.official_source_url);
  const system = text(input.source_system);
  const recordId = text(input.source_record_id || input.publisher_identifier || input.request_id);
  if (!url && !system && !recordId) return null;
  return {
    ...(system ? { system } : {}),
    ...(recordId ? { record_id: recordId } : {}),
    ...(url ? { url } : {}),
  };
}

function objectRefForRecord(record = {}) {
  return text(record.object_ref || record.subject_ref || record.meeting_id
    || record.procurement_id || record.project_id || record.request_id || record.record_id);
}

function sourceForRecord(record = {}) {
  return sourceValue({
    ...record,
    source: record.source || record.source_provenance || record.provenance?.source,
    source_url: record.source_url || record.official_notice_url || record.official_source_url,
    source_record_id: record.source_record_id || record.publisher_identifier || record.request_id,
  });
}

function canonicalUrlForRecord(record = {}) {
  const direct = safeUrl(record.canonical_url);
  if (direct) return direct;
  if (record.canonical_href && String(record.canonical_href).startsWith("/")) {
    return `https://cityscroll.org${record.canonical_href}`;
  }
  const ref = objectRefForRecord(record);
  if (record.meeting_id || ref?.startsWith("meeting:")) return `https://cityscroll.org/meetings/${encodeURIComponent(ref)}/`;
  if (record.procurement_id || ref?.startsWith("procurement:")) return `https://cityscroll.org/procurements/${encodeURIComponent(ref)}`;
  if (record.project_id || ref?.startsWith("project:")) return `https://cityscroll.org/projects/${encodeURIComponent(ref)}`;
  if (record.request_id || ref?.startsWith("notice:")) return `https://cityscroll.org/notices/${encodeURIComponent(ref)}`;
  return null;
}

function sourceDate(record, keys) {
  for (const key of keys) {
    const value = validDate(record?.[key]);
    if (value) return value;
  }
  return null;
}

function dateIsOnly(value) {
  return Boolean(value && ISO_DATE.test(value));
}

function asOfDate(value) {
  const supplied = text(value);
  if (supplied && ISO_DATE.test(supplied)) return supplied;
  return new Date().toISOString().slice(0, 10);
}

function isFuture(value, asOf) {
  return dateIsOnly(value) ? value >= asOf : String(value).slice(0, 10) >= asOf;
}

function locationForRecord(record = {}) {
  if (record.location) return typeof record.location === "string" ? text(record.location) : record.location;
  const access = record.meeting_access || record.access || {};
  const mode = access.mode || record.modality;
  const remote = access.remote_join_url || record.remote_join_url || record.participation?.remote_join_url;
  if (remote && (mode === "remote" || mode === "online" || !record.venue)) return `Online — ${remote}`;
  const venue = record.venue || {};
  return text(access.in_person_location || venue.address || venue.name || record.address
    || [record.street_address_1, record.street_address_2, record.city, record.state, record.zip_code]
      .filter(Boolean).join(", "));
}

function defaultTitle(record, kind) {
  const reviewedTitle = record.calendar_titles?.[kind] || record.calendar_title;
  if (reviewedTitle) return text(reviewedTitle);
  const subject = text(record.title || record.short_title || record.name || record.exam_title
    || record.subject || record.description) || "civic record";
  if (kind === "window_open") return `Applications open — ${subject}`;
  if (kind === "window_close") return `Applications close — ${subject}`;
  if (kind === "deadline") return `Due — ${subject}`;
  return subject;
}

/**
 * Validate and normalize one occurrence. `starts_at` is a timestamp; `date`
 * is a publisher date-only value. They are mutually exclusive by design.
 */
export function createCalendarOccurrence(input = {}) {
  const uid = text(input.uid);
  const kind = text(input.kind);
  const status = text(input.status) || "scheduled";
  const startsAt = validDate(input.starts_at);
  const date = validDate(input.date);
  const endsAt = validDate(input.ends_at);
  if (!uid) throw new TypeError("CalendarOccurrence.uid is required");
  if (!input.scope_ref && !input.object_ref && !input.scope && !input.subject_ref) {
    throw new TypeError("CalendarOccurrence needs a scope_ref or object_ref");
  }
  if (!CALENDAR_OCCURRENCE_KINDS.includes(kind)) throw new TypeError(`unsupported calendar occurrence kind: ${kind}`);
  if (!CALENDAR_OCCURRENCE_STATUSES.includes(status)) throw new TypeError(`unsupported calendar occurrence status: ${status}`);
  if (startsAt && date) throw new TypeError("CalendarOccurrence cannot contain both starts_at and date");
  if (!startsAt && !date) throw new TypeError("CalendarOccurrence needs starts_at or date");
  if (endsAt && startsAt && dateIsOnly(endsAt)) throw new TypeError("CalendarOccurrence.ends_at must be a timestamp for timed occurrences");
  if (endsAt && date && endsAt < date) {
    throw new TypeError("CalendarOccurrence.ends_at cannot precede date");
  }
  if (endsAt && startsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
    throw new TypeError("CalendarOccurrence.ends_at cannot precede starts_at");
  }
  const canonicalUrl = safeUrl(input.canonical_url);
  return Object.freeze({
    schema: CALENDAR_OCCURRENCE_SCHEMA,
    uid,
    scope_ref: text(input.scope_ref || input.scope) || null,
    object_ref: text(input.object_ref || input.subject_ref) || null,
    kind,
    title: text(input.title) || "Civic calendar item",
    starts_at: startsAt,
    date: dateIsOnly(date) ? date : null,
    ends_at: endsAt,
    timezone: text(input.timezone) || null,
    status,
    location: input.location == null ? null : input.location,
    description: text(input.description) || null,
    canonical_url: canonicalUrl,
    source: input.source && typeof input.source === "object" ? input.source : null,
    provenance: input.provenance && typeof input.provenance === "object" ? input.provenance : null,
    observed_at: validDate(input.observed_at) || text(input.observed_at) || null,
  });
}

// Named export for consumers that treat the normalized object as a contract
// type rather than a factory.
export const CalendarOccurrence = createCalendarOccurrence;

function occurrenceInput(record, fields, options) {
  const objectRef = text(options.object_ref || objectRefForRecord(record));
  const uid = text(fields.uid) || (options.legacy_uid ? objectRef : `${objectRef}:${fields.kind}`);
  return {
    uid,
    scope_ref: options.scope_ref || record.scope_ref || record.scope,
    object_ref: objectRef,
    kind: fields.kind,
    title: fields.title || defaultTitle(record, fields.kind),
    ...(dateIsOnly(fields.when) ? { date: fields.when } : { starts_at: fields.when }),
    ends_at: fields.ends_at,
    timezone: fields.timezone || (Object.hasOwn(options, "timezone") ? options.timezone : record.timezone || "America/New_York"),
    status: fields.status || record.status || "scheduled",
    location: fields.location ?? locationForRecord(record),
    description: fields.description || options.description || record.calendar_description || record.description,
    canonical_url: fields.canonical_url || options.canonical_url || canonicalUrlForRecord(record),
    source: fields.source || options.source || sourceForRecord(record),
    provenance: fields.provenance || options.provenance || record.provenance || null,
    observed_at: fields.observed_at || options.observed_at || record.observed_at || record.observed_receipt?.observed_at,
  };
}

function explicitOccurrences(record, options) {
  if (!Array.isArray(record.calendar_occurrences)) return null;
  return record.calendar_occurrences.map((value) => createCalendarOccurrence(occurrenceInput(record, {
    ...value,
    when: value.starts_at || value.date,
  }, options)));
}

/**
 * Generic row adapter used by the existing feed while domain-specific
 * producers migrate. Notice publication fields (`start_date`, `published_at`)
 * are intentionally absent from every candidate below.
 */
export function calendarOccurrencesForRecord(record = {}, options = {}) {
  const explicit = explicitOccurrences(record, options);
  if (explicit) return explicit.filter((occurrence) => occurrence.status === "cancelled"
    || isFuture(occurrence.starts_at || occurrence.date, asOfDate(options.as_of)));
  const kind = options.kind || "event";
  const values = [];
  if (kind === "meetings" || kind === "meeting") {
    const when = sourceDate(record, ["event_date", "meeting_date", "starts_at"]);
    if (when) values.push({ kind: "event", when, ends_at: sourceDate(record, ["event_end", "ends_at", "end_at"]) });
  } else {
    const event = sourceDate(record, ["event_date", "starts_at"]);
    const deadline = sourceDate(record, ["deadline_date", "due_date", "action_deadline", "comment_by_date"]);
    if (event) values.push({ kind: "event", when: event });
    if (deadline) values.push({ kind: "deadline", when: deadline });
  }
  const open = sourceDate(record, ["application_open_date", "application_start_date", "window_open_date"]);
  const close = sourceDate(record, ["application_close_date", "application_end_date", "window_close_date"]);
  if (open) values.push({ kind: "window_open", when: open });
  if (close) values.push({ kind: "window_close", when: close });
  return values
    .filter((value) => isFuture(value.when, asOfDate(options.as_of)))
    .map((value) => createCalendarOccurrence(occurrenceInput(record, value, options)));
}

/** Compatibility producer for Cal-1 callers that still pass neutral items. */
export function calendarOccurrenceFromLegacyFeedItem(item = {}) {
  const when = validDate(item.eventDate);
  if (!when || !text(item.id)) return null;
  return createCalendarOccurrence({
    uid: item.id,
    object_ref: item.id,
    kind: "event",
    title: item.title,
    ...(dateIsOnly(when) ? { date: when } : { starts_at: when }),
    timezone: null,
    description: [item.summary, item.url].filter(Boolean).join(" · "),
  });
}

export function calendarOccurrencesForRows(rows = [], options = {}) {
  return rows.flatMap((record) => calendarOccurrencesForRecord(record, options));
}

function semanticDateKeys() {
  return ["event_date", "meeting_date", "starts_at", "deadline_date", "due_date", "action_deadline",
    "comment_by_date", "application_open_date", "application_start_date", "window_open_date",
    "application_close_date", "application_end_date", "window_close_date"];
}

function semanticDateValues(record = {}) {
  return semanticDateKeys().map((key) => record[key]).filter((value) => value != null && String(value).trim() !== "");
}

function recordHasMeaningfulFutureTime(record = {}, options = {}) {
  return semanticDateValues(record).some((value) => {
    const parsed = validDate(value);
    return parsed && isFuture(parsed, asOfDate(options.as_of));
  });
}

function recordHasAmbiguousDate(record = {}) {
  // A malformed semantic date is withheld even if another candidate on the same
  // record is usable. Publication-only fields are intentionally not included.
  return semanticDateValues(record).some((value) => !validDate(value));
}

/** Calendarization coverage is intentionally separate from source ingestion. */
export function calendarizationCoverage(records = [], occurrences = [], options = {}) {
  const sourceRecords = Array.isArray(records) ? records : [];
  const projected = Array.isArray(occurrences) ? occurrences : [];
  const matching = Number.isFinite(options.matching_scope) ? options.matching_scope : sourceRecords.length;
  const exact = projected.filter((item) => Boolean(item.starts_at)).length;
  const dateOnly = projected.filter((item) => Boolean(item.date)).length;
  return {
    schema: "cityscroll.calendarization_coverage.v1",
    records_matching_scope: matching,
    records_with_meaningful_future_time: sourceRecords.filter((record) =>
      recordHasMeaningfulFutureTime(record, options)).length,
    records_with_occurrences: new Set(projected.map((item) => item.object_ref).filter(Boolean)).size,
    occurrences_emitted: projected.length,
    with_exact_time: exact,
    date_only: dateOnly,
    withheld_for_ambiguity: sourceRecords.filter(recordHasAmbiguousDate).length,
  };
}

export function projectCalendarOccurrences(records = [], options = {}) {
  const occurrences = calendarOccurrencesForRows(records, options);
  return { occurrences, coverage: calendarizationCoverage(records, occurrences, options) };
}
