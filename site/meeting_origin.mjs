/**
 * Publisher provenance for meeting-shaped records.
 *
 * Geography and publisher identity are separate facts: a City Record notice can
 * be placed in a community-board district without being an official board event.
 */

export const MEETING_ORIGINS = Object.freeze([
  "city_record_notice",
  "official_community_board_calendar",
  "official_minutes_joined",
  "community_board_source_observed",
  "unknown",
]);

export const MEETING_ORIGIN_LABELS = Object.freeze({
  city_record_notice: "City Record notice",
  official_community_board_calendar: "Official community board calendar",
  official_minutes_joined: "Official minutes joined",
  community_board_source_observed: "Community board source observed",
  unknown: "Meeting source unknown",
});

export const CITY_RECORD_NOTICE_URL = "https://a856-cityrecord.nyc.gov/RequestDetail/";

export function isMeetingOrigin(value) {
  return MEETING_ORIGINS.includes(String(value || ""));
}

/**
 * Normalize an origin without inferring one from agency, address, borough, or title.
 * Existing rows explicitly sourced from City Record retain the honest default;
 * everything else remains unknown until a future exact join supplies the origin.
 */
export function normalizeMeetingOrigin(row = {}) {
  const explicit = String(row.meeting_origin || row.origin || "").trim();
  if (isMeetingOrigin(explicit)) return explicit;
  if (String(row.source_system || row.source?.system || "").trim().toLowerCase() === "city_record") {
    return "city_record_notice";
  }
  return "unknown";
}

export function meetingOriginLabel(value) {
  return MEETING_ORIGIN_LABELS[isMeetingOrigin(value) ? value : "unknown"];
}

export function meetingSourceUrl(row = {}, origin = normalizeMeetingOrigin(row)) {
  const supplied = String(row.source_url || row.source?.url || "").trim();
  if (supplied) return supplied;
  if (origin === "city_record_notice" && row.request_id) {
    return `${CITY_RECORD_NOTICE_URL}${encodeURIComponent(String(row.request_id))}`;
  }
  return null;
}
