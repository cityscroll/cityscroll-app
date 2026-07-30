// Legistar authenticated client + meeting-outcomes ingest path characterization.
//
//   node --test test/legistar_client.test.mjs

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchLegistarEvents,
  fetchLegistarEventItems,
  fetchLegistarItemVotes,
  fetchLegistarItemAttachments,
  boundedMap,
  LEGISTAR_API_BASE,
} from "../worker/src/lib/legistar_client.mjs";
import { buildMeetingOutcomesView } from "../worker/src/lib/meeting_outcomes.mjs";

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

const VOTES = [
  { VoteValue: "Aye" }, { VoteValue: "Aye" }, { VoteValue: "Aye" },
  { VoteValue: "Nay" }, { VoteValue: "Nay" },
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
  });
  assert.equal(summary.counts.aye, 3);
  assert.equal(summary.counts.nay, 2);
  assert.equal(summary.result, "Passed");
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

  assert.equal(view.schema_version, 2);
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
