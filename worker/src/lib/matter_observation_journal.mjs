/**
 * Revision-aware matter observation journal.
 *
 * Compact meeting snapshots are replaced on refresh. This module keeps source
 * observations, event identities, revisions, and acquisition times independently
 * of that rolling view. Raw payloads live only in `source_records`. The tables
 * in migration 0027 are an indexed projection and repair receipts.
 *
 * Identity is publisher system + tenant + immutable matter id. Native event and
 * event-item identities are retained when the publisher supplies them. Compact
 * bootstrap appearances are labelled coarse and are never rewritten as native
 * history. Votes bind only to their own event item; missing binding stays
 * incomplete. A failed or empty replacement keeps last-good rows and records
 * one deduplicated repair observation.
 *
 * No function here reads a publisher. Callers pass already-retained snapshots
 * or already-fetched native bags.
 */

import {
  computeSourceRecordHash,
  SOURCE_RECORD_INSERT_SQL,
} from "./source_records.mjs";
import {
  formatSubjectRef,
  makeSubjectLink,
} from "./subject_registry.mjs";
import {
  LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM,
  LEGISTAR_EVENTS_SOURCE_SYSTEM,
  LEGISTAR_VOTES_SOURCE_SYSTEM,
  legistarEventItemSourceSystemId,
  legistarEventSourceSystemId,
  legistarVoteSourceSystemId,
} from "./legistar_source_records.mjs";

export const MATTER_JOURNAL_SCHEMA = "cityscroll.matter_observation_journal.v1";
export const MATTER_BOOTSTRAP_SOURCE_SYSTEM = "nyc_legistar_matter_bootstrap";
export const MATTER_SOURCE_SYSTEM = "legistar";
export const MATTER_IDENTITY_GRANULARITY = Object.freeze({
  coarse: "coarse",
  native: "native",
});
export const VOTE_BINDING_STATUS = Object.freeze({
  bound: "bound",
  incomplete: "incomplete",
  none: "none",
});
export const REPAIR_KIND = Object.freeze({
  emptyReplacement: "empty-replacement",
  partialReplacement: "partial-replacement",
  failedReplacement: "failed-replacement",
  transactionFailure: "transaction-failure",
});

const JOURNAL_INSERT_SQL = `INSERT OR IGNORE INTO matter_observation_journal (
  observation_id, source_system, tenant, matter_id, event_id,
  native_event_item_id, publisher_action_id, event_time, observed_at, acquired_at,
  identity_granularity, source_record_ref, raw_payload_hash, semantic_revision,
  notice_references_json, title, action_name, vote_binding_status, vote_event_item_id,
  provenance_json, public_hearing_key, superseded_by, created_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const SUPERSEDE_SQL = `UPDATE matter_observation_journal
   SET superseded_by = ?
 WHERE source_system = ? AND tenant = ? AND matter_id = ? AND event_id = ?
   AND identity_granularity = 'coarse' AND superseded_by IS NULL`;

const GENERATION_CLEAR_CURRENT_SQL = `UPDATE matter_observation_generation SET status = 'superseded' WHERE status = 'current'`;

const GENERATION_INSERT_SQL = `INSERT OR REPLACE INTO matter_observation_generation (
  generation_id, status, acquired_at, source_vintage, matter_count, appearance_count, receipt_json
) VALUES (?,?,?,?,?,?,?)`;

const REPAIR_SELECT_SQL = `SELECT repair_id, occurrence_count FROM matter_observation_repair WHERE signature = ?`;

const REPAIR_INSERT_SQL = `INSERT INTO matter_observation_repair (
  repair_id, signature, kind, observed_at, last_seen_at, occurrence_count, last_good_generation, detail_json
) VALUES (?,?,?,?,?,?,?,?)`;

const REPAIR_UPDATE_SQL = `UPDATE matter_observation_repair
   SET last_seen_at = ?, occurrence_count = ?, last_good_generation = ?, detail_json = ?
 WHERE signature = ?`;

function clean(value, max = 1000) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function exactId(value) {
  const id = clean(value, 80);
  return /^\d+$/.test(id) ? id : null;
}

function safeHttps(value) {
  try {
    const url = new URL(clean(value, 2000));
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function publisherTenantFromMatterUrl(matterUrl) {
  const href = safeHttps(matterUrl);
  if (!href) return null;
  const host = new URL(href).hostname.toLowerCase();
  const match = /^([a-z0-9-]+)\.legistar(?:\d+)?\.com$/.exec(host);
  return match ? match[1] : null;
}

export function canonicalMatterRef(tenant, matterId) {
  return `${MATTER_SOURCE_SYSTEM}:${tenant || "unresolved-tenant"}:matter:${matterId}`;
}

export function publicHearingKey(input = {}) {
  const sourceSystem = input.sourceSystem || input.source_system || MATTER_SOURCE_SYSTEM;
  const tenant = input.tenant || "unresolved-tenant";
  const matterId = input.matterId || input.matter_id;
  const eventId = input.eventId || input.event_id;
  return `${sourceSystem}:${tenant}:matter:${matterId}:event:${eventId}`;
}

function readFirst(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value === 0 || value === false) return value;
    if (value !== null && value !== undefined) {
      const text = String(value).trim();
      if (text !== "") return text;
    }
  }
  return null;
}

function sortedUnique(values) {
  return [...new Set(values.map((value) => clean(value, 80)).filter(Boolean))].sort();
}

function sourceRecordRef(sourceSystem, sourceSystemId, contentHash) {
  return `${sourceSystem}/${sourceSystemId}/${contentHash}`;
}

function noticeSubjectLinks(noticeIds, eventId) {
  const eventRef = eventId ? formatSubjectRef("legistar-event", eventId) : null;
  const links = [];
  for (const noticeId of noticeIds) {
    const noticeRef = formatSubjectRef("notice", noticeId);
    if (!noticeRef || !eventRef) continue;
    const link = makeSubjectLink({
      type: "about_notice",
      from: eventRef,
      to: noticeRef,
      evidence: {
        basis: "retained_matter_observation",
        source: "nyc-legistar",
        request_id: noticeId,
        event_id: eventId,
      },
    });
    if (link) links.push(link);
  }
  return links;
}

export async function semanticRevisionOf(fields) {
  return computeSourceRecordHash({
    action_name: fields.action_name || null,
    title: fields.title || null,
    outcome: fields.outcome || null,
    vote_binding_status: fields.vote_binding_status || VOTE_BINDING_STATUS.none,
    publisher_action_id: fields.publisher_action_id || null,
  });
}

export async function observationIdFor(fields) {
  return computeSourceRecordHash({
    source_system: fields.source_system,
    tenant: fields.tenant,
    matter_id: fields.matter_id,
    event_id: fields.event_id,
    native_event_item_id: fields.native_event_item_id || null,
    identity_granularity: fields.identity_granularity,
    raw_payload_hash: fields.raw_payload_hash,
  });
}

/**
 * Compact snapshot appearances, grouped by publisher tenant + matter + event.
 * Native event-item ids are not invented: the snapshot does not carry them.
 */
export function deriveCoarseAppearances(snapshot) {
  const byHearing = new Map();
  for (const [requestId, record] of Object.entries(snapshot?.by_notice || {})) {
    if (!record || record.snapshot_state === "absent") continue;
    const eventId = exactId(record.event?.event_id);
    if (!eventId) continue;
    for (const matter of Array.isArray(record.matters) ? record.matters : []) {
      const matterId = exactId(matter.matter_id);
      if (!matterId) continue;
      const tenant = publisherTenantFromMatterUrl(matter.matter_url);
      const hearingKey = publicHearingKey({
        sourceSystem: MATTER_SOURCE_SYSTEM,
        tenant,
        matterId,
        eventId,
      });
      if (!byHearing.has(hearingKey)) {
        byHearing.set(hearingKey, {
          source_system: MATTER_SOURCE_SYSTEM,
          tenant,
          matter_id: matterId,
          event_id: eventId,
          event_time: clean(record.event?.date, 40) || null,
          event_name: clean(record.event?.name, 240) || null,
          event_url: safeHttps(record.event?.url),
          matter_url: safeHttps(matter.matter_url),
          matter_file: clean(matter.matter_file, 80) || null,
          titles: [],
          actions: [],
          outcomes: [],
          notice_ids: [],
          votes: [],
          source_vintage: snapshot.generated_at || null,
        });
      }
      const entry = byHearing.get(hearingKey);
      if (matter.title) entry.titles.push(clean(matter.title, 500));
      for (const action of Array.isArray(matter.actions) ? matter.actions : []) {
        if (action) entry.actions.push(clean(action, 240));
      }
      if (matter.outcome) entry.outcomes.push(clean(matter.outcome, 240));
      entry.notice_ids.push(clean(requestId, 80));
      if (matter.votes != null) entry.votes.push(matter.votes);
    }
  }

  return [...byHearing.values()].map((entry) => {
    const notice_ids = sortedUnique(entry.notice_ids);
    const title = entry.titles.at(-1) || null;
    const action_name = entry.outcomes.at(-1) || entry.actions.at(-1) || null;
    const hasUnboundVotes = entry.votes.some((vote) => vote != null && vote !== "");
    return {
      ...entry,
      notice_ids,
      title,
      action_name,
      identity_granularity: MATTER_IDENTITY_GRANULARITY.coarse,
      native_event_item_id: null,
      publisher_action_id: null,
      vote_binding_status: hasUnboundVotes ? VOTE_BINDING_STATUS.incomplete : VOTE_BINDING_STATUS.none,
      vote_event_item_id: null,
      canonical_ref: canonicalMatterRef(entry.tenant, entry.matter_id),
      public_hearing_key: publicHearingKey(entry),
    };
  });
}

export function classifySnapshotIntake(snapshot) {
  if (snapshot == null) return "empty";
  if (snapshot.failed === true || snapshot.status === "failed") return "failed";
  if (snapshot.partial === true || snapshot.status === "partial") return "partial";
  const notices = snapshot.by_notice && typeof snapshot.by_notice === "object" ? snapshot.by_notice : null;
  if (!notices) return "empty";
  const present = Object.values(notices).filter((row) => row && row.snapshot_state !== "absent");
  if (present.length === 0) return "empty";
  if (Number.isFinite(Number(snapshot.present_count)) && Number(snapshot.present_count) > present.length) {
    return "partial";
  }
  return "complete";
}

function journalHasSchemaError(error) {
  const message = String(error?.message || error || "");
  return /no such table|matter_observation_/i.test(message);
}

async function bindInsert(env, sql, values) {
  return env.DB.prepare(sql).bind(...values);
}

async function readFirstRow(env, sql, values = []) {
  try {
    const statement = env.DB.prepare(sql);
    if (typeof statement.bind === "function" && values.length) {
      return statement.bind(...values).first();
    }
    return statement.first();
  } catch (error) {
    if (journalHasSchemaError(error)) return null;
    throw error;
  }
}

async function readAllRows(env, sql, values = []) {
  try {
    const statement = env.DB.prepare(sql);
    const bound = typeof statement.bind === "function" && values.length
      ? statement.bind(...values)
      : statement;
    const result = await bound.all();
    return result?.results || result || [];
  } catch (error) {
    if (journalHasSchemaError(error)) return [];
    throw error;
  }
}

export async function readCurrentGeneration(env) {
  const row = await readFirstRow(
    env,
    `SELECT * FROM matter_observation_generation WHERE status = 'current' ORDER BY acquired_at DESC LIMIT 1`,
  );
  return row || null;
}

export async function readJournalRows(env) {
  return readAllRows(
    env,
    `SELECT * FROM matter_observation_journal ORDER BY source_system, tenant, matter_id, event_id, created_at`,
  );
}

export async function readRepairRows(env) {
  return readAllRows(
    env,
    `SELECT * FROM matter_observation_repair ORDER BY signature`,
  );
}

export function summarizeRows(rows) {
  const matters = new Set();
  const hearings = new Set();
  const activeHearings = new Set();
  const observations = Array.isArray(rows) ? rows : [];
  for (const row of observations) {
    matters.add(canonicalMatterRef(row.tenant, row.matter_id));
    hearings.add(row.public_hearing_key);
    if (!row.superseded_by) activeHearings.add(row.public_hearing_key);
  }
  return {
    observation_count: observations.length,
    matter_count: matters.size,
    appearance_count: hearings.size,
    active_appearance_count: activeHearings.size,
    observation_ids: observations.map((row) => row.observation_id).sort(),
  };
}

async function buildJournalRow(payload, extra) {
  const raw_payload_hash = await computeSourceRecordHash(payload);
  const source_system = extra.source_system;
  const source_system_id = extra.source_system_id;
  const identity_granularity = extra.identity_granularity;
  const vote_binding_status = extra.vote_binding_status;
  const semantic_revision = await semanticRevisionOf({
    action_name: extra.action_name,
    title: extra.title,
    outcome: extra.outcome,
    vote_binding_status,
    publisher_action_id: extra.publisher_action_id,
  });
  const observation_id = await observationIdFor({
    source_system: extra.canonical_source_system,
    tenant: extra.tenant,
    matter_id: extra.matter_id,
    event_id: extra.event_id,
    native_event_item_id: extra.native_event_item_id,
    identity_granularity,
    raw_payload_hash,
  });
  const acquired_at = extra.acquired_at;
  const notice_ids = extra.notice_ids || [];
  const provenance = {
    identity_granularity,
    canonical_ref: canonicalMatterRef(extra.tenant, extra.matter_id),
    subject_links: noticeSubjectLinks(notice_ids, extra.event_id),
    source_urls: extra.source_urls || [],
    source_vintage: extra.source_vintage || null,
    bootstrap: identity_granularity === MATTER_IDENTITY_GRANULARITY.coarse,
  };
  return {
    observation_id,
    source_record: {
      source_system,
      source_system_id,
      raw_payload_hash,
      payload,
    },
    values: [
      observation_id,
      extra.canonical_source_system,
      extra.tenant || "unresolved-tenant",
      extra.matter_id,
      extra.event_id,
      extra.native_event_item_id,
      extra.publisher_action_id,
      extra.event_time,
      extra.observed_at,
      acquired_at,
      identity_granularity,
      sourceRecordRef(source_system, source_system_id, raw_payload_hash),
      raw_payload_hash,
      semantic_revision,
      JSON.stringify(notice_ids),
      extra.title,
      extra.action_name,
      vote_binding_status,
      extra.vote_event_item_id,
      JSON.stringify(provenance),
      extra.public_hearing_key,
      null,
      acquired_at,
    ],
    public_hearing_key: extra.public_hearing_key,
    upgrade: extra.upgrade || null,
  };
}

async function coarseRowsFromSnapshot(snapshot, acquiredAt) {
  const appearances = deriveCoarseAppearances(snapshot);
  const rows = [];
  for (const appearance of appearances) {
    const source_system_id = `appearance:event:${appearance.event_id}:matter:${appearance.matter_id}`;
    const payload = {
      source: "meeting_outcomes_snapshot",
      schema: snapshot.schema || null,
      generated_at: snapshot.generated_at || null,
      tenant: appearance.tenant,
      matter_id: appearance.matter_id,
      event_id: appearance.event_id,
      event_time: appearance.event_time,
      event_name: appearance.event_name,
      event_url: appearance.event_url,
      matter_url: appearance.matter_url,
      matter_file: appearance.matter_file,
      title: appearance.title,
      action_name: appearance.action_name,
      notice_ids: appearance.notice_ids,
      identity_granularity: MATTER_IDENTITY_GRANULARITY.coarse,
    };
    rows.push(await buildJournalRow(payload, {
      source_system: MATTER_BOOTSTRAP_SOURCE_SYSTEM,
      source_system_id,
      canonical_source_system: appearance.source_system,
      tenant: appearance.tenant,
      matter_id: appearance.matter_id,
      event_id: appearance.event_id,
      native_event_item_id: null,
      publisher_action_id: null,
      event_time: appearance.event_time,
      observed_at: snapshot.generated_at || acquiredAt,
      acquired_at: acquiredAt,
      identity_granularity: MATTER_IDENTITY_GRANULARITY.coarse,
      action_name: appearance.action_name,
      title: appearance.title,
      outcome: appearance.action_name,
      vote_binding_status: appearance.vote_binding_status,
      vote_event_item_id: null,
      notice_ids: appearance.notice_ids,
      source_urls: [appearance.matter_url, appearance.event_url].filter(Boolean),
      source_vintage: snapshot.generated_at || null,
      public_hearing_key: appearance.public_hearing_key,
    }));
  }
  return rows;
}

function voteItemId(vote) {
  return exactId(readFirst(vote, [
    "VoteEventItemId",
    "EventItemId",
    "EventItemID",
    "agenda_item_id",
    "itemId",
  ]));
}

async function nativeRowsFromBags(bags, acquiredAt) {
  const events = Array.isArray(bags?.events) ? bags.events : [];
  const items = Array.isArray(bags?.eventItems) ? bags.eventItems : [];
  const votes = Array.isArray(bags?.votes) ? bags.votes : [];
  const eventById = new Map();
  for (const event of events) {
    const eventId = exactId(readFirst(event, ["EventId", "eventId", "Event_ID", "id"]));
    if (eventId) eventById.set(eventId, event);
  }
  const votesByItem = new Map();
  const unboundVotes = [];
  for (const vote of votes) {
    const itemId = voteItemId(vote);
    if (!itemId) {
      unboundVotes.push(vote);
      continue;
    }
    if (!votesByItem.has(itemId)) votesByItem.set(itemId, []);
    votesByItem.get(itemId).push(vote);
  }

  const rows = [];
  const unresolved = [];
  for (const item of items) {
    const itemId = exactId(readFirst(item, ["EventItemId", "EventItemID", "AgendaItemId", "id"]));
    const matterId = exactId(readFirst(item, ["EventItemMatterId", "MatterId", "MatterID", "Matter_ID"]));
    const eventId = exactId(readFirst(item, [
      "EventItemEventId",
      "EventId",
      "eventId",
      "EventID",
    ]));
    if (!itemId || !matterId || !eventId) {
      unresolved.push({
        reason: "missing-native-identity",
        event_item_id: itemId,
        matter_id: matterId,
        event_id: eventId,
      });
      continue;
    }
    const event = eventById.get(eventId) || {};
    const matterUrl = readFirst(item, ["EventItemMatterUrl", "MatterUrl"])
      || `https://nyc.legistar.com/Gateway.aspx?M=L&ID=${matterId}`;
    const tenant = publisherTenantFromMatterUrl(matterUrl);
    const actionName = clean(readFirst(item, ["EventItemActionName", "ActionName", "Action"]), 240) || null;
    const title = clean(readFirst(item, ["EventItemMatterName", "EventItemTitle", "Title"]), 500) || null;
    const publisherActionId = exactId(readFirst(item, ["EventItemActionId", "ActionId"])) || null;
    const boundVotes = votesByItem.get(itemId) || [];
    const vote_binding_status = boundVotes.length
      ? VOTE_BINDING_STATUS.bound
      : VOTE_BINDING_STATUS.none;
    const payload = {
      source: "native_event_item",
      event,
      event_item: item,
      votes: boundVotes,
    };
    const source_system_id = legistarEventItemSourceSystemId(item);
    rows.push(await buildJournalRow(payload, {
      source_system: LEGISTAR_EVENT_ITEMS_SOURCE_SYSTEM,
      source_system_id,
      canonical_source_system: MATTER_SOURCE_SYSTEM,
      tenant,
      matter_id: matterId,
      event_id: eventId,
      native_event_item_id: itemId,
      publisher_action_id: publisherActionId,
      event_time: clean(readFirst(event, ["EventDate", "StartDate", "Date"]), 40) || null,
      observed_at: acquiredAt,
      acquired_at: acquiredAt,
      identity_granularity: MATTER_IDENTITY_GRANULARITY.native,
      action_name: actionName,
      title,
      outcome: actionName,
      vote_binding_status,
      vote_event_item_id: itemId,
      notice_ids: [],
      source_urls: [safeHttps(matterUrl)].filter(Boolean),
      source_vintage: acquiredAt,
      public_hearing_key: publicHearingKey({
        sourceSystem: MATTER_SOURCE_SYSTEM,
        tenant,
        matterId,
        eventId,
      }),
      upgrade: { tenant, matterId, eventId },
    }));

    for (const vote of boundVotes) {
      const votePayload = { ...vote, EventItemId: itemId };
      const voteHash = await computeSourceRecordHash(votePayload);
      rows.push({
        kind: "source-only",
        source_record: {
          source_system: LEGISTAR_VOTES_SOURCE_SYSTEM,
          source_system_id: legistarVoteSourceSystemId(votePayload),
          raw_payload_hash: voteHash,
          payload: votePayload,
        },
      });
    }

    if (eventById.has(eventId)) {
      const eventPayload = eventById.get(eventId);
      const eventHash = await computeSourceRecordHash(eventPayload);
      rows.push({
        kind: "source-only",
        source_record: {
          source_system: LEGISTAR_EVENTS_SOURCE_SYSTEM,
          source_system_id: legistarEventSourceSystemId(eventPayload),
          raw_payload_hash: eventHash,
          payload: eventPayload,
        },
      });
    }
  }

  for (const vote of unboundVotes) {
    unresolved.push({
      reason: "vote-missing-event-item",
      vote_person_id: readFirst(vote, ["VotePersonId", "PersonId", "PersonID"]) || null,
    });
  }

  return { rows, unresolved };
}

async function statementsForRows(env, prepared, acquiredAt, snapshotVintage) {
  const statements = [];
  const upgrades = [];
  const observationIds = [];
  for (const row of prepared) {
    if (row.source_record) {
      statements.push(await bindInsert(env, SOURCE_RECORD_INSERT_SQL, [
        row.source_record.source_system,
        row.source_record.source_system_id,
        row.source_record.raw_payload_hash,
        JSON.stringify(row.source_record.payload),
        JSON.stringify(row.source_record.payload),
        acquiredAt,
      ]));
    }
    if (row.values) {
      statements.push(await bindInsert(env, JOURNAL_INSERT_SQL, row.values));
      observationIds.push(row.observation_id);
      if (row.upgrade) upgrades.push({ ...row.upgrade, observation_id: row.observation_id });
    }
  }
  for (const upgrade of upgrades) {
    statements.push(await bindInsert(env, SUPERSEDE_SQL, [
      upgrade.observation_id,
      MATTER_SOURCE_SYSTEM,
      upgrade.tenant || "unresolved-tenant",
      upgrade.matterId,
      upgrade.eventId,
    ]));
  }
  return { statements, observationIds, snapshotVintage };
}

async function commitGeneration(env, statements, receipt, acquiredAt) {
  const generationId = await computeSourceRecordHash({
    acquired_at: acquiredAt,
    observation_ids: receipt.observation_ids,
    source_vintage: receipt.source_vintage,
  });
  statements.push(await bindInsert(env, GENERATION_CLEAR_CURRENT_SQL, []));
  statements.push(await bindInsert(env, GENERATION_INSERT_SQL, [
    generationId,
    "current",
    acquiredAt,
    receipt.source_vintage || null,
    receipt.matter_count,
    receipt.appearance_count,
    JSON.stringify({ schema: MATTER_JOURNAL_SCHEMA, ...receipt }),
  ]));
  await env.DB.batch(statements);
  return generationId;
}

async function recordRepair(env, { kind, detail, acquiredAt }) {
  const lastGood = await readCurrentGeneration(env);
  const signature = `matter-journal:${kind}`;
  const repairId = await computeSourceRecordHash({ signature });
  const existing = await readFirstRow(env, REPAIR_SELECT_SQL, [signature]);
  const detailJson = JSON.stringify(detail || {});
  const lastGoodId = lastGood?.generation_id || null;
  if (existing?.repair_id) {
    await env.DB.batch([
      await bindInsert(env, REPAIR_UPDATE_SQL, [
        acquiredAt,
        Number(existing.occurrence_count || 0) + 1,
        lastGoodId,
        detailJson,
        signature,
      ]),
    ]);
    return { repair_id: existing.repair_id, signature, kind, deduplicated: true };
  }
  await env.DB.batch([
    await bindInsert(env, REPAIR_INSERT_SQL, [
      repairId,
      signature,
      kind,
      acquiredAt,
      acquiredAt,
      1,
      lastGoodId,
      detailJson,
    ]),
  ]);
  return { repair_id: repairId, signature, kind, deduplicated: false };
}

function skippedResult(reason) {
  return {
    schema: MATTER_JOURNAL_SCHEMA,
    written: 0,
    skipped: reason,
    failed: false,
    repair: null,
  };
}

async function applyPrepared(env, prepared, {
  acquiredAt,
  sourceVintage,
  unresolved = [],
}) {
  const journalPrepared = prepared.filter((row) => row.values);
  const existing = await readJournalRows(env);
  const before = summarizeRows(existing);
  const { statements } = await statementsForRows(env, prepared, acquiredAt, sourceVintage);
  const combined = [
    ...existing,
    ...journalPrepared.map((row) => ({
      tenant: row.values[2],
      matter_id: row.values[3],
      public_hearing_key: row.public_hearing_key,
      observation_id: row.observation_id,
      superseded_by: null,
    })),
  ];
  const preview = summarizeRows(combined);
  const generationId = await commitGeneration(env, statements, {
    observation_ids: [...new Set([
      ...before.observation_ids,
      ...journalPrepared.map((row) => row.observation_id),
    ])].sort(),
    source_vintage: sourceVintage,
    matter_count: preview.matter_count,
    appearance_count: preview.appearance_count,
    unresolved,
  }, acquiredAt);
  const after = summarizeRows(await readJournalRows(env));
  return {
    schema: MATTER_JOURNAL_SCHEMA,
    written: journalPrepared.length,
    skipped: null,
    failed: false,
    generation_id: generationId,
    unresolved,
    before,
    after,
    repair: null,
  };
}

/**
 * Retain compact snapshot observations. Empty, partial, or failed intakes
 * leave existing rows in place and emit one repair observation.
 */
export async function retainSnapshotMatterObservations(env, snapshot, options = {}) {
  if (!env?.DB) return skippedResult("no-db");
  const acquiredAt = options.acquiredAt || new Date().toISOString();
  const classification = options.classification || classifySnapshotIntake(snapshot);
  if (classification !== "complete") {
    const kind = classification === "partial"
      ? REPAIR_KIND.partialReplacement
      : classification === "failed"
        ? REPAIR_KIND.failedReplacement
        : REPAIR_KIND.emptyReplacement;
    const lastGood = await readCurrentGeneration(env);
    const after = summarizeRows(await readJournalRows(env));
    const repair = await recordRepair(env, {
      kind,
      acquiredAt,
      detail: { classification, last_good_generation: lastGood?.generation_id || null },
    });
    return {
      schema: MATTER_JOURNAL_SCHEMA,
      written: 0,
      skipped: classification,
      failed: classification === "failed",
      last_good_retained: true,
      after,
      repair,
    };
  }

  try {
    const prepared = await coarseRowsFromSnapshot(snapshot, acquiredAt);
    return await applyPrepared(env, prepared, {
      acquiredAt,
      sourceVintage: snapshot.generated_at || acquiredAt,
    });
  } catch (error) {
    if (journalHasSchemaError(error)) return skippedResult("no-schema");
    const after = summarizeRows(await readJournalRows(env));
    const repair = await recordRepair(env, {
      kind: REPAIR_KIND.transactionFailure,
      acquiredAt,
      detail: { message: String(error?.message || error) },
    });
    return {
      schema: MATTER_JOURNAL_SCHEMA,
      written: 0,
      skipped: null,
      failed: true,
      last_good_retained: true,
      after,
      repair,
    };
  }
}

/**
 * Retain native event-item observations. Matching coarse bootstrap hearings
 * are superseded, not duplicated. Missing native identities are reported,
 * never manufactured.
 */
export async function retainNativeMatterObservations(env, bags, options = {}) {
  if (!env?.DB) return skippedResult("no-db");
  const acquiredAt = options.acquiredAt || new Date().toISOString();
  try {
    const { rows, unresolved } = await nativeRowsFromBags(bags, acquiredAt);
    if (!rows.length && !unresolved.length) return skippedResult("empty");
    return await applyPrepared(env, rows, {
      acquiredAt,
      sourceVintage: acquiredAt,
      unresolved,
    });
  } catch (error) {
    if (journalHasSchemaError(error)) return skippedResult("no-schema");
    const after = summarizeRows(await readJournalRows(env));
    const repair = await recordRepair(env, {
      kind: REPAIR_KIND.transactionFailure,
      acquiredAt,
      detail: { message: String(error?.message || error) },
    });
    return {
      schema: MATTER_JOURNAL_SCHEMA,
      written: 0,
      skipped: null,
      failed: true,
      last_good_retained: true,
      after,
      repair,
    };
  }
}

export async function projectMatterJournal(env) {
  const rows = await readJournalRows(env);
  const repairs = await readRepairRows(env);
  const generation = await readCurrentGeneration(env);
  const summary = summarizeRows(rows);
  const byMatter = new Map();
  for (const row of rows) {
    const key = canonicalMatterRef(row.tenant, row.matter_id);
    if (!byMatter.has(key)) {
      byMatter.set(key, {
        canonical_ref: key,
        source_system: row.source_system,
        tenant: row.tenant,
        matter_id: row.matter_id,
        appearances: [],
      });
    }
    const provenance = JSON.parse(row.provenance_json || "{}");
    byMatter.get(key).appearances.push({
      observation_id: row.observation_id,
      event_id: row.event_id,
      native_event_item_id: row.native_event_item_id,
      publisher_action_id: row.publisher_action_id,
      event_time: row.event_time,
      observed_at: row.observed_at,
      acquired_at: row.acquired_at,
      identity_granularity: row.identity_granularity,
      source_record_ref: row.source_record_ref,
      raw_payload_hash: row.raw_payload_hash,
      semantic_revision: row.semantic_revision,
      notice_references: JSON.parse(row.notice_references_json || "[]"),
      title: row.title,
      action_name: row.action_name,
      vote_binding_status: row.vote_binding_status,
      vote_event_item_id: row.vote_event_item_id,
      public_hearing_key: row.public_hearing_key,
      superseded_by: row.superseded_by,
      provenance,
    });
  }
  return {
    schema: MATTER_JOURNAL_SCHEMA,
    generation,
    summary,
    matters: [...byMatter.values()].sort((a, b) => a.matter_id.localeCompare(b.matter_id)),
    repairs: repairs.map((row) => ({
      ...row,
      detail: JSON.parse(row.detail_json || "{}"),
    })),
  };
}
