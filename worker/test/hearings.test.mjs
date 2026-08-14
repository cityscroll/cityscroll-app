import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  buildHearingView,
  handleHearings,
  handleMeetingICS,
  HEARINGS_KV_KEY,
  refreshHearings,
} from "../src/hearings.mjs";
import { normalizeHearing } from "../src/lib/hearings.mjs";

const TEST_NOW = new Date();
const CITY_RECORD_20260713006_HTML = await readFile(
  new URL("./fixtures/city-record-hearing/20260713006.html", import.meta.url),
  "utf8",
);

function fixtureDate(offsetDays) {
  const date = new Date(TEST_NOW.getTime() + (offsetDays * 24 * 60 * 60 * 1000));
  return date.toISOString().replace(".000Z", ".000");
}

function makeSourceRow() {
  return {
  request_id: "fixture-hearing-view",
  start_date: fixtureDate(-1),
  event_date: fixtureDate(6),
  agency_name: "City Planning Commission",
  type_of_notice_description: "Public Hearings",
  section_name: "Public Hearings and Meetings",
  short_title: "Queens zoning map amendment",
  street_address_1: "120 Broadway",
  city: "New York",
  state: "NY",
  zip_code: "10271",
  additional_description_1: "IN THE MATTER OF property located at 37-18 Queens Boulevard in the Sunnyside neighborhood, Community District 2, Queens.",
  };
}

const sourceRow = makeSourceRow();

function fetchFixture(calls) {
  return async (url) => {
    calls.push(url);
    if (url.startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify([sourceRow]), { status: 200 });
    }
    const query = new URL(url).searchParams.get("text") || "";
    const queens = query.includes("Queens Boulevard");
    return new Response(JSON.stringify({
      features: [{
        properties: {
          borough: queens ? "Queens" : "Manhattan",
          neighbourhood: queens ? "Sunnyside" : "Financial District",
        },
      }],
    }), { status: 200 });
  };
}

function memoryKV() {
  const values = new Map();
  return {
    values,
    async get(key) { return values.get(key) || null; },
    async put(key, value) { values.set(key, value); },
  };
}

test("materialized view queries both hearing-bearing sections and geocodes venue and subject separately", async () => {
  const calls = [];
  const view = await buildHearingView(fetchFixture(calls), TEST_NOW);
  assert.equal(view.hearings.length, 1);
  const where = new URL(calls[0]).searchParams.get("$where");
  assert.match(where, /Public Hearings and Meetings/);
  assert.match(where, /Agency Rules/);
  assert.match(where, /section_name='Agency Rules' AND event_date IS NOT NULL/);
  assert.doesNotMatch(where, /section_name='Agency Rules'.*type_of_notice_description='Public Hearings'/);
  assert.equal(view.hearings[0].venue.borough, "Manhattan");
  assert.deepEqual(view.hearings[0].affected_area.boroughs, ["Queens"]);
  assert.deepEqual(view.counts, { total: 1, local: 1, citywide: 0, unlocated: 0 });
});

test("refresh writes one materialized view and the read route serves it", async () => {
  const kv = memoryKV();
  const result = await refreshHearings({ ALERT_STATE: kv }, fetchFixture([]), TEST_NOW);
  assert.equal(result.status, "success");
  assert.ok(kv.values.has(HEARINGS_KV_KEY));

  const response = await handleHearings(new Request("https://api.cityscroll.org/hearings"), { ALERT_STATE: kv });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const body = await response.json();
  assert.equal(body.hearings[0].request_id, "fixture-hearing-view");
  assert.equal(body.source_extraction_version, 2);
});

test("meeting ICS is built from the materialized hearing record", async () => {
  const kv = memoryKV();
  await kv.put(HEARINGS_KV_KEY, JSON.stringify({
    generated_at: TEST_NOW.toISOString(),
    hearings: [{
      request_id: "fixture-calendar",
      title: "Hybrid hearing",
      agency: "City Planning Commission",
      event_date: "2026-08-10T14:30:00.000",
      venue: { mode: "hybrid", building: "Room 120", address: "1 Centre Street, New York, NY 10007" },
      meeting_access: {
        mode: "hybrid",
        in_person_location: "Room 120 · 1 Centre Street, New York, NY 10007",
        remote_join_url: "https://zoom.us/j/123456789",
        dial_in: [],
      },
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/fixture-calendar",
    }],
  }));
  const response = await handleMeetingICS(
    new Request("https://api.cityscroll.org/meeting.ics?id=fixture-calendar"),
    { ALERT_STATE: kv },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/calendar/);
  const body = await response.text();
  assert.match(body, /URL:https:\/\/zoom\.us\/j\/123456789/);
  assert.match(body, /LOCATION:Room 120/);
});

test("rule notices with a hearing date are included even when their notice type is generic", async () => {
  const row = {
    request_id: "20260803009",
    start_date: "2026-08-12T00:00:00.000",
    event_date: "2026-09-14T10:00:00.000",
    agency_name: "Health and Mental Hygiene",
    type_of_notice_description: "Notice",
    section_name: "Agency Rules",
    short_title: "New Rules Relating to Rat Inspections",
  };
  const calls = [];
  const fetchRule = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify([row]), { status: 200 });
    }
    return new Response("", { status: 200 });
  };
  const view = await buildHearingView(fetchRule, new Date("2026-08-12T12:00:00.000Z"));
  assert.equal(view.hearings[0]?.request_id, "20260803009");
  const where = new URL(calls[0]).searchParams.get("$where");
  assert.doesNotMatch(where, /section_name='Agency Rules'.*type_of_notice_description='Public Hearings'/);
});

test("ICS refreshes a fresh cache miss for the dated rule hearing", async () => {
  const kv = memoryKV();
  await kv.put(HEARINGS_KV_KEY, JSON.stringify({
    generated_at: TEST_NOW.toISOString(),
    hearings: [],
  }));
  const row = {
    request_id: "20260803009",
    start_date: "2026-08-03T00:00:00.000",
    event_date: "2026-09-14T10:00:00.000",
    agency_name: "Health and Mental Hygiene",
    type_of_notice_description: "Notice",
    section_name: "Agency Rules",
    short_title: "New Rules Relating to Rat Inspections",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify([row]), { status: 200 });
    }
    if (target.includes("a856-cityrecord.nyc.gov/RequestDetail/20260803009")) {
      return new Response(
        '<div class="container page-body"><p>To participate in the public hearing, enter to register at this Zoom meeting.</p>'
          + '<a href="https://health-nyc.zoomgov.com/j/1659561163?pwd=VeOYdE9L6mLxAjB9aiajLvQg6dLj9x.1">Join</a>'
          + '</div>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response(JSON.stringify({ features: [] }), { status: 200 });
  };
  try {
    const response = await handleMeetingICS(
      new Request("https://api.cityscroll.org/meeting.ics?id=20260803009"),
      { ALERT_STATE: kv },
    );
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /DTSTART;TZID=America\/New_York:20260914T100000/);
    assert.match(body, /SUMMARY:New Rules Relating to Rat Inspections/);
    assert.match(body, /LOCATION:Online/);
    const unfolded = body.replace(/\r\n[ \t]/g, "");
    assert.match(unfolded, /Join online: https:\/\/health-nyc\.zoomgov\.com\/j\/1659561163/);
    assert.match(unfolded, /Mode: Online/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("City Record hearing source text supplies online mode and the join URL", () => {
  const record = normalizeHearing({
    request_id: "20260803009",
    event_date: "2026-09-14T10:00:00.000",
    agency_name: "Health and Mental Hygiene",
    section_name: "Agency Rules",
    type_of_notice_description: "Public Hearings",
    short_title: "New Rules Relating to Rat Inspections",
    source_body: "To participate in the public hearing, enter to register at this Zoom meeting.",
    source_links: ["https://health-nyc.zoomgov.com/j/1659561163?pwd=VeOYdE9L6mLxAjB9aiajLvQg6dLj9x.1"],
  });
  assert.equal(record.meeting_access.mode, "remote");
  assert.equal(record.meeting_access.remote_join_url, "https://health-nyc.zoomgov.com/j/1659561163?pwd=VeOYdE9L6mLxAjB9aiajLvQg6dLj9x.1");
});

test("City Record rule hearing strips page chrome and keeps only its GetFile attachment", async () => {
  const row = {
    request_id: "20260713006",
    start_date: "2026-07-20T00:00:00.000",
    event_date: "2026-08-19T11:00:00.000",
    agency_name: "Consumer and Worker Protection (DCWP)",
    type_of_notice_description: "Public Hearings",
    section_name: "Agency Rules",
    short_title: "DCWP NOH Rules Relating to Waitlist for GV Licenses",
  };
  const calls = [];
  const fetchRule = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith("https://data.cityofnewyork.us/")) {
      return new Response(JSON.stringify([row]), { status: 200 });
    }
    if (String(url).includes("a856-cityrecord.nyc.gov/RequestDetail/20260713006")) {
      return new Response(CITY_RECORD_20260713006_HTML, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response(JSON.stringify({ features: [] }), { status: 200 });
  };

  const view = await buildHearingView(fetchRule, new Date("2026-08-12T12:00:00.000Z"));
  const record = view.hearings.find((hearing) => hearing.request_id === row.request_id);
  assert.ok(record);
  assert.doesNotMatch(record.description, /The City Record Online \(CROL\)|UNSUPPORTED|Sections|User's Guide/);
  assert.deepEqual(record.participation.links, [{
    label: "Participation link",
    url: "https://a856-cityrecord.nyc.gov/Search/GetFile?sectionId=4&requestId=20260713006&requestStatus=Archived&documentId=44259",
  }]);
  assert.ok(!record.participation.links.some((link) => /fonts\.googleapis\.com/i.test(link.url)));
  assert.ok(calls.some((url) => url.includes("RequestDetail/20260713006")));
});

test("participation does not guess from generic assets or stylesheet links", () => {
  const record = normalizeHearing({
    request_id: "20260713007",
    section_name: "Agency Rules",
    event_date: "2026-08-20T11:00:00.000",
    source_body: "Notice details without a meeting link.",
    source_links: [
      "https://fonts.googleapis.com/css?family=Open+Sans",
      "https://a856-cityrecord.nyc.gov/Content/site.css",
      "https://a856-cityrecord.nyc.gov/Search/GetFile?requestId=other&documentId=44259",
    ],
  });
  assert.deepEqual(record.participation.links, []);
});
