#!/usr/bin/env node
/**
 * Materialize the bounded Land authority-summary projection.
 *
 * Usage:
 *   node tools/build_land_authority_summary.mjs
 *   node tools/build_land_authority_summary.mjs --check
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLandAuthoritySummaries,
  materializeLandAuthoritySummaries,
} from "../site/land_authority_summary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAYLOAD_JSON = "site/data/land_authority_summary.json";
export const RECEIPT_JSON = "site/data/land_authority_summary_receipt.json";

const LAND_DEFAULT = "site/data/land_default_ulurp.json";
const GEOGRAPHY = "site/data/community_board_geography_lookup.json";
const HEARINGS = "site/data/land_upcoming_hearings.json";

function parseArgs(argv) {
  const out = { check: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function sha256File(root, relativePath) {
  return createHash("sha256").update(readFileSync(path.join(root, relativePath))).digest("hex");
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildLandAuthoritySummaryFromRepo(root = ROOT) {
  const landDefault = JSON.parse(readFileSync(path.join(root, LAND_DEFAULT), "utf8"));
  const { payload, receipt } = materializeLandAuthoritySummaries({
    landDefault,
    geography: JSON.parse(readFileSync(path.join(root, GEOGRAPHY), "utf8")),
    publishedOpportunities: JSON.parse(readFileSync(path.join(root, HEARINGS), "utf8")),
    asOf: landDefault.generated_at,
    generatedAt: landDefault.generated_at,
    artifactHashes: {
      land_default: sha256File(root, LAND_DEFAULT),
      geography: sha256File(root, GEOGRAPHY),
      upcoming_hearings: sha256File(root, HEARINGS),
    },
  });
  const payloadText = stableStringify(payload);
  const stamped = {
    ...receipt,
    generation: {
      ...receipt.generation,
      payload_path: PAYLOAD_JSON,
      payload_bytes: Buffer.byteLength(payloadText),
      payload_sha256: sha256Text(payloadText),
    },
  };
  assertLandAuthoritySummaries(payload, stamped, { payloadBytes: stamped.generation.payload_bytes });
  return { payload, receipt: stamped, payloadText, receiptText: stableStringify(stamped) };
}

export function writeLandAuthoritySummary({ check = false, root = ROOT } = {}) {
  const built = buildLandAuthoritySummaryFromRepo(root);
  const payloadPath = path.join(root, PAYLOAD_JSON);
  const receiptPath = path.join(root, RECEIPT_JSON);
  if (check) {
    const committedPayload = readFileSync(payloadPath, "utf8");
    const committedReceipt = readFileSync(receiptPath, "utf8");
    if (committedPayload !== built.payloadText) {
      throw new Error(`${PAYLOAD_JSON} drifted; rerun without --check`);
    }
    if (committedReceipt !== built.receiptText) {
      throw new Error(`${RECEIPT_JSON} drifted; rerun without --check`);
    }
    return built;
  }
  writeFileSync(payloadPath, built.payloadText);
  writeFileSync(receiptPath, built.receiptText);
  return built;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  const built = writeLandAuthoritySummary({ check: args.check });
  const resolved = built.receipt.counts.resolved;
  const universe = built.receipt.counts.universe;
  console.log(
    args.check
      ? `land authority summary check ok: ${resolved}/${universe} resolved`
      : `wrote ${PAYLOAD_JSON} and ${RECEIPT_JSON}: ${resolved}/${universe} resolved`,
  );
}
