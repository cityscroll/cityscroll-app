/**
 * Matter observations survive snapshot replacement and retain their evidence.
 *
 *   node --test worker/test/matter_observation_retention.test.mjs
 *
 * Counts describe the committed meeting-outcomes snapshot at its own vintage.
 * They are not live publisher coverage. No test in this file contacts a publisher.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildMeetingOutcomesView } from "../src/lib/meeting_outcomes.mjs";
import {
  LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG,
} from "../src/lib/legistar_source_records.mjs";
import {
  MATTER_BOOTSTRAP_SOURCE_SYSTEM,
  MATTER_IDENTITY_GRANULARITY,
  VOTE_BINDING_STATUS,
  classifySnapshotIntake,
  projectMatterJournal,
  readJournalRows,
  readRepairRows,
  retainNativeMatterObservations,
  retainSnapshotMatterObservations,
  summarizeRows,
} from "../src/lib/matter_observation_journal.mjs";
import { renderMatterObservationOperatorHtml } from "../src/lib/matter_observation_operator_view.mjs";
import { matterJournalDatabase } from "./helpers/matter_observation_d1.mjs";
import { observedSnapshot } from "../../site/matter_coverage_recovery.mjs";

const rawSnapshot = JSON.parse(
  readFileSync(new URL("../../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"),
);

// Retain the snapshot as of its own vintage: meetings scheduled after it carry
// a placeholder action and no votes, so they are not outcomes to retain. This
// is the same rule the frozen coverage oracle applies.
const snapshot = observedSnapshot(rawSnapshot);

const ACQUIRED = "2026-08-10T13:08:13.019Z";

function independentPopulation(source) {
  const byMatter = new Map();
  for (const [requestId, record] of Object.entries(source.by_notice || {})) {
    if (!record || record.snapshot_state === "absent") continue;
    for (const matter of record.matters || []) {
      const id = String(matter.matter_id);
      if (!byMatter.has(id)) byMatter.set(id, []);
      byMatter.get(id).push({
        event_id: String(record.event.event_id),
        request_id: requestId,
        matter_url: matter.matter_url,
      });
    }
  }
  const appearances = [...byMatter.values()].reduce((sum, rows) => (
    sum + new Set(rows.map((row) => row.event_id)).size
  ), 0);
  return {
    matter_count: byMatter.size,
    appearance_count: appearances,
    reference_count: [...byMatter.values()].reduce((sum, rows) => sum + rows.length, 0),
    byMatter,
  };
}

const oracle = independentPopulation(snapshot);

test("bootstrap retains every snapshot matter and hearing with coarse identity and provenance", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const result = await retainSnapshotMatterObservations({ DB }, snapshot, { acquiredAt: ACQUIRED });
  assert.equal(result.failed, false);
  assert.equal(oracle.matter_count, 64);
  assert.equal(oracle.appearance_count, 79);
  assert.equal(result.after.matter_count, 64);
  assert.equal(result.after.appearance_count, 79);

  const rows = await readJournalRows({ DB });
  assert.equal(rows.length, 79);
  assert.ok(rows.every((row) => row.identity_granularity === MATTER_IDENTITY_GRANULARITY.coarse));
  assert.ok(rows.every((row) => row.native_event_item_id == null));
  assert.ok(rows.every((row) => row.source_record_ref.startsWith(`${MATTER_BOOTSTRAP_SOURCE_SYSTEM}/`)));
  assert.ok(rows.every((row) => row.raw_payload_hash && row.semantic_revision && row.acquired_at === ACQUIRED));

  const duplicate = [...oracle.byMatter.entries()].find(([, rowsForMatter]) => (
    new Set(rowsForMatter.map((row) => row.event_id)).size < rowsForMatter.length
  ));
  assert.ok(duplicate, "the frozen snapshot still has a coalesced two-notice hearing");
  const [matterId, refs] = duplicate;
  const eventId = refs[0].event_id;
  const journalRow = rows.find((row) => row.matter_id === matterId && row.event_id === eventId);
  const notices = JSON.parse(journalRow.notice_references_json);
  assert.ok(notices.length >= 2);
  const provenance = JSON.parse(journalRow.provenance_json);
  assert.equal(provenance.bootstrap, true);
  assert.ok(provenance.source_urls.length >= 1);
  assert.equal(provenance.source_vintage, snapshot.generated_at);
  assert.ok(Array.isArray(provenance.subject_links));
  assert.ok(provenance.subject_links.every((link) => link.type === "about_notice"));

  const raw = sqlite.prepare("SELECT COUNT(*) AS n FROM source_records WHERE source_system = ?").get(MATTER_BOOTSTRAP_SOURCE_SYSTEM);
  assert.equal(raw.n, 79);
  sqlite.close();
});

test("empty, partial, or failed replacement cannot delete retained history", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: ACQUIRED });
  const first = summarizeRows(await readJournalRows(env));

  const empty = await retainSnapshotMatterObservations(env, { schema: snapshot.schema, by_notice: {} }, { acquiredAt: "2026-08-11T00:00:00.000Z" });
  assert.equal(empty.last_good_retained, true);
  assert.equal(empty.after.appearance_count, first.appearance_count);
  assert.deepEqual(empty.after.observation_ids, first.observation_ids);

  const partial = await retainSnapshotMatterObservations(env, { ...snapshot, present_count: 999 }, { acquiredAt: "2026-08-11T00:00:00.000Z" });
  assert.equal(classifySnapshotIntake({ ...snapshot, present_count: 999 }), "partial");
  assert.equal(partial.after.appearance_count, first.appearance_count);

  const failed = await retainSnapshotMatterObservations(env, { failed: true }, { acquiredAt: "2026-08-11T00:00:00.000Z" });
  assert.equal(failed.failed, true);
  assert.equal(failed.after.appearance_count, first.appearance_count);

  const replay = await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-08-12T00:00:00.000Z" });
  assert.deepEqual(replay.after.observation_ids, first.observation_ids);
  assert.equal(replay.after.appearance_count, 79);

  const repairs = await readRepairRows(env);
  assert.equal(repairs.length, 3);
  assert.equal(repairs.filter((row) => row.kind === "empty-replacement").length, 1);
  sqlite.close();
});

test("stored fields keep source, tenant, event, item, clocks, receipt, and revision separate", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  await retainSnapshotMatterObservations({ DB }, snapshot, { acquiredAt: ACQUIRED });
  const row = (await readJournalRows({ DB })).find((entry) => entry.matter_id === "79200");
  assert.equal(row.source_system, "legistar");
  assert.equal(row.tenant, "nyc");
  assert.equal(row.matter_id, "79200");
  assert.equal(row.event_id, "22509");
  assert.equal(row.native_event_item_id, null);
  assert.equal(row.publisher_action_id, null);
  assert.equal(row.event_time, "2026-07-22");
  assert.equal(row.observed_at, snapshot.generated_at);
  assert.equal(row.acquired_at, ACQUIRED);
  assert.match(row.source_record_ref, /^nyc_legistar_matter_bootstrap\//);
  assert.equal(row.raw_payload_hash.length, 64);
  assert.equal(row.semantic_revision.length, 64);
  assert.notEqual(row.raw_payload_hash, row.semantic_revision);
  sqlite.close();
});

test("a vote from one event item never populates another event or matter", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: ACQUIRED });
  const native = await retainNativeMatterObservations(env, {
    events: [
      { EventId: 22509, EventDate: "2026-07-22", EventBodyName: "Subcommittee on Landmarks" },
    ],
    eventItems: [
      {
        EventItemId: 551001,
        EventItemEventId: 22509,
        EventItemMatterId: 79200,
        EventItemMatterName: "Landmarks, Queens CD 2",
        EventItemActionName: "Laid Over by Subcommittee",
        EventItemActionId: 77,
      },
      {
        EventItemId: 551002,
        EventItemEventId: 22509,
        EventItemMatterId: 79200,
        EventItemMatterName: "Landmarks, Queens CD 2",
        EventItemActionName: "Hearing Held by Committee",
        EventItemActionId: 78,
      },
    ],
    votes: [
      { VoteEventItemId: 551001, VotePersonId: 7801, VoteValueName: "Affirmative" },
    ],
  }, { acquiredAt: "2026-08-11T00:00:00.000Z" });

  assert.equal(native.failed, false);
  const rows = (await readJournalRows(env)).filter((row) => row.identity_granularity === "native" && row.matter_id === "79200");
  const first = rows.find((row) => row.native_event_item_id === "551001");
  const second = rows.find((row) => row.native_event_item_id === "551002");
  assert.equal(first.vote_binding_status, VOTE_BINDING_STATUS.bound);
  assert.equal(first.vote_event_item_id, "551001");
  assert.equal(second.vote_binding_status, VOTE_BINDING_STATUS.none);
  assert.notEqual(second.vote_event_item_id, "551001");

  const incomplete = await retainNativeMatterObservations(env, {
    events: [{ EventId: 99901, EventDate: "2026-07-22" }],
    eventItems: [{
      EventItemId: 660001,
      EventItemEventId: 99901,
      EventItemMatterId: 79200,
      EventItemActionName: "Laid Over by Subcommittee",
    }],
    votes: [{ VotePersonId: 7801, VoteValueName: "Affirmative" }],
  }, { acquiredAt: "2026-08-11T01:00:00.000Z" });
  assert.ok(incomplete.unresolved.some((row) => row.reason === "vote-missing-event-item"));
  sqlite.close();
});

test("a correction keeps both versions on one event, and same-day items stay distinct", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  const bags = (action, itemId = "551001") => ({
    events: [{ EventId: 22509, EventDate: "2026-07-22" }],
    eventItems: [{
      EventItemId: itemId,
      EventItemEventId: 22509,
      EventItemMatterId: 79200,
      EventItemMatterName: "Landmarks, Queens CD 2",
      EventItemActionName: action,
    }],
    votes: [],
  });
  await retainNativeMatterObservations(env, bags("Laid Over by Subcommittee"), { acquiredAt: "2026-08-11T00:00:00.000Z" });
  await retainNativeMatterObservations(env, bags("Approved by Subcommittee"), { acquiredAt: "2026-08-12T00:00:00.000Z" });
  await retainNativeMatterObservations(env, {
    events: [{ EventId: 22509, EventDate: "2026-07-22" }],
    eventItems: [{
      EventItemId: "551009",
      EventItemEventId: 22509,
      EventItemMatterId: 79200,
      EventItemMatterName: "Landmarks, Queens CD 2",
      EventItemActionName: "Hearing Held by Committee",
    }],
    votes: [],
  }, { acquiredAt: "2026-08-12T00:00:00.000Z" });

  const rows = (await readJournalRows(env)).filter((row) => row.matter_id === "79200" && row.identity_granularity === "native");
  const corrections = rows.filter((row) => row.native_event_item_id === "551001");
  assert.equal(corrections.length, 2);
  assert.equal(new Set(corrections.map((row) => row.event_id)).size, 1);
  assert.equal(new Set(corrections.map((row) => row.semantic_revision)).size, 2);
  assert.ok(rows.some((row) => row.native_event_item_id === "551009"));

  await retainNativeMatterObservations(env, {
    events: [{ EventId: 23000, EventDate: "2026-07-22" }],
    eventItems: [{
      EventItemId: "700001",
      EventItemEventId: 23000,
      EventItemMatterId: "79163",
      EventItemMatterName: "Landmarks, Queens CD 2",
      EventItemActionName: "Laid Over by Subcommittee",
    }],
    votes: [],
  }, { acquiredAt: "2026-08-12T00:00:00.000Z" });
  const titles = (await readJournalRows(env)).filter((row) => row.title && row.title.includes("Landmarks, Queens CD 2"));
  assert.ok(titles.some((row) => row.matter_id === "79200"));
  assert.ok(titles.some((row) => row.matter_id === "79163"));
  sqlite.close();
});

test("interrupted transactions keep last-good state and one deduplicated repair", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: ACQUIRED });
  const before = summarizeRows(await readJournalRows(env));
  DB.state.failNextBatch = true;
  const failed = await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-08-20T00:00:00.000Z" });
  assert.equal(failed.failed, true);
  assert.equal(failed.last_good_retained, true);
  assert.deepEqual(failed.after.observation_ids, before.observation_ids);
  assert.equal(failed.repair.kind, "transaction-failure");

  DB.state.failNextBatch = true;
  const again = await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2026-08-21T00:00:00.000Z" });
  assert.equal(again.repair.deduplicated, true);
  const repairs = await readRepairRows(env);
  assert.equal(repairs.filter((row) => row.kind === "transaction-failure").length, 1);
  assert.equal(Number(repairs[0].occurrence_count) >= 2, true);

  const aged = await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: "2027-02-10T00:00:00.000Z" });
  assert.equal(aged.after.appearance_count, 79);
  sqlite.close();
});

test("a native fixture upgrades a coarse hearing without duplicating it or inventing ids", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: ACQUIRED });
  const before = summarizeRows(await readJournalRows(env));
  const upgraded = await retainNativeMatterObservations(env, {
    events: [{ EventId: 22509, EventDate: "2026-07-22", EventInSiteURL: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22509" }],
    eventItems: [{
      EventItemId: 551001,
      EventItemEventId: 22509,
      EventItemMatterId: 79200,
      EventItemMatterName: "Landmarks, Queens CD 2 Walk to Park Site Selection/Acquisition, Queens (C 260089 PCQ).",
      EventItemActionName: "Laid Over by Subcommittee",
    }, {
      EventItemTitle: "Unidentified line",
      EventItemEventId: 22509,
    }],
    votes: [],
  }, { acquiredAt: "2026-08-11T00:00:00.000Z" });

  assert.ok(upgraded.unresolved.some((row) => row.reason === "missing-native-identity"));
  const projected = await projectMatterJournal(env);
  const matter = projected.matters.find((entry) => entry.matter_id === "79200");
  const hearings = new Set(matter.appearances.map((row) => row.public_hearing_key));
  assert.equal(hearings.size, 1);
  assert.ok(matter.appearances.some((row) => row.identity_granularity === "coarse" && row.superseded_by));
  assert.ok(matter.appearances.some((row) => row.identity_granularity === "native" && row.native_event_item_id === "551001"));
  assert.ok(matter.appearances.some((row) => row.notice_references.includes("20260707022")));
  assert.equal(projected.summary.appearance_count, before.appearance_count);
  sqlite.close();
});

test("operator projection names last-good retention, coarse identity, and repair without resident follow claims", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB };
  await retainSnapshotMatterObservations(env, snapshot, { acquiredAt: ACQUIRED });
  await retainSnapshotMatterObservations(env, { by_notice: {} }, { acquiredAt: "2026-08-11T00:00:00.000Z" });
  const html = renderMatterObservationOperatorHtml(await projectMatterJournal(env), {
    matterId: "79200",
    route: "/operator/matter-observations/last-good/",
  });
  assert.match(html, /Last-good journal holds 64 matters/);
  assert.match(html, /Coarse bootstrap appearance/);
  assert.match(html, /empty-replacement/);
  assert.match(html, /cannot delete these rows/);
  assert.doesNotMatch(html, /subscribe|notify me|testimony caused/i);
  assert.match(html, /min-height: 44px/);
  sqlite.close();
});

test("meeting-outcomes refresh records native journal rows without blocking the public view", async () => {
  const { sqlite, DB } = matterJournalDatabase();
  const env = { DB, [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true" };
  const notice = {
    request_id: "20260728001",
    section_name: "Public Hearings and Meetings",
    type_of_notice_description: "Public Hearing",
    agency_name: "City Council",
    short_title: "7-28-26 Subcommittee on Land Use — Queens items",
    event_date: "2026-07-28T16:00:00.000",
    start_date: "2026-07-10",
    additional_description_1: "Borough of Queens public hearing.",
    street_address_1: "120 Broad Street",
    city: "New York",
    state: "NY",
    zip_code: "10271",
  };
  const event = {
    EventId: 22526,
    EventBodyName: "Subcommittee on Land Use",
    EventDate: "2026-07-28T00:00:00",
    EventInSiteURL: "https://nyc.legistar.com/MeetingDetail.aspx?LEGID=22526",
  };
  const item = {
    EventItemId: 440244,
    EventItemEventId: 22526,
    EventItemTitle: "Transit Improvement Funding",
    EventItemActionName: "Approved by Subcommittee",
    EventItemMatterId: 79193,
    EventItemMatterName: "Transit Improvement Funding",
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes("/resource/dg92-zbpx.json")) return new Response(JSON.stringify([notice]));
    if (parsed.pathname === "/v1/nyc/Events") return new Response(JSON.stringify([event]));
    if (parsed.pathname === "/v1/nyc/Events/22526/EventItems") return new Response(JSON.stringify([item]));
    if (parsed.pathname.includes("/Votes") || parsed.pathname.includes("/Attachments")) {
      return new Response(JSON.stringify([]));
    }
    return new Response(JSON.stringify([]));
  };
  const view = await buildMeetingOutcomesView({
    token: "test-token",
    fetchImpl,
    now: new Date("2026-08-01T12:00:00.000Z"),
    env,
  });
  assert.equal(view.counts.matched_notices, 1);
  assert.equal(view.matter_journal.failed, false);
  const rows = await readJournalRows(env);
  assert.ok(rows.some((row) => row.matter_id === "79193" && row.native_event_item_id === "440244"));
  sqlite.close();
});
