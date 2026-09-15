#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePdcScheduleHtml } from "../site/pdc_calendar.mjs";

const ROOT = join(import.meta.dirname, "..");
export function buildPdcCalendar({ html, sourceUrl, observedAt, receipt } = {}) {
  return { ...parsePdcScheduleHtml(html, { sourceUrl, observedAt, receipt }), generated_at: observedAt || null };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const input = process.argv[2];
  const output = process.argv[3] || join(ROOT, "site/data/pdc_calendar.json");
  if (!input) throw new Error("usage: build_pdc_calendar.mjs <captured-html> [output]");
  const result = buildPdcCalendar({ html: readFileSync(input, "utf8"), sourceUrl: "https://www.nyc.gov/site/designcommission/design-review/meetings/meetings.page", observedAt: process.env.PDC_OBSERVED_AT || new Date().toISOString() });
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
}
