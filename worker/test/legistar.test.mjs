import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyApiLimits,
  buildMeetingOutcomes,
  parseLegistarResponse,
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

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("parseLegistarResponse handles array-like payloads", () => {
  assert.equal(parseLegistarResponse([{ id: 1 }]).length, 1);
  assert.equal(parseLegistarResponse({ value: [{ id: 2 }] }).length, 1);
  assert.equal(parseLegistarResponse({ d: [{ id: 3 }] }).length, 1);
  assert.equal(parseLegistarResponse("noop").length, 0);
});

// ---------------------------------------------------------------------------
// Chain coverage
// ---------------------------------------------------------------------------

test("buildMeetingOutcomes follows notice -> agenda -> matter -> vote -> document", () => {
  const model = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.agenda_items,
    fixture.matters,
    fixture.votes,
    fixture.documents,
  );

  assert.equal(model.records.length, 1);
  assert.equal(model.counts.votes, 1);
  assert.equal(model.counts.documents, 1);

  const record = model.records[0];
  assert.equal(record.join.matched, true);
  assert.equal(record.join.reason.includes("title overlap"), true);

  const item = record.agenda_items[0];
  assert.equal(item.join.matched, true);
  assert.equal(item.matters.length, 1);

  const matter = item.matters[0];
  assert.equal(matter.matter_id, "mat-001");
  assert.equal(matter.votes[0].vote_id, "vote-001");
  assert.equal(matter.documents[0].document_id, "doc-001");
  assert.equal(matter.votes[0].counts.aye, 6);
  assert.equal(matter.join.matched, true);
});

test("notice venue does not become affected geography", () => {
  const model = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.agenda_items,
    fixture.matters,
    fixture.votes,
    fixture.documents,
  );
  const record = model.records[0];
  assert.equal(record.notice.affected_area.scope, "local");
  assert.deepEqual(record.notice.affected_area.boroughs, ["Queens"]);
  assert.equal(record.notice.venue.address, "120 Broad Street, New York, NY, 10271");
  assert.notEqual(record.notice.venue.borough, "Queens");
  assert.equal(record.agenda_items[0].join.reason, null);
});

test("unmatched notice is explicit and machine-readable", () => {
  const model = buildMeetingOutcomes(
    [
      {
        ...fixture.notices[0],
        request_id: "CR-1002",
        short_title: "Unmatched council item",
      },
    ],
    fixture.events,
    fixture.agenda_items,
    fixture.matters,
    fixture.votes,
    fixture.documents,
  );

  assert.equal(model.records.length, 1);
  assert.equal(model.records[0].join.matched, false);
  assert.equal(model.records[0].join.reason.includes("No Council event"), true);
  assert.equal(model.records[0].council_event, null);
  assert.equal(Array.isArray(model.records[0].agenda_items), true);
  assert.equal(model.records[0].agenda_items.length, 0);
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
  const payload = buildMeetingOutcomes(
    fixture.notices,
    fixture.events,
    fixture.agenda_items,
    fixture.matters,
    fixture.votes,
    fixture.documents,
  );
  payload.generated_at = nowIso(VIEW_NOW);
  payload.records = Array.from({ length: 140 }, (_, i) => ({
    ...payload.records[0],
    request_id: `CR-${i + 10}`,
    notice: { ...payload.records[0].notice, request_id: `CR-${i + 10}` },
    council_event: { ...payload.records[0].council_event, event_id: `evt-${i}` },
  }));
  await kv.put("meeting-outcomes:materialized:v1", JSON.stringify(payload));

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
