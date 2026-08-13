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
  matter_title_place: "meeting title location",
  venue_line: "meeting address",
  the_geom: "map boundary",
  boundary_vintage: "boundary date",
  source_record_id: "source record",
  source_fields: "source fields",
  join_method: "matching method",
  source_system: "source",
  warehouse: "Warehouse materialization",
  socrata: "NYC Open Data",
  legistar: "NYC Council Legistar",
  passport: "PASSPort Public",
  checkbook: "Checkbook NYC",
  enacted_local_law: "Enacted local law",
});

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
