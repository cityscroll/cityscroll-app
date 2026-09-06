/**
 * Last-good retention across exact-matter refresh faults.
 *
 *   node --test worker/test/matter_exact_refresh_retention.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
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

test("a later failed refresh cannot delete early hearings", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await retainSnapshotMatterObservations(env, earlyOnlySnapshot(), { acquiredAt: START.toISOString() });
  await upsertRosterEntry(env, { matterId: BASELINE[0].matter_id, kind: ROSTER_KIND.explicitRetained, now: START });
  const { fetchImpl } = createPublisherFetch(defaultCatalog());
  await refreshExactMatterRoster(env, { now: START, fetchImpl, maxMatters: 1, maxRequests: 20 });
  const good = (await readJournalRows(env)).map((row) => `${row.matter_id}:${row.event_id}`).sort();
  assert.ok(good.includes("79163:22567"));
  assert.ok(good.includes("79163:22526"));

  const { fetchImpl: fail } = createPublisherFetch(defaultCatalog(), { status: 403 });
  const receipt = await refreshExactMatterRoster(env, {
    now: new Date(START.getTime() + 24 * 60 * 60 * 1000),
    fetchImpl: fail,
    maxMatters: 1,
  });
  assert.equal(receipt.current, false);
  const after = (await readJournalRows(env)).map((row) => `${row.matter_id}:${row.event_id}`).sort();
  for (const key of good) assert.ok(after.includes(key));
  sqlite.close();
});
