/**
 * Presentation-neutral calendar projection.
 *
 * Producers decide whether a source fact is something that happens, is due,
 * opens, closes, or is a milestone.  Consumers (ICS today, other calendar
 * formats later) only serialize the resulting occurrence.
 */

const CALENDAR_OCCURRENCE_SCHEMA = "cityscroll.calendar_occurrence.v1";

const CALENDAR_OCCURRENCE_KINDS = Object.freeze([
  "event",
  "deadline",
  "window_open",
  "window_close",
  "milestone",
]);

const CALENDAR_OCCURRENCE_STATUSES = Object.freeze([
  "scheduled",
  "cancelled",
  "completed",
]);

// Lifecycle is the source-facing history of an occurrence. `status` remains
// the compact calendar status used by existing producers and ICS consumers.
const CALENDAR_OCCURRENCE_LIFECYCLES = Object.freeze([
  "published",
  "scheduled",
  "rescheduled",
  "cancelled",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
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
  const us = result.match(US_DATE);
  if (us) {
    const normalized = `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    const parsed = new Date(`${normalized}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized ? normalized : null;
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
    || record.procurement_id || record.project_id || record.request_id || record.record_id
    || (record.exam_number ? `exam:${record.exam_number}` : null));
}

function sourceForRecord(record = {}) {
  return sourceValue({
    ...record,
    source: record.source || record.source_provenance || record.provenance?.source,
    source_url: record.source_url || record.notice_url || record.official_notice_url
      || record.official_source_url || record.official_application_url,
    source_record_id: record.source_record_id || record.publisher_identifier || record.request_id || record.exam_number,
  });
}

function recordIsCancelled(record = {}) {
  if (record.status === "cancelled" || record.lifecycle === "cancelled") return true;
  // City Record cancellation notices often publish the cancellation in the
  // notice title/body instead of a typed status field. Require explicit
  // cancellation language; unrelated publication text remains unknown.
  const sourceText = [record.title, record.short_title, record.type_of_notice_description,
    record.notice_type, record.status_label, record.additional_description_1,
    record.additional_description_2, record.cancellation_notice].filter(Boolean).join(" ");
  return /\b(?:cancelled|canceled)\b/i.test(sourceText);
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
  if (record.exam_number || ref?.startsWith("exam:")) return `https://cityscroll.org/exams/${encodeURIComponent(String(record.exam_number || ref).replace(/^exam:/, ""))}/`;
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
  // determinism-lint: allow clock the caller-supplied as-of wins on the line above; this is the arm taken when nothing was supplied.
  return new Date().toISOString().slice(0, 10);
}

function sequenceValue(value) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null;
}

function timestampValue(value) {
  const normalized = validDate(value);
  return normalized && !dateIsOnly(normalized) ? normalized : null;
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

const PROCUREMENT_DATE_FIELDS = Object.freeze([
  ["deadline", ["bid_deadline", "proposal_deadline", "due_date", "deadline_date"], "Bids due"],
  ["questions_deadline", ["questions_deadline", "questions_due_date", "question_deadline", "inquiries_deadline"], "Questions due"],
  ["pre_bid_conference", ["pre_bid_conference_date", "pre_bid_date"], "Pre-bid conference"],
  ["pre_proposal_conference", ["pre_proposal_conference_date", "pre_proposal_date"], "Pre-proposal conference"],
]);

const EXAM_DATE_FIELDS = Object.freeze([
  ["window_open", ["application_open_date", "application_start_date", "application_start"]],
  ["deadline", ["application_close_date", "application_end_date", "application_end"]],
  ["event", ["exam_date", "scheduled_exam_date", "examination_date", "test_date"]],
]);

function isExamRecord(record, options) {
  return options.kind === "exam"
    || Boolean(record.exam_number)
    || /^exam:/.test(String(record.object_ref || record.subject_ref || ""));
}

function milestoneTitle(record, label, kind) {
  const subject = text(record.title || record.short_title || record.name || record.subject) || "civic record";
  return `${label || defaultTitle(record, kind)} — ${subject}`;
}

function explicitMilestones(record) {
  const input = Array.isArray(record.procurement_milestones)
    ? record.procurement_milestones
    : Array.isArray(record.milestones) ? record.milestones : [];
  return input.flatMap((milestone) => {
    if (!milestone || typeof milestone !== "object") return [];
    const when = validDate(milestone.date || milestone.starts_at || milestone.when);
    const label = text(milestone.label || milestone.name || milestone.type);
    if (!when || !label) return [];
    const normalized = String(milestone.kind || "milestone").trim();
    const kind = CALENDAR_OCCURRENCE_KINDS.includes(normalized) ? normalized : "milestone";
    return [{
      kind,
      when,
      uid_suffix: text(milestone.uid),
      title: milestone.title || `${label} — ${text(record.title || record.short_title || "solicitation")}`,
      provenance: { basis: "publisher_record", source_field: "procurement_milestones", label },
    }];
  });
}

function labeledTextMilestones(record) {
  const textFields = ["additional_description_1", "additional_description_2", "additional_description_3",
    "other_info_1", "other_info_2", "other_info_3", "printout_1"];
  const source = textFields.map((key) => String(record?.[key] || "")).join(" ");
  if (!source) return [];
  const patterns = [
    ["questions_deadline", /(?:questions?|inquiries?)\s+(?:deadline|due|close|accepted until)\s*[:\-]\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i, "Questions due"],
    ["pre_bid_conference", /pre[- ]bid(?: conference)?\s*(?:date|on)?\s*[:\-]\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i, "Pre-bid conference"],
    ["pre_proposal_conference", /pre[- ]proposal(?: conference)?\s*(?:date|on)?\s*[:\-]\s*(\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})/i, "Pre-proposal conference"],
  ];
  return patterns.flatMap(([uidKind, pattern, label]) => {
    const match = source.match(pattern);
    const when = validDate(match?.[1]);
    return when ? [{ kind: uidKind === "questions_deadline" ? "deadline" : "milestone", when,
      uid_suffix: uidKind, title: milestoneTitle(record, label, uidKind === "questions_deadline" ? "deadline" : "milestone"),
      provenance: { basis: "publisher_record", source_fields: textFields, label } }] : [];
  });
}

function domainOccurrences(record, options) {
  const exam = isExamRecord(record, options);
  if (exam) {
    return EXAM_DATE_FIELDS.flatMap(([kind, keys]) => {
      const when = sourceDate(record, keys);
      if (!when) return [];
      return [{ kind, when, force_typed_uid: true,
        title: kind === "window_open" ? milestoneTitle(record, "Applications open", kind)
          : kind === "deadline" ? milestoneTitle(record, "Applications close", kind)
            : milestoneTitle(record, "Exam date", kind),
        provenance: { basis: "publisher_record", source_fields: keys } }];
    });
  }
  if (options.kind !== "rfp" && options.kind !== "procurement" && !record.procurement_milestones && !record.milestones) return null;
  const fields = PROCUREMENT_DATE_FIELDS.flatMap(([uidKind, keys, label]) => {
    const when = sourceDate(record, keys);
    if (!when) return [];
    const kind = uidKind === "deadline" || uidKind === "questions_deadline" ? "deadline" : "milestone";
    return [{ kind, when, force_typed_uid: true, uid_suffix: uidKind,
      title: milestoneTitle(record, label, kind), provenance: { basis: "publisher_record", source_fields: keys } }];
  });
  return [...fields, ...explicitMilestones(record), ...labeledTextMilestones(record)];
}

/**
 * Validate and normalize one occurrence. `starts_at` is a timestamp; `date`
 * is a publisher date-only value. They are mutually exclusive by design.
 */
function createCalendarOccurrence(input = {}) {
  const uid = text(input.uid);
  const kind = text(input.kind);
  const status = text(input.status) || "scheduled";
  const suppliedLifecycle = text(input.lifecycle || input.occurrence_lifecycle);
  const lifecycle = suppliedLifecycle || (status === "cancelled" ? "cancelled" : "scheduled");
  const sequence = sequenceValue(input.sequence);
  const effectiveSequence = sequence ?? (lifecycle === "rescheduled" ? 1 : null);
  const lastModified = timestampValue(input.last_modified || input.modified_at);
  const startsAt = validDate(input.starts_at);
  const date = validDate(input.date);
  const endsAt = validDate(input.ends_at);
  if (!uid) throw new TypeError("CalendarOccurrence.uid is required");
  if (!input.scope_ref && !input.object_ref && !input.scope && !input.subject_ref) {
    throw new TypeError("CalendarOccurrence needs a scope_ref or object_ref");
  }
  if (!CALENDAR_OCCURRENCE_KINDS.includes(kind)) throw new TypeError(`unsupported calendar occurrence kind: ${kind}`);
  if (!CALENDAR_OCCURRENCE_STATUSES.includes(status)) throw new TypeError(`unsupported calendar occurrence status: ${status}`);
  if (!CALENDAR_OCCURRENCE_LIFECYCLES.includes(lifecycle)) throw new TypeError(`unsupported calendar occurrence lifecycle: ${lifecycle}`);
  if (status === "cancelled" && lifecycle !== "cancelled") throw new TypeError("cancelled occurrences must have a cancelled lifecycle");
  if (lifecycle === "cancelled" && status !== "cancelled") throw new TypeError("cancelled lifecycle requires cancelled status");
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
    lifecycle,
    sequence: effectiveSequence,
    last_modified: lastModified,
    location: input.location == null ? null : input.location,
    description: text(input.description) || null,
    canonical_url: canonicalUrl,
    source: input.source && typeof input.source === "object" ? input.source : null,
    provenance: input.provenance && typeof input.provenance === "object" ? input.provenance : null,
    observed_at: validDate(input.observed_at) || text(input.observed_at) || null,
  });
}

// Public alias for consumers that treat the normalized object as a contract
// type rather than a factory.
const CalendarOccurrence = createCalendarOccurrence;

function occurrenceInput(record, fields, options) {
  const objectRef = text(options.object_ref || objectRefForRecord(record));
  const uid = text(fields.uid)
    || (text(fields.uid_suffix) ? `${objectRef}:${text(fields.uid_suffix)}`
      : (options.legacy_uid && !fields.force_typed_uid ? objectRef : `${objectRef}:${fields.kind}`));
  return {
    uid,
    scope_ref: options.scope_ref || record.scope_ref || record.scope,
    object_ref: objectRef,
    kind: fields.kind,
    title: fields.title || defaultTitle(record, fields.kind),
    ...(dateIsOnly(fields.when) ? { date: fields.when } : { starts_at: fields.when }),
    ends_at: fields.ends_at,
    timezone: fields.timezone || (Object.hasOwn(options, "timezone") ? options.timezone : record.timezone || "America/New_York"),
    status: fields.status || record.status || (recordIsCancelled(record) ? "cancelled" : "scheduled"),
    lifecycle: fields.lifecycle || record.lifecycle || record.occurrence_lifecycle
      || (fields.status === "cancelled" || recordIsCancelled(record) ? "cancelled" : null),
    sequence: fields.sequence ?? record.sequence ?? record.sequence_number ?? record.revision
      ?? record.source_sequence ?? record.source_revision ?? record.provenance?.revision,
    last_modified: fields.last_modified || fields.modified_at || record.last_modified
      || record.modified_at || record.updated_at || record.source_modified_at
      || record.source_last_modified,
    location: fields.location ?? locationForRecord(record),
    description: fields.description || options.description || record.calendar_description || record.description,
    canonical_url: fields.canonical_url || options.canonical_url || canonicalUrlForRecord(record),
    source: fields.source || options.source || sourceForRecord(record),
    provenance: fields.provenance || options.provenance || record.provenance
      || (Array.isArray(record.sources) ? { basis: "publisher_record", source_records: record.sources } : null),
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
 * Generic candidate values used by the existing feed while domain-specific
 * producers migrate. Notice publication fields (`start_date`, `published_at`)
 * are intentionally absent from every candidate below. Values are returned
 * unfiltered; temporal filtering is applied by each consumer.
 */
function genericOccurrenceValues(record = {}, options = {}) {
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
  if (close) values.push({ kind: isExamRecord(record, options) ? "deadline" : "window_close", when: close });
  return values;
}

/**
 * Generic row adapter used by the existing feed while domain-specific
 * producers migrate. Future-only by construction: the standing feed only ever
 * surfaces upcoming occurrences, plus explicit cancellations that retain their
 * identity. Historical display is served by the separate bounded display path.
 */
function calendarOccurrencesForRecord(record = {}, options = {}) {
  const explicit = explicitOccurrences(record, options);
  if (explicit) return explicit.filter((occurrence) => occurrence.status === "cancelled"
    || isFuture(occurrence.starts_at || occurrence.date, asOfDate(options.as_of)));
  const domain = domainOccurrences(record, options);
  if (domain) {
    return domain
      .filter((value) => isFuture(value.when, asOfDate(options.as_of)))
      .map((value) => createCalendarOccurrence(occurrenceInput(record, value, options)));
  }
  return genericOccurrenceValues(record, options)
    .filter((value) => isFuture(value.when, asOfDate(options.as_of)))
    .map((value) => createCalendarOccurrence(occurrenceInput(record, value, options)));
}

/**
 * Presentation-neutral production of every occurrence a record supports, with
 * no temporal filter. This is the seam the bounded display query builds on: it
 * separates *what a record means* (an occurrence with a real date, identity,
 * source, and destination) from *which window is being queried*. The standing
 * feed never calls this — it keeps its future-only default above — so exposing
 * past occurrences here cannot widen a subscription.
 */
function displayCandidateOccurrencesForRecord(record = {}, options = {}) {
  const explicit = explicitOccurrences(record, options);
  if (explicit) return explicit;
  const domain = domainOccurrences(record, options);
  if (domain) return domain.map((value) => createCalendarOccurrence(occurrenceInput(record, value, options)));
  return genericOccurrenceValues(record, options)
    .map((value) => createCalendarOccurrence(occurrenceInput(record, value, options)));
}

/** Compatibility producer for Cal-1 callers that still pass neutral items. */
function calendarOccurrenceFromLegacyFeedItem(item = {}) {
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

function calendarOccurrencesForRows(rows = [], options = {}) {
  return deduplicateCalendarOccurrences(rows.flatMap((record) => calendarOccurrencesForRecord(record, options)));
}

function deduplicateCalendarOccurrences(occurrences = []) {
  const byUid = new Map();
  occurrences.forEach((occurrence, index) => {
    if (!occurrence?.uid) return;
    const current = byUid.get(occurrence.uid);
    if (!current || occurrenceIsNewer(occurrence, current, index)) byUid.set(occurrence.uid, occurrence);
  });
  return [...byUid.values()];
}

function occurrenceIsNewer(candidate, current, candidateIndex) {
  const candidateSequence = candidate.sequence ?? -1;
  const currentSequence = current.sequence ?? -1;
  if (candidateSequence !== currentSequence) return candidateSequence > currentSequence;
  const candidateModified = Date.parse(candidate.last_modified || candidate.observed_at || "") || -1;
  const currentModified = Date.parse(current.last_modified || current.observed_at || "") || -1;
  if (candidateModified !== currentModified) return candidateModified > currentModified;
  // If a source sends a cancellation without a revision clock, retain the
  // identity and prefer the cancellation over a same-UID scheduled copy.
  if (candidate.status !== current.status) return candidate.status === "cancelled";
  return candidateIndex > 0;
}

function semanticDateKeys() {
  return ["event_date", "meeting_date", "starts_at", "deadline_date", "due_date", "action_deadline",
    "comment_by_date", "application_open_date", "application_start_date", "window_open_date",
    "application_close_date", "application_end_date", "window_close_date", "application_start", "application_end",
    "exam_date", "scheduled_exam_date", "examination_date", "test_date", "bid_deadline", "proposal_deadline",
    "questions_deadline", "questions_due_date", "pre_bid_conference_date", "pre_proposal_conference_date"];
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
function calendarizationCoverage(records = [], occurrences = [], options = {}) {
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

function projectCalendarOccurrences(records = [], options = {}) {
  const occurrences = calendarOccurrencesForRows(records, options);
  return { occurrences, coverage: calendarizationCoverage(records, occurrences, options) };
}

export {
  CALENDAR_OCCURRENCE_SCHEMA,
  CALENDAR_OCCURRENCE_KINDS,
  CALENDAR_OCCURRENCE_STATUSES,
  CALENDAR_OCCURRENCE_LIFECYCLES,
  CalendarOccurrence,
  createCalendarOccurrence,
  calendarOccurrencesForRecord,
  displayCandidateOccurrencesForRecord,
  calendarOccurrenceFromLegacyFeedItem,
  calendarOccurrencesForRows,
  deduplicateCalendarOccurrences,
  recordHasAmbiguousDate,
  calendarizationCoverage,
  projectCalendarOccurrences,
};
