import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildMeetingOutcomesSnapshot,
  compactVotes,
  renderMeetingOutcomesFirstPaint,
} from "../site/meeting_outcomes_static.mjs";
import { buildMeetingOutcomes } from "../worker/src/lib/meeting_outcomes.mjs";

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
