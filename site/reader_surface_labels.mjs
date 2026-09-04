/**
 * Shared reader vocabulary for values that cross from read models into copy.
 *
 * Producers may keep their stable schema names in data attributes and payloads;
 * resident-facing renderers use this narrow waist for visible labels.
 */

export const READER_LABELS = Object.freeze({
  certified_to_agency: "certified to the agency",
  city_record: "City Record",
  issued_rule: "issued rule",
  votes_on: "voted on",
  notice_90: "90-day notice",
  notice_60: "60-day notice",
  notice_30: "30-day notice",
  notice_10: "10-day notice",
  boro_cd: "borough and community district",
  coundist: "Council District",
  cd_centroid_council: "Council District center",
  cd_intersects_council: "overlapping Council District",
  publisher_district: "publisher community district",
  matter_title_place: "meeting title location",
  venue_line: "meeting address",
  the_geom: "map boundary",
  boundary_vintage: "boundary date",
  source_record_id: "source record",
  source_fields: "source fields",
  join_method: "matching method",
  source_system: "source",
  warehouse: "Warehouse records",
  socrata: "NYC Open Data",
  legistar: "NYC Council Legistar",
  passport: "PASSPort Public",
  checkbook: "Checkbook NYC",
  enacted_local_law: "Enacted local law",
});

/**
 * Rule-history provenance fields that may appear beside a source label. Only these
 * exact identifiers have resident-facing copy; any other field name stays in the
 * event model (and machine-readable attributes) and is omitted from visible text
 * rather than mechanically humanized, so future schema names cannot leak as copy.
 */
export const READER_SOURCE_FIELD_LABELS = Object.freeze({
  pubDate: "publication date",
  "city_record.event_date": "event date",
  hearing_date_1: "hearing date",
  comment_by_date: "comment deadline",
  "city_record.notice_date": "notice publication date",
});

/** Readable label for a rule-history source field, or null when none is approved. */
export function sourceFieldLabel(field) {
  const raw = clean(field);
  if (!raw) return null;
  return READER_SOURCE_FIELD_LABELS[raw] || null;
}

const DEBUG_VALUE = /^(?:unavailable|not available)$/i;

function clean(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** Return a plain label while retaining ordinary human-authored copy. */
export function readerLabel(value, fallback = null) {
  const raw = clean(value);
  if (!raw) return fallback;
  const exact = READER_LABELS[raw] || READER_LABELS[raw.toLowerCase()];
  if (exact) return exact;
  return raw.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi, (token) => {
    const mapped = READER_LABELS[token] || READER_LABELS[token.toLowerCase()];
    return mapped || token.replaceAll("_", " ");
  });
}

/** Remove debug sentinels from optional provenance values. */
export function readerValue(value) {
  if (Array.isArray(value)) {
    const values = value.map(clean).filter((item) => item && !DEBUG_VALUE.test(item));
    return values.length ? values : null;
  }
  const normalized = clean(value);
  return normalized && !DEBUG_VALUE.test(normalized) ? normalized : null;
}

export function isReaderMissing(value) {
  return readerValue(value) == null;
}
