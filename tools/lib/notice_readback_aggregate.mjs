/**
 * Retained Notice post-delivery read-back aggregate.
 *
 * The register's gated ledger needs a committed file it can read. The daily
 * RUM drift reader writes only a scratch overlay, so this module owns the
 * retained shape: three measurement groups the Notice letters require, each
 * with its own delivery (or probe) anchor, observation window, sample counts,
 * and percentiles, plus the record subrequest's cache outcome distribution for
 * the same window as the first-byte group. Groups stay separate; nothing here
 * pools them.
 *
 * The cache outcome distribution is always present and always named as either
 * `read` (counts per closed outcome, zeros allowed) or `unread` (that word and
 * a reason). An absent field is a refusal, never silence that could be read as
 * an empty measurement.
 *
 * Window rule (site-owner decision): "the same window" as the first-byte group
 * means a window of the same shape — same length and completeness rules — once
 * the cache dimension exists. It does not require re-reading the other groups
 * over one shared calendar window with the distribution.
 */

import { NOTICE_EDGE_CACHE_OUTCOMES } from "../../site/notice_edge_response.mjs";

export const NOTICE_READBACK_AGGREGATE_SCHEMA = "cityscroll.notice_readback_aggregate.v2";
export const NOTICE_READBACK_SAMPLE_FLOOR = 30;
export const NOTICE_READBACK_RETAINED_PATH =
  "docs/evidence/performance-drift/notice-readback-aggregate.json";

/** Closed cache-outcome vocabulary carried on the Notice response. */
export const NOTICE_READBACK_CACHE_OUTCOMES = NOTICE_EDGE_CACHE_OUTCOMES;

/**
 * Shape sibling for the cache-outcome window. The distribution uses the same
 * length and completeness rules as this group; calendar bounds may differ once
 * the cache dimension's own delivery opens a later window.
 */
export const NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP = "first_byte";

/** Declared window rule: same shape as the sibling group, not the same dates. */
export const NOTICE_READBACK_CACHE_OUTCOME_WINDOW_RULE = "same_shape";

export const NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON =
  "retained_windowed_distribution_unavailable";

/**
 * Delivery that opened collection of the record-cache-outcome RUM dimension.
 * Calendar windows for the distribution begin at or after this anchor.
 */
export const NOTICE_READBACK_CACHE_OUTCOME_DELIVERY = Object.freeze({
  kind: "dimension_collection",
  merged_at: "2026-09-30T18:00:00.000Z",
  merge_commit: null,
  pull_request: null,
  note: "Resident measurement collection began retaining the record subrequest cache outcome as a RUM dimension (alias c7a6b040d3706). The prior unread marker established that Server-Timing alone could not produce a windowed distribution.",
});

/** The three groups the Notice post-delivery letters require, in declaration order. */
export const NOTICE_READBACK_REQUIRED_GROUPS = Object.freeze([
  "cold_module_path",
  "first_byte",
  "synthetic",
]);

export const NOTICE_READBACK_DELIVERIES = Object.freeze({
  cold_module_path: Object.freeze({
    kind: "delivery_merge",
    merged_at: "2026-09-06T19:15:53.000Z",
    merge_commit: "8a2fba61b4192481a8d6b7852f6094b79599dbca",
    pull_request: 1769,
    note: "Cold module path change that opened the readiness read-back.",
  }),
  first_byte: Object.freeze({
    kind: "delivery_merge",
    merged_at: "2026-09-06T20:18:09.000Z",
    merge_commit: "8a43f7e8009818295c7561e04032c0ea17f60892",
    pull_request: 1774,
    note: "Edge response change that opened the first-byte read-back.",
  }),
  synthetic: Object.freeze({
    kind: "first_probe_slot",
    merged_at: "2026-09-08T08:07:00.000Z",
    merge_commit: null,
    pull_request: null,
    note: "First synthetic probe slot that retained an observation.",
  }),
});

export const NOTICE_READBACK_GROUP_SPECS = Object.freeze({
  cold_module_path: Object.freeze({
    measurement_group: "cold_module_path",
    population: "resident",
    traffic_class: "production",
    rum_group: "resident",
    metrics: Object.freeze([
      Object.freeze({
        metric_id: "component_ready_ms",
        surface_id: "notice",
        component_id: "notice-context",
      }),
      Object.freeze({
        metric_id: "content_ready_ms",
        surface_id: "notice",
        component_id: "none",
      }),
    ]),
  }),
  first_byte: Object.freeze({
    measurement_group: "first_byte",
    population: "resident",
    traffic_class: "production",
    rum_group: "resident",
    metrics: Object.freeze([
      Object.freeze({
        metric_id: "ttfb_ms",
        surface_id: "notice",
        component_id: "none",
      }),
      Object.freeze({
        metric_id: "ttfb_ms",
        surface_id: "home",
        component_id: "none",
        role: "same_window_comparison",
      }),
    ]),
  }),
  synthetic: Object.freeze({
    measurement_group: "synthetic",
    population: "synthetic",
    traffic_class: "synthetic",
    rum_group: "synthetic",
    metrics: Object.freeze([
      Object.freeze({
        metric_id: "content_ready_ms",
        surface_id: "notice",
        component_id: "none",
      }),
      Object.freeze({
        metric_id: "component_ready_ms",
        surface_id: "notice",
        component_id: "notice-context",
      }),
    ]),
  }),
});

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isoOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function roundMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function refusal(reason, details = {}) {
  return { reason, ...details };
}

function metricKey(metric) {
  return `${metric.metric_id}/${metric.surface_id}/${metric.component_id || "none"}`;
}

/** Zero-filled outcome counts. A read that found nothing uses these zeros. */
export function emptyRecordCacheOutcomeCounts() {
  const outcomes = {};
  for (const name of NOTICE_READBACK_CACHE_OUTCOMES) outcomes[name] = 0;
  return outcomes;
}

function normalizeOutcomeCounts(raw) {
  const outcomes = emptyRecordCacheOutcomeCounts();
  if (!isRecord(raw)) return { outcomes, sampled_count: 0, ok: false };
  let sampled = 0;
  let ok = true;
  for (const name of NOTICE_READBACK_CACHE_OUTCOMES) {
    const value = raw[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      ok = false;
      outcomes[name] = 0;
      continue;
    }
    outcomes[name] = value;
    sampled += value;
  }
  for (const key of Object.keys(raw)) {
    if (!NOTICE_READBACK_CACHE_OUTCOMES.includes(key)) ok = false;
  }
  return { outcomes, sampled_count: sampled, ok };
}

function projectCacheWindow(window, delivery) {
  const deliveryAt = isoOrNull(delivery?.at) || NOTICE_READBACK_CACHE_OUTCOME_DELIVERY.merged_at;
  const start = isoOrNull(window?.requested_start);
  const beginsAfter = window?.begins_at_or_after_delivery === true
    || window?.begins_at_or_after_anchor === true
    || window?.post_dates_delivery === true
    || (start != null && Date.parse(start) >= Date.parse(deliveryAt));
  return {
    requested_start: start,
    requested_end: isoOrNull(window?.requested_end),
    status: window?.complete === true || window?.status === "complete" ? "complete" : "incomplete",
    complete: window?.complete === true || window?.status === "complete",
    keyed_to_measurement_group: NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP,
    window_rule: NOTICE_READBACK_CACHE_OUTCOME_WINDOW_RULE,
    begins_at_or_after_delivery: beginsAfter,
    post_dates_delivery: beginsAfter,
  };
}

function projectCacheDelivery(delivery) {
  const fallback = NOTICE_READBACK_CACHE_OUTCOME_DELIVERY;
  return {
    kind: delivery?.kind || fallback.kind,
    at: isoOrNull(delivery?.at) || fallback.merged_at,
    merge_commit: delivery?.merge_commit ?? fallback.merge_commit,
    pull_request: delivery?.pull_request ?? fallback.pull_request,
    note: delivery?.note || fallback.note,
  };
}

/**
 * A distribution that was read. Empty is allowed: every outcome may be zero.
 * That is a measurement, distinct from unread.
 */
export function buildReadRecordCacheOutcomeDistribution({
  outcomes = null,
  window = null,
  delivery = null,
  queriedAt = null,
  source = null,
} = {}) {
  const normalized = normalizeOutcomeCounts(outcomes ?? emptyRecordCacheOutcomeCounts());
  return {
    state: "read",
    window: projectCacheWindow(window, delivery),
    delivery: projectCacheDelivery(delivery),
    queried_at: isoOrNull(queriedAt),
    outcomes: normalized.outcomes,
    sampled_count: normalized.sampled_count,
    source: isRecord(source) ? source : {
      response_header: "Server-Timing",
      metric: "cs-record",
      closed_outcomes: [...NOTICE_READBACK_CACHE_OUTCOMES],
      retained_query_path: "blob14/record_cache_outcome",
      dimension: "record_cache_outcome",
    },
  };
}

/**
 * A distribution that could not be read. Carries the word `unread` and a reason.
 * Never omit this object in favor of an absent field.
 */
export function buildUnreadRecordCacheOutcomeDistribution({
  reason = NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON,
  detail = null,
  window = null,
  delivery = null,
  queriedAt = null,
  source = null,
} = {}) {
  return {
    state: "unread",
    reason: String(reason || NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON),
    ...(detail ? { detail: String(detail) } : {}),
    window: projectCacheWindow(window, delivery),
    delivery: projectCacheDelivery(delivery),
    queried_at: isoOrNull(queriedAt),
    source: isRecord(source) ? source : {
      response_header: "Server-Timing",
      metric: "cs-record",
      closed_outcomes: [...NOTICE_READBACK_CACHE_OUTCOMES],
      retained_query_path: null,
      dimension: "record_cache_outcome",
    },
  };
}

function projectMetricRow(spec, readBack, sampleFloor) {
  const row = Array.isArray(readBack?.groups) ? readBack.groups[0] : null;
  const sampled = Number.isSafeInteger(row?.sampled_count) ? row.sampled_count : 0;
  const window = isRecord(readBack?.window) ? readBack.window : {};
  const windowComplete = window.complete === true || window.status === "complete";
  const beginsAfter = window.begins_at_or_after_anchor === true;
  let sufficiency = "insufficient_sample";
  if (!beginsAfter) sufficiency = "samples_predate_delivery";
  else if (!windowComplete) sufficiency = "window_incomplete";
  else if (sampled >= sampleFloor
    && Number.isFinite(row?.p50_ms)
    && Number.isFinite(row?.p75_ms)
    && Number.isFinite(row?.p95_ms)) {
    sufficiency = "sufficient";
  }
  const publish = sufficiency === "sufficient";
  return {
    metric_id: spec.metric_id,
    surface_id: spec.surface_id,
    component_id: spec.component_id,
    ...(spec.role ? { role: spec.role } : {}),
    sample_floor: sampleFloor,
    sampled_count: sampled,
    estimated_count: Number.isFinite(row?.estimated_count) ? row.estimated_count : null,
    sufficiency,
    p50_ms: publish ? roundMs(row.p50_ms) : null,
    p75_ms: publish ? roundMs(row.p75_ms) : null,
    p95_ms: publish ? roundMs(row.p95_ms) : null,
    p95_tail_support_estimate: publish && sampled > 0
      ? Math.max(1, Math.round(sampled * 0.05))
      : null,
    first_observation_at: isoOrNull(row?.first_observation_at),
    latest_observation_at: isoOrNull(row?.latest_observation_at),
  };
}

function projectGroup(groupName, readsByMetricKey, {
  sampleFloor = NOTICE_READBACK_SAMPLE_FLOOR,
  queriedAt = null,
} = {}) {
  const spec = NOTICE_READBACK_GROUP_SPECS[groupName];
  const delivery = NOTICE_READBACK_DELIVERIES[groupName];
  const metrics = spec.metrics.map((metricSpec) => {
    const readBack = readsByMetricKey.get(metricKey(metricSpec)) || null;
    return projectMetricRow(metricSpec, readBack, sampleFloor);
  });
  const windows = spec.metrics
    .map((metricSpec) => readsByMetricKey.get(metricKey(metricSpec))?.window)
    .filter(isRecord);
  const starts = windows.map((window) => isoOrNull(window.requested_start)).filter(Boolean).sort();
  const ends = windows.map((window) => isoOrNull(window.requested_end)).filter(Boolean).sort();
  const complete = windows.length > 0 && windows.every((window) => (
    window.complete === true || window.status === "complete"
  ));
  const beginsAfter = windows.length > 0 && windows.every((window) => (
    window.begins_at_or_after_anchor === true
  ));
  const clearsFloor = metrics.every((metric) => metric.sampled_count >= sampleFloor);
  return {
    measurement_group: groupName,
    population: spec.population,
    traffic_class: spec.traffic_class,
    rum_measurement_group: spec.rum_group,
    sample_floor: sampleFloor,
    clears_sample_floor: clearsFloor && beginsAfter && complete,
    delivery: {
      kind: delivery.kind,
      at: delivery.merged_at,
      merge_commit: delivery.merge_commit,
      pull_request: delivery.pull_request,
      note: delivery.note,
    },
    window: {
      requested_start: starts[0] || null,
      requested_end: ends[ends.length - 1] || null,
      status: complete ? "complete" : "incomplete",
      complete,
      begins_at_or_after_delivery: beginsAfter,
      post_dates_delivery: beginsAfter,
    },
    queried_at: isoOrNull(queriedAt),
    metrics,
  };
}

/**
 * Build the retained aggregate from labelled single-group read-backs.
 *
 * `reads` is a list of `{ group, metric_id, surface_id, component_id, document }`
 * where `document` is a `cityscroll.rum_measurement_group_read_back.v1` result.
 *
 * `recordCacheOutcomeDistribution` must already be shaped as either a `read`
 * distribution (counts per outcome, zeros allowed) or an `unread` record with
 * that word and a reason. When omitted, the builder records unread for the
 * first-byte window rather than leaving the field absent.
 */
export function buildNoticeReadbackAggregate({
  reads = [],
  productionRevision = null,
  queriedAt = null,
  sampleFloor = NOTICE_READBACK_SAMPLE_FLOOR,
  sourceCommand = "node tools/build_notice_readback_aggregate.mjs",
  recordCacheOutcomeDistribution = null,
} = {}) {
  const byGroup = new Map();
  for (const name of NOTICE_READBACK_REQUIRED_GROUPS) byGroup.set(name, new Map());

  for (const entry of reads) {
    if (!entry || !NOTICE_READBACK_GROUP_SPECS[entry.group]) continue;
    const key = metricKey(entry);
    byGroup.get(entry.group).set(key, entry.document || null);
  }

  const measurementGroups = {};
  for (const name of NOTICE_READBACK_REQUIRED_GROUPS) {
    measurementGroups[name] = projectGroup(name, byGroup.get(name), {
      sampleFloor,
      queriedAt,
    });
  }

  const firstByte = measurementGroups[NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP];
  const cacheDelivery = projectCacheDelivery(NOTICE_READBACK_CACHE_OUTCOME_DELIVERY);
  const cacheDistribution = isRecord(recordCacheOutcomeDistribution)
    ? recordCacheOutcomeDistribution
    : buildUnreadRecordCacheOutcomeDistribution({
      reason: NOTICE_READBACK_CACHE_OUTCOME_UNREAD_REASON,
      detail: "No record-cache-outcome distribution was supplied to the builder.",
      window: firstByte?.window || null,
      delivery: cacheDelivery,
      queriedAt,
    });

  return {
    schema: NOTICE_READBACK_AGGREGATE_SCHEMA,
    version: 2,
    public_alias: "c7a6b040d3706",
    title: "Notice post-delivery read-back aggregate",
    queried_at: isoOrNull(queriedAt) || new Date().toISOString(),
    production_revision: productionRevision || null,
    sample_floor: sampleFloor,
    producer: {
      repository: "cityscroll-app",
      source: "tools/read_rum_drift.mjs",
      builder: "tools/build_notice_readback_aggregate.mjs",
      retained_path: NOTICE_READBACK_RETAINED_PATH,
      command: sourceCommand,
      dataset: "crol_rum_observations_v1",
      notes: [
        "Each measurement group is read on its own query through the shared RUM grammar.",
        "Groups are never combined into one distribution.",
        "The record subrequest cache outcome distribution uses a window of the same shape as the first_byte group (same length and completeness rules) once the cache dimension exists, and is always recorded as read or unread.",
        "Each other measurement group keeps its own calendar window; the distribution opens its own same-shape window after the dimension-collection delivery.",
      ],
    },
    required_groups: [...NOTICE_READBACK_REQUIRED_GROUPS],
    measurement_groups: measurementGroups,
    record_cache_outcome_distribution: cacheDistribution,
  };
}

/**
 * Validate the always-present record-cache-outcome distribution.
 * Distinguishes a read-and-empty distribution from an unread one; refuses a
 * missing field by name so silence cannot pass as a measurement.
 */
export function validateRecordCacheOutcomeDistribution(field, {
  expectedWindow = null,
} = {}) {
  const refusals = [];
  if (!isRecord(field)) {
    return {
      ok: false,
      refusals: [refusal("missing_record_cache_outcome_distribution", {
        detail: "record_cache_outcome_distribution must be present as read or unread",
      })],
    };
  }

  if (field.state === "read") {
    const normalized = normalizeOutcomeCounts(field.outcomes);
    if (!isRecord(field.outcomes)) {
      refusals.push(refusal("missing_record_cache_outcome_counts", {
        detail: "a read distribution must carry outcomes counts for every closed cache outcome",
      }));
    } else if (!normalized.ok) {
      refusals.push(refusal("invalid_record_cache_outcome_counts", {
        detail: "outcomes must name only the closed set with non-negative integer counts",
      }));
    } else if (!Number.isSafeInteger(field.sampled_count) || field.sampled_count !== normalized.sampled_count) {
      refusals.push(refusal("invalid_record_cache_outcome_sampled_count", {
        detail: "sampled_count must equal the sum of outcome counts",
        sampled_count: field.sampled_count,
        expected: normalized.sampled_count,
      }));
    }
    if (field.reason != null) {
      refusals.push(refusal("read_distribution_carries_unread_reason", {
        detail: "a read distribution must not carry an unread reason",
      }));
    }
  } else if (field.state === "unread") {
    if (typeof field.reason !== "string" || !field.reason.trim()) {
      refusals.push(refusal("missing_unread_reason", {
        detail: "an unread distribution must carry a non-empty reason",
      }));
    }
    if (isRecord(field.outcomes)) {
      refusals.push(refusal("unread_distribution_carries_outcome_counts", {
        detail: "an unread distribution must not present outcome counts that could be read as a measurement",
      }));
    }
  } else {
    refusals.push(refusal("invalid_record_cache_outcome_state", {
      detail: "state must be the word read or the word unread",
      state: field.state ?? null,
    }));
  }

  if (!isRecord(field.window)
    || field.window.keyed_to_measurement_group !== NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP) {
    refusals.push(refusal("cache_outcome_window_not_keyed", {
      detail: `window.keyed_to_measurement_group must be ${NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP}`,
    }));
  }
  if (!isRecord(field.window)
    || field.window.window_rule !== NOTICE_READBACK_CACHE_OUTCOME_WINDOW_RULE) {
    refusals.push(refusal("cache_outcome_window_rule_missing", {
      detail: `window.window_rule must be ${NOTICE_READBACK_CACHE_OUTCOME_WINDOW_RULE}`,
    }));
  }

  // Same-shape rule: length and completeness follow the sibling group. Calendar
  // bounds may differ once the cache dimension's own delivery opens a later
  // window, so start/end equality with first_byte is not required.
  void expectedWindow;

  if (!isRecord(field.delivery) || field.delivery.kind !== NOTICE_READBACK_CACHE_OUTCOME_DELIVERY.kind) {
    refusals.push(refusal("cache_outcome_delivery_kind_mismatch", {
      detail: `delivery.kind must be ${NOTICE_READBACK_CACHE_OUTCOME_DELIVERY.kind}`,
      kind: field.delivery?.kind ?? null,
    }));
  }

  return { ok: refusals.length === 0, refusals };
}

/**
 * Validate a retained aggregate. Refusals carry one named reason each so a
 * shepherd can distinguish a thin sample from a missing group from a window
 * that still includes pre-delivery observations, and from a missing or
 * ambiguous record-cache-outcome distribution.
 */
export function validateNoticeReadbackAggregate(document, {
  sampleFloor = NOTICE_READBACK_SAMPLE_FLOOR,
  requireProductionRevision = true,
} = {}) {
  const refusals = [];
  if (!isRecord(document) || document.schema !== NOTICE_READBACK_AGGREGATE_SCHEMA) {
    return {
      ok: false,
      refusals: [refusal("missing_aggregate", {
        detail: "document must declare cityscroll.notice_readback_aggregate.v2",
      })],
    };
  }

  if (requireProductionRevision) {
    const revision = String(document.production_revision || "");
    if (!/^[a-f0-9]{40}$/.test(revision)) {
      refusals.push(refusal("missing_production_revision", {
        detail: "production_revision must be a 40-character commit SHA",
      }));
    }
  }

  const groups = isRecord(document.measurement_groups) ? document.measurement_groups : {};
  for (const name of NOTICE_READBACK_REQUIRED_GROUPS) {
    if (!isRecord(groups[name])) {
      refusals.push(refusal("missing_measurement_group", {
        measurement_group: name,
        detail: `required measurement group ${name} is absent`,
      }));
      continue;
    }
    const group = groups[name];
    const deliveryAt = isoOrNull(group.delivery?.at) || NOTICE_READBACK_DELIVERIES[name].merged_at;
    const deliveryMs = Date.parse(deliveryAt);
    const windowStart = isoOrNull(group.window?.requested_start);
    const metrics = Array.isArray(group.metrics) ? group.metrics : [];
    const expected = NOTICE_READBACK_GROUP_SPECS[name].metrics;

    for (const metricSpec of expected) {
      const found = metrics.find((metric) => (
        metric?.metric_id === metricSpec.metric_id
        && metric?.surface_id === metricSpec.surface_id
        && (metric?.component_id || "none") === metricSpec.component_id
      ));
      if (!found) {
        refusals.push(refusal("missing_measurement_group", {
          measurement_group: name,
          metric_id: metricSpec.metric_id,
          surface_id: metricSpec.surface_id,
          detail: `group ${name} is missing metric ${metricKey(metricSpec)}`,
        }));
        continue;
      }
      const sampled = Number.isSafeInteger(found.sampled_count) ? found.sampled_count : 0;
      if (sampled < sampleFloor) {
        refusals.push(refusal("below_sample_floor", {
          measurement_group: name,
          metric_id: found.metric_id,
          surface_id: found.surface_id,
          sampled_count: sampled,
          sample_floor: sampleFloor,
        }));
      }
      const firstObs = isoOrNull(found.first_observation_at);
      if (windowStart && Date.parse(windowStart) < deliveryMs) {
        refusals.push(refusal("samples_predate_delivery", {
          measurement_group: name,
          metric_id: found.metric_id,
          surface_id: found.surface_id,
          window_start: windowStart,
          delivery_at: deliveryAt,
          detail: "observation window begins before the group's delivery anchor",
        }));
      } else if (firstObs && Date.parse(firstObs) < deliveryMs) {
        refusals.push(refusal("samples_predate_delivery", {
          measurement_group: name,
          metric_id: found.metric_id,
          surface_id: found.surface_id,
          first_observation_at: firstObs,
          delivery_at: deliveryAt,
          detail: "earliest retained observation predates the group's delivery anchor",
        }));
      }
      if (found.sufficiency !== "sufficient"
        && (found.p50_ms != null || found.p75_ms != null || found.p95_ms != null)) {
        refusals.push(refusal("percentiles_without_sufficiency", {
          measurement_group: name,
          metric_id: found.metric_id,
          surface_id: found.surface_id,
        }));
      }
    }
  }

  // Extra groups are allowed only when labelled; unknown keys are refused so a
  // silent rename cannot satisfy the declaration.
  for (const name of Object.keys(groups)) {
    if (!NOTICE_READBACK_REQUIRED_GROUPS.includes(name)) {
      refusals.push(refusal("unknown_measurement_group", {
        measurement_group: name,
      }));
    }
  }

  if (!Object.prototype.hasOwnProperty.call(document, "record_cache_outcome_distribution")) {
    refusals.push(refusal("missing_record_cache_outcome_distribution", {
      detail: "record_cache_outcome_distribution must be present as read or unread",
    }));
  } else {
    const cacheValidation = validateRecordCacheOutcomeDistribution(
      document.record_cache_outcome_distribution,
      { expectedWindow: groups[NOTICE_READBACK_CACHE_OUTCOME_WINDOW_GROUP]?.window || null },
    );
    refusals.push(...cacheValidation.refusals);
  }

  return { ok: refusals.length === 0, refusals };
}

/** Deep-clone helper used by non-vacuity controls. */
export function cloneNoticeReadbackAggregate(document) {
  return JSON.parse(JSON.stringify(document));
}

/** Remove one required group so a non-vacuity control can prove the validator notices. */
export function withoutMeasurementGroup(document, groupName) {
  const clone = cloneNoticeReadbackAggregate(document);
  if (clone.measurement_groups) delete clone.measurement_groups[groupName];
  if (Array.isArray(clone.required_groups)) {
    clone.required_groups = clone.required_groups.filter((name) => name !== groupName);
  }
  return clone;
}

/** Remove the cache-outcome field so a non-vacuity control can prove the validator notices. */
export function withoutRecordCacheOutcomeDistribution(document) {
  const clone = cloneNoticeReadbackAggregate(document);
  delete clone.record_cache_outcome_distribution;
  return clone;
}
