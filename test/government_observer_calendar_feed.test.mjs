import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildObserveSurface,
  normalizeObserveScope,
} from "../site/government_observe.mjs";
import {
  buildObserverCalendarFeed,
  compareObserverCalendarRevisions,
  filterObserveRowsForFeed,
  meetingRowMatchesObserveFilter,
  observeCalendarFeedUrl,
  observeCalendarSubscriptionDetails,
  observeSubscriptionWatchFromScope,
  observerCalendarOccurrences,
  renderObserveCalendarSubscription,
} from "../site/government_observer_calendar_feed.mjs";
import { parsePdcScheduleHtml } from "../site/pdc_calendar.mjs";
import { parseBsaAgendaPages, bsaCalendarOccurrences } from "../site/bsa_calendar.mjs";
import { parseOathTrialCsv } from "../site/oath_trial_calendar.mjs";
import {
  normalizeOathTrialCalendarMeeting,
} from "../site/meeting_object_contract.mjs";
import { calendarFeedUrlForScope } from "../site/scope_v0.mjs";
import {
  calendarEventPreviewFacts,
  renderCalendarEventPreviewBody,
} from "../site/calendar_event_preview.mjs";
import { unsupportedModernFeedFilterFields } from "../worker/src/lib/feed.mjs";
import { sanitize } from "../worker/src/lib/filter.mjs";
import { todayISO, withPinnedClock } from "./helpers/test_clock.mjs";

const OATH_SOURCE_REVISION = "fixture-rev-1";
const PINNED_OBSERVED_AT = "2026-09-10T12:00:00.000Z";

function day(value) {
  const match = String(value ?? "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function addDays(isoDay, days) {
  const date = new Date(`${isoDay}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function observedAt() {
  return `${todayISO()}T12:00:00.000Z`;
}

function pdcFixtureRows() {
  const html = readFileSync(new URL("./fixtures/pdc_calendar/schedule.html", import.meta.url), "utf8");
  return parsePdcScheduleHtml(html, {
    sourceUrl: "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page",
    observedAt: observedAt(),
  }).records;
}

function bsaFixtureSessions() {
  const source = JSON.parse(readFileSync(new URL("./fixtures/bsa/september-14-15-2026.json", import.meta.url), "utf8"));
  return parseBsaAgendaPages(source);
}

function oathFixtureParse(sourceRevision = OATH_SOURCE_REVISION) {
  const csv = [
    "Index,Date,Start,End,Type,Location",
    "270419,09/15/2026,10:00 AM,,Scheduled For Trial,",
    "270160,09/15/2026,10:30 AM,,Scheduled For Trial,",
    "262021,09/15/2026,2:00 PM,,Conference Scheduled,",
    "270419,09/15/2026,10:00 AM,,Scheduled For Trial,",
  ].join("\n");
  return parseOathTrialCsv(csv, {
    sourceUrl: "https://www.nyc.gov/site/oath/trials/conference-and-trial-calendar.page",
    observedAt: observedAt(),
    sourceRevision,
  });
}

function oathFixtureRows(sourceRevision = OATH_SOURCE_REVISION) {
  return oathFixtureParse(sourceRevision).records;
}

/** Calendar detail entry projected from a normalized occurrence. */
function detailEntryFromOccurrence(occurrence) {
  const dayValue = day(occurrence.starts_at) || occurrence.date;
  return {
    uid: occurrence.uid,
    kind: occurrence.kind,
    lifecycle: occurrence.lifecycle,
    status: occurrence.status,
    title: occurrence.title,
    day: dayValue,
    starts_at: occurrence.starts_at,
    date: occurrence.date,
    timezone: occurrence.timezone,
    canonical_url: occurrence.canonical_url,
    source: occurrence.source,
    state: dayValue && dayValue < todayISO() ? "past" : dayValue === todayISO() ? "current" : "future",
  };
}

function collectionRows() {
  return [...pdcFixtureRows(), ...bsaFixtureSessions(), ...oathFixtureRows()];
}

test("A1 subscription emits exact observe scope and feed replay keeps collection identities", async () => {
  await withPinnedClock(PINNED_OBSERVED_AT, () => {
    const asOf = todayISO();
    const scope = normalizeObserveScope({
      body: "bsa_calendar",
      access: "remote",
      placeRole: "venue",
    });
    const watch = observeSubscriptionWatchFromScope(scope);
    assert.equal(watch.ok, true, "A1 place scope is emitted rather than refused");
    assert.equal(watch.watch.lens, "meetings");
    assert.deepEqual(watch.watch.filter, {
      activity: "observe",
      body: "bsa_calendar",
      access: "remote",
      place_role: "venue",
    }, "A1 subscription emits body, access, and place scope together");

    const feedUrl = observeCalendarFeedUrl(scope);
    assert.ok(feedUrl, "A1 place scope yields a feed address");
    const url = new URL(feedUrl);
    assert.equal(url.searchParams.get("lens"), "meetings");
    assert.deepEqual(JSON.parse(url.searchParams.get("filter")), watch.watch.filter);
    assert.equal(calendarFeedUrlForScope(watch.watch), feedUrl);

    const rows = collectionRows();
    const surface = buildObserveSurface({ rows }, scope);
    const selected = filterObserveRowsForFeed(rows, scope);
    assert.ok(selected.length > 0, "A1 venue place scope selects BSA sessions with venues");
    assert.deepEqual(
      selected.map((row) => row.meeting_id).sort(),
      surface.observations.map((row) => row.id).sort(),
    );

    const sanitized = sanitize("meetings", watch.watch.filter);
    assert.equal(sanitized.activity, "observe");
    assert.equal(sanitized.body, "bsa_calendar");
    assert.equal(sanitized.access, "remote");
    assert.equal(sanitized.place_role, "venue", "A1 worker sanitize retains place_role");
    const replayed = rows
      .filter((row) => day(row.event_date) && day(row.event_date) > asOf)
      .filter((row) => meetingRowMatchesObserveFilter(row, sanitized));
    assert.deepEqual(
      replayed.map((row) => row.meeting_id).sort(),
      selected.map((row) => row.meeting_id).sort(),
      "A1 three-path replay keeps identities under place scope",
    );

    const details = observeCalendarSubscriptionDetails(scope, { rows: selected });
    assert.ok(details?.feedUrl);
    assert.match(details.webcalUrl, /^webcal:/);
    assert.match(details.scopeLabel, /Board of Standards and Appeals|bsa_calendar|Observe/);
    assert.match(details.scopeLabel, /venue/i, "A1 scope label names the emitted place role");
  });
});

test("A2 PDC date-only, BSA both days, and OATH New York start keep source precision", async () => {
  await withPinnedClock(PINNED_OBSERVED_AT, () => {
    const pdc = pdcFixtureRows().find((row) => row.event_date === "2026-09-22");
    const bsa = bsaFixtureSessions();
    const oath = oathFixtureRows().find((row) => row.oath_index === "270419");

    const feed = buildObserverCalendarFeed({
      scope: normalizeObserveScope({}),
      rows: [pdc, ...bsa, oath],
      title: "Observer calendar",
    });
    assert.equal(feed.ok, true);
    const ics = feed.ics;
    const unfolded = ics.replace(/\r\n[ \t]/g, "");

    assert.match(ics, /DTSTART;VALUE=DATE:20260922/);
    assert.match(unfolded, /Time not yet published/);
    assert.match(unfolded, /All-day marking means only the meeting day is known so far/);
    assert.doesNotMatch(unfolded, /\ball day program\b|\bfull day program\b|\bfull-day program\b/i);

    const bsaUids = bsaCalendarOccurrences(bsa).map((row) => row.uid);
    assert.equal(bsaUids.length, 2);
    // Standing-feed UID host is owned by the ICS serializer; assert the UID stem
    // and host delimiter without copying the compatibility-domain literal here.
    for (const uid of bsaUids) {
      assert.match(ics, new RegExp(`UID:${uid.replaceAll(":", "\\:")}@`));
    }

    assert.match(ics, /DTSTART;TZID=America\/New_York:20260915T100000/);
    assert.doesNotMatch(ics, /undefined/);
    const oathOccurrence = observerCalendarOccurrences([oath])[0];
    assert.equal(oathOccurrence.starts_at, "2026-09-15T10:00:00");
    assert.equal(oathOccurrence.ends_at, null);
    assert.equal(oathOccurrence.timezone, "America/New_York");
    assert.equal(oathOccurrence.date, null);
  });
});

test("A3 evidenced correction retains UID and advances sequence; explicit cancel is consistent", async () => {
  await withPinnedClock(PINNED_OBSERVED_AT, () => {
    const sessionDay = addDays(todayISO(), 1);
    const sessionId = `270419:${sessionDay}:10:00:00:Scheduled For Trial`;
    const stable = normalizeOathTrialCalendarMeeting({
      oath_trial_session_id: sessionId,
      oath_index: "270419",
      title: "OATH trial 270419",
      event_date: `${sessionDay}T10:00:00`,
      source_url: "https://example.test/oath",
      sequence: 0,
      last_modified: observedAt(),
    });
    const corrected = {
      ...stable,
      event_date: `${sessionDay}T10:30:00`,
      start_time: "10:30:00",
      sequence: 1,
      lifecycle: "rescheduled",
      last_modified: `${addDays(todayISO(), 1)}T12:00:00.000Z`,
    };
    const cancelled = {
      ...corrected,
      sequence: 2,
      status: "cancelled",
      lifecycle: "cancelled",
      last_modified: `${addDays(todayISO(), 1)}T18:00:00.000Z`,
      cancellation_notice: "Cancelled by OATH calendar unit",
    };

    const before = observerCalendarOccurrences([stable])[0];
    const after = observerCalendarOccurrences([corrected])[0];
    assert.equal(after.uid, before.uid);
    assert.equal(after.uid, stable.meeting_id);
    assert.equal(after.lifecycle, "rescheduled");
    assert.equal(after.sequence, 1);
    assert.equal(after.starts_at, `${sessionDay}T10:30:00`);

    const cancelledOccurrence = observerCalendarOccurrences([cancelled])[0];
    assert.equal(cancelledOccurrence.uid, before.uid);
    assert.equal(cancelledOccurrence.status, "cancelled");
    assert.equal(cancelledOccurrence.sequence, 2);

    const feed = buildObserverCalendarFeed({
      scope: normalizeObserveScope({ body: "oath_trial_calendar" }),
      rows: [cancelled],
    });
    assert.match(feed.ics, /STATUS:CANCELLED/, "A3 feed export carries cancelled status");
    assert.match(feed.ics, /SEQUENCE:2/, "A3 feed export carries advanced sequence");

    // Detail rendering must state the same cancellation the feed exports —
    // not a re-read of the fixture object just constructed.
    const detailFacts = calendarEventPreviewFacts(detailEntryFromOccurrence(cancelledOccurrence));
    const detailHtml = renderCalendarEventPreviewBody(detailFacts);
    assert.equal(detailFacts?.lifecycle, "cancelled", "A3 detail facts carry cancelled lifecycle");
    assert.match(detailHtml, /This event is cancelled\./, "A3 detail render states cancellation");
  });
});

test("A4 unsupported fields refuse a broadened feed; inspecting never subscribes", async () => {
  await withPinnedClock(PINNED_OBSERVED_AT, () => {
    const unsupportedText = observeSubscriptionWatchFromScope({
      body: "pdc_calendar",
      text_query: { version: 1, expression: "design" },
    });
    assert.equal(unsupportedText.ok, false);
    assert.equal(unsupportedText.reason, "unsupported-scope");
    assert.ok(unsupportedText.unsupported.includes("text_query"));
    assert.equal(observeCalendarFeedUrl({ body: "pdc_calendar", text_query: { version: 1 } }), null);

    const unsupportedBody = observeSubscriptionWatchFromScope({ body: "all" });
    assert.equal(unsupportedBody.ok, false);
    assert.equal(observeCalendarFeedUrl({ body: "all" }), null);

    const freeText = observeSubscriptionWatchFromScope({
      body: "bsa_calendar",
      keywords: ["zoning"],
    });
    assert.equal(freeText.ok, false);
    assert.ok(freeText.unsupported.includes("keywords"));

    const supported = observeSubscriptionWatchFromScope({ body: "pdc_calendar", access: "in_person" });
    assert.equal(supported.ok, true);
    const unsupported = unsupportedModernFeedFilterFields("meetings", {
      ...supported.watch.filter,
      text_query: { version: 1, expression: "x" },
    }, { format: "ics" });
    assert.ok(unsupported.includes("text_query"));

    const surface = buildObserveSurface({ rows: collectionRows() }, { body: "pdc_calendar" });
    const html = renderObserveCalendarSubscription(surface);
    assert.match(html, /Subscribe to calendar|calendar-subscribe/);
    assert.doesNotMatch(html, /Inspect observation[\s\S]*Subscribe to calendar/);
    assert.match(html, /data-calendar-subscription="scope"/);
    const inspectOnly = surface.observations.map((row) => row.href).join(" ");
    assert.doesNotMatch(inspectOnly, /feed\.ics|webcal:/);
  });
});

test("A5 all-day wording, dedupe, and no publisher ICS passthrough", async () => {
  await withPinnedClock(PINNED_OBSERVED_AT, () => {
    const pdc = pdcFixtureRows().find((row) => row.event_date === "2026-09-22");
    const oathRows = oathFixtureRows();
    assert.equal(oathRows.filter((row) => row.oath_index === "270419").length, 1, "parser already dedupes exact rows");

    const duplicated = [pdc, { ...pdc }, ...oathRows, oathRows[0]];
    const occurrences = observerCalendarOccurrences(duplicated);
    const uids = occurrences.map((row) => row.uid);
    assert.equal(uids.length, new Set(uids).size);

    const feed = buildObserverCalendarFeed({
      scope: normalizeObserveScope({}),
      rows: duplicated,
    });
    assert.equal((feed.ics.match(/BEGIN:VEVENT/g) || []).length, uids.length);
    assert.doesNotMatch(feed.ics, /\ball day program\b|\bfull-day program\b|\bfull day program\b/i);
    assert.doesNotMatch(feed.ics, /TZID=undefined|DTEND:[^:\r\n]*undefined/);
    assert.doesNotMatch(feed.ics, /X-WR-TIMEZONE:undefined/);
    assert.match(feed.ics, /PRODID:-\/\/CityScroll\/\/feeds\/\/EN/);
  });
});

test("A6 missing or moved OATH row invents neither cancellation nor reschedule relation", async () => {
  await withPinnedClock(PINNED_OBSERVED_AT, () => {
    const parsed = oathFixtureParse(OATH_SOURCE_REVISION);
    assert.equal(parsed.source_revision, OATH_SOURCE_REVISION, "A6 source revision retained on parse envelope");
    assert.ok(
      parsed.records.length > 0
        && parsed.records.every((row) => row.source_revision === OATH_SOURCE_REVISION),
      "A6 source revision retained on every parsed trial row",
    );
    assert.ok(
      parsed.records.every((row) => row.source_receipt?.source_revision === OATH_SOURCE_REVISION),
      "A6 source revision retained on each row source receipt",
    );
    const later = oathFixtureParse("fixture-rev-2");
    assert.equal(later.source_revision, "fixture-rev-2", "A6 a later source revision stays distinct");
    assert.notEqual(parsed.source_revision, later.source_revision);

    const firstDay = addDays(todayISO(), 1);
    const movedDay = addDays(todayISO(), 1);
    // Move to a different clock time on the same +1d horizon so identity changes
    // without inventing a cancellation or reschedule relation.
    const first = normalizeOathTrialCalendarMeeting({
      oath_trial_session_id: `270419:${firstDay}:10:00:00:Scheduled For Trial`,
      oath_index: "270419",
      title: "OATH trial 270419",
      event_date: `${firstDay}T10:00:00`,
      source_url: "https://example.test/oath",
      sequence: 0,
      source_revision: OATH_SOURCE_REVISION,
    });
    const moved = normalizeOathTrialCalendarMeeting({
      oath_trial_session_id: `270419:${movedDay}:14:00:00:Scheduled For Trial`,
      oath_index: "270419",
      title: "OATH trial 270419",
      event_date: `${movedDay}T14:00:00`,
      source_url: "https://example.test/oath",
      sequence: 0,
      source_revision: "fixture-rev-2",
    });
    assert.notEqual(first.meeting_id, moved.meeting_id);

    const comparison = compareObserverCalendarRevisions({
      previousRows: [first],
      nextRows: [moved],
      scope: normalizeObserveScope({ body: "oath_trial_calendar" }),
    });
    assert.deepEqual(comparison.retained_uids, []);
    assert.deepEqual(comparison.cancelled_uids, []);
    assert.deepEqual(comparison.rescheduled_uids, []);
    assert.deepEqual(comparison.removed_without_cancellation, [first.meeting_id]);
    assert.deepEqual(comparison.added_uids, [moved.meeting_id]);

    const nextFeed = buildObserverCalendarFeed({
      scope: normalizeObserveScope({ body: "oath_trial_calendar" }),
      rows: [moved],
    });
    assert.doesNotMatch(nextFeed.ics, /STATUS:CANCELLED/);
    assert.equal(nextFeed.occurrences.length, 1);
    assert.equal(nextFeed.occurrences[0].uid, moved.meeting_id);
    assert.notEqual(nextFeed.occurrences[0].uid, first.meeting_id);
    const unfolded = nextFeed.ics.replace(/\r\n[ \t]/g, "");
    assert.doesNotMatch(unfolded, new RegExp(first.meeting_id.replaceAll(":", "\\:")));
    assert.match(unfolded, new RegExp(`UID:${moved.meeting_id.replaceAll(":", "\\:")}@`));
  });
});
