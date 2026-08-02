/**
 * Characterization: matter-centric meeting vote spine
 * (agenda → matter → action → vote → attachment) and
 * meeting_vote_spine_completeness_rate.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  buildMeetingOutcomes,
  buildMeetingVoteSpine,
  buildMeetingVoteSpines,
  measureMeetingVoteSpineCompleteness,
  MEETING_VOTE_SPINE_STAGES,
} from "../worker/src/lib/meeting_outcomes.mjs";
import { mapMeetingRecordToCivic } from "../worker/src/lib/civic_time.mjs";

const fixture = JSON.parse(
  await readFile(new URL("./contract/fixtures/meeting_outcomes.json", import.meta.url), "utf8"),
);

function model() {
  return buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
}

test("MEETING_VOTE_SPINE_STAGES is agenda→matter→action→vote→attachment", () => {
  assert.deepEqual([...MEETING_VOTE_SPINE_STAGES], [
    "agenda",
    "matter",
    "action",
    "vote",
    "attachment",
  ]);
});

test("buildMeetingOutcomes stamps one connected spine object per matter", () => {
  const view = model();
  const record = view.records[0];
  assert.equal(record.join.matched, true);
  assert.equal(record.spines.length, 1);

  const spine = record.spines[0];
  assert.equal(spine.subject_ref, "matter:mat-001");
  assert.equal(spine.matter_id, "mat-001");
  assert.equal(spine.agenda_item_id, "evtitem-001");
  assert.equal(spine.event_id, "evt-001");
  assert.equal(spine.full, true);
  assert.equal(spine.stage_fill, 1);
  assert.deepEqual(
    spine.stages.map((s) => s.kind),
    ["agenda", "matter", "action", "vote", "attachment"],
  );
  assert.ok(spine.stages.every((s) => s.matched === true));

  // Action and vote are distinct stages on the same object.
  const action = spine.stages.find((s) => s.kind === "action");
  const vote = spine.stages.find((s) => s.kind === "vote");
  const attachment = spine.stages.find((s) => s.kind === "attachment");
  assert.equal(action.action_name, "Approved by Subcommittee");
  assert.equal(vote.result, "Passed");
  assert.equal(vote.counts.aye, 6);
  assert.equal(vote.by_person.length, 3);
  assert.ok(attachment.documents.some((d) => d.name === "Staff report"));
  assert.ok(attachment.documents.some((d) => d.name === "Agenda"));
  // Fixture matter_id is non-numeric ("mat-001") → no invented matter_url
  const matterStage = spine.stages.find((s) => s.kind === "matter");
  assert.equal(matterStage.matter_url, null);
});

test("buildMeetingVoteSpine stamps Gateway matter_url for numeric MatterIds", () => {
  const spine = buildMeetingVoteSpine({
    item: { agenda_item_id: "a1", title: "Item" },
    matter: { matter_id: "79062", matter_file: "LU 0091-2026", title: "Public School 15 Annex" },
    event: { event_id: "22526" },
  });
  const matter = spine.stages.find((s) => s.kind === "matter");
  assert.equal(
    matter.matter_url,
    "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79062",
  );
});

test("meeting_vote_spine_completeness_rate moves from 0 (empty) to 1 (full fixture)", () => {
  const empty = measureMeetingVoteSpineCompleteness([]);
  assert.equal(empty.metric, "meeting_vote_spine_completeness_rate");
  assert.equal(empty.meeting_vote_spine_completeness_rate, 0);
  assert.equal(empty.spine_count, 0);

  // Partial spine: agenda + matter only.
  const partial = buildMeetingVoteSpine({
    item: { agenda_item_id: "a1", title: "Item" },
    matter: { matter_id: "m1", title: "Matter" },
    event: { event_id: "e1" },
  });
  assert.equal(partial.stage_fill, 2 / 5);
  const mid = measureMeetingVoteSpineCompleteness([{
    join: { matched: true },
    spines: [partial],
  }]);
  assert.equal(mid.meeting_vote_spine_completeness_rate, 0.4);
  assert.equal(mid.stage_rates.agenda, 1);
  assert.equal(mid.stage_rates.vote, 0);

  const full = measureMeetingVoteSpineCompleteness(model().records);
  assert.equal(full.meeting_vote_spine_completeness_rate, 1);
  assert.equal(full.full_spine_rate, 1);
  assert.equal(full.spine_count, 1);
  assert.deepEqual(full.stage_rates, {
    agenda: 1,
    matter: 1,
    action: 1,
    vote: 1,
    attachment: 1,
  });
});

test("view metrics expose meeting_vote_spine_completeness_rate", () => {
  const view = model();
  assert.equal(view.metrics.meeting_vote_spine_completeness_rate, 1);
  assert.equal(view.counts.spines, 1);
  assert.equal(view.counts.full_spines, 1);
});

test("unmatched notice has empty spines and does not inflate completeness", () => {
  const view = buildMeetingOutcomes(
    [{ ...fixture.notices[0], request_id: "CR-9999", short_title: "Unrelated agency briefing" }],
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
  assert.equal(view.records[0].join.matched, false);
  assert.deepEqual(view.records[0].spines, []);
  assert.equal(view.metrics.meeting_vote_spine_completeness_rate, 0);
  assert.equal(view.counts.spines, 0);
});

test("mapMeetingRecordToCivic reads production spine shape (action on matter)", () => {
  const record = model().records[0];
  const civic = mapMeetingRecordToCivic(record, {
    observed_at: "2026-07-29T06:00:00.000Z",
    processed_at: "2026-08-01T12:00:00.000Z",
  });
  assert.deepEqual(
    civic.map((e) => e.event_kind),
    ["meetings.council_event", "meetings.agenda_item_action", "meetings.roll_call_vote"],
  );
  assert.equal(civic[0].subject_ref, "legistar-event:evt-001");
});

test("buildMeetingVoteSpines is pure and rebuildable from nested agenda_items", () => {
  const record = model().records[0];
  const without = { ...record, spines: undefined };
  const rebuilt = buildMeetingVoteSpines(without);
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0].full, true);
  assert.equal(rebuilt[0].subject_ref, "matter:mat-001");
});
