#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseOathTrialCsv } from "../site/oath_trial_calendar.mjs";

const ROOT = join(import.meta.dirname, "..");
export function buildOathTrialCalendar({ csv, sourceUrl, observedAt, sourceRevision, receipt } = {}) {
  return parseOathTrialCsv(csv, { sourceUrl, observedAt, sourceRevision, receipt });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const input = process.argv[2];
  const output = process.argv[3] || join(ROOT, "site/data/oath_trial_calendar.json");
  if (!input) throw new Error("usage: build_oath_trial_calendar.mjs <captured-csv> [output]");
  const result = buildOathTrialCalendar({
    csv: readFileSync(input, "utf8"),
    sourceUrl: "https://www.nyc.gov/site/oath/calendar/calendar.page",
    observedAt: process.env.OATH_OBSERVED_AT || new Date().toISOString(),
    sourceRevision: process.env.OATH_SOURCE_REVISION || null,
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
