/**
 * Transport and reader projection for source-qualified procurement deadlines.
 *
 * Browser-safe: stays inside site/ so the Pages client module graph can publish
 * every import. Typed resolution still lives in warehouse/lib for adapters; this
 * module reads already-resolved typed_deadlines / due fields and renders them.
 */

import { shortDate } from "./digest_item_awareness.mjs";

export const PROCUREMENT_DEADLINE_PROJECTION_SCHEMA = "cityscroll.procurement_deadline_projection.v1";

export const DEADLINE_PRECISION = Object.freeze({
  DATE_ONLY: "date_only",
  EXACT_TIME: "exact_time",
});

export const DEADLINE_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: "resolved",
  ABSENT: "absent",
  UNRESOLVED_CONFLICT: "unresolved_conflict",
});

export const DEADLINE_SEMANTIC_KIND = Object.freeze({
  RESPONSE_DEADLINE: "response_deadline",
  BID_OPENING: "bid_opening",
  DOCUMENT_AVAILABILITY: "document_availability",
});

export const NYC_PUBLISHER_TIMEZONE = "America/New_York";

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

// Prefix private top-level bindings: classic-script module-dom flatten merges
// parent imports into one scope, and bare ISO_DATE/MONTHS collide with other
// site helpers (#task/can-i-bid readiness fails with "already been declared").
const DEADLINE_PROJECTION_MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});
const DEADLINE_PROJECTION_MONTH_LONG = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);
const DEADLINE_PROJECTION_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DEADLINE_PROJECTION_ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const DEADLINE_PROJECTION_US_DATE_TIME = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i;
const DEADLINE_PROJECTION_ENGLISH_DATE_TIME = /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),\s*(\d{4})(?:\s*(?:at\s+)?(\d{1,2}):(\d{2})\s*(am|pm))?$/i;

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

/** Browser-safe publisher deadline parser (mirrors warehouse parseDeadlineValue). */
export function parseDeadlineValue(raw) {
  const sourceText = text(raw);
  if (!sourceText) return null;

  const isoDt = sourceText.match(DEADLINE_PROJECTION_ISO_DATE_TIME);
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

  const iso = sourceText.match(DEADLINE_PROJECTION_ISO_DATE);
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

  const us = sourceText.match(DEADLINE_PROJECTION_US_DATE_TIME);
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

  const english = sourceText.match(DEADLINE_PROJECTION_ENGLISH_DATE_TIME);
  if (english) {
    const month = DEADLINE_PROJECTION_MONTHS[english[1].toLowerCase()];
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
  const month = DEADLINE_PROJECTION_MONTH_LONG[Number(match[2]) - 1];
  if (!month) return null;
  return `${month} ${Number(match[3])}, ${match[1]}`;
}

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

function chosenFromParsed(parsed, {
  source_system = null,
  source_record_id = null,
  source_url = null,
  observed_at = null,
  publisher_timezone_semantics = null,
} = {}) {
  if (!parsed?.ok) return null;
  const timezone = parsed.precision === DEADLINE_PRECISION.EXACT_TIME
    && (publisher_timezone_semantics === "america_new_york"
      || publisher_timezone_semantics === NYC_PUBLISHER_TIMEZONE)
    ? NYC_PUBLISHER_TIMEZONE
    : null;
  return {
    date: parsed.date,
    wall_time: parsed.wall_time,
    precision: parsed.precision,
    timezone,
    source_text: parsed.source_text,
    source_locator: {
      source_system,
      source_record_id,
      source_url,
    },
    observed_at,
  };
}

function resolutionFromSnapshotFields(snapshot = {}) {
  const due = text(snapshot?.due_date ?? snapshot?.source_values?.due_date);
  const opening = text(snapshot?.opening_date ?? snapshot?.source_values?.opening_date);
  const meta = {
    source_system: text(snapshot?.source_system),
    source_record_id: text(snapshot?.source_record_id || snapshot?.source_system_id),
    source_url: text(snapshot?.official_url || snapshot?.source_receipt?.url),
    observed_at: text(snapshot?.observed_at || snapshot?.retrieved_at),
    publisher_timezone_semantics: text(snapshot?.publisher_timezone_semantics),
  };
  const responseChosen = due ? chosenFromParsed(parseDeadlineValue(due), meta) : null;
  const openingChosen = opening ? chosenFromParsed(parseDeadlineValue(opening), meta) : null;
  return {
    response_deadline: responseChosen
      ? { status: DEADLINE_RESOLUTION_STATUS.RESOLVED, chosen: responseChosen }
      : { status: DEADLINE_RESOLUTION_STATUS.ABSENT, chosen: null },
    bid_opening: openingChosen
      ? { status: DEADLINE_RESOLUTION_STATUS.RESOLVED, chosen: openingChosen }
      : { status: DEADLINE_RESOLUTION_STATUS.ABSENT, chosen: null },
  };
}

export function typedDeadlinesFromSnapshot(snapshot = {}) {
  if (snapshot?.typed_deadlines && typeof snapshot.typed_deadlines === "object") {
    return snapshot.typed_deadlines;
  }
  const due = text(snapshot?.due_date ?? snapshot?.source_values?.due_date);
  const opening = text(snapshot?.opening_date ?? snapshot?.source_values?.opening_date);
  if (!due && !opening) return null;
  return resolutionFromSnapshotFields(snapshot);
}

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
 * Project deadlines from a notice-shaped row.
 * Pass `resolution` when the caller already ran the warehouse typed resolver
 * (for example competing assertions). This module never imports warehouse/.
 */
export function projectDeadlinesFromNoticeRow(row = {}, {
  resolution = null,
  source_url = null,
  publisher_timezone_semantics = "america_new_york",
} = {}) {
  if (resolution && typeof resolution === "object") {
    const response = projectDeadlineKind(resolution, "response");
    return freezeDeep({
      schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
      response_deadline: response,
      bid_opening: projectDeadlineKind(resolution, "bid_opening"),
      due_date: response?.date || null,
    });
  }

  const dueRaw = text(row?.due_date);
  const openingRaw = text(row?.opening_date || row?.bid_opening);
  const requestId = text(row?.request_id);
  const officialUrl = text(source_url)
    || text(row?.official_notice_url)
    || (requestId ? `https://a856-cityrecord.nyc.gov/RequestDetail/${requestId}` : null);
  const meta = {
    source_system: "city_record",
    source_record_id: requestId,
    source_url: officialUrl,
    observed_at: null,
    publisher_timezone_semantics,
  };
  const responseChosen = dueRaw ? chosenFromParsed(parseDeadlineValue(dueRaw), meta) : null;
  const openingChosen = openingRaw ? chosenFromParsed(parseDeadlineValue(openingRaw), meta) : null;
  const synthesized = {
    response_deadline: responseChosen
      ? { status: DEADLINE_RESOLUTION_STATUS.RESOLVED, chosen: responseChosen }
      : { status: DEADLINE_RESOLUTION_STATUS.ABSENT, chosen: null },
    bid_opening: openingChosen
      ? { status: DEADLINE_RESOLUTION_STATUS.RESOLVED, chosen: openingChosen }
      : { status: DEADLINE_RESOLUTION_STATUS.ABSENT, chosen: null },
  };
  const response = projectDeadlineKind(synthesized, "response");
  return freezeDeep({
    schema: PROCUREMENT_DEADLINE_PROJECTION_SCHEMA,
    response_deadline: response,
    bid_opening: projectDeadlineKind(synthesized, "bid_opening"),
    due_date: response?.date || null,
  });
}

export function digestDeadlineFields(projection = {}) {
  const fields = {};
  if (projection?.due_date) fields.due_date = projection.due_date;
  if (projection?.response_deadline) fields.response_deadline = projection.response_deadline;
  if (projection?.bid_opening) fields.bid_opening = projection.bid_opening;
  return fields;
}

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
