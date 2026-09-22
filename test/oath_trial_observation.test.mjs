import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildSharedMeetingReadModel } from "../site/shared_meeting_read_model.mjs";
import { buildMeetingSearchDocuments } from "../site/meeting_search_producer.mjs";
import {
  OATH_TRIAL_CALENDAR_SOURCE_URL,
  parseOathTrialCsv,
  observerRequestForTrial,
  observerRequestMailto,
  localDateTime,
} from "../site/oath_trial_calendar.mjs";
import { installOathObserverRequestControls } from "../site/oath_trial_observation.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { meetingPlacementsFromRow } from "../tools/lib/district_activity.mjs";
import { buildOathTrialCalendar } from "../tools/build_oath_trial_calendar.mjs";
import { click, mountDocument } from "./helpers/preview_dom.mjs";
import { testClockISOString, todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const sourceUrl = "https://www.nyc.gov/site/oath/trials/trial-calendar.page";
const CAPTURED_CSV_PATH = new URL("./fixtures/oath/daily-calendar-2026-09-15.csv", import.meta.url);
const CAPTURED_SOURCE_REVISION = "7995493cfbba9e085252496ebb8cb930fc4bbe52172dcc16ac18a21088af4691";
const TRACKED_OATH_CALENDAR = new URL("../site/data/oath_trial_calendar.json", import.meta.url);

test("OATH publisher href pins to the live trial calendar page", () => {
  assert.equal(OATH_TRIAL_CALENDAR_SOURCE_URL, sourceUrl);
  assert.equal(sourceUrl, "https://www.nyc.gov/site/oath/trials/trial-calendar.page");
  const artifact = JSON.parse(readFileSync(TRACKED_OATH_CALENDAR, "utf8"));
  assert.ok((artifact.records || []).length > 0, "tracked OATH calendar must retain trial sessions");
  for (const row of artifact.records) {
    assert.equal(row.source_url, sourceUrl);
    assert.equal(row.compatibility?.publisher_href, sourceUrl);
    assert.equal(row.source_receipt?.source_url, sourceUrl);
  }
});

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
      unaccounted_row_count: 0,
    });
    assert.equal(result.records.length, 145);
    assert.equal(
      result.records.some((row) => row.oath_index === "262021" && row.event_date === "2026-09-15T14:00:00"),
      false,
    );
    const labeled = result.records.find((row) => /Scheduled For Trial/i.test(row.proceeding_type || ""));
    assert.ok(labeled);
    assert.match(labeled.meeting_id, /^meeting:oath_trial_calendar:/);
    assert.doesNotMatch(labeled.meeting_id, /\s/);
    assert.match(labeled.meeting_id, /Scheduled-For-Trial/);
  });
});

test("OATH builder fails closed when a capture has no trial records", () => {
  assert.throws(
    () => buildOathTrialCalendar({ csv: "Index,Date,Start,Type\n1,9/22/2026,10:00 AM,Conference", sourceUrl }),
    /no trial records; refusing to replace/,
  );
});

test("OATH builder rejects a partial parse when a publisher row changes schema", () => {
  const csv = [
    "Index,Date,Start,Type,Category",
    "1,9/22/2026,10:00 AM,Trial,",
    "2,9/23/2026,11:00 AM,,Scheduled For Trial",
  ].join("\n");
  assert.throws(
    () => buildOathTrialCalendar({ csv, sourceUrl }),
    /left 1 of 2 input rows unaccounted; refusing to replace/,
  );
});

test("every OATH calendar meeting_id is present in the shared meeting read model", () => {
  const calendar = JSON.parse(readFileSync(new URL("../site/data/oath_trial_calendar.json", import.meta.url), "utf8"));
  const shared = JSON.parse(readFileSync(new URL("../site/data/shared_meeting_read_model.json", import.meta.url), "utf8"));
  const calendarIds = (calendar.records || calendar.rows || [])
    .map((row) => row?.meeting_id)
    .filter(Boolean);
  assert.ok(calendarIds.length > 0, "expected OATH calendar meeting rows");
  const sharedIds = new Set(
    (shared.rows || [])
      .filter((row) => row?.source_system === "oath_trial_calendar")
      .map((row) => row.meeting_id)
      .filter(Boolean),
  );
  const missing = calendarIds.filter((id) => !sharedIds.has(id));
  assert.deepEqual(missing, [], "OATH calendar meeting_ids missing from shared meeting read model");
  assert.ok(calendarIds.every((id) => !/\s/.test(id)), "OATH calendar meeting_ids must be digest-safe");
  assert.equal(calendarIds.length, sharedIds.size);
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

test("A2: mailto composer carries index, date, and start and asks for confirmation and access instructions", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, () => {
    const day = addDays(todayISO(), 1);
    const record = {
      source_system: "oath_trial_calendar",
      meeting_id: "meeting:oath_trial_calendar:a2",
      oath_index: "12345",
      event_date: `${day}T10:00:00`,
      start_time: "10:00:00",
      source_url: sourceUrl,
    };
    const request = observerRequestForTrial(record);
    const href = observerRequestMailto(record);
    const mailto = new URL(href);
    const body = mailto.searchParams.get("body") || "";
    assert.deepEqual(
      {
        request_asks_confirmation_and_access_instructions:
          /Please confirm whether observation is possible and provide the access instructions\./.test(request),
        mailto_recipient: mailto.pathname,
        mailto_body_includes_index: /Index: 12345/.test(body),
        mailto_body_includes_date: body.includes(`Date: ${day}`),
        mailto_body_includes_local_start: /Local start time: 10:00:00/.test(body),
      },
      {
        request_asks_confirmation_and_access_instructions: true,
        mailto_recipient: "OATHCalUnit@OATH.nyc.gov",
        mailto_body_includes_index: true,
        mailto_body_includes_date: true,
        mailto_body_includes_local_start: true,
      },
    );
  });
});

test("A5: request stays editable with accessible copy acknowledgement and copy fallback", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, async () => {
    const day = addDays(todayISO(), 1);
    const record = {
      source_system: "oath_trial_calendar",
      meeting_id: "meeting:oath_trial_calendar:a5",
      oath_index: "12345",
      event_date: `${day}T10:00:00`,
      start_time: "10:00:00",
      source_url: sourceUrl,
    };
    const html = renderMeetingDocument(record);
    const section = html.match(/<section[^>]*data-oath-observer-request[\s\S]*?<\/section>/)?.[0];
    assert.ok(section, "rendered trial document must include the observer-request section");
    const { container } = mountDocument(section);
    const area = container.querySelector("[data-oath-request-text]");
    const statusEl = container.querySelector("[data-oath-copy-status]");
    const button = container.querySelector("[data-oath-copy-request]");
    area.value = area.textContent;
    area.selectCount = 0;
    area.select = function selectRequestText() {
      this.selectCount += 1;
    };
    installOathObserverRequestControls(container);

    const navigatorRef = globalThis.navigator;
    let copied = null;
    Object.defineProperty(navigatorRef, "clipboard", {
      configurable: true,
      get() {
        return {
          writeText: async (text) => {
            copied = text;
          },
        };
      },
    });
    await click(button);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const success = {
      editable_label: container.querySelector("label")?.textContent || null,
      editable_textarea: area?.tagName || null,
      copy_status_role: statusEl?.getAttribute("role") || null,
      copy_status_aria_live: statusEl?.getAttribute("aria-live") || null,
      copy_success_message: statusEl?.textContent || null,
      copy_success_revealed: statusEl?.hidden === false,
      copied_request_text: copied === area.value,
    };

    Object.defineProperty(navigatorRef, "clipboard", {
      configurable: true,
      get() {
        return undefined;
      },
    });
    await click(button);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      {
        ...success,
        fallback_message: statusEl?.textContent || null,
        fallback_focuses_request: area.focusCount >= 1,
        fallback_selects_request: area.selectCount >= 1,
        never_labels_registered_or_confirmed_attendance: !/registered|confirmed attendance/i.test(html),
      },
      {
        editable_label: "Editable request",
        editable_textarea: "textarea",
        copy_status_role: "status",
        copy_status_aria_live: "polite",
        copy_success_message: "Observer request copied.",
        copy_success_revealed: true,
        copied_request_text: true,
        fallback_message: "Copy was unavailable. Select and copy the request text below.",
        fallback_focuses_request: true,
        fallback_selects_request: true,
        never_labels_registered_or_confirmed_attendance: true,
      },
    );
  });
});

test("A6: schema-change retention keeps unexpected publisher columns on the record", async () => {
  await withPinnedClock(`${todayISO()}T00:00:00.000Z`, () => {
    const day = todayISO();
    const csv = [
      "Index,Date,Start,Type,Location,Courtroom_Code",
      `99,${toSlashDate(day)},9:00 AM,Trial,,CR-7`,
    ].join("\n");
    const record = parseOathTrialCsv(csv, {
      sourceUrl,
      sourceRevision: "schema-rev-1",
      observedAt: testClockISOString(),
    }).records[0];
    assert.deepEqual(
      {
        retained_unexpected_column: record.source_raw_values.courtroom_code,
        retained_known_index: record.source_raw_values.index,
        retained_source_revision: record.source_revision,
      },
      {
        retained_unexpected_column: "CR-7",
        retained_known_index: "99",
        retained_source_revision: "schema-rev-1",
      },
    );
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
