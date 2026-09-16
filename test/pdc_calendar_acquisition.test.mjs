import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { buildMeetingSearchDocuments } from "../site/meeting_search_producer.mjs";
import { classifySameProceedingCandidate } from "../site/meeting_same_proceeding.mjs";
import { parsePdcAgendaText, parsePdcScheduleHtml, enrichPdcMeetingWithAgenda } from "../site/pdc_calendar.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { withPinnedClock } from "./helpers/test_clock.mjs";

const sourceUrl = "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page";
const fixtureHtml = readFileSync(new URL("./fixtures/pdc_calendar/schedule.html", import.meta.url), "utf8");
const augustAgendaText = readFileSync(new URL("./fixtures/pdc_calendar/august-17-agenda.txt", import.meta.url), "utf8");
const noQuorumText = readFileSync(new URL("./fixtures/pdc_calendar/no-quorum-notice.txt", import.meta.url), "utf8");
const observedAt = "2026-09-15T00:00:00.000Z";

function schedule() {
  return parsePdcScheduleHtml(fixtureHtml, { sourceUrl, observedAt });
}

function augustRecord() {
  return parsePdcScheduleHtml("<table><tr><th>Meeting Date</th><th>Agenda</th></tr><tr><td>August 17, 2026</td><td>Agenda</td></tr></table>", { sourceUrl, observedAt }).records[0];
}

test("A1: captured schedule and linked agenda enrich one date-only session", () => {
  const record = schedule().records.find((row) => row.event_date === "2026-09-22");
  const agenda = parsePdcAgendaText(augustAgendaText, { meetingDate: "2026-09-22", documentUrl: "https://www.nyc.gov/assets/designcommission/agenda-09-22.pdf", observedAt });
  const enriched = enrichPdcMeetingWithAgenda(record, agenda);
  assert.equal(record.meeting_documents.length, 0, "the bare September label creates no agenda document");
  assert.equal(enriched.meeting_id, record.meeting_id, "agenda enrichment preserves the session identity");
  assert.equal(enriched.event_date, "2026-09-22T10:00:00", "the agenda contributes its published start time");
  assert.equal(enriched.meeting_documents[0].document_url, "https://www.nyc.gov/assets/designcommission/agenda-09-22.pdf");
  assert.deepEqual(enriched.agenda_sections.map((section) => section.section_type), ["committee", "consent", "presentation"]);
});

test("A2: agenda presentation context displays arrival advice separately from start time", () => {
  const agenda = parsePdcAgendaText(augustAgendaText, { meetingDate: "2026-08-17", documentUrl: "https://example.test/pdc.pdf" });
  const enriched = enrichPdcMeetingWithAgenda(augustRecord(), agenda);
  const model = buildSharedMeetingReadModel({ generatedAt: observedAt, pdcCalendarIndex: { generated_at: observedAt, records: [enriched] }, now: observedAt });
  const rendered = renderMeetingDocument(model.rows[0]);
  assert.deepEqual(agenda.sections.map((section) => section.section_type), ["committee", "consent", "presentation"]);
  assert.equal(agenda.start_time, "10:00:00", "the published hour remains the meeting start");
  assert.match(rendered, /Please arrive 45 minutes before the estimated time of your item/);
  assert.match(rendered, /2026-08-17T10:00:00/);
});

test("A3: deadline dates do not create events and date-only sessions invent no timing or cancellation", () => {
  const records = schedule().records;
  assert.deepEqual(records.map((row) => row.event_date), ["2026-09-22", "2026-10-20", "2026-11-16", "2026-12-14"]);
  assert.equal(records.some((row) => row.event_date === "2026-09-25"), false, "the submission deadline is absent from event output");
  const september = records[0];
  assert.equal(september.meeting_documents.length, 0);
  assert.equal(september.event_date, "2026-09-22");
  assert.equal(september.event_end, null);
  assert.equal(Object.hasOwn(september, "cancelled"), false);
});

test("A4: a no-quorum notice preserves the scheduled meeting and has no votes or guaranteed presentation", () => {
  const notice = parsePdcAgendaText(noQuorumText, { meetingDate: "2026-08-17" });
  const record = enrichPdcMeetingWithAgenda(augustRecord(), notice);
  const model = buildSharedMeetingReadModel({ generatedAt: observedAt, pdcCalendarIndex: { generated_at: observedAt, records: [record] }, now: observedAt });
  const rendered = renderMeetingDocument(model.rows[0]);
  assert.equal(model.rows[0].event_date.slice(0, 10), "2026-08-17", "the parent scheduled session remains present");
  assert.deepEqual(model.rows[0].quorum_notice, { status: "no_quorum", votes: [] });
  assert.match(rendered, /Consent listing/);
  assert.doesNotMatch(rendered, /substantive presentation/i);
});

test("A5: exact cross-source evidence relates one candidate and leaves ambiguous candidates separate", () => {
  const cityRecord = { meeting_id: "meeting:city_record:pdc-notice", event_date: "2026-08-17", short_title: "Public Design Commission", source_url: sourceUrl };
  const exact = { meeting_id: "meeting:nyc_legistar_events:pdc-event", event_id: "pdc-event", event_date: "2026-08-17", committee: { name: "Public Design Commission" }, source_url: "https://council.example/pdc-event" };
  const related = classifySameProceedingCandidate(cityRecord, [exact]);
  assert.equal(related.accepted, true, "explicit issuer/date/body evidence creates one relation");
  const ambiguous = classifySameProceedingCandidate(cityRecord, [exact, { ...exact, meeting_id: "meeting:nyc_legistar_events:pdc-event-2", event_id: "pdc-event-2" }]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.candidate_event_ids, ["pdc-event", "pdc-event-2"]);
});

test("A6: canonical detail and search render materialized fixture data without publisher requests", async () => {
  await withPinnedClock(observedAt, async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests += 1; throw new Error("resident rendering must not fetch publisher data"); };
    try {
      const record = schedule().records[0];
      const model = buildSharedMeetingReadModel({ generatedAt: observedAt, pdcCalendarIndex: { generated_at: observedAt, records: [record] }, now: observedAt });
      assert.equal(model.sources.pdc_calendar.row_count, 1);
      assert.equal(buildMeetingSearchDocuments(model).documents[0].object_ref, record.meeting_id);
      assert.match(renderMeetingDocument(model.rows[0]), /Agenda not yet published/);
      assert.equal(requests, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("changed-column and broken-PDF controls fail closed", () => {
  assert.equal(parsePdcScheduleHtml("<table><tr><th>Submission Deadline</th></tr><tr><td>September 25, 2026</td></tr></table>", { sourceUrl }).records?.length || 0, 0);
  const noPdf = parsePdcAgendaText("not a PDF extraction", { meetingDate: "2026-09-22" });
  assert.deepEqual(noPdf.sections, []);
});
