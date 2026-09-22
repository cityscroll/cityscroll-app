import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePdcCalendar, buildPdcCapture, runPdcCalendar } from "../tools/build_pdc_calendar.mjs";
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

// The publisher puts the year in the schedule heading and agenda links in the date cell.
const headingYearSchedule = `<a href="/calendar-2027.pdf">Download the 2027 calendar</a>
<h3>Public Design Commission Calendar 2026</h3>
<table><tr><th>Submission Deadline</th><th>Meeting Date</th></tr>
<tr><td>Thursday, December 18, 2025</td><td><a href="/january-agenda.pdf">Tuesday, January 20 Agenda</a></td></tr>
<tr><td>Friday, August 21</td><td><a href="/september-agenda.pdf">Tuesday, September 22* Agenda</a></td></tr>
<tr><td>Friday, September 25</td><td>Tuesday, October 20* Agenda</td></tr>
<tr><td>Friday, December 18</td><td></td></tr></table>
<h3>Public Design Commission Meeting Minutes and Certificates of Approval 2026</h3>
<table><tr><th>Meeting Date</th><th>Minutes and Certificates</th><th>Videos</th></tr>
<tr><td>January 20, 2026</td><td><a href="/minutes.pdf">Minutes</a></td><td></td></tr></table>`;

test("publisher heading years and in-cell agenda links produce distinct schedule sessions only", () => {
  const records = parsePdcScheduleHtml(headingYearSchedule, {sourceUrl, observedAt}).records;
  assert.deepEqual(records.map((row) => row.event_date), ["2026-01-20", "2026-09-22", "2026-10-20"]);
  assert.equal(records[0].meeting_documents[0].document_url, "https://www.nyc.gov/january-agenda.pdf");
  assert.equal(records[1].meeting_documents[0].document_url, "https://www.nyc.gov/september-agenda.pdf");
  assert.equal(records[2].meeting_documents.length, 0);
  assert.equal(parsePdcScheduleHtml(headingYearSchedule.replace(/<h3>Public Design Commission Calendar 2026<\/h3>/, "")).records.length, 0, "a download-link year is not a table-year declaration");
});

test("live acquisition validates before publication and preserves last good bytes on failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdc-refresh-"));
  const capture = join(root, "capture.json");
  const output = join(root, "calendar.json");
  const registry = JSON.parse(readFileSync(new URL("../site/data/source_contracts.json", import.meta.url), "utf8"));
  const refresh = registry.first_class_artifacts.find((entry) => entry.id === "pdc-calendar");
  const acquireArgs = [...refresh.acquisition_command.slice(2), capture];
  const buildArgs = [...refresh.builder_command.slice(2), capture, output];
  const options = {observedAt, fetchImpl:async () => new Response(headingYearSchedule, {headers:{"content-type":"text/html"}})};
  try {
    await runPdcCalendar(acquireArgs, options);
    await runPdcCalendar(buildArgs);
    const goodCapture = readFileSync(capture, "utf8");
    const goodOutput = readFileSync(output, "utf8");
    const data = JSON.parse(goodOutput);
    assert.equal(data.records.length, 3);
    assert.equal(data.generated_at, observedAt);
    assert.equal(data.records[0].source_receipt.observed_at, observedAt);
    assert.equal(data.records[0].source_receipt.sha256, JSON.parse(goodCapture).sha256);
    for (const response of [new Response("unavailable", {status:503}), new Response("{}", {headers:{"content-type":"application/json"}}), new Response("<html>maintenance</html>", {headers:{"content-type":"text/html"}})]) {
      await assert.rejects(runPdcCalendar(acquireArgs, {...options, fetchImpl:async () => response}));
      assert.equal(readFileSync(capture, "utf8"), goodCapture);
      assert.equal(readFileSync(output, "utf8"), goodOutput);
    }
    await assert.rejects(acquirePdcCalendar({...options, fetchImpl:async () => {throw new Error("network failed");}}), /network failed/);
    assert.throws(() => buildPdcCapture({...JSON.parse(goodCapture), html:"tampered"}), /Invalid PDC publisher capture/);
  } finally {
    rmSync(root, {recursive:true, force:true});
  }
});

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
