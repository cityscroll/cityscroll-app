import test from "node:test";
import assert from "node:assert/strict";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { buildMeetingSearchDocuments } from "../site/meeting_search_producer.mjs";
import { parseOathTrialCsv, observerRequestForTrial, observerRequestMailto, localDateTime } from "../site/oath_trial_calendar.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { meetingPlacementsFromRow } from "../tools/lib/district_activity.mjs";

const sourceUrl = "https://www.nyc.gov/site/oath/trials/conference-trial-calendar.page";
const csv = [
  "Index,Date,Start,Type,Location",
  "262021,09/15/2026,2:00 PM,Conference,",
  "12345,09/16/2026,10:00 AM,Trial,",
  "12345,09/16/2026,10:00 AM,Trial,",
  "12345,09/17/2026,10:00 AM,Trial,",
  "<x>&,09/18/2026,11:30 AM,Trial,",
].join("\n");

test("OATH parser filters by explicit type and exactly deduplicates sessions", () => {
  const result = parseOathTrialCsv(csv, { sourceUrl, sourceRevision: "rev-1", observedAt: "2026-09-15T00:00:00Z" });
  assert.equal(result.records.length, 3);
  assert.deepEqual(result.records.map((row) => row.event_date), ["2026-09-16T10:00:00", "2026-09-17T10:00:00", "2026-09-18T11:30:00"]);
  assert.equal(result.records[0].source_raw_values.index, "12345");
  assert.equal(result.records[0].source_revision, "rev-1");
  assert.equal(result.records[0].venue, null);
});

test("OATH local time conversion is wall-clock deterministic", () => {
  assert.equal(localDateTime("September 15, 2026", "2 PM"), "2026-09-15T14:00:00");
  assert.equal(localDateTime("2026-09-15", ""), "2026-09-15");
});

test("trial rows flow through shared detail and search producers", () => {
  const record = parseOathTrialCsv(csv, { sourceUrl }).records[0];
  const model = buildSharedMeetingReadModel({ generatedAt: "2026-09-15T00:00:00Z", oathTrialCalendarIndex: { generated_at: "2026-09-15T00:00:00Z", records: [record] } });
  assert.equal(model.sources.oath_trial_calendar.row_count, 1);
  assert.equal(buildMeetingSearchDocuments(model).documents[0].object_ref, record.meeting_id);
  const html = renderMeetingDocument(model.rows[0]);
  assert.match(html, /Copy observer request/);
  assert.match(html, /OATHCalUnit@OATH\.nyc\.gov/);
  assert.match(html, /2026-09-16/);
  assert.match(html, /10:00:00/);
  assert.doesNotMatch(html, /courthouse|estimated end|registered|confirmed attendance/i);
});

test("observer request is editable, escaped, and mailto remains user-sent", () => {
  const record = { source_system: "oath_trial_calendar", meeting_id: "meeting:oath_trial_calendar:x", oath_index: "<x>&", event_date: "2026-09-18T11:30:00", source_url: sourceUrl };
  const request = observerRequestForTrial(record);
  const href = observerRequestMailto(record);
  assert.match(request, /Index: <x>&/);
  assert.match(href, /^mailto:OATHCalUnit@OATH\.nyc\.gov/);
  assert.match(renderMeetingDocument(record), /&lt;x&gt;&amp;/);
});

test("source disappearance or changed time does not invent cancellation or reschedule", () => {
  const first = parseOathTrialCsv("Index,Date,Start,Type\n1,09/16/2026,10:00 AM,Trial", { sourceUrl }).records[0];
  const changed = parseOathTrialCsv("Index,Date,Start,Type\n1,09/16/2026,11:00 AM,Trial", { sourceUrl }).records[0];
  assert.notEqual(first.meeting_id, changed.meeting_id);
  assert.equal(first.join_status, "unknown");
  assert.equal(changed.join_status, "unknown");
  assert.equal(first.meeting_join, undefined);
});

test("blank OATH locations stay unlocated instead of turning case-party text into geography", () => {
  const record = parseOathTrialCsv("date,start,name,about,location\n09/15/2026,10:00 AM,270419 - Transit Authority v. Harlem Restoration,Scheduled For Trial,", { sourceUrl }).records[0];
  const placements = meetingPlacementsFromRow(record, { community_districts: [], council_districts: [] });
  assert.deepEqual([...placements], []);
  assert.equal(placements.unlocated_reason, "source_location_not_published");
});
