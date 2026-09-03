#!/usr/bin/env node
/**
 * Materialize the bounded Land project-geometry projection and its
 * full-corpus recon receipt (LM-17).
 *
 * Usage:
 *   node tools/build_land_project_geometry.mjs
 *   node tools/build_land_project_geometry.mjs --check
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLandProjectGeometry,
  materializeLandProjectGeometry,
} from "../site/land_project_geometry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PAYLOAD_JSON = "site/data/land_project_geometry.json";
export const RECEIPT_JSON = "site/data/land_project_geometry_receipt.json";

const LAND_DEFAULT = "site/data/land_default_ulurp.json";
const ZAP_BBL = "site/data/zap_bbl_warehouse_lookup.json";
const GEOMETRY_SOURCE = "site/data/land_project_geometry_source_lookup.json";
const MAP_POINTS = "site/data/land_project_map_points.json";

function parseArgs(argv) {
  const out = { check: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function buildLandProjectGeometryFromRepo(root = ROOT) {
  const landDefault = JSON.parse(readFileSync(path.join(root, LAND_DEFAULT), "utf8"));
  const zapBbl = JSON.parse(readFileSync(path.join(root, ZAP_BBL), "utf8"));
  const geometrySource = JSON.parse(readFileSync(path.join(root, GEOMETRY_SOURCE), "utf8"));
  const mapPoints = JSON.parse(readFileSync(path.join(root, MAP_POINTS), "utf8"));
  const mappedProjectIds = Object.keys(mapPoints.points || {});

  const { payload, receipt } = materializeLandProjectGeometry({
    landDefault,
    zapBbl,
    geometrySource,
    mappedProjectIds,
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
  assertLandProjectGeometry(payload, stamped, { payloadBytes: stamped.generation.payload_bytes });
  return { payload, receipt: stamped, payloadText, receiptText: stableStringify(stamped) };
}

export function writeLandProjectGeometry({ check = false, root = ROOT } = {}) {
  const built = buildLandProjectGeometryFromRepo(root);
  const payloadPath = path.join(root, PAYLOAD_JSON);
  const receiptPath = path.join(root, RECEIPT_JSON);
  if (check) {
    const committedPayload = readFileSync(payloadPath, "utf8");
    const committedReceipt = readFileSync(receiptPath, "utf8");
    if (committedPayload !== built.payloadText) throw new Error(`${PAYLOAD_JSON} drifted; rerun without --check`);
    if (committedReceipt !== built.receiptText) throw new Error(`${RECEIPT_JSON} drifted; rerun without --check`);
    return built;
  }
  writeFileSync(payloadPath, built.payloadText);
  writeFileSync(receiptPath, built.receiptText);
  return built;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv);
  const built = writeLandProjectGeometry({ check: args.check });
  const { counts } = built.receipt;
  const summary =
    `exact=${counts.exact} ambiguous=${counts.ambiguous_relation} invalid=${counts.invalid} ` +
    `stale=${counts.stale} missing_row=${counts.missing_geometry_row} unmapped=${counts.not_applicable_unmapped} ` +
    `universe=${counts.universe}`;
  console.log(args.check ? `land project geometry check ok: ${summary}` : `wrote ${PAYLOAD_JSON} and ${RECEIPT_JSON}: ${summary}`);
}
