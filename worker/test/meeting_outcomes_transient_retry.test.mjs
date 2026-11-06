/**
 * A transient publisher failure in the first two reads of the daily Council
 * meeting-outcomes refresh (City Record notices, Legistar Events window) used
 * to fail the only scheduled attempt of the day. The stored view then aged past
 * its 36-hour serving limit and the static snapshot build refused to publish.
 *
 * These tests drive the real refresh with a publisher that fails once, then
 * the real 10:00 scheduled entrypoint against stored views of different ages.
 *
 * verify: node --test worker/test/meeting_outcomes_transient_retry.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  MEETING_OUTCOMES_KV_KEY,
  meetingOutcomesPublishedSincePrimary,
  refreshMeetingOutcomes,
} from "../src/lib/meeting_outcomes.mjs";

const TOKEN = "test-token-do-not-log";
const NOW = new Date("2026-11-06T08:00:08.000Z");
const PRIOR_VIEW = JSON.stringify({ generated_at: "2026-11-05T08:00:53.045Z", records: [] });

const NOTICE = {
  request_id: "20261104001",
  section_name: "Public Hearings and Meetings",
  type_of_notice_description: "Public Hearing",
  agency_name: "City Council",
  short_title: "11-04-26 Subcommittee on Land Use — Queens items",
  event_date: "2026-11-04T16:00:00.000",
  start_date: "2026-10-20",
};

const EVENT = {
  EventId: 22526,
  EventBodyName: "Subcommittee on Land Use",
  EventDate: "2026-11-04T00:00:00",
  EventInSiteURL: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22526",
};

function kv(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    async get(key) { return values.has(key) ? values.get(key) : null; },
    async put(key, value) { values.set(key, value); },
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * Publisher double. `failures` maps "notices" / "events" to a queue of
 * failures served before the healthy response.
 */
function publisher(failures = {}) {
  const calls = { notices: 0, events: 0 };
  const queues = {
    notices: [...(failures.notices || [])],
    events: [...(failures.events || [])],
  };
  const serve = async (kind, healthy) => {
    calls[kind] += 1;
    const next = queues[kind].shift();
    if (next === "throw") throw new TypeError("fetch failed");
    if (next) return next();
    return healthy();
  };
  const fetchImpl = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === "/resource/dg92-zbpx.json") return serve("notices", () => json([NOTICE]));
    if (pathname === "/v1/nyc/Events") return serve("events", () => json([EVENT]));
    return json([]);
  };
  return { calls, fetchImpl };
}

function retryOptions() {
  const waits = [];
  return { waits, readRetry: { waitFn: async (ms) => { waits.push(ms); } } };
}

function env(store) {
  return { ALERT_STATE: store, LEGISTAR_API_TOKEN: TOKEN };
}

test("a City Record gateway failure on the first read no longer fails the day's refresh", async () => {
  const store = kv({ [MEETING_OUTCOMES_KV_KEY]: PRIOR_VIEW });
  const source = publisher({ notices: [() => new Response("gateway", { status: 503 })] });
  const { waits, readRetry } = retryOptions();

  const result = await refreshMeetingOutcomes(env(store), source.fetchImpl, NOW, { readRetry });

  assert.equal(result.status, "success");
  assert.equal(source.calls.notices, 2);
  assert.deepEqual(waits, [1_000]);
  const published = JSON.parse(store.values.get(MEETING_OUTCOMES_KV_KEY));
  assert.ok(Date.parse(published.generated_at) > Date.parse("2026-11-05T08:00:53.045Z"));
  assert.equal(published.counts.notices, 1);
});

test("a dropped City Record connection is retried", async () => {
  const store = kv({ [MEETING_OUTCOMES_KV_KEY]: PRIOR_VIEW });
  const source = publisher({ notices: ["throw"] });
  const { readRetry } = retryOptions();

  const result = await refreshMeetingOutcomes(env(store), source.fetchImpl, NOW, { readRetry });

  assert.equal(result.status, "success");
  assert.equal(source.calls.notices, 2);
});

test("a transient Legistar Events failure is retried before the refresh gives up", async () => {
  const store = kv({ [MEETING_OUTCOMES_KV_KEY]: PRIOR_VIEW });
  const source = publisher({ events: [() => new Response("unavailable", { status: 502 }), "throw"] });
  const { waits, readRetry } = retryOptions();

  const result = await refreshMeetingOutcomes(env(store), source.fetchImpl, NOW, { readRetry });

  assert.equal(result.status, "success");
  assert.equal(source.calls.events, 3);
  assert.deepEqual(waits, [1_000, 3_000]);
  assert.equal(JSON.parse(store.values.get(MEETING_OUTCOMES_KV_KEY)).counts.event_rows, 1);
});

test("a persistent failure stays bounded and keeps the last-known-good view", async () => {
  const store = kv({ [MEETING_OUTCOMES_KV_KEY]: PRIOR_VIEW });
  const always = () => new Response("down", { status: 504 });
  const source = publisher({ notices: [always, always, always, always] });
  const { readRetry } = retryOptions();

  await assert.rejects(
    refreshMeetingOutcomes(env(store), source.fetchImpl, NOW, { readRetry }),
    /City Record notices 504/,
  );
  assert.equal(source.calls.notices, 3);
  assert.equal(store.values.get(MEETING_OUTCOMES_KV_KEY), PRIOR_VIEW);
});

test("a rejected request and a long publisher Retry-After are not retried", async () => {
  const badRequest = publisher({ notices: [() => new Response("bad query", { status: 400 })] });
  await assert.rejects(
    refreshMeetingOutcomes(env(kv()), badRequest.fetchImpl, NOW, retryOptions()),
    /City Record notices 400/,
  );
  assert.equal(badRequest.calls.notices, 1);

  const forbidden = publisher({ events: [() => new Response("no", { status: 403 })] });
  await assert.rejects(
    refreshMeetingOutcomes(env(kv()), forbidden.fetchImpl, NOW, retryOptions()),
    /legistar-events-forbidden-403/,
  );
  assert.equal(forbidden.calls.events, 1);

  const throttled = publisher({
    events: [() => new Response("slow down", { status: 429, headers: { "Retry-After": "600" } })],
  });
  await assert.rejects(
    refreshMeetingOutcomes(env(kv()), throttled.fetchImpl, NOW, retryOptions()),
    /legistar-events-rate-limited-429/,
  );
  assert.equal(throttled.calls.events, 1);
});

test("the primary-window check reads the stored view's own generation clock", async () => {
  const at10 = new Date("2026-11-06T10:00:00.000Z");
  const yesterday = await meetingOutcomesPublishedSincePrimary(env(kv({ [MEETING_OUTCOMES_KV_KEY]: PRIOR_VIEW })), at10);
  assert.equal(yesterday.published, false);
  assert.equal(yesterday.since, "2026-11-06T08:00:00.000Z");

  const today = await meetingOutcomesPublishedSincePrimary(env(kv({
    [MEETING_OUTCOMES_KV_KEY]: JSON.stringify({ generated_at: "2026-11-06T08:00:53.045Z" }),
  })), at10);
  assert.equal(today.published, true);

  assert.equal((await meetingOutcomesPublishedSincePrimary(env(kv()), at10)).published, false);
  assert.equal((await meetingOutcomesPublishedSincePrimary(env(kv({
    [MEETING_OUTCOMES_KV_KEY]: "{not json",
  })), at10)).published, false);
});

// --- 10:00 same-day re-attempt through the committed scheduled entrypoint ---

const SOURCE = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");

function scheduledWorker(overrides = {}) {
  const calls = [];
  const acquisitions = [];
  const logs = [];
  const context = {
    Date,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: () => { throw new Error("unexpected scheduled test fetch"); },
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  };
  for (const match of SOURCE.matchAll(/import\s+\{([^}]+)\}\s+from\s+"[^"]+";/g)) {
    for (const entry of match[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const name = entry.split(/\s+as\s+/).at(-1);
      context[name] = async (...args) => {
        calls.push(name);
        if (overrides[name]) return overrides[name](...args);
        if (name === "withWorkerAcquisitionReceipt") {
          acquisitions.push(args[1]);
          return args[3](args[4]?.signal);
        }
        return {};
      };
    }
  }
  vm.runInNewContext(SOURCE.replace(/^import[\s\S]*?;\s*/gm, "")
    .replace("export default", "globalThis.worker ="), context);
  const ctx = { waitUntil() {} };
  return {
    calls,
    acquisitions,
    logs,
    run: (cron, runEnv, event = {}) => context.worker.runScheduled({ cron, ...event }, runEnv, ctx),
  };
}

const TEN = new Date("2026-11-06T10:00:00.000Z").getTime();
const shadowOverrides = {
  meetingOutcomesPublishedSincePrimary,
  persistDigestShadowStarted: () => ({ status: "STARTED", write_accepted: true }),
  createDigestShadowRebuild: () => ({ run_id: "digest-shadow-rebuild:test", status: "queued" }),
  markDigestShadowRebuildQueued: () => ({ write_accepted: true }),
};

test("the 10:00 window re-attempts the Council refresh when today's 08:00 run did not publish", async () => {
  const worker = scheduledWorker(shadowOverrides);
  await worker.run("0 10 * * *", env(kv({ [MEETING_OUTCOMES_KV_KEY]: PRIOR_VIEW })), { scheduledTime: TEN });

  assert.equal(worker.calls.filter((name) => name === "refreshMeetingOutcomes").length, 1);
  assert.ok(worker.acquisitions.includes("nyc-council-legistar"));
  // The rehearsal hand-off is unchanged and completes before the re-attempt.
  assert.ok(worker.calls.indexOf("markDigestShadowRebuildQueued") < worker.calls.indexOf("refreshMeetingOutcomes"));
  assert.ok(worker.logs.some(([label]) => label === "meeting outcomes re-attempt:"));
});

test("the 10:00 window leaves a view that today's 08:00 run published alone", async () => {
  const worker = scheduledWorker(shadowOverrides);
  await worker.run("0 10 * * *", env(kv({
    [MEETING_OUTCOMES_KV_KEY]: JSON.stringify({ generated_at: "2026-11-06T08:00:53.045Z" }),
  })), { scheduledTime: TEN });

  assert.equal(worker.calls.includes("refreshMeetingOutcomes"), false);
  assert.ok(worker.calls.includes("markDigestShadowRebuildQueued"));
});

test("the 10:00 re-attempt also runs when the rehearsal was already queued, and never under a cost probe", async () => {
  const queued = scheduledWorker(shadowOverrides);
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({
          status: "STARTED",
          summary_json: JSON.stringify({ phase: "rebuild_queued", rebuild_run_id: "digest-shadow-rebuild:earlier" }),
        }),
      }),
    }),
  };
  await queued.run("0 10 * * *", { ...env(kv({ [MEETING_OUTCOMES_KV_KEY]: PRIOR_VIEW })), DB: db }, { scheduledTime: TEN });
  assert.equal(queued.calls.includes("persistDigestShadowStarted"), false);
  assert.equal(queued.calls.filter((name) => name === "refreshMeetingOutcomes").length, 1);

  const probe = scheduledWorker(shadowOverrides);
  await probe.run("0 10 * * *", env(kv({ [MEETING_OUTCOMES_KV_KEY]: PRIOR_VIEW })), { scheduledTime: TEN, costProbe: true });
  assert.equal(probe.calls.includes("refreshMeetingOutcomes"), false);
});
