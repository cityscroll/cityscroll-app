import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyApiLimits,
  buildMeetingOutcomes,
  MEETING_OUTCOMES_KV_KEY,
} from "../src/lib/meeting_outcomes.mjs";
import {
  handleMeetingOutcomes,
  refreshMeetingOutcomes,
} from "../src/meeting_outcomes.mjs";

const fixture = JSON.parse(await readFile(new URL("../../test/contract/fixtures/meeting_outcomes.json", import.meta.url), "utf8"));

function memoryKV() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, value); },
  };
}

function nowIso(value) {
  return new Date(value).toISOString();
}

const VIEW_NOW = new Date("2026-07-29T12:00:00.000Z");

function modelFromFixture(overrides = {}) {
  return buildMeetingOutcomes(
    overrides.notices || fixture.notices,
    overrides.events || fixture.events,
    overrides.event_items || fixture.event_items,
    overrides.votes || fixture.votes,
    overrides.attachments || [],
  );
}

// ---------------------------------------------------------------------------
// Chain coverage (strict join + inline matters)
// ---------------------------------------------------------------------------

test("buildMeetingOutcomes follows notice -> event -> agenda -> matter -> vote", () => {
  const model = modelFromFixture();

  assert.equal(model.records.length, 1);
  assert.equal(model.counts.votes, 1);
  assert.ok(model.counts.documents >= 2);

  const record = model.records[0];
  assert.equal(record.join.matched, true);
  assert.equal(record.join.method, "exact_date_body_tokens");

  const item = record.agenda_items[0];
  assert.equal(item.join.matched, true);
  assert.equal(item.matters.length, 1);

  const matter = item.matters[0];
  assert.equal(matter.matter_id, "mat-001");
  assert.equal(matter.matter_file, "LU 0001-2026");
  assert.equal(matter.outcome, "Approved by Subcommittee");
  assert.equal(matter.votes[0].counts.aye, 6);
  assert.equal(matter.join.matched, true);
});

test("notice venue does not become affected geography", () => {
  const model = modelFromFixture();
  const record = model.records[0];
  assert.equal(record.notice.affected_area.scope, "local");
  assert.deepEqual(record.notice.affected_area.boroughs, ["Queens"]);
  assert.equal(record.notice.venue.address, "120 Broad Street, New York, NY, 10271");
  assert.notEqual(record.notice.venue.borough, "Queens");
  assert.equal(record.agenda_items[0].join.reason, null);
});

test("unmatched notice is explicit and machine-readable", () => {
  const model = modelFromFixture({
    notices: [
      {
        ...fixture.notices[0],
        request_id: "CR-1002",
        short_title: "Unmatched council item",
      },
    ],
  });

  assert.equal(model.records.length, 1);
  assert.equal(model.records[0].join.matched, false);
  assert.equal(model.records[0].join.reason.includes("No Council event"), true);
  assert.equal(model.records[0].council_event, null);
  assert.equal(Array.isArray(model.records[0].agenda_items), true);
  assert.equal(model.records[0].agenda_items.length, 0);
});

test("attachments attach to matter documents by agenda_item_id", () => {
  const model = modelFromFixture({
    attachments: [{
      agenda_item_id: "evtitem-001",
      documents: [{ url: "https://example.com/a.pdf", name: "Staff report", category: "Supporting" }],
    }],
  });
  const matter = model.records[0].agenda_items[0].matters[0];
  assert.equal(matter.documents.length, 1);
  assert.equal(matter.documents[0].name, "Staff report");
});

// ---------------------------------------------------------------------------
// API behavior
// ---------------------------------------------------------------------------

test("API limit cap is enforced regardless of requested limit", () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ request_id: `cr-${i}` }));
  const limited = applyApiLimits(rows, { limit: "250", offset: "120" });
  assert.equal(limited.limit, 100);
  assert.equal(limited.offset, 120);
  assert.equal(limited.returned, 100);
  assert.equal(limited.total, 250);
});

test("GET /meeting-outcomes serves capped JSON records", async () => {
  const kv = memoryKV();
  const payload = modelFromFixture();
  // Handler re-fetches live when generated_at is older than MAX_AGE_MS (~36h).
  // Seed a fresh timestamp so this test stays hermetic against wall-clock drift.
  payload.generated_at = new Date().toISOString();
  payload.records = Array.from({ length: 140 }, (_, i) => ({
    ...payload.records[0],
    request_id: `CR-${i + 10}`,
    notice: { ...payload.records[0].notice, request_id: `CR-${i + 10}` },
    council_event: { ...payload.records[0].council_event, event_id: `evt-${i}` },
  }));
  await kv.put(MEETING_OUTCOMES_KV_KEY, JSON.stringify(payload));

  const response = await handleMeetingOutcomes(
    new Request("https://api.cityscroll.org/meeting-outcomes?offset=0&limit=200"),
    { ALERT_STATE: kv },
    {},
  );
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.pagination.limit, 100);
  assert.equal(json.pagination.total, 140);
  assert.equal(json.pagination.returned, 100);
  assert.equal(json.pagination.requested, 200);
  assert.equal(json.records.length, 100);
});

test("refreshMeetingOutcomes is a no-op when KV is missing", async () => {
  const response = await refreshMeetingOutcomes({}, fetch);
  assert.equal(response.status, "skipped");
  assert.equal(response.reason, "no-kv");
});

test("OPTIONS and method gates are handled by handleMeetingOutcomes", async () => {
  const preflight = await handleMeetingOutcomes(
    new Request("https://api.cityscroll.org/meeting-outcomes", { method: "OPTIONS" }),
    { ALERT_STATE: memoryKV() },
  );
  assert.equal(preflight.status, 204);

  const unsupported = await handleMeetingOutcomes(
    new Request("https://api.cityscroll.org/meeting-outcomes", { method: "POST" }),
    { ALERT_STATE: memoryKV() },
  );
  assert.equal(unsupported.status, 405);
});
