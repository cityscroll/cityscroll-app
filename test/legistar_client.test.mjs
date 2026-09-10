// Legistar authenticated client + meeting-outcomes ingest path characterization.
//
//   node --test test/legistar_client.test.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  fetchLegistarEvents,
  fetchLegistarEventsWindow,
  fetchLegistarBodies,
  fetchLegistarEventItems,
  fetchLegistarItemVotes,
  fetchLegistarItemAttachments,
  summarizeLegistarVotes,
  boundedMap,
  LEGISTAR_API_BASE,
} from "../worker/src/lib/legistar_client.mjs";
import {
  assertPublicUpcomingProjection,
  buildUpcomingCouncilMeetingsView,
  isEligibleUpcomingEvent,
  selectUpcomingItemTargets,
  upcomingCouncilMeetingsHealth,
  upcomingWindow,
  UPCOMING_COUNCIL_MEETINGS_HORIZON_DAYS,
  UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY,
  UPCOMING_COUNCIL_MEETINGS_SCHEMA,
} from "../worker/src/lib/upcoming_council_meetings.mjs";
import { buildMeetingOutcomesView } from "../worker/src/lib/meeting_outcomes.mjs";
import {
  measureOfficialVoteMetrics,
  OFFICIAL_ENTITY_TYPE,
  VOTES_ON_LINK_TYPE,
} from "../entity_resolution/officials/index.mjs";

const TOKEN = "test-token-do-not-log";

/** Build a fetch mock from a pathname → JSON payload map. */
function mockFetch(routes) {
  return async (url) => {
    const { pathname, searchParams } = new URL(url);
    for (const [prefix, payload] of routes) {
      if (pathname.startsWith(prefix)) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }
    // Echo back the token-in-URL invariant so we can assert the client stitches it.
    if (searchParams.get("token")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

const EVENT = {
  EventId: 22526,
  EventBodyName: "Subcommittee on Land Use",
  EventDate: "2026-07-28T00:00:00",
  EventAgendaFile: "https://nyc.legistar1.com/nyc/agenda.pdf",
  EventMinutesFile: "https://nyc.legistar1.com/nyc/minutes.pdf",
  EventInSiteURL: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22526",
};

const ITEM = {
  EventItemId: 440244,
  EventItemEventId: 22526,
  EventItemTitle: "Transit Improvement Funding",
  EventItemActionName: "Approved by Subcommittee",
  EventItemPassedFlagName: "Pass",
  EventItemRollCallFlag: 1,
  EventItemMatterId: 79193,
  EventItemMatterFile: "LU 0001-2026",
  EventItemMatterName: "Transit Improvement Funding",
  EventItemMatterStatus: "Adopted",
};

// Fixture shape kept for backward compatibility (PersonId / VoteValue).
const VOTES = [
  { PersonId: 101, PersonName: "Ada Councilmember", VoteValue: "Aye" },
  { PersonId: 102, PersonName: "Ben Councilmember", VoteValue: "Aye" },
  { PersonId: 103, PersonName: "Cara Councilmember", VoteValue: "Aye" },
  { PersonId: 104, PersonName: "Dee Councilmember", VoteValue: "Nay" },
  { PersonId: 105, PersonName: "Eli Councilmember", VoteValue: "Nay" },
];

// Live Granicus Votes shape (VotePersonId / VoteValueName) — production field names.
const LIVE_VOTES = [
  { VotePersonId: 7801, VotePersonName: "Christopher Marte", VoteValueName: "Affirmative", VoteEventItemId: 440494 },
  { VotePersonId: 7802, VotePersonName: "Ben Councilmember", VoteValueName: "Affirmative", VoteEventItemId: 440494 },
  { VotePersonId: 7803, VotePersonName: "Cara Councilmember", VoteValueName: "Affirmative", VoteEventItemId: 440494 },
  { VotePersonId: 7804, VotePersonName: "Dee Councilmember", VoteValueName: "Negative", VoteEventItemId: 440494 },
  { VotePersonId: 7805, VotePersonName: "Eli Councilmember", VoteValueName: "Negative", VoteEventItemId: 440494 },
];

const NOTICE = {
  request_id: "20260728001",
  section_name: "Public Hearings and Meetings",
  type_of_notice_description: "Public Hearing",
  agency_name: "City Council",
  short_title: "7-28-26 Subcommittee on Land Use — Queens items",
  event_date: "2026-07-28T16:00:00.000",
  start_date: "2026-07-10",
  additional_description_1: "Borough of Queens public hearing.",
  street_address_1: "120 Broad Street",
  city: "New York",
  state: "NY",
  zip_code: "10271",
};

// ---------------------------------------------------------------------------
// Client units
// ---------------------------------------------------------------------------

test("fetchLegistarEvents paginates Events with the token query and date filter", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const isEvents = new URL(url).pathname === "/v1/nyc/Events";
    return new Response(JSON.stringify(isEvents ? [EVENT] : []), { status: 200 });
  };
  const rows = await fetchLegistarEvents({ token: TOKEN, fetchImpl, now: new Date("2026-08-01") });
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].EventId, 22526);
  assert.ok(calls[0].includes("token="));
  assert.ok(calls[0].includes("filter="));
});

test("fetchLegistarEvents returns [] without a token", async () => {
  const rows = await fetchLegistarEvents({ token: null, fetchImpl: async () => new Response("[]") });
  assert.deepEqual(rows, []);
});

test("fetchLegistarEventsWindow reports pagination truncation at the page budget", async () => {
  // Every page comes back full, so the page budget is the binding bound.
  const pages = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/v1/nyc/Events") {
      const skip = Number(u.searchParams.get("$skip"));
      const page = Array.from({ length: 2 }, (_, i) => ({ ...EVENT, EventId: skip + i + 1 }));
      pages.push(skip);
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  const result = await fetchLegistarEventsWindow({ token: TOKEN, fetchImpl, pageSize: 2, maxPages: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 6);
  assert.deepEqual(pages, [0, 2, 4]);
  assert.equal(result.complete, false);
  assert.equal(result.pages, 3);

  // An under-full page ends pagination with complete: true.
  const shortFetch = async () => new Response(JSON.stringify([{ ...EVENT }]), { status: 200 });
  const complete = await fetchLegistarEventsWindow({ token: TOKEN, fetchImpl: shortFetch, pageSize: 200 });
  assert.equal(complete.ok, true);
  assert.equal(complete.rows.length, 1);
  assert.equal(complete.complete, true);
  assert.equal(complete.pages, 1);
});

test("fetchLegistarEventsWindow classifies rate limiting, malformed payloads, and transport failures", async () => {
  const rateLimited = await fetchLegistarEventsWindow({
    token: TOKEN,
    fetchImpl: async () => new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "30" },
    }),
  });
  assert.equal(rateLimited.ok, false);
  assert.equal(rateLimited.kind, "rate-limited");
  assert.equal(rateLimited.status, 429);
  assert.ok(rateLimited.retryAfter);

  const malformed = await fetchLegistarEventsWindow({
    token: TOKEN,
    fetchImpl: async () => new Response("<html>not json</html>", { status: 200 }),
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.kind, "malformed");

  const unreachable = await fetchLegistarEventsWindow({
    token: TOKEN,
    fetchImpl: async () => { throw new Error("ECONNRESET"); },
  });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.kind, "network");
  assert.equal(unreachable.retryAfter, null);

  // The array wrapper keeps its throwing contract for real failures.
  await assert.rejects(
    fetchLegistarEvents({ token: TOKEN, fetchImpl: async () => new Response("no", { status: 429 }) }),
    /legistar-events-rate-limited-429/,
  );
});

test("fetchLegistarBodies uses the authenticated Bodies endpoint and preserves publisher rows", async () => {
  const calls = [];
  const rows = [{ BodyId: 1, BodyName: "New York City Council" }];
  const result = await fetchLegistarBodies({
    token: TOKEN,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.deepEqual(result, rows);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/Bodies\?/);
  assert.match(calls[0], /token=/);
  assert.match(calls[0], /%24top=500/);
});

test("fetchLegistarBodies returns [] without a token", async () => {
  const result = await fetchLegistarBodies({ token: null, fetchImpl: async () => new Response("[]") });
  assert.deepEqual(result, []);
});

test("fetchLegistarEventItems hits the nested Events/{id}/EventItems route", async () => {
  let hit = "";
  const fetchImpl = async (url) => {
    hit = new URL(url).pathname;
    return new Response(JSON.stringify([ITEM]), { status: 200 });
  };
  const rows = await fetchLegistarEventItems({ eventId: 22526, token: TOKEN, fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(hit, "/v1/nyc/Events/22526/EventItems");
});

test("fetchLegistarItemVotes aggregates per-person rows into aye/nay tallies", async () => {
  const summary = await fetchLegistarItemVotes({
    itemId: 440244,
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify(VOTES), { status: 200 }),
    matterId: "79193",
  });
  assert.equal(summary.counts.aye, 3);
  assert.equal(summary.counts.nay, 2);
  assert.equal(summary.result, "Passed");
  assert.equal(summary.by_person.length, 5);
  assert.equal(summary.officials[0].entity_type, OFFICIAL_ENTITY_TYPE);
  assert.equal(summary.votes_on[0].type, VOTES_ON_LINK_TYPE);
  assert.equal(summary.votes_on[0].to, "matter:79193");
  assert.equal(summary.person_vote_retention_rate, 1);
  assert.equal(summary.official_votes_on_edge_rate, 1);
});

test("summarizeLegistarVotes retains person identity for the official family", () => {
  const summary = summarizeLegistarVotes(VOTES, { matterId: "79193", agendaItemId: "440244" });
  const metrics = measureOfficialVoteMetrics(summary);
  // Named product metric: person_vote_retention_rate (0 → 1 on identified rows).
  assert.equal(metrics.person_vote_retention_rate, 1);
  assert.equal(metrics.official_votes_on_edge_rate, 1);
  assert.equal(metrics.distinct_officials, 5);
  assert.equal(metrics.votes_on_edges, 5);
  assert.equal(summary.by_person[0].official.id, "official:101");
});

test("summarizeLegistarVotes keeps tallies when person identity is absent", () => {
  const anonymous = [
    { VoteValue: "Aye" },
    { VoteValue: "Nay" },
  ];
  const summary = summarizeLegistarVotes(anonymous, { matterId: "x" });
  assert.equal(summary.counts.aye, 1);
  assert.equal(summary.counts.nay, 1);
  assert.equal(summary.by_person.length, 0);
  assert.equal(summary.person_vote_retention_rate, 0);
  assert.equal(summary.official_votes_on_edge_rate, 0);
  assert.equal(summary.vote_identity, "tally_only");
});

test("summarizeLegistarVotes retains live VotePersonId/VotePersonName rows", () => {
  const summary = summarizeLegistarVotes(LIVE_VOTES, {
    matterId: "79193",
    agendaItemId: "440494",
  });
  assert.equal(summary.person_count, 5);
  assert.equal(summary.by_person.length, 5);
  assert.equal(summary.person_vote_retention_rate, 1);
  assert.equal(summary.vote_identity, "roll_call");
  assert.equal(summary.counts.aye, 3);
  assert.equal(summary.counts.nay, 2);
  assert.equal(summary.by_person[0].official.id, "official:7801");
  assert.equal(summary.by_person[0].person_name, "Christopher Marte");
  assert.equal(summary.votes_on[0].to, "matter:79193");
});

test("fetchLegistarItemVotes returns null when no votes are recorded", async () => {
  const summary = await fetchLegistarItemVotes({
    itemId: 440244,
    token: TOKEN,
    fetchImpl: async () => new Response(JSON.stringify([]), { status: 200 }),
  });
  assert.equal(summary, null);
});

test("fetchLegistarItemAttachments hits the nested EventItems/{id}/Attachments route", async () => {
  let hit = "";
  const fetchImpl = async (url) => {
    hit = new URL(url).pathname;
    return new Response(JSON.stringify([{
      MatterAttachmentName: "Staff report",
      MatterAttachmentHyperlink: "https://example.com/staff.pdf",
      MatterAttachmentIsSupportingDocument: true,
    }]), { status: 200 });
  };
  const docs = await fetchLegistarItemAttachments({ itemId: 440244, token: TOKEN, fetchImpl });
  assert.equal(hit, "/v1/nyc/EventItems/440244/Attachments");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].name, "Staff report");
  assert.equal(docs[0].url, "https://example.com/staff.pdf");
});

test("boundedMap preserves order under bounded concurrency", async () => {
  const items = [1, 2, 3, 4, 5];
  const out = await boundedMap(items, async (n) => {
    await new Promise((r) => setTimeout(r, Math.random() * 20));
    return n * 10;
  }, 2);
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
});

// ---------------------------------------------------------------------------
// Full ingest path: notices → authenticated events → strict join → items → votes
// ---------------------------------------------------------------------------

test("buildMeetingOutcomesView strict-joins notices to events and materializes matters", async () => {
  const fetchImpl = mockFetch([
    ["/resource/dg92-zbpx.json", [NOTICE]],
    ["/v1/nyc/Events/22526/EventItems", [ITEM]],
    ["/v1/nyc/EventItems/440244/Votes", VOTES],
  ]);
  // The Events list route: return the event only for the top-level Events path.
  const composed = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/v1/nyc/Events") {
      return new Response(JSON.stringify([EVENT]), { status: 200 });
    }
    return mockFetch([
      ["/resource/dg92-zbpx.json", [NOTICE]],
      ["/v1/nyc/Events/22526/EventItems", [ITEM]],
      ["/v1/nyc/EventItems/440244/Votes", VOTES],
    ])(url);
  };

  const view = await buildMeetingOutcomesView({
    token: TOKEN,
    fetchImpl: composed,
    now: new Date("2026-08-01"),
  });

  assert.equal(view.schema_version, 4);
  assert.equal(view.counts.notices, 1);
  assert.equal(view.counts.matched_notices, 1);
  assert.equal(view.counts.event_rows, 1);

  const record = view.records[0];
  assert.equal(record.join.matched, true);
  assert.equal(record.join.method, "exact_date_body_tokens");
  assert.equal(record.council_event.event_id, "22526");
  assert.equal(record.council_event.body_name, "Subcommittee on Land Use");

  const matter = record.agenda_items[0].matters[0];
  assert.equal(matter.matter_id, "79193");
  assert.equal(matter.matter_file, "LU 0001-2026");
  assert.equal(matter.status, "Adopted");
  assert.equal(matter.outcome, "Approved by Subcommittee");
  assert.equal(matter.votes[0].counts.aye, 3);
  assert.equal(matter.votes[0].counts.nay, 2);
  assert.equal(matter.votes[0].by_person.length, 5);
  assert.equal(matter.votes[0].votes_on.length, 5);
  assert.equal(matter.votes[0].officials[0].entity_type, "official");
  assert.equal(matter.votes[0].person_vote_retention_rate, 1);
});

test("buildMeetingOutcomesView supports a bounded historical tranche window", async () => {
  const requested = [];
  const composed = async (url) => {
    requested.push(new URL(url));
    const u = new URL(url);
    if (u.pathname === "/v1/nyc/Events") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  await buildMeetingOutcomesView({
    token: TOKEN,
    fetchImpl: composed,
    now: new Date("2026-08-01"),
    lookbackDays: 730,
    noticeLimit: 2_000,
  });

  const notices = requested.find((url) => url.pathname === "/resource/dg92-zbpx.json");
  const events = requested.find((url) => url.pathname === "/v1/nyc/Events");
  assert.equal(notices.searchParams.get("$limit"), "2000");
  assert.match(notices.searchParams.get("$where"), /event_date >= '2024-08-01T00:00:00'/);
  assert.match(events.searchParams.get("$filter"), /2024-08-01T00:00:00Z/);
});

test("buildMeetingOutcomesView degrades to notices-only gaps without a token", async () => {
  const fetchImpl = mockFetch([
    ["/resource/dg92-zbpx.json", [NOTICE]],
  ]);
  const view = await buildMeetingOutcomesView({
    token: null,
    fetchImpl,
    now: new Date("2026-08-01"),
  });
  assert.equal(view.counts.matched_notices, 0);
  assert.equal(view.counts.event_rows, 0);
  assert.equal(view.records[0].join.matched, false);
  assert.equal(view.upcoming.publishable, false);
  assert.equal(view.upcoming.reason, "token-absent");
  assert.equal(view.upcoming.view, null);
});

test("buildMeetingOutcomesView fetches EventItems only for matched events", async () => {
  const itemCalls = [];
  const composed = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/v1/nyc/Events") {
      // Two events, but only one matches the notice body.
      return new Response(JSON.stringify([
        EVENT,
        { ...EVENT, EventId: 99999, EventBodyName: "Committee on Finance" },
      ]), { status: 200 });
    }
    if (u.pathname.includes("/EventItems") && u.pathname.includes("/Events/")) {
      itemCalls.push(u.pathname);
    }
    return mockFetch([
      ["/resource/dg92-zbpx.json", [NOTICE]],
      ["/v1/nyc/Events/22526/EventItems", [ITEM]],
    ])(url);
  };
  await buildMeetingOutcomesView({
    token: TOKEN,
    fetchImpl: composed,
    now: new Date("2026-08-01"),
  });
  // Only the matched event's items were fetched.
  assert.deepEqual(itemCalls, ["/v1/nyc/Events/22526/EventItems"]);
});

test("token never appears in the API base constant", () => {
  assert.equal(LEGISTAR_API_BASE.includes("token"), false);
});

// ---------------------------------------------------------------------------
// Upcoming Council meetings: eligibility horizon and bounded item discovery
// ---------------------------------------------------------------------------

const UPCOMING_FIXTURE = JSON.parse(await readFile(
  new URL("./fixtures/legistar/upcoming_contracts_22691.json", import.meta.url),
  "utf8",
));

const UPCOMING_NOW = new Date("2026-09-09T12:00:00.000Z");
const UPCOMING_EVENT_ID = String(UPCOMING_FIXTURE.event.EventId);
const UPCOMING_MEETING_ID = `meeting:nyc_legistar_events:${UPCOMING_EVENT_ID}`;

function upcomingProjection(overrides = {}) {
  return buildUpcomingCouncilMeetingsView({
    eventRows: overrides.eventRows || [UPCOMING_FIXTURE.event],
    itemsByEventId: overrides.itemsByEventId || new Map([
      [UPCOMING_EVENT_ID, { rows: UPCOMING_FIXTURE.event_items, fetchError: null }],
    ]),
    now: overrides.now || UPCOMING_NOW,
    cityRecordByEventId: overrides.cityRecordByEventId || new Map(),
    eventsFetch: overrides.eventsFetch || { ok: true, complete: true, pages: 1 },
  });
}

test("upcoming eligibility follows the documented horizon from the pinned clock", () => {
  assert.equal(UPCOMING_COUNCIL_MEETINGS_HORIZON_DAYS, 120);
  assert.equal(UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY, 6);
  const window = upcomingWindow(UPCOMING_NOW);
  assert.equal(window.start, "2026-09-09");
  assert.equal(window.end, "2027-01-07");
  assert.equal(isEligibleUpcomingEvent(UPCOMING_FIXTURE.event, window), true);
  // Past events and events beyond the horizon are not eligible.
  assert.equal(isEligibleUpcomingEvent({ ...UPCOMING_FIXTURE.event, EventDate: "2026-09-08T00:00:00" }, window), false);
  assert.equal(isEligibleUpcomingEvent({ ...UPCOMING_FIXTURE.event, EventDate: "2027-02-01T00:00:00" }, window), false);
  assert.equal(isEligibleUpcomingEvent({ EventDate: "2026-09-23T00:00:00" }, window), false);
});

test("selectUpcomingItemTargets bounds discovery to the nearest events and reports deferral", () => {
  const eligible = [
    { EventId: 3, EventDate: "2026-10-05T00:00:00" },
    { EventId: 1, EventDate: "2026-09-23T00:00:00" },
    { EventId: 4, EventDate: "2026-11-02T00:00:00" },
    { EventId: 2, EventDate: "2026-09-23T00:00:00" },
  ];
  const selection = selectUpcomingItemTargets(eligible, new Set(["2"]), 2);
  // Nearest first, same-day ties by id; already-materialized events are skipped.
  assert.deepEqual(selection.targets.map((e) => e.EventId), [1, 3]);
  assert.equal(selection.already_materialized, 1);
  assert.equal(selection.deferred, 1);
  assert.equal(selection.truncated, true);
});

test("pinned Contracts hearing projects without a City Record notice", () => {
  const result = upcomingProjection();
  assert.equal(result.publishable, true);
  assert.equal(result.view.meetings.length, 1);
  const meeting = result.view.meetings[0];
  assert.equal(meeting.meeting_id, UPCOMING_MEETING_ID);
  assert.equal(meeting.identity.source_system, "nyc_legistar_events");
  assert.equal(meeting.identity.event_id, UPCOMING_EVENT_ID);
  assert.equal(meeting.identity.event_guid, UPCOMING_FIXTURE.event.EventGuid);
  assert.equal(meeting.date, "2026-09-23");
  assert.equal(meeting.wall_time, "2026-09-23T10:00:00");
  assert.equal(meeting.time_zone, "America/New_York");
  assert.equal(meeting.governing_body.name, "Committee on Contracts");
  assert.match(meeting.venue.address, /250 Broadway/);
  assert.match(meeting.venue.address, /Hearing Room 2/);
  assert.equal(meeting.url, UPCOMING_FIXTURE.event.EventInSiteURL);
  assert.equal(meeting.documents[0].url, UPCOMING_FIXTURE.event.EventAgendaFile);
  assert.equal(meeting.source_receipt.source_system, "nyc_legistar_events");
  assert.equal(meeting.source_receipt.observed_at, result.view.generated_at);
  assert.equal(meeting.city_record_notice.matched_in_window, false);
  assert.equal(meeting.city_record_notice.request_id, null);
  assert.match(meeting.agenda.search_text, /M\/WBE Utilization and the Required Disparity Study/);
  assert.equal(result.view.discovery.horizon_days, 120);
  assert.equal(result.view.discovery.item_concurrency, 6);
  assert.equal(result.view.discovery.item_discovery_truncated, false);
  assert.equal(result.view.source_health.status, "healthy");
  assertPublicUpcomingProjection(result.view);
  assert.equal(UPCOMING_FIXTURE.insite_calendar.meeting_id, 1439673);
});

test("a later City Record notice links metadata without replacing Events identity", () => {
  const result = upcomingProjection({
    cityRecordByEventId: new Map([
      [UPCOMING_EVENT_ID, { request_id: "20260923001", method: "exact_date_body_tokens" }],
    ]),
  });
  const meeting = result.view.meetings[0];
  assert.equal(meeting.meeting_id, UPCOMING_MEETING_ID);
  assert.equal(meeting.city_record_notice.matched_in_window, true);
  assert.equal(meeting.city_record_notice.request_id, "20260923001");
  assert.equal(meeting.city_record_notice.method, "exact_date_body_tokens");
});

test("upcoming item discovery truncation is explicit when the event cap binds", () => {
  const eligible = [
    { ...UPCOMING_FIXTURE.event, EventId: 1, EventDate: "2026-09-23T00:00:00" },
    { ...UPCOMING_FIXTURE.event, EventId: 2, EventDate: "2026-10-01T00:00:00" },
    { ...UPCOMING_FIXTURE.event, EventId: 3, EventDate: "2026-11-01T00:00:00" },
  ];
  const result = upcomingProjection({
    eventRows: eligible,
    itemsByEventId: new Map([["1", { rows: UPCOMING_FIXTURE.event_items, fetchError: null }]]),
  });
  assert.equal(result.view.meetings.length, 3);
  assert.equal(result.view.discovery.item_events_attempted, 1);
  assert.equal(result.view.discovery.item_events_deferred, 2);
  assert.equal(result.view.discovery.item_discovery_truncated, true);
  assert.equal(result.view.meetings[1].agenda.status, "not_fetched");
});

test("empty authenticated Events rows are not a publishable upcoming source", () => {
  const result = buildUpcomingCouncilMeetingsView({
    eventRows: [],
    now: UPCOMING_NOW,
  });
  assert.equal(result.publishable, false);
  assert.equal(result.reason, "empty-source");
  assert.equal(result.view, null);
});

test("public upcoming projection refuses credentials and authenticated publisher URLs", () => {
  const result = upcomingProjection();
  assertPublicUpcomingProjection(result.view);
  const leaked = structuredClone(result.view);
  leaked.meetings[0].url = "https://webapi.legistar.com/v1/nyc/Events?token=secret";
  assert.throws(() => assertPublicUpcomingProjection(leaked), /authenticated publisher URL|credential-bearing/);
});

test("upcoming serving health is unavailable or stale rather than an empty success", () => {
  assert.deepEqual(upcomingCouncilMeetingsHealth(null), { status: "unavailable", reason: "no-snapshot" });
  const result = upcomingProjection();
  assert.equal(upcomingCouncilMeetingsHealth(result.view, Date.parse("2026-09-09T12:00:00.000Z")).status, "healthy");
  assert.equal(
    upcomingCouncilMeetingsHealth(result.view, Date.parse("2026-09-12T00:00:00.000Z")).status,
    "stale",
  );
  assert.equal(
    upcomingCouncilMeetingsHealth({ ...result.view, schema_version: 0 }, Date.parse("2026-09-09T12:00:00.000Z")).status,
    "stale",
  );
});

test("buildMeetingOutcomesView fetches EventItems for eligible upcoming unmatched events at bounded concurrency", async () => {
  const itemCalls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const gate = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  };
  const composed = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/v1/nyc/Events") {
      // One eligible upcoming event with no matching City Record notice, plus
      // one past event nothing should fetch items for.
      return new Response(JSON.stringify([
        UPCOMING_FIXTURE.event,
        { ...UPCOMING_FIXTURE.event, EventId: 99998, EventDate: "2026-08-01T00:00:00" },
      ]), { status: 200 });
    }
    if (u.pathname === `/v1/nyc/Events/${UPCOMING_EVENT_ID}/EventItems`) {
      itemCalls.push(u.pathname);
      await gate();
      return new Response(JSON.stringify(UPCOMING_FIXTURE.event_items), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  const view = await buildMeetingOutcomesView({
    token: TOKEN,
    fetchImpl: composed,
    now: UPCOMING_NOW,
  });

  // The unmatched upcoming event still received agenda discovery.
  assert.deepEqual(itemCalls, [`/v1/nyc/Events/${UPCOMING_EVENT_ID}/EventItems`]);
  assert.equal(view.upcoming.publishable, true);
  assert.equal(view.upcoming.view.schema, UPCOMING_COUNCIL_MEETINGS_SCHEMA);
  assert.equal(view.upcoming.view.meetings.length, 1);
  assert.equal(view.upcoming.view.meetings[0].meeting_id, UPCOMING_MEETING_ID);
  assert.match(view.upcoming.view.meetings[0].agenda.search_text, /M\/WBE Utilization and the Required Disparity Study/);
  assert.equal(view.upcoming.view.meetings[0].city_record_notice.matched_in_window, false);
  // The upcoming item rows also feed the outcomes view's unmatched-event
  // diagnostic population (event_rows counts every acquired event).
  assert.equal(view.counts.event_rows, 2);
  assert.ok(maxInFlight <= UPCOMING_COUNCIL_MEETINGS_ITEM_CONCURRENCY, `observed concurrency ${maxInFlight} exceeded the bound`);
  assertPublicUpcomingProjection(view.upcoming.view);
});
