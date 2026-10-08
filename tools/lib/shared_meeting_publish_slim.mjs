/**
 * Producer publish slim for the shared meeting catalog written into
 * site/data/shared_meeting_read_model.json (and Pages).
 *
 * Full per-row geography stamps are large. The resident UI reads only a subset:
 * - venue text from `venue` / search fields (not venue location_assertions)
 * - Subject property from subject_property location_assertions or
 *   agenda_subject_places (meeting_document.mjs)
 * - exact NTA / district placement from venue and subject_property
 *   location_memberships (Near You / district activity)
 *
 * Host-jurisdiction memberships are rebuilt from board ontology by district
 * activity; stamping them onto every shared row reclassifies board meetings as
 * parcel_membership and blows the Pages headroom budget.
 *
 * Stripped on publish (not displayed from these fields on the catalog):
 * 1. location_assertions where role !== subject_property
 *    (venue receipts/components — redundant with venue.address / venue.name)
 * 2. location_memberships where role is host_jurisdiction (or any role other
 *    than venue / subject_property)
 * 3. membership provenance.source_path and redundant record_id (assertion_id
 *    + row meeting_id already identify the edge; source_path duplicates venue
 *    text and blows the Pages ~18 MiB headroom after neighborhood publication)
 * 4. geography_backfill.input_hash (full hash stays in meeting-geography-backfill
 *    artifacts; the catalog keeps outcome + processed_at only)
 *
 * Retained:
 * - subject_property location_assertions
 * - agenda_subject_places (projected when subject assertions exist)
 * - venue + subject_property location_memberships (including police_precinct)
 * - geography_backfill compact outcome receipt
 * - all other row fields (venue, title, schedule, …)
 */

export const SUBJECT_PROPERTY_ROLE = "subject_property";
export const VENUE_MEMBERSHIP_ROLE = "venue";

/** Membership roles the published shared catalog may carry. */
export const PUBLIC_LOCATION_MEMBERSHIP_ROLES = Object.freeze([
  VENUE_MEMBERSHIP_ROLE,
  SUBJECT_PROPERTY_ROLE,
]);

/**
 * Exact strip inventory for tests and producer docs. Each entry names what is
 * removed and why the resident surface does not read it from the catalog.
 */
export const SHARED_MEETING_PUBLISH_STRIP = Object.freeze([
  Object.freeze({
    field: "location_assertions",
    remove_when: "role !== subject_property",
    why_not_displayed:
      "Meeting detail and Near You read venue name/address from row.venue; "
      + "Subject property reads only subject_property assertions (or agenda_subject_places).",
  }),
  Object.freeze({
    field: "location_memberships",
    remove_when: "role === host_jurisdiction (or any role outside venue/subject_property)",
    why_not_displayed:
      "District activity adds board covers from community-board ontology; "
      + "Near You exact membership uses venue/subject_property memberships only.",
  }),
  Object.freeze({
    field: "location_memberships.provenance.source_path",
    remove_when: "always on publish",
    why_not_displayed:
      "Resident surfaces read venue/subject text from row.venue and subject "
      + "assertions; the bulky source_path copy is evidence-plane detail.",
  }),
  Object.freeze({
    field: "location_memberships.record_id",
    remove_when: "always on publish",
    why_not_displayed:
      "The catalog row already carries meeting_id; repeating record_id on every "
      + "membership edge is redundant for Near You / detail placement.",
  }),
  Object.freeze({
    field: "geography_backfill.input_hash",
    remove_when: "always on publish",
    why_not_displayed:
      "Backfill artifacts under site/data/meeting-geography-backfill keep the "
      + "input hash; the catalog only needs outcome + processed_at.",
  }),
]);

function cleanText(value, max = 500) {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, max) : null;
}

/**
 * Compact resident subject places derived from admitted subject_property
 * assertions. Shape matches meetingAgendaSubjectPlaces() consumers.
 */
export function agendaSubjectPlacesFromAssertions(assertions) {
  if (!Array.isArray(assertions) || !assertions.length) return [];
  const places = [];
  const seen = new Set();
  for (const row of assertions) {
    if (!row || row.role !== SUBJECT_PROPERTY_ROLE) continue;
    const original_address = cleanText(row.original_address, 240);
    if (!original_address || seen.has(original_address)) continue;
    seen.add(original_address);
    places.push({
      original_address,
      source_passage: cleanText(row.source_passage, 500),
      passage_locator: cleanText(row.passage_locator, 240),
      assertion_id: cleanText(row.assertion_id, 320),
    });
  }
  return places;
}

function subjectAssertionsOnly(assertions) {
  if (!Array.isArray(assertions) || !assertions.length) return [];
  return assertions.filter((row) => row && row.role === SUBJECT_PROPERTY_ROLE);
}

function publicMembershipsOnly(memberships) {
  if (!Array.isArray(memberships) || !memberships.length) return [];
  const allowed = new Set(PUBLIC_LOCATION_MEMBERSHIP_ROLES);
  return memberships.filter((row) => row && allowed.has(row.role));
}

/**
 * Drop publish-only bulk from one retained venue/subject membership while
 * keeping placement fields Near You and district activity read.
 */
export function slimPublicLocationMembership(membership) {
  if (!membership || typeof membership !== "object") return membership;
  const {
    record_id: _recordId,
    provenance,
    ...rest
  } = membership;
  const next = { ...rest };
  if (provenance && typeof provenance === "object") {
    const slimProvenance = {};
    if (provenance.source_method) slimProvenance.source_method = provenance.source_method;
    if (provenance.parcel_bbl) slimProvenance.parcel_bbl = provenance.parcel_bbl;
    if (Object.keys(slimProvenance).length) next.provenance = slimProvenance;
    else delete next.provenance;
  }
  return next;
}

/**
 * Catalog geography_backfill keeps outcome + processed_at only.
 */
export function slimGeographyBackfillReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return receipt;
  const next = {};
  if (receipt.outcome != null) next.outcome = receipt.outcome;
  if (receipt.processed_at != null) next.processed_at = receipt.processed_at;
  return Object.keys(next).length ? next : receipt;
}

function preserveExistingSubjectPlaces(row) {
  if (!Array.isArray(row?.agenda_subject_places) || !row.agenda_subject_places.length) {
    return [];
  }
  return agendaSubjectPlacesFromAssertions(
    row.agenda_subject_places.map((place) => ({
      role: SUBJECT_PROPERTY_ROLE,
      original_address: place?.original_address || place?.address,
      source_passage: place?.source_passage,
      passage_locator: place?.passage_locator,
      assertion_id: place?.assertion_id,
    })),
  );
}

/**
 * Slim one shared-meeting row for the Pages-served catalog.
 * Drops non-subject location_assertions and non-public memberships; retains
 * subject_property assertions, agenda_subject_places, and venue/subject
 * memberships.
 */
export function slimSharedMeetingRow(row) {
  if (!row || typeof row !== "object") return row;
  const {
    location_assertions,
    location_memberships,
    geography_backfill,
    ...rest
  } = row;
  const subjects = subjectAssertionsOnly(location_assertions);
  const fromAssertions = agendaSubjectPlacesFromAssertions(subjects);
  const places = fromAssertions.length ? fromAssertions : preserveExistingSubjectPlaces(row);
  const memberships = publicMembershipsOnly(location_memberships)
    .map(slimPublicLocationMembership);
  const next = { ...rest };
  if (subjects.length) next.location_assertions = subjects;
  if (memberships.length) next.location_memberships = memberships;
  if (places.length) next.agenda_subject_places = places;
  else delete next.agenda_subject_places;
  if (geography_backfill) next.geography_backfill = slimGeographyBackfillReceipt(geography_backfill);
  return next;
}

/**
 * Strip bulky non-public geography stamps from the published shared meeting
 * catalog while retaining the subject-property assertions and venue/subject
 * memberships the meeting detail and Near You surfaces need.
 */
export function slimSharedMeetingReadModel(model) {
  if (!model || typeof model !== "object") return model;
  return {
    ...model,
    rows: Array.isArray(model.rows) ? model.rows.map(slimSharedMeetingRow) : model.rows,
    hearings: Array.isArray(model.hearings) ? model.hearings.map(slimSharedMeetingRow) : model.hearings,
  };
}
