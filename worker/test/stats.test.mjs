// R·B — outcome counters, /stats, and the count-only /r redirect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayStr, statsKey, lastNDays, parseRedirect, noticeUrl, bumpStat, sumStat, STATS_TTL } from "../src/lib/stats.mjs";
import { handleRedirect } from "../src/redirect.mjs";

// A minimal in-memory KV double (get/put/list subset used by the stats helpers).
function fakeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v, opts) { store.set(k, v); this.lastOpts = opts; },
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
