#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
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
  if (!Array.isArray(parsed.records) || parsed.records.length === 0) {
    throw new Error("PDC capture produced no calendar records; refusing to replace the last-known-good artifact");
  }
  const population = parsed.population || {};
  const accounted = Number(population.calendar_record_count) + Number(population.unaccounted_row_count);
  if (!Number.isFinite(accounted) || accounted !== Number(population.input_row_count)
    || Number(population.unaccounted_row_count) !== 0) {
    throw new Error(`PDC capture left ${population.unaccounted_row_count ?? "unknown"} of ${population.input_row_count ?? "unknown"} input rows unaccounted; refusing to replace the last-known-good artifact`);
  }
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
  const receiptInput = process.argv[4];
  if (!input) throw new Error("usage: build_pdc_calendar.mjs <captured-html> [output] [capture-receipt]");
  const captureReceipt = receiptInput ? JSON.parse(readFileSync(receiptInput, "utf8")) : null;
  const observedAt = captureReceipt?.observed_at || process.env.PDC_OBSERVED_AT || new Date().toISOString();
  const receipt = captureReceipt ? { ...captureReceipt, parser: "pdc_calendar_acquisition.v1" } : null;
  const agendaInput = process.env.PDC_AGENDA_TEXT_FILE;
  const result = buildPdcCalendar({ html: readFileSync(input, "utf8"), sourceUrl: "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page", observedAt, receipt, ...(agendaInput ? { agendaText: readFileSync(agendaInput, "utf8"), agendaDate: process.env.PDC_AGENDA_DATE || null, agendaDocumentUrl: process.env.PDC_AGENDA_URL || null } : {}) });
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, output);
}
