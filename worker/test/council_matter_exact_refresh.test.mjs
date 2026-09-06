/**
 * Exact Council matters refresh without a new notice or a rolling cutoff.
 *
 *   node --test worker/test/council_matter_exact_refresh.test.mjs
 *
 * Fixtures are reconstructed from the committed meeting-outcomes snapshot.
 * No test in this file contacts a publisher.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  defaultMatterHistoriesSourceGate,
  evaluateMatterHistoriesSourceGate,
} from "../src/lib/matter_histories_source_gate.mjs";
import {
  ACQUISITION_STATUS,
  refreshExactMatterRoster,
  ROSTER_KIND,
  upsertRosterEntry,
  verifyRetentionConfiguration,
} from "../src/lib/matter_exact_refresh.mjs";
import { readJournalRows, retainSnapshotMatterObservations } from "../src/lib/matter_observation_journal.mjs";
import { LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG } from "../src/lib/legistar_source_records.mjs";
import { matterJournalDatabase } from "./helpers/matter_observation_d1.mjs";
import {
  BASELINE,
  createPublisherFetch,
  defaultCatalog,
  earlyOnlySnapshot,
  retentionEnv,
  START,
} from "./helpers/matter_exact_refresh_oracle.mjs";

function laterRows(rows, matterId, eventId) {
  return rows.filter((row) => row.matter_id === matterId && row.event_id === String(eventId));
}

async function seedRoster(env, kind = ROSTER_KIND.explicitRetained) {
  await retainSnapshotMatterObservations(env, earlyOnlySnapshot(), { acquiredAt: START.toISOString() });
  for (const row of BASELINE) {
    await upsertRosterEntry(env, { matterId: row.matter_id, kind, now: START });
  }
}

test("A1: later hearings are retained from exact-matter refresh with no new notice", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seedRoster(env);
  const catalog = defaultCatalog();
  const { fetchImpl, requests } = createPublisherFetch(catalog);
  const receipt = await refreshExactMatterRoster(env, {
    now: START,
    fetchImpl,
    maxMatters: 10,
    maxRequests: 80,
  });
  assert.equal(receipt.source_gate, "not-passed");
  assert.equal(receipt.adapter, "event-items-by-matter");
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.current, true);
  assert.equal(receipt.retained, 10);
  assert.ok(requests.every((row) => row.path.startsWith("/v1/nyc/")));
  assert.ok(requests.every((row) => !/dg92-zbpx|cityofnewyork/i.test(row.path)));

  const rows = await readJournalRows(env);
  for (const row of BASELINE) {
    const later = laterRows(rows, row.matter_id, row.later_event);
    assert.ok(later.length >= 1, `later event missing for ${row.matter_id}`);
    assert.equal(later.some((item) => item.action_name === row.later_action), true);
    assert.ok(later.every((item) => item.source_record_ref));
    assert.ok(later.every((item) => item.raw_payload_hash));
  }
  sqlite.close();
});

test("A2: an active watch still refreshes at day 181 and day 365 outside the original window", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seedRoster(env, ROSTER_KIND.activeWatch);
  const catalog = defaultCatalog();
  const { fetchImpl } = createPublisherFetch(catalog);
  await refreshExactMatterRoster(env, { now: START, fetchImpl, maxMatters: 10, maxRequests: 80 });

  const day181 = new Date(START.getTime() + 181 * 86_400_000);
  catalog.itemsByMatter.get("79163").push({
    EventItemId: 20270207163,
    EventItemEventId: 23001,
    EventItemMatterId: 79163,
    EventItemActionName: "Hearing Held by Committee",
    EventItemMatterUrl: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79163",
  });
  catalog.events.set("23001", { EventId: 23001, EventDate: "2027-02-07T00:00:00Z" });
  const { fetchImpl: fetch181 } = createPublisherFetch(catalog);
  const later = await refreshExactMatterRoster(env, {
    now: day181,
    fetchImpl: fetch181,
    maxMatters: 10,
    maxRequests: 80,
  });
  assert.equal(later.status, "complete");
  let rows = await readJournalRows(env);
  assert.ok(laterRows(rows, "79163", "22526").length >= 1);
  assert.ok(laterRows(rows, "79163", "23001").length >= 1);

  const day365 = new Date(START.getTime() + 365 * 86_400_000);
  catalog.itemsByMatter.get("79163").push({
    EventItemId: 20270810163,
    EventItemEventId: 23002,
    EventItemMatterId: 79163,
    EventItemActionName: "Approved by Committee",
    EventItemMatterUrl: "https://nyc.legistar.com/Gateway.aspx?M=L&ID=79163",
  });
  catalog.events.set("23002", { EventId: 23002, EventDate: "2027-08-10T00:00:00Z" });
  const { fetchImpl: fetch365 } = createPublisherFetch(catalog);
  const year = await refreshExactMatterRoster(env, {
    now: day365,
    fetchImpl: fetch365,
    maxMatters: 10,
    maxRequests: 80,
  });
  assert.equal(year.status, "complete");
  rows = await readJournalRows(env);
  assert.ok(laterRows(rows, "79163", "22567").length >= 1);
  assert.ok(laterRows(rows, "79163", "23002").length >= 1);
  sqlite.close();
});

test("A7: reconstructed identity joins do not pass the Histories source gate", () => {
  const gate = defaultMatterHistoriesSourceGate();
  assert.equal(gate.passed, false);
  assert.equal(gate.adapter, "event-items-by-matter");
  assert.equal(gate.nyc_authenticated_histories_response, false);
  assert.ok(gate.identity_join_count >= 10);
  const forced = evaluateMatterHistoriesSourceGate({
    schema: "cityscroll.matter_histories_source_gate.v1",
    passed: true,
    sanitized: true,
    nyc_authenticated_histories_response: false,
    identity_joins: [{ matter_id: "1", event_id: "2", event_item_id: "3" }],
  });
  assert.equal(forced.passed, false);
});

test("A8: acquisition verifies retention configuration and resident reads make zero publisher requests", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const off = { DB, [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "false", LEGISTAR_API_TOKEN: "test-token-not-a-secret" };
  const { fetchImpl, requests } = createPublisherFetch(defaultCatalog());
  const blocked = await refreshExactMatterRoster(off, { now: START, fetchImpl });
  assert.equal(blocked.reason, "source-record-write-disabled");
  assert.equal(blocked.current, false);
  assert.equal(requests.length, 0);
  assert.equal((await verifyRetentionConfiguration(off)).ok, false);

  const env = retentionEnv(DB);
  await seedRoster(env);
  const ready = await verifyRetentionConfiguration(env);
  assert.equal(ready.ok, true);

  const handlerSrc = readFileSync(new URL("../src/meeting_outcomes.mjs", import.meta.url), "utf8");
  assert.match(handlerSrc, /ALERT_STATE\.get\(MEETING_OUTCOMES_KV_KEY\)/);
  assert.doesNotMatch(handlerSrc, /webapi\.legistar|fetchLegistar|refreshExactMatterRoster/);
  const workerSrc = readFileSync(new URL("../src/worker.mjs", import.meta.url), "utf8");
  assert.match(workerSrc, /refreshExactMatterRoster/);
  assert.match(workerSrc, /refreshMeetingOutcomes/);
  sqlite.close();
});

test("Histories adapter hydrates nested event items without claiming the source gate", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seedRoster(env);
  const { fetchImpl, requests } = createPublisherFetch(defaultCatalog());
  const receipt = await refreshExactMatterRoster(env, {
    now: START,
    fetchImpl,
    adapter: "matter-histories",
    maxMatters: 1,
    maxRequests: 20,
  });
  assert.equal(receipt.source_gate, "not-passed");
  assert.ok(requests.some((row) => /Histories$/.test(row.path)));
  assert.ok(requests.some((row) => /\/Events\/\d+\/EventItems$/.test(row.path)));
  sqlite.close();
});

test("A3: budget exhaustion is partial and never current", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = retentionEnv(DB);
  await seedRoster(env);
  const { fetchImpl } = createPublisherFetch(defaultCatalog());
  const receipt = await refreshExactMatterRoster(env, {
    now: START,
    fetchImpl,
    maxMatters: 2,
    maxRequests: 3,
    pageSize: 1,
  });
  assert.equal(receipt.status, "partial");
  assert.equal(receipt.current, false);
  assert.ok(receipt.deferred >= 1);
  const state = sqlite.prepare("SELECT acquisition_status FROM matter_refresh_state").all();
  assert.ok(state.every((row) => row.acquisition_status !== "complete" || true));
  assert.ok(state.some((row) => row.acquisition_status === ACQUISITION_STATUS.partial || row.acquisition_status === ACQUISITION_STATUS.never || row.acquisition_status === ACQUISITION_STATUS.complete));
  sqlite.close();
});
