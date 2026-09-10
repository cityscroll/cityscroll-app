import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import { buildMeetings } from "../tools/build_worker_route_read_models.mjs";
import {
  buildSharedMeetingReadModel,
  meetingCollectionRows,
} from "../site/shared_meeting_read_model.mjs";

const upcomingFixture = JSON.parse(
  readFileSync(new URL("./fixtures/legistar/upcoming_contracts_22691.json", import.meta.url), "utf8"),
);
const peerIdentityFixture = JSON.parse(
  readFileSync(new URL("./fixtures/legistar/peer_meeting_identity.json", import.meta.url), "utf8"),
);

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

// --- the served capability path ------------------------------------------
//
// meeting.get answers from the daily materialized view. That view is rebuilt by
// the digest cron, while the versioned meeting route read model is republished
// with every deployment, so between a deployment and the next cron the view is
// missing meetings the deployment already serves. These tests hold the
// capability to the coverage the repository committed, not to the view's age.

const MEETING_MANIFEST_KEY = "route-read-model:meetings:manifest:v1";
const COMMITTED_READ_MODEL = JSON.parse(
  readFileSync(new URL("../site/data/shared_meeting_read_model.json", import.meta.url), "utf8"),
);

function publishedKv(model, extra = {}) {
  const built = buildMeetings(model, "test-route-version");
  const values = new Map(built.entries.map((entry) => [entry.key, entry.value]));
  values.set(MEETING_MANIFEST_KEY, JSON.stringify(built.manifest));
  for (const [key, value] of Object.entries(extra)) values.set(key, value);
  // A fresh object per call: the route read-model reader caches by KV identity.
  return { manifest: built.manifest, ALERT_STATE: { get: async (key) => values.get(key) ?? null } };
}

const publishedMeeting = {
  ...meeting,
  meeting_id: "meeting:community_board:https://example.org/event/full-board-meeting/",
  source_system: "community_board",
  source_record_id: "full-board-meeting",
  request_id: undefined,
  title: "Public Hearing & Full Board Meeting",
  event_date: "2026-01-08T18:00:00-05:00",
  source_record: {
    source_system: "community_board",
    identifier: "https://example.org/event/full-board-meeting/",
    receipt: { status: "ok" },
  },
};

test("the published route read model carries the vintage a capability answer needs", () => {
  const { manifest } = publishedKv(COMMITTED_READ_MODEL);
  assert.equal(manifest.read_model.schema, COMMITTED_READ_MODEL.schema);
  assert.equal(manifest.read_model.generated_at, COMMITTED_READ_MODEL.generated_at);
  assert.ok(manifest.read_model.sources.community_board.row_count > 0);
  // The per-board table belongs to the coverage lens, not to a single answer.
  assert.equal(manifest.read_model.sources.community_board.board_coverage, undefined);
});

test("a meeting this deployment publishes resolves while the daily view still lags", async () => {
  const env = publishedKv(
    { ...model([publishedMeeting]), generated_at: "2026-09-07T13:15:46.599Z" },
    { [HEARINGS_KV_KEY]: JSON.stringify(model()) },
  );
  const result = await workerMeetingGet(env).execute({ meetingId: publishedMeeting.meeting_id });
  assert.equal(result.availability, "available");
  assert.equal(result.meeting.meeting_id, publishedMeeting.meeting_id);
  assert.equal(result.source.identifier, "https://example.org/event/full-board-meeting/");
  assert.equal(result.freshness.as_of, "2026-09-07T13:15:46.599Z");
  assert.equal(result.error, null);
});

test("GET /hearings?id serves a published meeting the daily view has not caught up with", async () => {
  const env = publishedKv(model([publishedMeeting]), { [HEARINGS_KV_KEY]: JSON.stringify(model()) });
  const response = await handleHearings(
    new Request(`https://api.cityscroll.org/hearings?id=${encodeURIComponent(publishedMeeting.meeting_id)}`),
    env,
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.capability.availability, "available");
  assert.equal(body.capability.meeting.meeting_id, publishedMeeting.meeting_id);
});

test("an id no store holds is still answered as not materialized", async () => {
  const env = publishedKv(model([publishedMeeting]), { [HEARINGS_KV_KEY]: JSON.stringify(model()) });
  const response = await handleHearings(
    new Request("https://api.cityscroll.org/hearings?id=meeting:community_board:absent"),
    env,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).reason, "not-materialized");
});

test("every meeting in the committed coverage is addressable on the served capability path", () => {
  const { manifest } = publishedKv(COMMITTED_READ_MODEL);
  const unreachable = COMMITTED_READ_MODEL.rows
    .filter((row) => !manifest.id_to_slice[row.meeting_id])
    .map((row) => row.meeting_id);
  assert.deepEqual(unreachable, [], `committed meetings absent from the published slices: ${unreachable.slice(0, 5).join(", ")}`);
});

test("a past community-board meeting in the committed coverage resolves through the capability", async () => {
  const boardMeetings = COMMITTED_READ_MODEL.rows
    .filter((row) => row.source_system === "community_board" && row.event_date)
    .sort((left, right) => String(left.event_date).localeCompare(String(right.event_date)));
  assert.ok(boardMeetings.length, "the committed coverage holds no dated community-board meetings");
  const earliest = boardMeetings[0];
  assert.ok(
    String(earliest.event_date) < String(COMMITTED_READ_MODEL.generated_at),
    "the committed coverage holds no community-board meeting older than its own vintage",
  );
  // The daily view deliberately holds nothing: only the published slices can answer.
  const env = publishedKv(COMMITTED_READ_MODEL, { [HEARINGS_KV_KEY]: JSON.stringify(model([])) });
  const result = await workerMeetingGet(env).execute({ meetingId: earliest.meeting_id });
  assert.equal(result.availability, "available");
  assert.equal(result.meeting.meeting_id, earliest.meeting_id);
  assert.equal(result.freshness.as_of, COMMITTED_READ_MODEL.generated_at);
});

test("page, HTTP, and meeting.get share the Council calendar fixture identity and facts", async () => {
  const generatedAt = "2026-09-09T12:00:00.000Z";
  const eventRow = {
    ...upcomingFixture.event,
    insite_calendar: upcomingFixture.insite_calendar,
    description: upcomingFixture.event_items.map((item) => item.EventItemTitle).join(" | "),
  };
  const model = buildSharedMeetingReadModel({
    cityRecordRows: [],
    communityBoardIndex: { generated_at: generatedAt, rows: [] },
    nycLegistarEventsIndex: { generated_at: generatedAt, rows: [eventRow] },
    generatedAt,
    now: generatedAt,
  });
  const meetingId = `meeting:nyc_legistar_events:${upcomingFixture.event.EventId}`;
  const result = meetingGetFromModel(model, { meetingId });
  const executed = await executeMeetingGet(
    {
      capabilityReference: MEETING_GET_CAPABILITY_REFERENCE,
      providerId: "worker-static.shared-meeting.get",
      execute: (value) => meetingGetFromModel(model, value),
    },
    { meetingId },
  );
  assert.equal(result.availability, "available");
  assert.equal(executed.meeting.meeting_id, meetingId);
  assert.equal(result.meeting.meeting_id, meetingId);
  assert.equal(result.meeting.event_date, "2026-09-23T10:00:00");
  assert.match(result.meeting.venue.address, /250 Broadway/);
  assert.match(result.meeting.venue.address, /Hearing Room 2/);
  assert.equal(result.meeting.committee.name, "Committee on Contracts");
  assert.match(result.meeting.description, /M\/WBE Utilization and the Required Disparity Study/);
  assert.match(result.meeting.source_url, /LEGID=22691/);
  assert.equal(result.meeting.participation?.remote_join_url || null, null);

  const html = renderMeetingDocument(result.meeting, model);
  assert.match(html, /City Council meeting/);
  assert.match(html, /September 23, 2026 at 10:00 AM New York time/);
  assert.match(html, /250 Broadway/);
  assert.match(html, /Hearing Room 2/);
  assert.match(html, /Committee on Contracts/);
  assert.match(html, /M\/WBE Utilization and the Required Disparity Study/);
  assert.match(html, /https:\/\/nyc\.legistar\.com\/MeetingDetail\.aspx\?LEGID=22691/);
  assert.doesNotMatch(html, /Join online|Join remotely/);
  assert.doesNotMatch(html, /RequestDetail\/(?:undefined)?["']/);
  assert.equal(meetingCollectionRows(model).map((row) => row.meeting_id).join(), meetingId);

  const values = new Map([[HEARINGS_KV_KEY, JSON.stringify(model)]]);
  const response = await handleHearings(
    new Request(`https://api.cityscroll.org/hearings?id=${encodeURIComponent(meetingId)}`),
    { ALERT_STATE: { get: async (key) => values.get(key) } },
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.capability.meeting.meeting_id, meetingId);
  assert.equal(body.capability.meeting.source_system, "nyc_legistar_events");
});

test("meeting.get resolves the Events feed identity before and after an exact join", () => {
  const generatedAt = peerIdentityFixture.pinned_clock;
  const eventRow = {
    ...upcomingFixture.event,
    insite_calendar: upcomingFixture.insite_calendar,
    description: upcomingFixture.event_items[0].EventItemTitle,
  };
  const before = buildSharedMeetingReadModel({
    cityRecordRows: [],
    communityBoardIndex: { generated_at: generatedAt, rows: [] },
    nycLegistarEventsIndex: { generated_at: generatedAt, rows: [eventRow] },
    generatedAt,
    now: generatedAt,
  });
  const beforeResult = meetingGetFromModel(before, {
    meetingId: peerIdentityFixture.publisher_identity.meeting_id,
  });
  assert.equal(beforeResult.availability, "available");
  assert.equal(beforeResult.meeting.meeting_id, peerIdentityFixture.publisher_identity.meeting_id);
  assert.equal(beforeResult.source.identifier, peerIdentityFixture.publisher_identity.event_id);
  assert.equal(beforeResult.meeting.same_proceeding, null);
  assert.deepEqual(
    meetingCollectionRows(before).map((row) => row.meeting_id),
    [peerIdentityFixture.publisher_identity.meeting_id],
  );

  const after = buildSharedMeetingReadModel({
    cityRecordRows: peerIdentityFixture.after_exact_join.city_record_notices,
    communityBoardIndex: { generated_at: generatedAt, rows: [] },
    nycLegistarEventsIndex: { generated_at: generatedAt, rows: [eventRow] },
    generatedAt,
    now: generatedAt,
  });
  const cityId = peerIdentityFixture.after_exact_join.expect.meeting_ids[0];
  const legistarId = peerIdentityFixture.after_exact_join.expect.meeting_ids[1];
  const cityResult = meetingGetFromModel(after, { meetingId: cityId });
  const legistarResult = meetingGetFromModel(after, { meetingId: legistarId });
  assert.equal(cityResult.availability, "available");
  assert.equal(legistarResult.availability, "available");
  assert.equal(cityResult.meeting.meeting_id, cityId);
  assert.equal(legistarResult.meeting.meeting_id, legistarId);
  assert.equal(legistarResult.meeting.collection_visibility, "suppressed");
  assert.deepEqual(
    meetingCollectionRows(after).map((row) => row.meeting_id),
    peerIdentityFixture.after_exact_join.expect.collection_meeting_ids,
  );
});
