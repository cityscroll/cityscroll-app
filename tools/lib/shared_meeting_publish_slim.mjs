/**
 * Publish-time slim for the shared meeting catalog served to Pages.
 *
 * Full per-row location_assertions (especially venue receipts) are large and
 * redundant with venue/search text for the static payload. Subject-property
 * assertions are not redundant: the meeting-detail renderer reads them (or the
 * compact agenda_subject_places projection) to emit the Subject property
 * section. Dropping every assertion made regenerated Pages catalogs lose that
 * resident label even when upstream admissions still carried it.
 */

export const SUBJECT_PROPERTY_ROLE = "subject_property";

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
 * Drops non-subject location_assertions; retains subject_property assertions
 * and a compact agenda_subject_places projection for the detail renderer.
 */
export function slimSharedMeetingRow(row) {
  if (!row || typeof row !== "object") return row;
  const { location_assertions, ...rest } = row;
  const subjects = subjectAssertionsOnly(location_assertions);
  const fromAssertions = agendaSubjectPlacesFromAssertions(subjects);
  const places = fromAssertions.length ? fromAssertions : preserveExistingSubjectPlaces(row);
  const next = { ...rest };
  if (subjects.length) next.location_assertions = subjects;
  if (places.length) next.agenda_subject_places = places;
  else delete next.agenda_subject_places;
  return next;
}

/**
 * Strip bulky non-subject location_assertions from the published shared meeting
 * catalog while retaining the subject-property assertions the meeting detail
 * renderer needs.
 */
export function slimSharedMeetingReadModel(model) {
  if (!model || typeof model !== "object") return model;
  return {
    ...model,
    rows: Array.isArray(model.rows) ? model.rows.map(slimSharedMeetingRow) : model.rows,
    hearings: Array.isArray(model.hearings) ? model.hearings.map(slimSharedMeetingRow) : model.hearings,
  };
}
