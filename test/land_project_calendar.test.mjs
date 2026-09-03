import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  projectCalendarActionsHTML,
  projectCalendarOccurrences,
  projectCalendarOccurrencesForRecord,
  projectCalendarRecordsForRecord,
} from "../site/project_calendar.mjs";
import { boundedDisplayOccurrences } from "../site/calendar_display.mjs";
import { buildCompactMonthView, renderCompactMonth } from "../site/compact_calendar.mjs";
import { landProjectConnectedCalendarHTML } from "../site/land_project_connected_calendar.mjs";
import { FIXTURE_TODAY, fixtureOccurrences } from "./fixtures/compact_calendar_fixtures.mjs";

// A project's accepted connections span years; the same wide practical range
// `site/land_project_connected_calendar.mjs` uses for its bounded display
// query (the month itself is chosen by the density rule, not by this range).
const WIDE_DISPLAY_BOUNDS = { from: "2000-01-01", to: "2099-12-31" };

const ROOT = dirname(fileURLToPath(import.meta.url));
const LAND_SOURCE = readFileSync(join(ROOT, "..", "site", "app", "land.mjs"), "utf8");
const LAND_CALENDAR_SOURCE = readFileSync(join(ROOT, "..", "site", "land_project_connected_calendar.mjs"), "utf8");

const PROJECT_REF = "project:2026M0001";
const SOURCE_URL = "https://records.example/source/2026-03";
const CALENDAR_SOURCE = "https://cityscroll.org/connectors/project-2026M0001";

function acceptedNoticeRecord() {
  return {
    relation: "project_hearing_decision",
    confidence: "strong",
    calendar_record: {
      object_ref: "notice:2026M0001-hearing",
      title: "Commission public hearing",
      event_date: "2026-03-18T19:00:00-04:00",
      canonical_url: "https://cityscroll.org/notices/2026m0001-hearing",
      source: { system: "city_record", record_id: "2026M0001-hearing", url: SOURCE_URL },
      status: "scheduled",
    },
  };
}

function rejectedNoticeRecord() {
  return {
    relation: "project_proceeding_held",
    state: "held",
    calendar_record: {
      object_ref: "notice:2026M0001-held",
      title: "Dropped hearing",
      event_date: "2026-04-01T19:00:00-04:00",
      canonical_url: "https://cityscroll.org/notices/2026m0001-held",
      source: { system: "city_record", record_id: "2026M0001-held", url: SOURCE_URL },
    },
  };
}

function recordFromParts({ status = "bounded", connections = {}, roots = [] } = {}) {
  return {
    project_id: "2026M0001",
    project_name: "Example project",
    project_ref: PROJECT_REF,
    project_calendar_sources: [
      {
        relation: "project_process",
        object_ref: "project:2026M0001:calendar-root",
        title: "Project filing",
        event_date: "2026-03-05T09:00:00-04:00",
        canonical_url: "https://cityscroll.org/projects/2026M0001",
        source: { system: "city_record", record_id: "2026M0001", url: CALENDAR_SOURCE },
      },
      ...roots,
    ],
    project_connections: {
      status,
      project_ref: PROJECT_REF,
      groups: [{
        id: "project-connections",
        status: "matched",
        items: [acceptedNoticeRecord(), rejectedNoticeRecord()],
        ...connections,
      }],
      ...connections,
    },
  };
}

function directProjectOccurrences(record, options = {}) {
  return projectCalendarOccurrences({
    project_ref: PROJECT_REF,
    connections: record.project_connections,
    connected_records: record.project_calendar_sources,
  }, options);
}

test("project-calendar connected occurrences remain identical to subscription projection", () => {
  const record = recordFromParts();
  const fromSubscription = projectCalendarOccurrencesForRecord(record, { as_of: "2026-03-15" });
  const fromDirect = directProjectOccurrences(record, { as_of: "2026-03-15" });
  assert.deepEqual(
    fromSubscription.map((item) => item.uid).sort(),
    fromDirect.map((item) => item.uid).sort(),
  );
  assert.deepEqual(
    fromSubscription.find((item) => item.uid.startsWith("notice:2026M0001-hearing")).source.system,
    "city_record",
  );
  assert.equal(fromSubscription.some((item) => /2026m0001-held/.test(item.uid)), false);
});

test("rejected connected relations do not leak into project calendar output", () => {
  const record = recordFromParts();
  const occurrences = projectCalendarOccurrencesForRecord(record, { as_of: "2026-03-15" });
  const uids = occurrences.map((item) => item.object_ref);
  assert.equal(uids.some((item) => item === "notice:2026M0001-held"), false);
  assert.equal(uids.some((item) => item === "notice:2026M0001-hearing"), true);
});

test("bounded display gate surfaces an exact past accepted occurrence the future-only subscription omits", () => {
  const record = recordFromParts();
  const subscriptionUids = projectCalendarOccurrencesForRecord(record, { as_of: "2026-03-15" }).map((item) => item.uid);
  const records = projectCalendarRecordsForRecord(record);
  const displayed = boundedDisplayOccurrences(records, WIDE_DISPLAY_BOUNDS);
  const displayedRefs = displayed.map((item) => item.object_ref);
  assert.equal(displayedRefs.includes("project:2026M0001:calendar-root"), true, "the past project-filing root is shown");
  assert.equal(subscriptionUids.some((uid) => uid.startsWith("project:2026M0001:calendar-root")), false,
    "the future-only subscription never emits that same past occurrence");
});

test("a milestone carrying a statutory/estimated date basis never surfaces as an ordinary connected-calendar event", () => {
  const record = recordFromParts({
    roots: [{
      relation: "project_process",
      object_ref: "project:2026M0001:milestone:anticipated-review",
      title: "Anticipated council review",
      event_date: "2026-03-20T10:00:00-04:00",
      canonical_url: "https://cityscroll.org/projects/2026M0001",
      source: { system: "zap-api-outcomes", record_id: "anticipated-review", url: CALENDAR_SOURCE },
      provenance: { basis: "statutory_expected" },
    }],
  });
  const records = projectCalendarRecordsForRecord(record);
  assert.equal(records.some((item) => item.object_ref === "project:2026M0001:milestone:anticipated-review"), true,
    "the accepted population still carries the candidate record");
  const displayed = boundedDisplayOccurrences(records, WIDE_DISPLAY_BOUNDS);
  assert.equal(displayed.some((item) => item.object_ref === "project:2026M0001:milestone:anticipated-review"), false,
    "the bounded display gate excludes the statutory/estimated-basis date");
});

test("connected-calendar month view renders across a dense, mixed past/future accepted bundle", () => {
  const record = recordFromParts({
    roots: [
      {
        relation: "project_process",
        object_ref: "project:2026M0001:milestone:certification",
        title: "Certification",
        event_date: "2026-03-10T09:00:00-04:00",
        canonical_url: "https://cityscroll.org/projects/2026M0001",
        source: { system: "zap-api-outcomes", record_id: "certification", url: CALENDAR_SOURCE },
        provenance: { basis: "publisher_record" },
      },
      {
        relation: "project_disposition",
        object_ref: "project:2026M0001:vote",
        title: "CPC vote",
        event_date: "2026-03-25T10:00:00-04:00",
        canonical_url: "https://cityscroll.org/projects/2026M0001",
        source: { system: "zap-api-outcomes", record_id: "vote", url: CALENDAR_SOURCE },
        provenance: { basis: "publisher_record" },
      },
    ],
  });
  const records = projectCalendarRecordsForRecord(record);
  const displayed = boundedDisplayOccurrences(records, WIDE_DISPLAY_BOUNDS);
  const view = buildCompactMonthView(displayed, { today: FIXTURE_TODAY });
  assert.equal(view.render, true);
  assert.equal(view.occurrence_days.includes("2026-03-05"), true, "past filing date is in the rendered month");
  assert.equal(view.occurrence_days.includes("2026-03-18"), true, "future hearing date is in the rendered month");
  assert.equal(view.occurrence_days.includes("2026-04-01"), false, "the held/rejected relation stays excluded");

  const html = landProjectConnectedCalendarHTML(record, { today: FIXTURE_TODAY });
  assert.match(html, /project-connected-calendar/);
  assert.match(html, /Connected dates/);
  assert.match(html, /data-project-id="2026M0001"/);
});

test("land project connected-calendar panel routes the accepted population through the bounded display gate, not the raw feed", () => {
  assert.match(LAND_CALENDAR_SOURCE, /projectCalendarRecordsForRecord/);
  assert.match(LAND_CALENDAR_SOURCE, /boundedDisplayOccurrences/);
  assert.match(LAND_SOURCE, /import\s*\{[^}]*landProjectConnectedCalendarHTML[^}]*\}\s*from\s*"\.\.\/land_project_connected_calendar\.mjs"/,
    "land detail mounts the dedicated connected-calendar module");
  assert.match(LAND_SOURCE, /todayISO\(\)\.slice\(0,\s*10\)/, "today is normalized to a bare date before the panel builds its view");
});

test("landProjectConnectedCalendarHTML requires an explicit date-only today and never reads a hidden clock", () => {
  const record = recordFromParts();
  assert.equal(landProjectConnectedCalendarHTML(record, { today: "2026-03-15T00:00:00" }), "");
  assert.equal(landProjectConnectedCalendarHTML(record, {}), "");
});

test("partial or unavailable project connections render no connected calendar feed", () => {
  assert.equal(projectCalendarOccurrencesForRecord(recordFromParts({ status: "partial" }), { as_of: FIXTURE_TODAY }).length, 0);
  assert.equal(projectCalendarOccurrencesForRecord(recordFromParts({ status: "unavailable" }), { as_of: FIXTURE_TODAY }).length, 0);
});

test("compact month view includes past and future occurrences for connected calendar payloads", () => {
  const dense = fixtureOccurrences("dense");
  const view = buildCompactMonthView(dense, { today: FIXTURE_TODAY });
  assert.equal(view.render, true);
  assert.equal(view.occurrence_days.includes("2026-03-04"), true);
  const html = renderCompactMonth(view);
  assert.match(html, /Kickoff hearing/);
  assert.match(html, /Comments due today/);
  assert.match(html, /Board vote/);
});

test("compact month rejects sparse payloads and returns empty render", () => {
  const sparse = fixtureOccurrences("sparse");
  const view = buildCompactMonthView(sparse, { today: FIXTURE_TODAY });
  assert.equal(view.render, false);
  assert.equal(renderCompactMonth(view), "");
});

test("compact month preserves lifecycle flags and canonical/source link identity", () => {
  const lifecycle = [
    ...fixtureOccurrences("lifecycle"),
    {
      uid: "override",
      object_ref: "project:override-source",
      kind: "event",
      title: "Alternative source",
      date: "2026-03-30",
      canonical_url: "https://cityscroll.org/projects/2026M0001",
      source: { system: "city_record", record_id: "override", url: "https://example.gov/override" },
      provenance: { basis: "publisher_record" },
    },
  ];
  const view = buildCompactMonthView(lifecycle, { today: FIXTURE_TODAY });
  const html = renderCompactMonth(view);
  assert.equal(view.render, true);
  assert.match(html, /compact-month-occ-flag-cancelled/);
  assert.match(html, /compact-month-occ-flag-rescheduled/);
  assert.match(html, /https:\/\/cityscroll\.org\/projects\/2026M0001/);
  assert.match(html, /https:\/\/example\.gov\/override/);
  assert.match(html, /compact-month-occ-source/);
});

test("land template adds connected dates between actions and outcomes and preserves calendar affordances", () => {
  const actions = LAND_SOURCE.indexOf("projectCalendarActions({projectId:r.project_id})");
  const projectConnections = LAND_SOURCE.indexOf('id="project-connections"');
  const connected = LAND_SOURCE.indexOf('id="project-connected-calendar"');
  const outcomes = LAND_SOURCE.indexOf('id="land-outcomes"');
  const connectedCalendarStyles = LAND_CALENDAR_SOURCE.indexOf("compact_calendar.css");
  const projectCalendarActionsSource = LAND_SOURCE.indexOf("projectCalendarActionsHTML as projectCalendarActions");
  const subscriptionActionsHtml = projectCalendarActionsHTML({
    projectId: "2026M0001",
    projectName: "Example project",
  });

  assert.ok(actions >= 0 && projectConnections >= 0 && connected >= 0 && outcomes >= 0, "land detail sections are present");
  assert.ok(actions < projectConnections, "actions render before project connections");
  assert.ok(projectConnections < connected, "project connections render before connected calendar");
  assert.ok(connected < outcomes, "connected calendar renders before long outcomes section");
  assert.equal(connectedCalendarStyles >= 0, true, "connected-calendar module references the compact calendar stylesheet");
  assert.ok(projectCalendarActionsSource >= 0, "land detail still mounts project calendar actions");
  assert.match(subscriptionActionsHtml, />Follow project</);
  assert.match(subscriptionActionsHtml, />Subscribe to project calendar</);
});
