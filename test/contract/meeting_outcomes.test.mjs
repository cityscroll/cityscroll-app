import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";

import {
  applyApiLimits,
  buildMeetingOutcomes,
} from "../../worker/src/lib/meeting_outcomes.mjs";

const fixture = JSON.parse(await readFile(new URL("./fixtures/meeting_outcomes.json", import.meta.url), "utf8"));

function model() {
  return buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.agenda_items,
    fixture.matters,
    fixture.votes,
    fixture.documents,
  );
}

// ---------------------------------------------------------------------------
// Chain characterization: notice -> agenda item -> matter -> vote -> document
// ---------------------------------------------------------------------------

test("contract fixture follows notice -> agenda -> matter -> vote -> document", () => {
  const modelRow = model();
  assert.equal(modelRow.records.length, 1);

  const record = modelRow.records[0];
  assert.equal(record.join.matched, true);
  assert.equal(record.agenda_items.length, 1);

  const item = record.agenda_items[0];
  assert.equal(item.matters.length, 1);

  const matter = item.matters[0];
  assert.equal(matter.matter_id, "mat-001");
  assert.equal(matter.votes[0].vote_id, "vote-001");
  assert.equal(matter.documents[0].document_id, "doc-001");
  assert.equal(matter.votes[0].counts.aye, 6);

  assert.equal(record.notice.affected_area.scope, "local");
  assert.deepEqual(record.notice.affected_area.boroughs, ["Queens"]);
  assert.equal(record.notice.venue.address, "120 Broad Street, New York, NY, 10271");
  assert.notEqual(record.notice.venue.borough, "Queens");
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

function modelWithNotice(notice) {
  return buildMeetingOutcomes(
    [notice],
    fixture.events,
    fixture.agenda_items,
    fixture.matters,
    fixture.votes,
    fixture.documents,
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
