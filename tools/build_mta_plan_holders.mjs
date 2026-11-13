#!/usr/bin/env node
// Build site/data/mta_plan_holders.json from the retained MTA Construction & Development
// current-opportunities page and its plan-holder listing PDFs.
//
//   node tools/build_mta_plan_holders.mjs [--input <dir>] [--output <file>] [--check]
//
// The input directory holds retrieval.json (URL, time, status, bytes and sha256 of every file)
// and the files themselves. A file whose bytes no longer match its receipt is refused, and so is a
// listing that pdftotext cannot read: nothing is written. --check rebuilds and compares.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildMtaPlanHolders, sha256 } from "../warehouse/lib/mta_plan_holders.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_INPUT = path.join(ROOT, "warehouse/fixtures/authority-native-procurement/mta-plan-holders");
export const DEFAULT_OUTPUT = path.join(ROOT, "site/data/mta_plan_holders.json");

export function pdfLayoutText(bytes) {
  const dir = mkdtempSync(path.join(tmpdir(), "mta-plan-holders-"));
  try {
    const pdf = path.join(dir, "listing.pdf");
    writeFileSync(pdf, bytes);
    const result = spawnSync("pdftotext", ["-layout", pdf, "-"], { encoding: "utf8", timeout: 20_000 });
    if (result.error || result.status !== 0 || !result.stdout.trim()) throw new Error(`pdftotext could not read the listing (${result.error?.code || result.status})`);
    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checked(dir, entry) {
  const bytes = readFileSync(path.join(dir, entry.file));
  if (entry.http_status !== 200) throw new Error(`${entry.file}: retained with HTTP ${entry.http_status}`);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error(`${entry.file}: bytes do not match retrieval.json`);
  return bytes;
}

export function buildFromRetained(dir = DEFAULT_INPUT, { layoutText = pdfLayoutText } = {}) {
  const receipt = JSON.parse(readFileSync(path.join(dir, "retrieval.json"), "utf8"));
  if (receipt.schema !== "cityscroll.mta_plan_holders_retrieval.v1") throw new Error("unexpected retrieval receipt");
  const html = checked(dir, receipt.page).toString("utf8");
  const listings = new Map(receipt.listings.map((entry) => {
    const bytes = checked(dir, entry);
    return [entry.url, { bytes, text: layoutText(bytes), retrieved_at: entry.retrieved_at }];
  }));
  return buildMtaPlanHolders({ page: { html }, listings, retrievedAt: receipt.page.retrieved_at });
}

function main(argv) {
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const output = arg("--output") || DEFAULT_OUTPUT;
  const serialized = `${JSON.stringify(buildFromRetained(arg("--input") || DEFAULT_INPUT), null, 2)}\n`;
  if (argv.includes("--check")) {
    let current = null;
    try { current = readFileSync(output, "utf8"); } catch { current = null; }
    if (current !== serialized) {
      process.stderr.write(`${path.relative(ROOT, output)} is out of date; run node tools/build_mta_plan_holders.mjs\n`);
      return 1;
    }
    process.stdout.write(`${path.relative(ROOT, output)} is current\n`);
    return 0;
  }
  writeFileSync(output, serialized);
  process.stdout.write(`wrote ${path.relative(ROOT, output)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
