// Characterization: named post-flip checks encode last-24h incident classes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  POST_FLIP_NAMED_CHECKS,
  POST_FLIP_NAMED_CHECK_IDS,
  classifyEmailHealth,
  classifyHumanPathJourney,
  classifyStatsSanity,
  classifyWorkerAccess,
  runPostFlipNamedChecks,
} from "../tools/post_flip_checks.mjs";
import { POST_FLIP_TARGETS, targetsFromCli } from "../tools/live_url_smoke.mjs";

const baseline = JSON.parse(
  readFileSync(new URL("../docs/evidence/hosting-migration-baseline.json", import.meta.url), "utf8"),
);

test("named post-flip checks cover the four incident-encoded gates", () => {
  assert.deepEqual([...POST_FLIP_NAMED_CHECK_IDS].sort(), [
    "email-health",
    "human-path-journey",
    "stats-sanity",
    "worker-access",
  ].sort());
  const byId = Object.fromEntries(POST_FLIP_NAMED_CHECKS.map((c) => [c.id, c]));
  assert.equal(byId["email-health"].incident.class, "silent-five-day-alert");
  assert.match(byId["email-health"].incident.field_case, /2026-07-30/);
  assert.equal(byId["stats-sanity"].incident.class, "sent_today-zero-and-frozen-gauge");
  assert.equal(byId["worker-access"].incident.class, "could-not-reach");
  assert.equal(byId["human-path-journey"].incident.class, "owner-manually-found-the-site-down");
  assert.match(byId["human-path-journey"].incident.field_case, /ERR_TOO_MANY_REDIRECTS|redirect-loop/i);
});

test("EMAIL HEALTH fails on null last_run (silent digest class) and passes with receipt + motion", () => {
  // Receipt-day freshness is relative to "now" (stale after 2 days). Keep pass cases
  // on a recent UTC day so this characterization does not fail when the calendar rolls.
  const recentDay = new Date().toISOString().slice(0, 10);
  const recentAt = `${recentDay}T13:00:00.000Z`;

  assert.equal(
    classifyEmailHealth({
      digests: { sent_today: 0, sent_last7d: 6, sent_all_time: 27, last_run: null },
    }).ok,
    false,
  );
  assert.match(
    classifyEmailHealth({
      digests: { sent_today: 0, sent_last7d: 6, last_run: null },
    }).reason,
    /silent-five-day-alert|last_run is null/,
  );

  // Unexplained zero: receipt exists but skipped_reason empty and sent=0
  assert.equal(
    classifyEmailHealth({
      digests: {
        sent_today: 0,
        sent_last7d: 6,
        last_run: { ranAt: recentAt, day: recentDay, sent: 0 },
      },
    }).ok,
    false,
  );

  assert.equal(
    classifyEmailHealth({
      digests: {
        sent_today: 0,
        sent_last7d: 6,
        sent_all_time: 27,
        last_run: {
          ranAt: recentAt,
          day: recentDay,
          sent: 0,
          skipped_reason: "all_quiet",
          matched: 0,
        },
      },
    }).ok,
    true,
  );

  assert.equal(
    classifyEmailHealth({
      digests: {
        sent_today: 2,
        sent_last7d: 8,
        last_run: {
          ranAt: recentAt,
          day: recentDay,
          sent: 2,
          skipped_reason: null,
        },
      },
    }).ok,
    true,
  );
});

test("STATS SANITY rejects frozen gauges and unexplained sent_today zero", () => {
  assert.equal(
    classifyStatsSanity({
      digests: { sent_today: 0, last_run: null },
      usage: { available: true, page_views: { last7d: 0 }, searches: { last7d: 0 } },
      nl_search: { calls_last7d: 0 },
      digest_clicks: { last7d: 0 },
    }).ok,
    false,
  );
  assert.match(
    classifyStatsSanity({
      digests: { sent_today: 1, last_run: { ranAt: "x", sent: 1, skipped_reason: null } },
      usage: { available: true, page_views: { last7d: 0 }, searches: { last7d: 0 } },
      nl_search: { calls_last7d: 0 },
      digest_clicks: { last7d: 0 },
    }).reason,
    /frozen-gauge/,
  );

  assert.equal(
    classifyStatsSanity({
      digests: {
        sent_today: 0,
        last_run: { ranAt: "2026-07-30T13:00:00.000Z", sent: 0, skipped_reason: "all_quiet" },
      },
      usage: {
        available: true,
        page_views: { last7d: 316 },
        searches: { last7d: 90 },
      },
      nl_search: { calls_last7d: 90 },
      digest_clicks: { last7d: 21 },
    }).ok,
    true,
  );
});

test("WORKER ACCESS requires health, stats JSON, and site-origin CORS on /events", () => {
  assert.equal(
    classifyWorkerAccess({
      healthStatus: 200,
      healthBody: "crol-worker ok",
      statsStatus: 200,
      statsOkJson: true,
      eventsCorsOrigin: "https://cityscroll.org",
      expectedSiteOrigin: "https://cityscroll.org",
    }).ok,
    true,
  );
  assert.match(
    classifyWorkerAccess({
      healthStatus: 200,
      healthBody: "crol-worker ok",
      statsStatus: 200,
      statsOkJson: true,
      eventsCorsOrigin: null,
    }).reason,
    /could-not-reach|Access-Control-Allow-Origin/i,
  );
  assert.equal(
    classifyWorkerAccess({
      healthStatus: 502,
      healthBody: "Bad gateway",
      statsStatus: 200,
      statsOkJson: true,
      eventsCorsOrigin: "https://cityscroll.org",
    }).ok,
    false,
  );
});

test("HUMAN-PATH JOURNEY requires home/search/notice/deeplink/subscribe steps", () => {
  assert.equal(
    classifyHumanPathJourney({
      steps: [
        { ok: true, name: "home-browse" },
        { ok: true, name: "search-list" },
        { ok: true, name: "notice-detail" },
        { ok: true, name: "deeplink-notice" },
        { ok: true, name: "subscribe-surface" },
      ],
    }).ok,
    true,
  );
  assert.equal(
    classifyHumanPathJourney({
      steps: [
        { ok: true, name: "home-browse" },
        { ok: false, name: "search-list", detail: "timeout" },
      ],
    }).ok,
    false,
  );
  assert.match(
    classifyHumanPathJourney({
      steps: [
        { ok: true, name: "home-browse" },
        { ok: true, name: "search-list" },
        { ok: true, name: "notice-detail" },
        { ok: true, name: "deeplink-notice" },
      ],
    }).reason,
    /subscribe/,
  );
});

test("runPostFlipNamedChecks aggregates classifiers with incident annotations", async () => {
  const recentDay = new Date().toISOString().slice(0, 10);
  const statsBody = {
    digests: {
      sent_today: 0,
      sent_last7d: 6,
      sent_all_time: 27,
      last_run: {
        ranAt: `${recentDay}T13:00:00.000Z`,
        day: recentDay,
        sent: 0,
        skipped_reason: "all_quiet",
        matched: 0,
      },
    },
    usage: {
      available: true,
      page_views: { last7d: 100 },
      searches: { last7d: 10 },
    },
    nl_search: { calls_last7d: 10 },
    digest_clicks: { last7d: 5 },
  };

  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/health")) {
      return {
        status: 200,
        text: async () => "crol-worker ok",
        headers: { get: () => null },
      };
    }
    if (u.endsWith("/stats")) {
      return {
        status: 200,
        text: async () => JSON.stringify(statsBody),
        headers: { get: () => null },
      };
    }
    if (u.endsWith("/events") && init.method === "OPTIONS") {
      return {
        status: 204,
        text: async () => "",
        headers: {
          get(name) {
            if (String(name).toLowerCase() === "access-control-allow-origin") {
              return "https://cityscroll.org";
            }
            return null;
          },
        },
      };
    }
    return { status: 404, text: async () => "miss", headers: { get: () => null } };
  };

  const result = await runPostFlipNamedChecks({
    fetchImpl,
    runJourney: true,
    journeyRunner: async () => ({
      steps: [
        { ok: true, name: "home-browse" },
        { ok: true, name: "search-list" },
        { ok: true, name: "notice-detail" },
        { ok: true, name: "deeplink-notice" },
        { ok: true, name: "subscribe-surface" },
      ],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 4);
  for (const r of result.results) {
    assert.ok(r.incident?.class, `${r.id} must carry incident annotation`);
    assert.equal(r.ok, true, r.id);
  }
});

test("post-flip URL matrix includes stats endpoint and is selected only via --set", () => {
  const urls = POST_FLIP_TARGETS.map((t) => t.url);
  assert.ok(urls.includes("https://api.cityscroll.org/stats"));
  assert.ok(urls.includes("https://api.cityscroll.org/health"));
  assert.equal(targetsFromCli({ targetSet: "post-flip" }), POST_FLIP_TARGETS);
  assert.notEqual(targetsFromCli({}), POST_FLIP_TARGETS);
});

test("migration baseline scorecard is measured before-side, not asserted after", () => {
  assert.equal(baseline.schema, "hosting-migration-baseline.v1");
  assert.equal(baseline.serving_shape, "github-pages-origin-via-worker-mirror");
  assert.equal(baseline.merge_to_live.tag, "measured");
  assert.ok(baseline.merge_to_live.n >= 5);
  assert.ok(baseline.merge_to_live.median_s > 0);
  assert.ok(baseline.merge_to_live.samples.every((s) => s.wall_clock_s > 0 && s.run_id));
  const silent = baseline.detection_latency_exemplars.find(
    (e) => e.incident_class === "silent-digest-sent-today-zero",
  );
  assert.ok(silent);
  assert.equal(silent.tag, "measured");
  assert.equal(silent.latency_minutes.min, 6);
  assert.equal(silent.latency_minutes.max, 10);
  assert.equal(baseline.rollback_estimate.tag, "estimated");
  assert.equal(baseline.after_cutover.status, "not-yet-measured");
  assert.ok(baseline.claims_to_measure_after_cutover.some((c) => c.id === "ship-faster"));
});
