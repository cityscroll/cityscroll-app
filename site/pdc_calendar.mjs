import { normalizePdcCalendarMeeting } from "./meeting_object_contract.mjs";
import { createCalendarOccurrence } from "./calendar_occurrence.mjs";
import { extractPdfCalendarText } from "../tools/lib/pdf_calendar_text.mjs";

export const PDC_CALENDAR_SCHEMA = "cityscroll.pdc_calendar.v1";
export const PDC_CALENDAR_SOURCE_URL = "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page";
export const PDC_CALENDAR_PARSER = "pdc_calendar_acquisition.v1";

const clean = (value, max = 2_000) => String(value ?? "")
  .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
  .replace(/\s+/g, " ").trim().slice(0, max);

function htmlRows(html) {
  return [...String(html || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)]
      .map((cell) => ({ text: clean(cell[2]), html: cell[2] })))
    .filter((row) => row.length);
}

function hrefFrom(html) {
  const match = String(html || "").match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return match?.[1] || null;
}

function dateFrom(value) {
  const text = clean(value, 200);
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i)
    || text.match(/\b(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\b/);
  if (!match) return null;
  if (/^20/.test(match[1])) return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1].toLowerCase()) + 1;
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
}

function columns(rows) {
  const header = rows.find((row) => row.some((cell) => /meeting date|submission deadline|agenda/i.test(cell.text)));
  if (!header) return null;
  return Object.fromEntries(header.map((cell, index) => {
    const name = cell.text.toLowerCase();
    return [name.includes("meeting") ? "meeting_date" : name.includes("submission") ? "submission_deadline" : name.includes("agenda") ? "agenda" : `column_${index}`, index];
  }));
}

/** Parse only explicit meeting-date cells from the official PDC table. */
export function parsePdcScheduleHtml(html, { sourceUrl = PDC_CALENDAR_SOURCE_URL, observedAt = null, receipt = null } = {}) {
  const rows = htmlRows(html);
  const indexes = columns(rows);
  if (!indexes || indexes.meeting_date == null) return { schema: PDC_CALENDAR_SCHEMA, rows: [], documents: [], receipt };
  const headerIndex = rows.findIndex((row) => row.some((cell) => /meeting date|submission deadline|agenda/i.test(cell.text)));
  const records = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const meetingCell = row[indexes.meeting_date];
    const eventDate = dateFrom(meetingCell?.text);
    if (!eventDate) continue;
    const agendaCell = indexes.agenda == null ? null : row[indexes.agenda];
    const agendaHref = hrefFrom(agendaCell?.html);
    records.push(normalizePdcCalendarMeeting({
      pdc_event_id: `pdc-${eventDate}`,
      title: "Public Design Commission meeting",
      event_date: eventDate,
      source_url: sourceUrl,
      meeting_origin: "official_pdc_schedule",
      source_receipt: receipt || { schema: "cityscroll.meeting_source_receipt.v1", source_url: sourceUrl, observed_at: observedAt, status: "ok", fetch_status: "snapshot", parser: PDC_CALENDAR_PARSER },
      meeting_documents: agendaHref ? [{ role: "agenda", document_id: agendaHref, document_url: new URL(agendaHref, sourceUrl).href, source_url: sourceUrl, meeting_id: `meeting:pdc_calendar:pdc-${eventDate}`, attachment_status: "attached", adapter: PDC_CALENDAR_PARSER }] : [],
    }));
  }
  return { schema: PDC_CALENDAR_SCHEMA, rows: records, documents: records.flatMap((row) => row.meeting_documents || []), records };
}

/** Extract the agenda's typed sections without promoting consent items to presentations. */
export function parsePdcAgendaText(text, { meetingDate = null, documentUrl = null, observedAt = null, receipt = null } = {}) {
  const lines = String(text || "").split(/\r?\n/).map((line) => clean(line, 500)).filter(Boolean);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^(Consent|Presentation|Committee)(?:\s+Items?)?\b.*$/i);
    if (heading) { current = { section_type: /consent/i.test(line) ? "consent" : /presentation/i.test(line) ? "presentation" : "committee", title: line, items: [] }; sections.push(current); continue; }
    if (current && current.items.length < 100 && !/^page \d+$/i.test(line)) current.items.push(line);
  }
  const arrival = lines.find((line) => /arriv|45 minutes|estimated time/i.test(line)) || null;
  const quorumNotice = lines.find((line) => /no quorum|without quorum|lack of quorum/i.test(line))
    ? { status: "no_quorum", votes: [] }
    : null;
  const clock = lines.join(" ").match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  let startTime = null;
  if (clock) {
    let hour = Number(clock[1]); const suffix = clock[3].toUpperCase();
    if (suffix === "AM" && hour === 12) hour = 0;
    if (suffix === "PM" && hour < 12) hour += 12;
    if (hour < 24) startTime = `${String(hour).padStart(2, "0")}:${clock[2]}:00`;
  }
  return { meeting_date: meetingDate, start_time: startTime, sections, arrival_advice: arrival, quorum_notice: quorumNotice, document_url: documentUrl, source_receipt: receipt || (observedAt ? { schema: "cityscroll.meeting_source_receipt.v1", observed_at: observedAt, status: "ok", fetch_status: "snapshot", parser: PDC_CALENDAR_PARSER } : null) };
}

export function enrichPdcMeetingWithAgenda(record, agenda) {
  if (!record?.meeting_id || !agenda) return record;
  const sections = Array.isArray(agenda.sections) ? agenda.sections : [];
  return { ...record, event_date: record.event_date?.slice(0, 10) === agenda.meeting_date ? (agenda.start_time ? `${agenda.meeting_date}T${agenda.start_time}` : record.event_date) : record.event_date, agenda_sections: sections, arrival_advice: agenda.arrival_advice || null, ...(agenda.quorum_notice ? { quorum_notice: agenda.quorum_notice } : {}), meeting_documents: [...(record.meeting_documents || []), ...(agenda.document_url ? [{ role: "agenda", document_id: agenda.document_url, document_url: agenda.document_url, meeting_id: record.meeting_id, attachment_status: "attached", adapter: PDC_CALENDAR_PARSER, source_receipt: agenda.source_receipt }] : [])] };
}

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

export { extractPdfCalendarText };
