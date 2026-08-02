/**
 * Characterization: daily write-ahead prewarm for Land ZAP outcomes.
 * Cold GET /zap-outcomes is multi-source (~12s); prewarm fills KV so public reads hit cache.
 *
 *   node --test worker/test/zap_outcomes_prewarm.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  listPrewarmProjectIds,
  prewarmZapOutcomes,
  prewarmOneZapOutcome,
  refreshZapOutcomes,
  handleAdminZapOutcomesRefresh,
  handleZapOutcomes,
  outcomeCacheIsFresh,
  outcomeCacheIsPrewarmFresh,
  kvKey,
  ZAP_PREWARM_MAX,
  ZAP_PREWARM_DEMO_IDS,
  ZAP_PREWARM_STATUSES,
  ZAP_OUTCOMES_KV_PREFIX,
  ZAP_OUTCOMES_MAX_AGE_MS,
} from "../src/zap_outcomes.mjs";

function kv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    _store: store,
  };
}

function recordFor(id, generatedAt = new Date().toISOString()) {
  return {
    project_id: id,
    generated_at: generatedAt,
    join: { matched: true, method: "exact_project_id" },
    filled: true,
    documents: [{ name: "Decision.pdf", url: "https://example.test/doc" }],
    approved_actions: [],
    dispositions: [],
  };
}

test("kvKey and freshness helpers", () => {
  assert.equal(kvKey("2022M0258"), `${ZAP_OUTCOMES_KV_PREFIX}2022M0258`);
  const now = Date.parse("2026-08-01T12:00:00.000Z");
  const fresh = recordFor("2022M0258", "2026-08-01T10:00:00.000Z");
  const aging = recordFor("2022M0258", "2026-07-31T10:00:00.000Z"); // 26h old
  assert.equal(outcomeCacheIsFresh(fresh, now), true);
  assert.equal(outcomeCacheIsFresh(aging, now), false);
  assert.equal(outcomeCacheIsPrewarmFresh(fresh, now), true);
  // 20h old is still under public max-age but past 0.75 refresh window
  const almost = recordFor("2022M0258", "2026-07-31T14:00:00.000Z"); // 22h
  assert.equal(outcomeCacheIsFresh(almost, now), true);
  assert.equal(outcomeCacheIsPrewarmFresh(almost, now), false);
  assert.ok(ZAP_PREWARM_MAX >= 50 && ZAP_PREWARM_MAX <= 500);
  assert.ok(ZAP_PREWARM_STATUSES.includes("In Public Review"));
  assert.ok(ZAP_PREWARM_DEMO_IDS.includes("2022M0258"));
  assert.ok(ZAP_OUTCOMES_MAX_AGE_MS >= 12 * 60 * 60 * 1000);
});

test("listPrewarmProjectIds: priority order, demo pin, cap, fail-soft", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes("In%20Public%20Review") || String(url).includes("In Public Review")) {
      return {
        ok: true,
        json: async () => [
          { project_id: "2023Q0315" },
          { project_id: "2022M0258" }, // demo already pinned — dedupe
          { project_id: "2024K0280" },
        ],
      };
    }
    if (String(url).includes("Noticed")) {
      return { ok: true, json: async () => [{ project_id: "2025M0449" }] };
    }
    if (String(url).includes("Active")) {
      throw new Error("soda-down");
    }
    return { ok: true, json: async () => [{ project_id: "2020Q0129" }] };
  };
  const ids = await listPrewarmProjectIds({ fetchImpl, max: 10 });
  assert.equal(ids[0], "2022M0258");
  assert.ok(ids.includes("2023Q0315"));
  assert.ok(ids.includes("2024K0280"));
  assert.ok(ids.includes("2025M0449"));
  assert.ok(ids.includes("2020Q0129"));
  assert.equal(ids.filter((id) => id === "2022M0258").length, 1);
  assert.ok(ids.length <= 10);
  assert.ok(calls.length >= 1);
});

test("prewarmOneZapOutcome: skips fresh, computes stale, writes KV", async () => {
  const store = kv();
  const env = { ALERT_STATE: store };
  const id = "2022M0258";
  const now = Date.parse("2026-08-01T12:00:00.000Z");

  // Seed a prewarm-fresh record
  await store.put(kvKey(id), JSON.stringify(recordFor(id, "2026-08-01T11:00:00.000Z")));
  let builds = 0;
  const build = async (projectId) => {
    builds++;
    return recordFor(projectId, "2026-08-01T12:00:00.000Z");
  };

  const skip = await prewarmOneZapOutcome(env, id, { build, nowMs: now });
  assert.equal(skip.status, "skipped");
  assert.equal(builds, 0);

  // Force recompute
  const forced = await prewarmOneZapOutcome(env, id, { build, nowMs: now, force: true });
  assert.equal(forced.status, "computed");
  assert.equal(builds, 1);
  const written = JSON.parse(await store.get(kvKey(id)));
  assert.equal(written.generated_at, "2026-08-01T12:00:00.000Z");
});

test("prewarmZapOutcomes: bounded, fail-soft, summary counts", async () => {
  const store = kv();
  const env = { ALERT_STATE: store };
  const build = async (projectId) => {
    if (projectId === "BAD") throw new Error("upstream");
    return recordFor(projectId);
  };
  // Pre-seed one as fresh so it is skipped
  await store.put(kvKey("A"), JSON.stringify(recordFor("A")));
  const summary = await prewarmZapOutcomes(env, ["A", "B", "BAD", "B"], {
    build,
    concurrency: 2,
  });
  assert.equal(summary.requested, 3); // deduped
  assert.equal(summary.skipped, 1);
  assert.equal(summary.computed, 1);
  assert.equal(summary.failed, 1);
  assert.ok(await store.get(kvKey("B")));
});

test("refreshZapOutcomes: no-kv skip; lists + prewarms with fixture fetch", async () => {
  const bare = await refreshZapOutcomes({});
  assert.equal(bare.status, "skipped");
  assert.equal(bare.reason, "no-kv");

  const store = kv();
  const env = { ALERT_STATE: store };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => [{ project_id: "2023Q0315" }, { project_id: "2024K0280" }],
  });
  const build = async (projectId) => recordFor(projectId, "2026-08-01T12:00:00.000Z");
  const r = await refreshZapOutcomes(env, { fetchImpl, build, max: 5, nowMs: Date.parse("2026-08-01T12:00:00.000Z") });
  assert.equal(r.status, "ok");
  assert.ok(r.listed >= 1);
  assert.ok(r.computed >= 1);
  // Public GET path should now report cached:true
  const res = await handleZapOutcomes(
    new Request("https://w/zap-outcomes?id=2023Q0315"),
    env,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.cached, true);
  assert.equal(body.record.project_id, "2023Q0315");
});

test("handleAdminZapOutcomesRefresh: auth + no-kv skip (no network)", async () => {
  const noKey = await handleAdminZapOutcomesRefresh(
    new Request("https://w/admin/zap-outcomes-refresh", { method: "POST" }),
    {},
  );
  assert.equal(noKey.status, 404);

  const badKey = await handleAdminZapOutcomesRefresh(
    new Request("https://w/admin/zap-outcomes-refresh", { method: "POST" }),
    { ADMIN_KEY: "s3cr3t" },
  );
  assert.equal(badKey.status, 401);

  const get = await handleAdminZapOutcomesRefresh(
    new Request("https://w/admin/zap-outcomes-refresh?key=s3cr3t", { method: "GET" }),
    { ADMIN_KEY: "s3cr3t", ALERT_STATE: kv() },
  );
  assert.equal(get.status, 405);

  const ok = await handleAdminZapOutcomesRefresh(
    new Request("https://w/admin/zap-outcomes-refresh?key=s3cr3t", { method: "POST" }),
    { ADMIN_KEY: "s3cr3t" },
  );
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.status, "skipped");
  assert.equal(body.reason, "no-kv");
  assert.ok(body.triggeredAt);
});

test("refreshZapOutcomes: explicit projectIds with injected build (no network)", async () => {
  const store = kv();
  const r = await refreshZapOutcomes(
    { ALERT_STATE: store },
    {
      projectIds: ["2022M0258", "2023Q0315"],
      build: async (id) => recordFor(id),
      force: true,
    },
  );
  assert.equal(r.status, "ok");
  assert.equal(r.requested, 2);
  assert.equal(r.computed, 2);
  assert.equal(r.failed, 0);
});
