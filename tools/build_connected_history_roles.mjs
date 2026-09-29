#!/usr/bin/env node
/**
 * Materialize fixed-dossier connected-history participant roles.
 *
 *   node tools/build_connected_history_roles.mjs
 *   node tools/build_connected_history_roles.mjs --check
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONNECTED_HISTORY_ROLES_ARTIFACT_SCHEMA,
  CONNECTED_HISTORY_ROLES_VERSION,
} from "../site/connected_history_roles.mjs";
import {
  CONNECTED_HISTORY_ROLES_ARTIFACT_PATH,
  CONNECTED_HISTORY_ROLES_RECEIPT_PATH,
  connectedHistoryRolesDrift,
  materializeConnectedHistoryRoles,
  serializeConnectedHistoryRolesJson,
} from "./lib/connected_history_roles.mjs";
import { evidenceInvalidatedBy, retainedEvidencePins } from "./lib/retained_evidence_pins.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, CONNECTED_HISTORY_ROLES_ARTIFACT_PATH);
const RECEIPT = join(ROOT, CONNECTED_HISTORY_ROLES_RECEIPT_PATH);

const checkOnly = process.argv.includes("--check");

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const materialized = materializeConnectedHistoryRoles();
const { artifact, receipt } = materialized;

if (artifact.schema !== CONNECTED_HISTORY_ROLES_ARTIFACT_SCHEMA) {
  throw new Error("unexpected artifact schema");
}
if (artifact.version !== CONNECTED_HISTORY_ROLES_VERSION) {
  throw new Error("unexpected artifact version");
}

// The check is byte-exact: equal selection hashes and counts do not make the
// committed artifact what the code produces.
const drift = connectedHistoryRolesDrift(
  { artifactText: readText(OUT), receiptText: readText(RECEIPT) },
  materialized,
);
// Retained production measurements that pin the bytes this build would change.
const invalidated = evidenceInvalidatedBy(retainedEvidencePins(ROOT), drift.map((finding) => finding.path));

if (checkOnly) {
  if (drift.length) {
    for (const finding of drift) {
      console.error(
        `${finding.path}: committed ${finding.committed_bytes} bytes (sha256 ${finding.committed_sha256}) `
        + `differ from a fresh materialization of ${finding.materialized_bytes} bytes `
        + `(sha256 ${finding.materialized_sha256}) at byte ${finding.first_difference_at}`,
      );
    }
    for (const entry of invalidated) {
      console.error(`rebuilding changes bytes pinned by ${entry.path} (${entry.inputs_changed.join(", ")})`);
    }
    throw new Error("connected history roles artifact or receipt is stale; rebuild required");
  }
  console.log("ok connected history roles artifact and receipt are byte-identical to a fresh materialization");
  process.exit(0);
}

writeFileSync(OUT, serializeConnectedHistoryRolesJson(artifact));
writeFileSync(RECEIPT, serializeConnectedHistoryRolesJson(receipt));
console.log(
  JSON.stringify(
    {
      counts: artifact.counts,
      missing_strata: artifact.missing_strata,
      selection_hash: artifact.selection_hash,
      changed: drift.map((finding) => finding.path),
      invalidates_retained_measurements: invalidated,
      out: [CONNECTED_HISTORY_ROLES_ARTIFACT_PATH, CONNECTED_HISTORY_ROLES_RECEIPT_PATH],
    },
    null,
    2,
  ),
);
