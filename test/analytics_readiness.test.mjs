import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { handleEvent } from "../worker/src/events.mjs";
import { handlePrivateStats, handleStats } from "../worker/src/stats.mjs";
import { primaryDocumentOutputs } from "../tools/build_primary_documents.mjs";
import {
  ANALYTICS_LENSES,
  ANALYTICS_SCENARIOS,
  ANALYTICS_DOCUMENT_CUTOVER,
  ANALYTICS_PRIMARY_DOCUMENT_SURFACES,
  COMPATIBLE_TAXONOMY_VERSIONS,
  TAXONOMY_VERSION,
  buildUsageSnapshot,
  normalizeUsageEvent,
  reconcileUsageWithDurableStores,
  usageAnalyticsQuery,
} from "../worker/src/lib/analytics.mjs";
import {
  ANALYTICS_COLLECTOR_SURFACES,
  resolveAnalyticsSurface,
} from "../site/analytics_surface_taxonomy.mjs";

const FIXTURE_NOW = new Date("2026-07-27T12:00:00Z");
const FIXTURE_DAY = FIXTURE_NOW.toISOString().slice(0, 10);

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    // Exposed so a test can assert which keys a request wrote, not only what it returned.
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

function analyticsBinding(points) {
  return { writeDataPoint(point) { points.push(point); } };
}

function rowFromPoint(point, day) {
  return {
    day,
    event: point.blobs[0],
    lens: point.blobs[1],
    detail: point.blobs[2],
    geography: point.blobs[3],
    surface: point.blobs[4],
    count: point.doubles[0],
  };
}

function developerToken(secret, nowMs) {
  const timestamp = Math.floor(nowMs / 1000);
  const signature = createHmac("sha256", secret)
    .update(`crol-analytics-dev-exclusion\n${timestamp}`)
    .digest("base64url");
  return `v1.${timestamp}.${signature}`;
}

async function emit(points, event, options = {}) {
  const headers = {
    Origin: "https://cityscroll.org",
    "Content-Type": "text/plain;charset=UTF-8",
  };
  if (options.developerToken) headers["X-CROL-Analytics-Dev"] = options.developerToken;
  const env = {
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ENVIRONMENT: options.environment ?? "production",
    ANALYTICS_DEV_KEY: options.secret,
    ALERT_STATE: options.alertState,
  };
  const response = await handleEvent(new Request("https://api.cityscroll.org/events", {
    method: "POST",
    headers,
    body: JSON.stringify(event),
  }), env, { nowMs: options.nowMs });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  return response;
}

/**
 * The producer's own surface answer for a pathname. `site/analytics.js` is a module now, so
 * the resolution it performs is exercised through the module both halves share rather than by
 * re-running the page script in a sandbox; the page script's use of it is asserted separately
 * below, by reading its source.
 */
function pageViewSurface(pathname) {
  return resolveAnalyticsSurface(pathname).surface;
}

test("event intake writes only bounded taxonomy dimensions", async () => {
  const points = [];
  await emit(points, {
    event: "search_run",
    lens: "land",
    detail: "filters",
    geography: "queens",
    surface: "home",
    raw_query: "this value must never be written",
    visitor_id: "also forbidden",
  });

  assert.equal(points.length, 1);
  // blob7 traffic_class defaults to production; developer traffic is excluded from AE writes.
  assert.deepEqual(points[0].blobs, ["search_run", "land", "filters", "queens", "home", TAXONOMY_VERSION, "production"]);
  assert.deepEqual(points[0].doubles, [1]);
  assert.deepEqual(points[0].indexes, ["search_run"]);
  assert.ok(!JSON.stringify(points[0]).includes("this value"));
  assert.ok(!JSON.stringify(points[0]).includes("forbidden"));
  assert.equal(normalizeUsageEvent({ event: "unknown", surface: "home" }), null);
  assert.equal(normalizeUsageEvent({
    event: "scenario_open",
    lens: "meetings",
    detail: "subsidies-land-use",
    surface: "home",
  })?.detail, "subsidies-land-use");
  assert.equal(normalizeUsageEvent({
    event: "scenario_open",
    lens: "meetings",
    detail: "property-lawyer",
    surface: "home",
  }), null, "scenario values stay a bounded declared-interest enumeration");
  assert.deepEqual(normalizeUsageEvent({
    event: "comparative_signal_shown",
    detail: "visible",
    surface: "worth-a-look",
    signal_id: "must-not-survive",
  }), {
    event: "comparative_signal_shown",
    lens: "none",
    detail: "visible",
    geography: "none",
    surface: "worth-a-look",
    traffic_class: "production",
    taxonomy_version: TAXONOMY_VERSION,
  });
  assert.equal(normalizeUsageEvent({
    event: "comparative_signal_shown",
    detail: "visible",
    surface: "home",
  }), null, "the denominator is scoped to the private pilot surface");
});

test("developer exclusion is authenticated, invisible, and fail-closed", async () => {
  const nowMs = Date.parse("2026-07-27T22:15:00Z");
  const secret = "test-only-analytics-developer-key-32-chars";
  const event = { event: "page_view", surface: "stats" };

  const excluded = [];
  await emit(excluded, event, {
    developerToken: developerToken(secret, nowMs),
    secret,
    nowMs,
  });
  assert.equal(excluded.length, 0, "a current valid HMAC token is excluded");

  const counted = [];
  await emit(counted, event, {
    developerToken: developerToken(`${secret}-wrong`, nowMs),
    secret,
    nowMs,
  });
  await emit(counted, event, { secret, nowMs });
  await emit(counted, event, {
    developerToken: developerToken(secret, nowMs - 6 * 60 * 1000),
    secret,
    nowMs,
  });
  assert.equal(counted.length, 3, "invalid, absent, and expired tokens count normally");

  const nonProduction = [];
  await emit(nonProduction, event, {
    environment: "preview",
    developerToken: developerToken(secret, nowMs),
    secret,
    nowMs,
  });
  assert.equal(nonProduction.length, 0, "non-production bindings drop events by default");
});

test("fixture event flows emit -> sampling-aware aggregate -> authenticated stats endpoint", async () => {
  // FIXTURE_DAY / FIXTURE_NOW pin the last7d window (main #375); do not use wall-clock today.
  const points = [];
  await emit(points, { event: "page_view", surface: "home" });
  await emit(points, { event: "page_view", surface: "stats" });
  await emit(points, { event: "search_run", lens: "land", detail: "filters", geography: "queens", surface: "home" });
  await emit(points, { event: "export", lens: "money", detail: "csv", surface: "home" });
  await emit(points, { event: "alert_confirmed", lens: "land", surface: "email" });
  await emit(points, { event: "scenario_open", lens: "meetings", detail: "hearings", surface: "home" });

  const rows = points.map((point) => rowFromPoint(point, FIXTURE_DAY));
  const env = {
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ACCOUNT_ID: "test-account",
    ANALYTICS_READ_TOKEN: "test-token",
    ANALYTICS_DATASET: "crol_usage_events_v1",
    ANALYTICS_MEASURED_SINCE: FIXTURE_DAY,
    ALERT_STATE: fakeKV(),
    NL_METER: fakeKV(),
    SUBS: fakeKV(),
  };
  const response = await handlePrivateStats(
    new Request("https://api.cityscroll.org/admin/stats"),
    env,
    {
      fetchImpl: async (_url, init) => {
        assert.match(init.body, /sum\(_sample_interval \* double1\)/);
        assert.equal(init.headers["Content-Type"], "text/plain");
        return Response.json({ data: rows });
      },
      now: FIXTURE_NOW,
    },
  );
  const body = await response.json();

  assert.equal(body.usage.available, true);
  assert.equal(body.usage.page_views.last7d, 2);
  assert.equal(body.usage.searches.last7d, 1);
  assert.equal(body.usage.exports.last7d, 1);
  assert.equal(body.usage.alerts.confirmed_last7d, 1);
  assert.equal(body.usage.geography_interest.last30d.queens, 1);
  assert.equal(body.usage.scenario_interest.last30d.hearings, 1);
  assert.deepEqual(Object.keys(body.usage.scenario_interest.last30d), ANALYTICS_SCENARIOS);
  assert.deepEqual(Object.keys(body.usage.lens_interest.last30d), ANALYTICS_LENSES);
  assert.equal(body.usage.lens_interest.last30d.meetings, 0);
  assert.equal(body.nl_search.by_category.meetings, 0, "previously omitted zero-count lens is pinned");
});

test("the route map decides a surface, and an unregistered route gets none", async () => {
  // Every one of these was reported as "home" before the taxonomy was shared: the platform
  // serves each .html document at its extensionless path, and the Search, data-health and
  // per-lane browse documents were never in the old filename table at all.
  const routes = {
    "/": "home",
    "/index.html": "home",
    "/now/": "now",
    "/near-you/": "near-you",
    "/near-you/borough/queens/": "near-you",
    "/following/": "following",
    "/browse/": "browse",
    "/browse/property/": "browse-property",
    "/browse/contracts/": "browse-contracts",
    "/search/": "search",
    "/data-health/": "data-health",
    "/stats": "stats",
    "/stats.html": "stats",
    "/about": "about",
    "/api": "api",
    "/data": "data",
    "/changelog": "changelog",
    "/standards": "standards",
    "/experimental/worth-a-look/": "worth-a-look",
    // The three worked paths the public Stats page teaches, and the mandate one of them ends on.
    "/notices/20231222103": "notice",
    "/notices/20260605008": "notice",
    "/mandates/64116-001": "mandate",
    "/browse/zoning/": "browse-zoning",
    "/agencies/homeless-services/": "agency",
    "/guide/start/trace-an-award-and-keep-the-trail/": "guide-article",
  };
  for (const [pathname, expected] of Object.entries(routes)) {
    assert.equal(pageViewSurface(pathname), expected, pathname);
  }

  // An unregistered route is an observability gap, not the homepage.
  for (const pathname of ["/not-a-route/", "/notices/", "/browse/nothing/", "/stats/extra"]) {
    assert.equal(pageViewSurface(pathname), null, pathname);
    assert.equal(resolveAnalyticsSurface(pathname).classification_state, "unclassified", pathname);
  }

  // The page script resolves through that module and refuses to send an event without a
  // surface; no literal fallback survives in its source.
  const producer = await readFile(new URL("../site/analytics.js", import.meta.url), "utf8");
  assert.match(producer, /import \{ resolveAnalyticsSurface \} from "\.\/analytics_surface_taxonomy\.mjs";/);
  assert.match(producer, /const PAGE_SURFACE = resolveAnalyticsSurface\(location\.pathname\)\.surface;/);
  assert.match(producer, /if \(!dimensions \|\| !dimensions\.surface\) return;/);
  assert.doesNotMatch(producer, /\|\| "home"/);
  assert.doesNotMatch(producer, /surface: "home"/);
  // A lens is a thing the reader chose; the producer no longer hands one out by default.
  assert.doesNotMatch(producer, /: "money";/);
});

test("the surface a producer can emit is exactly the surface the validator accepts", () => {
  for (const surface of ANALYTICS_COLLECTOR_SURFACES) {
    assert.ok(
      normalizeUsageEvent({ event: "page_view", surface }),
      `page_view from ${surface} must be accepted`,
    );
  }
  // A registered route whose document does not ship the collector is not an accepted page-view
  // dimension: nothing produces it, so nothing may report it.
  for (const surface of ["notice", "vendor", "mandate", "guide-article"]) {
    assert.ok(!ANALYTICS_COLLECTOR_SURFACES.includes(surface), `${surface} ships no collector`);
    assert.equal(normalizeUsageEvent({ event: "page_view", surface }), null, surface);
  }
  // Delivery surfaces belong to the events that are delivered, never to a page view.
  assert.equal(normalizeUsageEvent({ event: "page_view", surface: "email" }), null);
  assert.equal(normalizeUsageEvent({ event: "page_view", surface: "digest" }), null);
});

test("all primary documents load the aggregate collector", async () => {
  const built = Object.fromEntries(primaryDocumentOutputs().map(([path, html]) => [path, html]));
  for (const route of ["now", "browse"]) {
    const entry = Object.entries(built).find(([path]) => path.endsWith(`/site/${route}/index.html`));
    assert.ok(entry, `${route} build output exists`);
    assert.match(entry[1], /analytics\.js\?v=1\.4\.0/, route);
  }
  for (const route of ["near-you", "following"]) {
    const html = await readFile(new URL(`../site/${route}/index.html`, import.meta.url), "utf8");
    assert.match(html, /analytics\.js\?v=1\.4\.0/, route);
  }
});

test("primary-document attribution has a dated cutover and preserves old home rows without inventing a split", () => {
  assert.equal(ANALYTICS_DOCUMENT_CUTOVER, "2026-08-05");
  assert.deepEqual(ANALYTICS_PRIMARY_DOCUMENT_SURFACES, ["now", "near-you", "following", "browse"]);
  const snapshot = buildUsageSnapshot([
    { day: "2026-08-04", event: "page_view", surface: "home", count: 7 },
    { day: "2026-08-05", event: "page_view", surface: "home", count: 2 },
    { day: "2026-08-05", event: "page_view", surface: "now", count: 3 },
    { day: "2026-08-05", event: "page_view", surface: "near-you", count: 4 },
    { day: "2026-08-05", event: "page_view", surface: "following", count: 5 },
    { day: "2026-08-05", event: "page_view", surface: "browse", count: 6 },
  ], new Date("2026-08-05T12:00:00Z"));

  assert.equal(snapshot.page_views.by_surface_last30d.home, 9);
  assert.equal(snapshot.page_views.by_surface_last30d.now, 3);
  assert.equal(snapshot.page_views.by_surface_last30d["near-you"], 4);
  assert.equal(snapshot.page_views.by_surface_last30d.following, 5);
  assert.equal(snapshot.page_views.by_surface_last30d.browse, 6);
  assert.deepEqual(snapshot.page_views.pre_cutover_home, {
    label: "home (before primary-document attribution)",
    through: "2026-08-04",
    retained: 7,
    last30d: 7,
  });
});

test("accepted action and voluntary outcome rows are exposed only as aggregate counts", () => {
  const snapshot = buildUsageSnapshot([
    { day: FIXTURE_DAY, event: "action_opened", detail: "official-handoff", surface: "home", count: 10 },
    { day: FIXTURE_DAY, event: "outcome_prompted", detail: "official-handoff", surface: "home", count: 8 },
    { day: FIXTURE_DAY, event: "outcome_dismissed", detail: "official-handoff", surface: "home", count: 2 },
    { day: FIXTURE_DAY, event: "outcome_recorded", detail: "submitted", surface: "home", count: 3 },
    { day: FIXTURE_DAY, event: "outcome_recorded", detail: "not-useful", surface: "home", count: 1 },
  ], FIXTURE_NOW);

  assert.deepEqual(snapshot.action_outcomes, {
    prompt_status: "retired-2026-08-06",
    opened_last7d: 10,
    opened_last30d: 10,
    prompted_last7d: 8,
    prompted_last30d: 8,
    dismissed_last7d: 2,
    dismissed_last30d: 2,
    recorded_last7d: 4,
    recorded_last30d: 4,
    by_outcome_last30d: { submitted: 3, attended: 0, bid: 0, won: 0, "not-useful": 1 },
  });
  assert.doesNotMatch(JSON.stringify(snapshot.action_outcomes), /visitor|device|query|address|notice|referrer/i);
});

test("zero-state repro: private stats report unavailable usage without analytics credentials", async () => {
  const response = await handlePrivateStats(
    new Request("https://api.cityscroll.org/admin/stats"),
    { SUBS: fakeKV(), ALERT_STATE: fakeKV(), NL_METER: fakeKV() },
    { waitUntil() {} },
  );
  const body = await response.json();
  assert.equal(body.usage.available, false);
  assert.equal(body.usage.unavailable_reason, "not-configured");
  assert.equal(body.usage.page_views.last30d, 0);
});

test("field case: accepted page_view remains readable by private stats when SQL credentials are missing", async () => {
  // Symptom (2026-07-30): POST /events returned 204 for a well-formed page_view, but
  // The operational stats reader showed page_views=0 and usage.available=false (unavailable_reason
  // not-configured). Writer must await KV fallback; reader must promote those counts
  // when the Analytics Engine SQL path is not configured.
  const points = [];
  const secret = "test-only-analytics-developer-key-32-chars";
  const alertState = fakeKV();
  const nowMs = Date.now();
  await emit(points, { event: "page_view", surface: "home" }, {
    environment: "production",
    secret,
    alertState,
    nowMs,
  });
  await emit(points, { event: "page_view", surface: "stats" }, {
    environment: "production",
    secret,
    alertState,
    nowMs: nowMs + 1,
  });

  // Bumps are awaited inside handleEvent — no sleep race. Immediately after 204, KV holds counts.
  const response = await handlePrivateStats(
    new Request("https://api.cityscroll.org/admin/stats"),
    { SUBS: fakeKV(), ALERT_STATE: alertState, NL_METER: fakeKV() },
    { waitUntil() {} },
  );
  const body = await response.json();

  assert.equal(body.usage.available, true);
  assert.equal(body.usage.unavailable_reason, undefined);
  assert.equal(body.usage.page_views.last7d, 2);
  assert.equal(body.usage.page_views.last30d, 2);
  assert.equal(body.usage.page_views.by_surface_last30d.home, 1);
  assert.equal(body.usage.page_views.by_surface_last30d.stats, 1);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("field case: fire-and-forget page_view writes are rejected by the intake contract", async () => {
  // Pin the regression shape: intake source must await page_view KV bumps, not void them.
  const source = await readFile(new URL("../worker/src/events.mjs", import.meta.url), "utf8");
  assert.match(source, /await Promise\.all\(tasks\)/);
  assert.match(source, /bumpStat\(env\.ALERT_STATE, "page_view"/);
  assert.doesNotMatch(source, /void Promise\.all\(/);
});

test("field case: domain migration store continuity — durable KV history must not reset Site totals to zero", async () => {
  // Symptom (2026-07-30): after the crol-list.org → cityscroll.org flip, usage.available
  // was false / not-configured and page_views showed zeros even though the pre-flip
  // ALERT_STATE / NL_METER namespaces still held searches, digest-link clicks, and shares.
  // Analytics Engine had zero rows; the reader must reconcile against the continuous store.
  const emptyAe = {
    available: false,
    unavailable_reason: "not-configured",
    measured_since: "2026-07-27",
    page_views: { last7d: 0, last30d: 0, by_surface_last30d: {} },
    searches: { last7d: 0, last30d: 0, by_lens_last30d: {} },
    deep_links: { last7d: 0, last30d: 0, by_kind_last30d: {} },
    lens_interest: { last7d: {}, last30d: {} },
    alerts: { starts_last30d: 0, confirmed_last7d: 0, confirmed_last30d: 0 },
    growth: { by_day: {} },
  };
  const reconciled = reconcileUsageWithDurableStores(emptyAe, {
    searchesLast7d: 89,
    searchesLast30d: 120,
    searchesByLensLast7d: { money: 16, land: 10, meetings: 19 },
    searchesByLensLast30d: { money: 32, land: 18, meetings: 19 },
    deepLinksLast7d: 3,
    deepLinksLast30d: 5,
    sharesLast7d: 29,
    sharesLast30d: 40,
    growthByDay: {
      "2026-07-29": { page_views: 0, interactions: 68 },
      "2026-07-28": { page_views: 0, interactions: 2 },
    },
  }, { measuredSince: "2026-07-27" });

  assert.equal(reconciled.available, true);
  assert.equal(reconciled.unavailable_reason, undefined);
  assert.equal(reconciled.searches.last7d, 89);
  assert.equal(reconciled.searches.last30d, 120);
  assert.equal(reconciled.searches.by_lens_last30d.money, 32);
  assert.equal(reconciled.deep_links.last7d, 3 + 29);
  assert.equal(reconciled.lens_interest.last30d.money, 32);
  assert.equal(reconciled.growth.by_day["2026-07-29"].interactions, 68);

  // End-to-end through private stats with the live KV shape (no AE credentials).
  const today = new Date().toISOString().slice(0, 10);
  const alertState = fakeKV({
    [`stats:click:${today}`]: "3",
    [`stats:share:${today}`]: "29",
  });
  const nlMeter = fakeKV({
    [`stats:nl_search:${today}`]: "89",
    [`stats:catday:nl_search:money:${today}`]: "16",
    [`stats:catday:nl_search:land:${today}`]: "10",
    [`hist:nl_search:2026-07-29`]: "68",
    [`hist:era:nl_search`]: "2026-07-14",
  });
  const response = await handlePrivateStats(
    new Request("https://api.cityscroll.org/admin/stats"),
    { SUBS: fakeKV(), ALERT_STATE: alertState, NL_METER: nlMeter },
    { waitUntil() {} },
  );
  const body = await response.json();
  assert.equal(body.usage.available, true);
  assert.ok(body.usage.searches.last7d >= 89);
  assert.ok(body.usage.deep_links.last7d >= 32);
  assert.ok(body.usage.growth.by_day["2026-07-29"]?.interactions >= 68);
});

test("aggregate windows exclude old rows without inventing missing values", () => {
  const snapshot = buildUsageSnapshot([
    { day: "2026-07-27", event: "page_view", lens: "none", detail: "none", geography: "none", surface: "home", count: 2 },
    { day: "2026-06-01", event: "page_view", lens: "none", detail: "none", geography: "none", surface: "home", count: 99 },
  ], new Date("2026-07-27T12:00:00Z"), "2026-07-27");
  assert.equal(snapshot.page_views.last7d, 2);
  assert.equal(snapshot.page_views.last30d, 2);
  assert.equal(snapshot.measured_since, "2026-06-01");
});

test("public stats page is a small coverage surface with dated cards and no usage panels", async () => {
  const html = await readFile(new URL("../site/stats.html", import.meta.url), "utf8");
  assert.match(html, /id="grid"(?![^>]*\bhidden\b)/);
  // Three measured headline facts. Languages left the grid deliberately: the site's
  // language list is a capability the page offers, not a measure of how it is used, and
  // a headline tile invited it to be read as one.
  assert.equal((html.match(/class="stat"/g) || []).length, 3);
  assert.equal((html.match(/data-stat-asof/g) || []).length, 4);
  assert.doesNotMatch(html, /gridUsage|usageLensTableBody|usageGrowthTableBody|s-digests|s-subs|s-pageviews/);
  assert.doesNotMatch(html, /id="s-languages"/);
  assert.match(html, /stats_sources_label/);
  assert.match(html, /stats_record_sets_label/);
  assert.match(html, /stats_evidence_label/);
  // Each headline number is a description-list value under the term that names its unit,
  // so a screen reader reads the figure with the thing it counts.
  assert.match(html, /<dl class="grid" id="grid">/);
  assert.match(html, /<dt class="l" data-i18n="stats_sources_label">[^<]*<\/dt><dd class="n" id="s-sources">/);
  // Languages stay on the page as a stated capability, in the methodology list.
  assert.match(html, /<dt data-i18n="stats_public_languages_label">/);
});

test("every public page loads the first-party collector and every locale covers new labels", async () => {
  for (const page of ["index.html", "stats.html", "about.html", "data.html", "api.html", "changelog.html", "standards.html"]) {
    assert.match(await readFile(new URL(`../site/${page}`, import.meta.url), "utf8"), /analytics\.js\?v=1\.4\.0/, page);
  }
  for (const locale of ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"]) {
    const source = await readFile(new URL(`../site/i18n/lang/${locale}.js`, import.meta.url), "utf8");
    for (const key of ["stats_public_lede", "stats_sources_label", "stats_record_sets_label", "stats_public_languages_label", "stats_public_asof"]) {
      assert.match(source, new RegExp(`${key}:`), `${locale}: ${key}`);
    }
  }
});

test("the retired privacy policy stays off the public About page", async () => {
  const about = await readFile(new URL("../site/about.html", import.meta.url), "utf8");
  const english = await readFile(new URL("../site/i18n.js", import.meta.url), "utf8");
  assert.doesNotMatch(about, /id="privacy"|Microsoft Clarity|Do Not Track|Global Privacy Control/i);
  assert.doesNotMatch(english, /about_h_privacy|about_p_privacy_intro|about_li_privacy_html/);
});

test("taxonomy and budget note pin current Cloudflare allowances and limits", async () => {
  const doc = await readFile(new URL("../docs/analytics-event-taxonomy.md", import.meta.url), "utf8");
  assert.match(doc, new RegExp(`Version: \\*\\*${TAXONOMY_VERSION.replaceAll(".", "\\.")}\\*\\*`));
  assert.match(doc, /declared task, not an inferred identity/);
  assert.match(doc, /10 million data points/);
  assert.match(doc, /1 million SQL read queries/);
  assert.match(doc, /250 data points per Worker invocation/);
  assert.match(doc, /ANALYTICS_DEV_KEY/);
  assert.match(doc, /ANALYTICS_ENVIRONMENT/);
  assert.match(doc, /https:\/\/developers\.cloudflare\.com\/analytics\/analytics-engine\/pricing\//);
  assert.match(usageAnalyticsQuery(), /INTERVAL '90' DAY/);
  for (const version of COMPATIBLE_TAXONOMY_VERSIONS) {
    assert.match(usageAnalyticsQuery(), new RegExp(`'${version.replaceAll(".", "\\.")}'`));
  }
});

/**
 * The boundary the published figures depend on: an interaction and a finished search are two
 * signals, and neither is ever quietly turned into the other.
 */
test("a search interaction and an accepted execution stay two signals", async () => {
  const points = [];
  const alertState = fakeKV();
  await emit(points, {
    event: "search_run",
    lens: "land",
    detail: "filters",
    surface: "home",
  }, { alertState, nowMs: FIXTURE_NOW.getTime() });

  // The interaction moved its own counters and nothing else. There is no receipt key, no
  // execution counter, and nothing that a completed-search reader would pick up.
  const written = [...alertState.store.keys()].sort();
  assert.deepEqual(written, [
    `stats:catday:usage_search_run:land:${FIXTURE_DAY}`,
    `stats:usage_search_run:${FIXTURE_DAY}`,
  ]);
  assert.equal(written.some((key) => key.startsWith("search:exec")), false);

  const response = await handlePrivateStats(new Request("https://api.cityscroll.org/admin/stats"), {
    ALERT_STATE: alertState,
    NL_METER: fakeKV(),
  }, { now: FIXTURE_NOW });
  const body = JSON.parse(await response.text());

  // Completed searches are read from the receipt store, which this interaction never wrote to.
  // The interaction is counted once as an interaction and contributes nothing to the completed
  // count, and the empty completed count does not claim to be an established measurement.
  assert.equal(await alertState.get(`stats:usage_search_run:${FIXTURE_DAY}`), "1");
  assert.equal(body.search_executions.windows.last7d.completed, 0);
  assert.equal(body.search_executions.windows.last7d.returned_records, 0);
  assert.equal(body.search_executions.measured_since, null,
    "with no established start, a zero is not a claim that nobody searched");
  assert.equal(body.search_executions.executions_observed, 0);

  // And the two are described as different measurements, by different methods, beside each
  // other rather than added together.
  assert.equal(body.measurement_basis["usage.searches"].method, "sampled");
  assert.equal(body.measurement_basis["usage.searches"].exactness, "estimated");
  assert.equal(body.measurement_basis.search_executions.method, "receipt-count");
  assert.equal(body.measurement_basis.search_executions.exactness, "exact");
  assert.match(body.measurement_basis.note, /Never summed/i);
  assert.match(usageAnalyticsQuery(), /_sample_interval/);
});

test("a refused dimension is counted privately and never becomes a report", async () => {
  const points = [];
  const alertState = fakeKV();
  const env = {
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ENVIRONMENT: "production",
    ALERT_STATE: alertState,
  };
  const submit = async (event) => handleEvent(new Request("https://api.cityscroll.org/events", {
    method: "POST",
    headers: { Origin: "https://cityscroll.org", "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(event),
  }), env, { nowMs: FIXTURE_NOW.getTime() });

  // A surface nobody registered, and a page view claiming a delivery surface.
  assert.equal((await submit({ event: "page_view", surface: "a-surface-nobody-registered" })).status, 400);
  assert.equal((await submit({ event: "page_view", surface: "email" })).status, 400);
  assert.deepEqual(points, [], "a refused submission writes no analytics point");
  assert.equal(await alertState.get(`stats:usage_rejected:${FIXTURE_DAY}`), "2");
  // The refused values themselves are not kept anywhere.
  assert.equal([...alertState.store.keys()].some((key) => key.includes("a-surface-nobody-registered")), false);
  assert.equal(await alertState.get(`stats:page_view:${FIXTURE_DAY}`), null);

  const response = await handlePrivateStats(new Request("https://api.cityscroll.org/admin/stats"), {
    ALERT_STATE: alertState,
    NL_METER: fakeKV(),
  }, { now: FIXTURE_NOW });
  const body = JSON.parse(await response.text());
  assert.equal(body.measurement_diagnostics.rejected_events_last7d, 2);
  assert.equal(body.measurement_diagnostics.rejected_events_last30d, 2);
});

test("developer and preview traffic cannot move a production counter, refused or accepted", async () => {
  const secret = "x".repeat(48);
  const nowMs = FIXTURE_NOW.getTime();

  const developerState = fakeKV();
  const developerEnv = {
    USAGE_ANALYTICS: analyticsBinding([]),
    ANALYTICS_ENVIRONMENT: "production",
    ANALYTICS_DEV_KEY: secret,
    ALERT_STATE: developerState,
  };
  const asDeveloper = async (event) => handleEvent(new Request("https://api.cityscroll.org/events", {
    method: "POST",
    headers: {
      Origin: "https://cityscroll.org",
      "Content-Type": "text/plain;charset=UTF-8",
      "X-CROL-Analytics-Dev": developerToken(secret, nowMs),
    },
    body: JSON.stringify(event),
  }), developerEnv, { nowMs });

  assert.equal((await asDeveloper({ event: "page_view", surface: "stats" })).status, 204);
  assert.equal((await asDeveloper({ event: "page_view", surface: "nonsense" })).status, 400);
  assert.deepEqual([...developerState.store.keys()], [], "no production counter moved, and no rejection was counted");

  const previewState = fakeKV();
  const previewEnv = {
    USAGE_ANALYTICS: analyticsBinding([]),
    ANALYTICS_ENVIRONMENT: "preview",
    ALERT_STATE: previewState,
  };
  const response = await handleEvent(new Request("https://api.cityscroll.org/events", {
    method: "POST",
    headers: { Origin: "https://cityscroll.org", "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ event: "page_view", surface: "no-such-surface" }),
  }), previewEnv, { nowMs });
  assert.equal(response.status, 400);
  assert.deepEqual([...previewState.store.keys()], []);
});

test("this change publishes no new public headline metric", async () => {
  const response = await handleStats(
    new Request("https://api.cityscroll.org/stats"),
    {},
    { waitUntil: async (promise) => promise },
    { now: FIXTURE_NOW, skipCacheRead: true },
  );
  const body = JSON.parse(await response.text());
  assert.deepEqual(Object.keys(body),
    ["schema", "generated_at", "scope", "coverage", "language_coverage", "search_usage"]);
  // The dated lineage, the reconciliation and the refusal diagnostics are private evidence for
  // the published figures, not published figures of their own.
  for (const key of ["search_usage_lineage", "measurement_diagnostics", "measurement_basis"]) {
    assert.equal(key in body, false, key);
  }
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /page_view|export|deep_link|click|surface/i);
});
