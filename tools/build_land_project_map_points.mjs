#!/usr/bin/env node
/**
 * Materialize the bounded Land project-location projection.
 *
 * Usage:
 *   node tools/build_land_project_map_points.mjs
 *   node tools/build_land_project_map_points.mjs --check
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLandProjectMapPoints,
  materializeLandProjectMapPoints,
} from "../site/land_project_map_points.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAYLOAD_JSON = "site/data/land_project_map_points.json";
export const RECEIPT_JSON = "site/data/land_project_map_points_receipt.json";

const LAND_DEFAULT = "site/data/land_default_ulurp.json";
const ZAP_BBL = "site/data/zap_bbl_warehouse_lookup.json";
const MAPPLUTO = "site/data/bbl_mappluto_centroids_lookup.json";

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

export function buildLandProjectMapPointsFromRepo(root = ROOT) {
  const { payload, receipt } = materializeLandProjectMapPoints({
    landDefault: JSON.parse(readFileSync(path.join(root, LAND_DEFAULT), "utf8")),
    zapBbl: JSON.parse(readFileSync(path.join(root, ZAP_BBL), "utf8")),
    mapplutoCentroids: JSON.parse(readFileSync(path.join(root, MAPPLUTO), "utf8")),
    artifactHashes: {
      land_default: sha256File(root, LAND_DEFAULT),
      zap_bbl: sha256File(root, ZAP_BBL),
      mappluto_centroids: sha256File(root, MAPPLUTO),
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
  assertLandProjectMapPoints(payload, stamped, { payloadBytes: stamped.generation.payload_bytes });
  return { payload, receipt: stamped, payloadText, receiptText: stableStringify(stamped) };
}

export function writeLandProjectMapPoints({ check = false, root = ROOT } = {}) {
  const built = buildLandProjectMapPointsFromRepo(root);
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
  const built = writeLandProjectMapPoints({ check: args.check });
  const mapped = built.receipt.counts.mapped;
  const universe = built.receipt.counts.universe;
  console.log(
    args.check
      ? `land project map points check ok: ${mapped}/${universe}`
      : `wrote ${PAYLOAD_JSON} and ${RECEIPT_JSON}: ${mapped}/${universe}`,
  );
}
