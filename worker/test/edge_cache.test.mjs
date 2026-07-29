import { test } from "node:test";
import assert from "node:assert/strict";

import { handleAgency } from "../src/agency.mjs";
import { handleExternalAward } from "../src/external_award.mjs";
import { handleInv } from "../src/inv.mjs";
import { handlePriorCycle } from "../src/prior_cycle.mjs";
import { handleSuggestions, SUGGESTIONS_KV_KEY } from "../src/suggest.mjs";
import {
  handleVendorProfile,
  vendorProfileBucket,
  vendorProfileBucketKey,
} from "../src/vendor_profile.mjs";

function memoryCache() {
  const entries = new Map();
  return {
    matches: 0,
    puts: 0,
    async match(request) {
      this.matches++;
      const key = request instanceof Request ? request.url : String(request);
      const stored = entries.get(key);
      if (!stored) return undefined;
      const hit = new Response(stored.body, stored);
      hit.headers.set("X-Test-Cache-Hit", "true");
      return hit;
    },
    async put(request, response) {
      this.puts++;
      const key = request instanceof Request ? request.url : String(request);
      entries.set(key, response.clone());
    },
  };
}

async function assertSecondHit(invoke, sourceReads) {
  const previous = globalThis.caches;
  const cache = memoryCache();
  globalThis.caches = { default: cache };
  try {
    const first = await invoke();
    const firstBody = await first.text();
    const readsAfterFirst = sourceReads();
    const second = await invoke();
    assert.equal(second.headers.get("X-Test-Cache-Hit"), "true");
    assert.equal(await second.text(), firstBody);
    assert.equal(sourceReads(), readsAfterFirst, "the second request must not read the backing source");
    assert.equal(cache.puts, 1);
    assert.equal(cache.matches, 2);
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
}

test("cacheable route classes serve the second identical request from caches.default", async (t) => {
  await t.test("vendor profile KV record", async () => {
    const generated = "2026-07-27T13:00:00.000Z";
    const version = "20260727130000";
    const stem = "CAMBA";
    const bucketKey = vendorProfileBucketKey(version, vendorProfileBucket(stem));
    const values = new Map([
      ["vp:manifest:v1", JSON.stringify({ generated, version })],
      [bucketKey, JSON.stringify({ generated, profiles: { [stem]: { stem, display: "Camba Inc." } } })],
    ]);
    let reads = 0;
    const env = { ALERT_STATE: { async get(key) { reads++; return values.get(key) ?? null; } } };
    const req = new Request("https://api.cityscroll.org/vendor-profile?name=Camba%20Inc.");
    await assertSecondHit(
      () => handleVendorProfile(req, env, { nowMs: Date.parse(generated) + 60_000 }),
      () => reads,
    );
  });

  await t.test("shared investigation KV record", async () => {
    let reads = 0;
    const env = {
      SUBS: {
        async get() {
          reads++;
          return JSON.stringify({ name: "Shared", items: [] });
        },
      },
    };
    const req = new Request("https://api.cityscroll.org/inv/shared123");
    await assertSecondHit(() => handleInv(req, env, "/inv/shared123"), () => reads);
  });

  await t.test("external award KV record", async () => {
    let reads = 0;
    const env = {
      ALERT_STATE: {
        async get() {
          reads++;
          return JSON.stringify({
            dataset: "8w5p-k45m",
            authority: "New York City School Construction Authority",
            refreshed: "2025-12-01",
            awards: [],
          });
        },
      },
    };
    const req = new Request(
      "https://api.cityscroll.org/externalaward?agency=School%20Construction%20Authority",
    );
    await assertSecondHit(() => handleExternalAward(req, env), () => reads);
  });

  await t.test("static agency identity", async () => {
    let reads = 0;
    const req = new Request(
      "https://api.cityscroll.org/agency?name=DEPARTMENT%20OF%20SANITATION",
      { headers: { Origin: "https://cityscroll.org" } },
    );
    await assertSecondHit(() => handleAgency(req, {}), () => reads);
  });

  await t.test("prior-cycle D1 record", async () => {
    let reads = 0;
    const stored = JSON.stringify({ strict: [], near: [], eligibleCount: 0 });
    const env = {
      DB: {
        prepare() {
          return {
            bind() { return this; },
            async first() {
              reads++;
              return { matches: stored };
            },
          };
        },
      },
    };
    const req = new Request("https://api.cityscroll.org/priorcycle/20220314107");
    await assertSecondHit(
      () => handlePriorCycle(req, env, "/priorcycle/20220314107"),
      () => reads,
    );
  });

  await t.test("validated suggestions KV record", async () => {
    let reads = 0;
    const stored = JSON.stringify({
      generatedAt: "2026-07-27T13:00:00.000Z",
      minResults: 3,
      byLens: { money: [{ idx: 0, count: 42 }] },
    });
    const env = {
      ALERT_STATE: {
        async get(key) {
          reads++;
          assert.equal(key, SUGGESTIONS_KV_KEY);
          return stored;
        },
      },
    };
    const req = new Request("https://api.cityscroll.org/suggestions");
    await assertSecondHit(() => handleSuggestions(req, env), () => reads);
  });
});

test("vendor profile cache TTL never exceeds the remaining 24-hour freshness window", async () => {
  const generated = "2026-07-27T13:00:00.000Z";
  const version = "20260727130000";
  const stem = "CAMBA";
  const bucketKey = vendorProfileBucketKey(version, vendorProfileBucket(stem));
  const values = new Map([
    ["vp:manifest:v1", JSON.stringify({ generated, version })],
    [bucketKey, JSON.stringify({ generated, profiles: { [stem]: { stem } } })],
  ]);
  const env = { ALERT_STATE: { async get(key) { return values.get(key) ?? null; } } };
  const remainingSeconds = 90;
  const nowMs = Date.parse(generated) + 24 * 60 * 60 * 1000 - remainingSeconds * 1000;
  const res = await handleVendorProfile(
    new Request("https://api.cityscroll.org/vendor-profile?name=Camba%20Inc."),
    env,
    { nowMs },
  );
  const maxAge = Number(res.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1]);
  assert.ok(Number.isFinite(maxAge));
  assert.ok(maxAge <= remainingSeconds);
});

test("cache hits retain the requesting origin's CORS header", async () => {
  const previous = globalThis.caches;
  const cache = memoryCache();
  globalThis.caches = { default: cache };
  const url = "https://api.cityscroll.org/agency?name=DEPARTMENT%20OF%20SANITATION";
  try {
    await handleAgency(new Request(url, {
      headers: { Origin: "https://cityscroll.org" },
    }), {});
    const hit = await handleAgency(new Request(url, {
      headers: { Origin: "https://www.cityscroll.org" },
    }), {});
    assert.equal(hit.headers.get("X-Test-Cache-Hit"), "true");
    assert.equal(hit.headers.get("Access-Control-Allow-Origin"), "https://www.cityscroll.org");
  } finally {
    if (previous === undefined) delete globalThis.caches;
    else globalThis.caches = previous;
  }
});
