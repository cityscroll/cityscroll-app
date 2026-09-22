#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { parsePdcAgendaText, parsePdcScheduleHtml, enrichPdcMeetingWithAgenda, PDC_CALENDAR_SOURCE_URL, PDC_CALENDAR_PARSER } from "../site/pdc_calendar.mjs";

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

const CAPTURE_PATH = join(ROOT, ".artifacts/pdc-calendar-source.json");
const OUTPUT_PATH = join(ROOT, "site/data/pdc_calendar.json");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function requireScheduleSessions(result) {
  if (!result.records.length) throw new Error("PDC input contains no validated schedule sessions; retaining last-known-good calendar");
  return result;
}

export function buildPdcCapture(capture) {
  if (capture?.schema !== "cityscroll.pdc_calendar_capture.v1"
    || capture.source_url !== PDC_CALENDAR_SOURCE_URL
    || !Number.isFinite(Date.parse(capture.observed_at))
    || typeof capture.html !== "string"
    || sha256(capture.html) !== capture.sha256) throw new Error("Invalid PDC publisher capture");
  const receipt = {
    schema:"cityscroll.meeting_source_receipt.v1", source_url:capture.source_url,
    observed_at:capture.observed_at, status:"ok", fetch_status:"200",
    parser:PDC_CALENDAR_PARSER, sha256:capture.sha256,
  };
  return requireScheduleSessions(buildPdcCalendar({html:capture.html, sourceUrl:capture.source_url, observedAt:capture.observed_at, receipt}));
}

export async function acquirePdcCalendar({fetchImpl = globalThis.fetch, observedAt = new Date().toISOString()} = {}) {
  const response = await fetchImpl(PDC_CALENDAR_SOURCE_URL, {
    headers:{Accept:"text/html"}, signal:AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`PDC acquisition HTTP ${response.status}`);
  if (!/text\/html/i.test(response.headers.get("content-type") || "")) throw new Error("PDC acquisition did not return HTML");
  const html = await response.text();
  if (Buffer.byteLength(html) > 2_000_000) throw new Error("PDC capture exceeds bounded HTML size");
  const capture = {
    schema:"cityscroll.pdc_calendar_capture.v1", source_url:PDC_CALENDAR_SOURCE_URL,
    observed_at:observedAt, sha256:sha256(html), html,
  };
  buildPdcCapture(capture);
  return capture;
}

function writeJsonAtomic(output, value) {
  mkdirSync(dirname(output), {recursive:true});
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, output);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export async function runPdcCalendar(argv, options = {}) {
  if (argv[0] === "--acquire") {
    const capture = await acquirePdcCalendar(options);
    writeJsonAtomic(argv[1] || CAPTURE_PATH, capture);
    return;
  }
  if (argv[0] === "--build-captured") {
    const capture = JSON.parse(readFileSync(argv[1] || CAPTURE_PATH, "utf8"));
    writeJsonAtomic(argv[2] || OUTPUT_PATH, buildPdcCapture(capture));
    return;
  }
  const input = argv[0];
  const output = argv[1] || OUTPUT_PATH;
  if (!input) throw new Error("usage: build_pdc_calendar.mjs <captured-html> [output]");
  const agendaInput = argv[2] || process.env.PDC_AGENDA_TEXT_FILE;
  const result = requireScheduleSessions(buildPdcCalendar({ html: readFileSync(input, "utf8"), sourceUrl: "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page", observedAt: process.env.PDC_OBSERVED_AT || new Date().toISOString(), ...(agendaInput ? { agendaText: readFileSync(agendaInput, "utf8"), agendaDate: process.env.PDC_AGENDA_DATE || null, agendaDocumentUrl: process.env.PDC_AGENDA_URL || null } : {}) }));
  writeJsonAtomic(output, result);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  await runPdcCalendar(process.argv.slice(2));
}
