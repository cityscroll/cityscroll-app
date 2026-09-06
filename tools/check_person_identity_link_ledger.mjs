#!/usr/bin/env node

/**
 * Check-mode gate for the reviewed same-person identity-link ledger.
 *
 * `--check` reads the committed ledger and refuses any stored link whose
 * method is not the reviewed assertion, whose evidence carries no source
 * locator, or whose endpoints are display names or non-generic ids. It prints
 * one line per violation and exits non-zero; a clean ledger exits zero.
 *
 * `--diagnostics` prints the inspectable listing instead of a verdict, so the
 * candidate and rejected records stay visible as non-linking evidence rather
 * than being dropped or read as accepted identity.
 *
 * The command reads only committed files and takes no ambient input.
 */

import { relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PERSON_IDENTITY_LINK_LEDGER_PATH,
  PERSON_IDENTITY_LINK_LEDGER_RELATIVE_PATH,
  checkPersonIdentityLinkLedger,
  formatPersonIdentityLinkLedgerFindings,
  personIdentityLinkLedgerDiagnostics,
  personIdentityLinkRecords,
  readPersonIdentityLinkLedger,
} from "../ontology/person_identity_link_ledger.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const USAGE = [
  "Usage: node tools/check_person_identity_link_ledger.mjs --check [--ledger PATH]",
  "       node tools/check_person_identity_link_ledger.mjs --diagnostics [--ledger PATH]",
  "",
  `Default ledger: ${PERSON_IDENTITY_LINK_LEDGER_RELATIVE_PATH}`,
].join("\n");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const wantsCheck = process.argv.includes("--check");
const wantsDiagnostics = process.argv.includes("--diagnostics");

if (process.argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}
if (!wantsCheck && !wantsDiagnostics) {
  console.error(USAGE);
  process.exit(2);
}

const ledgerPath = argValue("--ledger") || PERSON_IDENTITY_LINK_LEDGER_PATH;
const ledger = readPersonIdentityLinkLedger(ledgerPath);
const label = relative(ROOT, ledger.path) || ledger.path;

if (!ledger.exists) {
  console.error(`${label}:0 [ledger_missing] the reviewed identity-link ledger is not present`);
  process.exit(1);
}

const records = personIdentityLinkRecords(ledger.entries);

if (wantsDiagnostics) {
  const diagnostics = personIdentityLinkLedgerDiagnostics(records);
  console.log(`${label}: ${diagnostics.total} stored link record(s)`);
  console.log(
    `  accepted ${diagnostics.accepted.length}, candidate ${diagnostics.candidate.length}, `
    + `rejected ${diagnostics.rejected.length}, superseded ${diagnostics.superseded.length}`,
  );
  for (const row of diagnostics.rows) {
    const state = [
      row.current ? "current" : "superseded",
      row.linking ? "linking" : "non-linking",
    ].join("/");
    console.log(
      `  ${label}:${row.ledger_line} ${row.record_id} ${row.status} (${state}) `
      + `${row.left_identity} + ${row.right_identity} `
      + `canonical_person_ref=${row.canonical_person_ref ?? "none"} `
      + `evidence=${row.evidence_refs.join(",") || "none"}`,
    );
  }
  console.log(`  materialized canonical references: ${diagnostics.materialized.length}`);
  for (const { identity, canonical_person_ref: canonical } of diagnostics.materialized) {
    console.log(`    ${identity} -> ${canonical}`);
  }
}

if (!wantsCheck) process.exit(0);

const result = checkPersonIdentityLinkLedger(ledger.entries);

if (!result.ok) {
  console.error(formatPersonIdentityLinkLedgerFindings(result.findings, label));
  console.error(`${label}: ${result.findings.length} violation(s) in ${result.link_records} stored link record(s)`);
  process.exit(1);
}

console.log(
  `reviewed identity-link ledger ok (${result.link_records} stored link record(s) in ${label}; `
  + `${personIdentityLinkLedgerDiagnostics(records).materialized.length} materialized canonical reference(s))`,
);
