#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assertPublicUpcomingProjection,
  buildUpcomingCouncilMeetingsView,
} from "../worker/src/lib/upcoming_council_meetings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/legistar/upcoming_contracts_22691.json");
const OUT = join(ROOT, "site/data/upcoming_council_meetings.json");
const PINNED_NOW = "2026-09-09T12:00:00.000Z";

export function buildUpcomingCouncilMeetingsSnapshot(fixture = JSON.parse(readFileSync(FIXTURE, "utf8"))) {
  const eventId = String(fixture.event.EventId);
  const { publishable, view } = buildUpcomingCouncilMeetingsView({
    eventRows: [fixture.event],
    itemsByEventId: new Map([[eventId, { rows: fixture.event_items, fetchError: null }]]),
    now: new Date(PINNED_NOW),
  });
  if (!publishable || !view) {
    throw new Error("upcoming council meetings snapshot is not publishable from the pinned fixture");
  }
  view.meetings[0].insite_calendar = fixture.insite_calendar || null;
  assertPublicUpcomingProjection(view);
  return `${JSON.stringify(view, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes("--check");
  const content = buildUpcomingCouncilMeetingsSnapshot();
  if (check) {
    if (!existsSync(OUT) || readFileSync(OUT, "utf8") !== content) {
      console.error("site/data/upcoming_council_meetings.json is stale");
      process.exit(1);
    }
    console.log("upcoming council meetings snapshot is current");
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, content);
    console.log("wrote site/data/upcoming_council_meetings.json");
  }
}
