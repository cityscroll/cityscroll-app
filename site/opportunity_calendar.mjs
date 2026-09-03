/**
 * Opportunity-bundle adapter for the shared compact month (CBICS-07).
 *
 * A procurement solicitation or property disposition notice can carry several
 * actionable dates — a pre-bid conference, a questions deadline, showings, a
 * bid deadline — that today read as prose, chips, or process-event rows. This
 * module decides only *which source facts become opportunity occurrences* and
 * hands the resulting bundle to the one shared bounded-display pipeline and
 * compact month component (CBICS-01 + CBICS-02). It does not decide density
 * (that is the commissioned rule inside the shared view model), render its own
 * grid, or widen any feed scope.
 *
 * Scope discipline mirrored from the card:
 *
 *   - Opportunity dates only. Award, registration, conveyance, result, and
 *     payment history stay in the existing lifecycle spine; this adapter never
 *     emits occurrences for them, so a multi-year contract history cannot
 *     stretch the month view.
 *   - Source-observed dates only. Relative-rule-derived property deadlines
 *     (for example an accommodation window derived as N business days before a
 *     hearing) and low-confidence dates are excluded from confirmed cells; they
 *     remain visible in the existing dated-event presentation below.
 *   - Publication-only timestamps (a notice's own `start_date`, `published_at`)
 *     are never copied onto a record, so they can never become occurrences.
 *
 * Everything here is pure: no clock, no I/O. Callers supply `today` explicitly;
 * a caller that cannot name the day gets no calendar, never a hidden clock.
 */

import {
  classifyDisplayRecord,
} from "./calendar_display.mjs";
import {
  deduplicateCalendarOccurrences,
} from "./calendar_occurrence.mjs";
import {
  buildCompactMonthView,
  renderCompactMonth,
} from "./compact_calendar.mjs";

export const OPPORTUNITY_CALENDAR_SCHEMA = "cityscroll.opportunity_calendar_bundle.v1";

const OPPORTUNITY_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Publisher fields that carry opportunity semantics on procurement source
// snapshots. Publication-only fields are deliberately absent: copying a notice
// `start_date` here would let a publication timestamp masquerade as an event.
const PROCUREMENT_OPPORTUNITY_DATE_FIELDS = Object.freeze([
  "bid_deadline", "proposal_deadline", "due_date", "deadline_date",
  "questions_deadline", "questions_due_date", "question_deadline", "inquiries_deadline",
  "pre_bid_conference_date", "pre_bid_date",
  "pre_proposal_conference_date", "pre_proposal_date",
]);

// Free-text notice fields the occurrence projection mines for labeled
// conference / questions milestones. Copied so City Record prose keeps working.
const PROCUREMENT_OPPORTUNITY_TEXT_FIELDS = Object.freeze([
  "short_title", "title",
  "additional_description_1", "additional_description_2", "additional_description_3",
  "other_info_1", "other_info_2", "other_info_3", "printout_1",
  "type_of_notice_description",
]);

// Markers a publisher snapshot may carry that classifyDisplayRecord turns into
// an exclusion (A4). Copied verbatim so the shared boundary, not this module,
// remains the one place eligibility is decided.
const PROCUREMENT_CONFIDENCE_MARKERS = Object.freeze([
  "confidence", "low_confidence", "derived", "date_basis",
]);

const CITY_RECORD_SOURCE_URL_BASE = "https://a856-cityrecord.nyc.gov/RequestDetail/";

function opportunityText(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function opportunityIsDateOnly(value) {
  return typeof value === "string" && OPPORTUNITY_ISO_DATE.test(value);
}

/* ---------- procurement: observations -> display records ---------- */

function passportRfxSourceUrl(snapshot) {
  return opportunityText(snapshot?.official_url || snapshot?.source_url) || null;
}

function cityRecordSourceUrl(snapshot) {
  const direct = opportunityText(snapshot?.official_url || snapshot?.source_url);
  if (direct) return direct;
  const requestId = opportunityText(snapshot?.request_id);
  return requestId ? `${CITY_RECORD_SOURCE_URL_BASE}${encodeURIComponent(requestId)}` : null;
}

// Sources whose snapshots can carry opportunity dates. Contract, spending, and
// award sources are absent by design: award/registration/payment history is
// lifecycle, not opportunity (A5).
const PROCUREMENT_OPPORTUNITY_SOURCE_SYSTEMS = new Set([
  "passport_public_rfx",
  "city_record",
  "city_record_procurement",
  "crol",
  "nys_contract_reporter",
  "mta_current_opportunities",
]);

/**
 * Build one display record per in-scope retained observation. Each record is
 * shaped so the shared CBICS-01 classifier — not this module — decides which
 * candidates are eligible display occurrences.
 */
export function procurementOpportunityRecords(object = {}, observations = []) {
  const procurementId = opportunityText(object?.procurement_id);
  if (!procurementId || !procurementId.startsWith("procurement:")) return [];
  const refs = new Set(Array.isArray(object.source_observation_refs) ? object.source_observation_refs : []);
  if (!refs.size) return [];
  const canonicalUrl = `https://cityscroll.org/procurements/${encodeURIComponent(procurementId)}`;

  const records = [];
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (!observation || !refs.has(observation?.source_observation_ref)) continue;
    const system = opportunityText(observation.source_system)?.toLowerCase();
    if (!PROCUREMENT_OPPORTUNITY_SOURCE_SYSTEMS.has(system)) continue;
    const snapshot = observation?.snapshot && typeof observation.snapshot === "object" ? observation.snapshot : {};

    const record = {
      object_ref: procurementId,
      procurement_id: procurementId,
      timezone: "America/New_York",
      source_system: system,
      source_record_id: opportunityText(observation.source_system_id) || opportunityText(snapshot.request_id),
      canonical_url: canonicalUrl,
      provenance: { basis: "publisher_record" },
    };
    const sourceUrl = system === "passport_public_rfx"
      ? passportRfxSourceUrl(snapshot)
      : cityRecordSourceUrl(snapshot);
    if (sourceUrl) record.source_url = sourceUrl;
    const observedAt = opportunityText(observation.ingested_at);
    if (observedAt) record.observed_at = observedAt;
    for (const field of PROCUREMENT_OPPORTUNITY_DATE_FIELDS) {
      if (snapshot[field] != null && String(snapshot[field]).trim() !== "") record[field] = snapshot[field];
    }
    for (const field of PROCUREMENT_OPPORTUNITY_TEXT_FIELDS) {
      if (snapshot[field] != null && String(snapshot[field]).trim() !== "") record[field] = snapshot[field];
    }
    if (Array.isArray(snapshot.procurement_milestones) && snapshot.procurement_milestones.length) {
      record.procurement_milestones = snapshot.procurement_milestones;
    }
    for (const marker of PROCUREMENT_CONFIDENCE_MARKERS) {
      if (snapshot[marker] != null && String(snapshot[marker]).trim() !== "") record[marker] = snapshot[marker];
    }
    records.push(record);
  }
  return records;
}

/* ---------- property: timed events -> display records ---------- */

// Plain, short resident labels. The shared renderer already names the month,
// the kind (event/deadline/opens/closes), and the time; these titles carry the
// property-specific meaning only.
const PROPERTY_OPPORTUNITY_TITLES = Object.freeze({
  hearing: "Public hearing",
  auction: "Public auction",
  sale: "Public sale",
  bid_deadline: "Bids due",
  inspection_showing: "Property showing",
  accommodation_deadline: "Accommodation requests due",
  objection_deadline: "Objections due",
  comment_deadline: "Comments due",
});

const PROPERTY_OPPORTUNITY_KINDS = Object.freeze({
  hearing: "event",
  auction: "event",
  sale: "event",
  bid_deadline: "deadline",
  inspection_showing: "event",
  accommodation_deadline: "deadline",
  objection_deadline: "deadline",
  comment_deadline: "deadline",
});

// Structured, closed vocabulary of reasons a timed event never becomes an
// opportunity occurrence. Lifecycle results stay in the spine; derived and
// low-confidence dates stay out of confirmed cells (A4/A5).
export const PROPERTY_OPPORTUNITY_EXCLUSION_REASONS = Object.freeze([
  "lifecycle-result-award",
  "lifecycle-result-notice-auction",
  "relative-rule-derived-date",
  "low-confidence-date",
  "duplicate-of-window-close",
  "unknown-opportunity-kind",
]);

// Wall-clock times in property notices are New York local times published
// without an offset. Resolve the offset from the zone rules at that wall time
// so the stored instant is explicit and rendering is deterministic in any
// runner timezone. (A wall time inside a DST transition can resolve an hour
// either way; such showing times are vanishingly rare and stay truthful to the
// minute the notice printed.)
function newYorkOffsetForWallClock(day, time) {
  let probe;
  try {
    probe = new Date(`${day}T${time}:00Z`);
  } catch {
    return null;
  }
  if (Number.isNaN(probe.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "longOffset",
    }).formatToParts(probe);
    const name = parts.find((part) => part.type === "timeZoneName")?.value || "";
    const match = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) return name === "GMT" ? "+00:00" : null;
    const sign = match[1];
    const hours = match[2].padStart(2, "0");
    return `${sign}${hours}:${match[3] || "00"}`;
  } catch {
    return null;
  }
}

function propertyWhen(value) {
  const raw = opportunityText(value);
  if (!raw) return null;
  if (opportunityIsDateOnly(raw)) return { date: raw };
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return null;
  const offset = newYorkOffsetForWallClock(match[1], match[2]);
  return offset == null ? { date: match[1] } : { starts_at: `${match[1]}T${match[2]}:00${offset}` };
}

function propertyEventSpanKey(event) {
  const span = event?.source_span;
  return `${event?.source_field ?? ""}:${span?.start ?? ""}:${span?.end ?? ""}`;
}

/**
 * Map one notice's typed timed events (property_timed_event.v1, each with an
 * exact character span) into one display record carrying explicit
 * `calendar_occurrences`. Excluded events are reported with a reason instead of
 * being silently dropped, so a sparse or filtered bundle stays explainable.
 */
export function buildPropertyOpportunityRecord(timedEvents = [], {
  requestId = null,
  title = null,
  shortTitle = null,
  noticeBody = null,
  sourceUrl = null,
  canonicalUrl = null,
} = {}) {
  const ref = opportunityText(requestId);
  if (!ref) return null;
  const events = Array.isArray(timedEvents) ? timedEvents : [];
  const noticeRef = `notice:${ref}`;

  // An online-auction window already emits both boundary cells; its
  // same-span bid-deadline twin would double the closing day.
  const windowCloses = new Set();
  for (const event of events) {
    if (event?.kind === "auction_window" && event.end) {
      windowCloses.add(`${propertyEventSpanKey(event)}|${String(event.end).slice(0, 10)}`);
    }
  }

  const occurrences = [];
  const excluded = [];
  for (const event of events) {
    if (!event || !event.kind) continue;
    const reason = propertyExclusionReason(event, windowCloses);
    if (reason) {
      excluded.push({
        kind: event.kind,
        reason,
        ...(event.deadline || event.start || event.end ? { day: String(event.deadline || event.start || event.end).slice(0, 10) } : {}),
      });
      continue;
    }
    if (event.kind === "auction_window") {
      for (const [boundary, value] of [["open", event.start], ["close", event.end]]) {
        const when = propertyWhen(value);
        if (!when) continue;
        occurrences.push({
          uid: `${noticeRef}:auction_window:${boundary}:${propertyEventSpanKey(event)}`,
          kind: boundary === "open" ? "window_open" : "window_close",
          title: boundary === "open" ? "Online bidding opens" : "Online bidding closes",
          ...when,
          timezone: "America/New_York",
        });
      }
      continue;
    }
    const when = propertyWhen(event.deadline || event.start || event.end);
    if (!when) continue;
    const kind = PROPERTY_OPPORTUNITY_KINDS[event.kind];
    if (!kind) {
      excluded.push({ kind: event.kind, reason: "unknown-opportunity-kind" });
      continue;
    }
    // Identity: notice + kind + resolved day (with clock when published).
    // Two dates mined from one shared text segment — the two dates of a
    // "Show Dates:" block — stay two stable occurrences; a genuinely repeated
    // same-day fact from two segments collapses as a duplicate, per the
    // shared identity contract.
    occurrences.push({
      uid: `${noticeRef}:${event.kind}:${when.starts_at || when.date}`,
      kind,
      title: PROPERTY_OPPORTUNITY_TITLES[event.kind] || "Dated event",
      ...when,
      timezone: "America/New_York",
    });
  }

  return {
    schema: OPPORTUNITY_CALENDAR_SCHEMA,
    object_ref: noticeRef,
    request_id: ref,
    calendar_occurrences: occurrences,
    excluded_timed_events: excluded,
    source_system: "city_record",
    ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
    ...(title || shortTitle ? { short_title: shortTitle || title } : {}),
    ...(noticeBody ? { additional_description_1: noticeBody } : {}),
    provenance: { basis: "publisher_record" },
  };
}

function propertyExclusionReason(event, windowCloses) {
  if (event.kind === "result_award") return "lifecycle-result-award";
  if (event.kind === "auction" && event.context === "result_notice") return "lifecycle-result-notice-auction";
  if (event.date_source === "derived_from_relative_rule") return "relative-rule-derived-date";
  if (String(event.confidence || "").toLowerCase() === "low") return "low-confidence-date";
  if (event.kind === "bid_deadline" && event.deadline
    && windowCloses.has(`${propertyEventSpanKey(event)}|${String(event.deadline).slice(0, 10)}`)) {
    return "duplicate-of-window-close";
  }
  return null;
}

/* ---------- shared bundle pipeline ---------- */

/**
 * Classify opportunity records through the shared CBICS-01 boundary, pool the
 * eligible occurrences, and resolve stable identity (a rescheduled or
 * superseded twin collapses onto one UID, newest source state wins). Excluded
 * candidates are returned with their classifier reason.
 */
export function opportunityOccurrences(records = [], options = {}) {
  const classified = (Array.isArray(records) ? records : [])
    .filter(Boolean)
    .map((record) => classifyDisplayRecord(record, options));
  const eligible = classified.flatMap((row) => row.eligible_occurrences);
  return {
    schema: OPPORTUNITY_CALENDAR_SCHEMA,
    occurrences: deduplicateCalendarOccurrences(eligible),
    excluded: classified.flatMap((row) => row.excluded),
  };
}

/** Convenience: procurement observations -> pooled opportunity occurrences. */
export function procurementOpportunityOccurrences(object = {}, observations = []) {
  return opportunityOccurrences(procurementOpportunityRecords(object, observations), { kind: "rfp" });
}

/**
 * Render the compact opportunity month, or "" when the bundle does not meet
 * the commissioned density rule (A6: sparse opportunities keep their existing
 * presentation with no calendar chrome). `today` must be explicit; without it
 * there is no calendar at all.
 */
export function opportunityMonthHTML(occurrences = [], {
  today = null,
  fullListHref = null,
  fullListLabel = null,
  esc,
} = {}) {
  if (!opportunityIsDateOnly(today)) return "";
  const view = buildCompactMonthView(Array.isArray(occurrences) ? occurrences : [], { today });
  if (!view.render) return "";
  return renderCompactMonth(view, {
    ...(fullListHref ? { fullListHref } : {}),
    ...(fullListHref && fullListLabel ? { fullListLabel } : {}),
    ...(esc ? { esc } : {}),
  });
}
