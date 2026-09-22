#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  OATH_TRIAL_CALENDAR_SOURCE_URL,
  parseOathTrialCsv,
} from "../site/oath_trial_calendar.mjs";

const ROOT = join(import.meta.dirname, "..");
export function buildOathTrialCalendar({ csv, sourceUrl, observedAt, sourceRevision, receipt } = {}) {
  const result = parseOathTrialCsv(csv, { sourceUrl, observedAt, sourceRevision, receipt });
  if (!Array.isArray(result.records) || result.records.length === 0) {
    throw new Error("OATH capture produced no trial records; refusing to replace the last-known-good artifact");
  }
  const population = result.population || {};
  const accounted = Number(population.trial_session_count)
    + Number(population.excluded_conference_count)
    + Number(population.exact_duplicate_count)
    + Number(population.unaccounted_row_count);
  if (!Number.isFinite(accounted) || accounted !== Number(population.input_row_count)
    || Number(population.unaccounted_row_count) !== 0) {
    throw new Error(`OATH capture left ${population.unaccounted_row_count ?? "unknown"} of ${population.input_row_count ?? "unknown"} input rows unaccounted; refusing to replace the last-known-good artifact`);
  }
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const input = process.argv[2];
  const output = process.argv[3] || join(ROOT, "site/data/oath_trial_calendar.json");
  const receiptInput = process.argv[4];
  if (!input) throw new Error("usage: build_oath_trial_calendar.mjs <captured-csv> [output] [capture-receipt]");
  const captureReceipt = receiptInput ? JSON.parse(readFileSync(receiptInput, "utf8")) : null;
  const observedAt = captureReceipt?.observed_at || process.env.OATH_OBSERVED_AT || new Date().toISOString();
  const sourceRevision = captureReceipt?.source_revision || process.env.OATH_SOURCE_REVISION || null;
  const receipt = captureReceipt ? { ...captureReceipt, parser: "oath_trial_calendar_acquisition.v1" } : null;
  const result = buildOathTrialCalendar({
    csv: readFileSync(input, "utf8"),
    sourceUrl: OATH_TRIAL_CALENDAR_SOURCE_URL,
    observedAt,
    sourceRevision,
    receipt,
  });
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, output);
}
