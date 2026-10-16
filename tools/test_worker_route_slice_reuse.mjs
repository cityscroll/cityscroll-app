import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { contentAddressedEntry } from "./build_worker_route_read_models.mjs";
import {
  ROUTE_MANIFEST_KEYS,
  ROUTE_PUBLICATION_STATE_KEY,
  planRoutePublication,
  publishRouteReadModels,
} from "./lib/worker_route_publication.mjs";
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

function routeDirFor(candidateValue) {
  const dir = mkdtempSync(join(tmpdir(), "route-slice-reuse-fixture-"));
  writeFileSync(join(dir, "near-you.bulk.json"), JSON.stringify(candidateValue.entries.near_you));
  writeFileSync(join(dir, "meetings.bulk.json"), JSON.stringify(candidateValue.entries.meetings));
  writeFileSync(join(dir, "near-you.manifest.json"), JSON.stringify(candidateValue.manifests.near_you));
  writeFileSync(join(dir, "meetings.manifest.json"), JSON.stringify(candidateValue.manifests.meetings));
  return dir;
}

function recordingProvider() {
  const values = new Map();
  const calls = [];
  const bulkRows = [];
  return {
    values,
    calls,
    bulkRows,
    async invoke(args) {
      calls.push([...args]);
      if (args.slice(0, 4).join(" ") === `kv key get ${ROUTE_PUBLICATION_STATE_KEY}`) {
        return { stdout: values.get(ROUTE_PUBLICATION_STATE_KEY) || "" };
      }
      if (args[0] !== "kv" || args[1] !== "key" && args[1] !== "bulk") {
        throw new Error(`unexpected provider operation: ${args.join(" ")}`);
      }
      if (args[1] === "bulk") {
        const rows = JSON.parse(readFileSync(args[3], "utf8"));
        bulkRows.push(rows);
        for (const row of rows) values.set(row.key, row.value);
        return { stdout: "" };
      }
      if (args[2] !== "put") throw new Error(`unexpected provider key operation: ${args.join(" ")}`);
      const path = args[args.indexOf("--path") + 1];
      values.set(args[3], readFileSync(path, "utf8"));
      return { stdout: "" };
    },
  };
}

function referencedManifestKeys(manifest) {
  return [
    ...Object.values(manifest?.slices || {}),
    ...Object.values(manifest?.id_to_slice || {}),
  ].filter(Boolean);
}

function residentActivity(recordId) {
  return JSON.stringify({ activity: { records: { meetings: { [recordId]: { id: recordId } } } } });
}

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

test("one changed slice invokes one payload put, preserves resident bytes, and retains active and rollback keys", async () => {
  const oldNear = [slice("borough:Queens:meetings", { a: { id: "a" } }), slice("citywide:meetings", {})];
  const oldMeetings = [meeting("2026-10", [{ meeting_id: "meeting:1" }])];
  const baseline = candidate(oldNear, oldMeetings, "old");
  const nextNear = [slice("borough:Queens:meetings", { b: { id: "b" } }), oldNear[1]];
  const next = candidate(nextNear, oldMeetings, "new");
  const baselineDir = routeDirFor(baseline);
  const nextDir = routeDirFor(next);
  const provider = recordingProvider();
  try {
    await publishRouteReadModels({ routeDir: baselineDir, invoke: provider.invoke });
    const oldCitywideBytes = provider.values.get(oldNear[1].entry.key);
    const oldMeetingBytes = provider.values.get(oldMeetings[0].entry.key);
    const callsBeforeChange = provider.calls.length;
    const bulkRowsBeforeChange = provider.bulkRows.length;

    const result = await publishRouteReadModels({ routeDir: nextDir, invoke: provider.invoke });

    assert.equal(result.decision, "changed-content");
    assert.equal(result.writes_avoided, 2);
    assert.deepEqual(result.attempted, { kv_reads: 1, route_key_puts: 1, manifest_puts: 2, state_puts: 1 });
    assert.deepEqual(result.confirmed, { route_key_puts: 1, manifest_puts: 2, state_puts: 1 });
    assert.equal(provider.bulkRows.length, bulkRowsBeforeChange + 1);
    assert.deepEqual(provider.bulkRows.at(-1).map((row) => row.key), [nextNear[0].entry.key]);
    const changedCalls = provider.calls.slice(callsBeforeChange);
    assert.equal(changedCalls.filter((args) => args[1] === "bulk").length, 1);
    assert.equal(changedCalls.filter((args) => args[1] === "key" && args[2] === "put").length, 3);
    assert.equal(changedCalls.some((args) => args.includes("delete")), false);
    assert.equal(provider.values.get(oldNear[1].entry.key), oldCitywideBytes);
    assert.equal(provider.values.get(oldMeetings[0].entry.key), oldMeetingBytes);

    const state = JSON.parse(provider.values.get(ROUTE_PUBLICATION_STATE_KEY));
    for (const generation of [state.active, state.rollback]) {
      for (const manifest of Object.values(generation.manifests)) {
        for (const key of referencedManifestKeys(manifest)) {
          assert.equal(typeof provider.values.get(key), "string", `retained payload ${key} is readable`);
        }
      }
    }
    assert.equal(provider.values.get(oldNear[0].entry.key), oldNear[0].entry.value);
  } finally {
    rmSync(baselineDir, { recursive: true, force: true });
    rmSync(nextDir, { recursive: true, force: true });
  }
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

test("loader reads resident sections while delayed visibility leaves other sections available", async () => {
  const delayedKey = "delayed-virtual";
  const values = new Map([
    [NEAR_YOU_MANIFEST_KEY, JSON.stringify({
      schema_version: 1,
      kind: "near-you",
      version: "resident-generation",
      slices: {
        "borough:Queens:meetings": "primary",
        "citywide:meetings": "citywide",
        "virtual:meetings": delayedKey,
        "unlocated:meetings": "unlocated",
      },
    })],
    ["primary", residentActivity("primary")],
    ["citywide", residentActivity("citywide")],
    ["unlocated", residentActivity("unlocated")],
    [delayedKey, residentActivity("virtual")],
  ]);
  let delayedVisible = false;
  const env = {
    ALERT_STATE: {
      async get(key) {
        if (key === delayedKey && !delayedVisible) return null;
        return values.get(key) ?? null;
      },
    },
  };
  const scope = { place: { boroughs: ["Queens"] }, facets: { domains: ["meetings"] } };

  const first = await loadNearYouActivity(env, scope);
  assert.equal(first.partial, true);
  assert.equal(first.sections.primary.state, "ready");
  assert.equal(first.sections.citywide.state, "ready");
  assert.equal(first.sections.virtual.state, "unavailable");
  assert.equal(first.sections.unlocated.state, "ready");
  assert.deepEqual(Object.keys(first.activity.records.meetings).sort(), ["citywide", "primary", "unlocated"]);

  delayedVisible = true;
  const second = await loadNearYouActivity(env, scope);
  assert.equal(second.sections.virtual.state, "ready");
  assert.deepEqual(Object.keys(second.activity.records.meetings).sort(), ["citywide", "primary", "unlocated", "virtual"]);
});
