import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  classifyCouncilMatterChange,
  councilMatterActionIdentity,
  MATTER_UPDATE_KIND,
  matterUpdateKey,
  reduceCouncilMatterWatchUpdates,
  renderCouncilMatterWatchUpdate,
} from "../../site/council_matter_watch_change.mjs";
import { councilMatterWatchSummaryHtml } from "../../site/council_matter_watch.mjs";
import { extractLensIdentity, enqueueEvaluatedSection, listAllOwedItems, SECTION_STATUS } from "../src/lib/digest_outbox.mjs";
import { reconcileTemporalCandidates } from "../src/lib/alert_temporal.mjs";
import { compileSub } from "../src/lib/compile.mjs";
import {
  confirmExactMatterWatch,
  eligibleMatterWatchRows,
} from "../src/lib/council_matter_watch_activation.mjs";
import { processOneSub, subDigestHtml } from "../src/alerts.mjs";
import { buildSubscription, deriveSubscriberId, deriveWatchId } from "../src/lib/subscriptions.mjs";
import { projectCivicOutcomeTransition } from "../../site/civic_outcome_transition.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const outboxSql = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const sourceSql = readFileSync(new URL("../migrations/0008_source_records.sql", import.meta.url), "utf8");
const journalSql = readFileSync(new URL("../migrations/0027_matter_observation_journal.sql", import.meta.url), "utf8");
const baselineSql = readFileSync(new URL("../migrations/0029_matter_watch_baseline.sql", import.meta.url), "utf8");

const TEN = Object.freeze([
  { matter_id: "79163", early_event: "22567", later_event: "22526", early_notice: "20260625040", later_notice: "20260706036" },
  { matter_id: "79164", early_event: "22567", later_event: "22526", early_notice: "20260625040", later_notice: "20260706036" },
  { matter_id: "79062", early_event: "22567", later_event: "22526", early_notice: "20260625040", later_notice: "20260706036" },
  { matter_id: "79063", early_event: "22567", later_event: "22526", early_notice: "20260625040", later_notice: "20260706036" },
  { matter_id: "79064", early_event: "22567", later_event: "22526", early_notice: "20260625040", later_notice: "20260706036" },
  { matter_id: "78605", early_event: "22342", later_event: "22375", early_notice: "20260408025", later_notice: "20260428021" },
  { matter_id: "78606", early_event: "22342", later_event: "22375", early_notice: "20260408025", later_notice: "20260428021" },
  { matter_id: "78682", early_event: "22342", later_event: "22375", early_notice: "20260408025", later_notice: "20260428021" },
  { matter_id: "78409", early_event: "22300", later_event: "22365", early_notice: "20260304007", later_notice: "20260331028" },
  { matter_id: "78411", early_event: "22300", later_event: "22365", early_notice: "20260304007", later_notice: "20260331028" },
]);

function matterRef(id) {
  return `legistar:nyc:matter:${id}`;
}

function appearance(matterId, noticeId) {
  const record = snapshot.by_notice[noticeId];
  const matter = (record?.matters || []).find((row) => String(row.matter_id) === String(matterId));
  const action = (Array.isArray(matter?.actions) ? matter.actions.at(-1) : "") || matter?.outcome;
  return {
    observation_id: `obs:${matterId}:${record.event.event_id}:${noticeId}`,
    matter_id: String(matterId),
    event_id: String(record.event.event_id),
    action_name: action,
    title: matter?.title,
    event_time: record.event.date,
    observed_at: record.event.date,
    acquired_at: `${record.event.date}T12:00:00.000Z`,
    published_revision: `rev:${noticeId}:${record.event.event_id}`,
    notice_references: [noticeId],
    semantic_revision: action,
  };
}

function packet(row, which) {
  return appearance(row.matter_id, which === "later" ? row.later_notice : row.early_notice);
}

class MockKV {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(seed));
  }
  async get(key) { return this.store.get(key) ?? null; }
  async put(key, value) { this.store.set(key, String(value)); }
}

function d1(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);
          return {
            async run() {
              const result = values.length ? statement.run(...values) : statement.run();
              return { success: true, meta: { changes: Number(result.changes || 0) } };
            },
            async all() {
              const rows = values.length ? statement.all(...values) : statement.all();
              return { results: rows };
            },
            async first() {
              const row = values.length ? statement.get(...values) : statement.get();
              return row ?? null;
            },
          };
        },
        async run() {
          sqlite.prepare(sql).run();
          return { success: true, meta: { changes: 0 } };
        },
        async all() { return { results: sqlite.prepare(sql).all() }; },
        async first() { return sqlite.prepare(sql).get() ?? null; },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        for (const statement of statements) await statement.run();
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return [];
    },
  };
}

function makeEnv() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(sourceSql);
  sqlite.exec(journalSql);
  sqlite.exec(baselineSql);
  sqlite.exec(outboxSql);
  return {
    sqlite,
    env: {
      DB: d1(sqlite),
      ALERT_STATE: new MockKV(),
      MATTER_WATCH_DELIVERY: "1",
      RESEND_API_KEY: "test-key",
      TOKEN_SECRET: "s".repeat(32),
      CONFIRM_BASE: "https://api.cityscroll.org",
    },
  };
}

function insertJournal(sqlite, row) {
  sqlite.prepare(`INSERT INTO matter_observation_journal (
    observation_id, source_system, tenant, matter_id, event_id, native_event_item_id,
    publisher_action_id, event_time, observed_at, acquired_at, identity_granularity,
    source_record_ref, raw_payload_hash, semantic_revision, notice_references_json,
    title, action_name, vote_binding_status, vote_event_item_id, provenance_json,
    public_hearing_key, superseded_by, created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    row.observation_id,
    "legistar",
    "nyc",
    row.matter_id,
    row.event_id,
    row.native_event_item_id || null,
    null,
    row.event_time || row.observed_at,
    row.observed_at,
    row.acquired_at,
    "coarse",
    `source:${row.observation_id}`,
    row.observation_id,
    row.semantic_revision || row.action_name || row.event_id,
    JSON.stringify(row.notice_references || []),
    row.title || "Council matter",
    row.action_name || null,
    "none",
    null,
    "{}",
    `hearing:${row.event_id}:${row.matter_id}`,
    null,
    row.acquired_at,
  );
}

async function watchRecord(email, matterId) {
  const record = buildSubscription({
    email,
    lens: "meetings",
    filter: { matter_ref: matterRef(matterId), matter_scope_version: 1 },
  });
  record.subscriber_id = await deriveSubscriberId(record.email);
  record.watch_id = await deriveWatchId(`sub:${email}:${matterId}`);
  record.key = `sub:${email}:${matterId}`;
  record.freq = "daily";
  record.channel = "email";
  record.lang = "en";
  record.createdAt = "2026-08-01T00:00:00.000Z";
  return record;
}

function ctx(today = "2026-08-10", extra = {}) {
  let sends = 0;
  return {
    FROM: "CityScroll <alerts@cityscroll.org>",
    LIVE: true,
    today,
    now: `${today}T13:00:00.000Z`,
    isMonday: false,
    heartbeatDays: 14,
    counts: () => ({ "per-run": sends, daily: sends }),
    caps: { "per-run": 25, daily: 50 },
    onSent: async () => { sends += 1; },
    ...extra,
  };
}

function mockResend(sent) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const value = String(url);
    if (value.includes("api.resend.com/emails")) {
      sent.push({ body: JSON.parse(options.body), headers: options.headers });
      return Response.json({ id: `email-${sent.length}` });
    }
    throw new Error(`unexpected fetch: ${value}`);
  };
  return () => { globalThis.fetch = original; };
}

async function enqueueUpdates(db, record, updates, now) {
  return enqueueEvaluatedSection(db, {
    lens: "meetings",
    kind: "council-matter",
    status: "success",
    watch_id: record.watch_id,
    subscriber_id: record.subscriber_id,
    freshRows: updates,
    now,
  });
}

test("A1: ten later-hearing packets create ten logical updates and replay adds none", async () => {
  const { sqlite, env } = makeEnv();
  const owedKeys = [];
  for (const row of TEN) {
    const record = await watchRecord(`reader-${row.matter_id}@example.com`, row.matter_id);
    const early = packet(row, "early");
    const later = packet(row, "later");
    insertJournal(sqlite, early);
    await confirmExactMatterWatch(env, record, {
      now: "2026-08-01T00:00:00.000Z",
      observations: [early],
    });
    const afterBaseline = reduceCouncilMatterWatchUpdates({
      matter_ref: matterRef(row.matter_id),
      observations: [early],
      baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
      asOf: "2026-08-10",
    });
    assert.equal(afterBaseline.length, 0);
    insertJournal(sqlite, later);
    const updates = await eligibleMatterWatchRows(env, record, {
      observations: [early, later],
      asOf: "2026-08-10",
    });
    assert.equal(updates.length, 1, row.matter_id);
    assert.equal(updates[0].matter_id, row.matter_id);
    assert.equal(updates[0].kind, MATTER_UPDATE_KIND.OCCURRED);
    const first = await enqueueUpdates(env.DB, record, updates, "2026-08-10T13:00:00.000Z");
    assert.equal(first.enqueued, 1);
    const replay = await enqueueUpdates(env.DB, record, updates, "2026-08-10T14:00:00.000Z");
    assert.equal(replay.enqueued, 0);
    assert.equal(replay.duplicates, 1);
    owedKeys.push(updates[0].matter_update_key);
  }
  assert.equal(new Set(owedKeys).size, 10);
  const total = sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items WHERE status = 'owed'").get().n;
  assert.equal(total, 10);
});

test("A2: a later action on an already-seen notice is eligible without a request_id identity", () => {
  const early = packet(TEN[5], "early");
  const laterOnSameNotice = {
    ...early,
    observation_id: "obs-same-notice-later-action",
    action_name: "Approved by Subcommittee",
    semantic_revision: "Approved by Subcommittee",
    acquired_at: "2026-08-11T00:00:00.000Z",
    published_revision: "rev:same-notice-later-action",
  };
  const updates = reduceCouncilMatterWatchUpdates({
    matter_ref: matterRef("78605"),
    observations: [early, laterOnSameNotice],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    asOf: "2026-08-12",
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].kind, MATTER_UPDATE_KIND.CORRECTION);
  const identity = extractLensIdentity("meetings", updates[0]);
  assert.equal(identity.identityField, "matter_update_key");
  assert.equal(identity.itemId, updates[0].matter_update_key);
  assert.doesNotMatch(identity.itemId, /^notice:/);
  assert.equal(updates[0].request_id, undefined);
});

test("A3: a later Laid Over event is new, and a later action after a vote is not ranked away", () => {
  const vote = {
    observation_id: "obs-vote",
    matter_id: "78605",
    event_id: "22342",
    native_event_item_id: "item-1",
    action_name: "Approved by Subcommittee",
    vote: { result: "Pass" },
    event_time: "2026-04-22",
    observed_at: "2026-04-22",
    acquired_at: "2026-04-22T12:00:00.000Z",
    published_revision: "rev-vote",
  };
  const laterLaidOver = {
    observation_id: "obs-later-laid",
    matter_id: "78605",
    event_id: "22999",
    action_name: "Laid Over by Subcommittee",
    event_time: "2026-06-01",
    observed_at: "2026-06-01",
    acquired_at: "2026-06-01T12:00:00.000Z",
    published_revision: "rev-later-laid",
  };
  const laterAction = {
    observation_id: "obs-later-action",
    matter_id: "78605",
    event_id: "23000",
    native_event_item_id: "item-2",
    action_name: "Hearing Held by Committee",
    event_time: "2026-06-15",
    observed_at: "2026-06-15",
    acquired_at: "2026-06-15T12:00:00.000Z",
    published_revision: "rev-later-action",
  };
  const rankedAway = projectCivicOutcomeTransition({
    subject_ref: "matter:78605",
    previous: { state: "vote", outcome_state: "recorded", event: { type: "vote", value: "Pass" } },
    current: { state: "action", outcome_state: "recorded", event: { type: "action", value: "Hearing Held by Committee" } },
    kind: "matter",
  });
  assert.equal(rankedAway.transition, null);
  const updates = reduceCouncilMatterWatchUpdates({
    matter_ref: matterRef("78605"),
    observations: [vote, laterLaidOver, laterAction],
    baseline: { observation_ids: [vote.observation_id], baseline_acquired_at: vote.acquired_at },
    asOf: "2026-07-01",
  });
  assert.equal(updates.length, 2);
  assert.ok(updates.every((row) => row.kind === MATTER_UPDATE_KIND.OCCURRED));
  assert.ok(updates.some((row) => row.action_name === "Laid Over by Subcommittee"));
  assert.ok(updates.some((row) => row.action_name === "Hearing Held by Committee"));
  assert.notEqual(
    councilMatterActionIdentity(laterLaidOver, matterRef("78605")),
    councilMatterActionIdentity(vote, matterRef("78605")),
  );
});

test("A4: scheduled is not held; correction is labelled; quiet edits produce nothing", () => {
  const early = packet(TEN[5], "early");
  const scheduled = {
    observation_id: "obs-scheduled",
    matter_id: "78605",
    event_id: "24000",
    action_name: "",
    status: "scheduled",
    event_time: "2026-12-01",
    observed_at: "2026-12-01",
    acquired_at: "2026-08-20T00:00:00.000Z",
    published_revision: "rev-scheduled",
  };
  const correction = {
    ...packet(TEN[5], "later"),
    observation_id: "obs-correction",
    action_name: "Amended by Subcommittee",
    semantic_revision: "Amended by Subcommittee",
    published_revision: "rev-correction",
    acquired_at: "2026-08-21T00:00:00.000Z",
  };
  const quiet = [
    { ...early, observation_id: "obs-title", title: "Renamed file", acquired_at: "2026-08-22T00:00:00.000Z", published_revision: "rev-title" },
    { ...early, observation_id: "obs-format", action_name: "Laid Over by   Subcommittee", acquired_at: "2026-08-23T00:00:00.000Z", published_revision: "rev-format" },
    { ...early, observation_id: "obs-notice", notice_references: [early.notice_references[0], "20260430007"], acquired_at: "2026-08-24T00:00:00.000Z", published_revision: "rev-notice" },
    { ...early, observation_id: "obs-acquired", acquired_at: "2026-08-25T00:00:00.000Z", published_revision: early.published_revision },
  ];
  const scheduledUpdates = reduceCouncilMatterWatchUpdates({
    matter_ref: matterRef("78605"),
    observations: [early, scheduled],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    asOf: "2026-08-10",
  });
  assert.equal(scheduledUpdates.length, 1);
  assert.equal(scheduledUpdates[0].kind, MATTER_UPDATE_KIND.SCHEDULED);
  assert.match(scheduledUpdates[0].short_title, /scheduled/i);
  assert.doesNotMatch(scheduledUpdates[0].short_title, /\bheld\b/i);
  const corrected = reduceCouncilMatterWatchUpdates({
    matter_ref: matterRef("78605"),
    observations: [early, packet(TEN[5], "later"), correction],
    baseline: {
      observation_ids: [early.observation_id, packet(TEN[5], "later").observation_id],
      baseline_acquired_at: packet(TEN[5], "later").acquired_at,
    },
    asOf: "2026-08-22",
  });
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].kind, MATTER_UPDATE_KIND.CORRECTION);
  assert.match(corrected[0].short_title, /corrected/i);
  const quietUpdates = reduceCouncilMatterWatchUpdates({
    matter_ref: matterRef("78605"),
    observations: [early, ...quiet],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    asOf: "2026-08-26",
  });
  assert.equal(quietUpdates.length, 0);
  assert.equal(classifyCouncilMatterChange({ current: scheduled, asOf: "2026-08-10" }), MATTER_UPDATE_KIND.SCHEDULED);
});

test("A5: reducer sequence is [0,1,0,0,1,1,1,0] through persisted outbox after restart", async () => {
  const { sqlite, env } = makeEnv();
  const record = await watchRecord("seq@example.com", "78605");
  const early = packet(TEN[5], "early");
  const later = packet(TEN[5], "later");
  const counts = [];
  async function step(observations) {
    const updates = reduceCouncilMatterWatchUpdates({
      matter_ref: matterRef("78605"),
      observations,
      baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
      asOf: "2026-08-10",
    });
    const result = await enqueueUpdates(env.DB, record, updates, "2026-08-10T13:00:00.000Z");
    counts.push(result.enqueued);
    for (const item of await listAllOwedItems(env.DB, record.subscriber_id)) {
      sqlite.prepare(`UPDATE digest_outbox_items SET status = 'delivered', delivered_at = ? WHERE watch_id = ? AND item_id = ?`)
        .run("2026-08-10T13:05:00.000Z", item.watch_id, item.item_id);
    }
    return updates;
  }
  await confirmExactMatterWatch(env, record, { now: "2026-08-01T00:00:00.000Z", observations: [early] });
  await step([early]);
  await step([early, later]);
  const snapshotState = sqlite.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL").all();
  assert.ok(snapshotState.length > 0);
  await step([early, later]);
  await step([
    early,
    { ...later, observation_id: "dup-notice", notice_references: [...later.notice_references, "20260430007"], title: "  File  ", action_name: "Approved by   Subcommittee" },
  ]);
  const laidOverAgain = {
    observation_id: "obs-repeat-laid",
    matter_id: "78605",
    event_id: "23111",
    action_name: "Laid Over by Subcommittee",
    event_time: "2026-06-20",
    observed_at: "2026-06-20",
    acquired_at: "2026-06-20T12:00:00.000Z",
    published_revision: "rev-repeat-laid",
  };
  await step([early, later, laidOverAgain]);
  const correction = {
    ...laidOverAgain,
    observation_id: "obs-correct-laid",
    action_name: "Laid Over by Committee as corrected",
    semantic_revision: "Laid Over by Committee as corrected",
    published_revision: "rev-correct-laid",
    acquired_at: "2026-06-21T12:00:00.000Z",
  };
  await step([early, later, laidOverAgain, correction]);
  const scheduled = {
    observation_id: "obs-future",
    matter_id: "78605",
    event_id: "24001",
    action_name: "",
    status: "scheduled",
    event_time: "2026-12-15",
    observed_at: "2026-12-15",
    acquired_at: "2026-08-20T00:00:00.000Z",
    published_revision: "rev-future",
  };
  await step([early, later, laidOverAgain, correction, scheduled]);
  await step([early, later, laidOverAgain, correction, scheduled]);
  assert.deepEqual(counts, [0, 1, 0, 0, 1, 1, 1, 0]);
});

test("A6: crash before enqueue, after enqueue, after provider accept, and before receipt keep one logical item", async () => {
  const sent = [];
  const restore = mockResend(sent);
  try {
    for (const crash of [null, "before-enqueue", "after-enqueue", "after-provider-accept", "before-receipt"]) {
      const { sqlite, env } = makeEnv();
      const record = await watchRecord(`crash-${crash || "ok"}@example.com`, "78605");
      const early = packet(TEN[5], "early");
      const later = packet(TEN[5], "later");
      insertJournal(sqlite, early);
      await confirmExactMatterWatch(env, record, { now: "2026-08-01T00:00:00.000Z", observations: [early] });
      insertJournal(sqlite, later);
      const first = await processOneSub(env, record, ctx("2026-08-10", crash ? { injectCrash: crash } : {}));
      const owedAfterCrash = sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items").get().n;
      if (crash === "before-enqueue") {
        assert.match(String(first.error || ""), /before-enqueue/);
        assert.equal(owedAfterCrash, 0);
      } else if (crash === "after-enqueue") {
        assert.match(String(first.error || ""), /after-enqueue/);
        assert.equal(owedAfterCrash, 1);
      } else if (crash === "after-provider-accept" || crash === "before-receipt") {
        assert.match(String(first.error || ""), /injected-crash/);
        assert.equal(owedAfterCrash, 1);
        assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items").get().status, "owed");
      } else {
        assert.equal(first.error, undefined, JSON.stringify(first));
        assert.equal(first.sent, true);
        assert.equal(first.new, 1);
        assert.match(first.preview?.html || sent.at(-1)?.body.html || "", /Officials recorded/i);
        assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items").get().status, "delivered");
        assert.ok(sent.at(-1)?.headers?.["Idempotency-Key"] || sent.at(-1)?.headers?.["idempotency-key"]);
      }
      const retry = await processOneSub(env, record, ctx("2026-08-10"));
      const owed = sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items").get().n;
      assert.equal(owed, crash === "before-enqueue" || !crash ? owed : 1);
      if (crash === "after-provider-accept" || crash === "before-receipt") {
        assert.equal(retry.occasionReserved || retry.sent === false || retry.physicalSendAmbiguous, true);
        assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items").get().n, 1);
      }
      if (crash === "before-enqueue") {
        assert.equal(retry.sent, true);
        assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM digest_outbox_items").get().n, 1);
      }
    }
  } finally {
    restore();
  }
});

test("A7: digest selection, temporal reconciliation, outbox identity, rendering, and acknowledgement run together", async () => {
  const { sqlite, env } = makeEnv();
  const record = await watchRecord("pipeline@example.com", "78605");
  const early = packet(TEN[5], "early");
  const later = packet(TEN[5], "later");
  insertJournal(sqlite, early);
  await confirmExactMatterWatch(env, record, { now: "2026-08-01T00:00:00.000Z", observations: [early] });
  insertJournal(sqlite, later);
  const compiled = compileSub(record, "2026-08-10");
  assert.equal(compiled.idField, "matter_update_key");
  const rows = await eligibleMatterWatchRows(env, record, { observations: [early, later], asOf: "2026-08-10" });
  const reconciled = reconcileTemporalCandidates({
    lens: "meetings",
    rows,
    seen: new Set(),
    idField: compiled.idField,
  });
  assert.equal(reconciled.fresh.length, 1);
  assert.equal(reconciled.markSeenIds[0], rows[0].matter_update_key);
  const html = subDigestHtml(
    "New York City Council matter 78605 — exact matter",
    "council-matter",
    reconciled.fresh,
    "https://example.test/unsub",
    "2026-08-01",
  );
  assert.match(html, /View matter history/);
  assert.match(html, /Officials recorded/);
  assert.doesNotMatch(html, /held/i);
  const sent = [];
  const restore = mockResend(sent);
  try {
    const result = await processOneSub(env, record, ctx("2026-08-10"));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.sent, true);
    assert.equal(result.new, 1);
    assert.match(sent[0].body.html, /View matter history/);
    assert.equal(sqlite.prepare("SELECT status FROM digest_outbox_items").get().status, "delivered");
    const replay = await processOneSub(env, record, ctx("2026-08-11"));
    assert.equal(replay.new, 0);
    assert.equal(sent.length, 1);
  } finally {
    restore();
  }
});

test("A8: overlapping follows coalesce; distinct recipients do not; notice and rules identities stay put", async () => {
  const { env } = makeEnv();
  const later = packet(TEN[5], "later");
  const early = packet(TEN[5], "early");
  const updates = reduceCouncilMatterWatchUpdates({
    matter_ref: matterRef("78605"),
    observations: [early, later],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    asOf: "2026-08-10",
  });
  const owner = await watchRecord("same@example.com", "78605");
  const overlap = { ...owner, watch_id: await deriveWatchId("sub:same-overlap") };
  const other = await watchRecord("other@example.com", "78605");
  const first = await enqueueUpdates(env.DB, owner, updates, "2026-08-10T13:00:00.000Z");
  const second = await enqueueUpdates(env.DB, overlap, updates, "2026-08-10T13:00:00.000Z");
  const third = await enqueueUpdates(env.DB, other, updates, "2026-08-10T13:00:00.000Z");
  assert.equal(first.enqueued, 1);
  assert.equal(second.enqueued, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(third.enqueued, 1);
  assert.deepEqual(extractLensIdentity("meetings", { request_id: "20260810001" }), {
    identityField: "request_id",
    identityValue: "20260810001",
    itemId: "notice:20260810001",
    itemKind: "meetings",
  });
  assert.equal(extractLensIdentity("rules", {
    request_id: "20260810001",
    temporal_action: { kind: "rules-comment-open", event_at: "2026-08-20" },
  }).itemId, "rules:temporal:rules:20260810001:comment-open:2026-08-20");
  const notice = await enqueueEvaluatedSection(env.DB, {
    lens: "meetings",
    kind: "meetings",
    status: SECTION_STATUS.SUCCESS,
    watch_id: "watch:notice",
    subscriber_id: "subscriber:notice",
    freshRows: [{ request_id: "20260810001", short_title: "Hearing" }],
    now: "2026-08-10T13:00:00.000Z",
  });
  assert.equal(notice.enqueued, 1);
  assert.equal(notice.item_ids[0], "notice:20260810001");
});

test("one published revision with two action strings is one logical update", () => {
  const early = packet(TEN[2], "early");
  const held = {
    observation_id: "obs-held",
    matter_id: "79062",
    event_id: "22526",
    native_event_item_id: "item-a",
    action_name: "Hearing Held by Committee",
    event_time: "2026-07-14",
    observed_at: "2026-07-14",
    acquired_at: "2026-07-14T12:00:00.000Z",
    published_revision: "rev-later-packet",
  };
  const approved = {
    observation_id: "obs-approved",
    matter_id: "79062",
    event_id: "22526",
    native_event_item_id: "item-b",
    action_name: "Approved by Subcommittee",
    event_time: "2026-07-14",
    observed_at: "2026-07-14",
    acquired_at: "2026-07-14T12:00:00.000Z",
    published_revision: "rev-later-packet",
  };
  const updates = reduceCouncilMatterWatchUpdates({
    matter_ref: matterRef("79062"),
    observations: [early, held, approved],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    asOf: "2026-08-10",
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].constituents.length, 2);
  assert.equal(updates[0].matter_update_key, matterUpdateKey(matterRef("79062"), "rev-later-packet"));
});

test("update rendering keeps a durable matter link and source disclosure", () => {
  const update = reduceCouncilMatterWatchUpdates({
    matter_ref: matterRef("78605"),
    observations: [packet(TEN[5], "early"), packet(TEN[5], "later")],
    baseline: {
      observation_ids: [packet(TEN[5], "early").observation_id],
      baseline_acquired_at: packet(TEN[5], "early").acquired_at,
    },
    asOf: "2026-08-10",
  })[0];
  const html = renderCouncilMatterWatchUpdate(update);
  assert.match(html, /href="\/matters\/78605\/"/);
  assert.match(html, /View matter history/);
  assert.match(html, /Source identity and acquisition/);
  const summary = councilMatterWatchSummaryHtml({ lens: "meetings", matter_id: "78605" }, { latest: update, stale: true });
  assert.match(summary, /last known history is still shown/i);
  assert.match(summary, /Officials recorded/);
});
