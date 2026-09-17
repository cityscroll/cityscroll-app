import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildMeetingOutcomesSnapshot,
  compactMeetingOutcomeRecord,
  compactVotes,
  retainBoundRollCall,
  renderMeetingOutcomesFirstPaint,
} from "../site/meeting_outcomes_static.mjs";
import { buildMeetingOutcomes } from "../worker/src/lib/meeting_outcomes.mjs";
import { unboundRollCalls } from "../ops/first-class-refresh/guard-publication.mjs";

const fixture = JSON.parse(readFileSync(new URL("./contract/fixtures/meeting_outcomes.json", import.meta.url), "utf8"));

test("meeting snapshot renders documents and outcomes on first paint", () => {
  const model = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.event_items,
    fixture.votes,
    fixture.attachments,
  );
  const record = model.records.find((row) => row.join?.matched) || model.records[0];
  const snapshot = buildMeetingOutcomesSnapshot([record], { generatedAt: "2026-08-05T13:00:00Z" });
  const html = renderMeetingOutcomesFirstPaint(snapshot, record.request_id);
  assert.match(html, /data-meeting-outcomes-first-paint="1"/);
  assert.match(html, /data-meeting-outcomes-state="present"/);
  assert.match(html, /Decision documents and outcomes/);
  assert.match(html, /node-source-disclosure/);
  assert.match(html, /meeting-source-link/);
  assert.doesNotMatch(html, /class="loading"/);
});

test("known empty meeting snapshot renders honest absence instead of a spinner", () => {
  const snapshot = buildMeetingOutcomesSnapshot([{
    request_id: "20260805001",
    join: { matched: false },
  }]);
  const html = renderMeetingOutcomesFirstPaint(snapshot, "20260805001");
  assert.match(html, /data-meeting-outcomes-state="absent"/);
  assert.match(html, /No decision documents published for this meeting\./);
  assert.doesNotMatch(html, /loading/i);
});

test("compactVotes accepts aye/nay publisher keys without inventing persons", () => {
  const withPeople = compactVotes({
    result: "Passed",
    counts: { aye: 5, nay: 1, abstain: 0 },
    vote_identity: "roll_call",
    by_person: [{ person_id: "1", person_name: "Ada", vote_bucket: "aye" }],
  });
  assert.equal(withPeople.yes, 5);
  assert.equal(withPeople.no, 1);
  assert.equal(withPeople.by_person.length, 1);

  const tallyOnly = compactVotes({
    result: "Passed",
    counts: { aye: 0, nay: 0, abstain: 7 },
    vote_identity: "tally_only",
    by_person: [],
  });
  assert.equal(tallyOnly.yes, 0);
  assert.equal(tallyOnly.vote_identity, "tally_only");
  assert.equal(tallyOnly.by_person.length, 0);
});

test("named roll calls without exact event and agenda-item refs are not retained as traceable", () => {
  const unbound = retainBoundRollCall(compactVotes({
    result: "Passed",
    counts: { aye: 5, nay: 1 },
    vote_identity: "roll_call",
    event_id: null,
    event_item_id: null,
    by_person: [{ person_id: "1", person_name: "Ada", vote_bucket: "aye" }],
  }), { eventId: "event-1", agendaItemId: "item-1" });
  assert.equal(unbound.person_count, 0);
  assert.deepEqual(unbound.by_person, []);
  assert.equal(unbound.vote_identity, "tally_only");
  assert.equal(unbound.yes, 5);

  const bound = retainBoundRollCall(compactVotes({
    result: "Passed",
    counts: { aye: 5, nay: 1 },
    vote_identity: "roll_call",
    event_id: "event-1",
    event_item_id: "item-1",
    by_person: [{ person_id: "1", person_name: "Ada", vote_bucket: "aye" }],
  }), { eventId: "event-1", agendaItemId: "item-1" });
  assert.equal(bound.person_count, 1);
  assert.equal(bound.event_id, "event-1");
  assert.equal(bound.event_item_id, "item-1");

  const snapshot = buildMeetingOutcomesSnapshot([
    {
      request_id: "20260917001",
      join: { matched: true },
      council_event: { event_id: "event-1", name: "Stated Meeting", date: "2026-09-17", url: "https://example.test/event/1", documents: [] },
      agenda_items: [{
        agenda_item_id: "item-1",
        title: "Example matter",
        matters: [{
          matter_id: "matter-1",
          matter_file: "Int 0001",
          agenda_item_id: "item-1",
          outcome: "Adopted",
          votes: {
            result: "Passed",
            counts: { aye: 5, nay: 1 },
            vote_identity: "roll_call",
            by_person: [{ person_id: "1", person_name: "Ada", vote_bucket: "aye" }],
          },
        }],
      }],
    },
  ], { generatedAt: "2026-09-17T12:00:00Z" });
  assert.equal(unboundRollCalls(snapshot).length, 0);
  const action = Object.values(snapshot.by_notice)[0].matters[0].item_actions[0];
  assert.equal(action.votes.person_count, 0);
  assert.equal(action.vote_state, "tally_recorded");

  const compacted = compactMeetingOutcomeRecord({
    request_id: "20260917002",
    join: { matched: true },
    council_event: { event_id: "event-2", documents: [] },
    agenda_items: [{
      agenda_item_id: "item-2",
      matters: [{
        matter_id: "matter-2",
        agenda_item_id: "item-2",
        votes: {
          result: "Passed",
          counts: { aye: 3, nay: 0 },
          event_id: "event-2",
          event_item_id: "item-2",
          vote_identity: "roll_call",
          by_person: [{ person_id: "2", person_name: "Bea", vote_bucket: "aye" }],
        },
      }],
    }],
  });
  assert.equal(compacted.matters[0].item_actions[0].votes.person_count, 1);
  assert.equal(compacted.matters[0].item_actions[0].vote_state, "roll_call_recorded");
});
