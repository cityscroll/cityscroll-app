/**
 * Fair scheduling and duplicate-trigger budgets for exact-matter refresh.
 *
 *   node --test worker/test/matter_exact_refresh_fairness.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  refreshExactMatterRoster,
  ROSTER_KIND,
  upsertRosterEntry,
} from "../src/lib/matter_exact_refresh.mjs";
import { retainSnapshotMatterObservations } from "../src/lib/matter_observation_journal.mjs";
import { matterJournalDatabase } from "./helpers/matter_observation_d1.mjs";
import {
  BASELINE,
  createPublisherFetch,
  defaultCatalog,
  earlyOnlySnapshot,
  retentionEnv,
  START,
} from "./helpers/matter_exact_refresh_oracle.mjs";

test("more due matters than one run can serve are all visited under recovery", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await retainSnapshotMatterObservations(env, earlyOnlySnapshot(), { acquiredAt: START.toISOString() });
  for (const row of BASELINE) {
    await upsertRosterEntry(env, { matterId: row.matter_id, kind: ROSTER_KIND.explicitRetained, now: START });
  }
  const catalog = defaultCatalog();
  const visited = new Set();
  let now = START;
  for (let i = 0; i < 6; i += 1) {
    const { fetchImpl } = createPublisherFetch(catalog);
    const receipt = await refreshExactMatterRoster(env, {
      now,
      fetchImpl,
      maxMatters: 2,
      maxRequests: 80,
    });
    assert.ok(receipt.request_count <= 80);
    for (const matter of receipt.matters || []) {
      if (matter.status === "complete" || matter.status === "partial" || matter.status === "failed") {
        visited.add(matter.matter_id);
      }
    }
    now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  assert.equal(visited.size, 10);
  sqlite.close();
});

test("duplicate triggers do not exceed the request budget", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await retainSnapshotMatterObservations(env, earlyOnlySnapshot(), { acquiredAt: START.toISOString() });
  for (const row of BASELINE) {
    await upsertRosterEntry(env, { matterId: row.matter_id, kind: ROSTER_KIND.explicitRetained, now: START });
  }
  const catalog = defaultCatalog();
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetchImpl, requests } = createPublisherFetch(catalog);
  const gated = async (url, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      return await fetchImpl(url, init);
    } finally {
      inFlight -= 1;
    }
  };
  const first = refreshExactMatterRoster(env, {
    now: START,
    fetchImpl: gated,
    maxMatters: 3,
    maxRequests: 12,
    concurrency: 1,
  });
  const second = refreshExactMatterRoster(env, {
    now: START,
    fetchImpl: gated,
    maxMatters: 3,
    maxRequests: 12,
    concurrency: 1,
  });
  const [a, b] = await Promise.all([first, second]);
  const deferred = [a, b].filter((row) => row.reason === "duplicate-trigger");
  const live = [a, b].filter((row) => row.reason !== "duplicate-trigger");
  assert.equal(deferred.length, 1);
  assert.equal(live.length, 1);
  assert.ok(live[0].request_count <= 12);
  assert.ok(requests.length <= 12);
  sqlite.close();
});
