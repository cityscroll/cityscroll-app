import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DATA_HEALTH_PATH,
  DATA_HEALTH_PUBLIC,
  DATA_HEALTH_TO_STATS_HTML,
  STATS_PATH,
  STATS_TO_DATA_HEALTH_HTML,
  dataHealthNavigationFindings,
  isDataHealthPath,
  navigationFromPublicSourceHealth,
  renderDataHealthToStatsHtml,
  renderDataHealthUnavailableDocument,
  renderStatsToDataHealthHtml,
} from "../site/data_health_navigation.mjs";
import { PUBLIC_SOURCE_HEALTH_SCHEMA } from "../site/source_health_public_projection.mjs";
import { handleStats } from "../worker/src/stats.mjs";
import edgeWorker from "../site/pages_edge.mjs";

const committed = JSON.parse(readFileSync(new URL("../site/data/source_health_public.json", import.meta.url)));
const statsHtml = readFileSync(new URL("../site/stats.html", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const searchHtml = readFileSync(new URL("../site/search/index.html", import.meta.url), "utf8");
const sitemapXml = readFileSync(new URL("../site/sitemap.xml", import.meta.url), "utf8");
const statsJs = readFileSync(new URL("../worker/src/stats.mjs", import.meta.url), "utf8");
const dataHealthPage = new URL("../site/data-health/index.html", import.meta.url);

test("stats and data-health share one materialized navigation fact from the public artifact", () => {
  const fact = navigationFromPublicSourceHealth(committed);
  assert.equal(committed.schema, PUBLIC_SOURCE_HEALTH_SCHEMA);
  assert.equal(fact.available, true);
  assert.equal(fact.generated_at, committed.generated_at);
  assert.equal(fact.source_count, committed.source_count);
  assert.equal(fact.data_health_href, DATA_HEALTH_PATH);
  assert.equal(fact.stats_href, STATS_PATH);
  assert.ok(fact.source_count > 0);
  assert.doesNotMatch(JSON.stringify(fact), /reason_codes|clocks|subscriptions|digests/);

  const unavailable = navigationFromPublicSourceHealth({
    schema: PUBLIC_SOURCE_HEALTH_SCHEMA,
    generated_at: null,
    available: false,
    source_count: null,
    sources: null,
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.generated_at, null);
  assert.equal(unavailable.source_count, null);
  assert.equal(unavailable.data_health_href, DATA_HEALTH_PATH);
});

test("stats page points at Data health with one semantic-boundary sentence when public", () => {
  assert.deepEqual(dataHealthNavigationFindings(statsHtml, "stats"), []);
  assert.doesNotMatch(statsHtml, /Publisher updated|CityScroll last checked|all operational|all systems operational/i);
  assert.doesNotMatch(statsHtml, /\/source-health/);
  assert.match(statsHtml, /base \+ "\/stats"/);
  if (DATA_HEALTH_PUBLIC) {
    assert.match(statsHtml, /stats-data-health-crosslink/);
    assert.match(statsHtml, /data-i18n-html="stats_data_health_html"/);
    assert.match(statsHtml, /For source freshness and coverage, see <a href="data-health\/">Data health<\/a>\./);
    assert.match(statsHtml, /href="data-health\/"/);
    assert.equal(renderStatsToDataHealthHtml(), `<p class="stats-data-health-crosslink">${STATS_TO_DATA_HEALTH_HTML}</p>`);
  } else {
    assert.doesNotMatch(statsHtml, /href="(?:\/)?data-health\//);
    assert.doesNotMatch(statsHtml, /stats-data-health-crosslink|stats_data_health_html/);
    assert.equal(renderStatsToDataHealthHtml(), "");
  }
});

test("public navigation exposes Data health beside Stats only when the page is public", () => {
  for (const html of [indexHtml, searchHtml]) {
    assert.deepEqual(dataHealthNavigationFindings(html, "nav"), []);
    assert.match(html, /data-i18n="footer_stats"/);
    if (DATA_HEALTH_PUBLIC) {
      assert.match(html, /data-i18n="footer_data_health"/);
      assert.match(html, /href="data-health\/"/);
    } else {
      assert.doesNotMatch(html, /data-i18n="footer_data_health"/);
      assert.doesNotMatch(html, /href="(?:\/)?data-health\//);
    }
  }
  assert.match(statsHtml, /data-i18n-html="stats_foot_html"/);
  if (DATA_HEALTH_PUBLIC) {
    assert.match(statsHtml, /href="data-health\/"/);
  } else {
    assert.doesNotMatch(statsHtml, /href="(?:\/)?data-health\//);
  }
});

test("the public data-health gate hides the route and sitemap until clocks are clean", () => {
  assert.equal(DATA_HEALTH_PUBLIC, false);
  assert.equal(isDataHealthPath("/data-health"), true);
  assert.equal(isDataHealthPath("/data-health/"), true);
  assert.equal(isDataHealthPath("/data-health/index.html"), true);
  assert.equal(isDataHealthPath("/stats.html"), false);
  assert.deepEqual(dataHealthNavigationFindings(sitemapXml, "sitemap"), []);
  assert.doesNotMatch(sitemapXml, /data-health/);
  assert.match(renderDataHealthUnavailableDocument(), /This page is not available/);
  assert.doesNotMatch(renderDataHealthUnavailableDocument(), /data-data-health|UNKNOWN/);
});

test("data-health, when present, points back at Stats and carries no usage stats", () => {
  assert.equal(
    renderDataHealthToStatsHtml(),
    `<p class="data-health-crosslink">${DATA_HEALTH_TO_STATS_HTML}</p>`,
  );
  if (!existsSync(dataHealthPage)) return;
  const html = readFileSync(dataHealthPage, "utf8");
  assert.deepEqual(dataHealthNavigationFindings(html, "data-health"), []);
  assert.match(html, /href="(?:\/)?stats\.html"/);
  assert.doesNotMatch(html, /subscriptions|nl_search|pageviews|watches_active/);
  assert.doesNotMatch(html, /all operational|all systems operational/i);
});

test("Pages edge returns not-found for public data-health while the gate is off", async () => {
  assert.equal(DATA_HEALTH_PUBLIC, false);
  const env = {
    ASSETS: {
      async fetch() {
        return new Response(
          "<!doctype html><html><body><main data-data-health=\"ready\">UNKNOWN clocks</main></body></html>",
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    },
  };
  for (const path of ["/data-health", "/data-health/", "/data-health/index.html"]) {
    const response = await edgeWorker.fetch(new Request(`https://cityscroll.org${path}`), env);
    assert.equal(response.status, 404, path);
    const body = await response.text();
    assert.doesNotMatch(body, /data-data-health="ready"|UNKNOWN clocks/);
    assert.match(body, /This page is not available/);
  }
});

test("public /stats JSON contract stays corpus coverage only", async () => {
  assert.doesNotMatch(statsJs, /data_health_navigation|source_health_public/);
  const response = await handleStats(
    new Request("https://api.cityscroll.org/stats"),
    {},
    { waitUntil() {} },
    {
      now: "2026-08-05T18:00:00Z",
      fetchImpl: async () => Response.json([{
        notice_count: "1099194",
        first_notice_date: "2003-01-02T00:00:00.000",
        latest_notice_date: "2026-08-05T00:00:00.000",
      }]),
    },
  );
  const body = await response.json();
  assert.equal(body.schema, "public-stats.v2");
  assert.equal(body.city_record.notice_count, 1099194);
  assert.equal(body.sources.primary_system_count, 6);
  for (const privateField of ["subscriptions", "digests", "nl_search", "history", "usage", "source_health"]) {
    assert.equal(Object.hasOwn(body, privateField), false, `${privateField} stays off public /stats`);
  }
});
