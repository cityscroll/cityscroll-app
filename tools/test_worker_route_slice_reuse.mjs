import assert from "node:assert/strict";
import test from "node:test";

import { contentAddressedEntry } from "./build_worker_route_read_models.mjs";
import { planRoutePublication } from "./lib/worker_route_publication.mjs";
import { loadNearYouActivity, NEAR_YOU_MANIFEST_KEY } from "../worker/src/lib/route_read_model_kv.mjs";

function candidate(nearEntries, meetingEntries, version) {
  const nearSlices = Object.fromEntries(nearEntries.map((row) => [row.id, row.entry.key]));
  const meetingSlices = Object.fromEntries(meetingEntries.map((row) => [row.id, row.entry.key]));
  return {
    content_version: `sha256:${version}`,
    manifests: {
      near_you: { schema_version: 1, kind: "near-you", version, slices: nearSlices },
      meetings: { schema_version: 1, kind: "meetings", version, slices: meetingSlices, id_to_slice: {} },
    },
    entries: {
      near_you: nearEntries.map((row) => row.entry),
      meetings: meetingEntries.map((row) => row.entry),
    },
  };
}

const slice = (id, records) => ({
  id,
  entry: contentAddressedEntry("near-you", id, {
    schema_version: 1, kind: "near-you", slice_id: id, lens: "meetings",
    activity: { records: { meetings: records } },
  }),
});
const meeting = (id, rows) => ({
  id,
  entry: contentAddressedEntry("meetings", id, { schema_version: 1, kind: "meetings", month: id, rows }),
});

test("one changed slice publishes only its new payload and keeps rollback references", () => {
  const oldNear = [slice("borough:Queens:meetings", { a: { id: "a" } }), slice("citywide:meetings", {})];
  const oldMeetings = [meeting("2026-10", [{ meeting_id: "meeting:1" }])];
  const previousCandidate = candidate(oldNear, oldMeetings, "old");
  const previousState = {
    schema: "cityscroll.worker_route_publication_state.v1",
    content_version: previousCandidate.content_version,
    active: { manifests: previousCandidate.manifests },
    rollback: null,
  };
  const nextNear = [slice("borough:Queens:meetings", { b: { id: "b" } }), oldNear[1]];
  const next = candidate(nextNear, oldMeetings, "new");
  const plan = planRoutePublication(next, previousState);
  assert.equal(plan.decision, "changed-content");
  assert.deepEqual(plan.entries.near_you.map((row) => row.key), [nextNear[0].entry.key]);
  assert.equal(plan.entries.meetings.length, 0);
  assert.equal(plan.writes_avoided, 2);
  assert.equal(nextNear[1].entry.key, oldNear[1].entry.key);
  assert.equal(oldMeetings[0].entry.key, next.entries.meetings[0].key);
});

test("legacy manifests remain readable and delayed visibility fails only the missing section", async () => {
  const good = JSON.stringify({ activity: { records: { meetings: {} } } });
  const values = new Map([
    [NEAR_YOU_MANIFEST_KEY, JSON.stringify({
      schema_version: 1,
      kind: "near-you",
      version: "legacy-generation",
      slices: {
        "borough:Queens:meetings": "not-visible-yet",
        "citywide:meetings": "legacy-citywide",
        "virtual:meetings": "legacy-virtual",
        "unlocated:meetings": "legacy-unlocated",
      },
    })],
    ["legacy-citywide", good],
    ["legacy-virtual", good],
    ["legacy-unlocated", good],
  ]);
  const env = { ALERT_STATE: { async get(key) { return values.get(key) ?? null; } } };
  const loaded = await loadNearYouActivity(env, {
    place: { boroughs: ["Queens"] }, facets: { domains: ["meetings"] },
  });
  assert.equal(loaded.version, "legacy-generation");
  assert.equal(loaded.partial, true);
  assert.deepEqual(loaded.sections.primary, { state: "unavailable", cause: "missing_slice" });
  assert.equal(loaded.sections.citywide.state, "ready");
});
