import { normalizePdcCalendarMeeting } from "./meeting_object_contract.mjs";
import { projectMeetingSchedule } from "./meeting_temporal_evidence.mjs";

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

function dateFrom(value, fallbackYear = null) {
  const text = clean(value, 200);
  const match = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i)
    || text.match(/\b(20\d{2})[-/]([01]?\d)[-/]([0-3]?\d)\b/);
  if (match) {
    if (/^20/.test(match[1])) return `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
    const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(match[1].toLowerCase()) + 1;
    return `${match[3]}-${String(month).padStart(2, "0")}-${String(match[2]).padStart(2, "0")}`;
  }
  if (!fallbackYear) return null;
  const withoutYear = text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\b/i);
  if (!withoutYear) return null;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(withoutYear[1].toLowerCase()) + 1;
  return `${fallbackYear}-${String(month).padStart(2, "0")}-${String(withoutYear[2]).padStart(2, "0")}`;
}

function calendarYearContext(html) {
  const years = new Set(
    [...String(html || "").matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
      .map((match) => clean(match[1], 300).match(/\bPublic Design Commission Calendar\s+(20\d{2})\b/i)?.[1])
      .filter(Boolean),
  );
  return years.size === 1 ? [...years][0] : null;
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
  if (!indexes || indexes.meeting_date == null) return { schema: PDC_CALENDAR_SCHEMA, rows: [], records: [], documents: [], receipt };
  const fallbackYear = calendarYearContext(html);
  const headerIndex = rows.findIndex((row) => row.some((cell) => /meeting date|submission deadline|agenda/i.test(cell.text)));
  const records = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const meetingCell = row[indexes.meeting_date];
    const eventDate = dateFrom(meetingCell?.text, fallbackYear);
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
  const clock = lines.join(" ").match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(A\.?M\.?|P\.?M\.?)\b/i);
  let startTime = null;
  let publishedTime = null;
  if (clock) {
    let hour = Number(clock[1]); const suffix = clock[4].replace(/\./g, "").toUpperCase();
    if (suffix === "AM" && hour === 12) hour = 0;
    if (suffix === "PM" && hour < 12) hour += 12;
    if (hour < 24) {
      startTime = `${String(hour).padStart(2, "0")}:${clock[2]}:${clock[3] || "00"}`;
      publishedTime = clock[0];
    }
  }
  return { meeting_date: meetingDate, start_time: startTime, published_time: publishedTime, sections, arrival_advice: arrival, quorum_notice: quorumNotice, document_url: documentUrl, source_receipt: receipt || (observedAt ? { schema: "cityscroll.meeting_source_receipt.v1", observed_at: observedAt, status: "ok", fetch_status: "snapshot", parser: PDC_CALENDAR_PARSER } : null) };
}

export function enrichPdcMeetingWithAgenda(record, agenda) {
  if (!record?.meeting_id || !agenda) return record;
  const sections = Array.isArray(agenda.sections) ? agenda.sections : [];
  const recordDate = record.event_date?.slice(0, 10) || null;
  const matchesRecord = Boolean(recordDate && agenda.meeting_date === recordDate);
  const agendaSchedule = matchesRecord && agenda.start_time
    ? projectMeetingSchedule({
      event_date: `${recordDate}T${agenda.start_time}`,
      schedule: {
        raw_date: recordDate,
        raw_time: agenda.start_time,
        basis: "publisher_document",
        source_url: agenda.document_url || record.source_url,
        observed_at: agenda.source_receipt?.observed_at || record.source_receipt?.observed_at,
      },
    })
    : null;
  const promotesClock = agendaSchedule?.status === "resolved" && agendaSchedule.precision === "exact_time";
  const documents = [...(record.meeting_documents || [])];
  if (agenda.document_url && !documents.some((document) => document.document_url === agenda.document_url)) {
    documents.push({ role: "agenda", document_id: agenda.document_url, document_url: agenda.document_url, meeting_id: record.meeting_id, attachment_status: "attached", adapter: PDC_CALENDAR_PARSER, source_receipt: agenda.source_receipt });
  }
  return {
    ...record,
    ...(promotesClock ? { event_date: agendaSchedule.starts_at, schedule: agendaSchedule } : {}),
    agenda_sections: sections,
    arrival_advice: agenda.arrival_advice || null,
    ...(agenda.quorum_notice ? { quorum_notice: agenda.quorum_notice } : {}),
    meeting_documents: documents,
  };
}

export { pdcCalendarOccurrences } from "./observer_calendar_occurrences.mjs";
