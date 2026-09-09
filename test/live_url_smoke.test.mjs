// Characterization tests for the post-deploy live-URL smoke guard.
// Regression anchor: 2026-07-30 cityscroll.org ERR_TOO_MANY_REDIRECTS while deploy
// reported success (GitHub Pages CNAME 301 loop). Class boundaries: non-200, empty
// body, redirect loop, 200-with-error-page, healthy content.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  API_HEALTH_MARKER,
  CONTENT_MARKER,
  CANONICAL_MEETING_TARGETS,
  DEFAULT_TARGETS,
  meetingDocumentMarker,
  MEETING_READ_MODEL_PATH,
  publishedMeetingTargets,
  resolvePublishedMeetingTargets,
  PAGES_DEV_TARGETS,
  POST_FLIP_TARGETS,
  TARGET_SETS,
  TARGET_SET_NAMES,
  cacheBustUrl,
  classifyProbe,
  createFixtureFetch,
  formatFailure,
  formatStatusChain,
  probeUrl,
  resolveTargetSet,
  runSmoke,
  targetsFromCli,
} from "../tools/live_url_smoke.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const fieldCase = JSON.parse(read("./fixtures/live_url_smoke/field-case-2026-07-30.json"));
const variants = JSON.parse(read("./fixtures/live_url_smoke/variants.json"));

test("field-case fixture documents the 2026-07-30 redirect-loop outage verbatim", () => {
  assert.equal(fieldCase.id, "cityscroll-redirect-loop-2026-07-30");
  assert.match(fieldCase.description, /2026-07-30/);
  assert.match(fieldCase.description, /ERR_TOO_MANY_REDIRECTS/);
  assert.match(fieldCase.description, /deploy pipeline reported success/);
  assert.match(fieldCase.description, /GitHub Pages CNAME/);
  assert.equal(fieldCase.observed, "ERR_TOO_MANY_REDIRECTS");
  assert.deepEqual(fieldCase.hosts, ["https://cityscroll.org/", "https://crol-list.org/"]);
  assert.equal(fieldCase.redirect_loop["https://cityscroll.org/"].status, 301);
  assert.equal(fieldCase.redirect_loop["https://cityscroll.org/"].location, "https://crol-list.org/");
  assert.equal(fieldCase.redirect_loop["https://crol-list.org/"].status, 301);
  assert.equal(fieldCase.redirect_loop["https://crol-list.org/"].location, "https://cityscroll.org/");
});

test("field-case redirect loop fails with URL + status chain + body snippet diagnostic", async () => {
  const fetchImpl = createFixtureFetch(fieldCase.redirect_loop);
  const result = await probeUrl("https://cityscroll.org/", {
    fetchImpl,
    cacheBust: true,
    now: 1_700_000_000_000,
  });

  assert.equal(result.classification.ok, false);
  assert.match(result.classification.reason, /redirect loop/i);

  const diagnostic = formatFailure({
    url: result.url,
    statusChain: result.statusChain,
    body: result.body,
    reason: result.classification.reason,
  });
  assert.match(diagnostic, /LIVE URL SMOKE FAIL: https:\/\/cityscroll\.org\//);
  assert.match(diagnostic, /status chain:/);
  assert.match(diagnostic, /301/);
  assert.match(diagnostic, /body snippet:/);
  // Chain must name both hosts involved in the loop.
  const chain = formatStatusChain(result.statusChain);
  assert.match(chain, /cityscroll\.org|crol-list\.org/);
});

test("class-boundary fixtures pin fail/pass shapes", async () => {
  for (const c of variants.cases) {
    const fetchImpl = createFixtureFetch(c.hops);
    const result = await probeUrl(c.url || "https://cityscroll.org/", {
      fetchImpl,
      cacheBust: false,
    });
    if (c.expect === "pass") {
      assert.equal(result.classification.ok, true, `${c.id}: ${result.classification.reason}`);
    } else {
      assert.equal(result.classification.ok, false, `${c.id} should fail`);
      assert.match(
        result.classification.reason,
        new RegExp(c.reason_match, "i"),
        `${c.id}: got ${result.classification.reason}`,
      );
    }
  }
});

test("classifyProbe rejects empty body, non-200, and marker-less error shells", () => {
  assert.equal(
    classifyProbe({ statusChain: [{ status: 200 }], finalStatus: 200, body: "" }).ok,
    false,
  );
  assert.match(
    classifyProbe({ statusChain: [{ status: 502 }], finalStatus: 502, body: "Bad gateway" }).reason,
    /final status 502/,
  );
  assert.match(
    classifyProbe({
      statusChain: [{ status: 200 }],
      finalStatus: 200,
      body: "<title>404 Not Found</title><p>Page not found</p>",
    }).reason,
    /error-page body/,
  );
  assert.equal(
    classifyProbe({
      statusChain: [{ status: 200 }],
      finalStatus: 200,
      body: "<title>CityScroll</title>",
      marker: CONTENT_MARKER,
    }).ok,
    true,
  );
});

test("meeting deploy markers cover both source types and require the exact id", () => {
  const shell = '<title>CityScroll · track RFPs, rezonings, meetings</title><main data-civic-object-kind="meeting" data-meeting-id="meeting:city_record:other"></main>';
  assert.equal(CANONICAL_MEETING_TARGETS.length, 2);
  assert.deepEqual(
    CANONICAL_MEETING_TARGETS.map(({ meetingId }) => meetingId.split(":")[1]),
    ["city_record", "community_board"],
  );
  for (const { meetingId } of CANONICAL_MEETING_TARGETS) {
    const marker = meetingDocumentMarker(meetingId);
    const document = `<title>Meeting record · CityScroll</title><main data-civic-object-kind="meeting" data-meeting-id="${meetingId}"></main>`;
    assert.equal(marker.test(document), true, meetingId);
    assert.equal(marker.test(shell), false, meetingId);
    assert.equal(marker.test(document.replace(meetingId, `${meetingId}-other`)), false, meetingId);
  }
});

test("field case: live smoke fails on unsubstituted __I18N_ASSET_VERSION__ (and any __TOKEN__)", () => {
  // Symptom (2026-07-30): homepage served src="i18n.js?v=__I18N_ASSET_VERSION__".
  const result = classifyProbe({
    statusChain: [{ status: 200 }],
    finalStatus: 200,
    body: '<title>CityScroll</title><script src="i18n.js?v=__I18N_ASSET_VERSION__"></script>',
    marker: CONTENT_MARKER,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unsubstituted build placeholder __I18N_ASSET_VERSION__/);
  assert.equal(
    classifyProbe({
      statusChain: [{ status: 200 }],
      finalStatus: 200,
      body: '<title>CityScroll</title><script src="i18n.js?v=c4609cdfa552"></script>',
      marker: CONTENT_MARKER,
    }).ok,
    true,
  );
});

test("cache-bust query is applied so stale redirect caches cannot false-green", () => {
  const busted = cacheBustUrl("https://cityscroll.org/about.html", 42);
  assert.match(busted, /_smoke=42/);
  assert.match(busted, /^https:\/\/cityscroll\.org\/about\.html\?/);
});

test("runSmoke passes quickly when content is healthy", async () => {
  const healthy = variants.cases.find((c) => c.id === "healthy-cityscroll-200");
  const fetchImpl = createFixtureFetch(healthy.hops);
  let sleeps = 0;
  const result = await runSmoke({
    targets: [{ id: "apex", url: "https://cityscroll.org/", marker: CONTENT_MARKER }],
    fetchImpl,
    timeoutMs: 60_000,
    intervalMs: 1_000,
    cacheBust: false,
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(sleeps, 0);
});

test("runSmoke retries then fails with named diagnostics after the window", async () => {
  const fetchImpl = createFixtureFetch([{ status: 503, body: "Service Unavailable" }]);
  let now = 0;
  const result = await runSmoke({
    targets: [{ id: "apex", url: "https://cityscroll.org/" }],
    fetchImpl,
    timeoutMs: 100,
    intervalMs: 40,
    cacheBust: false,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  assert.equal(result.ok, false);
  assert.ok(result.attempts >= 2, `expected retries, got ${result.attempts}`);
  assert.match(result.failures.join("\n"), /LIVE URL SMOKE FAIL: https:\/\/cityscroll\.org\//);
  assert.match(result.failures.join("\n"), /503/);
});

test("default targets cover both public apex hosts, www, and a deep route", () => {
  const urls = DEFAULT_TARGETS.map((t) => t.url);
  assert.ok(urls.includes("https://cityscroll.org/"));
  assert.ok(urls.includes("https://www.cityscroll.org/"));
  assert.ok(urls.includes("https://crol-list.org/"));
  assert.ok(urls.some((u) => u.includes("about.html")));
  // Parallel host and post-flip matrix stay off the deploy default.
  assert.ok(!urls.includes("https://cityscroll.pages.dev/"));
  assert.ok(!urls.includes("https://api.cityscroll.org/health"));
});

test("named smoke target sets: pages-dev and post-flip are selectable and dormant", () => {
  assert.deepEqual([...TARGET_SET_NAMES].sort(), ["default", "pages-dev", "post-flip"].sort());
  assert.equal(TARGET_SETS.default, DEFAULT_TARGETS);
  assert.equal(resolveTargetSet("default"), DEFAULT_TARGETS);
  assert.equal(resolveTargetSet("pages-dev"), PAGES_DEV_TARGETS);
  assert.equal(resolveTargetSet("post-flip"), POST_FLIP_TARGETS);
  assert.equal(resolveTargetSet("PAGES-DEV"), PAGES_DEV_TARGETS);

  const pagesDevUrls = PAGES_DEV_TARGETS.map((t) => t.url);
  assert.deepEqual(pagesDevUrls, [
    "https://cityscroll.pages.dev/",
    "https://cityscroll.pages.dev/about.html",
  ]);

  const postFlipUrls = POST_FLIP_TARGETS.map((t) => t.url);
  assert.deepEqual(postFlipUrls, [
    "https://cityscroll.org/",
    "https://www.cityscroll.org/",
    "https://cityscroll.org/about.html",
    "https://crol-list.org/",
    "https://api.cityscroll.org/health",
    "https://api.cityscroll.org/stats",
    "https://cityscroll.pages.dev/",
  ]);
  const api = POST_FLIP_TARGETS.find((t) => t.id === "post-flip-api-health");
  assert.equal(api.marker, API_HEALTH_MARKER);
  const stats = POST_FLIP_TARGETS.find((t) => t.id === "post-flip-api-stats");
  assert.match(String(stats.marker), /public-stats/);
  const apex = POST_FLIP_TARGETS.find((t) => t.id === "post-flip-cityscroll-apex");
  assert.deepEqual([...apex.requireAbsentHeaders], ["x-github-request-id"]);
  const www = POST_FLIP_TARGETS.find((t) => t.id === "post-flip-cityscroll-www");
  assert.deepEqual([...www.requireAbsentHeaders], ["x-github-request-id"]);

  assert.throws(() => resolveTargetSet("not-a-set"), /unknown smoke target set/);
});

test("targetsFromCli selects named sets; --url and --base-url still take precedence", () => {
  assert.equal(targetsFromCli({}), DEFAULT_TARGETS);
  assert.equal(targetsFromCli({ targetSet: "pages-dev" }), PAGES_DEV_TARGETS);
  assert.equal(targetsFromCli({ targetSet: "post-flip" }), POST_FLIP_TARGETS);

  const fromBase = targetsFromCli({ baseUrl: "https://cityscroll.pages.dev", targetSet: "post-flip" });
  assert.deepEqual(
    fromBase.map((t) => t.url),
    [
      "https://cityscroll.pages.dev/",
      "https://cityscroll.pages.dev/about.html",
      ...CANONICAL_MEETING_TARGETS.map(({ meetingId }) => `https://cityscroll.pages.dev/meetings/${encodeURIComponent(meetingId)}/`),
    ],
  );

  const fromUrls = targetsFromCli({
    urls: ["https://example.test/x"],
    targetSet: "pages-dev",
  });
  assert.equal(fromUrls[0].url, "https://example.test/x");
  assert.equal(fromUrls[0].marker, CONTENT_MARKER);
});

test("post-flip header assertion fails when x-github-request-id is still present", () => {
  const withGithubHeader = classifyProbe({
    statusChain: [{ status: 200 }],
    finalStatus: 200,
    body: "<title>CityScroll</title>",
    marker: CONTENT_MARKER,
    finalHeaders: { "x-github-request-id": "ABC123" },
    requireAbsentHeaders: ["x-github-request-id"],
  });
  assert.equal(withGithubHeader.ok, false);
  assert.match(withGithubHeader.reason, /x-github-request-id/i);

  const pagesPrimary = classifyProbe({
    statusChain: [{ status: 200 }],
    finalStatus: 200,
    body: "<title>CityScroll</title>",
    marker: CONTENT_MARKER,
    finalHeaders: { "cf-ray": "xyz" },
    requireAbsentHeaders: ["x-github-request-id"],
  });
  assert.equal(pagesPrimary.ok, true);

  const apiHealth = classifyProbe({
    statusChain: [{ status: 200 }],
    finalStatus: 200,
    body: "cityscroll-worker ok",
    marker: API_HEALTH_MARKER,
  });
  assert.equal(apiHealth.ok, true);
});

test("probeUrl applies requireAbsentHeaders from the target", async () => {
  const fetchImpl = createFixtureFetch([
    {
      status: 200,
      body: "<title>CityScroll</title>",
      headers: { "x-github-request-id": "still-on-pages" },
    },
  ]);
  const result = await probeUrl("https://cityscroll.org/", {
    fetchImpl,
    cacheBust: false,
    requireAbsentHeaders: ["x-github-request-id"],
  });
  assert.equal(result.classification.ok, false);
  assert.match(result.classification.reason, /x-github-request-id/i);
});

test("Cloudflare Pages and deploy-worker run the live-URL smoke after deploy", () => {
  const pages = readFileSync(new URL("../.github/workflows/deploy-cloudflare-pages.yml", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../.github/workflows/deploy-worker.yml", import.meta.url), "utf8");

  for (const [name, workflow] of [["deploy-cloudflare-pages", pages], ["deploy-worker", worker]]) {
    assert.match(workflow, /live_url_smoke\.mjs/, `${name} must invoke the smoke tool`);
    assert.match(workflow, /needs:\s*deploy/, `${name} smoke job must run after deploy`);
    // Failure must fail the workflow (default step failure); no continue-on-error.
    const smokeBlock = workflow.slice(workflow.indexOf("live_url_smoke"));
    assert.doesNotMatch(
      smokeBlock.slice(0, 400),
      /continue-on-error:\s*true/,
      `${name} must not soft-pass smoke failures`,
    );
    // Deploy gates must not auto-select the post-flip matrix (owner flip is separate).
    assert.doesNotMatch(
      smokeBlock.slice(0, 600),
      /--set\s+post-flip/,
      `${name} must not run post-flip set until cutover is authorized`,
    );
  }
});

// Published meeting resolution and strict page assertions.
const BASE = "https://published.example";
const rows = [
  { source_system: "council", meeting_id: "meeting:council:1", title: "Council" },
  { source_system: "community_board", meeting_id: "meeting:community_board:https://board.example/event/health/?a=1&b='2'", title: "Health & City's <Transport> [2026]" },
  { source_system: "city_record", meeting_id: "meeting:city_record:current", title: "Public hearing" },
  { source_system: "community_board", meeting_id: "meeting:community_board:later", title: "Later board meeting" },
  { source_system: "city_record", meeting_id: "meeting:city_record:later", title: "Later hearing" },
];
const model = (items = rows) => ({ schema: "cityscroll.shared_meeting_read_model.v1", rows: items });
const response = (status, body) => ({ status, text: async () => body, headers: { get: () => null } });
const esc = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&#39;");
const document = (row) => `<title>${esc(row.title)} · CityScroll</title><main data-civic-object-kind="meeting" data-meeting-id="${esc(row.meeting_id)}"></main>`;
const cleanUrl = (url) => { const parsed = new URL(url); parsed.searchParams.delete("_smoke"); return parsed.href; };
function siteFetch({ readModel = model(), pageResponse } = {}) {
  const requests = [];
  const fetchImpl = async (url) => {
    const key = cleanUrl(url);
    requests.push(key);
    if (key === `${BASE}${MEETING_READ_MODEL_PATH}`) return response(200, JSON.stringify(readModel));
    const row = rows.find((item) => key === `${BASE}/meetings/${encodeURIComponent(item.meeting_id)}/`);
    if (row) return pageResponse?.(row) ?? response(200, document(row));
    if (key === `${BASE}/` || key === `${BASE}/about.html`) return response(200, "<title>CityScroll</title>");
    return response(404, "Page not found");
  };
  return { requests, fetchImpl };
}

test("resolver chooses the first published record of each family and encodes the complete ID", () => {
  const targets = publishedMeetingTargets(model(), BASE);
  assert.deepEqual(targets.map((item) => item.meetingId), [rows[2].meeting_id, rows[1].meeting_id]);
  for (const target of targets) {
    const row = rows.find((item) => item.meeting_id === target.meetingId);
    assert.equal(target.url, `${BASE}/meetings/${encodeURIComponent(row.meeting_id)}/`);
    assert.equal(target.marker.test(document(row)), true);
    assert.equal(target.marker.test(document({ ...row, title: "Different meeting" })), false);
    assert.equal(target.marker.test(document({ ...row, meeting_id: `${row.meeting_id}-other` })), false);
    assert.equal(target.marker.test(document(row).replace('data-civic-object-kind="meeting"', 'data-civic-object-kind="notice"')), false);
  }
});

test("resolver keeps a URL-shaped ID's terminal slash inside the encoded route segment", () => {
  const row = { ...rows[1], meeting_id: "meeting:community_board:https://board.example/event/transport/" };
  const target = publishedMeetingTargets(model([rows[2], row]), BASE)[1];
  assert.ok(target.url.endsWith("transport%2F/"));
  assert.equal(decodeURIComponent(new URL(target.url).pathname.split("/")[2]), row.meeting_id);
});

test("a readable model missing either family fails instead of using historical IDs", async () => {
  for (const family of ["community_board", "city_record"]) {
    const readModel = model(rows.filter((row) => row.source_system !== family));
    await assert.rejects(resolvePublishedMeetingTargets(BASE, {
      fetchImpl: async () => response(200, JSON.stringify(readModel)),
    }), new RegExp(`no published ${family} meeting`));
  }
});

test("a malformed first record fails with its ID instead of choosing the next record", () => {
  for (const bad of [{ ...rows[1], title: "" }, { ...rows[1], meeting_id: "meeting:city_record:wrong-family" }]) {
    assert.throws(() => publishedMeetingTargets(model([bad, ...rows]), BASE), (error) => {
      assert.match(error.message, /invalid first published community_board meeting/);
      assert.ok(error.message.includes(bad.meeting_id));
      return true;
    });
  }
});

test("unreadable models use documented fallbacks with the failed source and resolved IDs", async () => {
  for (const fetchImpl of [
    async () => response(503, "unavailable"),
    async () => response(200, "not JSON"),
    async () => response(200, JSON.stringify({ rows: [] })),
    async () => { throw new Error("network unavailable"); },
  ]) {
    const targets = await resolvePublishedMeetingTargets(BASE, { fetchImpl });
    assert.deepEqual(targets.map((item) => item.meetingId), CANONICAL_MEETING_TARGETS.map((item) => item.meetingId));
    for (const target of targets) {
      assert.ok(target.resolutionWarning.includes(`${BASE}${MEETING_READ_MODEL_PATH}`));
      assert.ok(target.resolutionWarning.includes(target.meetingId));
      assert.match(target.resolutionWarning, /historical fallback/);
    }
  }
});

test("model reads respect the existing request timeout", async () => {
  const targets = await resolvePublishedMeetingTargets(BASE, {
    requestTimeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("request timed out")), { once: true });
    }),
  });
  assert.match(targets[0].resolutionWarning, /request timed out/);
});

test("smoke resolves both families once per host and asserts the published pages", async () => {
  const fixture = siteFetch();
  const result = await runSmoke({ targets: targetsFromCli({ baseUrl: BASE }), fetchImpl: fixture.fetchImpl, timeoutMs: 0 });
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.results.length, 4);
  assert.equal(fixture.requests.filter((url) => url === `${BASE}${MEETING_READ_MODEL_PATH}`).length, 1);
  assert.deepEqual(result.results.filter((item) => item.meetingId).map((item) => item.meetingId), [rows[2].meeting_id, rows[1].meeting_id]);
  assert.ok(result.results.every((item) => !item.resolutionWarning));
});

test("a broken first published page fails and names its ID without trying later or historical meetings", async () => {
  for (const pageResponse of [
    (row) => row === rows[1] ? response(404, "Page not found") : undefined,
    (row) => row === rows[1] ? response(200, document({ ...row, title: "Wrong title" })) : undefined,
  ]) {
    const fixture = siteFetch({ pageResponse });
    const result = await runSmoke({ targets: targetsFromCli({ baseUrl: BASE }), fetchImpl: fixture.fetchImpl, timeoutMs: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.ok(result.failures[0].includes(rows[1].meeting_id));
    assert.ok(result.failures[0].includes(rows[1].title));
    assert.ok(!fixture.requests.some((url) => url.includes(encodeURIComponent(rows[3].meeting_id))));
    assert.ok(!fixture.requests.some((url) => CANONICAL_MEETING_TARGETS.some((item) => url.includes(encodeURIComponent(item.meetingId)))));
  }
});

test("a missing family remains a smoke failure even if historical pages could render", async () => {
  const fixture = siteFetch({ readModel: model([rows[2]]) });
  const result = await runSmoke({ targets: targetsFromCli({ baseUrl: BASE }), fetchImpl: fixture.fetchImpl, timeoutMs: 0 });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), /no published community_board meeting/);
  assert.ok(!fixture.requests.some((url) => url.includes("/meetings/")));
});

test("each retry resolves the current publication again", async () => {
  let clock = 0;
  let modelReads = 0;
  const fixture = siteFetch({ pageResponse: (row) => row === rows[1] ? response(404, "Page not found") : undefined });
  const fetchImpl = async (url) => {
    if (cleanUrl(url) === `${BASE}${MEETING_READ_MODEL_PATH}`) {
      modelReads += 1;
      return response(200, JSON.stringify(model(modelReads === 1 ? rows : rows.filter((row) => row !== rows[1]))));
    }
    return fixture.fetchImpl(url);
  };
  const result = await runSmoke({ targets: targetsFromCli({ baseUrl: BASE }), fetchImpl,
    timeoutMs: 10, intervalMs: 1, now: () => clock, sleep: async (ms) => { clock += ms; } });
  assert.equal(result.ok, true, result.failures.join("\n"));
  assert.equal(result.attempts, 2);
  assert.equal(modelReads, 2);
  assert.equal(result.results.at(-1).meetingId, rows[3].meeting_id);
});

test("an explicit URL never triggers meeting resolution", async () => {
  const requests = [];
  const result = await runSmoke({ targets: targetsFromCli({ urls: [`${BASE}/custom`] }), timeoutMs: 0,
    fetchImpl: async (url) => { requests.push(cleanUrl(url)); return response(200, "CityScroll"); } });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [`${BASE}/custom`]);
});

test("fallback pages still need the exact historical ID, title, and meeting marker", async () => {
  for (const valid of [true, false]) {
    const result = await runSmoke({ targets: targetsFromCli({ baseUrl: BASE }), timeoutMs: 0,
      fetchImpl: async (url) => {
        const key = cleanUrl(url);
        if (key.endsWith(MEETING_READ_MODEL_PATH)) return response(503, "unavailable");
        const target = CANONICAL_MEETING_TARGETS.find((item) => key.includes(encodeURIComponent(item.meetingId)));
        if (target) return response(200, valid ? document({ meeting_id: target.meetingId, title: target.meetingTitle }) : "<title>CityScroll</title>");
        return response(200, "CityScroll");
      } });
    assert.equal(result.ok, valid);
    assert.equal(result.results.filter((item) => item.resolutionWarning).length, 2);
    if (!valid) {
      for (const target of CANONICAL_MEETING_TARGETS) assert.ok(result.failures.join("\n").includes(target.meetingId));
    }
  }
});
