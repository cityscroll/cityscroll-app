// Characterization: named post-flip checks encode last-24h incident classes.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  POST_FLIP_NAMED_CHECKS,
  POST_FLIP_NAMED_CHECK_IDS,
  classifyCorpusFreshness,
  classifyCoverageSanity,
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
const NOW = new Date("2026-08-05T18:00:00Z");

function freshLastRun(overrides = {}) {
  const day = NOW.toISOString().slice(0, 10);
  return { ranAt: `${day}T13:00:00.000Z`, day, sent: 0, skipped_reason: "all_quiet", matched: 0, ...overrides };
}

test("named post-flip checks preserve private operations gates and add public coverage gates", () => {
  assert.deepEqual([...POST_FLIP_NAMED_CHECK_IDS].sort(), [
    "corpus-freshness",
    "coverage-sanity",
    "email-health",
    "human-path-journey",
    "stats-sanity",
    "worker-access",
  ].sort());
  const byId = Object.fromEntries(POST_FLIP_NAMED_CHECKS.map((c) => [c.id, c]));
  assert.equal(byId["email-health"].incident.class, "silent-five-day-alert");
  assert.equal(byId["stats-sanity"].incident.class, "sent_today-zero-and-frozen-gauge");
  assert.equal(byId["corpus-freshness"].incident.class, "stale-public-corpus");
  assert.equal(byId["coverage-sanity"].incident.class, "public-private-contract-drift");
  assert.equal(byId["worker-access"].incident.class, "could-not-reach");
  assert.equal(byId["human-path-journey"].incident.class, "owner-manually-found-the-site-down");
  assert.match(byId["human-path-journey"].incident.field_case, /ERR_TOO_MANY_REDIRECTS|redirect-loop/i);
});

test("EMAIL HEALTH still rejects silent or unexplained sends on authenticated operations data", () => {
  const privateStats = {
    digests: { sent_today: 0, sent_last7d: 6, sent_all_time: 27, last_run: freshLastRun() },
    history: { digests: { by_day: {} } },
  };
  assert.equal(classifyEmailHealth(privateStats, { now: NOW }).ok, true);
  assert.match(
    classifyEmailHealth({ ...privateStats, digests: { ...privateStats.digests, last_run: null } }, { now: NOW }).reason,
    /last_run is null/,
  );
  assert.match(
    classifyEmailHealth({ ...privateStats, digests: { ...privateStats.digests, last_run: freshLastRun({ skipped_reason: null }) } }, { now: NOW }).reason,
    /unexplained zero/,
  );
  assert.equal(
    classifyEmailHealth({ ...privateStats, digests: { ...privateStats.digests, sent_today: 2, last_run: freshLastRun({ sent: 2, skipped_reason: null }) } }, { now: NOW }).ok,
    true,
  );
});

test("STATS SANITY still rejects frozen gauges on authenticated operations data", () => {
  const privateStats = {
    digests: { sent_today: 0, last_run: freshLastRun() },
    usage: { available: true, page_views: { last7d: 316 }, searches: { last7d: 90 } },
    nl_search: { calls_last7d: 90 },
    digest_clicks: { last7d: 21 },
  };
  assert.equal(classifyStatsSanity(privateStats).ok, true);
  assert.match(
    classifyStatsSanity({ ...privateStats, usage: { available: true, page_views: {}, searches: {} }, nl_search: {}, digest_clicks: {} }).reason,
    /frozen-gauge/,
  );
  assert.match(classifyStatsSanity({ ...privateStats, digests: { sent_today: 0, last_run: null } }).reason, /sent_today-zero/);
});

test("CORPUS FRESHNESS requires an available, recent City Record aggregate", () => {
  const current = {
    schema: "public-stats.v2",
    city_record: { available: true, notice_count: 1099194, latest_notice_date: "2026-08-05" },
  };
  assert.equal(classifyCorpusFreshness(current, { now: new Date("2026-08-05T18:00:00Z") }).ok, true);
  assert.equal(classifyCorpusFreshness({ ...current, city_record: { available: false } }).ok, false);
  assert.match(
    classifyCorpusFreshness({ ...current, city_record: { ...current.city_record, latest_notice_date: "2026-07-01" } }, { now: new Date("2026-08-05T18:00:00Z") }).reason,
    /older than 3 days/,
  );
});

test("COVERAGE SANITY requires coherent coverage and rejects usage-class fields", () => {
  const coverage = {
    sources: { primary_system_count: 2, systems: ["A", "B"] },
    language_coverage: { site_languages: 11 },
  };
  assert.equal(classifyCoverageSanity(coverage).ok, true);
  assert.match(classifyCoverageSanity({ ...coverage, usage: {} }).reason, /usage-class fields leaked/);
  assert.match(classifyCoverageSanity({ ...coverage, sources: { primary_system_count: 3, systems: ["A"] } }).reason, /disagree/);
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
  const publicStatsBody = {
    schema: "public-stats.v2",
    city_record: { available: true, notice_count: 1099194, latest_notice_date: "2026-08-05" },
    sources: { primary_system_count: 2, systems: ["A", "B"] },
    language_coverage: { site_languages: 11 },
  };
  const privateStatsBody = {
    digests: { sent_today: 0, sent_last7d: 6, sent_all_time: 27, last_run: freshLastRun() },
    usage: { available: true, page_views: { last7d: 100 }, searches: { last7d: 10 } },
    nl_search: { calls_last7d: 10 },
    digest_clicks: { last7d: 5 },
    history: { digests: { by_day: {} } },
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
    if (u.endsWith("/admin/stats")) {
      assert.equal(init.headers?.Authorization, "Bearer test-admin-key");
      return {
        status: 200,
        text: async () => JSON.stringify(privateStatsBody),
        headers: { get: () => null },
      };
    }
    if (u.endsWith("/stats")) {
      return {
        status: 200,
        text: async () => JSON.stringify(publicStatsBody),
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
    adminKey: "test-admin-key",
    now: NOW,
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
  assert.equal(result.results.length, 6);
  for (const r of result.results) {
    assert.ok(r.incident?.class, `${r.id} must carry incident annotation`);
    assert.equal(r.ok, true, r.id);
  }
});

test("private operations checks fail closed when no desk credential is configured", async () => {
  const result = await runPostFlipNamedChecks({
    fetchImpl: async () => ({ status: 503, text: async () => "", headers: { get: () => null } }),
    runJourney: false,
    skip: ["corpus-freshness", "coverage-sanity", "worker-access"],
    adminKey: "",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map((row) => row.id), ["email-health", "stats-sanity"]);
  assert.ok(result.results.every((row) => /CITYSCROLL_ADMIN_KEY/.test(row.reason)));
});

test("post-flip URL matrix includes stats endpoint and is selected only via --set", () => {
  const urls = POST_FLIP_TARGETS.map((t) => t.url);
  assert.ok(urls.includes("https://api.cityscroll.org/stats"));
  assert.ok(urls.includes("https://api.cityscroll.org/health"));
  assert.equal(targetsFromCli({ targetSet: "post-flip" }), POST_FLIP_TARGETS);
  assert.notEqual(targetsFromCli({}), POST_FLIP_TARGETS);
});

test("migration scorecard preserves the measured before-side and labels after verdicts", () => {
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
  assert.equal(baseline.after_cutover.status, "value-partially-confirmed");
  assert.equal(baseline.after_cutover.merge_to_live.tag, "measured");
  assert.equal(baseline.after_cutover.merge_to_live.verdict, "confirmed");
  assert.equal(baseline.after_cutover.merge_to_live.n, 50);
  assert.equal(baseline.after_cutover.detection_latency.verdict, "cant-measure-yet");
  assert.equal(baseline.after_cutover.rollback_wall_clock.verdict, "cant-measure-yet");
  assert.equal(baseline.after_cutover.rollback_wall_clock.actual_restore_s, null);
  assert.equal(baseline.after_cutover.rollback_wall_clock.production_mutation_performed, false);
  assert.ok(baseline.claims_to_measure_after_cutover.some((c) => c.id === "ship-faster"));
});
