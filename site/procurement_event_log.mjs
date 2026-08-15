/**
 * Bounded procurement event-log envelope for process-conformance fixtures.
 *
 * The envelope is deliberately presentation-neutral: one case key, one ordered
 * trace, explicit clocks, and source warrants. A missing public event is an
 * evidence-coverage deviation, never a legal-compliance finding.
 */

export const PROCUREMENT_EVENT_LOG_SCHEMA = "cityscroll.procurement_event_log.v1";
export const PROCUREMENT_EVENT_LOG_METHOD = "bounded_expected_trace_replay_v1";

export const PROCUREMENT_EXPECTED_PROCESS = Object.freeze([
  Object.freeze({
    id: "solicitation",
    label: "Solicitation published",
    clock: "publication",
  }),
  Object.freeze({
    id: "bid_deadline",
    label: "Bid deadline",
    clock: "deadline",
  }),
  Object.freeze({
    id: "award",
    label: "Award published",
    clock: "publication",
  }),
  Object.freeze({
    id: "registration",
    label: "Contract registered",
    clock: "registration",
  }),
  Object.freeze({
    id: "payment",
    label: "Payment issued",
    clock: "payment",
  }),
]);

export const PROCUREMENT_DEVIATION_CLASS = Object.freeze({
  CONFORMING: "conforming",
  MISSING_OPEN_DATA: "missing_open_data",
  OUT_OF_ORDER_TRACE: "out_of_order_trace",
});

const ACTIVITY_BY_ID = new Map(PROCUREMENT_EXPECTED_PROCESS.map((stage) => [stage.id, stage]));
const EXPECTED_TRACE = Object.freeze(PROCUREMENT_EXPECTED_PROCESS.map((stage) => stage.id));

const CANONICAL_SOURCE_HOSTS = new Set([
  "a0333-passportpublic.nyc.gov",
  "a856-cityrecord.nyc.gov",
  "data.cityofnewyork.us",
  "www.checkbooknyc.com",
]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function validDay(value) {
  const day = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(parsed) ? day : null;
}

function canonicalSourceHref(value) {
  const href = clean(value);
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" || !CANONICAL_SOURCE_HOSTS.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeSource(source, caseId, activity) {
  const system = clean(source?.system);
  const href = canonicalSourceHref(source?.href);
  if (!system || !href) {
    throw new TypeError(`${caseId}:${activity} requires a canonical source system and HTTPS href`);
  }
  const recordId = clean(source?.record_id);
  return {
    system,
    href,
    record_id: recordId || null,
  };
}

function normalizeEvent(event, caseId, ordinal) {
  const activity = clean(event?.activity);
  const stage = ACTIVITY_BY_ID.get(activity);
  if (!stage) throw new TypeError(`${caseId}: unknown procurement activity ${activity || "(empty)"}`);
  const occurredAt = validDay(event?.occurred_at);
  if (!occurredAt) throw new TypeError(`${caseId}:${activity} requires occurred_at as YYYY-MM-DD`);
  const clock = clean(event?.clock);
  if (clock !== stage.clock) {
    throw new TypeError(`${caseId}:${activity} requires the ${stage.clock} clock`);
  }
  return {
    case_id: caseId,
    activity,
    activity_label: stage.label,
    occurred_at: occurredAt,
    clock,
    source: normalizeSource(event?.source, caseId, activity),
    _ordinal: ordinal,
  };
}

function deviationFor(observedTrace, dataAsOf) {
  const missing = EXPECTED_TRACE.filter((activity) => !observedTrace.includes(activity));
  const ranks = observedTrace.map((activity) => EXPECTED_TRACE.indexOf(activity));
  const outOfOrder = ranks.some((rank, index) => index > 0 && rank < ranks[index - 1]);
  const deviationClass = missing.length
    ? PROCUREMENT_DEVIATION_CLASS.MISSING_OPEN_DATA
    : outOfOrder
      ? PROCUREMENT_DEVIATION_CLASS.OUT_OF_ORDER_TRACE
      : PROCUREMENT_DEVIATION_CLASS.CONFORMING;

  return {
    class: deviationClass,
    missing_activities: missing,
    data_as_of: dataAsOf,
    is_legal_noncompliance: false,
    adjudication: "not_adjudicated",
  };
}

/**
 * Normalize one bounded case and mechanically compare its observed trace with
 * the fixed expected procurement process.
 */
export function buildProcurementEventLogEnvelope(input) {
  const caseId = clean(input?.case_id);
  if (!caseId) throw new TypeError("procurement event log requires case_id");
  const fixtureKind = clean(input?.fixture_kind);
  if (!fixtureKind) throw new TypeError(`${caseId} requires fixture_kind`);
  const dataAsOf = validDay(input?.data_as_of);
  if (!dataAsOf) throw new TypeError(`${caseId} requires data_as_of as YYYY-MM-DD`);

  const events = (Array.isArray(input?.events) ? input.events : [])
    .map((event, ordinal) => normalizeEvent(event, caseId, ordinal))
    .sort((left, right) => (
      left.occurred_at.localeCompare(right.occurred_at) || left._ordinal - right._ordinal
    ))
    .map(({ _ordinal, ...event }) => event);
  const observedTrace = events.map((event) => event.activity);

  return {
    schema: PROCUREMENT_EVENT_LOG_SCHEMA,
    method: PROCUREMENT_EVENT_LOG_METHOD,
    case_id: caseId,
    fixture_kind: fixtureKind,
    data_as_of: dataAsOf,
    expected_process: {
      id: "nyc_procurement_lifecycle_v1",
      stages: PROCUREMENT_EXPECTED_PROCESS.map((stage) => ({ ...stage })),
      trace: [...EXPECTED_TRACE],
    },
    event_log: events,
    observed_trace: observedTrace,
    deviation: deviationFor(observedTrace, dataAsOf),
  };
}
