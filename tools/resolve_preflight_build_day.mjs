#!/usr/bin/env node
/**
 * Default CROL_BUILD_DAY for the local required-CI preflight.
 *
 * CI leaves CROL_BUILD_DAY unset, so primaryDocumentOutputs keeps a null clock
 * and does not re-filter the committed open-solicitation snapshot. The local
 * preflight must pin one instant across its rebuilds and test suite; that
 * instant has to be a day on which the committed snapshot still has open rows.
 *
 * Derive it from the same vintage fields the browser harness uses
 * (test/functional/assets/fixture_clock.py): open_as_of, then generated_at,
 * then retrieved_at. An explicit CROL_BUILD_DAY in the environment always wins
 * at the preflight entry point; this helper only supplies the default.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MONEY_OPEN_SNAPSHOT_PATH = join(ROOT, "site/data/money_default_open.json");
export const VINTAGE_FIELDS = Object.freeze(["open_as_of", "generated_at", "retrieved_at"]);

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function resolvePreflightBuildDay(payload, { snapshotPath = MONEY_OPEN_SNAPSHOT_PATH } = {}) {
  for (const key of VINTAGE_FIELDS) {
    const day = String(payload?.[key] || "").slice(0, 10);
    if (DAY.test(day)) return day;
  }
  throw new Error(
    `${snapshotPath} declares no vintage; CROL_BUILD_DAY cannot be derived from the pinned data snapshot`,
  );
}

export function resolvePreflightBuildDayFromFile(snapshotPath = MONEY_OPEN_SNAPSHOT_PATH) {
  const payload = JSON.parse(readFileSync(snapshotPath, "utf8"));
  return resolvePreflightBuildDay(payload, { snapshotPath });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${resolvePreflightBuildDayFromFile()}\n`);
}
