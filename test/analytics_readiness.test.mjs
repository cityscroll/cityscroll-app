import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import { handleEvent } from "../worker/src/events.mjs";
import { handleStats } from "../worker/src/stats.mjs";
import {
  ANALYTICS_LENSES,
  buildUsageSnapshot,
  normalizeUsageEvent,
  usageAnalyticsQuery,
} from "../worker/src/lib/analytics.mjs";

function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
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
    Origin: "https://crol-list.org",
    "Content-Type": "text/plain;charset=UTF-8",
  };
  if (options.developerToken) headers["X-CROL-Analytics-Dev"] = options.developerToken;
  const response = await handleEvent(new Request("https://api.crol-list.org/events", {
    method: "POST",
    headers,
    body: JSON.stringify(event),
  }), {
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ENVIRONMENT: options.environment ?? "production",
    ANALYTICS_DEV_KEY: options.secret,
  }, { nowMs: options.nowMs });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
  return response;
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
  assert.deepEqual(points[0].blobs, ["search_run", "land", "filters", "queens", "home", "1.0.0"]);
  assert.deepEqual(points[0].doubles, [1]);
  assert.deepEqual(points[0].indexes, ["search_run"]);
  assert.ok(!JSON.stringify(points[0]).includes("this value"));
  assert.ok(!JSON.stringify(points[0]).includes("forbidden"));
  assert.equal(normalizeUsageEvent({ event: "unknown", surface: "home" }), null);
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

test("fixture event flows emit -> sampling-aware aggregate -> public stats endpoint", async () => {
  const points = [];
  await emit(points, { event: "page_view", surface: "home" });
  await emit(points, { event: "page_view", surface: "stats" });
  await emit(points, { event: "search_run", lens: "land", detail: "filters", geography: "queens", surface: "home" });
  await emit(points, { event: "export", lens: "money", detail: "csv", surface: "home" });
  await emit(points, { event: "alert_confirmed", lens: "land", surface: "email" });

  const rows = points.map((point) => rowFromPoint(point, "2026-07-27"));
  const env = {
    USAGE_ANALYTICS: analyticsBinding(points),
    ANALYTICS_ACCOUNT_ID: "test-account",
    ANALYTICS_READ_TOKEN: "test-token",
    ANALYTICS_DATASET: "crol_usage_events_v1",
    ANALYTICS_MEASURED_SINCE: "2026-07-27",
    ALERT_STATE: fakeKV(),
    NL_METER: fakeKV(),
    SUBS: fakeKV(),
  };
  const response = await handleStats(
    new Request("https://api.crol-list.org/stats"),
    env,
    { waitUntil() {} },
    {
      fetchImpl: async (_url, init) => {
        assert.match(init.body, /sum\(_sample_interval \* double1\)/);
        assert.equal(init.headers["Content-Type"], "text/plain");
        return Response.json({ data: rows });
      },
    },
  );
  const body = await response.json();

  assert.equal(body.usage.available, true);
  assert.equal(body.usage.page_views.last7d, 2);
  assert.equal(body.usage.searches.last7d, 1);
  assert.equal(body.usage.exports.last7d, 1);
  assert.equal(body.usage.alerts.confirmed_last7d, 1);
  assert.equal(body.usage.geography_interest.last30d.queens, 1);
  assert.deepEqual(Object.keys(body.usage.lens_interest.last30d), ANALYTICS_LENSES);
  assert.equal(body.usage.lens_interest.last30d.meetings, 0);
  assert.equal(body.nl_search.by_category.meetings, 0, "previously omitted zero-count lens is pinned");
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

test("stats page never success-gates its number panels and stamps each panel", async () => {
  const html = await readFile(new URL("../stats.html", import.meta.url), "utf8");
  for (const id of ["grid", "gridAllTime", "gridUsage", "gridTechnical"]) {
    assert.match(html, new RegExp(`id="${id}"(?![^>]*\\bhidden\\b)`));
  }
  assert.ok((html.match(/data-stat-asof/g) || []).length >= 15);
  assert.ok((html.match(/data-usage-asof/g) || []).length >= 8);
  assert.match(html, /stats_usage_unavailable/);
  assert.match(html, /usageLensTableBody/);
  assert.match(html, /usageGrowthTableBody/);
});

test("every public page loads the first-party collector and every locale covers new labels", async () => {
  for (const page of ["index.html", "stats.html", "about.html", "data.html", "api.html", "changelog.html", "standards.html"]) {
    assert.match(await readFile(new URL(`../${page}`, import.meta.url), "utf8"), /analytics\.js\?v=1\.1\.0/, page);
  }
  for (const locale of ["es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"]) {
    const source = await readFile(new URL(`../i18n/lang/${locale}.js`, import.meta.url), "utf8");
    for (const key of ["stats_h_usage", "stats_lbl_pageviews", "stats_col_last30", "stats_metric_asof", "stats_area_queens"]) {
      assert.match(source, new RegExp(`${key}:`), `${locale}: ${key}`);
    }
  }
});

test("privacy copy removes falsified exhaustive promises without adding a new enumeration", async () => {
  const about = await readFile(new URL("../about.html", import.meta.url), "utf8");
  const english = await readFile(new URL("../i18n.js", import.meta.url), "utf8");
  for (const source of [about, english]) {
    assert.match(source, /uses no accounts, no cookies, no cross-site tracking, no ad tech/);
    assert.match(source, /Searches and filters(?:<\/b>)? use NYC Open Data/);
    assert.doesNotMatch(source, /go straight to NYC Open Data|server never sees them|only keep a daily count/i);
    assert.doesNotMatch(source, /aggregate usage events|interaction taxonomy/i);
  }
});

test("taxonomy and budget note pin current Cloudflare allowances and limits", async () => {
  const doc = await readFile(new URL("../docs/analytics-event-taxonomy.md", import.meta.url), "utf8");
  assert.match(doc, /Version: \*\*1\.0\.0\*\*/);
  assert.match(doc, /10 million data points/);
  assert.match(doc, /1 million SQL read queries/);
  assert.match(doc, /250 data points per Worker invocation/);
  assert.match(doc, /ANALYTICS_DEV_KEY/);
  assert.match(doc, /ANALYTICS_ENVIRONMENT/);
  assert.match(doc, /https:\/\/developers\.cloudflare\.com\/analytics\/analytics-engine\/pricing\//);
  assert.match(usageAnalyticsQuery(), /INTERVAL '90' DAY/);
});
