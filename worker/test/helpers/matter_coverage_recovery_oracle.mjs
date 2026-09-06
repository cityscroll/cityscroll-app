/**
 * Frozen-population replay for exact-matter coverage and recovery.
 *
 * Later packets start withheld and enter only through the collector adapter.
 * Synthetic fault cases are labelled durability tests.
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_REFRESH_CADENCE_MS,
  FROZEN_LATER_EVENT_WATCHES,
  buildAcceptanceIndex,
  countDistinctAppearances,
  countMaterializedMatters,
  deriveFrozenCoverageOracle,
  observedSnapshot,
  laterDiscoveries,
  snapshotFromJournalAppearances,
  withholdLaterMatterPackets,
} from "../../../site/matter_coverage_recovery.mjs";
import {
  buildLegislativeMatterIndex,
  buildLegislativeMatterLookup,
} from "../../../tools/build_legislative_matter_documents.mjs";
import {
  confirmExactMatterWatch,
  eligibleMatterWatchRows,
} from "../../src/lib/council_matter_watch_activation.mjs";
import { enqueueEvaluatedSection } from "../../src/lib/digest_outbox.mjs";
import { LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG } from "../../src/lib/legistar_source_records.mjs";
import {
  ROSTER_KIND,
  refreshExactMatterRoster,
  upsertRosterEntry,
} from "../../src/lib/matter_exact_refresh.mjs";
import {
  projectMatterCoverageReceipt,
  recoverPendingDelivery,
  recoverPublicationLag,
  recoverStaleRefresh,
} from "../../src/lib/matter_coverage_recovery.mjs";
import { publishMatterGeneration } from "../../src/lib/matter_publication.mjs";
import { readJournalRows, retainSnapshotMatterObservations } from "../../src/lib/matter_observation_journal.mjs";
import { buildSubscription, deriveSubscriberId, deriveWatchId } from "../../src/lib/subscriptions.mjs";
import { d1FromSqlite } from "./matter_observation_d1.mjs";
import {
  START,
  createPublisherFetch,
  fixtureItemId,
} from "./matter_exact_refresh_oracle.mjs";

const RAW_SNAPSHOT = JSON.parse(
  readFileSync(new URL("../../../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"),
);

// Replay the snapshot as of its own vintage. The committed file also carries
// meetings scheduled after it, which have a placeholder action and no votes;
// they are what a watch notifies about, not outcomes to replay, and the frozen
// oracle already leaves them out. Filtering once here keeps every harness that
// reads SNAPSHOT counting the same appearances the oracle does.
export const SNAPSHOT = observedSnapshot(RAW_SNAPSHOT);
export const ORACLE = deriveFrozenCoverageOracle(SNAPSHOT);
export const DATA_VINTAGE = SNAPSHOT.generated_at;
export { START, FROZEN_LATER_EVENT_WATCHES };

const SOURCE_SQL = readFileSync(new URL("../../migrations/0008_source_records.sql", import.meta.url), "utf8");
const JOURNAL_SQL = readFileSync(new URL("../../migrations/0027_matter_observation_journal.sql", import.meta.url), "utf8");
const REFRESH_SQL = readFileSync(new URL("../../migrations/0028_matter_exact_refresh.sql", import.meta.url), "utf8");
const BASELINE_SQL = readFileSync(new URL("../../migrations/0029_matter_watch_baseline.sql", import.meta.url), "utf8");
const OUTBOX_SQL = readFileSync(new URL("../../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");

class MockKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
  }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, String(value)); }
}

export function coverageRecoveryDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SOURCE_SQL);
  sqlite.exec(JOURNAL_SQL);
  sqlite.exec(REFRESH_SQL);
  sqlite.exec(BASELINE_SQL);
  sqlite.exec(OUTBOX_SQL);
  const kv = new MockKV();
  const env = {
    DB: d1FromSqlite(sqlite),
    ALERT_STATE: kv,
    MATTER_PUBLICATION: kv,
    MATTER_WATCH_DELIVERY: "1",
    [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true",
    LEGISTAR_API_TOKEN: "test-token-not-a-secret",
  };
  return { sqlite, env, kv };
}

export function catalogFromSnapshot(snapshot) {
  const itemsByMatter = new Map();
  const events = new Map();
  const historiesByMatter = new Map();
  // The caller passes the snapshot as of its own vintage (see SNAPSHOT above),
  // so every event here is one the publisher had already held.
  for (const record of Object.values(snapshot.by_notice || {})) {
    const eventId = String(record?.event?.event_id || "");
    if (!eventId) continue;
    events.set(eventId, { EventId: Number(eventId), EventDate: record.event.date });
    for (const matter of record.matters || []) {
      const matterId = String(matter.matter_id);
      const action = (Array.isArray(matter.actions) ? matter.actions.at(-1) : "") || matter.outcome || "";
      const item = {
        EventItemId: fixtureItemId(eventId, matterId),
        EventItemEventId: Number(eventId),
        EventItemMatterId: Number(matterId),
        EventItemActionName: action,
        EventItemMatterName: matter.title,
        EventItemMatterUrl: matter.matter_url || `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${matterId}`,
      };
      const items = itemsByMatter.get(matterId) || [];
      if (!items.some((row) => String(row.EventItemEventId) === eventId)) items.push(item);
      itemsByMatter.set(matterId, items);
    }
  }
  for (const [matterId, items] of itemsByMatter) {
    historiesByMatter.set(matterId, items.map((item, index) => ({
      MatterHistoryId: Number(`${item.EventItemEventId}${index + 1}`),
      MatterHistoryEventId: item.EventItemEventId,
      MatterHistoryActionName: item.EventItemActionName,
      MatterHistoryActionDate: events.get(String(item.EventItemEventId))?.EventDate,
    })));
  }
  return { itemsByMatter, events, historiesByMatter, votesByItem: new Map() };
}

export function releaseLaterPackets(catalog, snapshot, oracle = ORACLE) {
  const full = catalogFromSnapshot(snapshot);
  for (const watch of FROZEN_LATER_EVENT_WATCHES) {
    const later = (full.itemsByMatter.get(watch.matter_id) || [])
      .filter((item) => String(item.EventItemEventId) === watch.later_event);
    const current = catalog.itemsByMatter.get(watch.matter_id) || [];
    for (const item of later) {
      if (!current.some((row) => row.EventItemId === item.EventItemId)) current.push(item);
    }
    catalog.itemsByMatter.set(watch.matter_id, current);
    const event = full.events.get(watch.later_event);
    if (event) catalog.events.set(watch.later_event, event);
    catalog.historiesByMatter.set(watch.matter_id, (catalog.itemsByMatter.get(watch.matter_id) || []).map((item, index) => ({
      MatterHistoryId: Number(`${item.EventItemEventId}${index + 1}`),
      MatterHistoryEventId: item.EventItemEventId,
      MatterHistoryActionName: item.EventItemActionName,
      MatterHistoryActionDate: catalog.events.get(String(item.EventItemEventId))?.EventDate,
    })));
  }
  return { catalog, later_notices_in_discovery: [], oracle };
}

async function publishFromJournal(env, snapshot, journalRows, now, generationId) {
  const lookup = buildLegislativeMatterLookup(snapshotFromJournalAppearances(snapshot, journalRows));
  const index = buildLegislativeMatterIndex(lookup);
  return publishMatterGeneration(env, {
    lookup,
    index,
    published_at: new Date(now).toISOString(),
    generation_id: generationId,
    source_vintage: snapshot.generated_at,
  });
}

async function watchRecord(matterId) {
  const local = `coverage-recovery-${matterId}`;
  const record = buildSubscription({
    email: `${local}@example.com`,
    lens: "meetings",
    filter: { matter_ref: `legistar:nyc:matter:${matterId}`, matter_scope_version: 1 },
  });
  record.subscriber_id = await deriveSubscriberId(record.email);
  record.watch_id = await deriveWatchId(`coverage:${matterId}`);
  record.key = `coverage:${matterId}`;
  record.freq = "daily";
  record.channel = "email";
  record.lang = "en";
  record.createdAt = START.toISOString();
  return record;
}

async function enqueueWatchUpdates(env, record, now) {
  const updates = await eligibleMatterWatchRows(env, record, { asOf: new Date(now).toISOString().slice(0, 10) });
  const result = await enqueueEvaluatedSection(env.DB, {
    lens: "meetings",
    kind: "council-matter",
    status: "success",
    watch_id: record.watch_id,
    subscriber_id: record.subscriber_id,
    freshRows: updates,
    now: new Date(now).toISOString(),
  });
  return { updates, result };
}

const REFRESH_BUDGET = { maxMatters: 50, maxRequests: 400 };

async function drainRoster(env, catalog, now, cycles = 4, script = {}) {
  const { fetchImpl, requests } = createPublisherFetch(catalog, script);
  let clock = new Date(now);
  let last = null;
  for (let i = 0; i < cycles; i += 1) {
    last = await refreshExactMatterRoster(env, {
      now: clock,
      fetchImpl,
      ...REFRESH_BUDGET,
    });
    if ((last.deferred || 0) === 0 && last.status === "complete") {
      return { receipt: last, now: clock, requests };
    }
    clock = new Date(clock.getTime() + DEFAULT_REFRESH_CADENCE_MS + 1000);
  }
  return { receipt: last, now: clock, requests };
}

export async function runFrozenCoverageReplay({
  dayOffset = 0,
  restart = true,
  partialFailure = true,
} = {}) {
  const oracle = ORACLE;
  const withheld = withholdLaterMatterPackets(SNAPSHOT, oracle);
  const { sqlite, env } = coverageRecoveryDatabase();
  const now0 = new Date(START.getTime() + dayOffset * 86_400_000);
  await retainSnapshotMatterObservations(env, withheld, { acquiredAt: now0.toISOString() });
  for (const matterId of oracle.matter_ids) {
    await upsertRosterEntry(env, { matterId, kind: ROSTER_KIND.explicitRetained, now: now0 });
  }
  const watches = [];
  for (const row of FROZEN_LATER_EVENT_WATCHES) {
    await upsertRosterEntry(env, { matterId: row.matter_id, kind: ROSTER_KIND.activeWatch, now: now0 });
    const record = await watchRecord(row.matter_id);
    const observations = (await readJournalRows(env)).filter((item) => String(item.matter_id) === row.matter_id);
    const laterPreloaded = observations.some((item) => String(item.event_id) === row.later_event);
    if (laterPreloaded) throw new Error(`later event for ${row.matter_id} was preloaded before collector release`);
    await confirmExactMatterWatch(env, record, {
      now: now0.toISOString(),
      observations,
    });
    watches.push(record);
  }

  let journal = await readJournalRows(env);
  const beforeRelease = {
    matters: countMaterializedMatters(journal),
    appearances: countDistinctAppearances(journal),
    later: laterDiscoveries(journal, oracle).length,
  };
  await publishFromJournal(env, SNAPSHOT, journal, now0, `gen-baseline-${dayOffset}`);

  let owed = 0;
  for (const record of watches) {
    const { result } = await enqueueWatchUpdates(env, record, now0);
    owed += result.enqueued || 0;
  }

  const catalog = catalogFromSnapshot(withheld);
  const baselineDrain = await drainRoster(env, catalog, now0);
  journal = await readJournalRows(env);
  if (laterDiscoveries(journal, oracle).length !== 0) {
    throw new Error("later packets arrived before collector release");
  }
  if (baselineDrain.requests.some((row) => /dg92-zbpx|cityofnewyork/i.test(row.path))) {
    throw new Error("collector used City Record discovery");
  }

  const released = releaseLaterPackets(catalog, SNAPSHOT, oracle);
  const laterStart = new Date(baselineDrain.now.getTime() + DEFAULT_REFRESH_CADENCE_MS + 60_000);
  const laterDrain = await drainRoster(env, catalog, laterStart);
  const collected = laterDrain.receipt;
  const laterNow = laterDrain.now;
  journal = await readJournalRows(env);
  const discovered = laterDiscoveries(journal, oracle);
  await publishFromJournal(env, SNAPSHOT, journal, new Date(laterNow.getTime() + 60_000), `gen-later-${dayOffset}`);

  let logical = 0;
  let replayDuplicates = 0;
  const updateKeys = [];
  for (const record of watches) {
    const first = await enqueueWatchUpdates(env, record, new Date(laterNow.getTime() + 120_000));
    logical += first.result.enqueued || 0;
    updateKeys.push(...first.updates.map((row) => row.matter_update_key));
    const replay = await enqueueWatchUpdates(env, record, new Date(laterNow.getTime() + 180_000));
    replayDuplicates += replay.result.enqueued || 0;
  }

  const day181 = new Date(now0.getTime() + 181 * 86_400_000);
  if (partialFailure) {
    const failing = createPublisherFetch(catalog, { pageTwoFailure: true });
    await refreshExactMatterRoster(env, {
      now: day181,
      fetchImpl: failing.fetchImpl,
      maxMatters: 64,
      maxRequests: 600,
      pageSize: 1,
    });
  }
  if (restart) {
    const crash = createPublisherFetch(catalog);
    try {
      await refreshExactMatterRoster(env, {
        now: day181,
        fetchImpl: crash.fetchImpl,
        maxMatters: 1,
        pageSize: 1,
        maxRequests: 20,
        crashAfterPage: true,
      });
    } catch {
      // injected crash; cursor remains
    }
  }
  const recovered181Drain = await drainRoster(env, catalog, new Date(day181.getTime() + 16 * 60 * 1000));
  const recovered181 = recovered181Drain.receipt;
  const journal181 = await readJournalRows(env);
  let recoveredUpdates = 0;
  for (const record of watches) {
    const replay = await enqueueWatchUpdates(env, record, day181);
    recoveredUpdates += replay.result.enqueued || 0;
  }

  const day365 = new Date(now0.getTime() + 365 * 86_400_000);
  const recovered365Drain = await drainRoster(env, catalog, day365);
  const recovered365 = recovered365Drain.receipt;
  const journal365 = await readJournalRows(env);
  let recoveredUpdates365 = 0;
  for (const record of watches) {
    const replay = await enqueueWatchUpdates(env, record, day365);
    recoveredUpdates365 += replay.result.enqueued || 0;
  }

  const receipt = await projectMatterCoverageReceipt(env, { now: day365 });
  const counts = {
    materialized_matters: countMaterializedMatters(journal365),
    distinct_appearances: countDistinctAppearances(journal365),
    later_event_discoveries: laterDiscoveries(journal365, oracle).length,
    logical_later_updates: logical,
    replay_duplicates: replayDuplicates,
    recovered_updates_181: recoveredUpdates,
    recovered_updates_365: recoveredUpdates365,
  };
  const acceptance = buildAcceptanceIndex({
    A1: {
      status: counts.materialized_matters === 64
        && counts.distinct_appearances === 79
        && counts.later_event_discoveries === 15
        && counts.logical_later_updates === 15
        && counts.replay_duplicates === 0
        ? "pass" : "fail",
      evidence: counts,
    },
    A2: {
      status: beforeRelease.later === 0 && owed === 0 && released.later_notices_in_discovery.length === 0 ? "pass" : "fail",
      evidence: { beforeRelease, baseline_owed: owed, discovery: released.later_notices_in_discovery },
    },
    A3: {
      status: countMaterializedMatters(journal181) === 64
        && countDistinctAppearances(journal181) === 79
        && laterDiscoveries(journal181, oracle).length === 15
        && recoveredUpdates === 0
        && recoveredUpdates365 === 0
        && countDistinctAppearances(journal365) === 79
        ? "pass" : "fail",
      evidence: {
        day181: { matters: countMaterializedMatters(journal181), appearances: countDistinctAppearances(journal181), recoveredUpdates },
        day365: { matters: countMaterializedMatters(journal365), appearances: countDistinctAppearances(journal365), recoveredUpdates365 },
      },
    },
  });

  return {
    sqlite,
    env,
    oracle,
    withheld,
    catalog,
    collector_requests: [...baselineDrain.requests, ...laterDrain.requests],
    collected,
    recovered181,
    recovered365,
    counts,
    beforeRelease,
    discovered,
    updateKeys,
    receipt,
    acceptance,
    data_vintage: DATA_VINTAGE,
    durability: false,
  };
}

const STALE_OFFSET = 48 * 60 * 60 * 1000 + 60_000;

async function seedOneWatch(env, matterId = FROZEN_LATER_EVENT_WATCHES[5].matter_id) {
  const withheld = withholdLaterMatterPackets(SNAPSHOT, ORACLE);
  await retainSnapshotMatterObservations(env, withheld, { acquiredAt: START.toISOString() });
  await upsertRosterEntry(env, { matterId, kind: ROSTER_KIND.activeWatch, now: START });
  const catalog = catalogFromSnapshot(withheld);
  await refreshExactMatterRoster(env, {
    now: START,
    fetchImpl: createPublisherFetch(catalog).fetchImpl,
    maxMatters: 1,
    maxRequests: 40,
  });
  return { withheld, catalog, matterId };
}

export async function runStaleRefreshFault() {
  const { sqlite, env } = coverageRecoveryDatabase();
  const seeded = await seedOneWatch(env);
  const staleAt = new Date(START.getTime() + STALE_OFFSET);
  const before = await projectMatterCoverageReceipt(env, { now: staleAt });
  const recovered = await recoverStaleRefresh(env, {
    now: staleAt,
    fetchImpl: createPublisherFetch(seeded.catalog).fetchImpl,
    maxMatters: 1,
    maxRequests: 40,
  });
  sqlite.close();
  return { durability: true, label: "stale-refresh-48h", before, after: recovered.coverage };
}

export async function runPublicationLagFault() {
  const { sqlite, env } = coverageRecoveryDatabase();
  const seeded = await seedOneWatch(env);
  let journal = await readJournalRows(env);
  await publishFromJournal(env, SNAPSHOT, journal, START, "gen-lag-baseline");
  releaseLaterPackets(seeded.catalog, SNAPSHOT, ORACLE);
  const collectedAt = new Date(START.getTime() + DEFAULT_REFRESH_CADENCE_MS + 60_000);
  await refreshExactMatterRoster(env, {
    now: collectedAt,
    fetchImpl: createPublisherFetch(seeded.catalog).fetchImpl,
    maxMatters: 1,
    maxRequests: 40,
  });
  const laggedAt = new Date(collectedAt.getTime() + 2 * DEFAULT_REFRESH_CADENCE_MS + 60_000);
  const before = await projectMatterCoverageReceipt(env, { now: laggedAt });
  journal = await readJournalRows(env);
  const lookup = buildLegislativeMatterLookup(snapshotFromJournalAppearances(SNAPSHOT, journal));
  const recovered = await recoverPublicationLag(env, {
    lookup,
    index: buildLegislativeMatterIndex(lookup),
    now: laggedAt,
    generationId: "gen-lag-recovered",
  });
  sqlite.close();
  return { durability: true, label: "publication-lag-two-cycles", before, after: recovered.coverage };
}

export async function runDeliveryLagFault() {
  const replay = await runFrozenCoverageReplay({ restart: false, partialFailure: false });
  const lastOwed = replay.receipt.observed_at;
  const laggedAt = new Date(Date.parse(lastOwed) + 2 * DEFAULT_REFRESH_CADENCE_MS + 60_000);
  const before = await projectMatterCoverageReceipt(replay.env, { now: laggedAt });
  const recovered = await recoverPendingDelivery(replay.env, { now: laggedAt });
  replay.sqlite.close();
  return { durability: true, label: "pending-delivery-two-cycles", before, after: recovered.coverage };
}

export { STALE_OFFSET };
