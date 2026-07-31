// Account-level digest rollup: multi-watch email → one consolidated send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAlerts, processAccountRollup, dryRunRollupForEmail, digestSendTestForEmail } from "../src/alerts.mjs";
import { buildDayLog } from "../src/lib/digest_ops.mjs";

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
    if (u.includes("data.cityofnewyork.us") || u.includes("resource/")) {
      let rows = [rowA, rowB];
      if (u.includes("construction") || (options == null && u.includes("construction"))) {
        rows = [rowA];
      }
      // URLSearchParams in query string
      if (u.includes("construction")) rows = [rowA];
      else if (u.includes("education")) rows = [rowB];
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
  const today = new Date().toISOString().slice(0, 10);
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
    const summary = await runAlerts(env, []);
    assert.equal(sentEmails.length, 1, "exactly one consolidated email");
    assert.equal(summary.sentThisRun, 1, "one send unit");
    const html = sentEmails[0].html;
    assert.match(html, /your daily digest/i);
    assert.match(html, /Manage watches|manage/i);
    assert.match(html, /Unsubscribe from all|unsubscribe/i);
    // Day log marks rollup
    const day = new Date().toISOString().slice(0, 10);
    const dayLog = JSON.parse(await ALERT_STATE.get(`digest:daylog:${day}`));
    const rollups = dayLog.entries.filter((e) => e.kind === "rollup");
    assert.equal(rollups.length, 1, "daylog has one rollup entry");
    assert.equal(rollups[0].sendUnits, 1);
  });
});

test("single watch same email: still one single-path email (not rollup shell)", async () => {
  const today = new Date().toISOString().slice(0, 10);
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
    await runAlerts(env, []);
    assert.equal(sentEmails.length, 1);
    // Single path uses per-watch title, not "your daily digest"
    assert.doesNotMatch(sentEmails[0].html, /your daily digest/i);
  });
});

test("paused watch excluded from rollup active set → single path when only one remains", async () => {
  const today = new Date().toISOString().slice(0, 10);
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
    await runAlerts(env, []);
    assert.equal(sentEmails.length, 1);
    assert.doesNotMatch(sentEmails[0].html, /your daily digest/i);
  });
});

test("dryRunRollupForEmail: no Resend, returns rollup preview", async () => {
  const today = new Date().toISOString().slice(0, 10);
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
  const today = new Date().toISOString().slice(0, 10);
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
