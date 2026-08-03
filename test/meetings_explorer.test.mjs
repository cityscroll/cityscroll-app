/**
 * Meetings domain explorer — process-stage ontology, multi-notice grouping, next-action keys.
 *
 *   node --test test/meetings_explorer.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MEETINGS_PROCESS_STAGES,
  buildMeetingsExplorerEntries,
  countMeetingsProcessStages,
  entryCurrentProcessStage,
  filterMeetingsExplorerEntries,
  groupMeetingsByPlace,
  hasAgendaSignal,
  hasOutcomesSignal,
  meetingEventSubjectKey,
  meetingProcessActionKey,
  meetingProcessFilterKey,
  meetingProcessStage,
  meetingsAgencyName,
  pickPrimaryHearing,
} from "../site/meetings_explorer.mjs";

const NOW = "2026-08-02";

function hearing(partial) {
  return {
    request_id: "20260801001",
    agency: "City Planning Commission",
    notice_type: "Public Hearings",
    title: "Public hearing on a land-use matter",
    decides: "Whether to certify a Brooklyn special permit application",
    event_date: "2026-08-10",
    published_at: "2026-08-01",
    source_section: "Public Hearings and Meetings",
    description: "A public hearing will be held.",
    affected_area: { scope: "local", boroughs: ["Brooklyn"], neighborhoods: ["Gowanus"] },
    venue: { mode: "in-person", building: "Spector Hall", address: "22 Reade Street" },
    participation: { links: [], emails: [], phones: [] },
    affects: [],
    ...partial,
  };
}

test("MEETINGS_PROCESS_STAGES is the ops-ontology rail (not the date window)", () => {
  const keys = MEETINGS_PROCESS_STAGES.map(([k]) => k);
  assert.deepEqual(keys, [
    "all",
    "scheduled",
    "agenda",
    "held",
    "outcomes",
    "unstaged",
  ]);
});

test("meetingProcessStage classifies upcoming scheduled vs agenda from notice signals", () => {
  const bare = hearing({ event_date: "2026-08-15", description: "A hearing will be held." });
  assert.equal(meetingProcessStage(bare, { now: NOW }), "scheduled");

  const withAgenda = hearing({
    event_date: "2026-08-15",
    description: "The agenda is published with the notice package.",
  });
  assert.equal(meetingProcessStage(withAgenda, { now: NOW }), "agenda");

  const meetingType = hearing({
    event_date: "2026-08-15",
    notice_type: "Meeting",
    description: "Monthly board meeting.",
  });
  assert.equal(meetingProcessStage(meetingType, { now: NOW }), "agenda");

  const withJoin = hearing({
    event_date: "2026-08-15",
    participation: {
      links: [{ label: "Join online", url: "https://zoom.example/j/1" }],
      emails: [],
      phones: [],
    },
  });
  assert.equal(meetingProcessStage(withJoin, { now: NOW }), "agenda");
  assert.equal(hasAgendaSignal(withJoin), true);
});

test("meetingProcessStage classifies past held vs outcomes without inventing votes", () => {
  const held = hearing({
    event_date: "2026-07-20",
    description: "A public hearing was noticed.",
  });
  assert.equal(meetingProcessStage(held, { now: NOW }), "held");
  assert.equal(hasOutcomesSignal(held), false);

  const minutes = hearing({
    event_date: "2026-07-20",
    description: "Minutes of the prior hearing are available on the board site.",
  });
  assert.equal(meetingProcessStage(minutes, { now: NOW }), "outcomes");

  const matched = hearing({
    event_date: "2026-07-20",
    meeting_outcomes_matched: true,
  });
  assert.equal(meetingProcessStage(matched, { now: NOW }), "outcomes");

  assert.equal(meetingProcessStage({ title: "No date" }, { now: NOW }), null);
  assert.equal(meetingProcessFilterKey({ title: "No date" }, { now: NOW }), "unstaged");
});

test("meetingProcessActionKey prefers join / testimony / dated attend when published", () => {
  assert.equal(meetingProcessActionKey(null), "meeting_action_open_notice");
  assert.equal(meetingProcessActionKey("held"), "meeting_action_review_held");
  assert.equal(meetingProcessActionKey("outcomes"), "meeting_action_review_outcomes");

  const join = hearing({
    participation: {
      links: [{ label: "Join online", url: "https://zoom.example/j/1" }],
      emails: [],
      phones: [],
    },
  });
  assert.equal(meetingProcessActionKey("agenda", join), "meeting_action_join_online");

  const testimony = hearing({
    participation: {
      links: [],
      emails: ["testify@example.com"],
      phones: [],
    },
  });
  assert.equal(
    meetingProcessActionKey("scheduled", testimony),
    "meeting_action_submit_testimony",
  );

  const dated = hearing({ event_date: "2026-08-12", participation: { links: [], emails: [], phones: [] } });
  assert.equal(meetingProcessActionKey("scheduled", dated), "meeting_action_attend_dated");
});

test("buildMeetingsExplorerEntries collapses same-agency same-day notices", () => {
  const a = hearing({
    request_id: "20260810011",
    agency: "Landmarks Preservation Commission",
    event_date: "2026-08-12",
    decides: "Certificate of appropriateness for 100 Main Street",
    affected_area: { scope: "local", boroughs: ["Manhattan"], neighborhoods: ["SoHo"] },
  });
  const b = hearing({
    request_id: "20260810012",
    agency: "Landmarks Preservation Commission",
    event_date: "2026-08-12",
    decides: "Certificate of appropriateness for 200 Side Street",
    affected_area: { scope: "citywide", boroughs: [] },
  });
  const c = hearing({
    request_id: "20260815001",
    agency: "Landmarks Preservation Commission",
    event_date: "2026-08-20",
    decides: "A separate later hearing",
  });

  const entries = buildMeetingsExplorerEntries([a, b, c], { now: NOW });
  assert.equal(entries.length, 2);
  const eventCard = entries.find((e) => e.kind === "event");
  const singleton = entries.find((e) => e.kind === "notice");
  assert.ok(eventCard);
  assert.equal(eventCard.notice_count, 2);
  assert.equal(eventCard.join_method, "agency_event_date");
  // Prefer local place scope when collapsing (preserve place strength).
  assert.equal(eventCard.place_scope, "local");
  assert.equal(eventCard.primary.request_id, "20260810011");
  assert.ok(singleton);
  assert.equal(singleton.request_id || singleton.primary.request_id, "20260815001");
  assert.equal(meetingEventSubjectKey(a), meetingEventSubjectKey(b));
});

test("buildMeetingsExplorerEntries collapses multi-notice matter subject across dates", () => {
  const decides =
    "Whether to approve the franchise agreement with OneChronos Markets LLC for information services";
  const hearing1 = hearing({
    request_id: "20260501001",
    agency: "Franchise and Concession Review Committee",
    event_date: "2026-05-10",
    decides,
    description: "Public hearing notice.",
  });
  const hearing2 = hearing({
    request_id: "20260601001",
    agency: "Franchise and Concession Review Committee",
    event_date: "2026-06-15",
    decides,
    description: "Follow-up meeting on the same franchise matter.",
  });
  const other = hearing({
    request_id: "20260701001",
    agency: "Franchise and Concession Review Committee",
    event_date: "2026-07-01",
    decides: "Unrelated monthly calendar roster for FCRC",
  });

  const entries = buildMeetingsExplorerEntries([hearing1, hearing2, other], { now: NOW });
  const matter = entries.find((e) => e.kind === "matter");
  assert.ok(matter, "matter journey should collapse to one card");
  assert.equal(matter.notice_count, 2);
  assert.equal(matter.join_method, "matter_subject");
  assert.equal(matter.sibling_notices.length, 2);
  // Other notice remains its own card.
  assert.ok(entries.some((e) => e.primary?.request_id === "20260701001"));
});

test("filterMeetingsExplorerEntries and counts support the process rail", () => {
  const rows = [
    hearing({
      request_id: "u1",
      agency: "Agency A",
      decides: "Whether to open a new community garden on Atlantic Avenue in Brooklyn",
      event_date: "2026-08-20",
      description: "Upcoming hearing.",
    }),
    hearing({
      request_id: "u2",
      agency: "Agency B",
      decides: "Whether to renew a sidewalk cafe license on Court Street in Brooklyn",
      event_date: "2026-08-18",
      description: "Agenda package attached.",
      notice_type: "Meeting",
    }),
    hearing({
      request_id: "p1",
      agency: "Agency C",
      decides: "Whether to designate a landmark at 40 Willow Street in Brooklyn",
      event_date: "2026-07-01",
      description: "Past hearing.",
    }),
    hearing({
      request_id: "p2",
      agency: "Agency D",
      decides: "Whether to amend parking rules near Flushing Meadows in Queens",
      event_date: "2026-06-01",
      description: "Minutes published after the hearing.",
    }),
  ];
  const entries = buildMeetingsExplorerEntries(rows, { now: NOW });
  const counts = countMeetingsProcessStages(entries);
  assert.equal(counts.all, 4);
  assert.ok(counts.scheduled >= 1);
  assert.ok(counts.agenda >= 1);
  assert.ok(counts.held >= 1);
  assert.ok(counts.outcomes >= 1);

  const scheduledOnly = filterMeetingsExplorerEntries(entries, {
    process: "scheduled",
    now: NOW,
  });
  assert.ok(scheduledOnly.every((e) => e.process_filter === "scheduled"
    || (e.matched_phases || []).includes("scheduled")
    || (e.members || []).some((m) => meetingProcessStage(m, { now: NOW }) === "scheduled")));
});

test("groupMeetingsByPlace preserves local / citywide / unlocated sections", () => {
  const entries = buildMeetingsExplorerEntries(
    [
      hearing({
        request_id: "1",
        agency: "Agency Local",
        decides: "Whether to approve a special permit for a school in Queens",
        event_date: "2026-08-10",
        affected_area: { scope: "local", boroughs: ["Queens"] },
      }),
      hearing({
        request_id: "2",
        agency: "Other Agency",
        decides: "Whether to adopt citywide procurement rules for hearing officers",
        event_date: "2026-08-11",
        affected_area: { scope: "citywide" },
      }),
      hearing({
        request_id: "3",
        agency: "Third Agency",
        decides: "Whether to convene a board without a stated neighborhood scope",
        event_date: "2026-08-12",
        affected_area: { scope: "unlocated" },
      }),
    ],
    { now: NOW },
  );
  const groups = groupMeetingsByPlace(entries);
  assert.equal(groups.local.length, 1);
  assert.equal(groups.citywide.length, 1);
  assert.equal(groups.unlocated.length, 1);
});

test("pickPrimaryHearing prefers local scope; meetingsAgencyName cleans agency", () => {
  const local = hearing({ affected_area: { scope: "local" }, request_id: "L" });
  const city = hearing({ affected_area: { scope: "citywide" }, request_id: "C" });
  assert.equal(pickPrimaryHearing([city, local]).request_id, "L");
  assert.equal(meetingsAgencyName(local), "City Planning Commission");
  // Furthest along the arc wins (held after agenda in process order).
  assert.equal(entryCurrentProcessStage([
    hearing({ event_date: "2026-07-01" }),
    hearing({ event_date: "2026-08-20", notice_type: "Meeting" }),
  ], { now: NOW }), "held");
});
