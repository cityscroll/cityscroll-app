/**
 * Search activity inside the ordinary Product Activity desk journey (SAH-02).
 *
 * Every specimen here is a real receipt written by the SAH-01 intake, so these
 * tests exercise the same objects an operator would be reading in production.
 * The central claim under test is historical: what Product Activity shows is what
 * the reader saw when the search ran, not what the query would return today.
 *
 * verify: node --test worker/test/search_activity_desk.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { signToken } from "optin-token";

import {
  SEARCH_ACTIVITY_FAMILIES,
  SEARCH_EXECUTION_RECEIPT_SCHEMA,
} from "../../capabilities/search_activity.mjs";
import { handleAdminSearchActivity, handleAdminStats } from "../src/admin.mjs";
import { handleSearchActivity } from "../src/search_activity.mjs";
import { SEARCH_ACTIVITY_KEY_PREFIX, VISITOR_COOKIE_NAME } from "../src/lib/search_activity.mjs";
import { SEARCH_ACTIVITY_FILTER_KEYS } from "../src/lib/search_activity_view.mjs";
import { deriveSubscriberId } from "../src/lib/subscriptions.mjs";
import { sessionPayload } from "../src/lib/session.mjs";

const INTAKE_URL = "https://api.cityscroll.org/search-activity";
const ORIGIN = "https://cityscroll.org";
const ADMIN_KEY = "admin-secret";
const TOKEN_SECRET = "token-secret-for-session-cookies-0123456789";
const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const NOW = "2026-09-01T18:00:00Z";

function kv() {
  const store = new Map();
  return {
    store,
    get: async (key) => (store.has(key) ? store.get(key) : null),
    put: async (key, value) => { store.set(key, value); },
    list: async ({ prefix = "", limit = 1000 } = {}) => {
      const keys = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      return { keys: keys.slice(0, limit).map((name) => ({ name })), list_complete: keys.length <= limit };
    },
  };
}

function deskEnv(overrides = {}) {
  return {
    ANALYTICS_ENVIRONMENT: "production",
    ADMIN_KEY,
    TOKEN_SECRET,
    ALERT_STATE: kv(),
    ...overrides,
  };
}

/** The `rats` specimen: one Contract and one Meeting, exactly as rendered. */
function ratsSubmission(overrides = {}) {
  return {
    schema: SEARCH_EXECUTION_RECEIPT_SCHEMA,
    occurred_at: "2026-09-01T12:00:00.000Z",
    query: { raw: "rats", normalized: "rats" },
    search_path: "/search/",
    scope: {},
    outcome: "matched",
    rendered_count: 2,
    family_counts: { contracts: 1, meetings: 1 },
    incomplete_families: [],
    results: [
      {
        reference: "procurement:rats-abatement-2026",
        entity_type: "procurement",
        family: "contracts",
        kind: "keyword",
        rank: 1,
        title: "Rodent (rats) abatement services",
        canonical_href: "/contracts/rats-abatement-2026",
      },
      {
        reference: "meeting:cb3-rats-hearing",
        entity_type: "meeting",
        family: "meetings",
        kind: "keyword",
        rank: 2,
        title: "Public hearing on rats and refuse",
        canonical_href: "/meetings/cb3-rats-hearing",
      },
    ],
    producers: { search_method: "keyword", search_schema: "cityscroll.keyword_search_response.v1" },
    ...overrides,
  };
}

const CB3_SUBMISSION = ratsSubmission({
  occurred_at: "2026-09-01T12:05:00.000Z",
  query: { raw: "CB3", normalized: "cb3" },
  outcome: "matched",
  rendered_count: 1,
  family_counts: { meetings: 1 },
  results: [{
    reference: "committee:manhattan-cb3",
    entity_type: "committee",
    family: "meetings",
    kind: "keyword",
    rank: 1,
    title: "Manhattan Community Board 3",
    canonical_href: "/community-boards/manhattan-cb3",
  }],
});

const EMPTY_SUBMISSION = ratsSubmission({
  occurred_at: "2026-09-01T12:10:00.000Z",
  query: { raw: "zzzz nothing here", normalized: "zzzz nothing here" },
  outcome: "empty",
  rendered_count: 0,
  family_counts: {},
  results: [],
});

const PARTIAL_SUBMISSION = ratsSubmission({
  occurred_at: "2026-09-01T12:15:00.000Z",
  query: { raw: "sidewalk shed", normalized: "sidewalk shed" },
  outcome: "partial",
  rendered_count: 1,
  family_counts: { contracts: 1 },
  incomplete_families: ["land", "meetings"],
  results: [{
    reference: "procurement:sidewalk-shed-inspection",
    entity_type: "procurement",
    family: "contracts",
    kind: "keyword",
    rank: 1,
    title: "Sidewalk shed inspection services",
    canonical_href: "/contracts/sidewalk-shed-inspection",
  }],
});

function intake(body, headers = {}) {
  return new Request(INTAKE_URL, {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json", "User-Agent": CHROME_UA, ...headers },
    body: JSON.stringify(body),
  });
}

function visitorCookieFrom(response) {
  const values = response.headers.getSetCookie?.() || [response.headers.get("set-cookie")].filter(Boolean);
  const header = values.find((value) => value.startsWith(`${VISITOR_COOKIE_NAME}=`));
  return header ? header.slice(`${VISITOR_COOKIE_NAME}=`.length).split(";")[0] : null;
}

async function record(env, body, headers = {}) {
  const response = await handleSearchActivity(intake(body, headers), env);
  assert.equal(response.status, 202, "the specimen must be an accepted receipt");
  return response;
}

/** The ordinary operator journey: authenticated Product Activity, rendered. */
async function productActivity(env, query = "") {
  const response = await handleAdminStats(
    new Request(`https://api.cityscroll.org/admin/stats?key=${ADMIN_KEY}&view=html${query}`),
    env,
    { now: NOW },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  return response.text();
}

async function readModel(env, query = "") {
  const response = await handleAdminSearchActivity(
    new Request(`https://api.cityscroll.org/admin/search-activity?key=${ADMIN_KEY}${query}`),
    env,
  );
  return { status: response.status, body: await response.json() };
}

/** Populate the store with the five commissioned specimens. */
async function seedSpecimens(env) {
  await record(env, ratsSubmission());
  await record(env, CB3_SUBMISSION);
  await record(env, EMPTY_SUBMISSION);
  await record(env, PARTIAL_SUBMISSION);
}

// ---- A1: the execution appears in the ordinary journey ----

test("a retained rats execution appears inside Product Activity with its stored facts", async () => {
  const env = deskEnv();
  await seedSpecimens(env);
  const html = await productActivity(env);

  assert.match(html, /<h1>Product activity<\/h1>/, "still the existing desk page");
  assert.match(html, /id="search-activity-heading">Search activity</, "a section, not a second dashboard");

  assert.match(html, /<h3>rats<\/h3>/, "the raw query the reader submitted");
  assert.match(html, /9\/1\/2026, 12:00:00\u202fPM UTC|9\/1\/2026, 12:00:00 PM UTC/, "the execution timestamp");
  assert.match(html, /All retained searches from this browser/, "a route into this browser's other executions");
  assert.match(html, />Matched</, "the stored terminal state");
  assert.match(html, /2 rows/, "the stored rendered count");
  assert.match(html, /All families complete/, "coverage state");
  assert.match(html, /Anonymous browser/, "recognition state");
  assert.match(html, /chrome 141 · macos · desktop/, "browser and device summary");

  const { body } = await readModel(env);
  const rats = body.items.find((item) => item.query.raw === "rats");
  assert.ok(html.includes(rats.visitor_id), "the visitor identity is shown, not just counted");
  assert.ok(html.includes(rats.execution_id), "the execution identity is shown");
});

// ---- A2: the stored result list, never a rerun ----

test("expanding the rats execution shows the Contract and Meeting stored at execution time", async () => {
  const env = deskEnv();
  await record(env, ratsSubmission());
  const html = await productActivity(env);

  const section = html.slice(html.indexOf("search-activity-panel"));
  assert.match(section, /<details class="results"><summary>2 stored results as rendered<\/summary>/);

  for (const [rank, family, title, reference, href] of [
    ["1", "contracts", "Rodent (rats) abatement services", "procurement:rats-abatement-2026", "/contracts/rats-abatement-2026"],
    ["2", "meetings", "Public hearing on rats and refuse", "meeting:cb3-rats-hearing", "/meetings/cb3-rats-hearing"],
  ]) {
    assert.match(section, new RegExp(`<th scope="row">${rank}</th><td>${family}</td>`), `rank ${rank} keeps its family`);
    assert.ok(section.includes(title), `stored title ${title}`);
    assert.ok(section.includes(reference), `stable reference ${reference}`);
    assert.ok(section.includes(`https://cityscroll.org${href}`), `canonical link ${href}`);
  }
});

test("Product Activity paints a receipt whose rows no live query could return", async () => {
  const env = deskEnv();
  // A row that exists only in the receipt. If the desk re-ran the query, this
  // could not appear; because it renders, the page is reading history.
  await record(env, ratsSubmission({
    occurred_at: "2026-09-01T09:00:00.000Z",
    query: { raw: "rats", normalized: "rats" },
    rendered_count: 1,
    family_counts: { contracts: 1 },
    results: [{
      reference: "procurement:withdrawn-since-execution",
      entity_type: "procurement",
      family: "contracts",
      kind: "keyword",
      rank: 1,
      title: "Award withdrawn after this search ran",
      canonical_href: "/contracts/withdrawn-since-execution",
    }],
  }));

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Product Activity must not run a search"); };
  try {
    const html = await productActivity(env);
    assert.ok(html.includes("Award withdrawn after this search ran"));
    assert.ok(html.includes("procurement:withdrawn-since-execution"));
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- A3: identity continuity, and partial vs empty ----

test("visitor filtering connects every retained execution from one browser", async () => {
  const env = deskEnv();
  const first = await record(env, ratsSubmission());
  const visitorId = visitorCookieFrom(first);
  assert.ok(visitorId);
  const cookie = { Cookie: `${VISITOR_COOKIE_NAME}=${visitorId}` };
  await record(env, CB3_SUBMISSION, cookie);
  // A different browser's execution must not be pulled into the same story.
  await record(env, EMPTY_SUBMISSION);

  const html = await productActivity(env, `&visitor=${encodeURIComponent(visitorId)}`);
  assert.ok(html.includes("<h3>rats</h3>"));
  assert.ok(html.includes("<h3>CB3</h3>"));
  assert.ok(!html.includes("zzzz nothing here"), "another browser's search stays out");

  const { body } = await readModel(env, `&visitor=${encodeURIComponent(visitorId)}`);
  assert.equal(body.count, 2);
  assert.equal(body.scan_complete, true, "the filtered read reached the end of retention");
  assert.deepEqual(body.items.map((item) => item.visitor_id), [visitorId, visitorId]);
});

test("a later recognized receipt shows both identities without rewriting the earlier anonymous one", async () => {
  const env = deskEnv();
  const first = await record(env, ratsSubmission());
  const visitorId = visitorCookieFrom(first);

  const email = "resident@example.org";
  const sessionToken = await signToken(TOKEN_SECRET, sessionPayload(email), { ttlSeconds: 3600 });
  await record(env, CB3_SUBMISSION, {
    Cookie: `${VISITOR_COOKIE_NAME}=${visitorId}; cs_session=${sessionToken}`,
  });

  const { body } = await readModel(env, `&visitor=${encodeURIComponent(visitorId)}`);
  assert.equal(body.count, 2);
  const anonymous = body.items.find((item) => item.query.raw === "rats");
  const recognized = body.items.find((item) => item.query.raw === "CB3");
  assert.equal(anonymous.recognition, "anonymous");
  assert.equal(anonymous.subscriber_id, null, "an earlier receipt is never back-filled with an account");
  assert.equal(anonymous.account_label, null);
  assert.equal(recognized.recognition, "recognized");
  assert.equal(recognized.subscriber_id, await deriveSubscriberId(email));
  assert.equal(recognized.account_label, "r…@example.org");
  assert.equal(recognized.visitor_id, visitorId, "one browser, two identity states");

  const html = await productActivity(env, `&visitor=${encodeURIComponent(visitorId)}`);
  assert.ok(html.includes("Anonymous browser"), "the earlier execution still reads anonymous");
  assert.ok(html.includes("Recognized · r…@example.org"), "the later one carries the redacted label");
  assert.ok(html.includes(recognized.subscriber_id), "and the separate subscriber identity");
  assert.ok(!html.includes(email), "the raw address never reaches the page");

  const subscriberOnly = await readModel(env, `&subscriber=${encodeURIComponent(recognized.subscriber_id)}`);
  assert.equal(subscriberOnly.body.count, 1, "subscriber filtering never claims the anonymous receipt");
});

test("partial coverage stays distinguishable from an honest zero-result search", async () => {
  const env = deskEnv();
  await seedSpecimens(env);
  const html = await productActivity(env);

  assert.match(html, />Partial coverage</);
  assert.match(html, /Incomplete: land, meetings/);
  assert.match(html, />No results</);
  assert.match(html, /Complete coverage, zero results/);

  const partial = await readModel(env, "&outcome=partial");
  assert.equal(partial.body.count, 1);
  assert.deepEqual(partial.body.items[0].incomplete_families, ["land", "meetings"]);
  const empty = await readModel(env, "&outcome=empty");
  assert.equal(empty.body.count, 1);
  assert.deepEqual(empty.body.items[0].incomplete_families, []);
  assert.equal(empty.body.items[0].rendered_count, 0);

  // The four terminal states stay four distinct states.
  await record(env, ratsSubmission({
    occurred_at: "2026-09-01T12:20:00.000Z",
    outcome: "unavailable",
    rendered_count: 0,
    family_counts: {},
    results: [],
    incomplete_families: [...SEARCH_ACTIVITY_FAMILIES],
  }));
  const all = await readModel(env);
  assert.deepEqual(
    [...new Set(all.body.items.map((item) => item.outcome))].sort(),
    ["empty", "matched", "partial", "unavailable"],
  );
});

test("a family filter finds both rendered rows and recorded coverage gaps", async () => {
  const env = deskEnv();
  await seedSpecimens(env);

  const contracts = await readModel(env, "&family=contracts");
  assert.deepEqual(contracts.body.items.map((item) => item.query.raw).sort(), ["rats", "sidewalk shed"]);

  const land = await readModel(env, "&family=land");
  assert.deepEqual(land.body.items.map((item) => item.query.raw), ["sidewalk shed"],
    "the family a reader never saw is exactly the one to search for");
});

// ---- A4: Desk and JSON agree; only backed filters; fail closed ----

test("Desk and the authenticated JSON agree on execution and result identities", async () => {
  const env = deskEnv();
  await seedSpecimens(env);
  const html = await productActivity(env);
  const { body } = await readModel(env);
  assert.equal(body.count, 4);

  for (const item of body.items) {
    assert.ok(html.includes(item.execution_id), `execution ${item.execution_id}`);
    assert.ok(html.includes(item.visitor_id), "visitor identity");
    assert.ok(html.includes(item.query.raw), "raw query");
    assert.ok(html.includes(item.outcome === "empty" ? "No results" : item.outcome === "partial" ? "Partial coverage" : "Matched"));
    for (const row of item.results) {
      assert.ok(html.includes(row.reference), `reference ${row.reference}`);
      assert.ok(html.includes(row.title), `title ${row.title}`);
      assert.ok(html.includes(`https://cityscroll.org${row.canonical_href}`), `link ${row.canonical_href}`);
      assert.match(html, new RegExp(`<th scope="row">${row.rank}</th><td>${row.family}</td>`));
    }
  }
});

test("only filters backed by a retained field are offered, and an unknown one is refused", async () => {
  const env = deskEnv();
  await seedSpecimens(env);

  const html = await productActivity(env);
  const section = html.slice(html.indexOf("search-activity-filters"), html.indexOf("</form>"));
  for (const key of SEARCH_ACTIVITY_FILTER_KEYS) {
    assert.match(section, new RegExp(`name="${key}"`), `${key} is offered`);
  }
  const offered = [...section.matchAll(/ name="([a-z_]+)"/g)].map(([, name]) => name);
  assert.deepEqual(
    offered.filter((name) => !["key", "view"].includes(name)).sort(),
    [...SEARCH_ACTIVITY_FILTER_KEYS].sort(),
    "the form offers the closed vocabulary and nothing else",
  );

  const invented = await readModel(env, "&ip=203.0.113.7");
  assert.equal(invented.status, 400);
  assert.equal(invented.body.error, "unsupported-filter");
  assert.deepEqual(invented.body.unsupported_filters, ["ip"]);

  const badOutcome = await readModel(env, "&outcome=probably");
  assert.equal(badOutcome.status, 400, "a value outside the stored vocabulary is not silently empty");
  assert.deepEqual(badOutcome.body.invalid_filters, ["outcome"]);

  const deskRefusal = await productActivity(env, "&ip=203.0.113.7");
  assert.match(deskRefusal, /Unsupported filter: ip/);
  assert.ok(!deskRefusal.includes("<h3>rats</h3>"), "a refused filter shows nothing rather than everything");
});

test("both surfaces fail closed and stay private", async () => {
  const env = deskEnv();
  await seedSpecimens(env);

  for (const path of ["/admin/stats?view=html", "/admin/search-activity"]) {
    const unconfigured = path.startsWith("/admin/stats")
      ? await handleAdminStats(new Request(`https://api.cityscroll.org${path}`), { ALERT_STATE: env.ALERT_STATE }, { now: NOW })
      : await handleAdminSearchActivity(new Request(`https://api.cityscroll.org${path}`), { ALERT_STATE: env.ALERT_STATE });
    assert.equal(unconfigured.status, 404, `${path} hides itself until ADMIN_KEY is configured`);

    const wrongKey = path.startsWith("/admin/stats")
      ? await handleAdminStats(new Request(`https://api.cityscroll.org${path}&key=wrong`), env, { now: NOW })
      : await handleAdminSearchActivity(new Request(`https://api.cityscroll.org${path}?key=wrong`), env);
    assert.equal(wrongKey.status, 401, `${path} rejects a wrong key`);
    assert.ok(!(await wrongKey.text()).includes("rats"), "no receipt content leaks to an unauthenticated caller");
  }
});

test("the existing Product Activity summary and JSON body are unchanged", async () => {
  const env = deskEnv();
  await seedSpecimens(env);

  const html = await productActivity(env);
  for (const label of ["Accounts with watches", "Active watches", "Digests · 7 days", "Page views · 7 days",
    "Searches · 7 days", "Deep links · 7 days", "Exports · 7 days", "Watches confirmed · 7 days",
    "Delivery operations", "Daily activity", "Owed delivery backlog"]) {
    assert.ok(html.includes(label), `summary keeps ${label}`);
  }

  const jsonResponse = await handleAdminStats(
    new Request(`https://api.cityscroll.org/admin/stats?key=${ADMIN_KEY}`), env, { now: NOW },
  );
  const jsonText = await jsonResponse.text();
  assert.equal(jsonResponse.headers.get("content-type"), "application/json");
  assert.doesNotMatch(jsonText, /search_activity|execution_id|visitor_id/,
    "receipt detail stays on its own authenticated route, out of the stats body");
});

// ---- A5: an honest read — preserved read params, failures, truncation ----

test("applying a filter keeps the operator on the same receipt set: read params ride the form", async () => {
  const env = deskEnv();
  await seedSpecimens(env);

  const html = await productActivity(env, "&traffic_class=developer&limit=5");
  const form = html.slice(html.indexOf('<form class="search-activity-filters"'), html.indexOf("</form>"));
  assert.match(form, new RegExp(`<input type="hidden" name="key" value="${ADMIN_KEY}">`));
  assert.match(form, /<input type="hidden" name="view" value="html">/);
  assert.match(form, /<input type="hidden" name="limit" value="5">/);
  assert.match(form, /<input type="hidden" name="traffic_class" value="developer">/,
    "a developer cut never silently becomes a production cut on submit");

  const production = await productActivity(env);
  const productionForm = production.slice(production.indexOf('<form class="search-activity-filters"'), production.indexOf("</form>"));
  assert.ok(!productionForm.includes('name="traffic_class"'), "absent read params stay absent");
  assert.ok(!productionForm.includes('name="limit"'));
});

test("a receipt-store read failure reports read-failed, never a complete scan or missing config", async () => {
  const env = deskEnv();
  await seedSpecimens(env);
  const realGet = env.ALERT_STATE.get;
  env.ALERT_STATE.get = async (key) => {
    if (key.startsWith(SEARCH_ACTIVITY_KEY_PREFIX)) throw new Error("kv unavailable");
    return realGet(key);
  };

  const { status, body } = await readModel(env);
  assert.equal(status, 503);
  assert.equal(body.error, "read-failed");
  assert.equal(body.scan_complete, undefined, "a read that could not read claims no scan at all");

  const html = await productActivity(env);
  assert.match(html, /The receipt store could not be read\. This is a read failure, not a configuration problem — retry\./);
  assert.ok(!html.includes("until the receipt store is configured"),
    "a transient read failure is not dressed as missing configuration");
});

test("a corrupt stored receipt is skipped while the rest of the read stays honest", async () => {
  const env = deskEnv();
  await seedSpecimens(env);
  const [key] = [...env.ALERT_STATE.store.keys()];
  env.ALERT_STATE.store.set(key, "{not json");

  const { status, body } = await readModel(env);
  assert.equal(status, 200);
  assert.equal(body.count, 3, "the readable receipts still come back");
  assert.equal(body.scanned, 4, "the unreadable receipt still counts against the scan");
  assert.equal(body.scan_complete, true);
});

test("a filtered page that fills before the scan bound reports possible older matches", async () => {
  const env = deskEnv();
  await seedSpecimens(env);

  const { body } = await readModel(env, "&outcome=matched&limit=1");
  assert.equal(body.count, 1);
  assert.equal(body.scan_complete, false, "a filled page never claims the end of retention");
  assert.ok(body.scanned >= body.count && body.scanned <= 4);
});

test("the query filter matches the stored normalized query, not only the raw text", async () => {
  const env = deskEnv();
  await record(env, ratsSubmission({
    query: { raw: "colour of money", normalized: "color of money" },
  }));

  const viaNormalized = await readModel(env, `&query=${encodeURIComponent("color of")}`);
  assert.equal(viaNormalized.body.count, 1);
  const viaRaw = await readModel(env, `&query=${encodeURIComponent("colour")}`);
  assert.equal(viaRaw.body.count, 1);
});

// ---- escaping ----

test("receipt text and stored links are escaped before they reach an operator", async () => {
  const env = deskEnv();
  await record(env, ratsSubmission({
    query: { raw: 'rats <img src=x onerror="alert(1)">', normalized: "rats img" },
    rendered_count: 1,
    family_counts: { contracts: 1 },
    results: [{
      reference: 'procurement:"><script>alert(2)</script>',
      entity_type: "procurement",
      family: "contracts",
      kind: "keyword",
      rank: 1,
      title: "<script>alert(3)</script> & friends",
      canonical_href: "/contracts/quote-test",
    }],
  }));

  const html = await productActivity(env);
  assert.ok(!html.includes("<script>alert(3)</script>"), "no injected element survives");
  assert.ok(!html.includes('<img src=x'), "no injected attribute survives");
  assert.match(html, /rats &lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /&lt;script&gt;alert\(3\)&lt;\/script&gt; &amp; friends/);
  assert.match(html, /procurement:&quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});

test("a stored link outside the safe result roots renders as text, never as a link", async () => {
  const env = deskEnv();
  await record(env, ratsSubmission());
  const [key] = [...env.ALERT_STATE.store.keys()];
  const receipt = JSON.parse(env.ALERT_STATE.store.get(key));
  // Simulate a receipt written by a looser contract than today's intake accepts.
  receipt.results[0].canonical_href = "https://evil.example/steal";
  env.ALERT_STATE.store.set(key, JSON.stringify(receipt));

  const html = await productActivity(env);
  assert.ok(!html.includes("https://evil.example/steal"), "an unsafe stored URL is not rendered at all");
  assert.match(html, /No canonical link stored/);
});
