import assert from "node:assert/strict";
import test from "node:test";

import { handleFollowing } from "../src/following.mjs";
import { handleSubscribe } from "../src/subscribe.mjs";
import { handlePrefs } from "../src/prefs.mjs";
import { signToken } from "optin-token";
import { sessionPayload } from "../src/lib/session.mjs";

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

test("the edge Following renderer keeps the create-first empty state on a fresh visit", async () => {
  const response = await handleFollowing(new Request("https://cityscroll.org/following/"));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /data-following-preview-form/);
  assert.match(html, /data-following-subscribe-panel/);
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
  assert.match(html, /Open a CityScroll email to see your watches/);
  assert.doesNotMatch(html, /href="[^"]*prefs/);
  assert.doesNotMatch(html, /data-watch-key=/);
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
