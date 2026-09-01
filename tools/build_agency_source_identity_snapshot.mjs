#!/usr/bin/env node
/**
 * Regenerate or verify the CI-K1 agency source-identity regression snapshot.
 *
 *   node tools/build_agency_source_identity_snapshot.mjs --write   # refresh fixture
 *   node tools/build_agency_source_identity_snapshot.mjs --check   # CI gate
 *
 * The fixture under test/fixtures/agency_source_identity_compatibility/ is
 * the committed byte/shape receipt for agency routes, subject refs, scopes,
 * follows, property disposition keys, person-leader keys, staffing agency
 * refs, and all 59 Community Board body ids. Drift is a failure, never an
 * auto-advance.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgencySourceIdentitySnapshot } from "./lib/agency_source_identity_snapshot.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_PATH = join(
  ROOT,
  "test/fixtures/agency_source_identity_compatibility/snapshot.v1.json",
);

const mode = process.argv.includes("--check") ? "check" : "write";
const snapshot = buildAgencySourceIdentitySnapshot({ root: ROOT });
const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

if (mode === "write") {
  writeFileSync(FIXTURE_PATH, serialized);
  console.log(`wrote ${FIXTURE_PATH}`);
} else {
  let current = "";
  try {
    current = readFileSync(FIXTURE_PATH, "utf8");
  } catch {
    console.error(`missing fixture: ${FIXTURE_PATH}`);
    process.exit(1);
  }
  if (current !== serialized) {
    console.error("agency source-identity snapshot drift detected; run --write and review the diff");
    process.exit(1);
  }
  console.log("agency source-identity snapshot unchanged");
}
