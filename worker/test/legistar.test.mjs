import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyApiLimits,
  buildMeetingOutcomes,
  MEETING_OUTCOMES_KV_KEY,
  MEETING_OUTCOMES_VIEW_VERSION,
  meetingOutcomesViewNeedsRefresh,
} from "../src/lib/meeting_outcomes.mjs";
import {
  handleMeetingOutcomes,
  refreshMeetingOutcomes,
} from "../src/meeting_outcomes.mjs";
import {
  UPCOMING_COUNCIL_MEETINGS_KV_KEY,
  UPCOMING_COUNCIL_MEETINGS_SCHEMA,
} from "../src/lib/upcoming_council_meetings.mjs";

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

  // Subject registry: matched notice ↔ legistar-event with provenance.
  assert.ok(record.subject_refs?.notice);
  assert.ok(record.subject_refs?.["legistar-event"]);
  assert.equal(record.subject_refs["legistar-event"], `legistar-event:${record.council_event.event_id}`);
  assert.ok(record.subject_links.some((l) => (
    l.type === "about_notice"
    && l.from === record.subject_refs["legistar-event"]
    && l.to === record.subject_refs.notice
  )));
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
  // Unmatched: notice subject only — no speculative legistar-event stamp or link.
  assert.equal(model.records[0].subject_refs.notice, "notice:CR-1002");
  assert.equal(model.records[0].subject_refs["legistar-event"], undefined);
  assert.equal(model.records[0].subject_links.length, 0);
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

test("meetingOutcomesViewNeedsRefresh rebuilds young KV under an older schema_version", () => {
  const nowMs = Date.parse("2026-08-02T18:00:00.000Z");
  assert.equal(meetingOutcomesViewNeedsRefresh(null, nowMs), true);
  // Pre–person-vote materialization (schema 2) must not stick while still young.
  assert.equal(meetingOutcomesViewNeedsRefresh({
    schema_version: 2,
    generated_at: "2026-08-02T17:00:00.000Z",
  }, nowMs), true);
  assert.equal(meetingOutcomesViewNeedsRefresh({
    schema_version: MEETING_OUTCOMES_VIEW_VERSION,
    generated_at: "2026-08-02T17:00:00.000Z",
  }, nowMs), false);
  // Older than MAX_AGE_MS (~36h) even when schema matches.
  assert.equal(meetingOutcomesViewNeedsRefresh({
    schema_version: MEETING_OUTCOMES_VIEW_VERSION,
    generated_at: "2026-07-30T17:00:00.000Z",
  }, nowMs), true);
});

test("GET /meeting-outcomes serves capped JSON records", async () => {
  const kv = memoryKV();
  const payload = modelFromFixture();
  // Handler re-fetches live when generated_at is older than MAX_AGE_MS (~36h)
  // or schema_version is behind. Seed a fresh current-version snapshot so this
  // test stays hermetic against wall-clock drift and version bumps.
  payload.generated_at = new Date().toISOString();
  payload.schema_version = MEETING_OUTCOMES_VIEW_VERSION;
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

const upcomingFixture = JSON.parse(await readFile(
  new URL("../../test/fixtures/legistar/upcoming_contracts_22691.json", import.meta.url),
  "utf8",
));
const UPCOMING_NOW = new Date("2026-09-09T12:00:00.000Z");
const UPCOMING_TOKEN = "test-token-do-not-log";
const PRIOR_UPCOMING = JSON.stringify({
  schema: UPCOMING_COUNCIL_MEETINGS_SCHEMA,
  schema_version: 1,
  generated_at: "2026-09-08T12:00:00.000Z",
  meetings: [{ meeting_id: "meeting:nyc_legistar_events:1" }],
});

function upcomingFetchImpl({
  events = [upcomingFixture.event],
  items = upcomingFixture.event_items,
  notices = [],
  eventsStatus = 200,
  eventsBody = null,
  networkError = null,
} = {}) {
  return async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/resource/")) {
      return new Response(JSON.stringify(notices), { status: 200 });
    }
    if (networkError) throw new Error(networkError);
    if (parsed.pathname === "/v1/nyc/Events") {
      if (eventsStatus !== 200) {
        return new Response("rate limited", {
          status: eventsStatus,
          headers: { "Retry-After": "30" },
        });
      }
      if (eventsBody != null) return new Response(eventsBody, { status: 200 });
      return new Response(JSON.stringify(events), { status: 200 });
    }
    if (parsed.pathname === `/v1/nyc/Events/${upcomingFixture.event.EventId}/EventItems`) {
      return new Response(JSON.stringify(items), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
}

async function seedUpcoming(kv, value = PRIOR_UPCOMING) {
  await kv.put(UPCOMING_COUNCIL_MEETINGS_KV_KEY, value);
  return kv;
}

test("refreshMeetingOutcomes materializes the unmatched Contracts hearing into its own snapshot", async () => {
  const kv = memoryKV();
  const result = await refreshMeetingOutcomes(
    { ALERT_STATE: kv, LEGISTAR_API_TOKEN: UPCOMING_TOKEN },
    upcomingFetchImpl(),
    UPCOMING_NOW,
  );
  assert.equal(result.upcoming.status, "success");
  const stored = JSON.parse(await kv.get(UPCOMING_COUNCIL_MEETINGS_KV_KEY));
  assert.equal(stored.schema, UPCOMING_COUNCIL_MEETINGS_SCHEMA);
  assert.equal(stored.meetings[0].meeting_id, `meeting:nyc_legistar_events:${upcomingFixture.event.EventId}`);
  assert.match(stored.meetings[0].agenda.search_text, /M\/WBE Utilization and the Required Disparity Study/);
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes(UPCOMING_TOKEN), false);
  assert.equal(serialized.includes("token="), false);
  assert.equal(/webapi\.legistar\.com/i.test(serialized), false);
});

test("token absence retains last-known-good upcoming data as unavailable", async () => {
  const kv = await seedUpcoming(memoryKV());
  const result = await refreshMeetingOutcomes(
    { ALERT_STATE: kv },
    upcomingFetchImpl(),
    UPCOMING_NOW,
  );
  assert.equal(result.status, "no-token");
  assert.equal(result.upcoming.status, "unavailable");
  assert.equal(result.upcoming.reason, "token-absent");
  assert.equal(await kv.get(UPCOMING_COUNCIL_MEETINGS_KV_KEY), PRIOR_UPCOMING);
});

test("Events rate limiting retains last-known-good upcoming data", async () => {
  const kv = await seedUpcoming(memoryKV());
  await assert.rejects(
    refreshMeetingOutcomes(
      { ALERT_STATE: kv, LEGISTAR_API_TOKEN: UPCOMING_TOKEN },
      upcomingFetchImpl({ eventsStatus: 429 }),
      UPCOMING_NOW,
    ),
    /rate-limited/,
  );
  assert.equal(await kv.get(UPCOMING_COUNCIL_MEETINGS_KV_KEY), PRIOR_UPCOMING);
});

test("malformed Events payloads retain last-known-good upcoming data", async () => {
  const kv = await seedUpcoming(memoryKV());
  await assert.rejects(
    refreshMeetingOutcomes(
      { ALERT_STATE: kv, LEGISTAR_API_TOKEN: UPCOMING_TOKEN },
      upcomingFetchImpl({ eventsBody: "<html>not json</html>" }),
      UPCOMING_NOW,
    ),
    /malformed/,
  );
  assert.equal(await kv.get(UPCOMING_COUNCIL_MEETINGS_KV_KEY), PRIOR_UPCOMING);
});

test("Events transport failure retains last-known-good upcoming data", async () => {
  const kv = await seedUpcoming(memoryKV());
  await assert.rejects(
    refreshMeetingOutcomes(
      { ALERT_STATE: kv, LEGISTAR_API_TOKEN: UPCOMING_TOKEN },
      upcomingFetchImpl({ networkError: "ECONNRESET" }),
      UPCOMING_NOW,
    ),
    /network/,
  );
  assert.equal(await kv.get(UPCOMING_COUNCIL_MEETINGS_KV_KEY), PRIOR_UPCOMING);
});

test("an empty Events acquisition does not publish a successful empty upcoming source", async () => {
  const kv = await seedUpcoming(memoryKV());
  const result = await refreshMeetingOutcomes(
    { ALERT_STATE: kv, LEGISTAR_API_TOKEN: UPCOMING_TOKEN },
    upcomingFetchImpl({ events: [] }),
    UPCOMING_NOW,
  );
  assert.equal(result.upcoming.status, "unavailable");
  assert.equal(result.upcoming.reason, "empty-source");
  assert.equal(await kv.get(UPCOMING_COUNCIL_MEETINGS_KV_KEY), PRIOR_UPCOMING);
});

test("a credential-bearing upcoming projection fails closed and retains last-known-good", async () => {
  const kv = await seedUpcoming(memoryKV());
  const poisoned = {
    ...upcomingFixture.event,
    EventInSiteURL: "https://webapi.legistar.com/v1/nyc/Events?token=leaked",
  };
  await assert.rejects(
    refreshMeetingOutcomes(
      { ALERT_STATE: kv, LEGISTAR_API_TOKEN: UPCOMING_TOKEN },
      upcomingFetchImpl({ events: [poisoned] }),
      UPCOMING_NOW,
    ),
    /credential-bearing|authenticated publisher URL/,
  );
  assert.equal(await kv.get(UPCOMING_COUNCIL_MEETINGS_KV_KEY), PRIOR_UPCOMING);
  assert.equal(kv.values.has(MEETING_OUTCOMES_KV_KEY), false);
});
