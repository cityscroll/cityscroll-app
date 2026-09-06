/**
 * The client contract for the meeting-outcome read model.
 *
 * Which rows can carry an outcome, where the record is read from, and whether a
 * record is worth rendering are all decided here. The feed's action rail, the
 * notice detail, and the Meetings lens itself share the answers, so a route can
 * find out whether a notice has a meeting outcome before deciding to boot the
 * lens that renders one.
 */

/** Read path for one notice's meeting outcome. */
export const MEETING_OUTCOME_READ_PATH = "/meeting-outcomes";

/** True when the row is a hearing the outcome join can be expected to cover. */
export function isMeetingOutcomesEligible(row) {
  const section = row?.section_name || "";
  if (section === "Public Hearings and Meetings") return true;
  return section === "Agency Rules" && row?.type_of_notice_description === "Public Hearings";
}

/** True when the notice's publishing body is the City Council itself. */
export function isCityCouncilNotice(row) {
  const agency = String((row && row.agency_name) || "").trim();
  if (!agency) return false;
  return /\bcity council\b/i.test(agency);
}

/**
 * Read one notice's meeting-outcome record. Never throws: an unavailable read
 * model is the same absence as an unmatched notice.
 */
export async function readMeetingOutcome(requestId, fetchImpl, timeoutMs = 8000) {
  const id = String(requestId || "").trim();
  if (!id || typeof fetchImpl !== "function") return null;
  try {
    const response = await fetchImpl(`${MEETING_OUTCOME_READ_PATH}?id=${encodeURIComponent(id)}`, null, timeoutMs);
    if (!response || !response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  }
}

/**
 * Whether a payload has anything the notice detail would render.
 *
 * A hearing-eligible notice always has a state to show — a decision, a recorded
 * no-action, or an outcome that could not be located. Any other notice shows a
 * panel only when the join actually matched it to a meeting.
 */
export function hasRenderableMeetingOutcome(row, payload) {
  if (isMeetingOutcomesEligible(row)) return true;
  const record = payload && payload.ok !== false ? payload.record : null;
  return Boolean(record && record.join && record.join.matched);
}
