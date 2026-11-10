/**
 * PHC-01 — attendance-mode filter for the Meetings landing.
 * Engine-owned derivation lives in capabilities/meetings_attendance.mjs;
 * this module re-exports it for presentation importers.
 */

export {
  MEETINGS_ATTENDANCE_MODES,
  attendanceModeFromParticipation,
  attendanceDomainForRecord,
  participationModesForAttendance,
  attendanceModeForRecord,
} from "../capabilities/meetings_attendance.mjs";
