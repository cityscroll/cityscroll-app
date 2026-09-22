import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildPdcCalendar } from "../tools/build_pdc_calendar.mjs";
import { enrichPdcMeetingWithAgenda, parsePdcAgendaText, parsePdcScheduleHtml } from "../site/pdc_calendar.mjs";

const sourceUrl = "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page";
const html = readFileSync(new URL("./fixtures/pdc_calendar/schedule.html", import.meta.url), "utf8");
const liveHeadingYearHtml = readFileSync(new URL("./fixtures/pdc_calendar/live-heading-year.html", import.meta.url), "utf8");
const agendaText = readFileSync(new URL("./fixtures/pdc_calendar/august-17-agenda.txt", import.meta.url), "utf8");
const observedAt = "2026-09-18T12:00:00Z";

test("PDC promotes a matching captured agenda clock and preserves the publisher identity", () => {
  const record = parsePdcScheduleHtml(html, { sourceUrl, observedAt }).records[0];
  const enriched = enrichPdcMeetingWithAgenda(record, parsePdcAgendaText(agendaText, {
    meetingDate: record.event_date,
    documentUrl: "https://www.nyc.gov/assets/designcommission/agenda-09-22.pdf",
    observedAt,
  }));

  assert.equal(enriched.meeting_id, record.meeting_id);
  assert.equal(enriched.event_date, "2026-09-22T10:00:00");
  assert.equal(enriched.schedule.status, "resolved");
  assert.equal(enriched.schedule.basis, "publisher_document");
  assert.equal(enriched.schedule.source_url, "https://www.nyc.gov/assets/designcommission/agenda-09-22.pdf");
});

test("PDC builder only promotes agenda text for the linked meeting date", () => {
  const result = buildPdcCalendar({
    html,
    sourceUrl,
    observedAt,
    agendaText,
    agendaDate: "2026-09-22",
    agendaDocumentUrl: "https://www.nyc.gov/assets/designcommission/agenda-09-22.pdf",
  });

  assert.equal(result.records.find((row) => row.meeting_id.endsWith("2026-09-22")).schedule.precision, "exact_time");
  assert.equal(result.records.find((row) => row.meeting_id.endsWith("2026-10-20")).schedule.precision, "date_only");
});

test("PDC keeps a linked agenda date-only when its captured text has no valid clock", () => {
  const record = parsePdcScheduleHtml(html, { sourceUrl, observedAt }).records[0];
  const enriched = enrichPdcMeetingWithAgenda(record, parsePdcAgendaText("PUBLIC DESIGN COMMISSION\\nSeptember 22, 2026\\nAgenda items", {
    meetingDate: record.event_date,
    documentUrl: "https://www.nyc.gov/assets/designcommission/agenda-09-22.pdf",
    observedAt,
  }));
  assert.equal(enriched.meeting_id, record.meeting_id);
  assert.equal(enriched.schedule.precision, "date_only");
  assert.equal(enriched.schedule.starts_at, null);
});

test("PDC applies the single calendar heading year to live-shaped month/day rows", () => {
  const result = buildPdcCalendar({ html: liveHeadingYearHtml, sourceUrl, observedAt });
  assert.deepEqual(result.records.map((row) => row.event_date), ["2026-09-22", "2026-10-20"]);
});

test("PDC fails closed when yearless rows have no unambiguous calendar heading", () => {
  const ambiguous = liveHeadingYearHtml.replace(
    "<h2>Public Design Commission Calendar 2026</h2>",
    "<h2>Public Design Commission Calendar 2026</h2><h2>Public Design Commission Calendar 2027</h2>",
  );
  assert.throws(
    () => buildPdcCalendar({ html: ambiguous, sourceUrl, observedAt }),
    /no calendar records; refusing to replace/,
  );
});
