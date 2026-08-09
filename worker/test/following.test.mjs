import assert from "node:assert/strict";
import test from "node:test";

import { handleFollowing } from "../src/following.mjs";
import { handleSubscribe } from "../src/subscribe.mjs";
import { handleConfirm } from "../src/confirm.mjs";
import { handlePrefs } from "../src/prefs.mjs";
import { signToken } from "optin-token";
import { sessionPayload } from "../src/lib/session.mjs";

const SIGNING_FIXTURE = "example-token-placeholder";
const TEST_EMAIL = ["reader", "example.com"].join("@");

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
      event_date: "2026-08-12T18:00:00.000",
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
  assert.match(html, /Pick a topic or place to see matches\./);
  assert.match(html, /data-personal-watch-list/);
});

test("the edge Following renderer previews the same saved scope and preserves the source-list count", async () => {
  const filter = encodeURIComponent(JSON.stringify({
    keywords: ["curb"],
    agency: "Transportation",
    borough: "Queens",
    dateWindow: "month",
  }));
  const response = await handleFollowing(new Request(
    `https://cityscroll.org/following?lens=meetings&filter=${filter}&freq=weekly&count=17`,
  ), {}, {}, { fetchImpl: previewFetch });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/html/);
  assert.match(response.headers.get("cache-control") || "", /public/);
  assert.match(response.headers.get("content-security-policy") || "", /style-src[^;]+https:\/\/cityscroll\.org/);
  assert.match(response.headers.get("content-security-policy") || "", /font-src https:\/\/fonts\.gstatic\.com/);
  assert.match(html, /rel="stylesheet" href="https:\/\/cityscroll\.org\/brand\.css"/);
  assert.match(html, /rel="stylesheet" href="https:\/\/cityscroll\.org\/civic-documents\.css"/);
  assert.match(html, /data-scope-count="17"/);
  assert.match(html, /data-preview-id="20260805001"/);
  assert.match(html, /Queens curb redesign hearing/);
  assert.match(html, /name="lens"[^>]+value="meetings"/);
  assert.match(html, /name="freq"[^>]+value="weekly"/);
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
  ), {}, {}, { fetchImpl: previewFetch });
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

test("the recognized-session island renders inline cadence, pause, and unsubscribe controls", async () => {
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
  assert.match(html, /name="freq"/);
  assert.match(html, /name="action" value="update"/);
  assert.match(html, /name="action" value="pause"/);
  assert.match(html, /name="action" value="delete"/);
  assert.match(html, /action="https:\/\/cityscroll\.org\/prefs"/);
  assert.match(html, /name="token" value="[^"]+"/);
  assert.doesNotMatch(html, /href="[^"]*prefs\?token=/);
  assert.doesNotMatch(html, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a no-JavaScript form can submit, confirm, then reach management and unsubscribe controls", async () => {
  const originalFetch = globalThis.fetch;
  let confirmationEmail = null;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url) === "https://api.resend.com/emails") {
      confirmationEmail = JSON.parse(options.body);
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
    assert.match(submittedHtml, /Check your inbox/);

    const confirmUrl = confirmationEmail?.html.match(/https:\/\/api\.cityscroll\.org\/confirm\?[^"<]+/)?.[0].replaceAll("&amp;", "&");
    assert.ok(confirmUrl, "confirmation email exposes its purpose-scoped link");
    const confirmed = await handleConfirm(new Request(confirmUrl), env);
    const confirmedHtml = await confirmed.text();
    assert.equal(confirmed.status, 200);
    const manageUrl = confirmedHtml.match(/https:\/\/cityscroll\.org\/prefs\?[^"<]+/)?.[0].replaceAll("&amp;", "&");
    assert.ok(manageUrl, "confirmation landing links to watch management");

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
