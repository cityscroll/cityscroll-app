/**
 * Bounded exact-matter collector.
 *
 * Refreshes active watches and explicitly retained Council matters on the
 * existing daily Worker schedule. It does not use City Record notices or the
 * 180-day event lookback as a retention TTL. Newly observed rows go through
 * the matter observation journal and source_records; this module stores only
 * roster, cursor, retry, and operator receipts.
 *
 * Publisher requests happen only from this scheduled path after deployed
 * retention configuration is verified. Resident reads must not call it.
 */

import {
  fetchLegistarEventById,
  fetchLegistarEventItems,
  fetchLegistarEventItemsByMatterPage,
  fetchLegistarItemVoteRows,
  fetchLegistarMatterHistoriesPage,
  MATTER_EVENT_ITEMS_PAGE_SIZE,
} from "./legistar_client.mjs";
import {
  dualWriteLegistarObservations,
  LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG,
} from "./legistar_source_records.mjs";
import { sourceRecordDualWriteEnabled } from "./source_records.mjs";
import {
  canonicalMatterRef,
  MATTER_SOURCE_SYSTEM,
  retainNativeMatterObservations,
} from "./matter_observation_journal.mjs";
import {
  defaultMatterHistoriesSourceGate,
  evaluateMatterHistoriesSourceGate,
  MATTER_EVENT_ITEMS_ADAPTER,
  MATTER_HISTORIES_ADAPTER,
} from "./matter_histories_source_gate.mjs";

export const MATTER_REFRESH_SCHEMA = "cityscroll.matter_exact_refresh.v1";
export const MATTER_REFRESH_LOCK_ID = "exact-matter-refresh";
export const ROSTER_KIND = Object.freeze({
  explicitRetained: "explicit-retained",
  activeWatch: "active-watch",
});
export const ACQUISITION_STATUS = Object.freeze({
  never: "never",
  complete: "complete",
  partial: "partial",
  failed: "failed",
  deferred: "deferred",
});

export const DEFAULT_MAX_MATTERS_PER_RUN = 8;
export const DEFAULT_MAX_REQUESTS_PER_RUN = 40;
export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_CADENCE_MS = 24 * 60 * 60 * 1000;

const RUN_OWNERS = new WeakMap();

function iso(now) {
  return new Date(now).toISOString();
}

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function readBudgets(env, options = {}) {
  return {
    maxMatters: boundedInt(
      options.maxMatters ?? env?.MATTER_REFRESH_MAX_MATTERS_PER_RUN,
      DEFAULT_MAX_MATTERS_PER_RUN,
      1,
      50,
    ),
    maxRequests: boundedInt(
      options.maxRequests ?? env?.MATTER_REFRESH_MAX_REQUESTS_PER_RUN,
      DEFAULT_MAX_REQUESTS_PER_RUN,
      1,
      400,
    ),
    pageSize: boundedInt(
      options.pageSize ?? env?.MATTER_REFRESH_PAGE_SIZE,
      MATTER_EVENT_ITEMS_PAGE_SIZE,
      1,
      200,
    ),
    concurrency: boundedInt(
      options.concurrency ?? env?.MATTER_REFRESH_CONCURRENCY,
      DEFAULT_CONCURRENCY,
      1,
      4,
    ),
    cadenceMs: boundedInt(
      options.cadenceMs ?? env?.MATTER_REFRESH_CADENCE_MS,
      DEFAULT_CADENCE_MS,
      60_000,
      14 * DEFAULT_CADENCE_MS,
    ),
    timeoutMs: boundedInt(options.timeoutMs ?? env?.MATTER_REFRESH_TIMEOUT_MS, 15_000, 20, 30_000),
  };
}

function emptyReceipt(overrides = {}) {
  return {
    schema: MATTER_REFRESH_SCHEMA,
    status: "deferred",
    attempted: 0,
    retained: 0,
    deferred: 0,
    failed: 0,
    request_count: 0,
    current: false,
    ...overrides,
  };
}

export async function verifyRetentionConfiguration(env) {
  if (!sourceRecordDualWriteEnabled(env, LEGISTAR_SOURCE_RECORD_DUAL_WRITE_FLAG)) {
    return { ok: false, reason: "source-record-write-disabled" };
  }
  if (!env?.DB) return { ok: false, reason: "no-db" };
  try {
    await env.DB.prepare("SELECT 1 AS ok FROM matter_observation_journal LIMIT 1").first();
    await env.DB.prepare("SELECT 1 AS ok FROM source_records LIMIT 1").first();
    await env.DB.prepare("SELECT 1 AS ok FROM matter_refresh_roster LIMIT 1").first();
  } catch (error) {
    return { ok: false, reason: "schema-missing", message: String(error?.message || error) };
  }
  return { ok: true, reason: null };
}

export async function upsertRosterEntry(env, input = {}) {
  const tenant = String(input.tenant || "nyc");
  const matterId = String(input.matterId || input.matter_id || "");
  const kind = input.kind || ROSTER_KIND.explicitRetained;
  const active = input.active === false ? 0 : 1;
  const createdAt = input.createdAt || iso(input.now || new Date());
  const matterKey = canonicalMatterRef(tenant, matterId);
  await env.DB.prepare(
    `INSERT INTO matter_refresh_roster
       (matter_key, source_system, tenant, matter_id, kind, active, created_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(matter_key) DO UPDATE SET
       kind = excluded.kind,
       active = excluded.active`,
  ).bind(matterKey, MATTER_SOURCE_SYSTEM, tenant, matterId, kind, active, createdAt).run();
  await env.DB.prepare(
    `INSERT INTO matter_refresh_state
       (matter_key, acquisition_status, visit_seq, failure_count)
     VALUES (?,?,0,0)
     ON CONFLICT(matter_key) DO NOTHING`,
  ).bind(matterKey, ACQUISITION_STATUS.never).run();
  return matterKey;
}

export async function readRefreshState(env, matterKey) {
  return env.DB.prepare("SELECT * FROM matter_refresh_state WHERE matter_key = ?").bind(matterKey).first();
}

export async function readLatestRefreshRun(env) {
  return env.DB.prepare(
    "SELECT * FROM matter_refresh_run ORDER BY started_at DESC, run_id DESC LIMIT 1",
  ).first();
}

export async function listEligibleMatters(env, nowIso, limit) {
  const result = await env.DB.prepare(
    `SELECT r.matter_key, r.source_system, r.tenant, r.matter_id, r.kind,
            s.last_attempt_at, s.last_complete_refresh_at, s.acquisition_status,
            s.cursor_json, s.retry_after, s.due_at, s.visit_seq, s.failure_count,
            s.last_error, s.in_flight_run_id
       FROM matter_refresh_roster r
       LEFT JOIN matter_refresh_state s ON s.matter_key = r.matter_key
      WHERE r.active = 1
        AND (s.retry_after IS NULL OR s.retry_after <= ?)
        AND (s.due_at IS NULL OR s.due_at <= ?)
      ORDER BY COALESCE(s.visit_seq, 0) ASC,
               COALESCE(s.last_attempt_at, '') ASC,
               r.matter_id ASC
      LIMIT ?`,
  ).bind(nowIso, nowIso, limit).all();
  return result?.results || [];
}

async function writeState(env, matterKey, fields) {
  const current = await readRefreshState(env, matterKey) || {
    matter_key: matterKey,
    acquisition_status: ACQUISITION_STATUS.never,
    visit_seq: 0,
    failure_count: 0,
  };
  const next = { ...current, ...fields, matter_key: matterKey };
  await env.DB.prepare(
    `INSERT OR REPLACE INTO matter_refresh_state (
       matter_key, last_attempt_at, last_complete_refresh_at, acquisition_status,
       cursor_json, retry_after, due_at, visit_seq, failure_count, last_error, in_flight_run_id
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    matterKey,
    next.last_attempt_at || null,
    next.last_complete_refresh_at || null,
    next.acquisition_status,
    next.cursor_json || null,
    next.retry_after || null,
    next.due_at || null,
    Number(next.visit_seq || 0),
    Number(next.failure_count || 0),
    next.last_error || null,
    next.in_flight_run_id || null,
  ).run();
}

async function persistRun(env, receipt) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO matter_refresh_run (
       run_id, started_at, finished_at, status, attempted, retained, deferred, failed, request_count, receipt_json
     ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    receipt.run_id,
    receipt.started_at,
    receipt.finished_at,
    receipt.status,
    receipt.attempted,
    receipt.retained,
    receipt.deferred,
    receipt.failed,
    receipt.request_count,
    JSON.stringify(receipt),
  ).run();
}

function parseCursor(raw) {
  if (!raw) return { skip: 0 };
  try {
    const parsed = JSON.parse(raw);
    return { skip: Number(parsed.skip || 0), adapter: parsed.adapter || null };
  } catch {
    return { skip: 0 };
  }
}

function eventIdOf(row) {
  const value = row?.MatterHistoryEventId ?? row?.EventItemEventId ?? row?.EventId;
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

function itemIdOf(row) {
  const value = row?.EventItemId ?? row?.EventItemID;
  const id = String(value ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

async function publisherGet(budget, factory) {
  if (budget.remaining <= 0) {
    return { ok: false, kind: "budget", status: 0, rows: [], retryAfter: null, complete: false };
  }
  budget.remaining -= 1;
  budget.used += 1;
  return factory();
}

async function hydrateVotes(eventItems, { token, fetchImpl, budget, now }) {
  const votes = [];
  for (const item of eventItems) {
    if (!item?.EventItemRollCallFlag && !item?.EventItemPassedFlagName) continue;
    const itemId = itemIdOf(item);
    if (!itemId) continue;
    const page = await publisherGet(budget, () => fetchLegistarItemVoteRows({
      itemId,
      token,
      fetchImpl,
    }).then((rows) => ({ ok: true, kind: "ok", rows: Array.isArray(rows) ? rows : [], complete: true }))
      .catch((error) => ({ ok: false, kind: "network", rows: [], message: String(error?.message || error) })));
    if (!page.ok) {
      if (page.kind === "budget") return { votes, budgetExhausted: true };
      continue;
    }
    for (const row of page.rows) {
      votes.push({ ...row, EventItemId: itemId, EventItemMatterId: item.EventItemMatterId });
    }
  }
  return { votes, budgetExhausted: false };
}

async function hydrateEvents(eventIds, cache, { token, fetchImpl, budget, now, timeoutMs }) {
  const events = [];
  for (const eventId of eventIds) {
    if (cache.has(eventId)) {
      events.push(cache.get(eventId));
      continue;
    }
    const page = await publisherGet(budget, () => fetchLegistarEventById({
      eventId,
      token,
      fetchImpl,
      timeoutMs,
      now,
    }));
    if (!page.ok) {
      if (page.kind === "budget") return { events, budgetExhausted: true, failure: page };
      return { events, budgetExhausted: false, failure: page };
    }
    const row = page.rows[0] || { EventId: Number(eventId) };
    cache.set(eventId, row);
    events.push(row);
  }
  return { events, budgetExhausted: false, failure: null };
}

async function eventItemsForHistories(histories, matterId, { token, fetchImpl, budget }) {
  const eventIds = [...new Set(histories.map(eventIdOf).filter(Boolean))];
  const items = [];
  for (const eventId of eventIds) {
    const page = await publisherGet(budget, () => fetchLegistarEventItems({
      eventId,
      token,
      fetchImpl,
    }).then((rows) => ({ ok: true, kind: "ok", rows: Array.isArray(rows) ? rows : [] }))
      .catch((error) => ({ ok: false, kind: "network", rows: [], message: String(error?.message || error) })));
    if (!page.ok) return { items, failure: page };
    items.push(...page.rows.filter((row) => String(row?.EventItemMatterId) === String(matterId)));
  }
  return { items, failure: null };
}

async function refreshOneMatter(env, matter, context) {
  const {
    token, fetchImpl, now, budgets, budget, adapter, runId, eventCache,
  } = context;
  const matterKey = matter.matter_key;
  const cursor = parseCursor(matter.cursor_json);
  let skip = cursor.skip || 0;
  const pageSize = budgets.pageSize;
  const acquiredAt = iso(now);
  const histories = [];
  const eventItems = [];
  let complete = false;
  let retained = 0;

  await writeState(env, matterKey, {
    last_attempt_at: acquiredAt,
    in_flight_run_id: runId,
    acquisition_status: ACQUISITION_STATUS.partial,
  });

  while (true) {
    if (budget.remaining <= 0) {
      await writeState(env, matterKey, {
        last_attempt_at: acquiredAt,
        acquisition_status: ACQUISITION_STATUS.partial,
        cursor_json: JSON.stringify({ skip, adapter }),
        due_at: acquiredAt,
        retry_after: null,
        in_flight_run_id: null,
        last_error: "budget-exhausted",
        visit_seq: Number(matter.visit_seq || 0) + 1,
      });
      return { status: ACQUISITION_STATUS.partial, retained, reason: "budget-exhausted" };
    }

    const page = await publisherGet(budget, () => (
      adapter === MATTER_HISTORIES_ADAPTER
        ? fetchLegistarMatterHistoriesPage({
          matterId: matter.matter_id,
          token,
          fetchImpl,
          skip,
          top: pageSize,
          timeoutMs: budgets.timeoutMs,
          now,
        })
        : fetchLegistarEventItemsByMatterPage({
          matterId: matter.matter_id,
          token,
          fetchImpl,
          skip,
          top: pageSize,
          timeoutMs: budgets.timeoutMs,
          now,
        })
    ));

    if (!page.ok) {
      const failedStatus = page.kind === "budget" ? ACQUISITION_STATUS.partial : ACQUISITION_STATUS.failed;
      const retryAfter = page.retryAfter || null;
      const dueAt = retryAfter || new Date(now.getTime() + Math.min(
        budgets.cadenceMs,
        15 * 60 * 1000 * (2 ** Math.min(5, Number(matter.failure_count || 0))),
      )).toISOString();
      await writeState(env, matterKey, {
        last_attempt_at: acquiredAt,
        acquisition_status: failedStatus,
        cursor_json: JSON.stringify({ skip, adapter }),
        retry_after: retryAfter,
        due_at: dueAt,
        failure_count: Number(matter.failure_count || 0) + 1,
        last_error: page.kind,
        in_flight_run_id: null,
        visit_seq: Number(matter.visit_seq || 0) + 1,
        last_complete_refresh_at: matter.last_complete_refresh_at || null,
      });
      return {
        status: failedStatus,
        retained,
        reason: page.kind,
        retryAfter,
        current: false,
      };
    }

    const pageRows = page.rows || [];
    if (adapter === MATTER_HISTORIES_ADAPTER) {
      histories.push(...pageRows);
      const nested = await eventItemsForHistories(pageRows, matter.matter_id, { token, fetchImpl, budget });
      if (nested.failure) {
        const failedStatus = nested.failure.kind === "budget" ? ACQUISITION_STATUS.partial : ACQUISITION_STATUS.failed;
        await writeState(env, matterKey, {
          last_attempt_at: acquiredAt,
          acquisition_status: failedStatus,
          cursor_json: JSON.stringify({ skip, adapter }),
          retry_after: nested.failure.retryAfter || null,
          due_at: nested.failure.retryAfter || acquiredAt,
          last_error: nested.failure.kind,
          in_flight_run_id: null,
          visit_seq: Number(matter.visit_seq || 0) + 1,
          last_complete_refresh_at: matter.last_complete_refresh_at || null,
        });
        return { status: failedStatus, retained, reason: nested.failure.kind, current: false };
      }
      eventItems.push(...nested.items);
    } else {
      eventItems.push(...pageRows.filter((row) => String(row?.EventItemMatterId) === String(matter.matter_id)));
    }

    const eventIds = [...new Set(eventItems.map(eventIdOf).filter(Boolean))];
    const hydrated = await hydrateEvents(eventIds, eventCache, {
      token, fetchImpl, budget, now, timeoutMs: budgets.timeoutMs,
    });
    if (hydrated.budgetExhausted || hydrated.failure) {
      const failure = hydrated.failure || { kind: "budget" };
      const failedStatus = failure.kind === "budget" ? ACQUISITION_STATUS.partial : ACQUISITION_STATUS.failed;
      await writeState(env, matterKey, {
        last_attempt_at: acquiredAt,
        acquisition_status: failedStatus,
        cursor_json: JSON.stringify({ skip, adapter }),
        retry_after: failure.retryAfter || null,
        due_at: failure.retryAfter || acquiredAt,
        failure_count: Number(matter.failure_count || 0) + (failedStatus === ACQUISITION_STATUS.failed ? 1 : 0),
        last_error: failure.kind,
        in_flight_run_id: null,
        visit_seq: Number(matter.visit_seq || 0) + 1,
        last_complete_refresh_at: matter.last_complete_refresh_at || null,
      });
      if (eventItems.length) {
        await retainNativeMatterObservations(env, {
          events: [...eventCache.values()],
          eventItems,
          votes: [],
        }, { acquiredAt });
      }
      return { status: failedStatus, retained, reason: failure.kind, current: false };
    }

    const voteBag = await hydrateVotes(eventItems, { token, fetchImpl, budget, now });
    const journal = await retainNativeMatterObservations(env, {
      events: hydrated.events,
      eventItems,
      votes: voteBag.votes,
    }, { acquiredAt });
    retained += Number(journal?.written || 0);
    await dualWriteLegistarObservations(env, {
      events: hydrated.events,
      eventItems,
      votes: voteBag.votes,
      histories,
    }, acquiredAt);

    if (voteBag.budgetExhausted) {
      await writeState(env, matterKey, {
        last_attempt_at: acquiredAt,
        acquisition_status: ACQUISITION_STATUS.partial,
        cursor_json: JSON.stringify({ skip, adapter }),
        due_at: acquiredAt,
        last_error: "budget-exhausted",
        in_flight_run_id: null,
        visit_seq: Number(matter.visit_seq || 0) + 1,
      });
      return { status: ACQUISITION_STATUS.partial, retained, reason: "budget-exhausted", current: false };
    }

    skip += pageSize;
    complete = page.complete || pageRows.length === 0;
    await writeState(env, matterKey, {
      last_attempt_at: acquiredAt,
      acquisition_status: complete ? ACQUISITION_STATUS.complete : ACQUISITION_STATUS.partial,
      cursor_json: complete ? null : JSON.stringify({ skip, adapter }),
      in_flight_run_id: complete ? null : runId,
      last_complete_refresh_at: complete ? acquiredAt : (matter.last_complete_refresh_at || null),
      retry_after: null,
      due_at: complete ? new Date(now.getTime() + budgets.cadenceMs).toISOString() : acquiredAt,
      failure_count: complete ? 0 : Number(matter.failure_count || 0),
      last_error: complete ? null : "partial-page",
      visit_seq: Number(matter.visit_seq || 0) + (complete ? 1 : 0),
    });
    if (complete) {
      return { status: ACQUISITION_STATUS.complete, retained, reason: null, current: true };
    }
    if (context.crashAfterPage) {
      const err = new Error("injected-crash");
      err.injected = true;
      throw err;
    }
    if (budget.remaining <= 0) {
      await writeState(env, matterKey, {
        last_attempt_at: acquiredAt,
        acquisition_status: ACQUISITION_STATUS.partial,
        cursor_json: JSON.stringify({ skip, adapter }),
        due_at: acquiredAt,
        last_error: "budget-exhausted",
        in_flight_run_id: null,
        visit_seq: Number(matter.visit_seq || 0) + 1,
      });
      return { status: ACQUISITION_STATUS.partial, retained, reason: "budget-exhausted", current: false };
    }
  }
}

async function runRefresh(env, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const startedAt = iso(now);
  const runId = options.runId || `matter-refresh:${startedAt}`;
  const gate = options.gate || (
    options.historiesProof
      ? evaluateMatterHistoriesSourceGate(options.historiesProof)
      : defaultMatterHistoriesSourceGate()
  );
  const adapter = options.adapter || gate.adapter;
  const budgets = readBudgets(env, options);
  const token = options.token !== undefined ? options.token : (env?.LEGISTAR_API_TOKEN || null);
  const fetchImpl = options.fetchImpl || fetch;

  const retention = await verifyRetentionConfiguration(env);
  if (!retention.ok) {
    const receipt = emptyReceipt({
      run_id: runId,
      started_at: startedAt,
      finished_at: startedAt,
      status: "failed",
      failed: 1,
      reason: retention.reason,
      source_gate: gate.passed ? "passed" : "not-passed",
      adapter,
      current: false,
    });
    try { await persistRun(env, receipt); } catch { /* schema may be the failure */ }
    return receipt;
  }

  const lock = await env.DB.prepare("SELECT run_id, acquired_at FROM matter_refresh_lock WHERE lock_id = ?")
    .bind(MATTER_REFRESH_LOCK_ID).first();
  if (lock?.run_id && lock.run_id !== runId) {
    const age = Date.parse(lock.acquired_at || "") || 0;
    if (Number.isFinite(age) && now.getTime() - age < 15 * 60 * 1000) {
      return emptyReceipt({
        run_id: runId,
        started_at: startedAt,
        finished_at: startedAt,
        status: "deferred",
        deferred: 1,
        reason: "in-flight",
        source_gate: gate.passed ? "passed" : "not-passed",
        adapter,
        current: false,
      });
    }
  }
  await env.DB.prepare(
    "INSERT OR REPLACE INTO matter_refresh_lock (lock_id, run_id, acquired_at) VALUES (?,?,?)",
  ).bind(MATTER_REFRESH_LOCK_ID, runId, startedAt).run();

  try {
    const receipt = emptyReceipt({
      run_id: runId,
      started_at: startedAt,
      status: "partial",
      source_gate: gate.passed ? "passed" : "not-passed",
      adapter,
      current: false,
      matters: [],
    });

    if (!token) {
      const due = await listEligibleMatters(env, startedAt, budgets.maxMatters);
      receipt.attempted = due.length;
      receipt.failed = due.length;
      receipt.status = "failed";
      receipt.reason = "token-absent";
      receipt.finished_at = iso(now);
      for (const matter of due) {
        await writeState(env, matter.matter_key, {
          last_attempt_at: startedAt,
          acquisition_status: ACQUISITION_STATUS.failed,
          last_error: "token-absent",
          due_at: new Date(now.getTime() + budgets.cadenceMs).toISOString(),
          visit_seq: Number(matter.visit_seq || 0) + 1,
          failure_count: Number(matter.failure_count || 0) + 1,
          last_complete_refresh_at: matter.last_complete_refresh_at || null,
        });
        receipt.matters.push({ matter_id: matter.matter_id, status: ACQUISITION_STATUS.failed, reason: "token-absent" });
      }
      await persistRun(env, receipt);
      return receipt;
    }

    const eligible = await listEligibleMatters(env, startedAt, 500);
    const selected = eligible.slice(0, budgets.maxMatters);
    receipt.deferred = Math.max(0, eligible.length - selected.length);
    const budget = { remaining: budgets.maxRequests, used: 0 };
    const eventCache = new Map();

    for (const matter of selected) {
      if (budget.remaining <= 0) {
        receipt.deferred += 1;
        receipt.matters.push({ matter_id: matter.matter_id, status: ACQUISITION_STATUS.deferred, reason: "budget-exhausted" });
        continue;
      }
      receipt.attempted += 1;
      const result = await refreshOneMatter(env, matter, {
        token,
        fetchImpl,
        now,
        budgets,
        budget,
        adapter,
        runId,
        eventCache,
        crashAfterPage: options.crashAfterPage,
      });
      receipt.matters.push({
        matter_id: matter.matter_id,
        status: result.status,
        reason: result.reason || null,
        retained: result.retained,
      });
      if (result.status === ACQUISITION_STATUS.complete) receipt.retained += 1;
      else if (result.status === ACQUISITION_STATUS.deferred) receipt.deferred += 1;
      else if (result.status === ACQUISITION_STATUS.failed) receipt.failed += 1;
      else receipt.deferred += 1;
    }

    receipt.request_count = budget.used;
    receipt.finished_at = iso(now);
    const servedAll = receipt.failed === 0 && receipt.deferred === 0 && selected.length === eligible.length;
    receipt.status = receipt.failed && !receipt.retained && !receipt.attempted
      ? "failed"
      : servedAll && receipt.failed === 0
        ? "complete"
        : "partial";
    receipt.current = receipt.status === "complete";
    await persistRun(env, receipt);
    return receipt;
  } finally {
    await env.DB.prepare("DELETE FROM matter_refresh_lock WHERE lock_id = ? AND run_id = ?")
      .bind(MATTER_REFRESH_LOCK_ID, runId).run();
  }
}

export async function refreshExactMatterRoster(env, options = {}) {
  if (RUN_OWNERS.has(env)) {
    return emptyReceipt({
      status: "deferred",
      deferred: 1,
      reason: "duplicate-trigger",
      current: false,
      source_gate: (options.gate || defaultMatterHistoriesSourceGate()).passed ? "passed" : "not-passed",
    });
  }
  RUN_OWNERS.set(env, true);
  try {
    return await runRefresh(env, options);
  } finally {
    RUN_OWNERS.delete(env);
  }
}

export async function projectMatterRefreshOperatorView(env) {
  const run = await readLatestRefreshRun(env);
  const receipt = run?.receipt_json ? JSON.parse(run.receipt_json) : null;
  const roster = (await env.DB.prepare(
    `SELECT r.matter_id, r.kind, r.active, s.acquisition_status, s.last_attempt_at,
            s.last_complete_refresh_at, s.retry_after, s.due_at, s.last_error
       FROM matter_refresh_roster r
       LEFT JOIN matter_refresh_state s ON s.matter_key = r.matter_key
      ORDER BY r.matter_id ASC`,
  ).all())?.results || [];
  return {
    schema: MATTER_REFRESH_SCHEMA,
    receipt,
    roster,
    summary: {
      attempted: receipt?.attempted || 0,
      retained: receipt?.retained || 0,
      deferred: receipt?.deferred || 0,
      failed: receipt?.failed || 0,
      status: receipt?.status || "never",
      current: receipt?.current === true,
      source_gate: receipt?.source_gate || "not-passed",
      adapter: receipt?.adapter || MATTER_EVENT_ITEMS_ADAPTER,
    },
  };
}
