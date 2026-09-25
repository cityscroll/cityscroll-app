/**
 * Transport and reader projection for source-qualified procurement deadlines.
 *
 * Carries the typed deadline contract through digest rows, pursuit snapshots,
 * preview atoms, and email preparation. An opening never becomes a due date.
 * Conflicting current assertions surface as deadline-unconfirmed for action,
 * without adapter diagnostic field names in reader copy.
 */

import {
  DEADLINE_PRECISION,
  DEADLINE_RESOLUTION_STATUS,
  DEADLINE_SEMANTIC_KIND,
  NYC_PUBLISHER_TIMEZONE,
  parseDeadlineValue,
  resolveTypedSourceDeadlines,
} from "../warehouse/lib/typed_source_deadline.mjs";
import { shortDate } from "./digest_item_awareness.mjs";

export const PROCUREMENT_DEADLINE_PROJECTION_SCHEMA = "cityscroll.procurement_deadline_projection.v1";

export const DEADLINE_TRANSPORT_STATUS = Object.freeze({
  RESOLVED: "resolved",
  ABSENT: "absent",
  DEADLINE_UNCONFIRMED: "deadline_unconfirmed",
});

export const DEADLINE_ATOM_STATUS = Object.freeze({
  OBSERVED: "observed",
  NOT_OBSERVED: "not_observed",
  DEADLINE_UNCONFIRMED: "deadline_unconfirmed",
});

const MONTH_LONG = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);

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

function formatWallClock(wallTime) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(wallTime || ""));
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function timezoneAbbreviation(date, wallTime, timezone) {
  if (!timezone || !date) return null;
  try {
    const clock = wallTime || "12:00:00";
    const instant = new Date(`${date}T${clock}`);
    if (!Number.isFinite(instant.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    }).formatToParts(instant);
    return parts.find((part) => part.type === "timeZoneName")?.value || null;
  } catch {
    return null;
  }
}

function longDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) return null;
  const month = MONTH_LONG[Number(match[2]) - 1];
  if (!month) return null;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

/**
 * Reader-facing date label. Date-only values stay dates; timed values include
 * wall clock and timezone when the publisher established one.
 */
export function formatDeadlineReaderLabel({
  date = null,
  wall_time = null,
  precision = null,
  timezone = null,
  source_text = null,
} = {}, { kind = "response" } = {}) {
  if (!date) return null;
  const short = shortDate(date) || date;
  const long = longDate(date) || short;
  let label;
  if (precision === DEADLINE_PRECISION.EXACT_TIME && wall_time) {
    const clock = formatWallClock(wall_time);
    const zone = timezoneAbbreviation(date, wall_time, timezone)
      || (timezone === NYC_PUBLISHER_TIMEZONE ? "ET" : null);
    label = clock
      ? `${long} at ${clock}${zone ? ` ${zone}` : ""}`
      : (source_text || long);
  } else {
    // Date-only values stay compact calendar dates (same shortDate shape the
    // alert atom and pursuit snapshot already used).
    label = short;
  }
  if (kind === "bid_opening") return `Bid opening ${label}`;
  return label;
}

function compactFromChosen(chosen, {
  status = DEADLINE_TRANSPORT_STATUS.RESOLVED,
  source_observation_ref = null,
  kind = "response",
} = {}) {
  if (!chosen || status !== DEADLINE_TRANSPORT_STATUS.RESOLVED) {
    if (status === DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED) {
      return freezeDeep({
        schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
        status: DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED,
        semantic_kind: kind === "bid_opening"
          ? DEADLINE_SEMANTIC_KIND.BID_OPENING
          : DEADLINE_SEMANTIC_KIND.RESPONSE_DEADLINE,
        date: null,
        wall_time: null,
        precision: null,
        timezone: null,
        label: kind === "bid_opening" ? "Bid opening unconfirmed" : "Deadline unconfirmed",
        source_url: null,
        source_system: null,
        source_record_id: null,
        observed_at: null,
        source_observation_ref: source_observation_ref || null,
        source_text: null,
      });
    }
    return null;
  }

  const date = text(chosen.date);
  if (!date) return null;
  const wallTime = text(chosen.wall_time);
  const precision = text(chosen.precision)
    || (wallTime ? DEADLINE_PRECISION.EXACT_TIME : DEADLINE_PRECISION.DATE_ONLY);
  const timezone = text(chosen.timezone);
  const label = formatDeadlineReaderLabel({
    date,
    wall_time: wallTime,
    precision,
    timezone,
    source_text: text(chosen.source_text),
  }, { kind });

  return freezeDeep({
    schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
    status: DEADLINE_TRANSPORT_STATUS.RESOLVED,
    semantic_kind: kind === "bid_opening"
      ? DEADLINE_SEMANTIC_KIND.BID_OPENING
      : DEADLINE_SEMANTIC_KIND.RESPONSE_DEADLINE,
    date,
    wall_time: wallTime,
    precision,
    timezone,
    label,
    source_url: text(chosen.source_locator?.source_url),
    source_system: text(chosen.source_locator?.source_system),
    source_record_id: text(chosen.source_locator?.source_record_id),
    observed_at: text(chosen.observed_at),
    source_observation_ref: source_observation_ref || null,
    source_text: text(chosen.source_text),
  });
}

function kindBucket(resolution, kind) {
  if (!resolution || typeof resolution !== "object") return null;
  if (kind === "bid_opening") return resolution.bid_opening || resolution.by_kind?.bid_opening || null;
  return resolution.response_deadline || resolution.by_kind?.response_deadline || null;
}

/**
 * Project one semantic kind from a typed deadline resolution.
 */
export function projectDeadlineKind(resolution, kind = "response", {
  source_observation_ref = null,
} = {}) {
  const bucket = kindBucket(resolution, kind);
  if (!bucket) return null;
  const status = text(bucket.status);
  if (status === DEADLINE_RESOLUTION_STATUS.UNRESOLVED_CONFLICT) {
    return compactFromChosen(null, {
      status: DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED,
      source_observation_ref,
      kind,
    });
  }
  if (status !== DEADLINE_RESOLUTION_STATUS.RESOLVED || !bucket.chosen) return null;
  return compactFromChosen(bucket.chosen, {
    status: DEADLINE_TRANSPORT_STATUS.RESOLVED,
    source_observation_ref,
    kind,
  });
}

/**
 * Prefer an existing typed_deadlines block on a snapshot; otherwise build one
 * from explicit due/opening fields without inventing missing semantics.
 */
export function typedDeadlinesFromSnapshot(snapshot = {}) {
  if (snapshot?.typed_deadlines && typeof snapshot.typed_deadlines === "object") {
    return snapshot.typed_deadlines;
  }
  const assertions = [];
  const due = text(snapshot?.due_date ?? snapshot?.source_values?.due_date);
  const opening = text(snapshot?.opening_date ?? snapshot?.source_values?.opening_date);
  const sourceSystem = text(snapshot?.source_system);
  const sourceRecordId = text(snapshot?.source_record_id || snapshot?.source_system_id);
  const sourceUrl = text(snapshot?.official_url || snapshot?.source_receipt?.url);
  const observedAt = text(snapshot?.observed_at || snapshot?.retrieved_at);
  if (due) {
    assertions.push({
      assertion_id: `${sourceSystem || "source"}:${sourceRecordId || "record"}:due_date:${due}`,
      field: "due_date",
      semantic_kind: DEADLINE_SEMANTIC_KIND.RESPONSE_DEADLINE,
      value_raw: due,
      source_system: sourceSystem,
      source_record_id: sourceRecordId,
      source_url: sourceUrl,
      observed_at: observedAt,
      publisher_timezone_semantics: text(snapshot?.publisher_timezone_semantics),
      evidence_class: "authoritative",
    });
  }
  if (opening) {
    assertions.push({
      assertion_id: `${sourceSystem || "source"}:${sourceRecordId || "record"}:opening_date:${opening}`,
      field: "opening_date",
      semantic_kind: DEADLINE_SEMANTIC_KIND.BID_OPENING,
      value_raw: opening,
      source_system: sourceSystem,
      source_record_id: sourceRecordId,
      source_url: sourceUrl,
      observed_at: observedAt,
      publisher_timezone_semantics: text(snapshot?.publisher_timezone_semantics),
      evidence_class: "authoritative",
    });
  }
  if (!assertions.length) return null;
  return resolveTypedSourceDeadlines(assertions);
}

/**
 * Project response + opening deadlines from observation snapshots for a
 * procurement object. Never fills due_date from an opening.
 */
export function projectDeadlinesFromSnapshots(snapshots = [], {
  source_observation_refs = null,
} = {}) {
  const rows = Array.isArray(snapshots) ? snapshots.filter((row) => row && typeof row === "object") : [];
  let response = null;
  let opening = null;

  rows.forEach((snapshot, index) => {
    const typed = typedDeadlinesFromSnapshot(snapshot);
    if (!typed) return;
    const ref = Array.isArray(source_observation_refs)
      ? (source_observation_refs[index] || null)
      : null;
    const nextResponse = projectDeadlineKind(typed, "response", { source_observation_ref: ref });
    const nextOpening = projectDeadlineKind(typed, "bid_opening", { source_observation_ref: ref });
    if (!response && nextResponse) response = nextResponse;
    else if (
      response?.status === DEADLINE_TRANSPORT_STATUS.RESOLVED
      && nextResponse?.status === DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED
    ) {
      response = nextResponse;
    } else if (
      response?.status === DEADLINE_TRANSPORT_STATUS.RESOLVED
      && nextResponse?.status === DEADLINE_TRANSPORT_STATUS.RESOLVED
      && (
        response.date !== nextResponse.date
        || response.wall_time !== nextResponse.wall_time
      )
    ) {
      response = compactFromChosen(null, {
        status: DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED,
        kind: "response",
      });
    }
    if (!opening && nextOpening) opening = nextOpening;
  });

  return freezeDeep({
    schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
    response_deadline: response,
    bid_opening: opening,
    due_date: response?.status === DEADLINE_TRANSPORT_STATUS.RESOLVED ? response.date : null,
  });
}

/**
 * Project deadlines from a City Record / PASSPort notice-shaped row.
 */
export function projectDeadlinesFromNoticeRow(row = {}, {
  assertions = null,
  source_url = null,
  publisher_timezone_semantics = "america_new_york",
} = {}) {
  if (Array.isArray(assertions) && assertions.length) {
    const resolution = resolveTypedSourceDeadlines(assertions);
    return freezeDeep({
      schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
      response_deadline: projectDeadlineKind(resolution, "response"),
      bid_opening: projectDeadlineKind(resolution, "bid_opening"),
      due_date: projectDeadlineKind(resolution, "response")?.date || null,
    });
  }

  const dueRaw = text(row?.due_date);
  const openingRaw = text(row?.opening_date || row?.bid_opening);
  const requestId = text(row?.request_id);
  const officialUrl = text(source_url)
    || text(row?.official_notice_url)
    || (requestId ? `https://a856-cityrecord.nyc.gov/RequestDetail/${requestId}` : null);
  const built = [];
  if (dueRaw) {
    built.push({
      assertion_id: `city_record:${requestId || "notice"}:due_date:${dueRaw}`,
      field: "due_date",
      semantic_kind: DEADLINE_SEMANTIC_KIND.RESPONSE_DEADLINE,
      value_raw: dueRaw,
      source_system: "city_record",
      source_record_id: requestId,
      source_url: officialUrl,
      publisher_timezone_semantics,
      evidence_class: "authoritative",
    });
  }
  if (openingRaw) {
    built.push({
      assertion_id: `city_record:${requestId || "notice"}:opening_date:${openingRaw}`,
      field: "opening_date",
      semantic_kind: DEADLINE_SEMANTIC_KIND.BID_OPENING,
      value_raw: openingRaw,
      source_system: "city_record",
      source_record_id: requestId,
      source_url: officialUrl,
      publisher_timezone_semantics,
      evidence_class: "authoritative",
    });
  }
  if (!built.length && dueRaw) {
    const parsed = parseDeadlineValue(dueRaw);
    if (parsed?.ok) {
      const projected = compactFromChosen({
        date: parsed.date,
        wall_time: parsed.wall_time,
        precision: parsed.precision,
        timezone: parsed.precision === DEADLINE_PRECISION.EXACT_TIME ? NYC_PUBLISHER_TIMEZONE : null,
        source_text: parsed.source_text,
        source_locator: {
          source_system: "city_record",
          source_record_id: requestId,
          source_url: officialUrl,
        },
        observed_at: null,
      }, { kind: "response" });
      return freezeDeep({
        schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
        response_deadline: projected,
        bid_opening: null,
        due_date: projected?.date || null,
      });
    }
  }
  if (!built.length) {
    return freezeDeep({
      schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
      response_deadline: null,
      bid_opening: null,
      due_date: null,
    });
  }
  const resolution = resolveTypedSourceDeadlines(built);
  const response = projectDeadlineKind(resolution, "response");
  return freezeDeep({
    schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
    response_deadline: response,
    bid_opening: projectDeadlineKind(resolution, "bid_opening"),
    due_date: response?.date || null,
  });
}

/**
 * Additive digest fields from a projection. Absent deadlines stay absent.
 */
export function digestDeadlineFields(projection = {}) {
  const fields = {};
  if (projection?.due_date) fields.due_date = projection.due_date;
  if (projection?.response_deadline) fields.response_deadline = projection.response_deadline;
  if (projection?.bid_opening) fields.bid_opening = projection.bid_opening;
  return fields;
}

/**
 * Atom deadline part used by preview subjects and pursuit snapshots.
 */
export function atomDeadlineFromProjection(projection = {}) {
  const response = projection?.response_deadline || (
    projection?.status ? projection : null
  );
  if (!response) {
    return { value: null, label: null, status: DEADLINE_ATOM_STATUS.NOT_OBSERVED };
  }
  if (response.status === DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED) {
    return {
      value: null,
      label: response.label || "Deadline unconfirmed",
      status: DEADLINE_ATOM_STATUS.DEADLINE_UNCONFIRMED,
    };
  }
  if (response.status === DEADLINE_TRANSPORT_STATUS.RESOLVED && response.date) {
    return {
      value: response.date,
      label: response.label || shortDate(response.date) || response.date,
      status: DEADLINE_ATOM_STATUS.OBSERVED,
      wall_time: response.wall_time || null,
      precision: response.precision || null,
      timezone: response.timezone || null,
      source_url: response.source_url || null,
    };
  }
  return { value: null, label: null, status: DEADLINE_ATOM_STATUS.NOT_OBSERVED };
}

/**
 * Email / digest meta line fragment. Openings stay labeled as openings.
 */
export function digestDeadlineMetaLabel(row = {}) {
  const response = row?.response_deadline;
  if (response?.status === DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED) {
    return "deadline unconfirmed";
  }
  if (response?.status === DEADLINE_TRANSPORT_STATUS.RESOLVED && response.label) {
    return `due ${response.label}`;
  }
  const opening = row?.bid_opening;
  if (opening?.status === DEADLINE_TRANSPORT_STATUS.RESOLVED && opening.label) {
    return opening.label.startsWith("Bid opening") ? opening.label : `Bid opening ${opening.label}`;
  }
  const due = text(row?.due_date);
  if (!due) return "";
  const year = Number(String(due).slice(0, 4));
  if (Number.isFinite(year) && year >= 2090) return "no fixed deadline (rolling)";
  const day = /^\d{4}-\d{2}-\d{2}/.test(due) ? due.slice(0, 10) : due;
  const label = shortDate(day) || day;
  return `due ${label}`;
}

/**
 * Compatibility due_date for pursuit rows: resolved response date only.
 */
export function pursuitDueDateValue(projection = {}, fallbackDueDate = null) {
  const response = projection?.response_deadline;
  if (response?.status === DEADLINE_TRANSPORT_STATUS.DEADLINE_UNCONFIRMED) return null;
  if (response?.status === DEADLINE_TRANSPORT_STATUS.RESOLVED && response.date) return response.date;
  const fallback = text(fallbackDueDate);
  if (!fallback) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(fallback)) return fallback.slice(0, 10);
  const parsed = parseDeadlineValue(fallback);
  return parsed?.ok ? parsed.date : null;
}
