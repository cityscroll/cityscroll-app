/**
 * Injected publisher failures keep last-good exact-matter history.
 *
 *   node --test worker/test/matter_exact_refresh_failures.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ACQUISITION_STATUS,
  refreshExactMatterRoster,
  ROSTER_KIND,
  upsertRosterEntry,
} from "../src/lib/matter_exact_refresh.mjs";
import { readJournalRows, retainSnapshotMatterObservations } from "../src/lib/matter_observation_journal.mjs";
import { matterJournalDatabase } from "./helpers/matter_observation_d1.mjs";
import {
  BASELINE,
  createPublisherFetch,
  defaultCatalog,
  earlyOnlySnapshot,
  retentionEnv,
  START,
} from "./helpers/matter_exact_refresh_oracle.mjs";

async function seed(env) {
  await retainSnapshotMatterObservations(env, earlyOnlySnapshot(), { acquiredAt: START.toISOString() });
  await upsertRosterEntry(env, { matterId: BASELINE[0].matter_id, kind: ROSTER_KIND.explicitRetained, now: START });
}

test("token absence fails without publisher requests and keeps last-good rows", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB, { LEGISTAR_API_TOKEN: "" });
  await seed(env);
  const before = (await readJournalRows(env)).map((row) => row.observation_id).sort();
  const { fetchImpl, requests } = createPublisherFetch(defaultCatalog());
  const receipt = await refreshExactMatterRoster(env, { now: START, fetchImpl, token: null });
  assert.equal(receipt.reason, "token-absent");
  assert.equal(receipt.current, false);
  assert.equal(requests.length, 0);
  const after = (await readJournalRows(env)).map((row) => row.observation_id).sort();
  assert.deepEqual(after, before);
  sqlite.close();
});

test("403 does not mark the acquisition current", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seed(env);
  const before = (await readJournalRows(env)).length;
  const { fetchImpl } = createPublisherFetch(defaultCatalog(), { status: 403 });
  const receipt = await refreshExactMatterRoster(env, { now: START, fetchImpl, maxMatters: 1 });
  assert.equal(receipt.failed, 1);
  assert.equal(receipt.current, false);
  assert.equal((await readJournalRows(env)).length, before);
  sqlite.close();
});

test("429 stores retry guidance and is not current", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seed(env);
  const { fetchImpl } = createPublisherFetch(defaultCatalog(), { status: 429, retryAfter: 90 });
  const receipt = await refreshExactMatterRoster(env, { now: START, fetchImpl, maxMatters: 1 });
  assert.equal(receipt.current, false);
  const state = sqlite.prepare("SELECT retry_after, last_error, acquisition_status FROM matter_refresh_state").get();
  assert.equal(state.last_error, "rate-limited");
  assert.equal(state.acquisition_status, ACQUISITION_STATUS.failed);
  assert.ok(state.retry_after);
  sqlite.close();
});

test("timeout keeps last-good history", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seed(env);
  const before = (await readJournalRows(env)).map((row) => row.observation_id).sort();
  const { fetchImpl } = createPublisherFetch(defaultCatalog(), { timeout: true });
  const receipt = await refreshExactMatterRoster(env, { now: START, fetchImpl, maxMatters: 1, timeoutMs: 50 });
  assert.equal(receipt.current, false);
  assert.ok(receipt.failed >= 1 || receipt.deferred >= 1);
  assert.deepEqual((await readJournalRows(env)).map((row) => row.observation_id).sort(), before);
  sqlite.close();
});

test("malformed payload is not marked current", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seed(env);
  const { fetchImpl } = createPublisherFetch(defaultCatalog(), { malformed: true });
  const receipt = await refreshExactMatterRoster(env, { now: START, fetchImpl, maxMatters: 1 });
  assert.equal(receipt.current, false);
  sqlite.close();
});

test("page-two failure retains page-one history", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seed(env);
  const catalog = defaultCatalog();
  const { fetchImpl } = createPublisherFetch(catalog, { pageTwoFailure: true });
  const receipt = await refreshExactMatterRoster(env, {
    now: START,
    fetchImpl,
    maxMatters: 1,
    pageSize: 1,
    maxRequests: 20,
  });
  assert.equal(receipt.current, false);
  const rows = await readJournalRows(env);
  const later = rows.filter((row) => row.matter_id === "79163" && row.event_id === "22526");
  const early = rows.filter((row) => row.matter_id === "79163" && row.event_id === "22567");
  assert.ok(early.length >= 1);
  assert.equal(later.length, 0);
  sqlite.close();
});
