import { readFileSync } from "node:fs";

import { upcomingCouncilMeetingsIndex } from "../../worker/src/lib/upcoming_council_meetings.mjs";

export function readUpcomingCouncilMeetingsIndex(pathOrUrl) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(pathOrUrl, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return upcomingCouncilMeetingsIndex(raw);
}
