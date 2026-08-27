import assert from "node:assert/strict";
import test from "node:test";

import { icsFeed } from "../worker/src/lib/feed.mjs";
import {
  projectCalendarFeedUrl,
  projectCalendarActionsHTML,
  projectCalendarOccurrences,
} from "../site/project_calendar.mjs";

const PROJECT_REF = "project:2026M0001";

function connections(items) {
  return {
    project_ref: PROJECT_REF,
    groups: [{ id: "connected-processes", status: "matched", items }],
  };
}

const hearing = {
  relation: "decides_land_project",
  ref: "notice:hearing-1",
  calendar_record: {
    object_ref: "notice:hearing-1",
    title: "Public hearing — Riverfront rezoning",
    event_date: "2026-09-15T18:00:00-04:00",
    canonical_url: "https://cityscroll.org/notices/hearing-1",
    source: { system: "city_record", record_id: "hearing-1", url: "https://example.gov/hearing-1" },
    provenance: { basis: "exact_project_reference" },
  },
};

const procurement = {
  relation: "project_procurement_milestone",
  ref: "procurement:city_record:solicitation-1",
  calendar_record: {
    object_ref: "procurement:city_record:solicitation-1",
    title: "School roof repair",
    due_date: "2026-09-22",
    kind: "rfp",
    canonical_url: "https://cityscroll.org/procurements/procurement%3Acity_record%3Asolicitation-1",
    source: { system: "city_record", record_id: "solicitation-1", url: "https://example.gov/solicitation-1" },
    provenance: { basis: "publisher_record" },
  },
};

test("a project calendar combines connected civic processes through CalendarOccurrence", () => {
  const occurrences = projectCalendarOccurrences({
    project_ref: PROJECT_REF,
    connections: connections([hearing, procurement]),
  }, { as_of: "2026-08-27" });

  assert.equal(occurrences.length, 2);
  assert.deepEqual(occurrences.map((item) => item.kind), ["event", "deadline"]);
  assert.deepEqual(occurrences.map((item) => item.provenance.connected_relation), [
    "decides_land_project",
    "project_procurement_milestone",
  ]);
  assert.deepEqual(occurrences.map((item) => item.source.system), ["city_record", "city_record"]);

  const ics = icsFeed({ title: "Riverfront rezoning", occurrences });
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
  assert.match(ics, /SUMMARY:Public hearing — Riverfront rezoning/);
  assert.match(ics, /SUMMARY:Bids due — School roof repair/);
});

test("duplicate source records for one real-world event collapse to one entry", () => {
  const duplicate = {
    ...hearing,
    ref: "notice:hearing-duplicate",
    calendar_record: {
      ...hearing.calendar_record,
      object_ref: "notice:hearing-duplicate",
      source: { system: "community_board_calendar", record_id: "cb-copy-1", url: "https://example.gov/cb-copy-1" },
    },
  };
  const occurrences = projectCalendarOccurrences({
    project_ref: PROJECT_REF,
    connected_records: [hearing, duplicate],
  }, { as_of: "2026-08-27" });
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].uid, "notice:hearing-1:event");
  assert.equal(occurrences[0].source.record_id, "hearing-1");
});

test("removing a graph-supported relation removes its occurrence", () => {
  const before = projectCalendarOccurrences({
    project_ref: PROJECT_REF,
    connected_records: [hearing, procurement],
  }, { as_of: "2026-08-27" });
  const after = projectCalendarOccurrences({
    project_ref: PROJECT_REF,
    connected_records: [hearing],
  }, { as_of: "2026-08-27" });
  assert.deepEqual(before.map((item) => item.uid), [
    "notice:hearing-1:event",
    "procurement:city_record:solicitation-1:deadline",
  ]);
  assert.deepEqual(after.map((item) => item.uid), ["notice:hearing-1:event"]);
});

test("a newly connected milestone changes feed contents without changing its URL", () => {
  const feedUrl = projectCalendarFeedUrl(PROJECT_REF);
  const before = projectCalendarOccurrences({ project_ref: PROJECT_REF, connected_records: [hearing] }, { as_of: "2026-08-27" });
  const after = projectCalendarOccurrences({
    project_ref: PROJECT_REF,
    connected_records: [hearing, {
      relation: "project_disposition",
      ref: "project:2026M0001:vote:1",
      calendar_record: {
        object_ref: "project:2026M0001:vote:1",
        title: "CPC vote — Riverfront rezoning",
        event_date: "2026-10-01",
        canonical_url: "https://cityscroll.org/#land/2026M0001",
        source: { system: "zap-api-outcomes", record_id: "vote-1", url: "https://example.gov/project" },
      },
    }],
  }, { as_of: "2026-08-27" });
  assert.equal(feedUrl, projectCalendarFeedUrl(PROJECT_REF));
  assert.equal(before.length, 1);
  assert.equal(after.length, 2);
  assert.ok(after.some((item) => item.source.system === "zap-api-outcomes"));
});

test("held constellation edges never leak an occurrence", () => {
  const occurrences = projectCalendarOccurrences({
    project_ref: PROJECT_REF,
    connections: connections([{ ...hearing, state: "held" }]),
  }, { as_of: "2026-08-27" });
  assert.deepEqual(occurrences, []);
});

test("project surface exposes Following and the same stable calendar subscription scope", () => {
  const html = projectCalendarActionsHTML({
    projectId: "2026M0001",
    projectName: "Riverfront rezoning",
  });
  assert.match(html, />Follow project</);
  assert.match(html, />Subscribe to project calendar</);
  assert.match(html, /data-calendar-subscription="scope"/);
  assert.match(html, /data-calendar-subscription-webcal="webcal:/);
  const followHref = /href="([^"]+)"[^>]*>Follow project/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(followHref);
  const follow = new URL(followHref, "https://cityscroll.org");
  assert.equal(follow.searchParams.get("lens"), "entity");
  assert.deepEqual(JSON.parse(follow.searchParams.get("filter")), {
    entity_refs_all: [PROJECT_REF],
  });
});
