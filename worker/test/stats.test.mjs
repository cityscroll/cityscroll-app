// R·B — outcome counters, /stats, and the count-only /r redirect.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayStr, statsKey, lastNDays, parseRedirect, noticeUrl, bumpStat, sumStat, STATS_TTL,
  bumpStatAllTime, bumpCategoryStat, readStatAllTime, readAllCategoryStats,
} from "../src/lib/stats.mjs";
import { handleRedirect } from "../src/redirect.mjs";
import { handleStats } from "../src/stats.mjs";

// A minimal in-memory KV double (get/put/list subset used by the stats helpers).
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, opts) { store.set(k, v); this.lastOpts = opts; },
    async list({ prefix = "" } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}

const NOW = new Date("2026-07-02T15:00:00Z");

test("dayStr/statsKey match the repo's day-key convention", () => {
  assert.equal(dayStr(NOW), "2026-07-02");
  assert.equal(statsKey("click", "2026-07-02"), "stats:click:2026-07-02");
});

test("lastNDays walks backward from today, UTC", () => {
  assert.deepEqual(lastNDays(3, NOW), ["2026-07-02", "2026-07-01", "2026-06-30"]);
});

test("parseRedirect accepts real watch kinds + request ids", () => {
  assert.deepEqual(parseRedirect("/r/money/20260701123"), { kind: "money", id: "20260701123" });
  assert.deepEqual(parseRedirect("/r/entity/2026-0701-ABC"), { kind: "entity", id: "2026-0701-ABC" });
});

test("parseRedirect rejects junk: no URL smuggling, no odd chars, no empty parts", () => {
  for (const bad of [
    "/r/money/",                      // missing id
    "/r//123",                        // missing kind
    "/r/money/https://evil.example",  // URL-ish id
    "/r/money/1%2F..%2Fx",            // encoded slash junk
    "/r/MONEY/123",                   // kind must be lowercase slug
    "/r/money/123/extra",             // trailing segment
    "/r/" + "k".repeat(30) + "/1",    // kind too long
  ]) assert.equal(parseRedirect(bad), null, bad);
});

test("noticeUrl always targets crol-list.org (never an attacker-supplied URL)", () => {
  assert.equal(noticeUrl("20260701123"), "https://crol-list.org/#notice/20260701123");
  assert.ok(noticeUrl("a&b=c").startsWith("https://crol-list.org/#notice/"));
});

test("bumpStat increments a per-day counter with the self-cleaning TTL", async () => {
  const kv = fakeKV();
  await bumpStat(kv, "click", NOW);
  await bumpStat(kv, "click", NOW);
  assert.equal(kv.store.get("stats:click:2026-07-02"), "2");
  assert.equal(kv.lastOpts.expirationTtl, STATS_TTL);
});

test("bumpStat swallows KV failures — counting never breaks the request", async () => {
  await assert.doesNotReject(bumpStat({ async get() { throw new Error("kv down"); }, async put() {} }, "click", NOW));
  await assert.doesNotReject(bumpStat(null, "click", NOW));
});

test("sumStat sums the window and treats gaps as zero", async () => {
  const kv = fakeKV({ "stats:feed:2026-07-02": "3", "stats:feed:2026-06-30": "4" });
  assert.equal(await sumStat(kv, "feed", 7, NOW), 7);
  assert.equal(await sumStat(kv, "feed", 1, NOW), 3);
  assert.equal(await sumStat(null, "feed", 7, NOW), 0);
});

test("handleRedirect 302s to the permalink and counts total + per-kind", async () => {
  const kv = fakeKV();
  const waits = [];
  const res = handleRedirect(
    new Request("https://api.crol-list.org/r/money/20260701123"),
    { ALERT_STATE: kv }, { waitUntil: (p) => waits.push(p) }, "/r/money/20260701123",
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://crol-list.org/#notice/20260701123");
  await Promise.all(waits);
  assert.equal(kv.store.get(`stats:click:${dayStr(new Date())}`), "1");
  assert.equal(kv.store.get(`stats:click.money:${dayStr(new Date())}`), "1");
});

test("handleRedirect falls back to the homepage uncounted on junk paths", async () => {
  const kv = fakeKV();
  const res = handleRedirect(new Request("https://api.crol-list.org/r/x"), { ALERT_STATE: kv }, { waitUntil() {} }, "/r/x");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://crol-list.org/");
  assert.equal(kv.store.size, 0);
});

test("bumpStatAllTime accumulates forever, no per-day reset and no TTL", async () => {
  const kv = fakeKV();
  await bumpStatAllTime(kv, "digest");
  await bumpStatAllTime(kv, "digest");
  await bumpStatAllTime(kv, "digest");
  assert.equal(kv.store.get("stats:alltime:digest"), "3");
  assert.equal(kv.lastOpts, undefined);
  assert.equal(await readStatAllTime(kv, "digest"), 3);
  assert.equal(await readStatAllTime(kv, "nl_search"), 0, "an untouched metric reads zero, not an error");
  assert.equal(await readStatAllTime(null, "digest"), 0);
});

test("bumpCategoryStat + readAllCategoryStats break a metric out by category, discovered dynamically", async () => {
  const kv = fakeKV();
  await bumpCategoryStat(kv, "digest", "Procurement");
  await bumpCategoryStat(kv, "digest", "Procurement");
  await bumpCategoryStat(kv, "digest", "land");
  await bumpCategoryStat(kv, "nl_search", "money"); // a different metric must not bleed into "digest"
  assert.deepEqual(await readAllCategoryStats(kv, "digest"), { Procurement: 2, land: 1 });
  assert.deepEqual(await readAllCategoryStats(kv, "nl_search"), { money: 1 });
  assert.deepEqual(await readAllCategoryStats(null, "digest"), {});
});

test("bumpCategoryStat is a no-op with no category, and swallows KV failures", async () => {
  const kv = fakeKV();
  await bumpCategoryStat(kv, "digest", null);
  assert.equal(kv.store.size, 0);
  await assert.doesNotReject(bumpCategoryStat({ async get() { throw new Error("kv down"); }, async put() {} }, "digest", "land"));
});

test("GET /stats publishes all-time totals + category breakdown alongside the unchanged 7-day fields", async () => {
  const alertState = fakeKV({
    "stats:alltime:digest": "42",
    "stats:cat:digest:Procurement": "30",
    "stats:cat:digest:land": "12",
  });
  const nlMeter = fakeKV({
    "stats:alltime:nl_search": "9",
    "stats:cat:nl_search:money": "9",
  });
  const env = { ALERT_STATE: alertState, NL_METER: nlMeter, SUBS: fakeKV() };
  const res = await handleStats(new Request("https://api.crol-list.org/stats"), env, { waitUntil: async (p) => p });
  assert.equal(res.status, 200);
  const body = await res.json();

  // Existing 7-day/today shape is untouched — additive only.
  assert.deepEqual(Object.keys(body.digests).sort(), ["by_category", "sent_all_time", "sent_last7d", "sent_today"]);
  assert.equal(body.digests.sent_today, 0);
  assert.equal(body.digests.sent_last7d, 0);

  // New all-time + category fields.
  assert.equal(body.digests.sent_all_time, 42);
  assert.deepEqual(body.digests.by_category, { Procurement: 30, land: 12 });
  assert.equal(body.nl_search.calls_all_time, 9);
  assert.deepEqual(body.nl_search.by_category, { money: 9 });
});
