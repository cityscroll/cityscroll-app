import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildCouncilHearingActionPath } from "../site/council_hearing_action_path.mjs";
import { meetingCalendarICS } from "../site/hearing_attend_pack.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import {
  projectCouncilHearingMatterContinuation,
  renderCouncilHearingMatterContinuation,
} from "../site/council_hearing_matter_continuation.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const sharedModel = JSON.parse(readFileSync(new URL("../site/data/shared_meeting_read_model.json", import.meta.url), "utf8"));

function meeting(requestId, outcome) {
  return {
    source_system: "city_record",
    meeting_id: `meeting:city_record:${requestId}`,
    request_id: requestId,
    event_date: "2026-07-22T11:00:00-04:00",
    meeting_outcome: outcome,
  };
}

function present(matters) {
  return {
    snapshot_state: "present",
    join: { matched: true, method: "exact_date_body_tokens" },
    matters,
  };
}

test("the one-matter Council canary composes an exact subject continuation", () => {
  const outcome = snapshot.by_notice["20260707022"];
  const record = meeting("20260707022", outcome);
  const projection = projectCouncilHearingMatterContinuation(record);
  assert.equal(projection.state, "single");
  assert.deepEqual(projection.matters.map((matter) => matter.subject_ref), ["matter:79200"]);
  assert.equal(projection.join_method, "exact_date_body_tokens");

  const path = buildCouncilHearingActionPath(record);
  assert.equal(path.process_ref, "matter:79200");
  assert.equal(path.continuation_cta, true);
  assert.equal(path.continuation.subject_ref, "matter:79200");

  const html = renderCouncilHearingMatterContinuation(record);
  assert.match(html, /data-continuation-state="single"/);
  assert.match(html, /data-matter-id="79200"/);
  assert.match(html, /data-action-path-continuation="subject"/);
  assert.match(html, /data-subject-ref="matter:79200"/);
  // 79200 has a published local history, so the continuation opens that page
  // rather than handing the reader off to the publisher.
  assert.match(html, /data-matter-availability="local_history"/);
  assert.match(html, /View matter history/);
  assert.match(html, /href="\/matters\/79200\/"/);
});

test("the materialized meeting document carries the canary continuation without changing ICS identity", () => {
  const row = sharedModel.rows.find((candidate) => candidate.meeting_id === "meeting:city_record:20260707022");
  assert.ok(row?.meeting_outcome, "the shared meeting model should carry the outcome projection");
  const html = renderMeetingDocument(row, sharedModel);
  assert.match(html, /data-continuation-state="single"/);
  assert.match(html, /data-subject-ref="matter:79200"/);
  assert.match(html, /href="\/meeting\.ics\?id=meeting%3Acity_record%3A20260707022"/);
  const ics = meetingCalendarICS(row, { now: "2026-08-26T16:00:00Z" });
  assert.match(ics, /UID:meeting:city_record:20260707022@cityscroll\.org/);
});

test("multiple exact matters remain individually selectable", () => {
  const record = meeting("20260707021", snapshot.by_notice["20260707021"]);
  const projection = projectCouncilHearingMatterContinuation(record);
  assert.equal(projection.state, "multiple");
  assert.deepEqual(projection.matters.map((matter) => matter.matter_id), ["79201", "79203", "79202", "79204", "79205"]);

  const path = buildCouncilHearingActionPath(record);
  assert.equal(path.continuation_cta, false);
  assert.equal(path.continuation.ambiguity, "multiple");
  assert.equal(path.process_ref, null);
  const html = renderCouncilHearingMatterContinuation(record);
  assert.match(html, /Choose a matter to open/);
  for (const id of ["79201", "79203", "79202", "79204", "79205"]) {
    assert.match(html, new RegExp(`data-subject-ref="matter:${id}"`));
  }
  assert.doesNotMatch(html, /primary.*matter-choice/);
});

test("unmatched notices and logistics hearings do not invent a continuation", () => {
  const unmatched = meeting("20260827001", { snapshot_state: "absent" });
  assert.equal(projectCouncilHearingMatterContinuation(unmatched).state, "unmatched");
  assert.equal(buildCouncilHearingActionPath(unmatched).continuation, null);
  const html = renderCouncilHearingMatterContinuation(unmatched);
  assert.match(html, /data-continuation-state="unmatched"/);
  assert.doesNotMatch(html, /data-action-path-continuation/);

  const logistics = meeting("20260827002", present([]));
  assert.equal(projectCouncilHearingMatterContinuation(logistics).state, "no_matter");
  assert.equal(buildCouncilHearingActionPath(logistics).continuation, null);
  assert.match(renderCouncilHearingMatterContinuation(logistics), /no underlying matter/i);
});

test("a non-strict or title-only relation fails closed", () => {
  const record = meeting("20260827003", {
    snapshot_state: "present",
    join: { matched: true, method: "title_similarity" },
    matters: [{ matter_id: "99999", title: "Same words as the hearing" }],
  });
  assert.equal(projectCouncilHearingMatterContinuation(record).state, "unknown");
  assert.equal(buildCouncilHearingActionPath(record).continuation, null);
  assert.doesNotMatch(renderCouncilHearingMatterContinuation(record), /99999|Same words/);
});
