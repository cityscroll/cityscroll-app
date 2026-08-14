import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  applyApiLimits,
  buildMeetingOutcomes,
} from "../../worker/src/lib/meeting_outcomes.mjs";
import { normalizeHearing } from "../../worker/src/lib/hearings.mjs";
import {
  MEETING_ORIGINS,
  meetingSourceUrl,
  normalizeMeetingOrigin,
} from "../../site/meeting_origin.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/meeting_outcomes.json", import.meta.url), "utf8"));
const meetingsSnapshot = JSON.parse(await readFile(
  new URL("../../site/data/meetings_domain_observations.json", import.meta.url),
  "utf8",
));

function model() {
  return buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
}

// ---------------------------------------------------------------------------
// Chain characterization: notice -> (strict join) -> event -> agenda item -> matter
// ---------------------------------------------------------------------------

test("contract fixture follows notice -> event -> agenda -> matter with strict join", () => {
  const modelRow = model();
  assert.equal(modelRow.records.length, 1);

  const record = modelRow.records[0];
  assert.equal(record.join.matched, true);
  assert.equal(record.join.method, "exact_date_body_tokens");

  const event = record.council_event;
  assert.equal(event.event_id, "evt-001");
  assert.equal(event.body_name, "Subcommittee on Land Use");
  assert.equal(event.documents.length, 2);

  const item = record.agenda_items[0];
  assert.equal(item.matters.length, 1);

  const matter = item.matters[0];
  assert.equal(matter.matter_id, "mat-001");
  assert.equal(matter.matter_file, "LU 0001-2026");
  assert.equal(matter.status, "Adopted");
  assert.equal(matter.outcome, "Approved by Subcommittee");
  assert.equal(matter.votes[0].result, "Passed");
  assert.equal(matter.votes[0].counts.aye, 6);
  assert.equal(matter.votes[0].counts.nay, 3);
  assert.equal(matter.votes[0].by_person.length, 3);
  assert.equal(matter.votes[0].officials.length, 3);
  assert.equal(matter.votes[0].votes_on.length, 3);
  assert.equal(matter.votes[0].votes_on[0].type, "votes_on");
  assert.equal(matter.votes[0].votes_on[0].from, "official:p-101");
  assert.equal(matter.votes[0].votes_on[0].to, "matter:mat-001");
  assert.equal(matter.votes[0].person_vote_retention_rate, 1);
  assert.equal(matter.documents[0].name, "Staff report");

  // Matter-centric vote spine: one connected object for the full path.
  assert.equal(record.spines.length, 1);
  assert.equal(record.spines[0].subject_ref, "matter:mat-001");
  assert.deepEqual(
    record.spines[0].stages.map((s) => s.kind),
    ["agenda", "matter", "action", "vote", "attachment"],
  );
  assert.equal(record.spines[0].full, true);
});

test("notice location and affected-area still surface through normalizeHearing", () => {
  const modelRow = model();
  const record = modelRow.records[0];
  assert.equal(record.notice.affected_area.scope, "local");
  assert.deepEqual(record.notice.affected_area.boroughs, ["Queens"]);
  assert.equal(record.notice.venue.address, "120 Broad Street, New York, NY, 10271");
  assert.equal(record.notice.meeting_origin, "city_record_notice");
  assert.match(record.notice.source_url, /CR-1001/);
});

test("meeting origin vocabulary defaults City Record rows without promoting board signals", () => {
  assert.deepEqual(MEETING_ORIGINS, [
    "city_record_notice",
    "official_community_board_calendar",
    "official_minutes_joined",
    "community_board_source_observed",
    "unknown",
  ]);
  assert.equal(normalizeMeetingOrigin({ agency_name: "Community Boards" }), "unknown");
  assert.equal(normalizeMeetingOrigin({
    agency_name: "Community Boards",
    source_system: "city_record",
  }), "city_record_notice");
  assert.equal(normalizeHearing({
    request_id: "20260618032",
    agency_name: "Community Boards",
    short_title: "Community Board meeting",
  }).meeting_origin, "city_record_notice");
});

test("official origins and source URLs require explicit upstream assertions", () => {
  assert.equal(normalizeMeetingOrigin({
    meeting_origin: "official_community_board_calendar",
    agency_name: "Community Boards",
  }), "official_community_board_calendar");
  assert.equal(normalizeMeetingOrigin({ meeting_origin: "not-an-origin" }), "unknown");
  assert.equal(meetingSourceUrl({ meeting_origin: "official_minutes_joined" }), null);
});

test("committed meeting observations carry origin and City Record source provenance", () => {
  assert.deepEqual(meetingsSnapshot.meeting_origin_vocabulary, MEETING_ORIGINS);
  assert.ok(meetingsSnapshot.rows.length > 0);
  for (const row of meetingsSnapshot.rows) {
    assert.ok(MEETING_ORIGINS.includes(row.meeting_origin), row.request_id);
    assert.equal(row.meeting_origin, "city_record_notice", row.request_id);
    assert.match(row.source_url, new RegExp(`${row.request_id}$`));
  }
  const boardRows = meetingsSnapshot.rows.filter((row) => row.agency_name === "Community Boards");
  assert.ok(boardRows.length > 0);
  assert.ok(boardRows.every((row) => row.meeting_origin !== "official_community_board_calendar"));
});

// ---------------------------------------------------------------------------
// Unmatched behavior is explicit and machine-readable
// ---------------------------------------------------------------------------

test("unmatched notice records explicit reasons and empty outcome rows", () => {
  const unmatched = modelWithNotice({
    ...fixture.notices[0],
    request_id: "CR-1002",
    short_title: "Council office systems update",
  });

  assert.equal(unmatched.records.length, 1);
  assert.equal(unmatched.records[0].join.matched, false);
  assert.equal(unmatched.records[0].join.reason.includes("No Council event"), true);
  assert.equal(unmatched.records[0].agenda_items.length, 0);
});

test("same-day body mismatch is rejected by the strict join", () => {
  // Same date, but the notice title names a different body than the event.
  const rejected = buildMeetingOutcomes(
    [{ ...fixture.notices[0], short_title: "7-28-26 Subcommittee on Zoning and Franchises meeting" }],
    fixture.events,
    fixture.event_items,
    fixture.votes,
  );
  assert.equal(rejected.records[0].join.matched, false);
});

function modelWithNotice(notice) {
  return buildMeetingOutcomes(
    [notice],
    fixture.events,
    fixture.event_items,
    fixture.votes,
  );
}

// ---------------------------------------------------------------------------
// API page and cap behavior
// ---------------------------------------------------------------------------

test("API caps remain bounded regardless of requested limit", () => {
  const rows = Array.from({ length: 250 }, (_, index) => ({ request_id: `CR-${index + 1}` }));
  const limited = applyApiLimits(rows, { limit: 250, offset: 120 });

  assert.equal(limited.limit, 100);
  assert.equal(limited.offset, 120);
  assert.equal(limited.total, 250);
  assert.equal(limited.rows.length, 100);
});
