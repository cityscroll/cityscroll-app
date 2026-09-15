import test from "node:test";
import assert from "node:assert/strict";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { buildMeetingSearchDocuments } from "../site/meeting_search_producer.mjs";
import { parsePdcAgendaText, parsePdcScheduleHtml, enrichPdcMeetingWithAgenda } from "../site/pdc_calendar.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";

const sourceUrl = "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page";
const html = `<table><tr><th>Meeting Date</th><th>Submission Deadline</th><th>Agenda</th></tr><tr><td>September 22, 2026</td><td>September 25, 2026</td><td>Agenda</td></tr><tr><td>October 20, 2026</td><td>September 25, 2026</td><td><a href="/assets/designcommission/downloads/pdf/agendas/10-20-26-PDC-Public-Agenda.pdf">Agenda</a></td></tr></table>`;

test("native schedule admits meeting dates and excludes submission deadlines", () => {
  const result = parsePdcScheduleHtml(html, { sourceUrl, observedAt: "2026-09-15T00:00:00Z" });
  assert.deepEqual(result.records.map((row) => row.event_date), ["2026-09-22", "2026-10-20"]);
  assert.equal(result.records[0].meeting_id, "meeting:pdc_calendar:pdc-2026-09-22");
  assert.equal(result.records[0].meeting_documents.length, 0);
  assert.equal(result.records[1].meeting_documents[0].document_url, "https://www.nyc.gov/assets/designcommission/downloads/pdf/agendas/10-20-26-PDC-Public-Agenda.pdf");
});

test("agenda parsing preserves typed sections and relative arrival advice", () => {
  const agenda = parsePdcAgendaText("PUBLIC DESIGN COMMISSION\nAugust 17, 2026\n10:00 AM\nCommittee Items\nA. Civic plaza\nConsent Items\nB. Existing approval\nPresentation Items\nC. New library\nPlease arrive 45 minutes before the estimated time of your item.", { meetingDate: "2026-08-17", documentUrl: "https://example.test/pdc.pdf" });
  assert.deepEqual(agenda.sections.map((section) => section.section_type), ["committee", "consent", "presentation"]);
  assert.match(agenda.arrival_advice, /45 minutes/);
  assert.equal(agenda.start_time, "10:00:00");
  const record = parsePdcScheduleHtml("<table><tr><th>Meeting Date</th><th>Agenda</th></tr><tr><td>August 17, 2026</td><td></td></tr></table>", { sourceUrl }).records[0];
  const enriched = enrichPdcMeetingWithAgenda(record, agenda);
  assert.equal(enriched.meeting_id, record.meeting_id);
  assert.equal(enriched.agenda_sections[1].section_type, "consent");
});

test("shared canonical detail and search admit PDC without network reads", () => {
  const record = parsePdcScheduleHtml(html, { sourceUrl, observedAt: "2026-09-15T00:00:00Z" }).records[0];
  const model = buildSharedMeetingReadModel({ generatedAt: "2026-09-15T00:00:00Z", pdcCalendarIndex: { generated_at: "2026-09-15T00:00:00Z", records: [record] } });
  assert.equal(model.sources.pdc_calendar.row_count, 1);
  assert.equal(buildMeetingSearchDocuments(model).documents[0].object_ref, record.meeting_id);
  const detail = renderMeetingDocument(model.rows[0]);
  assert.match(detail, /Public Design Commission meeting/);
  assert.match(detail, /Agenda not yet published/);
});

test("broken or changed inputs fail closed", () => {
  assert.equal(parsePdcScheduleHtml("<table><tr><th>Submission Deadline</th></tr><tr><td>September 25, 2026</td></tr></table>", { sourceUrl }).records?.length || 0, 0);
  const noPdf = parsePdcAgendaText("not a PDF extraction", { meetingDate: "2026-09-22" });
  assert.deepEqual(noPdf.sections, []);
});
