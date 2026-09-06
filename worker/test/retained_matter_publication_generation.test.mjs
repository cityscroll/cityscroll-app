/**
 * Pages and saved watches share one retained matter publication generation.
 *
 *   node --test worker/test/retained_matter_publication_generation.test.mjs
 *
 * Page requests, publication, and delivery eligibility use retained fixtures.
 * No test contacts a publisher.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  buildLegislativeMatterIndex,
  buildLegislativeMatterLookup,
} from "../../tools/build_legislative_matter_documents.mjs";
import edgeWorker from "../../site/pages_edge.mjs";
import {
  MATTER_COVERAGE_STATE,
  coverageCopy,
  decideUpdateRelease,
} from "../../site/matter_publication_generation.mjs";
import {
  buildLegislativeMatterDocument,
  renderLegislativeMatterDocument,
} from "../../site/legislative_matter_document.mjs";
import {
  councilMatterChoiceMarkup,
  councilMatterFollowMarkup,
  councilMatterWatchSummaryHtml,
  exactCouncilMatterWatch,
} from "../../site/council_matter_watch.mjs";
import { reduceCouncilMatterWatchUpdates } from "../../site/council_matter_watch_change.mjs";
import {
  projectCouncilHearingMatterContinuation,
  renderCouncilHearingMatterContinuation,
} from "../../site/council_hearing_matter_continuation.mjs";
import { extractLensIdentity, enqueueEvaluatedSection, listAllOwedItems } from "../src/lib/digest_outbox.mjs";
import {
  confirmExactMatterWatch,
  eligibleMatterWatchRows,
  matterWatchActivationReadiness,
  removeExactMatterWatch,
} from "../src/lib/council_matter_watch_activation.mjs";
import { publishMatterGeneration, readPublishedMatterLookup } from "../src/lib/matter_publication.mjs";
import { buildSubscription, deriveSubscriberId, deriveWatchId } from "../src/lib/subscriptions.mjs";
import { LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG } from "../src/lib/legistar_source_records.mjs";

const snapshot = JSON.parse(readFileSync(new URL("../../site/data/meeting_outcomes_snapshot.json", import.meta.url), "utf8"));
const committedLookup = buildLegislativeMatterLookup(snapshot);
const outboxSql = readFileSync(new URL("../migrations/0018_digest_outbox.sql", import.meta.url), "utf8");
const sourceSql = readFileSync(new URL("../migrations/0008_source_records.sql", import.meta.url), "utf8");
const journalSql = readFileSync(new URL("../migrations/0027_matter_observation_journal.sql", import.meta.url), "utf8");
const refreshSql = readFileSync(new URL("../migrations/0028_matter_exact_refresh.sql", import.meta.url), "utf8");
const baselineSql = readFileSync(new URL("../migrations/0029_matter_watch_baseline.sql", import.meta.url), "utf8");

const MATTER_ID = "78605";
const MATTER_REF = `legistar:nyc:matter:${MATTER_ID}`;
const EARLY_NOTICE = "20260408025";
const LATER_NOTICE = "20260428021";
const HEARING_NOTICE = "20260408025";
const FIVE_MATTER_NOTICE = "20260707021";
const DATA_VINTAGE = snapshot.generated_at;

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

function publisherTracker() {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = String(input?.url || input);
    calls.push(url);
    throw new Error(`publisher call forbidden: ${url}`);
  };
  return { calls, fetchImpl };
}

function lookupFromNotices(noticeIds, generatedAt = DATA_VINTAGE) {
  const by_notice = {};
  for (const id of noticeIds) {
    if (snapshot.by_notice[id]) by_notice[id] = snapshot.by_notice[id];
  }
  return buildLegislativeMatterLookup({ ...snapshot, generated_at: generatedAt, by_notice });
}

function makeEnv({ delivery = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(sourceSql);
  sqlite.exec(journalSql);
  sqlite.exec(refreshSql);
  sqlite.exec(baselineSql);
  sqlite.exec(outboxSql);
  const kv = new MockKV();
  const publisher = publisherTracker();
  const env = {
    DB: d1(sqlite),
    ALERT_STATE: kv,
    MATTER_PUBLICATION: kv,
    MATTER_WATCH_DELIVERY: delivery ? "1" : "0",
    [LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG]: "true",
    fetch: publisher.fetchImpl,
  };
  return { sqlite, env, kv, publisher };
}

function assetsEnv(lookup, extra = {}) {
  return {
    ASSETS: {
      async fetch(request) {
        return new URL(request.url).pathname === "/data/legislative_matter_lookup.json"
          ? Response.json(lookup)
          : new Response("missing", { status: 404 });
      },
    },
    ...extra,
  };
}

function appearance(matterId, noticeId, extra = {}) {
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
    notice_references: [noticeId],
    semantic_revision: action,
    ...extra,
  };
}

async function watchRecord(email, matterId) {
  const record = buildSubscription({
    email,
    lens: "meetings",
    filter: { matter_ref: `legistar:nyc:matter:${matterId}`, matter_scope_version: 1 },
  });
  record.subscriber_id = await deriveSubscriberId(record.email);
  record.watch_id = await deriveWatchId(`sub:${email}:${matterId}`);
  record.key = `sub:${email}:${matterId}`;
  return record;
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
    null,
    null,
    row.event_time,
    row.observed_at,
    row.acquired_at,
    "coarse",
    `source:${row.observation_id}`,
    row.observation_id,
    row.semantic_revision || row.action_name,
    JSON.stringify(row.notice_references || []),
    row.title || "Council matter",
    row.action_name,
    "none",
    null,
    "{}",
    `hearing:${row.event_id}:${row.matter_id}`,
    null,
    row.acquired_at,
  );
}

test("A1: a delivered action resolves to a page from the same or newer generation", async () => {
  const { env, publisher } = makeEnv();
  const earlyLookup = lookupFromNotices([EARLY_NOTICE]);
  const laterLookup = lookupFromNotices([EARLY_NOTICE, LATER_NOTICE]);
  const g1 = await publishMatterGeneration(env, {
    lookup: earlyLookup,
    index: buildLegislativeMatterIndex(earlyLookup),
    sequence: 1,
    published_at: "2026-08-10T13:00:00.000Z",
    generation_id: "gen-early",
  });
  assert.equal(g1.promoted, true);
  const g2 = await publishMatterGeneration(env, {
    lookup: laterLookup,
    index: buildLegislativeMatterIndex(laterLookup),
    sequence: 2,
    published_at: "2026-08-10T14:00:00.000Z",
    generation_id: "gen-later",
  });
  assert.equal(g2.promoted, true);

  const early = appearance(MATTER_ID, EARLY_NOTICE, { generation_id: "gen-early" });
  const later = appearance(MATTER_ID, LATER_NOTICE, {
    generation_id: "gen-later",
    published_generation_id: "gen-later",
    published_generation_sequence: 2,
    published_generation_at: "2026-08-10T14:00:00.000Z",
  });
  const [update] = reduceCouncilMatterWatchUpdates({
    matter_ref: MATTER_REF,
    observations: [early, later],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
    publishedGeneration: { generation_id: "gen-later", sequence: 2, published_at: "2026-08-10T14:00:00.000Z" },
  });
  assert.equal(update.action_name, "Approved by Subcommittee");
  assert.equal(update.published_generation_id, "gen-later");

  const published = await readPublishedMatterLookup(env, {});
  const decision = decideUpdateRelease(update, published.generation);
  assert.equal(decision.release, true);
  assert.ok(published.generation.sequence >= 2);

  const page = await edgeWorker.fetch(
    new Request(`https://cityscroll.org/matters/${MATTER_ID}/`),
    assetsEnv(committedLookup, env),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Approved by Subcommittee/);
  assert.match(html, /data-matter-generation="gen-later"/);
  assert.match(html, /data-matter-coverage="current"/);
  assert.doesNotMatch(html, /testimony caused|agency replied|because you/i);
  assert.equal(publisher.calls.length, 0);
  assert.equal(page.headers.get("X-Matter-Generation"), "gen-later");
});

test("A2: interrupted publication keeps the prior complete generation and holds updates", async () => {
  const { env } = makeEnv();
  const earlyLookup = lookupFromNotices([EARLY_NOTICE]);
  const laterLookup = lookupFromNotices([EARLY_NOTICE, LATER_NOTICE]);
  await publishMatterGeneration(env, {
    lookup: earlyLookup,
    index: buildLegislativeMatterIndex(earlyLookup),
    sequence: 1,
    published_at: "2026-08-10T13:00:00.000Z",
    generation_id: "gen-early",
  });
  const interrupted = await publishMatterGeneration(env, {
    lookup: laterLookup,
    index: buildLegislativeMatterIndex(laterLookup),
    sequence: 2,
    published_at: "2026-08-10T14:00:00.000Z",
    generation_id: "gen-later",
    interruptBeforeManifest: true,
  });
  assert.equal(interrupted.promoted, false);
  assert.equal(interrupted.reason, "interrupted-before-manifest");
  assert.equal(interrupted.current.generation_id, "gen-early");

  const missing = await publishMatterGeneration(env, {
    lookup: laterLookup,
    index: buildLegislativeMatterIndex(laterLookup),
    sequence: 3,
    published_at: "2026-08-10T15:00:00.000Z",
    generation_id: "gen-missing",
    omitArtifact: "lookup.json",
  });
  assert.equal(missing.promoted, false);
  assert.equal(missing.current.generation_id, "gen-early");

  const published = await readPublishedMatterLookup(env, { staticLookup: committedLookup });
  assert.equal(published.generation.generation_id, "gen-early");
  const page = await edgeWorker.fetch(
    new Request(`https://cityscroll.org/matters/${MATTER_ID}/`),
    assetsEnv(committedLookup, env),
  );
  const html = await page.text();
  assert.match(html, /Laid Over by Subcommittee/);
  assert.doesNotMatch(html, /Approved by Subcommittee/);
  assert.match(html, /data-matter-generation="gen-early"/);

  const later = appearance(MATTER_ID, LATER_NOTICE, {
    published_generation_id: "gen-later",
    published_generation_sequence: 2,
    published_generation_at: "2026-08-10T14:00:00.000Z",
  });
  const early = appearance(MATTER_ID, EARLY_NOTICE);
  const [update] = reduceCouncilMatterWatchUpdates({
    matter_ref: MATTER_REF,
    observations: [early, later],
    baseline: { observation_ids: [early.observation_id], baseline_acquired_at: early.acquired_at },
  });
  const decision = decideUpdateRelease(update, published.generation);
  assert.equal(decision.hold, true);
  assert.equal(decision.reason, "destination-not-published");
});

test("A6: older static fallback never claims current coverage and page requests make zero publisher calls", async () => {
  const publisher = publisherTracker();
  const page = await edgeWorker.fetch(
    new Request(`https://cityscroll.org/matters/${MATTER_ID}/`),
    assetsEnv(committedLookup, { fetch: publisher.fetchImpl }),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /data-matter-coverage="older-static-fallback"/);
  assert.match(html, /data-matter-current-coverage="false"/);
  assert.match(html, /not the current retained generation/);
  assert.doesNotMatch(html, /data-matter-current-coverage="true"/);
  assert.equal(publisher.calls.length, 0);
  assert.equal(page.headers.get("X-Matter-Coverage"), MATTER_COVERAGE_STATE.OLDER_STATIC_FALLBACK);
});

test("A3: hearing, explicit choice, history, confirm, update, reopen, and removal keep one identity", async () => {
  const { env, sqlite, publisher } = makeEnv();
  const five = snapshot.by_notice[FIVE_MATTER_NOTICE];
  const fiveRecord = {
    source_system: "city_record",
    request_id: FIVE_MATTER_NOTICE,
    meeting_id: `city_record:${FIVE_MATTER_NOTICE}`,
    meeting_outcome: five,
  };
  const fiveProjection = projectCouncilHearingMatterContinuation(fiveRecord, five);
  assert.equal(fiveProjection.state, "multiple");
  assert.equal(fiveProjection.matters.length, 5);
  assert.match(councilMatterChoiceMarkup(fiveProjection.matters), /data-matter-follow-choice="5"/);

  const notice = snapshot.by_notice[HEARING_NOTICE];
  const record = {
    source_system: "city_record",
    request_id: HEARING_NOTICE,
    meeting_id: `city_record:${HEARING_NOTICE}`,
    meeting_outcome: notice,
  };
  const continuation = projectCouncilHearingMatterContinuation(record, notice);
  assert.equal(continuation.state, "multiple");
  assert.ok(continuation.matters.some((matter) => matter.matter_id === MATTER_ID));
  const hearingHtml = renderCouncilHearingMatterContinuation(record, notice)
    + councilMatterChoiceMarkup(continuation.matters);
  assert.match(hearingHtml, /meeting-matter-choice|matter-follow-choice/);
  assert.match(hearingHtml, /data-matter-id="78605"/);

  const chosen = exactCouncilMatterWatch({ lens: "meetings", matter_id: MATTER_ID });
  assert.equal(chosen.matter_ref, MATTER_REF);
  const laterLookup = lookupFromNotices([EARLY_NOTICE, LATER_NOTICE]);
  await publishMatterGeneration(env, {
    lookup: laterLookup,
    index: buildLegislativeMatterIndex(laterLookup),
    sequence: 1,
    published_at: "2026-08-10T14:00:00.000Z",
    generation_id: "gen-journey",
  });
  const history = await edgeWorker.fetch(
    new Request(`https://cityscroll.org/matters/${MATTER_ID}/`),
    assetsEnv(committedLookup, env),
  );
  const historyHtml = await history.text();
  assert.match(historyHtml, /data-matter-ref="legistar:nyc:matter:78605"/);
  assert.match(historyHtml, /Follow matter/);
  assert.match(historyHtml, /data-route-back=/);

  const early = appearance(MATTER_ID, EARLY_NOTICE, { generation_id: "gen-journey" });
  const later = appearance(MATTER_ID, LATER_NOTICE, {
    generation_id: "gen-journey",
    published_generation_id: "gen-journey",
    published_generation_sequence: 1,
  });
  insertJournal(sqlite, early);
  const sub = await watchRecord(["resident", "example.com"].join("@"), MATTER_ID);
  const confirmed = await confirmExactMatterWatch(env, sub, {
    observations: [early],
    requireReadiness: true,
    now: "2026-05-01T00:00:00.000Z",
  });
  assert.equal(confirmed.confirmation, "confirmed");
  assert.equal(confirmed.watch.matter_ref, MATTER_REF);
  assert.equal(confirmed.following, true);

  insertJournal(sqlite, later);
  const rows = await eligibleMatterWatchRows(env, sub, { observations: [early, later] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].matter_ref, MATTER_REF);
  assert.match(rows[0].short_title, /Approved by Subcommittee/);
  const identity = extractLensIdentity("meetings", rows[0]);
  await enqueueEvaluatedSection(env.DB, {
    lens: "meetings",
    kind: "council-matter",
    status: "success",
    watch_id: sub.watch_id,
    subscriber_id: sub.subscriber_id,
    freshRows: rows,
    now: "2026-08-10T16:00:00.000Z",
  });
  const owed = await listAllOwedItems(env.DB, sub.subscriber_id);
  assert.equal(owed.length, 1);
  assert.equal(identity.identityValue, owed[0].item_id);

  const reopened = await edgeWorker.fetch(
    new Request(`https://cityscroll.org/matters/${MATTER_ID}/`),
    assetsEnv(committedLookup, env),
  );
  const reopenedHtml = await reopened.text();
  assert.match(reopenedHtml, /data-matter-ref="legistar:nyc:matter:78605"/);
  assert.match(reopenedHtml, /Approved by Subcommittee/);
  const removed = await removeExactMatterWatch(env, sub);
  assert.equal(removed.removed, true);
  assert.equal(publisher.calls.length, 0);
  assert.equal(chosen.matter_ref, MATTER_REF);
});

test("A4: coverage states stay distinct and never mean no action occurred or successful following", () => {
  const unsupported = councilMatterWatchSummaryHtml({ lens: "meetings", matter_id: "not-a-matter" });
  assert.match(unsupported, /data-matter-coverage="unsupported-source"/);
  assert.doesNotMatch(unsupported, /successful following/i);
  assert.match(unsupported, /not a saved watch/);

  const failed = councilMatterWatchSummaryHtml(
    { lens: "meetings", matter_id: MATTER_ID },
    { confirmation: "failed" },
  );
  assert.match(failed, /data-matter-coverage="failed-confirmation"/);
  assert.match(failed, /not successful following/);

  const stale = coverageCopy(MATTER_COVERAGE_STATE.STALE_REFRESH);
  assert.match(stale, /last known history is still shown/i);
  assert.doesNotMatch(stale, /no action occurred/i);

  const incomplete = coverageCopy(MATTER_COVERAGE_STATE.INCOMPLETE_HISTORY);
  assert.match(incomplete, /incomplete/i);

  const none = coverageCopy(MATTER_COVERAGE_STATE.NO_LATER_ACTION_LOCATED);
  assert.match(none, /No later official action has been located/);
  assert.match(none, /not a finding that the matter is finished/);

  const view = buildLegislativeMatterDocument({
    ...committedLookup,
    coverage_state: MATTER_COVERAGE_STATE.STALE_REFRESH,
    generation_id: "gen-stale",
  }, MATTER_ID);
  const html = renderLegislativeMatterDocument(view);
  assert.match(html, /data-matter-coverage="stale-refresh"/);
  assert.match(html, /last known history is still shown/i);
  assert.match(html, /No later official step has been located/);
});

test("A5: approval language keeps the deciding body and stage and does not claim testimony or causation", () => {
  const view = buildLegislativeMatterDocument(committedLookup, MATTER_ID);
  const html = renderLegislativeMatterDocument(view);
  assert.match(html, /Approved by Subcommittee|Laid Over by Subcommittee/);
  assert.match(html, /subcommittee stage|Deciding body/i);
  assert.doesNotMatch(html, /you testified|agency replied|your testimony caused/i);
  assert.equal(view.approval.claims_testimony, false);
  assert.equal(view.approval.claims_agency_reply, false);
  assert.equal(view.approval.claims_resident_causation, false);
});

test("watch activation requires collector and delivery readiness", async () => {
  const { env } = makeEnv({ delivery: false });
  env[LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG] = "false";
  const sub = await watchRecord(["blocked", "example.com"].join("@"), MATTER_ID);
  const readiness = await matterWatchActivationReadiness(env);
  assert.equal(readiness.ready, false);
  const failed = await confirmExactMatterWatch(env, sub, { requireReadiness: true, observations: [] });
  assert.equal(failed.confirmation, "failed");
  assert.equal(failed.following, false);
  assert.match(councilMatterWatchSummaryHtml(sub, { confirmation: "failed" }), /not confirmed/);
});

test("A7: evidence manifest records routes, viewports, vintage, generation ids, and hashes without images", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../docs/evidence/retained-matter-publication-generation/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.schema, "cityscroll.retained_matter_publication_generation_evidence.v1");
  assert.equal(manifest.data_vintage, DATA_VINTAGE);
  assert.match(manifest.image_directory, /^\.artifacts\//);
  assert.ok(manifest.files.length >= 20);
  for (const file of manifest.files) {
    assert.ok(file.route);
    assert.equal(file.viewport.length, 2);
    assert.ok(file.sha256);
    assert.ok(file.assertion);
    assert.equal(file.data_vintage, DATA_VINTAGE);
    assert.ok(file.observations.render_hash);
    assert.ok(file.observations.fixture_vintage);
  }
  assert.ok(manifest.files.some((file) => file.viewport[0] === 390));
  assert.ok(manifest.files.some((file) => file.viewport[0] === 1440));
  assert.ok(manifest.files.some((file) => file.specimen === "keyboard-back"));
  assert.ok(manifest.files.some((file) => file.specimen === "native-link"));
  assert.ok(manifest.files.some((file) => file.specimen === "older-fallback"));
  assert.ok(manifest.files.some((file) => file.specimen === "failed-confirmation"));
});

test("follow markup preserves exact save controls", () => {
  const href = councilMatterFollowMarkup({ lens: "meetings", matter_id: MATTER_ID });
  assert.match(href, /data-matter-ref="legistar:nyc:matter:78605"/);
  assert.match(href, /Follow matter 78605|Follow Council matter 78605|Follow matter/);
});
