/**
 * Per-request resource-cost detector for the MCP get_meeting path.
 *
 * get_meeting intermittently exceeded the Cloudflare Worker resource budget
 * (runtime error 1102 — CPU time or memory) on api.cityscroll.org. The cause is
 * the fallback in worker/src/hearings.mjs: when a per-id published slice has not
 * caught a meeting id yet, the request parses the ENTIRE `hearings:location:v1`
 * corpus blob (measured at ~26MB, since inflated by a redundant nested copy) just
 * to return one meeting. The bounded per-id slice path reads only the manifest and
 * one month slice.
 *
 * This detector measures the KV bytes a single get_meeting request pulls, and
 * fails if the bounded path stops being bounded. The positive control proves the
 * detector fires for the expensive full-corpus fallback: a get whose id is not in
 * the slice manifest reads the whole daily-view blob and blows the budget.
 *
 * verify: node --test worker/test/meeting_get_request_budget.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { workerMeetingGet, HEARINGS_KV_KEY } from "../src/hearings.mjs";
import { MEETING_MANIFEST_KEY } from "../src/lib/route_read_model_kv.mjs";

const SHARED_MEETING_SCHEMA = "cityscroll.shared_meeting_read_model.v1";

// A bounded get_meeting request reads the meetings manifest plus at most one
// month slice. This budget sits comfortably above that and far below the whole
// daily-view corpus, so it distinguishes the intended per-id read from the
// full-corpus fallback that trips error 1102.
export const MEETING_GET_KV_BYTE_BUDGET = 64 * 1024; // 64 KiB

function meetingRow(id, extra = {}) {
  return {
    meeting_id: id,
    source_system: "nyc_legistar_events",
    title: `Meeting ${id}`,
    event_date: "2026-09-15T18:00:00.000Z",
    source_receipt: { observed_at: "2026-09-10T00:00:00.000Z" },
    ...extra,
  };
}

/** A KV double that records every key read and the byte length it returned. */
function byteCountingKv(values) {
  const reads = [];
  return {
    reads,
    bytesRead: () => reads.reduce((sum, r) => sum + r.bytes, 0),
    keysRead: () => reads.map((r) => r.key),
    async get(key) {
      const value = values.get(key) ?? null;
      reads.push({ key, bytes: value == null ? 0 : Buffer.byteLength(value, "utf8") });
      return value;
    },
  };
}

// The bounded per-id path: a small manifest that maps the id to a small slice.
const PRESENT_ID = "meeting:present@1";
function boundedValues() {
  return new Map([
    [MEETING_MANIFEST_KEY, JSON.stringify({
      schema_version: 1,
      kind: "meetings",
      version: "detector",
      // manifestFor() validates that `slices` is present; get_meeting resolves the
      // record through `id_to_slice`, which maps the id to its month slice key.
      slices: { "2026-09": "meetings:slice:2026-09" },
      read_model: { schema: SHARED_MEETING_SCHEMA, generated_at: "2026-09-11T00:00:00.000Z" },
      id_to_slice: { [PRESENT_ID]: "meetings:slice:2026-09" },
    })],
    ["meetings:slice:2026-09", JSON.stringify({
      schema: SHARED_MEETING_SCHEMA,
      generated_at: "2026-09-11T00:00:00.000Z",
      rows: [meetingRow(PRESENT_ID)],
    })],
    // A large daily-view corpus also lives in KV; the bounded path must NOT touch it.
    [HEARINGS_KV_KEY, JSON.stringify(largeDailyView())],
  ]);
}

// The full daily-view corpus: many rows, well over the byte budget. This is what
// the fallback JSON.parses when a slice has not caught the id.
const FALLBACK_ONLY_ID = "meeting:fallback-only@1";
function largeDailyView() {
  const rows = [];
  for (let i = 0; i < 400; i += 1) {
    rows.push(meetingRow(`meeting:corpus-${i}@1`, {
      title: `Corpus meeting ${i} — a realistically long hearing title for byte weight`,
      venue: { name: `Community Board District ${i % 59}`, address: `${100 + i} Civic Center Plaza, New York, NY 10007` },
    }));
  }
  rows.push(meetingRow(FALLBACK_ONLY_ID, { title: "Fallback-only meeting present only in the daily view" }));
  return { schema: SHARED_MEETING_SCHEMA, generated_at: "2026-09-11T00:00:00.000Z", rows };
}

test("get_meeting reads only the bounded per-id slice, not the full corpus", async () => {
  const kv = byteCountingKv(boundedValues());
  const result = await workerMeetingGet({ ALERT_STATE: kv }).execute({ meetingId: PRESENT_ID });

  assert.equal(result.availability, "available");
  assert.equal(result.meeting.meeting_id, PRESENT_ID);
  assert.ok(
    kv.bytesRead() <= MEETING_GET_KV_BYTE_BUDGET,
    `bounded get_meeting read ${kv.bytesRead()} B, over the ${MEETING_GET_KV_BYTE_BUDGET} B budget`,
  );
  assert.ok(
    !kv.keysRead().includes(HEARINGS_KV_KEY),
    "a served-by-slice get_meeting must never parse the full daily-view corpus",
  );
});

test("positive control: a slice-missing get_meeting falls back to the full corpus and blows the budget", async () => {
  const kv = byteCountingKv(boundedValues());
  // The id exists only in the daily-view corpus, not in the slice manifest, so
  // the request is forced onto the fallback that JSON.parses the whole blob.
  const result = await workerMeetingGet({ ALERT_STATE: kv }).execute({ meetingId: FALLBACK_ONLY_ID });

  assert.equal(result.meeting?.meeting_id, FALLBACK_ONLY_ID);
  assert.ok(kv.keysRead().includes(HEARINGS_KV_KEY), "the fallback path reads the full daily-view corpus");
  assert.ok(
    kv.bytesRead() > MEETING_GET_KV_BYTE_BUDGET,
    `expected the full-corpus fallback to exceed the ${MEETING_GET_KV_BYTE_BUDGET} B budget, read ${kv.bytesRead()} B`,
  );
});
