import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DOS_ENTITY_LOOKUP_ALLOW,
  DOS_ENTITY_LOOKUP_MAX_PER_IP_DAY,
  handleDosEntityLookup,
} from "../src/dos_entity_lookup.mjs";
import { buildNameQuery } from "../../entity_resolution/registers/dos_entities.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIX = path.join(ROOT, "test/fixtures/entity_registers");
const llcRows = JSON.parse(fs.readFileSync(path.join(FIX, "dos/llc_single.response.json"), "utf8"));
const llcUrl = buildNameQuery("C GLOBAL CONSULTING LLC", { limit: 25 }).url;

function corsAllowlistFromBatch() {
  const src = fs.readFileSync(path.join(ROOT, "worker/src/batch.mjs"), "utf8");
  const m = src.match(/const ALLOW = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(m, "batch ALLOW set not found");
  const urls = [...m[1].matchAll(/"(https?:[^"]+)"/g)].map((x) => x[1]);
  return new Set(urls);
}

function makeEnv({ overLimit = false } = {}) {
  return {
    NL_METER: {},
    __overLimit: overLimit,
  };
}

// Patch overActorLimit via dynamic import of meter is hard; instead wrap handle by
// stubbing global fetch and injecting through a test-only env flag used below.
// We monkey-patch the module's dependency by passing a custom caches + fetch.

const originalFetch = globalThis.fetch;
let fetchCalls = [];

test.beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url) === llcUrl) {
      return new Response(JSON.stringify(llcRows), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("down", { status: 503 });
  };
  globalThis.caches = {
    default: {
      store: new Map(),
      async match(req) {
        const key = req.url || String(req);
        const hit = this.store.get(key);
        return hit ? new Response(hit, { status: 200, headers: { "Content-Type": "application/json" } }) : undefined;
      },
      async put(req, res) {
        const key = req.url || String(req);
        this.store.set(key, await res.clone().text());
      },
    },
  };
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("CORS allowlist matches /batch", () => {
  const batch = corsAllowlistFromBatch();
  assert.deepEqual([...DOS_ENTITY_LOOKUP_ALLOW].sort(), [...batch].sort());
  assert.equal(DOS_ENTITY_LOOKUP_MAX_PER_IP_DAY, 200);
});

test("OPTIONS returns 204 with CORS", async () => {
  const res = await handleDosEntityLookup(new Request("https://api.cityscroll.org/org-register/dos", {
    method: "OPTIONS",
    headers: { Origin: "https://cityscroll.org" },
  }), makeEnv());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://cityscroll.org");
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
});

test("POST is refused", async () => {
  const res = await handleDosEntityLookup(new Request("https://api.cityscroll.org/org-register/dos?name=Acme", {
    method: "POST",
  }), makeEnv());
  assert.equal(res.status, 405);
});

test("refused input returns 400 with zero upstream fetches", async () => {
  const res = await handleDosEntityLookup(new Request("https://api.cityscroll.org/org-register/dos?name=%25%25%25"), makeEnv());
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.status, "refused");
  assert.equal(body.requests, 0);
  assert.equal(fetchCalls.length, 0);
});

test("one_match happy path for a recorded LLC name", async () => {
  const res = await handleDosEntityLookup(new Request("https://api.cityscroll.org/org-register/dos?name=C%20GLOBAL%20CONSULTING%20LLC"), makeEnv());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, "one_match");
  assert.equal(body.link_policy, "candidate_only");
  assert.equal(body.records[0].entity_class, "llc");
  assert.equal(body.cache, "miss");
  assert.equal(body.requests, 1);
  assert.ok(fetchCalls.some((u) => u === llcUrl));
});

test("identical lookup within cache window is a hit with requests 0", async () => {
  const req = () => handleDosEntityLookup(new Request("https://api.cityscroll.org/org-register/dos?name=C%20GLOBAL%20CONSULTING%20LLC"), makeEnv());
  const a = await (await req()).json();
  const before = fetchCalls.length;
  const b = await (await req()).json();
  assert.equal(a.cache, "miss");
  assert.equal(b.cache, "hit");
  assert.equal(b.requests, 0);
  assert.equal(fetchCalls.length, before);
});

test("upstream 503 returns 502 source_unavailable and is not cached", async () => {
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return new Response("down", { status: 503 });
  };
  const req = () => handleDosEntityLookup(new Request("https://api.cityscroll.org/org-register/dos?name=Skyline%20Builders"), makeEnv());
  const a = await req();
  const body = await a.json();
  assert.equal(a.status, 502);
  assert.equal(body.status, "source_unavailable");
  const storeSize = caches.default.store.size;
  await req();
  assert.equal(caches.default.store.size, storeSize, "failures must not populate cache");
});

test("disallowed Origin falls back to cityscroll.org allowlist default", async () => {
  const res = await handleDosEntityLookup(new Request("https://api.cityscroll.org/org-register/dos?name=ab", {
    headers: { Origin: "https://evil.example" },
  }), makeEnv());
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://cityscroll.org");
});

test("overActorLimit returns HTTP 429 with reason rate-limited and zero upstream", async () => {
  const res = await handleDosEntityLookup(
    new Request("https://api.cityscroll.org/org-register/dos?name=C%20GLOBAL%20CONSULTING%20LLC", {
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    }),
    makeEnv(),
    null,
    { overActorLimit: async () => true },
  );
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.equal(body.reason, "rate-limited");
  assert.equal(fetchCalls.length, 0);
});

test("fetchSodaRowsWithRetry is called with budgetMs 5000 and delaysMs [250]", async () => {
  let seen = null;
  await handleDosEntityLookup(
    new Request("https://api.cityscroll.org/org-register/dos?name=C%20GLOBAL%20CONSULTING%20LLC"),
    makeEnv(),
    null,
    {
      fetchSodaRowsWithRetry: async (url, opts) => {
        seen = opts;
        assert.equal(url, llcUrl);
        return llcRows;
      },
      onSodaOpts: (opts) => { seen = opts; },
    },
  );
  assert.equal(seen.budgetMs, 5000);
  assert.deepEqual(seen.delaysMs, [250]);
});
