#!/usr/bin/env node
/**
 * Materialize Community Board ACTIVE-row staff counts from Citywide Payroll.
 *
 * Exact payroll_number bindings only. Per-board dollars and titles stay
 * withheld. Employee rows never enter the served artifact.
 *
 * Usage:
 *   node tools/build_community_board_payroll_staff_count.mjs
 *   node tools/build_community_board_payroll_staff_count.mjs --check
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCommunityBoardPayrollStaffCount,
  validateCommunityBoardPayrollStaffCount,
} from "../site/community_board_payroll_identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "site/data/community_board_financial_identity_crosswalk.json");
const INVENTORY = join(ROOT, "warehouse/fixtures/community-board-payroll/fy2025_identity_inventory.json");
const OUTPUT = join(ROOT, "site/data/community_board_payroll_staff_count.json");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/community_board_payroll_identity_latest.json");
const GENERATED_AT = "2026-08-29T20:00:00.000Z";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialized(value));
}

function collect() {
  if (!existsSync(REGISTRY)) throw new Error("missing CB-MONEY-00 identity artifact");
  if (!existsSync(INVENTORY)) throw new Error("missing Citywide Payroll Community Board identity inventory");
  const registry = json(REGISTRY);
  const inventory = json(INVENTORY);
  const { model, receipt } = buildCommunityBoardPayrollStaffCount(registry, inventory, {
    generatedAt: GENERATED_AT,
    reviewedAt: GENERATED_AT,
  });
  const rendered = serialized(model);
  const stamped = {
    ...receipt,
    artifact: "site/data/community_board_payroll_staff_count.json",
    artifact_sha256: sha256(rendered),
  };
  const validation = validateCommunityBoardPayrollStaffCount(model, stamped);
  if (!validation.ok) throw new Error(`payroll staff-count validation failed: ${validation.errors.join("; ")}`);
  return { model, receipt: stamped };
}

function check() {
  if (!existsSync(OUTPUT) || !existsSync(RECEIPT)) {
    throw new Error("missing committed payroll staff-count artifact or receipt");
  }
  const expected = collect();
  const existingModel = serialized(json(OUTPUT));
  const existingReceipt = serialized(json(RECEIPT));
  if (existingModel !== serialized(expected.model)) {
    throw new Error("community_board_payroll_staff_count.json is stale; rebuild with node tools/build_community_board_payroll_staff_count.mjs");
  }
  if (existingReceipt !== serialized(expected.receipt)) {
    throw new Error("community_board_payroll_identity_latest.json is stale; rebuild with node tools/build_community_board_payroll_staff_count.mjs");
  }
  console.log(
    `community board payroll staff count ok: boards=${expected.model.rows.length} ` +
      `active_rows=${expected.receipt.measurement.active_rows} ` +
      `precision=${expected.receipt.measurement.reviewed_precision} ` +
      `dollars_withheld=${expected.model.withheld.payroll_measures} ` +
      `titles_withheld=${expected.model.withheld.title_mix}`,
  );
}

function main() {
  if (process.argv.includes("--check")) {
    check();
    return;
  }
  const { model, receipt } = collect();
  writeJson(OUTPUT, model);
  writeJson(RECEIPT, receipt);
  console.log(
    `wrote ${OUTPUT} (${model.rows.length} boards) and ${RECEIPT} ` +
      `(precision=${receipt.measurement.reviewed_precision})`,
  );
}

if (process.argv[1]?.endsWith("build_community_board_payroll_staff_count.mjs")) main();
