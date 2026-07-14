// R·B — outcome counters, /stats, and the count-only /r redirect.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayStr, statsKey, lastNDays, parseRedirect, noticeUrl, bumpStat, sumStat, STATS_TTL,
  bumpStatAllTime, bumpCategoryStat, readStatAllTime, readAllCategoryStats,
  bumpHistDay, readHistSeries, readHistEra, histDayKey, histEraKey,
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

test("bumpHistDay accumulates per day with no TTL, unlike the 40-day rolling stats:<metric>:<day> counter", async () => {
  const kv = fakeKV();
  await bumpHistDay(kv, "digest", NOW);
  await bumpHistDay(kv, "digest", NOW);
  assert.equal(kv.store.get(histDayKey("digest", "2026-07-02")), "2");
  assert.equal(kv.lastOpts, undefined, "no expirationTtl — a hist:<metric>:<day> key must outlive the 40-day one");
});

test("readHistSeries returns every recorded day for a metric, discovered via list, not a fixed range", async () => {
  const kv = fakeKV({
    [histDayKey("digest", "2026-07-02")]: "3",
    [histDayKey("digest", "2026-07-13")]: "7",
    [histDayKey("nl_search", "2026-07-13")]: "15", // a different metric must not bleed in
  });
  assert.deepEqual(await readHistSeries(kv, "digest"), { "2026-07-02": 3, "2026-07-13": 7 });
  assert.deepEqual(await readHistSeries(null, "digest"), {});
});

test("before: /stats had no way to tell recovered history from live-counted history, so a time-series chart built from it would show every day as equally certain; after: hist:era:<metric> marks the first live day, and readHistEra surfaces it so the UI can label the split honestly", async () => {
  const kv = fakeKV({ [histEraKey("digest")]: "2026-07-14" });
  assert.equal(await readHistEra(kv, "digest"), "2026-07-14");
  assert.equal(await readHistEra(kv, "nl_search"), null, "an unset era must not default to some other metric's boundary");
  assert.equal(await readHistEra(null, "digest"), null);
});

test("GET /stats includes a history block with per-day totals and the recovered/live boundary for both digests and nl_search", async () => {
  const alertState = fakeKV({
    [histDayKey("digest", "2026-07-02")]: "1",
    [histDayKey("digest", "2026-07-13")]: "2",
    [histEraKey("digest")]: "2026-07-14",
  });
  const nlMeter = fakeKV({
    [histDayKey("nl_search", "2026-07-13")]: "15",
    [histEraKey("nl_search")]: "2026-07-14",
  });
  const env = { ALERT_STATE: alertState, NL_METER: nlMeter, SUBS: fakeKV() };
  const res = await handleStats(new Request("https://api.crol-list.org/stats"), env, { waitUntil: async (p) => p });
  const body = await res.json();

  assert.deepEqual(body.history.digests.by_day, { "2026-07-02": 1, "2026-07-13": 2 });
  assert.equal(body.history.digests.live_from, "2026-07-14");
  assert.deepEqual(body.history.nl_search.by_day, { "2026-07-13": 15 });
  assert.equal(body.history.nl_search.live_from, "2026-07-14");
});
