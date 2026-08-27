import assert from "node:assert/strict";
import test from "node:test";

import {
  MEETING_GET_CAPABILITY,
  MEETING_GET_CAPABILITY_REFERENCE,
  executeMeetingGet,
  meetingGetFromModel,
} from "../capabilities/meetings.mjs";
import { renderMeetingDocument } from "../site/meeting_document.mjs";
import { canonicalMeetingsForRender } from "../site/meeting_capability_projection.mjs";
import { handleHearings, HEARINGS_KV_KEY, workerMeetingGet } from "../worker/src/hearings.mjs";

const meeting = {
  object_type: "meeting",
  meeting_id: "meeting:city_record:fixture-1",
  source_system: "city_record",
  source_record_id: "fixture-1",
  request_id: "fixture-1",
  title: "A public hearing",
  event_date: "2026-08-17T18:30:00-04:00",
  source_receipt: {
    schema: "cityscroll.meeting_source_receipt.v1",
    status: "ok",
    observed_at: "2026-08-15T12:00:00Z",
  },
  source_record: {
    source_system: "city_record",
    identifier: "fixture-1",
    receipt: { status: "ok" },
  },
};

function model(rows = [meeting]) {
  return {
    schema: "cityscroll.shared_meeting_read_model.v1",
    version: 1,
    generated_at: "2026-08-15T12:00:00Z",
    freshness: { generated_at: "2026-08-15T12:00:00Z", checked_at: "2026-08-15T12:01:00Z" },
    sources: { city_record: { status: "available", row_count: rows.length } },
    rows,
    hearings: rows,
  };
}

test("meeting.get shares exact identity, provenance, coverage, and freshness with the UI renderer", async () => {
  const input = { meetingId: meeting.meeting_id };
  const direct = meetingGetFromModel(model(), input);
  const provider = {
    capabilityReference: MEETING_GET_CAPABILITY_REFERENCE,
    providerId: "worker-static.shared-meeting.get",
    execute: (value) => meetingGetFromModel(model(), value),
  };
  const executed = await executeMeetingGet(provider, input);
  assert.equal(direct.capability_reference, MEETING_GET_CAPABILITY_REFERENCE);
  assert.equal(executed.meeting.meeting_id, meeting.meeting_id);
  assert.equal(executed.source.identifier, "fixture-1");
  assert.equal(executed.coverage.state, "observed");
  assert.equal(executed.freshness.as_of, "2026-08-15T12:00:00Z");
  assert.match(renderMeetingDocument(meeting), /data-capability-reference="meeting\.get@1"/);
  assert.equal(MEETING_GET_CAPABILITY.adapters.length, 2);
});

test("meeting explorer projects every static row through meeting.get without changing order", () => {
  const rows = [
    meeting,
    {
      ...meeting,
      meeting_id: "meeting:community_board:fixture-2",
      source_system: "community_board",
      source_record_id: "board-fixture-2",
      source_record: {
        source_system: "community_board",
        identifier: "board-fixture-2",
        receipt: { status: "ok" },
      },
    },
  ];
  const projected = canonicalMeetingsForRender(rows, model(rows));
  assert.deepEqual(projected.map((row) => row.meeting_id), rows.map((row) => row.meeting_id));
  assert.equal(projected[0].source_receipt.schema, "cityscroll.meeting_source_receipt.v1");
  assert.equal(projected[1].source_record.identifier, "board-fixture-2");
});

test("meeting.get is fail-closed for unknown ids and malformed read models", () => {
  const missing = meetingGetFromModel(model(), { meetingId: "meeting:city_record:missing" });
  assert.equal(missing.availability, "not_yet_public");
  assert.equal(missing.error, "not-found");
  const unavailable = meetingGetFromModel({ schema: "wrong", rows: [] }, { meetingId: meeting.meeting_id });
  assert.equal(unavailable.availability, "unavailable");
  assert.equal(unavailable.error, "unavailable");
  assert.throws(() => meetingGetFromModel(model(), { meetingId: "fixture-1" }), /canonical meeting id/);
});

test("GET /hearings?id keeps legacy lookup compatibility while exposing the canonical result", async () => {
  const values = new Map([[HEARINGS_KV_KEY, JSON.stringify(model())]]);
  const response = await handleHearings(
    new Request("https://api.cityscroll.org/hearings?id=fixture-1"),
    { ALERT_STATE: { get: async (key) => values.get(key) } },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.hearings[0].meeting_id, meeting.meeting_id);
  assert.equal(body.capability.capability_reference, MEETING_GET_CAPABILITY_REFERENCE);
  assert.equal(body.capability.meeting.meeting_id, meeting.meeting_id);
});

test("the Worker provider returns the capability's unavailable state without a live-source fallback", async () => {
  const result = await workerMeetingGet({ ALERT_STATE: { get: async () => null } }).execute({ meetingId: meeting.meeting_id });
  assert.equal(result.availability, "unavailable");
  assert.equal(result.error, "unavailable");
});
