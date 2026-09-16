/**
 * Web-API-safe observer calendar projections.
 *
 * Worker feed serialization imports only this module. Acquisition, PDF text
 * extraction, and other Node build-tool paths stay in their owning modules.
 */

import { createCalendarOccurrence } from "./calendar_occurrence.mjs";

/**
 * Project PDC sessions onto the shared occurrence contract.
 * Date-only schedule rows stay DATE-valued with explicit unpublished-time wording;
 * agenda-backed clock times become America/New_York starts without inventing an end.
 */
export function pdcCalendarOccurrences(records = []) {
  return (Array.isArray(records) ? records : []).flatMap((record) => {
    if (!record?.meeting_id || !record?.event_date) return [];
    const when = String(record.event_date);
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(when);
    const cancelled = record.status === "cancelled" || record.lifecycle === "cancelled";
    const descriptionParts = [
      dateOnly ? "Time not yet published" : null,
      dateOnly ? "All-day marking means only the meeting day is known so far." : null,
      record.arrival_advice || null,
      record.source_url || null,
    ].filter(Boolean);
    return [createCalendarOccurrence({
      uid: record.meeting_id,
      object_ref: record.meeting_id,
      kind: "event",
      title: record.title || "Public Design Commission meeting",
      ...(dateOnly ? { date: when } : { starts_at: when }),
      ends_at: record.event_end || null,
      timezone: dateOnly ? null : (record.timezone || "America/New_York"),
      status: cancelled ? "cancelled" : "scheduled",
      lifecycle: cancelled ? "cancelled" : (record.lifecycle || "scheduled"),
      sequence: record.sequence ?? record.sequence_number ?? null,
      last_modified: record.last_modified || record.modified_at || null,
      location: record.venue?.address || record.venue?.name || null,
      description: descriptionParts.join(" "),
      canonical_url: `https://cityscroll.org/meetings/${encodeURIComponent(record.meeting_id)}/`,
      source: {
        system: "pdc_calendar",
        record_id: record.pdc_event_id || record.publisher_identifier || record.source_record_id || null,
        url: record.source_url || null,
      },
      observed_at: record.source_receipt?.observed_at || record.observed_at || null,
    })];
  });
}

export function bsaCalendarOccurrences(sessions = []) {
  return (Array.isArray(sessions) ? sessions : []).map((session) => createCalendarOccurrence({
    uid: session.meeting_id,
    object_ref: session.meeting_id,
    kind: "event",
    title: session.title,
    starts_at: session.event_date,
    timezone: "America/New_York",
    canonical_url: `https://cityscroll.org/meetings/${encodeURIComponent(session.meeting_id)}/`,
    source: { system: "bsa_calendar", record_id: session.bsa_session_id, url: session.source_url },
    provenance: { basis: "explicit_dated_agenda_section", source_span: session.source_span },
  }));
}

/**
 * Project OATH trial sessions with New York local starts and no invented end.
 * Publisher widget timezone/end defects are corrected here rather than passed through.
 */
export function oathTrialCalendarOccurrences(records = []) {
  return (Array.isArray(records) ? records : []).flatMap((record) => {
    if (!record?.meeting_id || !record?.event_date) return [];
    const when = String(record.event_date);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(when)) return [];
    const cancelled = record.status === "cancelled" || record.lifecycle === "cancelled"
      || /\b(?:cancelled|canceled)\b/i.test(String(record.cancellation_notice || record.title || ""));
    const caveats = [
      "End time is not published.",
      "Location and remote access may require confirmation from the OATH calendar unit.",
      record.source_url || null,
    ].filter(Boolean);
    return [createCalendarOccurrence({
      uid: record.meeting_id,
      object_ref: record.meeting_id,
      kind: "event",
      title: record.title || `OATH trial ${record.oath_index || ""}`.trim(),
      starts_at: when,
      ends_at: null,
      timezone: "America/New_York",
      status: cancelled ? "cancelled" : "scheduled",
      lifecycle: cancelled
        ? "cancelled"
        : (record.lifecycle || "scheduled"),
      sequence: record.sequence ?? record.sequence_number ?? null,
      last_modified: record.last_modified || record.modified_at || null,
      location: record.venue?.address || record.venue?.name || null,
      description: caveats.join(" "),
      canonical_url: `https://cityscroll.org/meetings/${encodeURIComponent(record.meeting_id)}/`,
      source: {
        system: "oath_trial_calendar",
        record_id: record.oath_trial_session_id || record.publisher_identifier || record.source_record_id || null,
        url: record.source_url || null,
      },
      observed_at: record.source_receipt?.observed_at || record.observed_at || null,
    })];
  });
}

/** Dispatch one materialized observer row to its source-specific projection. */
export function observerCalendarOccurrencesForRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    if (row?.source_system === "pdc_calendar") return pdcCalendarOccurrences([row]);
    if (row?.source_system === "bsa_calendar") return bsaCalendarOccurrences([row]);
    if (row?.source_system === "oath_trial_calendar") return oathTrialCalendarOccurrences([row]);
    return [];
  });
}
