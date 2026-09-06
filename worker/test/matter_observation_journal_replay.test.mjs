/**
 * Independently derived revision, replay, deduplication, transaction-failure,
 * and last-good-state coverage for the matter observation journal.
 *
 * This file does not share the snapshot-walking helper used by the named
 * retention suite. It rebuilds expected membership from notice/event pairs,
 * then compares the journal after replay and fault injection.
 *
 *   node --test worker/test/matter_observation_journal_replay.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  projectMatterJournal,
  readJournalRows,
  readRepairRows,
  retainNativeMatterObservations,
  retainSnapshotMatterObservations,
} from "../src/lib/matter_observation_journal.mjs";
import { matterJournalDatabase } from "./helpers/matter_observation_d1.mjs";

const snapshot = JSON.parse(
  readFileSync(new URL("../../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"),
);

function expectedFromEventPairs(source) {
  const hearings = new Set();
  const matters = new Set();
  const references = [];
  for (const [noticeId, record] of Object.entries(source.by_notice || {})) {
    const eventId = record?.event?.event_id;
    if (!eventId || record.snapshot_state === "absent") continue;
    for (const matter of record.matters || []) {
      const matterId = String(matter.matter_id || "");
      if (!/^\d+$/.test(matterId)) continue;
      matters.add(matterId);
      hearings.add(`${matterId}::${eventId}`);
      references.push(`${matterId}::${eventId}::${noticeId}`);
    }
  }
  return {
    matter_count: matters.size,
    appearance_count: hearings.size,
    reference_count: references.length,
    hearings: [...hearings].sort(),
  };
}

const expected = expectedFromEventPairs(snapshot);

test("replay of the frozen snapshot is idempotent against an event-pair oracle", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  const first = await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-08-10T13:08:13.019Z" });
  const second = await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-08-10T18:00:00.000Z" });
  assert.equal(expected.matter_count, 66);
  assert.equal(expected.appearance_count, 76);
  assert.equal(expected.reference_count, 78);
  assert.equal(first.after.matter_count, expected.matter_count);
  assert.equal(first.after.appearance_count, expected.appearance_count);
  assert.deepEqual(second.after.observation_ids, first.after.observation_ids);

  const projected = await projectMatterJournal(env);
  const heard = new Set();
  for (const matter of projected.matters) {
    for (const appearance of matter.appearances) {
      heard.add(`${matter.matter_id}::${appearance.event_id}`);
    }
  }
  assert.deepEqual([...heard].sort(), expected.hearings);
  sqlite.close();
});

test("a later native correction is a new revision of the same event, not a new hearing", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  const item = (action) => ({
    events: [{ EventId: 22342, EventDate: "2026-04-22" }],
    eventItems: [{
      EventItemId: 410010,
      EventItemEventId: 22342,
      EventItemMatterId: 78605,
      EventItemActionName: action,
      EventItemMatterName: "A land use item",
    }],
    votes: [],
  });
  await retainNativeMatterObservations(env, item("Laid Over by Subcommittee"), { acquiredAt: "2026-05-01T00:00:00.000Z" });
  await retainNativeMatterObservations(env, item("Approved by Subcommittee"), { acquiredAt: "2026-05-20T00:00:00.000Z" });
  const rows = (await readJournalRows(env)).filter((row) => row.matter_id === "78605");
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.event_id)).size, 1);
  assert.equal(new Set(rows.map((row) => row.public_hearing_key)).size, 1);
  assert.equal(new Set(rows.map((row) => row.semantic_revision)).size, 2);
  sqlite.close();
});

test("transaction failure then empty replacement leave last-good rows and one repair signature each", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-08-10T13:08:13.019Z" });
  const ids = (await readJournalRows(env)).map((row) => row.observation_id).sort();

  DB.state.failNextBatch = true;
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-09-01T00:00:00.000Z" });
  DB.state.failNextBatch = true;
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-09-02T00:00:00.000Z" });
  await retainSnapshotMatterObservations(env, { by_notice: {} }, { acquiredAt: "2026-09-03T00:00:00.000Z" });
  await retainSnapshotMatterObservations(env, { by_notice: {} }, { acquiredAt: "2026-09-04T00:00:00.000Z" });

  const after = (await readJournalRows(env)).map((row) => row.observation_id).sort();
  assert.deepEqual(after, ids);
  const repairs = await readRepairRows(env);
  const kinds = repairs.map((row) => row.kind).sort();
  assert.deepEqual(kinds, ["empty-replacement", "transaction-failure"]);
  assert.ok(repairs.every((row) => Number(row.occurrence_count) >= 2));
  sqlite.close();
});

test("observations acquired 181 days earlier remain queryable without a publisher request", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-02-10T00:00:00.000Z" });
  const later = await projectMatterJournal(env);
  assert.equal(later.summary.appearance_count, expected.appearance_count);
  assert.ok(later.matters.every((matter) => matter.appearances.every((row) => row.acquired_at === "2026-02-10T00:00:00.000Z")));
  sqlite.close();
});
