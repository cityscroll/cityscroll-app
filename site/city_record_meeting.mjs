/**
 * The City Record notice predicate used by the build-time meeting materialization.
 *
 * A meeting is a dated notice in the public-meetings section, or a dated public
 * hearing published in Agency Rules. This is the same ontology boundary used by
 * the Worker hearings read model; procurement and undated rule notices do not
 * become meeting objects.
 */

const PUBLIC_MEETINGS_SECTION = "public hearings and meetings";
const AGENCY_RULES_SECTION = "agency rules";
const PUBLIC_HEARING_TYPE = "public hearings";

function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function isCityRecordMeeting(row = {}) {
  if (!row || typeof row !== "object" || !String(row.event_date ?? "").trim()) return false;
  const section = normalized(row.section_name || row.section);
  const type = normalized(row.type_of_notice_description || row.notice_type || row.type);
  return section === PUBLIC_MEETINGS_SECTION
    || (section === AGENCY_RULES_SECTION && type === PUBLIC_HEARING_TYPE);
}

export function eligibleCityRecordMeetings(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter(isCityRecordMeeting);
}

export const CITY_RECORD_MEETING_PREDICATE = Object.freeze({
  sections: ["Public Hearings and Meetings", "Agency Rules"],
  agency_rules_type: "Public Hearings",
  requires_event_date: true,
});
