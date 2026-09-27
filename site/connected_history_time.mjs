/**
 * Bitemporal, scope-preserving states for admitted connected-history facts.
 *
 * Civic/event time answers when a documented fact held. Observation/system
 * time answers when CityScroll retained it. Corrections and old evidence
 * learned later therefore alter a belief-time query without becoming new
 * civic events. Numeric differences are emitted only for explicitly compatible
 * scopes.
 */

import {
  CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP,
  CIVIC_TIME_LEDGER_CASE_FAMILIES,
  CIVIC_TIME_LEDGER_SCHEMA,
  normalizeAsOfDay,
} from "./civic_time_ledger.mjs";

export const CONNECTED_HISTORY_TIME_SCHEMA = "cityscroll.connected_history_time.v1";
export const CONNECTED_HISTORY_TIME_STATE_SCHEMA = "cityscroll.connected_history_time_state.v1";
export const CONNECTED_HISTORY_TIME_COMPARISON_SCHEMA = "cityscroll.connected_history_time_comparison.v1";
export const CONNECTED_HISTORY_TIME_ORDERING_SCHEMA = "cityscroll.connected_history_time_ordering_receipt.v1";
export const CONNECTED_HISTORY_TIME_METHOD = "connected_history_bitemporal_as_of_v1";
export const CONNECTED_HISTORY_TIME_VERSION = 1;
export const CONNECTED_HISTORY_TIME_CASE_FAMILY = "connected_history_fact";

export const CONNECTED_HISTORY_FACT_FAMILIES = Object.freeze([
  "land_application_history",
  "environmental_review_history",
  "component_phase_history",
  "corridor_measurement_history",
]);

export const CONNECTED_HISTORY_EVENT_CLASSES = Object.freeze([
  "planned",
  "decided",
  "realized",
]);

export const CONNECTED_HISTORY_CHANGE_KINDS = Object.freeze([
  "civic_event",
  "correction",
  "newly_acquired_old_evidence",
]);

export const CONNECTED_HISTORY_LIFECYCLE_ACTIONS = Object.freeze([
  "proposed",
  "amended",
  "withdrawn",
  "decided",
  "opened",
  "measured",
  "forecast",
]);

export const CONNECTED_HISTORY_COMPARABLE_SCOPE_KEYS = Object.freeze([
  "footprint",
  "metric",
  "phase",
  "population",
  "unit",
]);

const PRECISION_RANK = Object.freeze({ year: 0, month: 1, day: 2 });

const clean = (value, max = 500) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function immutableCopy(value) {
  if (Array.isArray(value)) return value.map(immutableCopy);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, immutableCopy(nested)]));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableString(value) {
  return JSON.stringify(stableValue(value));
}

function monthEnd(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Preserve source precision while deriving conservative interval bounds. */
export function normalizeConnectedHistoryDate(input, precisionInput = null) {
  const raw = typeof input === "object" && input
    ? clean(input.value, 20)
    : clean(input, 20);
  const precision = clean(
    (typeof input === "object" && input ? input.precision : precisionInput)
      || (/^\d{4}$/.test(raw) ? "year" : /^\d{4}-\d{2}$/.test(raw) ? "month" : "day"),
    20,
  );
  if (!Object.hasOwn(PRECISION_RANK, precision)) return null;

  if (precision === "year") {
    if (!/^\d{4}$/.test(raw)) return null;
    return { value: raw, precision, start: `${raw}-01-01`, end: `${raw}-12-31` };
  }
  if (precision === "month") {
    const match = /^(\d{4})-(\d{2})$/.exec(raw);
    if (!match) return null;
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    return {
      value: raw,
      precision,
      start: `${raw}-01`,
      end: `${raw}-${String(monthEnd(Number(match[1]), month)).padStart(2, "0")}`,
    };
  }
  const day = normalizeAsOfDay(raw);
  return day ? { value: day, precision, start: day, end: day } : null;
}

function normalizeInstant(value) {
  const raw = clean(value, 80);
  if (!raw) return null;
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function normalizeScope(scope) {
  const source = scope && typeof scope === "object" && !Array.isArray(scope) ? scope : {};
  const normalized = {};
  for (const key of [...CONNECTED_HISTORY_COMPARABLE_SCOPE_KEYS, "measurement_period"]) {
    const value = clean(source[key], 240);
    normalized[key] = value || null;
  }
  return normalized;
}

function hasSourceJudgment(judgment) {
  return Boolean(
    judgment
    && typeof judgment === "object"
    && clean(judgment.source_system, 100)
    && clean(judgment.source_record_id, 240)
    && clean(judgment.source_span?.locator, 240)
    && clean(judgment.source_span?.quote, 500),
  );
}

/** Validate and copy one retained fact. Unknown families fail closed. */
export function normalizeConnectedHistoryObservation(observation = {}) {
  if (!CIVIC_TIME_LEDGER_CASE_FAMILIES.includes(CONNECTED_HISTORY_TIME_CASE_FAMILY)) {
    throw new TypeError("connected history facts are not admitted by the civic-time ledger");
  }
  if (clean(observation.case_family, 80) !== CONNECTED_HISTORY_TIME_CASE_FAMILY) {
    throw new TypeError("connected history observation requires case_family connected_history_fact");
  }
  const historyFamily = clean(observation.history_family, 100);
  if (!CONNECTED_HISTORY_FACT_FAMILIES.includes(historyFamily)) {
    throw new TypeError(`unsupported connected history family: ${historyFamily || "missing"}`);
  }
  const eventClass = clean(observation.event_class, 40);
  if (!CONNECTED_HISTORY_EVENT_CLASSES.includes(eventClass)) {
    throw new TypeError(`unsupported connected history event class: ${eventClass || "missing"}`);
  }
  const changeKind = clean(observation.change_kind, 80);
  if (!CONNECTED_HISTORY_CHANGE_KINDS.includes(changeKind)) {
    throw new TypeError(`unsupported connected history change kind: ${changeKind || "missing"}`);
  }
  const lifecycleAction = clean(observation.lifecycle_action, 40);
  if (!CONNECTED_HISTORY_LIFECYCLE_ACTIONS.includes(lifecycleAction)) {
    throw new TypeError(`unsupported connected history lifecycle action: ${lifecycleAction || "missing"}`);
  }

  const required = {
    observation_id: clean(observation.observation_id, 240),
    family_id: clean(observation.family_id, 160),
    subject_ref: clean(observation.subject_ref, 240),
    assertion_key: clean(observation.assertion_key, 240),
    fact_kind: clean(observation.fact_kind, 100),
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) throw new TypeError(`connected history observation requires ${key}`);
  }
  const eventTime = normalizeConnectedHistoryDate(observation.event_time);
  if (!eventTime) throw new TypeError("connected history observation requires a valid precise or imprecise event_time");
  const observedAt = normalizeInstant(observation.observed_at);
  if (!observedAt) throw new TypeError("connected history observation requires observed_at");
  if (!hasSourceJudgment(observation.source_judgment)) {
    throw new TypeError("connected history observation requires a quoted source judgment");
  }

  const value = immutableCopy(observation.value);
  const numericValue = typeof observation.numeric_value === "number"
    && Number.isFinite(observation.numeric_value)
    ? observation.numeric_value
    : null;
  return deepFreeze({
    ...required,
    schema: CONNECTED_HISTORY_TIME_SCHEMA,
    case_family: CONNECTED_HISTORY_TIME_CASE_FAMILY,
    history_family: historyFamily,
    event_class: eventClass,
    change_kind: changeKind,
    lifecycle_action: lifecycleAction,
    event_time: eventTime,
    observed_at: observedAt,
    publication_time: normalizeConnectedHistoryDate(observation.publication_time),
    supersedes_observation_id: clean(observation.supersedes_observation_id, 240) || null,
    comparison_key: clean(observation.comparison_key, 240) || required.assertion_key,
    scope: normalizeScope(observation.scope),
    value,
    numeric_value: numericValue,
    preliminary: observation.preliminary === true,
    source_judgment: immutableCopy(observation.source_judgment),
  });
}

function compareTemporalEntries(left, right) {
  return left.event_time.start.localeCompare(right.event_time.start)
    || PRECISION_RANK[left.event_time.precision] - PRECISION_RANK[right.event_time.precision]
    || left.family_id.localeCompare(right.family_id)
    || left.subject_ref.localeCompare(right.subject_ref)
    || left.fact_kind.localeCompare(right.fact_kind)
    || left.observation_id.localeCompare(right.observation_id);
}

/**
 * Stable insertion sort with an observable intermediate trace. The trace makes
 * ordering evidence testable at the state where each item is inserted, not
 * only at the final array.
 */
export function orderConnectedHistoryEntries(entries = []) {
  const input = Array.isArray(entries) ? entries : [];
  const ordered = [];
  const steps = [];
  for (const entry of input) {
    const before = ordered.map((row) => row.observation_id);
    let index = ordered.length;
    while (index > 0 && compareTemporalEntries(entry, ordered[index - 1]) < 0) index -= 1;
    ordered.splice(index, 0, entry);
    steps.push({
      inserted_observation_id: entry.observation_id,
      insertion_index: index,
      before,
      after: ordered.map((row) => row.observation_id),
    });
  }
  return deepFreeze({
    entries: ordered,
    receipt: {
      schema: CONNECTED_HISTORY_TIME_ORDERING_SCHEMA,
      method: "stable_temporal_insertion_v1",
      input_observation_ids: input.map((row) => row.observation_id),
      intermediate_steps: steps,
      output_observation_ids: ordered.map((row) => row.observation_id),
    },
  });
}

function latestBeliefRows(observations, civicDay, beliefInstant) {
  const latest = new Map();
  let omittedAfterCivicTime = 0;
  let omittedAfterBeliefTime = 0;
  for (const observation of observations) {
    if (observation.observed_at > beliefInstant) {
      omittedAfterBeliefTime += 1;
      continue;
    }
    // Conservative precision rule: a year/month fact is admitted only after
    // the end of its documented interval, never silently promoted to Jan 1.
    if (observation.event_time.end > civicDay) {
      omittedAfterCivicTime += 1;
      continue;
    }
    const key = `${observation.family_id}\u0000${observation.assertion_key}`;
    const previous = latest.get(key);
    if (!previous
      || observation.observed_at > previous.observed_at
      || (observation.observed_at === previous.observed_at
        && observation.observation_id > previous.observation_id)) {
      latest.set(key, observation);
    }
  }
  return { rows: [...latest.values()], omittedAfterCivicTime, omittedAfterBeliefTime };
}

/** Query the retained connected-history ledger on both bitemporal axes. */
export function projectConnectedHistoryStateAsOf(observationRows = [], options = {}) {
  const civicTime = normalizeAsOfDay(options.civicTime);
  const beliefTime = normalizeInstant(options.beliefTime);
  if (!civicTime) throw new TypeError("civicTime must be YYYY-MM-DD");
  if (!beliefTime) throw new TypeError("beliefTime must be an ISO timestamp");
  const familyId = clean(options.familyId, 160) || null;
  const observations = (Array.isArray(observationRows) ? observationRows : [])
    .map(normalizeConnectedHistoryObservation)
    .filter((row) => !familyId || row.family_id === familyId);
  const selected = latestBeliefRows(observations, civicTime, beliefTime);
  const ordering = orderConnectedHistoryEntries(selected.rows);

  return deepFreeze({
    schema: CONNECTED_HISTORY_TIME_STATE_SCHEMA,
    version: CONNECTED_HISTORY_TIME_VERSION,
    method: CONNECTED_HISTORY_TIME_METHOD,
    family_id: familyId,
    as_of: {
      civic_time: civicTime,
      belief_time: beliefTime,
    },
    entries: ordering.entries,
    lifecycle_counts: Object.fromEntries(
      CONNECTED_HISTORY_EVENT_CLASSES.map((eventClass) => [
        eventClass,
        ordering.entries.filter((entry) => entry.event_class === eventClass).length,
      ]),
    ),
    receipt: {
      temporal_contract: CIVIC_TIME_LEDGER_SCHEMA,
      case_family: CONNECTED_HISTORY_TIME_CASE_FAMILY,
      axes: {
        valid: {
          owner: CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.civic.bitemporal_axis === "valid" ? "civic" : null,
          query: civicTime,
          imprecise_date_rule: "include_after_interval_end",
        },
        system: {
          owner: CIVIC_TIME_FOUR_CLOCK_BITEMPORAL_MAP.observation.bitemporal_axis === "system" ? "observation" : null,
          query: beliefTime,
        },
        publication: { owner: null, role: "evidence_clock" },
        processing: { owner: null, role: "receipt_only", used_for_membership: false },
      },
      counts: {
        retained_observations: observations.length,
        selected_assertions: ordering.entries.length,
        omitted_after_civic_time: selected.omittedAfterCivicTime,
        omitted_after_belief_time: selected.omittedAfterBeliefTime,
      },
      selected_observation_ids: ordering.entries.map((entry) => entry.observation_id),
      ordering: ordering.receipt,
    },
  });
}

/** Compare numeric facts only when every required scope dimension is explicit and equal. */
export function compareConnectedHistoryNumericFacts(left, right) {
  if (!left || !right || !Number.isFinite(left.numeric_value) || !Number.isFinite(right.numeric_value)) {
    return { comparable: false, delta: null, blocked_by: ["non_numeric_or_missing_value"] };
  }
  const blocked = [];
  for (const key of CONNECTED_HISTORY_COMPARABLE_SCOPE_KEYS) {
    const before = clean(left.scope?.[key], 240);
    const after = clean(right.scope?.[key], 240);
    if (!before || !after) blocked.push(`missing_scope:${key}`);
    else if (before !== after) blocked.push(`incompatible_scope:${key}`);
  }
  if (blocked.length) return { comparable: false, delta: null, blocked_by: blocked };
  return {
    comparable: true,
    delta: right.numeric_value - left.numeric_value,
    blocked_by: [],
  };
}

function stateMap(state) {
  return new Map((state?.entries || []).map((entry) => [
    `${entry.family_id}\u0000${entry.comparison_key}`,
    entry,
  ]));
}

/** Compare two query results without converting knowledge changes into civic events. */
export function compareConnectedHistoryStates(before, after) {
  if (before?.schema !== CONNECTED_HISTORY_TIME_STATE_SCHEMA
    || after?.schema !== CONNECTED_HISTORY_TIME_STATE_SCHEMA) {
    throw new TypeError("connected history comparison requires two as-of states");
  }
  const left = stateMap(before);
  const right = stateMap(after);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes = [];
  for (const identity of keys) {
    const previous = left.get(identity) || null;
    const current = right.get(identity) || null;
    if (previous && current && stableString(previous.value) === stableString(current.value)
      && previous.observation_id === current.observation_id) continue;
    const numeric = previous && current
      ? compareConnectedHistoryNumericFacts(previous, current)
      : { comparable: false, delta: null, blocked_by: ["missing_comparison_side"] };
    const changeKind = current?.change_kind || previous?.change_kind || "civic_event";
    changes.push({
      family_id: current?.family_id || previous?.family_id || null,
      comparison_key: current?.comparison_key || previous?.comparison_key || null,
      before_observation_id: previous?.observation_id || null,
      after_observation_id: current?.observation_id || null,
      classification: changeKind === "civic_event" ? "civic_change" : "knowledge_change",
      knowledge_change_kind: changeKind === "civic_event" ? null : changeKind,
      event_class: current?.event_class || previous?.event_class || null,
      numeric,
    });
  }
  return deepFreeze({
    schema: CONNECTED_HISTORY_TIME_COMPARISON_SCHEMA,
    method: CONNECTED_HISTORY_TIME_METHOD,
    before: immutableCopy(before.as_of),
    after: immutableCopy(after.as_of),
    changes,
    counts: {
      civic_changes: changes.filter((change) => change.classification === "civic_change").length,
      knowledge_changes: changes.filter((change) => change.classification === "knowledge_change").length,
      comparable_numeric_deltas: changes.filter((change) => change.numeric.comparable).length,
      withheld_numeric_deltas: changes.filter((change) => !change.numeric.comparable).length,
    },
  });
}
