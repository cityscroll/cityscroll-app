// Account-level digest rollup: multi-watch email → one consolidated send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAlerts, processAccountRollup, dryRunRollupForEmail, digestSendTestForEmail, consumeDigestJob, appendQueueDayLogEntry } from "../src/alerts.mjs";
import { buildDayLog } from "../src/lib/digest_ops.mjs";
import { buildDigestJobs } from "../src/lib/rollup.mjs";
import {
  buildDigestShadowHoldState,
  digestShadowId,
} from "../src/digest_shadow_hold.mjs";

const FIXTURE_NOW = new Date("2026-08-04T12:00:00Z");
const FIXTURE_TODAY = FIXTURE_NOW.toISOString().slice(0, 10);

function kv(map = {}) {
  return {
    get: async (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    put: async (k, v) => { map[k] = typeof v === "string" ? v : String(v); },
    delete: async (k) => { delete map[k]; },
    list: async (options = {}) => {
      const prefix = options.prefix || "";
      const keys = Object.keys(map).filter((k) => k.startsWith(prefix)).map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
    _map: map,
  };
}

const rowA = {
  request_id: "20260731001",
  agency_name: "DOE",
  short_title: "School construction services",
  additional_description_1: "Construction of school facilities.",
  pin: "P1",
  contract_amount: "2000000",
  due_date: "2099-01-01",
  start_date: "2026-07-31",
  section_name: "Procurement",
};
const rowB = {
  request_id: "20260731002",
  agency_name: "DOT",
  short_title: "Education data analysis",
  additional_description_1: "Analysis of education outcomes.",
  pin: "P2",
  contract_amount: "500000",
  due_date: "2099-01-01",
  start_date: "2026-07-31",
  section_name: "Procurement",
};

function makeEnv(subsStore, { live = true } = {}) {
  const sentEmails = [];
  const ALERT_STATE = kv({});
  const SUBS = kv(subsStore);
  const env = {
    ALERT_STATE,
    SUBS,
    ALERTS_LIVE: live ? "true" : "false",
    RESEND_API_KEY: "re-test",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
    HEARTBEAT_DAYS: "14",
    QUEUE_DIGESTS: "false",
  };
  return { env, sentEmails, ALERT_STATE, SUBS };
}

async function withMockFetch(sentEmails, rowForUrl, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes("api.resend.com/emails")) {
      sentEmails.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ id: "re-1" }) };
    }
    // SODA / open data: return different rows based on $q keyword when present.
    // Unknown keywords must return [] so "quiet" watches stay empty (not a full dump).
    if (u.includes("data.cityofnewyork.us") || u.includes("resource/")) {
      let rows = [];
      if (u.includes("construction")) rows = [rowA];
      else if (u.includes("education")) rows = [rowB];
      else if (u.includes("brooklyn")) rows = [rowA]; // meetings fixture when intentionally matched
      // else: empty (zzzznonexistentterm, bare scans, etc.)
      return { ok: true, json: async () => rows };
    }
    return { ok: true, json: async () => [] };
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("multi-watch same email: one rollup email, one send unit", async () => {
  const today = FIXTURE_TODAY;
  const subsStore = {
    "sub:rollup-a": JSON.stringify({
      email: "multi@example.com",
      lens: "money",
      filter: { keywords: ["construction"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
      lang: "en",
    }),
    "sub:rollup-b": JSON.stringify({
      email: "multi@example.com",
      lens: "money",
      filter: { keywords: ["education"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
      lang: "en",
    }),
  };
  const { env, sentEmails, ALERT_STATE } = makeEnv(subsStore, { live: true });

  await withMockFetch(sentEmails, null, async () => {
    const summary = await runAlerts(env, [], { now: FIXTURE_NOW });
    assert.equal(sentEmails.length, 1, "exactly one consolidated email");
    assert.equal(summary.sentThisRun, 1, "one send unit");
    const html = sentEmails[0].html;
    assert.match(html, /your daily digest/i);
    assert.match(html, /Manage watches|manage/i);
    assert.match(html, /Unsubscribe from all|unsubscribe/i);
    // Day log marks rollup
    const day = FIXTURE_TODAY;
    const dayLog = JSON.parse(await ALERT_STATE.get(`digest:daylog:${day}`));
    const rollups = dayLog.entries.filter((e) => e.kind === "rollup");
    assert.equal(rollups.length, 1, "daylog has one rollup entry");
    assert.equal(rollups[0].sendUnits, 1);
  });
});

test("single watch same email: still one single-path email (not rollup shell)", async () => {
  const today = FIXTURE_TODAY;
  const subsStore = {
    "sub:single-1": JSON.stringify({
      email: "solo@example.com",
      lens: "money",
      filter: { keywords: ["construction"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
      lang: "en",
    }),
  };
  const { env, sentEmails } = makeEnv(subsStore, { live: true });
  await withMockFetch(sentEmails, null, async () => {
    await runAlerts(env, [], { now: FIXTURE_NOW });
    assert.equal(sentEmails.length, 1);
    // Single path uses per-watch title, not "your daily digest"
    assert.doesNotMatch(sentEmails[0].html, /your daily digest/i);
  });
});

test("paused watch excluded from rollup active set → single path when only one remains", async () => {
  const today = FIXTURE_TODAY;
  const subsStore = {
    "sub:p1": JSON.stringify({
      email: "pause@example.com",
      lens: "money",
      filter: { keywords: ["construction"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
      paused: true,
    }),
    "sub:p2": JSON.stringify({
      email: "pause@example.com",
      lens: "money",
      filter: { keywords: ["education"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
    }),
  };
  const { env, sentEmails } = makeEnv(subsStore, { live: true });
  await withMockFetch(sentEmails, null, async () => {
    await runAlerts(env, [], { now: FIXTURE_NOW });
    assert.equal(sentEmails.length, 1);
    assert.doesNotMatch(sentEmails[0].html, /your daily digest/i);
  });
});

test("dryRunRollupForEmail: no Resend, returns rollup preview", async () => {
  const today = FIXTURE_TODAY;
  const subsStore = {
    "sub:d1": JSON.stringify({
      email: "dry@example.com",
      lens: "money",
      filter: { keywords: ["construction"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
    }),
    "sub:d2": JSON.stringify({
      email: "dry@example.com",
      lens: "money",
      filter: { keywords: ["education"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
    }),
  };
  const { env, sentEmails } = makeEnv(subsStore, { live: true });
  await withMockFetch(sentEmails, null, async () => {
    const out = await dryRunRollupForEmail(env, "dry@example.com");
    assert.equal(out.ok, true);
    assert.equal(out.rollup, true);
    assert.equal(out.mode, "rollup");
    assert.equal(out.wouldSend, true);
    assert.equal(out.dayLogPreview.kind, "rollup");
    assert.equal(sentEmails.length, 0, "dry-run never hits Resend");
  });
});

test("digestSendTestForEmail: live sends one rollup without advancing state by default", async () => {
  const today = FIXTURE_TODAY;
  const subsStore = {
    "sub:test-a": JSON.stringify({ email: "example@example.com", lens: "money", filter: { keywords: ["construction"] }, freq: "daily", createdAt: today }),
    "sub:test-b": JSON.stringify({ email: "example@example.com", lens: "money", filter: { keywords: ["education"] }, freq: "daily", createdAt: today }),
  };
  const { env, sentEmails, ALERT_STATE } = makeEnv(subsStore, { live: true });
  await withMockFetch(sentEmails, null, async () => {
    const out = await digestSendTestForEmail(env, "example@example.com", { live: true });
    assert.equal(out.mode, "rollup");
    assert.equal(out.wouldSend, true);
    assert.equal(out.manageUrlPresent, true);
    assert.equal(sentEmails.length, 1);
    assert.equal(await ALERT_STATE.get("seen:sub:test-a"), null);
    assert.equal(await ALERT_STATE.get("lastsent:sub:test-a"), null);
    assert.equal(await ALERT_STATE.get("stats:alltime:digest"), null, "probe send must not bump all-time digest stats");
    assert.equal(await ALERT_STATE.get(`stats:digest:${today}`), null, "probe send must not bump rolling digest stats");
    assert.equal(await ALERT_STATE.get(`hist:digest:${today}`), null, "probe send must not bump digest history");
    assert.match(sentEmails[0].html, /Manage watches/i);
  });
});

test("buildDayLog: rollup kind preserved", () => {
  const log = buildDayLog({
    day: "2026-07-31",
    results: [
      {
        kind: "rollup",
        sub: "account:ab***",
        emailRedacted: "ab***@ex.com",
        new: 3,
        noticeIds: ["1", "2", "3"],
        sent: true,
        sections: [{ sub: "sub:1", lens: "money", new: 3, action: "match" }],
      },
      {
        sub: "sub:solo",
        new: 1,
        noticeIds: ["9"],
        sent: true,
        action: "match",
        emailRedacted: "x***@y.co",
      },
    ],
  });
  assert.equal(log.entries.find((e) => e.kind === "rollup")?.noticeCount, 3);
  assert.equal(log.entries.find((e) => e.kind === "subscription")?.noticeCount, 1);
  assert.equal(log.sentCount, 2);
});

test("queue daylog append is fail-soft and reports success or failure", async () => {
  const day = "2026-08-04";
  const result = { sub: "sub:ab***", kind: "subscription", new: 1, found: 1, noticeIds: ["n1"], action: "match", sent: true };
  const good = kv({});
  const written = await appendQueueDayLogEntry({ ALERT_STATE: good }, day, result);
  assert.equal(written.ok, true);
  assert.equal(JSON.parse(await good.get(`digest:daylog:${day}`)).sentCount, 1);

  const failing = { get: async () => null, put: async () => { throw new Error("KV write down"); } };
  const failed = await appendQueueDayLogEntry({ ALERT_STATE: failing }, day, result);
  assert.deepEqual(failed, { ok: false, reason: "write-failed" });
});

test("multi-watch with only one matching section: subject names N watches, body lists all sections", async () => {
  const today = FIXTURE_TODAY;
  const subsStore = {
    "sub:one-hit": JSON.stringify({
      email: "partial@example.com",
      lens: "money",
      filter: { keywords: ["construction"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
      lang: "en",
    }),
    "sub:quiet-2": JSON.stringify({
      email: "partial@example.com",
      lens: "money",
      // Keyword that mock SODA never returns as a row title — stays quiet after seen seed.
      filter: { keywords: ["zzzznonexistentterm"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
      lang: "en",
    }),
    "sub:weekly-3": JSON.stringify({
      email: "partial@example.com",
      lens: "meetings",
      filter: { keywords: ["brooklyn"] },
      freq: "weekly",
      channel: "email",
      createdAt: today,
      lang: "en",
    }),
  };
  const { env, sentEmails } = makeEnv(subsStore, { live: true });
  // Seed seen empty so construction matches; force non-Monday weekly skip via process path.
  await withMockFetch(sentEmails, null, async () => {
    const summary = await runAlerts(env, [], { now: FIXTURE_NOW });
    assert.equal(sentEmails.length, 1, "one rollup email");
    assert.equal(summary.sentThisRun, 1);
    const mail = sentEmails[0];
    // Multi-watch subject even when only one section had content.
    assert.match(mail.subject, /\d+ new — 3 watches/);
    assert.doesNotMatch(mail.subject, /^CityScroll: \d+ new — contract money/);
    assert.match(mail.html, /your daily digest/i);
    assert.match(mail.html, /of 3 watches with updates/i);
    // Multi-watch TOC jump index for scan recovery.
    assert.match(mail.html, /data-rollup-toc="1"/);
    assert.match(mail.html, /In this email/i);
    // Quiet + weekly sections stay in the body as one-line quiet rows (not full chrome).
    assert.match(mail.html, /data-rollup-quiet="1"/);
    assert.match(mail.html, /no new matches|zzzznonexistentterm/i);
    // FIXTURE_NOW freezes wall clock so weekly skip path is deterministic (non-Monday).
    assert.match(mail.html, /weekly|Monday/i);
    assert.match(mail.html, /Unsubscribe from all|unsubscribe/i);
    assert.match(mail.html, /takes effect immediately|next digest/i);
  });
});

test("queue path: multi-watch account enqueues one rollup job and consumeDigestJob sends rollup chrome", async () => {
  const today = FIXTURE_TODAY;
  const subsStore = {
    "sub:q-a": JSON.stringify({
      email: "queue-multi@example.com",
      lens: "money",
      filter: { keywords: ["construction"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
    }),
    "sub:q-b": JSON.stringify({
      email: "queue-multi@example.com",
      lens: "money",
      filter: { keywords: ["education"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
    }),
  };
  const sentEmails = [];
  const queueJobs = [];
  const ALERT_STATE = kv({});
  const SUBS = kv(subsStore);
  const env = {
    ALERT_STATE,
    SUBS,
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "re-test",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
    HEARTBEAT_DAYS: "14",
    QUEUE_DIGESTS: "true",
    DIGEST_QUEUE: {
      send: async (job) => { queueJobs.push(job); },
    },
  };

  await withMockFetch(sentEmails, null, async () => {
    const summary = await runAlerts(env, [], { now: FIXTURE_NOW });
    assert.equal(summary.mode || summary.receipt?.mode, "queue");
    assert.equal(queueJobs.length, 1, "one account job");
    assert.equal(queueJobs[0].type, "rollup");
    assert.equal(queueJobs[0].keys.length, 2);

    // Fan-out → consumer (production scheduled path with QUEUE_DIGESTS=true).
    const result = await consumeDigestJob(env, queueJobs[0], { now: FIXTURE_NOW });
    assert.equal(result.kind, "rollup");
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].subject, /watches/);
    assert.match(sentEmails[0].html, /your daily digest/i);
    assert.match(sentEmails[0].html, /Manage watches|manage/i);
  });
});

test("queue path: type=rollup with only one key still uses rollup path (no single-watch fallback)", async () => {
  const today = FIXTURE_TODAY;
  const subsStore = {
    "sub:only-one": JSON.stringify({
      email: "fallback@example.com",
      lens: "money",
      filter: { keywords: ["construction"] },
      freq: "daily",
      channel: "email",
      createdAt: today,
    }),
  };
  const sentEmails = [];
  const ALERT_STATE = kv({});
  const SUBS = kv(subsStore);
  const env = {
    ALERT_STATE,
    SUBS,
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "re-test",
    TOKEN_SECRET: "s".repeat(32),
    CONFIRM_BASE: "https://api.cityscroll.org",
    MAX_PER_RUN: "25",
    MAX_SENDS_PER_DAY: "50",
    HEARTBEAT_DAYS: "14",
  };

  await withMockFetch(sentEmails, null, async () => {
    // Simulate a multi-watch rollup job where sibling keys no longer load.
    const result = await consumeDigestJob(env, {
      type: "rollup",
      email: "fallback@example.com",
      keys: ["sub:only-one", "sub:gone-sibling"],
    }, { now: FIXTURE_NOW });
    assert.equal(result.kind, "rollup");
    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].html, /your daily digest/i);
    assert.doesNotMatch(sentEmails[0].html, /^CityScroll — contract money/i);
  });
});

test("queue producer omits only the digest named by an active shadow hold", async () => {
  const heldKey = "sub:held";
  const eligibleKey = "sub:eligible";
  const subsStore = {
    [heldKey]: JSON.stringify({
      email: "held" + "@example.com", lens: "money", filter: {}, freq: "daily", channel: "email", createdAt: FIXTURE_TODAY,
    }),
    [eligibleKey]: JSON.stringify({
      email: "eligible" + "@example.com", lens: "money", filter: {}, freq: "daily", channel: "email", createdAt: FIXTURE_TODAY,
    }),
  };
  const queueJobs = [];
  const env = {
    ALERT_STATE: kv({}),
    SUBS: kv(subsStore),
    ALERTS_LIVE: "true",
    QUEUE_DIGESTS: "true",
    DIGEST_QUEUE: { send: async (job) => { queueJobs.push(job); } },
  };
  const heldId = await digestShadowId("digest", heldKey);
  const shadowHoldState = buildDigestShadowHoldState({
    summary: {
      run_day: FIXTURE_TODAY,
      status: "NEEDS_ATTENTION",
      ok: false,
      affected_digest_ids: [heldId],
    },
    now: `${FIXTURE_TODAY}T13:00:00.000Z`,
  });

  const summary = await runAlerts(env, [], {
    now: `${FIXTURE_TODAY}T13:00:00.000Z`,
    shadowHoldState,
  });
  assert.deepEqual(queueJobs.map((job) => job.key), [eligibleKey]);
  assert.equal(summary.results.filter((result) => result.skipped === "shadow-hold").length, 1);
  assert.equal(summary.shadowHold.active_count, 1);
  assert.equal(summary.receipt.skipped_reason, "queue_pending");
});

test("queue consumer acknowledges a newly held digest without rendering or sending", async () => {
  const key = "sub:held-after-enqueue";
  const sentEmails = [];
  const env = {
    ALERT_STATE: kv({}),
    SUBS: kv({
      [key]: JSON.stringify({
        email: "held" + "@example.com",
        lens: "money",
        filter: { keywords: ["construction"] },
        freq: "daily",
        channel: "email",
        createdAt: FIXTURE_TODAY,
      }),
    }),
    ALERTS_LIVE: "true",
    RESEND_API_KEY: "re-test",
    TOKEN_SECRET: "s".repeat(32),
  };
  const heldId = await digestShadowId("digest", key);
  const shadowHoldState = buildDigestShadowHoldState({
    summary: {
      run_day: FIXTURE_TODAY,
      status: "NEEDS_ATTENTION",
      ok: false,
      affected_digest_ids: [heldId],
    },
    now: `${FIXTURE_TODAY}T13:00:00.000Z`,
  });

  await withMockFetch(sentEmails, null, async () => {
    const result = await consumeDigestJob(env, { type: "sub", key }, {
      now: `${FIXTURE_TODAY}T13:00:00.000Z`,
      shadowHoldState,
    });
    assert.equal(result.skipped, "shadow-hold");
    assert.equal(result.sent, false);
    assert.equal(sentEmails.length, 0);
  });
});

test("dark-period hold blocks every producer job and an already-enqueued consumer job", async () => {
  const key = "sub:dark-period";
  const queueJobs = [];
  const sentEmails = [];
  const env = {
    ALERT_STATE: kv({}),
    SUBS: kv({
      [key]: JSON.stringify({
        email: "dark" + "@example.com",
        lens: "money",
        filter: { keywords: ["construction"] },
        freq: "daily",
        channel: "email",
        createdAt: FIXTURE_TODAY,
      }),
    }),
    ALERTS_LIVE: "true",
    QUEUE_DIGESTS: "true",
    DIGEST_QUEUE: { send: async (job) => { queueJobs.push(job); } },
    RESEND_API_KEY: "re-test",
    TOKEN_SECRET: "s".repeat(32),
  };
  const shadowHoldState = buildDigestShadowHoldState({
    summary: null,
    lastReadyRunDay: "2026-08-01",
    now: `${FIXTURE_TODAY}T13:00:00.000Z`,
  });

  const summary = await runAlerts(env, [], {
    now: `${FIXTURE_TODAY}T13:00:00.000Z`,
    shadowHoldState,
  });
  assert.deepEqual(queueJobs, []);
  assert.equal(summary.shadowHold.hold_all, true);
  assert.equal(summary.results.filter((result) => result.skipped === "shadow-hold").length, 1);
  assert.equal(summary.receipt.skipped_reason, "shadow_hold");

  await withMockFetch(sentEmails, null, async () => {
    const result = await consumeDigestJob(env, { type: "sub", key }, {
      now: `${FIXTURE_TODAY}T13:00:00.000Z`,
      shadowHoldState,
    });
    assert.equal(result.skipped, "shadow-hold");
    assert.equal(sentEmails.length, 0);
  });
});

test("buildDigestJobs: production-shaped multi-watch account is one rollup job", () => {
  const jobs = buildDigestJobs([
    { key: "sub:a", email: "owner@example.com", paused: false },
    { key: "sub:b", email: "owner@example.com", paused: false },
    { key: "sub:c", email: "owner@example.com", paused: false },
    { key: "sub:d", email: "owner@example.com", paused: false },
    { key: "sub:solo", email: "other@example.com", paused: false },
  ]);
  assert.equal(jobs.length, 2);
  const rollup = jobs.find((j) => j.type === "rollup");
  assert.ok(rollup);
  assert.equal(rollup.keys.length, 4);
  assert.equal(jobs.find((j) => j.type === "sub")?.key, "sub:solo");
});
