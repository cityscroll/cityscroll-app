import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { classifyDestinationUrl } from "../ontology/actionability_sample.mjs";
import {
  ACTION_LINK_PATTERNS,
  assessLinkSpecificity,
  auditPattern,
  collectSpecificityFindings,
  DEEP_LINK_SYSTEMS,
  probeUrl,
} from "../tools/audit-action-links.mjs";
import { applyAuditVerdicts } from "../tools/lib/action_link_health.mjs";

test("action-link inventory covers every take-action surface with distinct HTTPS patterns", () => {
  const requiredSurfaces = ["rules", "land", "contracts", "meetings", "property", "staffing"];
  const surfaces = new Set(ACTION_LINK_PATTERNS.map((pattern) => pattern.surface));
  for (const surface of requiredSurfaces) assert.ok(surfaces.has(surface), `missing ${surface}`);

  const ids = new Set();
  const urlPatterns = new Set();
  for (const pattern of ACTION_LINK_PATTERNS) {
    assert.ok(!ids.has(pattern.id), `duplicate id ${pattern.id}`);
    assert.ok(!urlPatterns.has(pattern.url_pattern), `duplicate URL pattern ${pattern.url_pattern}`);
    assert.equal(new URL(pattern.sample_url).protocol, "https:");
    for (const sampleUrl of pattern.sample_urls || []) {
      assert.equal(new URL(sampleUrl).protocol, "https:");
    }
    assert.equal(
      classifyDestinationUrl(pattern.sample_url),
      pattern.expected_destination_class,
      `unexpected destination class for ${pattern.id}`,
    );
    assert.equal(typeof pattern.upstream_fallback, "string");
    assert.ok(pattern.upstream_fallback.length > 20);
    ids.add(pattern.id);
    urlPatterns.add(pattern.url_pattern);
  }
  assert.ok(ids.has("staffing-oasys-noe"), "inventory must include OASys per-exam NOE deep link");
  assert.ok(DEEP_LINK_SYSTEMS.some((s) => s.id === "oasys"));
});

test("City Record notice pattern uses verified request IDs across publication vintages", () => {
  const pattern = ACTION_LINK_PATTERNS.find((item) => item.id === "contracts-city-record-notice");
  assert.deepEqual(pattern.sample_urls, [
    "https://a856-cityrecord.nyc.gov/RequestDetail/20260706006",
    "https://a856-cityrecord.nyc.gov/RequestDetail/20250130002",
    "https://a856-cityrecord.nyc.gov/RequestDetail/20241028013",
    "https://a856-cityrecord.nyc.gov/RequestDetail/20220203104",
    "https://a856-cityrecord.nyc.gov/RequestDetail/20190515036",
  ]);
  assert.doesNotMatch(pattern.sample_urls.join("\n"), /20260718010/);
});

test("specificity class flags OASys hub handoffs when a deep pattern is known", () => {
  const hub = assessLinkSpecificity("https://www.nyc.gov/examsforjobs", {
    system_id: "oasys",
    item_mappable: true,
  });
  assert.equal(hub.finding?.class, "low-specificity");

  const findings = collectSpecificityFindings([
    {
      id: "mapped-exam-still-lobby",
      url: "https://a856-exams.nyc.gov/OASysWeb/home",
      system_id: "oasys",
      item_mappable: true,
    },
  ]);
  assert.equal(findings.length, 1);

  // HTTP 200 on the lobby is not success when the pattern expects a deep link.
});

test("probeUrl falls back from a failed HEAD request to GET", async () => {
  const methods = [];
  const fetchImpl = async (_url, options) => {
    methods.push(options.method);
    return new Response(null, { status: options.method === "HEAD" ? 405 : 200 });
  };
  const result = await probeUrl("https://example.com/action", { fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(methods, ["HEAD", "GET"]);
});

test("probeUrl rejects a publisher soft 404 even when the response status is 200", async () => {
  const fetchImpl = async () => ({
    status: 200,
    url: "https://publisher.example/Error/Error404?path=/detail/1",
    headers: { get: () => "text/html" },
    body: null,
  });
  const result = await probeUrl("https://publisher.example/detail/1", { fetchImpl });
  assert.equal(result.ok, false);
  assert.deepEqual(result.attempts.map((attempt) => attempt.soft_error), [true, true]);
});

test("a dead NYC Rules RSS artifact is a derivable fix when its rule page responds", async () => {
  const fetchImpl = async (url, options) => {
    const isFeed = new URL(url).pathname.endsWith("/feed/");
    return new Response(null, { status: isFeed ? 404 : 200 });
  };
  const result = await auditPattern({
    id: "rules-feed-regression",
    surface: "rules",
    action: "comment",
    url_pattern: "https://rules.cityofnewyork.us/rule/:slug/feed/",
    sample_url: "https://rules.cityofnewyork.us/rule/example/feed/",
    expected_destination_class: "deep",
    derivation: "nyc_rules_rss",
    upstream_fallback: "Keep the official City Record notice and comment instructions visible.",
  }, { fetchImpl });

  assert.equal(result.verdict, "broken-derivable-fix");
  assert.equal(result.derived.url, "https://rules.cityofnewyork.us/rule/example/");
  assert.equal(result.derived.probe.ok, true);
});

test("a dead publisher URL without a derivable replacement stays an honest upstream break", async () => {
  const result = await auditPattern({
    id: "upstream-break",
    surface: "meetings",
    action: "attend",
    url_pattern: "https://example.com/meeting/:id",
    sample_url: "https://example.com/meeting/1",
    expected_destination_class: "unknown",
    upstream_fallback: "Keep the published venue and testimony contact visible beside the failed link.",
  }, { fetchImpl: async () => new Response(null, { status: 503 }) });

  assert.equal(result.verdict, "broken-upstream");
  assert.match(result.upstream_fallback, /venue/);
});

test("one reachable representative confirms a route pattern while preserving failed sample evidence", async () => {
  const result = await auditPattern({
    id: "multi-vintage-route",
    surface: "contracts",
    action: "submit",
    url_pattern: "https://example.com/detail/:id",
    sample_url: "https://example.com/detail/current",
    sample_urls: [
      "https://example.com/detail/current",
      "https://example.com/detail/archive",
    ],
    expected_destination_class: "deep",
    upstream_fallback: "Keep the extracted response instructions and contact fields visible.",
  }, {
    fetchImpl: async (url) => new Response(null, {status: url.endsWith("archive") ? 404 : 200}),
  });

  assert.equal(result.verdict, "OK");
  assert.equal(result.probe.sample_count, 2);
  assert.equal(result.probe.successes, 1);
  assert.equal(result.probe.failures, 1);
  assert.equal(result.sample_results[1].probe.ok, false);
});

test("audit health degrades immediately, escalates on the second consecutive failure, and recovers automatically", () => {
  const prior = {
    schema: "cityscroll.action_link_health.v1",
    patterns: {
      "contracts-city-record-notice": {
        verdict: "broken-upstream",
        degraded: true,
        consecutive_failures: 1,
        first_failed_at: "2026-08-03T14:01:25.936Z",
      },
    },
  };
  const brokenReport = {
    generated_at: "2026-08-04T14:01:25.936Z",
    patterns: [{
      id: "contracts-city-record-notice",
      verdict: "broken-upstream",
      upstream_fallback: "Keep extracted response instructions and contact fields visible.",
    }],
  };
  const broken = applyAuditVerdicts(brokenReport, prior, {escalationAfter: 2});
  assert.equal(broken.patterns["contracts-city-record-notice"].consecutive_failures, 2);
  assert.equal(broken.patterns["contracts-city-record-notice"].degraded, true);
  assert.deepEqual(broken.summary.newly_escalated_patterns, ["contracts-city-record-notice"]);

  const recovered = applyAuditVerdicts({
    generated_at: "2026-08-05T14:01:25.936Z",
    patterns: [{
      id: "contracts-city-record-notice",
      verdict: "OK",
      upstream_fallback: "Keep extracted response instructions and contact fields visible.",
    }],
  }, broken, {escalationAfter: 2});
  assert.equal(recovered.patterns["contracts-city-record-notice"].consecutive_failures, 0);
  assert.equal(recovered.patterns["contracts-city-record-notice"].degraded, false);
  assert.deepEqual(recovered.summary.recovered_patterns, ["contracts-city-record-notice"]);
});

test("scheduled audit persists verdict state, deploys it, escalates persistent failures, and clears recovered issues", () => {
  const workflow = readFileSync(new URL("../.github/workflows/action-links-live.yml", import.meta.url), "utf8");
  assert.match(workflow, /actions\/cache\/restore@v4/);
  assert.match(workflow, /update-action-link-health\.mjs/);
  assert.match(workflow, /action_link_health\.json/);
  assert.match(workflow, /actions\/cache\/save@v4/);
  assert.match(workflow, /pages deploy _site/);
  assert.match(workflow, /newly_escalated_patterns/);
  assert.match(workflow, /recovered_patterns/);
  assert.match(workflow, /state_reason:\s*"completed"/);
});
