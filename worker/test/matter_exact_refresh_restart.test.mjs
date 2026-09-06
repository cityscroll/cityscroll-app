/**
 * Fake-clock page boundaries, crash restart, reordered pages, and repeats.
 *
 *   node --test worker/test/matter_exact_refresh_restart.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  projectMatterRefreshOperatorView,
  refreshExactMatterRoster,
  ROSTER_KIND,
  upsertRosterEntry,
} from "../src/lib/matter_exact_refresh.mjs";
import { renderMatterExactRefreshOperatorHtml } from "../src/lib/matter_exact_refresh_operator_view.mjs";
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

async function seedOne(env, matterId = BASELINE[0].matter_id) {
  await retainSnapshotMatterObservations(env, earlyOnlySnapshot(), { acquiredAt: START.toISOString() });
  await upsertRosterEntry(env, { matterId, kind: ROSTER_KIND.explicitRetained, now: START });
}

test("crash after page one resumes from the checkpoint", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seedOne(env);
  const catalog = defaultCatalog();
  const { fetchImpl } = createPublisherFetch(catalog);
  await assert.rejects(
    refreshExactMatterRoster(env, {
      now: START,
      fetchImpl,
      maxMatters: 1,
      pageSize: 1,
      maxRequests: 20,
      crashAfterPage: true,
    }),
    /injected-crash/,
  );
  const cursor = sqlite.prepare("SELECT cursor_json, acquisition_status FROM matter_refresh_state").get();
  assert.equal(cursor.acquisition_status, "partial");
  assert.ok(cursor.cursor_json.includes("\"skip\":1") || cursor.cursor_json.includes("skip"));

  const { fetchImpl: resumeFetch, requests } = createPublisherFetch(catalog);
  const resumed = await refreshExactMatterRoster(env, {
    now: new Date(START.getTime() + 1000),
    fetchImpl: resumeFetch,
    maxMatters: 1,
    pageSize: 1,
    maxRequests: 20,
  });
  assert.equal(resumed.status, "complete");
  const skips = requests.filter((row) => /EventItems$/.test(row.path)).map((row) => Number(row.skip || 0));
  assert.ok(skips.includes(1));
  const rows = await readJournalRows(env);
  assert.ok(rows.some((row) => row.matter_id === "79163" && row.event_id === "22526"));
  sqlite.close();
});

test("reordered pages and repeated records stay idempotent", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seedOne(env);
  const catalog = defaultCatalog();
  const { fetchImpl } = createPublisherFetch(catalog, { reorder: true, repeat: true });
  const first = await refreshExactMatterRoster(env, {
    now: START,
    fetchImpl,
    maxMatters: 1,
    pageSize: 2,
    maxRequests: 20,
  });
  const second = await refreshExactMatterRoster(env, {
    now: new Date(START.getTime() + 24 * 60 * 60 * 1000),
    fetchImpl,
    maxMatters: 1,
    pageSize: 2,
    maxRequests: 20,
  });
  assert.equal(first.current, true);
  const rows = await readJournalRows(env);
  const later = rows.filter((row) => row.matter_id === "79163" && row.event_id === "22526");
  const ids = later.map((row) => row.observation_id);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(later.length >= 1);
  assert.equal(second.status === "complete" || second.status === "partial", true);
  sqlite.close();
});

test("operator receipt names attempted, retained, deferred, and failed work", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seedOne(env);
  const { fetchImpl } = createPublisherFetch(defaultCatalog());
  await refreshExactMatterRoster(env, { now: START, fetchImpl, maxMatters: 1, maxRequests: 20 });
  const view = await projectMatterRefreshOperatorView(env);
  assert.ok(view.summary.attempted >= 1);
  assert.equal(typeof view.summary.retained, "number");
  assert.equal(typeof view.summary.deferred, "number");
  assert.equal(typeof view.summary.failed, "number");
  const html = renderMatterExactRefreshOperatorHtml(view, { route: "/operator/matter-refresh/" });
  assert.match(html, /Attempted/);
  assert.match(html, /Retained complete/);
  assert.match(html, /Deferred/);
  assert.match(html, /Failed/);
  assert.match(html, /source gate has not passed/);
  sqlite.close();
});
