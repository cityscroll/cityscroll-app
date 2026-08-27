import { createCalendarOccurrence } from "./calendar_occurrence.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DISTRICT = /^(?:[1-9]|[1-4]\d|5[01])$/;
const COMMUNITY_DISTRICT = /^(?:M|X|K|Q|R)\d{2}$/i;
const LOW_CONFIDENCE = new Set(["inferred", "weak", "low", "approximate"]);

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

function values(value) {
  return [...new Set((Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item ?? "").split(/[,;/|\s]+/))
    .map(clean)
    .filter(Boolean))];
}

function communityDistricts(row) {
  return values(row.community_districts || row.communityDistricts || row.community_district)
    .map((value) => value.toUpperCase())
    .filter((value) => COMMUNITY_DISTRICT.test(value));
}

function councilDistricts(row) {
  return values(row.council_districts || row.councilDistricts || row.council_district || row.cc_district)
    .map((value) => value.replace(/^0+(?=\d)/, ""))
    .filter((value) => DISTRICT.test(value));
}

function stableToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "hearing";
}

function projectForHearing(hearing, projectsById) {
  const projectId = clean(hearing?.project_id);
  const project = projectId ? projectsById?.get(projectId.toUpperCase()) : null;
  return project ? { ...project, ...hearing } : { ...(hearing || {}) };
}

function geographyConfidence(row, project) {
  const value = row.geography_confidence || row.place?.confidence || row.affected_area?.confidence
    || project?.geography_confidence || project?.place?.confidence;
  return clean(value)?.toLowerCase() || null;
}

function hasExplicitDistrict(row, project) {
  return communityDistricts(row).length > 0 || councilDistricts(row).length > 0
    || communityDistricts(project || {}).length > 0 || councilDistricts(project || {}).length > 0;
}

function hasOwnDistrict(row) {
  return communityDistricts(row).length > 0 || councilDistricts(row).length > 0;
}

/**
 * Join a hearing to its exact project row and retain the publisher's place fields.
 * A low-confidence inferred place is never promoted to a district calendar item.
 */
export function zoningHearingWithProject(hearing, projects = []) {
  const byId = projects instanceof Map
    ? projects
    : new Map((Array.isArray(projects) ? projects : [])
      .map((project) => [clean(project?.project_id)?.toUpperCase(), project])
      .filter(([id]) => id));
  const project = byId.get(clean(hearing?.project_id)?.toUpperCase()) || null;
  const joined = projectForHearing(hearing, byId);
  const confidence = geographyConfidence(hearing, project);
  const hearingHasDistrict = hasOwnDistrict(hearing);
  const projectHasDistrict = hasOwnDistrict(project || {});
  const confidenceIsLow = LOW_CONFIDENCE.has(confidence || "");
  return {
    ...joined,
    project_id: clean(joined.project_id),
    project_name: clean(joined.project_name),
    community_districts: communityDistricts(joined),
    council_districts: councilDistricts(joined),
    geography_confidence: confidence,
    geography_basis: hasExplicitDistrict(hearing, project) ? "published_project_district" : null,
    _geography_eligible: !confidenceIsLow || (!hearingHasDistrict && projectHasDistrict && !LOW_CONFIDENCE.has(
      clean(project?.geography_confidence || project?.place?.confidence)?.toLowerCase() || "",
    )),
  };
}

export function zoningHearingMatchesFilter(row, filter = {}) {
  const community = clean(filter.communityDistrict)?.toUpperCase();
  const council = clean(filter.councilDistrict)?.replace(/^0+(?=\d)/, "");
  const borough = clean(filter.boro || filter.borough)?.toLowerCase();
  const attendance = clean(filter.attendance);
  const keywords = (Array.isArray(filter.keywords) ? filter.keywords : [filter.keywords])
    .map(clean).filter(Boolean).map((value) => value.toLowerCase());
  if (!row?._geography_eligible) return false;
  if (borough && clean(row.borough)?.toLowerCase() !== borough) return false;
  if (community && !row.community_districts.includes(community)) return false;
  if (council && !row.council_districts.includes(council)) return false;
  if (keywords.length) {
    const corpus = [row.project_name, row.project_id, row.milestone_title, row.representing, row.venue_address]
      .map(clean).filter(Boolean).join(" ").toLowerCase();
    if (keywords.some((keyword) => !corpus.includes(keyword))) return false;
  }
  if (attendance) {
    const modes = new Set(Array.isArray(row.attendance_modes) ? row.attendance_modes : []);
    if (attendance === "in_person" && !modes.has("in_person") && !clean(row.venue_address)) return false;
    if (attendance === "livestream" && !modes.has("livestream") && !clean(row.livestream_url)) return false;
    if (attendance === "hybrid" && !(modes.has("in_person") && modes.has("livestream"))
      && !(clean(row.venue_address) && clean(row.livestream_url))) return false;
  }
  return true;
}

function hearingKey(row) {
  const sourceKey = row.milestone_id || row.disposition_id || row.hearing_id || row.publisher_identifier;
  if (sourceKey) return `${clean(row.project_id)?.toUpperCase() || "unknown"}:${stableToken(sourceKey)}`;
  return `${clean(row.project_id)?.toUpperCase() || "unknown"}:${stableToken(row.event_class || row.representing || "hearing")}`;
}

function localStartsAt(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)) return raw;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function hearingWhen(row) {
  const day = clean(row.hearing_date || row.hearing_at)?.slice(0, 10);
  if (!ISO_DATE.test(day || "")) return null;
  if (row.parse_status !== "published_date_only" && row.hearing_at && /T\d{2}:\d{2}/.test(String(row.hearing_at))) {
    const startsAt = localStartsAt(row.hearing_at);
    if (startsAt) return { starts_at: startsAt, timezone: "America/New_York" };
  }
  return { date: day };
}

/** Convert one accepted upcoming-land-hearings row into the Cal-5 occurrence. */
export function zoningHearingCalendarOccurrence(row, { scope_ref = "land:hearings" } = {}) {
  const when = hearingWhen(row);
  const projectId = clean(row?.project_id);
  if (!when || !projectId || row?._geography_eligible === false) return null;
  const title = clean(row.project_name) || projectId;
  const location = clean(row.venue_address || row.hearing_location_raw)
    || (row.livestream_url ? `Online — ${row.livestream_url}` : null);
  const canonicalUrl = clean(row.portal_url)
    || `https://cityscroll.org/browse/zoning/#land/${encodeURIComponent(projectId)}`;
  return createCalendarOccurrence({
    uid: `land-hearing:${stableToken(hearingKey(row))}`,
    scope_ref,
    object_ref: `project:${projectId}`,
    kind: "event",
    title: `Public hearing — ${title}`,
    ...when,
    location,
    description: [row.representing, row.milestone_title, row.livestream_url ? `Join online: ${row.livestream_url}` : null]
      .filter(Boolean).join(" · "),
    canonical_url: canonicalUrl,
    source: {
      system: clean(row.source) || "land-upcoming-hearings",
      record_id: clean(row.milestone_id || row.disposition_id || row.project_id),
      ...(clean(row.portal_url) ? { url: row.portal_url } : {}),
    },
    provenance: row.provenance || null,
    observed_at: row.observed_at || row.source_receipt?.observed_at || null,
  });
}

/**
 * Produce the same exact district-filtered rows for Browse, Following, and ICS.
 * Duplicate source rows for one hearing collapse by source identity, so a date change
 * updates one occurrence instead of creating a second meeting.
 */
export function zoningHearingRowsForScope(hearings = [], projects = [], filter = {}, { today, closingWeek = false } = {}) {
  const floor = clean(today)?.slice(0, 10) || new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(`${floor}T00:00:00Z`);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  const through = weekEnd.toISOString().slice(0, 10);
  const byIdentity = new Map();
  for (const hearing of Array.isArray(hearings) ? hearings : []) {
    const row = zoningHearingWithProject(hearing, projects);
    const day = clean(row.hearing_date || row.hearing_at)?.slice(0, 10);
    if (!day || day < floor || (closingWeek && day > through) || !zoningHearingMatchesFilter(row, filter)) continue;
    const key = hearingKey(row);
    const previous = byIdentity.get(key);
    if (!previous || String(row.updated_at || row.observed_at || "") >= String(previous.updated_at || previous.observed_at || "")) {
      byIdentity.set(key, row);
    }
  }
  return [...byIdentity.values()].sort((a, b) => String(a.hearing_at || a.hearing_date).localeCompare(String(b.hearing_at || b.hearing_date)));
}

export function zoningHearingOccurrencesForScope(hearings, projects, filter, options = {}) {
  const scopeRef = filter?.councilDistrict
    ? `council-district:${filter.councilDistrict}`
    : filter?.communityDistrict
      ? `community-district:${filter.communityDistrict}`
      : "land:hearings";
  return zoningHearingRowsForScope(hearings, projects, filter, options)
    .map((row) => zoningHearingCalendarOccurrence(row, { scope_ref: scopeRef }))
    .filter(Boolean);
}
