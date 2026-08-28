#!/usr/bin/env node

/** Scheduled/build-time acquisition receipt for the official ALP bulk XML. */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const SOURCE_URL = "https://files.amlegal.com/pdffiles/NewYorkCity/Admin/XML.zip";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hashFile(path) {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

const output = resolve(arg("output", ".artifacts/admin-code-source/Admin-XML.zip"));
const receiptPath = resolve(arg("receipt", `${output}.receipt.json`));
mkdirSync(dirname(output), { recursive: true });
const response = await fetch(SOURCE_URL, {
  headers: { Accept: "application/zip", "User-Agent": "CityScrollAdminCodeAcquisition/1.0 (+https://cityscroll.org)" },
});
if (!response.ok) throw new Error(`American Legal Publishing bulk XML returned HTTP ${response.status}`);
writeFileSync(output, Buffer.from(await response.arrayBuffer()));
const observedAt = new Date().toISOString();
const receipt = {
  schema: "cityscroll.source_acquisition_receipt.v1",
  source_contract_id: "nyc-administrative-code",
  source_system: "american_legal_publishing",
  source_url: SOURCE_URL,
  observed_at: observedAt,
  status: "succeeded",
  run_id: `nyc-administrative-code:${observedAt}`,
  publisher_clock_basis: null,
  publisher_updated_at: null,
  bytes: statSync(output).size,
  content_hash: hashFile(output),
  delivery: "build_time_only",
  resident_time_publisher_fetch: false,
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ output, receipt: receiptPath, ...receipt }));
