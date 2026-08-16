/**
 * Meetings domain explorer — process-stage ontology, multi-notice grouping, next-action keys.
 *
 *   node --test test/meetings_explorer.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { SITE_SOURCE } from "./helpers/site_source.mjs";

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
import { renderObjectCardActionRail } from "../site/affordance_grammar.mjs";
import { meetingsCardInteractionProjection } from "../site/meetings_card_interaction.mjs";

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

test("place groups use positive headings without methodology notes", () => {
  assert.match(
    SITE_SOURCE,
    /const noteText=scope==="citywide"\?t\("citywide_hearings_note"\):"";/,
  );
  assert.doesNotMatch(SITE_SOURCE, /local_hearings_note|unlocated_hearings_note/);
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
      // Constructed so the public PR surface never contains a literal mailbox string.
      emails: [["testify", "example.com"].join("@")],
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

test("filterMeetingsExplorerEntries and counts support exclusive current-stage buckets", () => {
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
  assert.ok(scheduledOnly.every((e) => e.process_filter === "scheduled"));
  for (const [key] of MEETINGS_PROCESS_STAGES) {
    assert.equal(
      counts[key],
      filterMeetingsExplorerEntries(entries, { process: key, now: NOW }).length,
      `count-equals-list for ${key}`,
    );
  }
});

test("multi-notice meetings appear only in their current-stage bucket", () => {
  const decides = "Whether to renew the same public market concession";
  const entries = buildMeetingsExplorerEntries([
    hearing({
      request_id: "past",
      agency: "Franchise and Concession Review Committee",
      decides,
      event_date: "2026-07-20",
      description: "The public hearing was held.",
    }),
    hearing({
      request_id: "future",
      agency: "Franchise and Concession Review Committee",
      decides,
      event_date: "2026-08-20",
      description: "A follow-up public hearing is scheduled.",
    }),
  ], { now: NOW });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].process_filter, "held");

  const counts = countMeetingsProcessStages(entries);
  for (const [key] of MEETINGS_PROCESS_STAGES) {
    assert.equal(
      counts[key],
      filterMeetingsExplorerEntries(entries, { process: key, now: NOW }).length,
      `count-equals-list for ${key}`,
    );
  }
  assert.equal(filterMeetingsExplorerEntries(entries, { process: "scheduled", now: NOW }).length, 0);
  assert.equal(filterMeetingsExplorerEntries(entries, { process: "held", now: NOW }).length, 1);
});

test("groupMeetingsByPlace preserves local / citywide / unlocated sections (opt-in)", () => {
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

test("meetings place grouping is opt-in (default flat)", async () => {
  const { meetingsPlaceGroupEnabled, MEETINGS_PLACE_GROUP_MODES } = await import(
    "../site/meetings_explorer.mjs"
  );
  assert.equal(meetingsPlaceGroupEnabled("flat"), false);
  assert.equal(meetingsPlaceGroupEnabled(undefined), false);
  assert.equal(meetingsPlaceGroupEnabled("place"), true);
  assert.ok(MEETINGS_PLACE_GROUP_MODES.some(([k]) => k === "flat"));
  assert.ok(MEETINGS_PLACE_GROUP_MODES.some(([k]) => k === "place"));
  // Default list path is flat — group=place is the opt-in share link.
  assert.match(SITE_SOURCE, /meetingsPlaceGroupSel="flat"/);
  assert.match(SITE_SOURCE, /q\.set\("group", "place"\)/);
  assert.match(SITE_SOURCE, /meetingsplacegrouprail/);
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

test("meeting card interactions separate canonical navigation from published participation", () => {
  const passive = meetingsCardInteractionProjection({
    meeting_id: "meeting:city_record:20260801001",
    request_id: "20260801001",
    title: "Harbor access hearing",
    source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260801001",
    source_label: "Official source",
  });
  assert.equal(passive.target.href, "/meetings/meeting%3Acity_record%3A20260801001");
  assert.equal(passive.copy_target, "https://cityscroll.org/meetings/meeting%3Acity_record%3A20260801001");
  assert.deepEqual(passive.kinetic_actions, []);
  assert.equal(renderObjectCardActionRail(passive), "");
  assert.equal(passive.external_handoffs[0].kind, "official_source");

  const participatory = meetingsCardInteractionProjection({
    meeting_id: "meeting:community_board:harbor",
    title: "Harbor committee meeting",
    participation_actions: [
      { label: "Join online", href: "https://meet.example.gov/harbor", kind: "join", context_ready: true },
      { label: "Email listed in notice", href: "mailto:testimony@example.gov", kind: "testify", context_ready: true },
    ],
    guide_html: "<details><summary>How to participate</summary><p>Published meeting instructions.</p></details>",
    guide_source_backed: true,
  });
  assert.deepEqual(participatory.kinetic_actions.map((action) => action.kind), ["join", "testify"]);
  const rail = renderObjectCardActionRail(participatory);
  assert.match(rail, /Join online<span aria-hidden="true">↗<\/span>/);
  assert.match(rail, /Email listed in notice<span aria-hidden="true">↗<\/span>/);
  assert.match(rail, /How to participate/);

  const unbackedGuide = meetingsCardInteractionProjection({
    request_id: "20260801002",
    title: "Meeting without published instructions",
    guide_html: "<p>Generic advice.</p>",
    guide_source_backed: false,
  });
  assert.equal(renderObjectCardActionRail(unbackedGuide), "");
});
