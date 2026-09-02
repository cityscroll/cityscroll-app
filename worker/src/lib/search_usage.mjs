/**
 * Completed-search usage statistics, derived from accepted execution receipts.
 *
 * The event authority is the stored receipt: one accepted production receipt means
 * one reader watched one Search settle. Input counters (`nl_search`, `search_run`)
 * answer a different question — how often someone asked — and they stay where they
 * are. Nothing here reinterprets an input event as a completed search, and nothing
 * here counts an intake the receipt route rejected, because a rejected submission is
 * never stored in the first place.
 *
 * Four exclusions hold by construction rather than by filtering:
 *
 *   developer / test  classified by the same ANALYTICS_ENVIRONMENT + developer-
 *                     exclusion secret /events already uses, and stored under the
 *                     disjoint `search:exec-dev:` prefix. This read never lists it.
 *   rejected          refused before storage by the intake contract.
 *   duplicate intake  folded by the receipt's stable execution fingerprint.
 *   reload            a new render at a new instant is a new fingerprint, so it
 *                     counts again — which is the truth about what a reader did.
 *
 * COST: a window is folded out of KV `list()` pages. The receipt key already encodes
 * its received instant, and the aggregation dimensions ride the key as metadata, so
 * a 30-day window costs list pages rather than one read per receipt. Receipts stored
 * before those dimensions existed are hydrated with a bounded batch of body reads;
 * anything past that bound is reported as unclassified rather than guessed at.
 */

import {
  SEARCH_ACTIVITY_FAMILIES,
  SEARCH_ACTIVITY_OUTCOME_STATES,
  SEARCH_ACTIVITY_RETENTION_DAYS,
} from "../../../capabilities/search_activity.mjs";
import {
  SEARCH_ACTIVITY_KEY_PREFIX,
  searchActivityKeyReceivedAtMs,
  searchExecutionDimensions,
} from "./search_activity.mjs";

export const SEARCH_USAGE_SCHEMA = "cityscroll.search_usage.v1";

/** The established private windows, in UTC days including the current day. */
export const SEARCH_USAGE_WINDOW_DAYS = Object.freeze([7, 30]);

/**
 * Bounds on one read. Retention already caps the namespace at 30 days; these cap the
 * work a single authenticated request will do inside it, and a read that hits either
 * bound says so instead of returning a confident short number.
 */
export const SEARCH_USAGE_LIST_PAGE = 1000;
export const SEARCH_USAGE_MAX_SCAN_KEYS = 5000;
export const SEARCH_USAGE_MAX_HYDRATE = 200;
const HYDRATE_BATCH = 10;

const DAY_MS = 24 * 3600 * 1000;
const OUTCOME_SET = new Set(SEARCH_ACTIVITY_OUTCOME_STATES);
const FAMILY_SET = new Set(SEARCH_ACTIVITY_FAMILIES);

/**
 * Family appearance semantics, stated once and never mixed with the other reading.
 * An appearance is an EXECUTION that rendered at least one row in the family — so an
 * execution with nine Contract rows is one Contract appearance, and an execution that
 * rendered Contracts and Land is one appearance in each. Total rendered rows are a
 * different measure and are deliberately not published here.
 *
 * A family recorded as incomplete but with no rendered rows did not appear: coverage
 * gaps are a separate fact, already carried per execution on Search activity.
 */
export const SEARCH_USAGE_FAMILY_APPEARANCE_SEMANTICS =
  "One execution that rendered at least one row in the family. Never a count of result rows, and never a coverage gap.";

/**
 * Unique browsers and recognized accounts are separate measures over the same
 * executions. One person may be several browsers and one account may search from
 * several browsers, so neither is a count of people and the two are never added.
 */
export const SEARCH_USAGE_IDENTITY_NOTE =
  "Unique visitors counts distinct browsers, recognized accounts counts distinct recognized subscribers. They overlap, they are not people, and they are never summed.";

/**
 * Cuts this contract has a shape for but no landed signal behind. Each names the
 * contract that would make it truthful. Until then it reports unavailable — never a
 * measured zero, which an operator would read as "nobody did this".
 */
export const SEARCH_USAGE_OPTIONAL_CUTS = Object.freeze([
  Object.freeze({
    id: "history_reruns",
    label: "Searches rerun from browser search history",
    requires: "A landed browser search-history action signal carrying the execution identity it reran.",
    unavailable_reason: "no-landed-history-action-signal",
  }),
  Object.freeze({
    id: "recognized_account_history",
    label: "Account-specific search history cuts",
    requires: "A landed recognized-history session contract tying retained history to an account.",
    unavailable_reason: "no-landed-account-history-contract",
  }),
  Object.freeze({
    id: "searches_leading_to_following",
    label: "Searches that led to a Following watch",
    requires: "A stable execution or handoff identity carried from a search into the Following watch it produced.",
    unavailable_reason: "no-stable-handoff-identity",
  }),
]);

/**
 * Inclusive start of a window, in UTC day buckets. `days = 7` opens at midnight UTC
 * six days before the current UTC day, matching the established `lastNDays` windows
 * the rest of the private stats body already reports.
 */
export function searchUsageWindowStartMs(nowMs, days) {
  const dayStart = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return dayStart - (days - 1) * DAY_MS;
}

/** Normalize one stored dimension set; anything unusable becomes null, never a guess. */
export function normalizeSearchUsageDimensions(raw, receivedAtMs) {
  if (!raw || typeof raw !== "object") return null;
  const execution = typeof raw.execution === "string" && raw.execution ? raw.execution : null;
  const outcome = OUTCOME_SET.has(raw.outcome) ? raw.outcome : null;
  if (!execution || !outcome) return null;
  if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) return null;
  const families = Array.isArray(raw.families)
    ? [...new Set(raw.families.filter((family) => FAMILY_SET.has(family)))]
    : [];
  return {
    receivedAtMs,
    execution,
    outcome,
    recognized: raw.recognized === true,
    visitor: typeof raw.visitor === "string" && raw.visitor ? raw.visitor : null,
    subscriber: typeof raw.subscriber === "string" && raw.subscriber ? raw.subscriber : null,
    families,
  };
}

function emptyCut(days, nowMs) {
  return {
    window_days: days,
    starts_at: new Date(searchUsageWindowStartMs(nowMs, days)).toISOString(),
    ends_at: new Date(nowMs).toISOString(),
    completed: 0,
    outcomes: Object.fromEntries(SEARCH_ACTIVITY_OUTCOME_STATES.map((state) => [state, 0])),
    recognition: { recognized: 0, unrecognized: 0 },
    unique_visitors: 0,
    recognized_accounts: 0,
    family_appearances: Object.fromEntries(SEARCH_ACTIVITY_FAMILIES.map((family) => [family, 0])),
  };
}

/**
 * Optional cuts, measured only where a landed signal supplied both windows.
 * A partially supplied signal is not half a measurement; it stays unavailable.
 */
export function optionalSearchUsageCuts(signals = {}) {
  return Object.fromEntries(SEARCH_USAGE_OPTIONAL_CUTS.map((cut) => {
    const measured = signals?.[cut.id];
    const usable = Number.isSafeInteger(measured?.last7d) && Number.isSafeInteger(measured?.last30d);
    return [cut.id, usable
      ? {
        available: true,
        label: cut.label,
        requires: cut.requires,
        last7d: measured.last7d,
        last30d: measured.last30d,
      }
      : {
        available: false,
        label: cut.label,
        requires: cut.requires,
        unavailable_reason: cut.unavailable_reason,
      }];
  }));
}

/**
 * Fold observed receipt dimensions into the windowed cuts.
 *
 * One execution counts once per window it falls in. Duplicate intakes collapse onto
 * the earliest instant the store learned of that execution, so a retry can never move
 * an execution across a window boundary.
 */
export function foldSearchUsage(observations = [], {
  now = new Date(),
  scan = {},
  signals = {},
} = {}) {
  const nowMs = new Date(now).getTime();
  const byExecution = new Map();
  let duplicateIntakes = 0;
  let futureDated = 0;

  for (const observation of observations) {
    if (!observation) continue;
    const existing = byExecution.get(observation.execution);
    if (!existing) {
      byExecution.set(observation.execution, observation);
      continue;
    }
    duplicateIntakes += 1;
    if (observation.receivedAtMs < existing.receivedAtMs) {
      byExecution.set(observation.execution, observation);
    }
  }

  const windows = {};
  for (const days of SEARCH_USAGE_WINDOW_DAYS) {
    const cut = emptyCut(days, nowMs);
    const startMs = searchUsageWindowStartMs(nowMs, days);
    const visitors = new Set();
    const accounts = new Set();
    for (const execution of byExecution.values()) {
      if (execution.receivedAtMs > nowMs) continue;
      if (execution.receivedAtMs < startMs) continue;
      cut.completed += 1;
      cut.outcomes[execution.outcome] += 1;
      if (execution.recognized) cut.recognition.recognized += 1;
      else cut.recognition.unrecognized += 1;
      if (execution.visitor) visitors.add(execution.visitor);
      if (execution.recognized && execution.subscriber) accounts.add(execution.subscriber);
      for (const family of execution.families) cut.family_appearances[family] += 1;
    }
    cut.unique_visitors = visitors.size;
    cut.recognized_accounts = accounts.size;
    windows[`last${days}d`] = cut;
  }

  for (const execution of byExecution.values()) {
    if (execution.receivedAtMs > nowMs) futureDated += 1;
  }

  return {
    schema: SEARCH_USAGE_SCHEMA,
    available: true,
    unavailable_reason: null,
    generated_at: new Date(nowMs).toISOString(),
    source: "Accepted production search-execution receipts. Input events are not completed searches.",
    retention_days: SEARCH_ACTIVITY_RETENTION_DAYS,
    identity_note: SEARCH_USAGE_IDENTITY_NOTE,
    family_appearance_semantics: SEARCH_USAGE_FAMILY_APPEARANCE_SEMANTICS,
    executions_observed: byExecution.size,
    duplicate_intakes: duplicateIntakes,
    future_dated_executions: futureDated,
    unclassified_receipts: Number(scan.unclassified) || 0,
    scan: {
      keys_seen: Number(scan.keysSeen) || 0,
      hydrated_receipts: Number(scan.hydrated) || 0,
      scan_complete: scan.scanComplete !== false,
      key_ceiling: SEARCH_USAGE_MAX_SCAN_KEYS,
      hydrate_ceiling: SEARCH_USAGE_MAX_HYDRATE,
    },
    windows,
    optional_cuts: optionalSearchUsageCuts(signals),
  };
}

/** The honest empty answer when there is no store or the read failed. */
export function unavailableSearchUsage(reason, now = new Date()) {
  return {
    schema: SEARCH_USAGE_SCHEMA,
    available: false,
    unavailable_reason: reason,
    generated_at: new Date(now).toISOString(),
    source: "Accepted production search-execution receipts. Input events are not completed searches.",
    retention_days: SEARCH_ACTIVITY_RETENTION_DAYS,
    identity_note: SEARCH_USAGE_IDENTITY_NOTE,
    family_appearance_semantics: SEARCH_USAGE_FAMILY_APPEARANCE_SEMANTICS,
    windows: {},
    optional_cuts: optionalSearchUsageCuts(),
  };
}

/**
 * Read the production receipt prefix and fold it into the windowed statistics.
 *
 * Fail soft: a missing binding or a store error reports unavailability rather than
 * failing the whole private stats response, and never returns a zero that would read
 * as "no one searched".
 */
export async function readSearchUsage(env, { now = new Date(), signals = {} } = {}) {
  if (!env?.ALERT_STATE?.list) return unavailableSearchUsage("no-store", now);

  const nowMs = new Date(now).getTime();
  // Nothing outside retention can be in a window, so the oldest window bound is also
  // the point where paging further down the descending key order stops being useful.
  const oldestMs = searchUsageWindowStartMs(nowMs, Math.max(...SEARCH_USAGE_WINDOW_DAYS));

  const observations = [];
  const pending = [];
  let keysSeen = 0;
  let unclassified = 0;
  let hydrated = 0;
  let scanComplete = true;

  try {
    let cursor;
    let exhausted = false;
    while (!exhausted) {
      const listed = await env.ALERT_STATE.list({
        prefix: SEARCH_ACTIVITY_KEY_PREFIX,
        limit: SEARCH_USAGE_LIST_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      for (const key of listed?.keys || []) {
        const receivedAtMs = searchActivityKeyReceivedAtMs(key.name);
        if (receivedAtMs === null) {
          unclassified += 1;
          keysSeen += 1;
          continue;
        }
        // Keys sort newest first, so the first receipt older than the widest window
        // ends the useful part of the scan.
        if (receivedAtMs < oldestMs) {
          exhausted = true;
          break;
        }
        keysSeen += 1;
        const dimensions = normalizeSearchUsageDimensions(key.metadata, receivedAtMs);
        if (dimensions) observations.push(dimensions);
        else pending.push({ name: key.name, receivedAtMs });
      }
      if (exhausted) break;
      if (keysSeen >= SEARCH_USAGE_MAX_SCAN_KEYS) {
        scanComplete = listed?.list_complete === true;
        break;
      }
      cursor = listed?.list_complete === false ? listed.cursor : null;
      if (!cursor) break;
    }

    // Receipts written before the dimensions rode the key still describe real
    // executions. Hydrate a bounded batch of them from their own bodies; past that
    // bound they are reported unclassified rather than silently dropped or assumed.
    const hydratable = pending.slice(0, SEARCH_USAGE_MAX_HYDRATE);
    unclassified += pending.length - hydratable.length;
    for (let start = 0; start < hydratable.length; start += HYDRATE_BATCH) {
      const batch = hydratable.slice(start, start + HYDRATE_BATCH);
      const bodies = await Promise.all(batch.map((entry) => env.ALERT_STATE.get(entry.name)));
      for (const [index, body] of bodies.entries()) {
        let receipt = null;
        try { receipt = JSON.parse(body); } catch { /* a corrupt row is not a count */ }
        const dimensions = receipt
          ? normalizeSearchUsageDimensions(searchExecutionDimensions(receipt), batch[index].receivedAtMs)
          : null;
        if (dimensions) {
          observations.push(dimensions);
          hydrated += 1;
        } else {
          unclassified += 1;
        }
      }
    }
  } catch {
    return unavailableSearchUsage("read-failed", now);
  }

  return foldSearchUsage(observations, {
    now,
    signals,
    scan: { keysSeen, hydrated, unclassified, scanComplete },
  });
}
