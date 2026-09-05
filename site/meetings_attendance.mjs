/**
 * PHC-01 — independent attendance-mode filter for the Meetings landing.
 *
 * Attendance is derived from PHC-00's evidence-gated `participation_modes`
 * (site/consequence_projection.mjs) rather than re-parsing notice text, so
 * the same escalation rules apply here: a recognized video-conference join
 * platform is the only thing that proves remote participation, a bare
 * livestream/broadcast link is watch-only, and a record with no attendance
 * signal at all (including one with only written-testimony or
 * register-to-testify signals) stays "not stated" rather than being
 * upgraded to a stronger mode.
 */

import { buildConsequenceProjection } from "./consequence_projection.mjs";

export const MEETINGS_ATTENDANCE_MODES = Object.freeze([
  "in_person",
  "remote",
  "watch_only",
  "hybrid",
  "not_stated",
]);

export function attendanceModeFromParticipation(modes) {
  const list = Array.isArray(modes) ? modes : [];
  const remote = list.includes("join_remote");
  const inPerson = list.includes("attend_in_person");
  if (remote && inPerson) return "hybrid";
  if (remote) return "remote";
  if (inPerson) return "in_person";
  if (list.includes("watch")) return "watch_only";
  return "not_stated";
}

// Mirrors site/app/meetings.mjs's isCityCouncilNotice, applied to the
// normalized cityscroll.meeting_object.v1 row's `agency` field — that
// function itself reads the pre-normalization `agency_name` field, which is
// not present on rows already run through hearing_location.js's
// normalizeHearingRow.
function isCouncilHearingRecord(record) {
  return /\bcity council\b/i.test(String(record?.agency || "").trim());
}

export function attendanceDomainForRecord(record = {}) {
  return isCouncilHearingRecord(record) ? "council_hearing" : "meeting";
}

export function attendanceModeForRecord(record = {}) {
  const domain = attendanceDomainForRecord(record);
  const projection = buildConsequenceProjection(domain, record, {});
  return attendanceModeFromParticipation(projection.participation_modes);
}

