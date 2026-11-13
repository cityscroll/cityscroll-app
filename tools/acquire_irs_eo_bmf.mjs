#!/usr/bin/env node
/**
 * Acquire the IRS Exempt Organizations Business Master File extract for New York.
 *
 *   node tools/acquire_irs_eo_bmf.mjs
 *   node tools/acquire_irs_eo_bmf.mjs --check
 *   node tools/acquire_irs_eo_bmf.mjs --out-dir DIR
 *
 * Writes eo_ny.csv + receipt under .artifacts/first-class-inputs/irs-eo-bmf-ny/ (gitignored).
 * On failure, keeps the last verified capture and exits non-zero.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IRS_COLUMNS, IRS_FILE_URL, normalizeIrsCsv } from "../entity_resolution/registers/irs_eo_bmf.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = path.join(ROOT, ".artifacts", "first-class-inputs", "irs-eo-bmf-ny");
const USER_AGENT = "CityScrollRegisterAcquisition/1.0 (+https://cityscroll.org; public register ingest)";

function parseArgs(argv) {
  const out = {
    check: false,
    outDir: DEFAULT_DIR,
    csvPath: null,
    receiptPath: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") out.check = true;
    else if (a === "--out-dir") out.outDir = path.resolve(argv[++i]);
    else if (a === "--csv") out.csvPath = argv[++i];
    else if (a === "--receipt") out.receiptPath = argv[++i];
    else if (!a.startsWith("-") && !out.csvPath) out.csvPath = a;
    else if (!a.startsWith("-") && !out.receiptPath) out.receiptPath = a;
  }
  if (out.csvPath) {
    out.csvPath = path.isAbsolute(out.csvPath) ? out.csvPath : path.join(ROOT, out.csvPath);
    out.outDir = path.dirname(out.csvPath);
  }
  if (out.receiptPath) {
    out.receiptPath = path.isAbsolute(out.receiptPath) ? out.receiptPath : path.join(ROOT, out.receiptPath);
  }
  return out;
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function loadReceipt(dir) {
  const receiptPath = path.join(dir, "receipt.json");
  const csvPath = path.join(dir, "eo_ny.csv");
  if (!existsSync(receiptPath) || !existsSync(csvPath)) return null;
  try {
    return {
      receipt: JSON.parse(readFileSync(receiptPath, "utf8")),
      csvPath,
      bytes: readFileSync(csvPath),
    };
  } catch {
    return null;
  }
}

function validateCapture(bytes, receipt) {
  const problems = [];
  if (!bytes?.byteLength) problems.push("empty csv");
  if (receipt?.bytes != null && receipt.bytes !== bytes.byteLength) {
    problems.push(`receipt bytes ${receipt.bytes} != file ${bytes.byteLength}`);
  }
  const digest = sha256(bytes);
  if (receipt?.sha256 && receipt.sha256 !== digest) problems.push("sha256 mismatch");
  const text = Buffer.from(bytes).toString("utf8");
  const normalized = normalizeIrsCsv(text, { collected_at: receipt?.collected_at || new Date().toISOString() });
  if (!normalized.ok) problems.push(...(normalized.problems || ["normalize failed"]));
  else {
    if (receipt?.row_count != null && receipt.row_count !== normalized.row_count) {
      problems.push(`row_count ${receipt.row_count} != parsed ${normalized.row_count}`);
    }
    if (normalized.row_count < 100_000) problems.push(`row_count ${normalized.row_count} below floor 100000`);
  }
  return { ok: problems.length === 0, problems, normalized, digest };
}

export async function acquireIrsEoBmf({
  outDir = DEFAULT_DIR,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  mkdirSync(outDir, { recursive: true });
  const retained = loadReceipt(outDir);
  const csvPath = path.join(outDir, "eo_ny.csv");
  const receiptPath = path.join(outDir, "receipt.json");
  let response;
  try {
    response = await fetchImpl(IRS_FILE_URL, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/csv,*/*" },
    });
  } catch (error) {
    const err = new Error(`IRS download failed: ${error?.message || error}`);
    err.lastGoodPreserved = Boolean(retained);
    throw err;
  }
  if (!response.ok) {
    const err = new Error(`IRS download HTTP ${response.status}`);
    err.lastGoodPreserved = Boolean(retained);
    throw err;
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const collected_at = now().toISOString();
  const lastModified = response.headers.get("last-modified");
  const digest = sha256(buf);
  const normalized = normalizeIrsCsv(buf.toString("utf8"), { collected_at });
  if (!normalized.ok || normalized.row_count < 100_000) {
    const err = new Error(`IRS CSV refused: ${(normalized.problems || ["bad normalize"]).join("; ")} rows=${normalized.row_count}`);
    err.lastGoodPreserved = Boolean(retained);
    throw err;
  }
  const receipt = {
    schema: "cityscroll.irs_eo_bmf_ny.acquisition_receipt.v1",
    source_url: IRS_FILE_URL,
    collected_at,
    last_modified: lastModified,
    bytes: buf.byteLength,
    sha256: digest,
    row_count: normalized.row_count,
    columns: [...IRS_COLUMNS],
    distinct_eins: normalized.row_count,
  };
  const tmpCsv = `${csvPath}.tmp`;
  const tmpReceipt = `${receiptPath}.tmp`;
  writeFileSync(tmpCsv, buf);
  writeFileSync(tmpReceipt, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(tmpCsv, csvPath);
  renameSync(tmpReceipt, receiptPath);
  return receipt;
}

function checkMode(outDir) {
  const loaded = loadReceipt(outDir);
  if (!loaded) {
    console.error("no acquired IRS capture to check");
    process.exitCode = 1;
    return;
  }
  const result = validateCapture(loaded.bytes, loaded.receipt);
  if (!result.ok) {
    console.error(JSON.stringify({ ok: false, problems: result.problems }, null, 2));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    ok: true,
    bytes: loaded.bytes.byteLength,
    row_count: result.normalized.row_count,
    sha256: result.digest,
    collected_at: loaded.receipt.collected_at,
  }));
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.check) {
    checkMode(args.outDir);
    return;
  }
  try {
    const receipt = await acquireIrsEoBmf({ outDir: args.outDir });
    console.log(JSON.stringify({ ok: true, ...receipt }));
  } catch (error) {
    console.error(error?.message || error);
    if (error?.lastGoodPreserved) console.error("retained last verified IRS capture");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
