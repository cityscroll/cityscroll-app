// Live land upcoming-hearings snapshot stored in ALERT_STATE.
// The 08:00 cron derives hearings from zap-outcome:v1:{id} records plus the
// SODA sell-facing id list and writes land:upcoming-hearings:v1. GET
// /land-upcoming-hearings serves that key; missing, empty, unparseable, or
// failed KV uses the committed site snapshot so Land → Upcoming hearings
// never goes blank.

import landUpcomingHearingsFloor from "../../../site/data/land_upcoming_hearings.json" with { type: "json" };
import {
  detectSyntheticUpcomingHearings,
  LAND_UPCOMING_HEARINGS_SCHEMA_VERSION,
} from "../../../tools/lib/land_upcoming_hearings.mjs";
import { readKvValue } from "./preset_fallback_kv.mjs";

export const LAND_UPCOMING_HEARINGS_KV_KEY = "land:upcoming-hearings:v1";
export const LAND_UPCOMING_HEARINGS_MAX_AGE_MS = 36 * 60 * 60 * 1000;

export function committedLandUpcomingHearingsFloor() {
  return landUpcomingHearingsFloor;
}

export function parseLandUpcomingHearingsRecord(raw) {
  if (raw == null || raw === "") return null;
  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (Number(parsed.schema_version) !== LAND_UPCOMING_HEARINGS_SCHEMA_VERSION) return null;
  if (!Array.isArray(parsed.hearings)) return null;
  const detection = detectSyntheticUpcomingHearings(parsed);
  if (!detection.ok) return null;
  return parsed;
}

export async function loadLandUpcomingHearingsSnapshot(env) {
  const floor = committedLandUpcomingHearingsFloor();
  const kv = env?.ALERT_STATE;
  if (!kv || typeof kv.get !== "function") {
    return { source: "committed_floor", record: floor };
  }
  try {
    const parsed = parseLandUpcomingHearingsRecord(
      await readKvValue(kv, LAND_UPCOMING_HEARINGS_KV_KEY),
    );
    if (parsed) return { source: "kv", record: parsed };
  } catch {
    // Failed KV reads must not blank the Land upcoming-hearings filter.
  }
  return { source: "committed_floor", record: floor };
}

export function landUpcomingHearingsStale(record, nowMs = Date.now()) {
  const generated = Date.parse(record?.generated_at);
  if (!Number.isFinite(generated)) return true;
  return nowMs - generated > LAND_UPCOMING_HEARINGS_MAX_AGE_MS;
}
