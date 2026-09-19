/**
 * Evidence-preserving temporal projection for meeting producers.
 *
 * A meeting's source fields remain untouched. `schedule` is the narrow,
 * typed boundary consumed by calendar and availability code: a date-only
 * value never becomes a midnight timestamp, and disagreeing official clock
 * observations never resolve by parser order.
 */

export const MEETING_SCHEDULE_SCHEMA = "cityscroll.meeting_schedule.v1";
export const MEETING_SCHEDULE_STATUSES = Object.freeze([
  "resolved",
  "date_only",
  "conflicted",
  "invalid",
]);
export const MEETING_SCHEDULE_PRECISIONS = Object.freeze([
  "exact_time",
  "date_only",
]);
export const MEETING_SCHEDULE_BASES = Object.freeze([
  "publisher_field",
  "publisher_event",
  "publisher_document",
  "published_recurrence",
  "typical_recurrence",
]);

export const DEFAULT_MEETING_TIMEZONE = "America/New_York";

const MEETING_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MEETING_ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const MEETING_CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i;
const MEETING_US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function text(value) {
  const result = String(value ?? "").trim();
  return result || null;
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function validIsoDate(value) {
  const candidate = text(value);
  if (!candidate) return null;
  const iso = candidate.match(MEETING_ISO_DATE);
  const normalized = iso
    ? candidate
    : candidate.match(MEETING_US_DATE)
      ? `${candidate.match(MEETING_US_DATE)[3]}-${candidate.match(MEETING_US_DATE)[1].padStart(2, "0")}-${candidate.match(MEETING_US_DATE)[2].padStart(2, "0")}`
      : null;
  if (!normalized) return null;
  const [, year, month, day] = normalized.match(MEETING_ISO_DATE);
  const date = new Date(`${normalized}T00:00:00Z`);
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day)
    ? normalized
    : null;
}

function validDateTime(value) {
  const candidate = text(value);
  if (!candidate) return null;
  const match = candidate.match(MEETING_ISO_DATE_TIME);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", offset] = match;
  const numeric = [year, month, day, hour, minute, second].map(Number);
  if (numeric[3] > 23 || numeric[4] > 59 || numeric[5] > 59) return null;
  if (offset === "Z" || offset) {
    const parsed = new Date(candidate.replace(" ", "T")).getTime();
    if (!Number.isFinite(parsed)) return null;
  }
  const date = validIsoDate(`${year}-${month}-${day}`);
  if (!date) return null;
  const normalized = `${date}T${hour}:${minute}:${second}`;
  return offset ? `${normalized}${offset === "Z" ? "Z" : offset}` : normalized;
}

function normalizeClock(value) {
  const candidate = text(value);
  if (!candidate) return null;
  const match = candidate.match(MEETING_CLOCK);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || "00");
  const suffix = String(match[4] || "").toUpperCase();
  if (suffix && hour > 12) return null;
  if (suffix === "AM" && hour === 12) hour = 0;
  if (suffix === "PM" && hour < 12) hour += 12;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function datePart(value) {
  const dateTime = validDateTime(value);
  if (dateTime) return dateTime.slice(0, 10);
  return validIsoDate(value);
}

function safeUrl(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function receiptFor(row) {
  return object(row.source_receipt)
    || object(row.observed_receipt)
    || object(row.source_provenance?.observed_receipt)
    || object(row.schedule?.source_receipt)
    || null;
}

function sourceUrlFor(row) {
  return safeUrl(row.schedule?.source_url
    || row.source_url
    || row.record_url
    || row.source?.url
    || row.official_source_url
    || receiptFor(row)?.source_url);
}

function observedAtFor(row) {
  return text(row.schedule?.observed_at
    || row.observed_at
    || receiptFor(row)?.observed_at);
}

function timezoneFor(row) {
  return text(row.schedule?.timezone || row.timezone || row.time_zone)
    || DEFAULT_MEETING_TIMEZONE;
}

function basisFor(value, fallback = "publisher_field") {
  const candidate = text(value) || fallback;
  return MEETING_SCHEDULE_BASES.includes(candidate) ? candidate : null;
}

function sourceFieldsFor(row) {
  const schedule = object(row.schedule);
  const date = text(schedule?.raw_date)
    || text(row.raw_date)
    || text(row.EventDate)
    || text(row.event_date)
    || text(row.date)
    || text(row.meeting_date)
    || text(row.start_date);
  const time = text(schedule?.raw_time)
    || text(row.raw_time)
    || text(row.EventTime)
    || text(row.event_time)
    || text(row.time)
    || text(row.start_time)
    || text(row.start_at);
  return { date, time };
}

function candidateFromValues(values, metadata = {}) {
  const rawDate = text(values.raw_date);
  const rawTime = text(values.raw_time);
  const explicitDateTime = validDateTime(values.starts_at);
  const dateTime = explicitDateTime
    || validDateTime(rawDate)
    || (!rawDate ? validDateTime(rawTime) : null);
  if (dateTime) {
    return {
      starts_at: dateTime,
      raw_date: dateTime.slice(0, 10),
      raw_time: validDateTime(rawTime) ? rawTime.slice(11, 19) : (rawTime || dateTime.slice(11, 19)),
      ...metadata,
    };
  }
  const date = datePart(rawDate);
  if (!date) {
    return rawDate || rawTime
      ? { invalid: true, raw_date: rawDate, raw_time: rawTime, ...metadata }
      : null;
  }
  if (!rawTime) {
    return { date_only: true, raw_date: rawDate || date, raw_time: null, ...metadata };
  }
  const clock = normalizeClock(rawTime)
    || (validDateTime(rawTime) ? validDateTime(rawTime).slice(11, 19) : null);
  if (!clock) return { invalid: true, raw_date: rawDate, raw_time: rawTime, ...metadata };
  return {
    starts_at: `${date}T${clock}`,
    raw_date: rawDate || date,
    raw_time: rawTime,
    ...metadata,
  };
}

function primaryCandidate(row) {
  const schedule = object(row.schedule);
  if (schedule?.starts_at || schedule?.raw_date || schedule?.raw_time) {
    return candidateFromValues({
      starts_at: schedule.starts_at,
      raw_date: schedule.raw_date,
      raw_time: schedule.raw_time,
    }, {
      basis: basisFor(schedule.basis),
      source_url: sourceUrlFor(row),
      observed_at: observedAtFor(row),
    });
  }
  const startsAt = text(row.starts_at || row.start_at || row.wall_time);
  const fields = sourceFieldsFor(row);
  const startsAtIsDateOnly = validIsoDate(startsAt);
  return candidateFromValues({
    starts_at: validDateTime(startsAt) ? startsAt : (validDateTime(fields.date) ? fields.date : null),
    raw_date: startsAtIsDateOnly ? startsAt : fields.date,
    raw_time: startsAtIsDateOnly ? null : fields.time,
  }, {
    basis: basisFor(row.temporal_basis || row.schedule_basis || row.basis),
    source_url: sourceUrlFor(row),
    observed_at: observedAtFor(row),
  });
}

function suppliedObservations(row) {
  const schedule = object(row.schedule);
  const observations = row.temporal_observations
    || row.schedule_observations
    || schedule?.observations
    || schedule?.raw_values
    || row.conflicting_records;
  if (!Array.isArray(observations)) return [];
  return observations.map((observation) => {
    const item = object(observation) || {};
    const fields = sourceFieldsFor(item);
    return candidateFromValues({
      starts_at: item.starts_at || item.start_at || item.wall_time,
      raw_date: item.raw_date || fields.date,
      raw_time: item.raw_time || fields.time,
    }, {
      basis: basisFor(item.basis || item.temporal_basis || item.schedule_basis),
      source_url: safeUrl(item.source_url || item.record_url || item.official_source_url),
      observed_at: text(item.observed_at || item.source_receipt?.observed_at || item.observed_receipt?.observed_at),
    });
  }).filter(Boolean);
}

function observationView(candidate, row, fallback = {}) {
  return {
    starts_at: candidate.starts_at || null,
    raw_date: candidate.raw_date || null,
    raw_time: candidate.raw_time || null,
    basis: candidate.basis || fallback.basis || "publisher_field",
    source_url: candidate.source_url || fallback.source_url || sourceUrlFor(row),
    observed_at: candidate.observed_at || fallback.observed_at || observedAtFor(row),
  };
}

/**
 * Project one producer row into the shared schedule contract.
 *
 * The function is deliberately pure and does not alter any source field.
 * `temporal_observations`/`schedule_observations` may carry corroborating or
 * disagreeing official observations; disagreement is retained and unresolved.
 */
export function projectMeetingSchedule(row = {}) {
  row = object(row) || {};
  const supplied = object(row.schedule);
  const primary = primaryCandidate(row);
  const observations = suppliedObservations(row);
  const all = [primary, ...observations].filter(Boolean);
  const exact = all.filter((candidate) => candidate.starts_at);
  const distinctStarts = [...new Set(exact.map((candidate) => candidate.starts_at))];
  const explicitConflict = supplied?.status === "conflicted" || row.schedule_status === "conflicted";
  const hasInvalid = all.some((candidate) => candidate.invalid);
  const timezone = timezoneFor(row);
  const fallback = {
    basis: basisFor(supplied?.basis || row.temporal_basis || row.schedule_basis || row.basis),
    source_url: sourceUrlFor(row),
    observed_at: observedAtFor(row),
  };
  const first = primary || observations.find((candidate) => candidate.starts_at || candidate.date_only || candidate.invalid);
  const rawDate = first?.raw_date || null;
  const rawTime = first?.raw_time || null;
  const base = {
    schema: MEETING_SCHEDULE_SCHEMA,
    starts_at: null,
    timezone,
    precision: null,
    basis: first?.basis || fallback.basis || "publisher_field",
    source_url: first?.source_url || fallback.source_url,
    observed_at: first?.observed_at || fallback.observed_at,
    raw_date: rawDate,
    raw_time: rawTime,
  };

  if (explicitConflict || distinctStarts.length > 1) {
    return {
      ...base,
      status: "conflicted",
      precision: "exact_time",
      observations: all.map((candidate) => observationView(candidate, row, fallback)),
    };
  }
  if (hasInvalid && !exact.length && !all.some((candidate) => candidate.date_only)) {
    return { ...base, status: "invalid", reason: "invalid_date_or_time" };
  }
  if (exact.length) {
    return {
      ...base,
      status: "resolved",
      starts_at: exact[0].starts_at,
      precision: "exact_time",
      ...(observations.length ? {
        observations: all.map((candidate) => observationView(candidate, row, fallback)),
      } : {}),
    };
  }
  const dateOnly = all.find((candidate) => candidate.date_only);
  if (dateOnly) {
    return {
      ...base,
      status: "date_only",
      raw_date: dateOnly.raw_date,
      raw_time: null,
      precision: "date_only",
    };
  }
  return { ...base, status: "date_only", precision: "date_only" };
}

export function scheduleHasExactTime(schedule) {
  return Boolean(schedule
    && schedule.status === "resolved"
    && schedule.precision === "exact_time"
    && schedule.starts_at);
}

export function validateMeetingSchedule(schedule) {
  const value = object(schedule);
  const errors = [];
  if (!value || value.schema !== MEETING_SCHEDULE_SCHEMA) errors.push("schema");
  if (!MEETING_SCHEDULE_STATUSES.includes(value?.status)) errors.push("status");
  if (value?.precision != null && !MEETING_SCHEDULE_PRECISIONS.includes(value.precision)) errors.push("precision");
  if (!MEETING_SCHEDULE_BASES.includes(value?.basis)) errors.push("basis");
  if (!text(value?.timezone)) errors.push("timezone");
  if (value?.status === "resolved" && !validDateTime(value.starts_at)) errors.push("starts_at");
  if (value?.status !== "resolved" && value?.starts_at != null) errors.push("starts_at_for_non_resolved");
  if (value?.status === "resolved" && !value.source_url && !value.observed_at) errors.push("source_receipt");
  return { ok: errors.length === 0, errors };
}
