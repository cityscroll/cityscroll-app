/**
 * Incremental, presentation-neutral facts derived from a civic edge stream.
 *
 * The accumulator deliberately keeps corpus coverage separate from the bounded
 * preview rows that fed it.  Callers may add rows as they arrive, then freeze
 * the result for a read model without rescanning the graph.
 */

export const DERIVED_FEATURE_ROLLUP_SCHEMA = "cityscroll.derived_feature_rollup.v1";
export const DERIVED_FEATURE_ROLLUP_METHOD = "derived_feature_rollup_incremental_v1";

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const SEEN = Symbol("derived-feature-rollup-seen");

const LIFECYCLE_BUCKETS = Object.freeze(["current", "historical", "unknown"]);
const EMPTY_LIFECYCLE = () => Object.fromEntries(LIFECYCLE_BUCKETS.map((key) => [key, 0]));

function clean(value, max = 160) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Return a valid ISO calendar day without turning an invalid date into a neighbour. */
export function featureDayStamp(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const match = raw.match(/\d{4}-\d{2}-\d{2}/);
  if (!match || !DAY_RE.test(match[0])) return null;
  const [year, month, day] = match[0].split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) return null;
  return match[0];
}

function compareDay(left, right) {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function dayDistance(later, earlier) {
  if (!later || !earlier) return null;
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / DAY_MS);
}

function validDay(item = {}) {
  return featureDayStamp(item.valid_at)
    || featureDayStamp(item.valid_from)
    || featureDayStamp(item.published_at)
    || featureDayStamp(item.date)
    || featureDayStamp(item.when)
    || null;
}

function observedDay(item = {}) {
  return featureDayStamp(item.observed_at)
    || featureDayStamp(item.system_time)
    || featureDayStamp(item.learned_at)
    || featureDayStamp(item.knowledge_time)
    || null;
}

function lifecycleValue(item = {}) {
  const lifecycle = item.lifecycle && typeof item.lifecycle === "object" ? item.lifecycle : {};
  return clean(
    lifecycle.state
      || lifecycle.status
      || item.lifecycle_state
      || item.lifecycle_status
      || item.status
      || item.stage
      || item.state,
    80,
  ).toLowerCase();
}

function lifecycleBucket(item) {
  const value = lifecycleValue(item);
  if (!value) return "unknown";
  if (/^(open|active|current|pending|ongoing|in_progress|upcoming|future)$/.test(value)) return "current";
  if (/^(closed|complete|completed|historical|expired|cancelled|canceled|past|superseded|ended)$/.test(value)) return "historical";
  return "unknown";
}

function itemKey(item, index = 0) {
  return clean(
    item?.id
      || item?.subject_ref
      || item?.target_id
      || item?.event_id
      || item?.request_id
      || `row:${index}`,
    320,
  );
}

function incrementBucket(map, key) {
  const bucket = clean(key, 100).toLowerCase() || "unknown";
  map[bucket] = (map[bucket] || 0) + 1;
}

function updateSpan(span, day) {
  if (!day) return;
  if (!span.start || compareDay(day, span.start) < 0) span.start = day;
  if (!span.end || compareDay(day, span.end) > 0) span.end = day;
}

function updateFreshness(rollup, item, itemValid, itemObserved) {
  const sourceDay = featureDayStamp(item.as_of)
    || featureDayStamp(item.freshness_at)
    || itemObserved
    || itemValid;
  if (!sourceDay) return;
  if (!rollup.freshness.latest_day || compareDay(sourceDay, rollup.freshness.latest_day) > 0) {
    rollup.freshness.latest_day = sourceDay;
    rollup.freshness.latest_source = item.as_of ? "snapshot" : itemObserved ? "observation" : "published_record";
  }
}

function applyFreshness(rollup) {
  const reference = rollup.freshness.reference_day;
  const latest = rollup.freshness.latest_day;
  const limit = rollup.freshness.max_age_days;
  rollup.freshness.age_days = reference && latest ? dayDistance(reference, latest) : null;
  rollup.freshness.status = !latest
    ? "unknown"
    : !reference || limit == null
      ? "known"
      : rollup.freshness.age_days <= limit ? "fresh" : "stale";
}

function publicRollup(rollup) {
  const output = {
    schema: DERIVED_FEATURE_ROLLUP_SCHEMA,
    method: DERIVED_FEATURE_ROLLUP_METHOD,
    version: 1,
    counts: {
      total: rollup.counts.total,
      materialized: rollup.counts.materialized,
      dated: rollup.counts.dated,
      undated: rollup.counts.undated,
      by_state: { ...rollup.counts.by_state },
      by_relation: { ...rollup.counts.by_relation },
    },
    spans: {
      valid: { ...rollup.spans.valid },
      observed: { ...rollup.spans.observed },
      valid_days: dayDistance(rollup.spans.valid.end, rollup.spans.valid.start),
      observed_days: dayDistance(rollup.spans.observed.end, rollup.spans.observed.start),
    },
    lifecycle: {
      by_bucket: { ...rollup.lifecycle.by_bucket },
      by_stage: { ...rollup.lifecycle.by_stage },
      complete: rollup.lifecycle.complete,
    },
    freshness: { ...rollup.freshness },
  };
  return Object.freeze(output);
}

/** Create a mutable accumulator. Use finalizeDerivedFeatureRollup before publishing it. */
export function createDerivedFeatureRollup({
  totalCount = null,
  state = null,
  relation = null,
  asOf = null,
  referenceDay = null,
  maxAgeDays = null,
} = {}) {
  const total = totalCount == null ? null : Number(totalCount);
  const rollup = {
    counts: {
      total: Number.isInteger(total) && total >= 0 ? total : null,
      materialized: 0,
      dated: 0,
      undated: 0,
      by_state: {},
      by_relation: {},
    },
    spans: {
      valid: { start: null, end: null },
      observed: { start: null, end: null },
    },
    lifecycle: {
      by_bucket: EMPTY_LIFECYCLE(),
      by_stage: {},
      // A bounded preview does not prove the full corpus lifecycle counts.
      complete: total == null || total === 0,
    },
    freshness: {
      reference_day: featureDayStamp(referenceDay) || featureDayStamp(asOf),
      snapshot_day: featureDayStamp(asOf),
      latest_day: null,
      latest_source: null,
      age_days: null,
      max_age_days: Number.isInteger(maxAgeDays) && maxAgeDays >= 0 ? maxAgeDays : null,
      status: "unknown",
    },
    defaults: {
      state: state == null ? null : clean(state, 80),
      relation: relation == null ? null : clean(relation, 120),
    },
    [SEEN]: new Set(),
  };
  return rollup;
}

/** Add one graph row in O(1) amortized time; duplicate keys are ignored. */
export function addDerivedFeatureObservation(rollup, item = {}, {
  key = null,
  state = null,
  relation = null,
  index = 0,
} = {}) {
  if (!rollup || typeof rollup !== "object") throw new TypeError("rollup accumulator is required");
  if (!(rollup[SEEN] instanceof Set)) rollup[SEEN] = new Set();
  const id = clean(key || itemKey(item, index), 320);
  if (rollup[SEEN].has(id)) return rollup;
  rollup[SEEN].add(id);

  const valid = validDay(item);
  const observed = observedDay(item);
  const itemState = state || item.state || item.status || rollup.defaults?.state || "unknown";
  const itemRelation = relation || item.relation || item.edge_type || rollup.defaults?.relation || "unknown";
  const stage = lifecycleValue(item) || "unknown";

  rollup.counts.materialized += 1;
  if (valid) {
    rollup.counts.dated += 1;
    updateSpan(rollup.spans.valid, valid);
  } else {
    rollup.counts.undated += 1;
  }
  if (observed) updateSpan(rollup.spans.observed, observed);
  incrementBucket(rollup.counts.by_state, itemState);
  incrementBucket(rollup.counts.by_relation, itemRelation);
  const bucket = lifecycleBucket(item);
  rollup.lifecycle.by_bucket[bucket] += 1;
  incrementBucket(rollup.lifecycle.by_stage, stage);
  updateFreshness(rollup, item, valid, observed);
  if (rollup.counts.total == null) rollup.counts.total = rollup.counts.materialized;
  rollup.lifecycle.complete = rollup.counts.total === rollup.counts.materialized;
  applyFreshness(rollup);
  return rollup;
}

/** Finish an accumulator without exposing its de-duplication index. */
export function finalizeDerivedFeatureRollup(rollup) {
  if (!rollup || typeof rollup !== "object") return null;
  applyFreshness(rollup);
  return publicRollup(rollup);
}

/** One-pass construction for a bounded batch of already-materialized graph rows. */
export function buildDerivedFeatureRollup(items = [], options = {}) {
  const rows = Array.isArray(items) ? items : [];
  const rollup = createDerivedFeatureRollup({
    ...options,
    totalCount: Object.prototype.hasOwnProperty.call(options, "totalCount")
      ? options.totalCount
      : rows.length,
  });
  rows.forEach((item, index) => addDerivedFeatureObservation(rollup, item, { index }));
  return finalizeDerivedFeatureRollup(rollup);
}

/** Merge two finalized rollups without reopening the civic graph. */
export function mergeDerivedFeatureRollups(left, right) {
  const a = left || {};
  const b = right || {};
  const total = Number.isInteger(a.counts?.total) && Number.isInteger(b.counts?.total)
    ? Number(a.counts.total) + Number(b.counts.total)
    : null;
  const rollup = createDerivedFeatureRollup({
    totalCount: total,
    asOf: a.freshness?.snapshot_day || b.freshness?.snapshot_day,
    referenceDay: a.freshness?.reference_day || b.freshness?.reference_day,
    maxAgeDays: a.freshness?.max_age_days ?? b.freshness?.max_age_days,
  });
  rollup.counts.materialized = (Number(a.counts?.materialized) || 0) + (Number(b.counts?.materialized) || 0);
  rollup.counts.dated = (Number(a.counts?.dated) || 0) + (Number(b.counts?.dated) || 0);
  rollup.counts.undated = (Number(a.counts?.undated) || 0) + (Number(b.counts?.undated) || 0);
  rollup.counts.by_state = mergeMaps(a.counts?.by_state, b.counts?.by_state);
  rollup.counts.by_relation = mergeMaps(a.counts?.by_relation, b.counts?.by_relation);
  rollup.lifecycle.by_bucket = mergeMaps(a.lifecycle?.by_bucket, b.lifecycle?.by_bucket, EMPTY_LIFECYCLE());
  rollup.lifecycle.by_stage = mergeMaps(a.lifecycle?.by_stage, b.lifecycle?.by_stage);
  rollup.lifecycle.complete = Boolean(a.lifecycle?.complete && b.lifecycle?.complete);
  rollup.spans.valid = mergeSpans(a.spans?.valid, b.spans?.valid);
  rollup.spans.observed = mergeSpans(a.spans?.observed, b.spans?.observed);
  rollup.freshness.latest_day = [a.freshness?.latest_day, b.freshness?.latest_day]
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  rollup.freshness.latest_source = rollup.freshness.latest_day === b.freshness?.latest_day
    ? b.freshness?.latest_source
    : a.freshness?.latest_source;
  applyFreshness(rollup);
  return finalizeDerivedFeatureRollup(rollup);
}

function mergeMaps(left = {}, right = {}, seed = {}) {
  const merged = { ...seed };
  for (const [key, value] of Object.entries(left || {})) merged[key] = (merged[key] || 0) + (Number(value) || 0);
  for (const [key, value] of Object.entries(right || {})) merged[key] = (merged[key] || 0) + (Number(value) || 0);
  return merged;
}

function mergeSpans(left = {}, right = {}) {
  const days = [left.start, left.end, right.start, right.end].filter(Boolean).sort();
  return { start: days[0] || null, end: days.at(-1) || null };
}
