/**
 * Typed source-qualified deadline resolution for procurement opportunities.
 *
 * A response deadline, bid opening, and document-availability date are distinct
 * assertions. An opening date never supplies a response deadline. Conflicting
 * current authoritative assertions stay unresolved; an explicit sourced
 * replacement supersedes only its own prior assertion.
 */

export const TYPED_SOURCE_DEADLINE_SCHEMA = "cityscroll.typed_source_deadline.v1";

export const DEADLINE_SEMANTIC_KIND = Object.freeze({
  RESPONSE_DEADLINE: "response_deadline",
  BID_OPENING: "bid_opening",
  DOCUMENT_AVAILABILITY: "document_availability",
});

export const DEADLINE_PRECISION = Object.freeze({
  DATE_ONLY: "date_only",
  EXACT_TIME: "exact_time",
});

export const DEADLINE_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: "resolved",
  ABSENT: "absent",
  UNRESOLVED_CONFLICT: "unresolved_conflict",
  UNRESOLVED_INVALID: "unresolved_invalid",
  UNRESOLVED_UNKNOWN_TIMEZONE: "unresolved_unknown_timezone",
  UNRESOLVED_UNPROVEN_SEMANTICS: "unresolved_unproven_semantics",
  SUPERSEDED: "superseded",
});

export const DEADLINE_EVIDENCE_CLASS = Object.freeze({
  AUTHORITATIVE: "authoritative",
  STALE_CONFLICTING_TEST_EVIDENCE: "stale_conflicting_test_evidence",
  SYNTHETIC_MUTATION: "synthetic_mutation",
  NORMALIZED_ONLY_UNPROVEN: "normalized_only_unproven",
});

export const NYC_PUBLISHER_TIMEZONE = "America/New_York";

const RESPONSE_FIELDS = new Set([
  "due_date",
  "response_due_date",
  "bid_due_date",
  "proposal_deadline",
  "bid_deadline",
  "deadline_date",
]);
const OPENING_FIELDS = new Set([
  "opening_date",
  "bid_opening_date",
  "bid_opening",
  "auction_opening_date",
]);
const AVAILABILITY_FIELDS = new Set([
  "document_availability_date",
  "issue_date",
  "release_date",
]);

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const US_DATE_TIME = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i;
const ENGLISH_DATE_TIME = /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s*(\d{4})(?:\s*(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm))?$/i;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function freezeDeep(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) freezeDeep(entry);
    return Object.freeze(value);
  }
  for (const entry of Object.values(value)) freezeDeep(entry);
  return Object.freeze(value);
}

function validIsoDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const stamp = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const ms = Date.parse(`${stamp}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  const roundTrip = new Date(ms);
  return roundTrip.getUTCFullYear() === y
    && roundTrip.getUTCMonth() + 1 === m
    && roundTrip.getUTCDate() === d
    ? stamp
    : null;
}

function normalizeClock(hourRaw, minuteRaw, secondRaw, suffixRaw) {
  let hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw || 0);
  const suffix = String(suffixRaw || "").toUpperCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === "AM" && hour === 12) hour = 0;
    if (suffix === "PM" && hour < 12) hour += 12;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

/**
 * Parse a publisher deadline string into a typed value envelope.
 * Does not invent timezone. Callers decide NYC resolution separately.
 */
export function parseDeadlineValue(raw) {
  const sourceText = text(raw);
  if (!sourceText) return null;

  const isoDt = sourceText.match(ISO_DATE_TIME);
  if (isoDt) {
    const date = validIsoDate(isoDt[1], isoDt[2], isoDt[3]);
    if (!date) return { ok: false, reason: "invalid_date", source_text: sourceText };
    const clock = `${isoDt[4]}:${isoDt[5]}:${String(isoDt[6] || "00").padStart(2, "0")}`;
    const offset = isoDt[7] || null;
    return {
      ok: true,
      source_text: sourceText,
      date,
      wall_time: clock,
      precision: DEADLINE_PRECISION.EXACT_TIME,
      offset,
      instant: offset ? `${date}T${clock}${offset === "Z" ? "Z" : offset}` : null,
    };
  }

  const iso = sourceText.match(ISO_DATE);
  if (iso) {
    const date = validIsoDate(iso[1], iso[2], iso[3]);
    if (!date) return { ok: false, reason: "invalid_date", source_text: sourceText };
    return {
      ok: true,
      source_text: sourceText,
      date,
      wall_time: null,
      precision: DEADLINE_PRECISION.DATE_ONLY,
      offset: null,
      instant: null,
    };
  }

  const us = sourceText.match(US_DATE_TIME);
  if (us) {
    const date = validIsoDate(us[3], us[1], us[2]);
    if (!date) return { ok: false, reason: "invalid_date", source_text: sourceText };
    if (us[4] == null) {
      return {
        ok: true,
        source_text: sourceText,
        date,
        wall_time: null,
        precision: DEADLINE_PRECISION.DATE_ONLY,
        offset: null,
        instant: null,
      };
    }
    const clock = normalizeClock(us[4], us[5], us[6], us[7]);
    if (!clock) return { ok: false, reason: "invalid_time", source_text: sourceText };
    return {
      ok: true,
      source_text: sourceText,
      date,
      wall_time: clock,
      precision: DEADLINE_PRECISION.EXACT_TIME,
      offset: null,
      instant: null,
    };
  }

  const english = sourceText.match(ENGLISH_DATE_TIME);
  if (english) {
    const month = MONTHS[english[1].toLowerCase()];
    const date = validIsoDate(english[3], month, english[2]);
    if (!date) return { ok: false, reason: "invalid_date", source_text: sourceText };
    if (english[4] == null) {
      return {
        ok: true,
        source_text: sourceText,
        date,
        wall_time: null,
        precision: DEADLINE_PRECISION.DATE_ONLY,
        offset: null,
        instant: null,
      };
    }
    const clock = normalizeClock(english[4], english[5], null, english[6]);
    if (!clock) return { ok: false, reason: "invalid_time", source_text: sourceText };
    return {
      ok: true,
      source_text: sourceText,
      date,
      wall_time: clock,
      precision: DEADLINE_PRECISION.EXACT_TIME,
      offset: null,
      instant: null,
    };
  }

  return { ok: false, reason: "unparseable", source_text: sourceText };
}

export function semanticKindForField(field, explicit = null) {
  const kind = text(explicit);
  if (kind && Object.values(DEADLINE_SEMANTIC_KIND).includes(kind)) return kind;
  const name = text(field);
  if (!name) return null;
  if (RESPONSE_FIELDS.has(name)) return DEADLINE_SEMANTIC_KIND.RESPONSE_DEADLINE;
  if (OPENING_FIELDS.has(name)) return DEADLINE_SEMANTIC_KIND.BID_OPENING;
  if (AVAILABILITY_FIELDS.has(name)) return DEADLINE_SEMANTIC_KIND.DOCUMENT_AVAILABILITY;
  return null;
}

function timezoneForSemantics(semantics, parsed) {
  const mode = text(semantics);
  if (mode === "america_new_york" || mode === NYC_PUBLISHER_TIMEZONE) {
    return { timezone: NYC_PUBLISHER_TIMEZONE, timezone_status: "established" };
  }
  if (parsed?.offset) {
    return { timezone: null, timezone_status: "offset_embedded" };
  }
  if (parsed?.precision === DEADLINE_PRECISION.DATE_ONLY) {
    return { timezone: null, timezone_status: "not_applicable" };
  }
  return { timezone: null, timezone_status: "unknown" };
}

/**
 * Normalize one source-qualified deadline assertion.
 */
export function normalizeDeadlineAssertion(input = {}) {
  const field = text(input.field);
  const semanticKind = semanticKindForField(field, input.semantic_kind);
  const sourceText = text(input.value_raw ?? input.value ?? input.source_text);
  const evidenceClass = text(input.evidence_class) || DEADLINE_EVIDENCE_CLASS.AUTHORITATIVE;
  const assertionId = text(input.assertion_id)
    || [
      text(input.source_locator?.source_system) || "source",
      text(input.source_locator?.source_record_id) || text(input.source_record_id) || "record",
      field || semanticKind || "deadline",
      text(input.source_revision) || text(input.observation_id) || "obs",
    ].join(":");

  const base = {
    schema: TYPED_SOURCE_DEADLINE_SCHEMA,
    assertion_id: assertionId,
    semantic_kind: semanticKind,
    field,
    source_text: sourceText,
    source_locator: freezeDeep({
      source_system: text(input.source_locator?.source_system || input.source_system),
      source_record_id: text(input.source_locator?.source_record_id || input.source_record_id),
      source_url: text(input.source_locator?.source_url || input.source_url || input.url),
      field,
    }),
    source_revision: text(input.source_revision) || null,
    observation_id: text(input.observation_id) || null,
    observed_at: text(input.observed_at) || null,
    evidence_class: evidenceClass,
    supersedes_assertion_id: text(input.supersedes_assertion_id) || null,
    publisher_timezone_semantics: text(input.publisher_timezone_semantics) || null,
    synthetic_mutation: evidenceClass === DEADLINE_EVIDENCE_CLASS.SYNTHETIC_MUTATION
      || input.synthetic_mutation === true,
  };

  if (!semanticKind) {
    return freezeDeep({
      ...base,
      status: DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNPROVEN_SEMANTICS,
      value: null,
      date: null,
      wall_time: null,
      precision: null,
      timezone: null,
      timezone_status: "unknown",
      reason: "unknown_semantic_kind",
    });
  }

  if (evidenceClass === DEADLINE_EVIDENCE_CLASS.NORMALIZED_ONLY_UNPROVEN) {
    return freezeDeep({
      ...base,
      status: DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNPROVEN_SEMANTICS,
      value: null,
      date: null,
      wall_time: null,
      precision: null,
      timezone: null,
      timezone_status: "unknown",
      reason: "normalized_only_unproven",
    });
  }

  if (!sourceText) {
    return freezeDeep({
      ...base,
      status: DEADLINE_RESOLUTION_STATUS.ABSENT,
      value: null,
      date: null,
      wall_time: null,
      precision: null,
      timezone: null,
      timezone_status: "not_applicable",
      reason: "missing_value",
    });
  }

  const parsed = parseDeadlineValue(sourceText);
  if (!parsed?.ok) {
    return freezeDeep({
      ...base,
      status: DEADLINE_RESOLUTION_STATUS.UNRESOLVED_INVALID,
      value: null,
      date: null,
      wall_time: null,
      precision: null,
      timezone: null,
      timezone_status: "unknown",
      reason: parsed?.reason || "invalid_value",
    });
  }

  const tz = timezoneForSemantics(base.publisher_timezone_semantics, parsed);
  if (
    parsed.precision === DEADLINE_PRECISION.EXACT_TIME
    && !parsed.offset
    && tz.timezone_status === "unknown"
  ) {
    return freezeDeep({
      ...base,
      status: DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNKNOWN_TIMEZONE,
      value: parsed.date,
      date: parsed.date,
      wall_time: parsed.wall_time,
      precision: parsed.precision,
      timezone: null,
      timezone_status: "unknown",
      reason: "unknown_timezone",
    });
  }

  const value = parsed.precision === DEADLINE_PRECISION.EXACT_TIME
    ? (parsed.instant || `${parsed.date}T${parsed.wall_time}`)
    : parsed.date;

  return freezeDeep({
    ...base,
    status: DEADLINE_RESOLUTION_STATUS.RESOLVED,
    value,
    date: parsed.date,
    wall_time: parsed.wall_time,
    precision: parsed.precision,
    timezone: tz.timezone,
    timezone_status: tz.timezone_status,
    reason: null,
  });
}

function comparableValue(assertion) {
  if (!assertion || assertion.status !== DEADLINE_RESOLUTION_STATUS.RESOLVED) return null;
  if (assertion.precision === DEADLINE_PRECISION.EXACT_TIME) {
    return `${assertion.date}T${assertion.wall_time || "00:00:00"}`;
  }
  return assertion.date;
}

function isCurrentAuthoritative(assertion) {
  if (!assertion) return false;
  if (assertion.evidence_class === DEADLINE_EVIDENCE_CLASS.STALE_CONFLICTING_TEST_EVIDENCE) {
    return false;
  }
  if (assertion.evidence_class === DEADLINE_EVIDENCE_CLASS.NORMALIZED_ONLY_UNPROVEN) {
    return false;
  }
  return assertion.status === DEADLINE_RESOLUTION_STATUS.RESOLVED
    || assertion.status === DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNKNOWN_TIMEZONE
    || assertion.status === DEADLINE_RESOLUTION_STATUS.UNRESOLVED_INVALID;
}

/**
 * Resolve one semantic kind over source-qualified assertions.
 * Supersession is lineage-local. Competing current authoritative values stay unresolved.
 */
export function resolveTypedSourceDeadlines(rawAssertions = []) {
  const normalized = (Array.isArray(rawAssertions) ? rawAssertions : [])
    .map((row) => normalizeDeadlineAssertion(row))
    .filter(Boolean);

  const byId = new Map(normalized.map((row) => [row.assertion_id, row]));
  const superseded = new Set();
  for (const row of normalized) {
    const prior = text(row.supersedes_assertion_id);
    if (prior && byId.has(prior)) superseded.add(prior);
  }

  const annotated = normalized.map((row) => {
    if (!superseded.has(row.assertion_id)) return row;
    return freezeDeep({
      ...row,
      status: DEADLINE_RESOLUTION_STATUS.SUPERSEDED,
      reason: "superseded_by_later_source_version",
    });
  });

  const kinds = Object.values(DEADLINE_SEMANTIC_KIND);
  const byKind = {};
  for (const kind of kinds) {
    const rows = annotated.filter((row) => row.semantic_kind === kind);
    const current = rows.filter((row) => (
      row.status !== DEADLINE_RESOLUTION_STATUS.SUPERSEDED
      && row.status !== DEADLINE_RESOLUTION_STATUS.ABSENT
      && isCurrentAuthoritative(row)
    ));
    const stale = rows.filter((row) => (
      row.evidence_class === DEADLINE_EVIDENCE_CLASS.STALE_CONFLICTING_TEST_EVIDENCE
    ));

    const resolvedCurrent = current.filter((row) => row.status === DEADLINE_RESOLUTION_STATUS.RESOLVED);
    const distinct = [...new Map(
      resolvedCurrent.map((row) => [comparableValue(row), row]),
    ).values()];

    let chosen = null;
    let status = DEADLINE_RESOLUTION_STATUS.ABSENT;
    let reason = "no_assertion";

    if (distinct.length === 1) {
      chosen = distinct[0];
      status = DEADLINE_RESOLUTION_STATUS.RESOLVED;
      reason = null;
    } else if (distinct.length > 1) {
      status = DEADLINE_RESOLUTION_STATUS.UNRESOLVED_CONFLICT;
      reason = "competing_current_authoritative_assertions";
    } else if (current.some((row) => row.status === DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNKNOWN_TIMEZONE)) {
      status = DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNKNOWN_TIMEZONE;
      reason = "unknown_timezone";
    } else if (current.some((row) => row.status === DEADLINE_RESOLUTION_STATUS.UNRESOLVED_INVALID)) {
      status = DEADLINE_RESOLUTION_STATUS.UNRESOLVED_INVALID;
      reason = "invalid_value";
    } else if (rows.some((row) => row.status === DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNPROVEN_SEMANTICS)) {
      status = DEADLINE_RESOLUTION_STATUS.UNRESOLVED_UNPROVEN_SEMANTICS;
      reason = "unproven_semantics";
    }

    byKind[kind] = freezeDeep({
      semantic_kind: kind,
      status,
      reason,
      chosen,
      candidates: rows,
      current_authoritative: current,
      stale_conflicting_test_evidence: stale,
    });
  }

  return freezeDeep({
    schema: TYPED_SOURCE_DEADLINE_SCHEMA,
    assertions: annotated,
    by_kind: byKind,
    response_deadline: byKind[DEADLINE_SEMANTIC_KIND.RESPONSE_DEADLINE],
    bid_opening: byKind[DEADLINE_SEMANTIC_KIND.BID_OPENING],
    document_availability: byKind[DEADLINE_SEMANTIC_KIND.DOCUMENT_AVAILABILITY],
  });
}

/**
 * Compatibility due_date string for legacy normalized rows: only an explicit
 * resolved response deadline, never an opening or availability date.
 */
export function responseDueDateFromResolution(resolution) {
  const chosen = resolution?.response_deadline?.chosen;
  if (!chosen || chosen.status !== DEADLINE_RESOLUTION_STATUS.RESOLVED) return null;
  return chosen.source_text || chosen.value || null;
}

export function openingDateFromResolution(resolution) {
  const chosen = resolution?.bid_opening?.chosen;
  if (!chosen || chosen.status !== DEADLINE_RESOLUTION_STATUS.RESOLVED) return null;
  return chosen.source_text || chosen.value || null;
}

/**
 * Collect typed assertions from an MTA / Contract Reporter source row.
 * Opening and availability stay separate; due_date is only the explicit field.
 */
export function assertionsFromMtaOpportunitySource({
  source_row = {},
  source_system = null,
  source_record_id = null,
  source_url = null,
  source_revision = null,
  observed_at = null,
  publisher_timezone_semantics = null,
} = {}) {
  const row = source_row && typeof source_row === "object" ? source_row : {};
  const fields = [
    ["due_date", row.due_date, DEADLINE_SEMANTIC_KIND.RESPONSE_DEADLINE],
    ["opening_date", row.opening_date, DEADLINE_SEMANTIC_KIND.BID_OPENING],
    ["document_availability_date", row.document_availability_date, DEADLINE_SEMANTIC_KIND.DOCUMENT_AVAILABILITY],
    ["issue_date", row.issue_date, DEADLINE_SEMANTIC_KIND.DOCUMENT_AVAILABILITY],
  ];
  const assertions = [];
  for (const [field, value, kind] of fields) {
    if (value == null || String(value).trim() === "") continue;
    assertions.push({
      assertion_id: `${source_system || "mta"}:${source_record_id || "row"}:${field}:${String(value).trim()}`,
      field,
      semantic_kind: kind,
      value_raw: value,
      source_system,
      source_record_id,
      source_url,
      source_revision,
      observed_at,
      publisher_timezone_semantics,
      evidence_class: DEADLINE_EVIDENCE_CLASS.AUTHORITATIVE,
    });
  }
  return assertions;
}

/**
 * Build typed deadline resolution for one MTA opportunity fixture/source row.
 */
export function resolveMtaOpportunityDeadlines(fixture = {}) {
  const row = fixture.source_row || {};
  const assertions = assertionsFromMtaOpportunitySource({
    source_row: row,
    source_system: fixture.source_system,
    source_record_id: fixture.source_record_id,
    source_url: fixture.receipt?.url || null,
    source_revision: fixture.receipt?.raw_response_sha256 || fixture.source_record_id || null,
    observed_at: fixture.retrieved_at || fixture.receipt?.retrieved_at || null,
    // Contract Reporter / MTA CD pages publish US calendar dates without an
    // established NYC wall-clock claim on these fields; date-only stays fine.
    publisher_timezone_semantics: null,
  });
  return resolveTypedSourceDeadlines(assertions);
}
