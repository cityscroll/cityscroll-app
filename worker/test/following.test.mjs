import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import { handleFollowing } from "../src/following.mjs";
import { handleSubscribe } from "../src/subscribe.mjs";
import { handlePrefs } from "../src/prefs.mjs";
import { subDigestHtml } from "../src/alerts.mjs";
import { signToken } from "optin-token";
import { sessionPayload } from "../src/lib/session.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import {
  collapseMeetingDeliveryRows,
  meetingDeliveryKey,
  officialMeetingSourceActions,
  reconcileMeetingDelivery,
} from "../../site/meeting_delivery_identity.mjs";

const upcomingFixture = JSON.parse(readFileSync(new URL("../../test/fixtures/legistar/upcoming_contracts_22691.json", import.meta.url)));
const FIXTURE_EVENT_ID = String(upcomingFixture.event.EventId);
const FIXTURE_MEETING_ID = `meeting:nyc_legistar_events:${FIXTURE_EVENT_ID}`;
const PINNED_TODAY = "2026-09-09";

const SIGNING_FIXTURE = "example-token-placeholder";
const TEST_EMAIL = ["reader", "example.com"].join("@");
const FIXTURE_NOW = new Date("2026-08-10T12:00:00.000Z");
const FIXTURE_TODAY = FIXTURE_NOW.toISOString().slice(0, 10);
const FIXTURE_UPCOMING_MEETING = new Date(FIXTURE_NOW.getTime() + 2 * 86400000).toISOString();
const FIXTURE_HEARING = {
  schema_version: 1,
  source: "zap-api-milestones",
  project_id: "2026Q0001",
  project_name: "Known Rezoning",
  milestone_id: "hearing-1",
  milestone_title: "CPC Public Meeting - Public Hearing",
  milestone_source_title: "CPC Public Meeting - Public Hearing",
  event_class: "cpc_public_hearing",
  representing: "City Planning Commission",
  hearing_date: "2026-09-15",
  hearing_at: "2026-09-15T22:30:00.000Z",
  cc_district: "33",
  venue_address: "123 Main Street, Queens",
  portal_url: "https://zap.planning.nyc.gov/projects/2026Q0001",
  provenance: { field: "dcp-reviewmeetingdate", source: "zap-api-milestones" },
};

function kv() {
  const values = new Map();
  return {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix = "" } = {}) {
      return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
  };
}

function previewFetch(url) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "data.cityofnewyork.us");
  return Promise.resolve(new Response(JSON.stringify([
    {
      request_id: "20260805001",
      short_title: "Queens curb redesign hearing",
      agency_name: "Transportation",
      event_date: FIXTURE_UPCOMING_MEETING,
      section_name: "Public Hearings and Meetings",
    },
  ]), { status: 200, headers: { "Content-Type": "application/json" } }));
}

test("the edge Following renderer pins a notice-scoped handoff without changing the watch body", async () => {
  const filter = encodeURIComponent(JSON.stringify({ agency: "Transportation" }));
  const response = await handleFollowing(new Request(
    `https://cityscroll.org/following?lens=meetings&filter=${filter}&notice=20260805001&from=%2Fnotices%2F20260805001%2F`,
  ), {}, {}, { fetchImpl: previewFetch, todayISO: FIXTURE_TODAY });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /data-following-preview-focus/);
  assert.match(html, /data-focus-id="20260805001"/);
  assert.match(html, /name="notice" value="20260805001"/);
  assert.match(html, /name="from" value="\/notices\/20260805001\//);
  assert.match(html, /name="lens"[^>]+value="meetings"/);
  assert.match(html, /data-following-subscribe-form/);
  assert.doesNotMatch(html, /data-following-handoff-status="unrecognized_scope"/);
});

test("the edge Following renderer keeps an unrecognized lens from becoming a Contracts watch", async () => {
  const response = await handleFollowing(new Request(
    "https://cityscroll.org/following?lens=not-a-lens&filter=%7B%22agency%22%3A%22Parks%22%7D",
  ), {}, {}, { fetchImpl: previewFetch, todayISO: FIXTURE_TODAY });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /data-following-handoff-status="unrecognized_scope"/);
  assert.match(html, /This watch link is not recognized/);
  assert.doesNotMatch(html, /data-following-subscribe-form/);
  assert.doesNotMatch(html, /name="lens"[^>]+value="money"/);
});

test("choose-step Following URLs keep scope without previewing or saving", async () => {
  const response = await handleFollowing(new Request(
    "https://cityscroll.org/following?lens=land&filter=%7B%22boro%22%3A%22Brooklyn%22%7D&freq=weekly&step=choose",
  ), {}, {}, {
    fetchImpl: () => {
      throw new Error("preview fetch must not run on choose");
    },
  });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /data-following-journey="choose"/);
  assert.match(html, /following-scope-link on"[^>]*data-following-scope-value="land"/);
  assert.match(html, /following-scope-link on"[^>]*data-following-scope-value="Brooklyn"/);
  assert.doesNotMatch(html, /data-following-subscribe-form/);
  assert.doesNotMatch(html, /name="email"/);
  assert.match(html, /Choosing a topic or place does not start a watch/);
});

test("the edge Following renderer keeps the create-first empty state on a fresh visit", async () => {
  const response = await handleFollowing(new Request("https://cityscroll.org/following/"));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /data-following-preview-form/);
  assert.match(html, /data-following-journey="choose"/);
  assert.doesNotMatch(html, /data-following-subscribe-form/);
  assert.match(html, /Save a topic, place, agency, or keyword\. We email matching public records when they appear\./);
  assert.match(html, /data-personal-watch-list/);
});

test("the edge Following renderer previews the shared materialized meeting scope", async () => {
  const filter = encodeURIComponent(JSON.stringify({
    keywords: ["LANDMARKS 2"],
    borough: "Manhattan",
    dateWindow: "month",
  }));
  const response = await handleFollowing(new Request(
    `https://cityscroll.org/following?lens=meetings&filter=${filter}&freq=weekly&count=17`,
  ), {}, {}, { todayISO: FIXTURE_TODAY });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("cache-control") || "", /public/);
  assert.match(response.headers.get("content-security-policy") || "", /style-src[^;]+https:\/\/cityscroll\.org/);
  assert.match(response.headers.get("content-security-policy") || "", /font-src https:\/\/fonts\.gstatic\.com/);
  assert.match(html, /rel="stylesheet" href="https:\/\/cityscroll\.org\/brand\.css"/);
  assert.match(html, /rel="stylesheet" href="https:\/\/cityscroll\.org\/civic-documents\.css"/);
  assert.match(html, /data-scope-count="17"/);
  assert.match(html, /data-preview-id="meeting:community_board:/);
  assert.match(html, /LANDMARKS 2/);
  assert.match(html, /name="lens"[^>]+value="meetings"/);
  assert.match(html, /name="freq"[^>]+value="weekly"/);
});

test("the edge Following renderer previews district-scoped zoning hearings", async () => {
  const filter = { councilDistrict: "33", futureAction: "hearing" };
  const response = await handleFollowing(new Request(
    `https://cityscroll.org/following?lens=land&filter=${encodeURIComponent(JSON.stringify(filter))}`,
  ), { ALERT_STATE: { get: async () => JSON.stringify({
    schema_version: 2,
    generated_at: "2026-09-01T00:00:00.000Z",
    hearings: [FIXTURE_HEARING],
  }) } }, {}, {
    todayISO: "2026-09-01",
    fetchImpl: async () => new Response("unexpected", { status: 500 }),
  });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Known Rezoning/);
  assert.match(html, /Zoning hearing/);
  assert.match(html, /2026-09-15/);
  assert.match(html, /councilDistrict/);
});

test("the edge Following renderer preserves typed route facets in the watch form", async () => {
  const filter = encodeURIComponent(JSON.stringify({
    agency: "Housing Preservation and Development",
    noticeType: "award",
    entity_refs_all: ["agency:id:housing-preservation-and-development"],
    connection_relation: "published_by_agency",
  }));
  const response = await handleFollowing(new Request(
    `https://cityscroll.org/following?lens=money&filter=${filter}`,
  ), {}, {}, { fetchImpl: previewFetch, todayISO: FIXTURE_TODAY });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /entity_refs_all/);
  assert.match(html, /housing-preservation-and-development/);
  assert.match(html, /connection_relation/);
  assert.match(html, /published_by_agency/);
});

test("shared API-host Following documents permanently recover to the canonical host", async () => {
  const response = await handleFollowing(new Request(
    "https://api.cityscroll.org/following?lens=meetings&freq=weekly",
  ));

  assert.equal(response.status, 301);
  assert.equal(
    response.headers.get("location"),
    "https://cityscroll.org/following?lens=meetings&freq=weekly",
  );
});

test("legacy obligations lens redirects to canonical mandates on Following", async () => {
  const filter = encodeURIComponent(JSON.stringify({
    agency_id: "parks-and-recreation",
    agency: "Parks and Recreation",
  }));
  const response = await handleFollowing(new Request(
    `https://cityscroll.org/following?lens=obligations&filter=${filter}&freq=weekly`,
  ), {}, {}, { fetchImpl: previewFetch });

  assert.equal(response.status, 302);
  const location = response.headers.get("location") || "";
  assert.match(location, /lens=mandates/);
  assert.doesNotMatch(location, /lens=obligations/);
  assert.match(location, /freq=weekly/);
});

test("the personal island endpoint stays anonymous without a recognized session", async () => {
  const response = await handleFollowing(new Request(
    "https://api.cityscroll.org/following/personal",
  ), {}, {}, { fetchImpl: previewFetch });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  assert.match(html, /data-session-recognized="false"/);
  assert.match(html, /data-personal-state="unrecognized"/);
  assert.match(html, /Open a CityScroll email to see your watches/);
  assert.match(html, /data-following-create-recovery/);
  assert.doesNotMatch(html, /href="[^"]*prefs/);
  assert.doesNotMatch(html, /data-watch-key=/);
});

test("the recognized-session island stays empty without inventing a watch", async () => {
  const store = kv();
  const token = await signToken(SIGNING_FIXTURE, sessionPayload(TEST_EMAIL), { ttlSeconds: 3600 });
  const response = await handleFollowing(new Request(
    "https://api.cityscroll.org/following/personal",
    { headers: { Cookie: `cs_session=${token}`, Origin: "https://cityscroll.org" } },
  ), { TOKEN_SECRET: SIGNING_FIXTURE, SUBS: store });
  const html = await response.text();

  assert.match(html, /data-session-recognized="true"/);
  assert.match(html, /data-personal-state="empty"/);
  assert.match(html, /No saved watches yet/);
  assert.match(html, /data-following-create-recovery/);
  assert.doesNotMatch(html, /data-watch-key=/);
  assert.doesNotMatch(html, /name="action"/);
});

test("the recognized-session island shows a concise watch summary and management controls", async () => {
  const store = kv();
  await store.put("sub:meetings-queens", JSON.stringify({
    email: TEST_EMAIL,
    lens: "meetings",
    filter: { agency: "Transportation", borough: "Queens" },
    freq: "weekly",
    createdAt: "2026-08-01T12:00:00.000Z",
  }));
  const token = await signToken(SIGNING_FIXTURE, sessionPayload(TEST_EMAIL), { ttlSeconds: 3600 });
  const response = await handleFollowing(new Request(
    "https://api.cityscroll.org/following/personal",
    { headers: { Cookie: `cs_session=${token}`, Origin: "https://cityscroll.org" } },
  ), { TOKEN_SECRET: SIGNING_FIXTURE, SUBS: store });
  const html = await response.text();

  assert.match(html, /data-watch-key="sub:meetings-queens"/);
  assert.match(html, /data-session-recognized="true"/);
  assert.match(html, /data-personal-state="recognized"/);
  assert.match(html, /data-watch-lens="meetings"/);
  assert.match(html, /Transportation/);
  assert.match(html, /Active · (Daily when there are matches|Weekly digest)/);
  assert.match(html, /name="freq"/);
  assert.match(html, /name="action" value="update"/);
  assert.match(html, /name="action" value="pause"/);
  assert.match(html, /name="action" value="delete"/);
  assert.match(html, /action="https:\/\/cityscroll\.org\/prefs"/);
  assert.match(html, /<h3>Notify me when new hearings and meetings/);
  assert.match(html, /See current matches/);
  assert.match(html, /name="token" value="[^"]+"/);
  assert.doesNotMatch(html, /href="[^"]*prefs\?token=/);
  assert.doesNotMatch(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a no-JavaScript form subscribes immediately and reaches management from the welcome", async () => {
  const originalFetch = globalThis.fetch;
  let welcomeEmail = null;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "https://api.resend.com/emails") {
      welcomeEmail = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: "mail-1" }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const env = {
    TOKEN_SECRET: SIGNING_FIXTURE,
    RESEND_API_KEY: "test-resend-key",
    SUBS: kv(),
    CONFIRM_BASE: "https://api.cityscroll.org",
  };
  try {
    const form = new URLSearchParams({
      email: TEST_EMAIL,
      lens: "meetings",
      filter: JSON.stringify({ agency: "Transportation", borough: "Queens" }),
      freq: "weekly",
      lang: "en",
    });
    const submitted = await handleSubscribe(new Request("https://api.cityscroll.org/subscribe", {
      method: "POST",
      headers: {
        Origin: "https://cityscroll.org",
        Accept: "text/html",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form,
    }), env);
    const submittedHtml = await submitted.text();
    assert.equal(submitted.status, 200);
    assert.match(submitted.headers.get("content-type") || "", /text\/html/);
    assert.match(submittedHtml, /You're subscribed/);

    const manageUrl = welcomeEmail?.html.match(/https:\/\/cityscroll\.org\/prefs\?[^"<]+/)?.[0].replaceAll("&amp;", "&");
    assert.ok(manageUrl, "welcome email links to watch management");
    assert.match(welcomeEmail.headers["List-Unsubscribe"], /\/unsubscribe\?token=/);

    const managed = await handlePrefs(new Request(manageUrl), env);
    const managedHtml = await managed.text();
    assert.equal(managed.status, 200);
    assert.match(managedHtml, /Save/);
    assert.match(managedHtml, /Delete watch/);
    assert.match(managedHtml, /Unsubscribe all watches/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the Following handler does not claim Stats or API routes", async () => {
  for (const pathname of ["/stats", "/stats.html", "/api", "/mcp"]) {
    const response = await handleFollowing(new Request(`https://api.cityscroll.org${pathname}`));
    assert.equal(response.status, 404);
  }
});

test("a meetings watch for M/WBE previews the Council-native fixture from search text", async () => {
  const filter = encodeURIComponent(JSON.stringify({ keywords: ["M/WBE"] }));
  const response = await handleFollowing(new Request(
    `https://cityscroll.org/following?lens=meetings&filter=${filter}&freq=weekly`,
  ), {}, {}, { todayISO: PINNED_TODAY });
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, new RegExp(`data-preview-id="${FIXTURE_MEETING_ID}"`));
  assert.match(html, /Committee on Contracts/);
  assert.match(html, /name="lens"[^>]+value="meetings"/);
});

test("a meetings watch for disparity study previews the same Council-native fixture", async () => {
  const filter = encodeURIComponent(JSON.stringify({ keywords: ["disparity study"] }));
  const response = await handleFollowing(new Request(
    `https://cityscroll.org/following?lens=meetings&filter=${filter}`,
  ), {}, {}, { todayISO: PINNED_TODAY });
  const html = await response.text();
  assert.match(html, new RegExp(`data-preview-id="${FIXTURE_MEETING_ID}"`));
});

test("Council-native digest links the canonical meeting route and names NYC Council Legistar", () => {
  const row = compileSub({ lens: "meetings", filter: { keywords: ["M/WBE"] } }, PINNED_TODAY).readRows()[0];
  assert.equal(row.meeting_id, FIXTURE_MEETING_ID);
  assert.equal(row.request_id, FIXTURE_MEETING_ID);
  const html = subDigestHtml(
    "Meetings — about “M/WBE”",
    "meetings",
    [row],
    "https://example.test/unsubscribe",
    PINNED_TODAY,
  );
  assert.match(html, /\/meetings\/meeting%3Anyc_legistar_events%3A22691\//);
  assert.match(html, /NYC Council Legistar/);
  assert.match(html, /https:\/\/nyc\.legistar\.com\/MeetingDetail\.aspx\?LEGID=22691/);
  assert.doesNotMatch(html, /Join online|Dial-in|City Record/);
});

test("a later exact City Record join does not create a second meeting notification", () => {
  const legistar = compileSub({ lens: "meetings", filter: { keywords: ["M/WBE"] } }, PINNED_TODAY).readRows()[0];
  const sameProceeding = {
    meeting_ids: ["meeting:city_record:20260923001", FIXTURE_MEETING_ID],
    nyc_legistar_events_meeting_id: FIXTURE_MEETING_ID,
    city_record_meeting_id: "meeting:city_record:20260923001",
  };
  const cluster = [
    { ...legistar, collection_visibility: "suppressed", same_proceeding: sameProceeding },
    {
      meeting_id: "meeting:city_record:20260923001",
      source_system: "city_record",
      title: "Committee on Contracts meeting — M/WBE Utilization and the Required Disparity Study",
      event_date: "2026-09-23T10:00:00",
      venue: { address: "250 Broadway - 8th Floor - Hearing Room 2" },
      collection_visibility: "visible",
      same_proceeding: sameProceeding,
      source_url: "https://a856-cityrecord.nyc.gov/RequestDetail/20260923001",
    },
  ];
  const collapsed = collapseMeetingDeliveryRows(cluster);
  assert.equal(collapsed.length, 1);
  assert.equal(meetingDeliveryKey(collapsed[0]), FIXTURE_MEETING_ID);
  assert.ok(officialMeetingSourceActions(cluster).some((action) => action.label === "NYC Council Legistar"));

  const first = reconcileMeetingDelivery({ rows: collapsed.map((row) => ({ ...row, meeting_id: FIXTURE_MEETING_ID, same_proceeding: null })), seen: new Set() });
  assert.equal(first.fresh.length, 1);
  const afterJoin = reconcileMeetingDelivery({ rows: collapsed, seen: new Set(first.markSeenIds) });
  assert.equal(afterJoin.fresh.length, 0);

  const html = subDigestHtml("Meetings", "meetings", collapsed, "https://example.test/unsubscribe", PINNED_TODAY);
  assert.match(html, /NYC Council Legistar/);
  assert.match(html, /https:\/\/nyc\.legistar\.com\/MeetingDetail\.aspx\?LEGID=22691/);
});

test("meeting watch compilation succeeds without a City Record request_id", () => {
  const rows = compileSub({ lens: "meetings", filter: { keywords: ["disparity study"] } }, PINNED_TODAY).readRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].meeting_id, FIXTURE_MEETING_ID);
  assert.equal(rows[0].request_id, FIXTURE_MEETING_ID);
  assert.equal(rows[0].event_id, FIXTURE_EVENT_ID);
  assert.equal(rows[0].source_system, "nyc_legistar_events");
});

test("meeting delivery temporal fixtures cover replay, join, reschedule, cancellation, and an unmatched near-candidate", async () => {
  const identity = {
    meeting_id: FIXTURE_MEETING_ID,
    source_system: "nyc_legistar_events",
    event_date: "2026-09-23T10:00:00",
  };
  const first = reconcileMeetingDelivery({ rows: [identity], seen: new Set() });
  assert.equal(first.fresh.length, 1);
  assert.equal(reconcileMeetingDelivery({ rows: [identity], seen: new Set(first.markSeenIds) }).fresh.length, 0);

  const joined = {
    meeting_id: "meeting:city_record:20260923001",
    source_system: "city_record",
    event_date: "2026-09-23T10:00:00",
    same_proceeding: {
      meeting_ids: ["meeting:city_record:20260923001", FIXTURE_MEETING_ID],
      nyc_legistar_events_meeting_id: FIXTURE_MEETING_ID,
      city_record_meeting_id: "meeting:city_record:20260923001",
    },
  };
  assert.equal(reconcileMeetingDelivery({ rows: [joined], seen: new Set(first.markSeenIds) }).fresh.length, 0);
  assert.equal(reconcileMeetingDelivery({
    rows: [{ ...identity, lifecycle: "rescheduled", event_date: "2026-09-24T11:00:00" }],
    seen: new Set(first.markSeenIds),
  }).fresh.length, 1);
  assert.equal(reconcileMeetingDelivery({
    rows: [{ ...identity, lifecycle: "cancelled" }],
    seen: new Set(first.markSeenIds),
  }).fresh.length, 1);
  assert.deepEqual(
    reconcileMeetingDelivery({
      rows: [joined, {
        meeting_id: "meeting:city_record:20260923002",
        source_system: "city_record",
        event_date: "2026-09-23T10:00:00",
      }],
      seen: new Set(first.markSeenIds),
    }).fresh.map((row) => row.meeting_id),
    ["meeting:city_record:20260923002"],
  );

  const compiled = compileSub({ lens: "meetings", filter: { keywords: ["M/WBE"] } }, PINNED_TODAY);
  assert.equal(compiled.idField, "meeting_id");
  assert.equal(compiled.url, null);
  const reconciled = reconcileMeetingDelivery({ rows: compiled.readRows(), seen: new Set() });
  assert.equal(reconciled.fresh[0].meeting_id, FIXTURE_MEETING_ID);
});
