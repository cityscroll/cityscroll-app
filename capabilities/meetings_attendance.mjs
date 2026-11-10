/**
 * Attendance-mode buckets for the meetings capability.
 *
 * Attendance is derived from evidence-gated participation signals on a meeting
 * record. A recognized video-conference join platform proves remote
 * participation; a bare livestream or broadcast link is watch-only; written
 * testimony or registration alone stays "not stated".
 */

import { inferHearingLogistics, recognizedMeetingUrl } from "../site/hearing_logistics.mjs";
import { meetingProcessProjection } from "./meeting_process_profile.mjs";

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

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function httpsUrl(value) {
  const text = clean(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function noticeBody(record = {}) {
  return [
    record.additional_description_1,
    record.additional_description_2,
    record.body,
    record.notice_text,
    record.decides,
  ].map(clean).filter(Boolean).join("\n");
}

function isCouncilHearingRecord(record) {
  return /\bcity council\b/i.test(String(record?.agency || "").trim());
}

export function attendanceDomainForRecord(record = {}) {
  return isCouncilHearingRecord(record) ? "council_hearing" : "meeting";
}

function addMode(modes, mode) {
  if (!modes.includes(mode)) modes.push(mode);
}

function modesFromLogistics(record, logistics) {
  const modes = [];
  if (clean(logistics?.in_person_location) || clean(record.venue?.address) || clean(record.venue?.name)) {
    addMode(modes, "attend_in_person");
  }
  const joinUrl = recognizedMeetingUrl(logistics?.remote_join_url)
    || recognizedMeetingUrl(record.participation?.remote_join_url)
    || recognizedMeetingUrl(record.remote_join_url)
    || recognizedMeetingUrl(record.observer_access?.remote_join_url);
  if (joinUrl) addMode(modes, "join_remote");
  const watchUrl = httpsUrl(logistics?.broadcast_url)
    || httpsUrl(record.observer_access?.watch_url)
    || httpsUrl(record.watch_url);
  if (watchUrl) addMode(modes, "watch");
  return modes;
}

/**
 * Participation modes used only to derive an attendance bucket. Mirrors the
 * attendance-relevant signals from the consequence composers without pulling
 * presentation action-registry or consequence modules into the engine.
 */
export function participationModesForAttendance(record = {}) {
  const domain = attendanceDomainForRecord(record);

  if (domain === "council_hearing") {
    if (!clean(record?.meeting_id)) return [];
    const logistics = inferHearingLogistics({
      body: noticeBody(record),
      sourceLinks: record.source_links || record.participation?.links?.map((link) => link?.url) || [],
      physicalLocation: record.venue?.address || record.street_address_1 || null,
    });
    return modesFromLogistics(record, logistics);
  }

  const projection = meetingProcessProjection(record);
  if (["pdc_session_v1", "bsa_session_v1", "oath_trial_session_v1"].includes(projection.meeting_family)) {
    const logistics = {
      in_person_location: record.venue?.address || record.venue?.name || null,
      remote_join_url: record.observer_access?.remote_join_url || record.remote_join_url || null,
      broadcast_url: record.observer_access?.watch_url || record.watch_url || null,
    };
    return modesFromLogistics(record, logistics);
  }
  if (projection.meeting_family !== "community_board_meeting_v0") {
    return [];
  }

  const logistics = record.meeting_access || {
    in_person_location: record.venue?.address || null,
    remote_join_url: record.participation?.remote_join_url || null,
    broadcast_url: null,
  };
  const modes = modesFromLogistics(record, logistics);
  const hearingParticipation = record.hearing_participation;
  if (hearingParticipation && typeof hearingParticipation === "object") {
    for (const watch of Array.isArray(hearingParticipation.watch_urls) ? hearingParticipation.watch_urls : []) {
      if (httpsUrl(watch)) addMode(modes, "watch");
    }
  }
  return modes;
}

export function attendanceModeForRecord(record = {}) {
  return attendanceModeFromParticipation(participationModesForAttendance(record));
}
