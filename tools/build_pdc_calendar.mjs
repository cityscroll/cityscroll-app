#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePdcAgendaText, parsePdcScheduleHtml, enrichPdcMeetingWithAgenda } from "../site/pdc_calendar.mjs";

const ROOT = join(import.meta.dirname, "..");
function normalizeAgendaCaptures({ agenda, agendas, agendaCaptures, agendaText, agendaDate, agendaDocumentUrl, agendaReceipt } = {}) {
  const values = [
    ...(Array.isArray(agendas) ? agendas : []),
    ...(Array.isArray(agendaCaptures) ? agendaCaptures : []),
    ...(agenda ? [agenda] : []),
    ...(agendaText ? [{ text: agendaText, meetingDate: agendaDate, documentUrl: agendaDocumentUrl, receipt: agendaReceipt }] : []),
  ];
  return values.map((capture) => {
    if (typeof capture === "string") return { text: capture };
    return {
      text: capture?.text ?? capture?.body ?? capture?.content ?? "",
      meetingDate: capture?.meetingDate ?? capture?.meeting_date ?? capture?.date ?? null,
      documentUrl: capture?.documentUrl ?? capture?.document_url ?? capture?.source_url ?? null,
      receipt: capture?.receipt ?? capture?.source_receipt ?? null,
    };
  }).filter((capture) => capture.text && capture.meetingDate);
}

export function buildPdcCalendar({ html, sourceUrl, observedAt, receipt, agenda, agendas, agendaCaptures, agendaText, agendaDate, agendaDocumentUrl, agendaReceipt } = {}) {
  const parsed = parsePdcScheduleHtml(html, { sourceUrl, observedAt, receipt });
  const captures = normalizeAgendaCaptures({ agenda, agendas, agendaCaptures, agendaText, agendaDate, agendaDocumentUrl, agendaReceipt });
  const records = (parsed.records || []).map((record) => {
    const capture = captures.find((candidate) => candidate.meetingDate === record.event_date?.slice(0, 10));
    if (!capture) return record;
    return enrichPdcMeetingWithAgenda(record, parsePdcAgendaText(capture.text, {
      meetingDate: capture.meetingDate,
      documentUrl: capture.documentUrl,
      observedAt,
      receipt: capture.receipt,
    }));
  });
  return { ...parsed, records, rows: records, documents: records.flatMap((row) => row.meeting_documents || []), generated_at: observedAt || null };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const input = process.argv[2];
  const output = process.argv[3] || join(ROOT, "site/data/pdc_calendar.json");
  if (!input) throw new Error("usage: build_pdc_calendar.mjs <captured-html> [output]");
  const agendaInput = process.argv[4] || process.env.PDC_AGENDA_TEXT_FILE;
  const result = buildPdcCalendar({ html: readFileSync(input, "utf8"), sourceUrl: "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page", observedAt: process.env.PDC_OBSERVED_AT || new Date().toISOString(), ...(agendaInput ? { agendaText: readFileSync(agendaInput, "utf8"), agendaDate: process.env.PDC_AGENDA_DATE || null, agendaDocumentUrl: process.env.PDC_AGENDA_URL || null } : {}) });
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
