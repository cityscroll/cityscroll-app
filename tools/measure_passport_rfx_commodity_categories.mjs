#!/usr/bin/env node
/**
 * Measure how PASSPort Public RFx rows resolve to NYC commodity categories.
 *
 *   node tools/measure_passport_rfx_commodity_categories.mjs --input <rfxData.js> \
 *     --fetched-at <ISO instant> [--last-modified "<HTTP date>"] --out <receipt.json>
 *   node tools/measure_passport_rfx_commodity_categories.mjs --check <receipt.json>
 *
 * Reads a retained dump through the engine parser (parseRfxDump) and the edge resolver
 * (exact normalized L3 label). Never fetches. --check re-validates a committed receipt's
 * arithmetic and its catalog binding without the dump.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RFX_DATA_URL, parseRfxDump } from "../worker/src/lib/passport_parse.mjs";
import { passportRfxCommodityCoverage } from "../worker/src/lib/passport_commodity_category.mjs";

export const RECEIPT_SCHEMA = "cityscroll.passport_rfx_commodity_category_coverage.v1";
const CATEGORIES = new URL("../site/data/procurement_codes/nyc-commodity-categories.json", import.meta.url);

export function measurePassportRfxCommodityCategories(text, { fetchedAt, lastModified = null } = {}) {
  if (!fetchedAt || Number.isNaN(Date.parse(fetchedAt))) throw new Error("--fetched-at ISO instant required");
  const bytes = Buffer.from(text, "utf8");
  const rows = parseRfxDump(text);
  const coverage = passportRfxCommodityCoverage(rows);
  const categories = JSON.parse(readFileSync(CATEGORIES, "utf8"));
  // Line count of row arrays in the dump, kept beside the parsed count so rows the engine
  // parser cannot read are visible rather than silently absent.
  const dumpRowLines = text.split(/\r?\n/).filter((line) => /^\s*\[/.test(line.replace(/^﻿/, ""))).length;
  return {
    schema: RECEIPT_SCHEMA,
    source_contract_id: "passport-public-rfx",
    source_url: RFX_DATA_URL,
    fetched_at: fetchedAt,
    publisher_last_modified: lastModified,
    source_sha256: createHash("sha256").update(bytes).digest("hex"),
    source_bytes: bytes.length,
    dump_row_lines: dumpRowLines,
    rows_parsed: rows.length,
    catalog: {
      path: "/data/procurement_codes/nyc-commodity-categories.json",
      version: categories.version,
      source_sha256: categories.source_sha256,
      l3_categories: categories.counts.l3,
    },
    match_rule: categories.match_rule,
    coverage,
  };
}

export function checkReceipt(receipt) {
  const errors = [];
  const c = receipt?.coverage || {};
  if (receipt?.schema !== RECEIPT_SCHEMA) errors.push("schema");
  if (c.total !== receipt.rows_parsed) errors.push("coverage.total != rows_parsed");
  if (c.matched + c.unmatched + c.no_label !== c.total) errors.push("matched + unmatched + no_label != total");
  const statuses = Object.values(c.by_status || {});
  for (const key of ["total", "matched", "unmatched", "no_label"]) {
    if (statuses.reduce((sum, row) => sum + row[key], 0) !== c[key]) errors.push(`by_status ${key} does not sum`);
  }
  if ((c.unmatched_labels || []).reduce((sum, row) => sum + row.rows, 0) !== c.unmatched) {
    errors.push("unmatched_labels do not sum to unmatched");
  }
  const categories = JSON.parse(readFileSync(CATEGORIES, "utf8"));
  if (receipt?.catalog?.version !== categories.version || receipt?.catalog?.source_sha256 !== categories.source_sha256) {
    errors.push("receipt was measured against a different categories artifact");
  }
  return errors;
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function main(argv = process.argv.slice(2)) {
  const check = option(argv, "--check");
  if (check) {
    const errors = checkReceipt(JSON.parse(readFileSync(check, "utf8")));
    if (errors.length) throw new Error(`${check}: ${errors.join("; ")}`);
    console.log(`${check} ok`);
    return;
  }
  const input = option(argv, "--input");
  const out = option(argv, "--out");
  if (!input || !out) throw new Error("--input and --out are required");
  const receipt = measurePassportRfxCommodityCategories(readFileSync(input, "utf8"), {
    fetchedAt: option(argv, "--fetched-at"),
    lastModified: option(argv, "--last-modified"),
  });
  // determinism-lint: allow write explicit measurement mode writes only the named receipt
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  const { total, matched, unmatched, no_label: noLabel } = receipt.coverage;
  console.log(JSON.stringify({ out, total, matched, unmatched, no_label: noLabel }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
}
