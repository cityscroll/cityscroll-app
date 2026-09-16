import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { buildMeetingSearchDocuments } from "../site/meeting_search_producer.mjs";
import { parseOathTrialCsv, observerRequestForTrial, observerRequestMailto, localDateTime } from "../site/oath_trial_calendar.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { meetingPlacementsFromRow } from "../tools/lib/district_activity.mjs";
import { testClockISOString, todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const sourceUrl = "https://www.nyc.gov/site/oath/trials/conference-trial-calendar.page";
const CAPTURED_CSV_PATH = new URL("./fixtures/oath/daily-calendar-2026-09-15.csv", import.meta.url);
const CAPTURED_SOURCE_REVISION = "7995493cfbba9e085252496ebb8cb930fc4bbe52172dcc16ac18a21088af4691";

function addDays(day, days) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toSlashDate(day) {
  const [year, month, date] = day.split("-");
  return `${Number(month)}/${Number(date)}/${year}`;
}

function miniatureCsv(day0, day1) {
  return [
    "Index,Date,Start,Type,Location",
    `262021,${toSlashDate(day0)},2:00 PM,Conference,`,
    `12345,${toSlashDate(day1)},10:00 AM,Trial,`,
    `12345,${toSlashDate(day1)},10:00 AM,Trial,`,
    `12345,${toSlashDate(day0)},10:00 AM,Trial,`,
    `<x>&,${toSlashDate(day1)},11:30 AM,Trial,`,
  ].join("\n");
}

test("OATH parser filters by explicit type and exactly deduplicates sessions", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, () => {
    const day0 = todayISO();
    const day1 = addDays(todayISO(), 1);
    const result = parseOathTrialCsv(miniatureCsv(day0, day1), {
      sourceUrl,
      sourceRevision: "rev-1",
      observedAt: testClockISOString(),
    });
    assert.equal(result.records.length, 3);
    assert.deepEqual(
      result.records.map((row) => row.event_date),
      [`${day1}T10:00:00`, `${day0}T10:00:00`, `${day1}T11:30:00`],
    );
    assert.equal(result.records[0].source_raw_values.index, "12345");
    assert.equal(result.records[0].source_revision, "rev-1");
    assert.equal(result.records[0].venue, null);
    assert.equal(result.records[0].event_end, null);
  });
});

test("captured OATH CSV yields the named trial-session and conference-exclusion counts", async () => {
  await withPinnedClock("2026-09-15T12:00:00.000Z", () => {
    const csv = readFileSync(CAPTURED_CSV_PATH, "utf8");
    assert.equal(createHash("sha256").update(csv).digest("hex"), CAPTURED_SOURCE_REVISION);
    const result = parseOathTrialCsv(csv, {
      sourceUrl,
      sourceRevision: CAPTURED_SOURCE_REVISION,
      observedAt: testClockISOString(),
    });
    assert.deepEqual(result.population, {
      input_row_count: 259,
      trial_session_count: 145,
      excluded_conference_count: 113,
      exact_duplicate_count: 1,
    });
    assert.equal(result.records.length, 145);
    assert.equal(
      result.records.some((row) => row.oath_index === "262021" && row.event_date === "2026-09-15T14:00:00"),
      false,
    );
  });
});

test("OATH local time conversion is wall-clock deterministic", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, () => {
    const day = todayISO();
    const longDate = new Intl.DateTimeFormat("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${day}T12:00:00Z`));
    assert.equal(localDateTime(longDate, "2 PM"), `${day}T14:00:00`);
    assert.equal(localDateTime(day, ""), day);
  });
});

test("trial rows flow through shared detail and search producers", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, () => {
    const day0 = todayISO();
    const day1 = addDays(todayISO(), 1);
    const record = parseOathTrialCsv(miniatureCsv(day0, day1), {
      sourceUrl,
      observedAt: testClockISOString(),
    }).records[0];
    const generatedAt = testClockISOString();
    const model = buildSharedMeetingReadModel({
      generatedAt,
      oathTrialCalendarIndex: { generated_at: generatedAt, records: [record] },
    });
    assert.equal(model.sources.oath_trial_calendar.row_count, 1);
    assert.equal(buildMeetingSearchDocuments(model).documents[0].object_ref, record.meeting_id);
    const html = renderMeetingDocument(model.rows[0]);
    assert.match(html, /Copy observer request/);
    assert.match(html, /OATHCalUnit@OATH\.nyc\.gov/);
    assert.match(html, new RegExp(day1));
    assert.match(html, /10:00:00/);
    assert.doesNotMatch(html, /courthouse|estimated end|registered|confirmed attendance/i);
  });
});

test("observer request is editable, escaped, and mailto remains user-sent", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, () => {
    const day = addDays(todayISO(), 1);
    const record = {
      source_system: "oath_trial_calendar",
      meeting_id: "meeting:oath_trial_calendar:x",
      oath_index: "<x>&",
      event_date: `${day}T11:30:00`,
      source_url: sourceUrl,
    };
    const request = observerRequestForTrial(record);
    const href = observerRequestMailto(record);
    assert.match(request, /Index: <x>&/);
    assert.match(href, /^mailto:OATHCalUnit@OATH\.nyc\.gov/);
    assert.match(renderMeetingDocument(record), /&lt;x&gt;&amp;/);
  });
});

test("source disappearance or changed time does not invent cancellation or reschedule", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, () => {
    const day = addDays(todayISO(), 1);
    const slash = toSlashDate(day);
    const first = parseOathTrialCsv(`Index,Date,Start,Type\n1,${slash},10:00 AM,Trial`, { sourceUrl }).records[0];
    const changed = parseOathTrialCsv(`Index,Date,Start,Type\n1,${slash},11:00 AM,Trial`, { sourceUrl }).records[0];
    assert.notEqual(first.meeting_id, changed.meeting_id);
    assert.equal(first.join_status, "unknown");
    assert.equal(changed.join_status, "unknown");
    assert.equal(first.meeting_join, undefined);
  });
});

test("blank OATH locations stay unlocated instead of turning case-party text into geography", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, () => {
    const day = todayISO();
    const record = parseOathTrialCsv(
      `date,start,name,about,location\n${toSlashDate(day)},10:00 AM,270419 - Transit Authority v. Harlem Restoration,Scheduled For Trial,`,
      { sourceUrl },
    ).records[0];
    const placements = meetingPlacementsFromRow(record, { community_districts: [], council_districts: [] });
    assert.deepEqual([...placements], []);
    assert.equal(placements.unlocated_reason, "source_location_not_published");
  });
});
