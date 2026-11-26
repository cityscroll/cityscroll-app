#!/usr/bin/env node
/**
 * SBS Certified Business List (Open Data ci93-uc8s) -> sharded static directory under site/data/.
 *
 *   node tools/build_sbs_certified_business_directory.mjs --from-soda   # refresh (first-class refresh runs this)
 *   node tools/build_sbs_certified_business_directory.mjs --fixture --out DIR   # build the committed fixture set
 *   node tools/build_sbs_certified_business_directory.mjs --check [--site-dir DIR]   # read-only: integrity + serve gate
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LIMITS, DIR, MANIFEST_PATH, acquisitionReceipt, buildDirectory, pullAll, readPublisherClock,
  serveGateFindings, verifyDirectoryFiles,
} from "../warehouse/lib/sbs_certified_business_directory.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT = "warehouse/receipts/proof/sbs_certified_business_list_latest.json";
const FIXTURES = join(ROOT, "test/fixtures/sbs_certified_businesses");
const FIXTURE_LIMITS = Object.freeze({ max_rows: 50, max_bytes: 1024 * 1024, max_index_bytes: 512 * 1024 });

function parseArgs(argv) {
  const out = { check: false, fromSoda: false, fixture: false, outDir: null, siteDir: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--check") out.check = true;
    // determinism-lint: allow external-data opt-in SODA acquisition flag; --check never sets it
    else if (token === "--from-soda") out.fromSoda = true;
    else if (token === "--fixture") out.fixture = true;
    else if (token === "--out") out.outDir = argv[++i] || null;
    else if (token === "--site-dir") out.siteDir = argv[++i] || null;
  }
  return out;
}

function writeFilesAtomically(files, root) {
  // determinism-lint: allow write non-check materialization output
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(join(root, ".sbs-publication-"));
  try {
    for (const [rel, text] of files) {
      const stagedPath = join(staging, rel);
      // determinism-lint: allow write non-check materialization output
      mkdirSync(dirname(stagedPath), { recursive: true });
      // determinism-lint: allow write non-check materialization output
      writeFileSync(stagedPath, text);
      // determinism-lint: allow write non-check materialization output
      mkdirSync(dirname(join(root, rel)), { recursive: true });
    }
    // A complete directory lists the payloads first and the manifest last.
    for (const rel of files.keys()) {
      // determinism-lint: allow write non-check materialization output
      renameSync(join(staging, rel), join(root, rel));
    }
  } finally {
    // determinism-lint: allow write non-check materialization output
    rmSync(staging, { recursive: true, force: true });
  }
}

function publishDirectory(files, root) {
  writeFilesAtomically(files, root);
  const dir = join(root, DIR);
  for (const file of readdirSync(dir)) {
    if (/^rows-\d{3}\.json$/.test(file) && !files.has(`${DIR}/${file}`)) {
      // determinism-lint: allow write non-check stale-shard cleanup
      rmSync(join(dir, file));
    }
  }
}

function writeReceipt(manifest, requests) {
  const receipt = acquisitionReceipt(manifest, requests);
  writeFilesAtomically(new Map([[RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`]]), ROOT);
}

async function fromSoda(site) {
  const readSite = (rel) => readFileSync(join(site, rel), "utf8");
  const existing = existsSync(join(site, MANIFEST_PATH)) ? JSON.parse(readSite(MANIFEST_PATH)) : null;
  // determinism-lint: allow clock acquisition instant recorded on --from-soda only
  const collectedAt = new Date().toISOString();
  // determinism-lint: allow external-data live SODA path only for --from-soda rematerialization
  const clock = await readPublisherClock();
  if (existing && existing.rows_updated_at === clock.rowsUpdatedAt && existing.publisher_row_count === clock.publisherCount) {
    // Publisher did not move: keep every shard byte-for-byte and restamp only the manifest observation time.
    const manifest = { ...existing, collected_at: collectedAt };
    writeFilesAtomically(new Map([[MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`]]), site);
    writeReceipt(manifest, 2);
    console.log(`unchanged at publisher (${clock.rowsUpdatedAt}); manifest collected_at restamped`);
    return;
  }
  // determinism-lint: allow external-data live SODA path only for --from-soda rematerialization
  const pull = await pullAll();
  const built = buildDirectory(pull.rows, {
    collected_at: collectedAt,
    rows_updated_at: pull.rowsUpdatedAt,
    publisher_row_count: pull.publisherCount,
  }, DEFAULT_LIMITS);
  const findings = serveGateFindings(built.manifest);
  if (existing && Math.abs(built.manifest.row_count - existing.row_count) > existing.row_count * 0.05) {
    findings.push(`row_count moved more than 5% (${existing.row_count} -> ${built.manifest.row_count})`);
  }
  if (findings.length) {
    console.error(`refused, last-good retained: ${findings.join("; ")}`);
    process.exit(1);
  }
  publishDirectory(built.files, site);
  writeReceipt(built.manifest, pull.requests.length);
  console.log(`wrote ${built.manifest.row_count} rows in ${built.manifest.shards.length} shards`);
}

function check(site) {
  const readSite = (rel) => readFileSync(join(site, rel), "utf8");
  const findings = verifyDirectoryFiles(readSite);
  findings.push(...serveGateFindings(JSON.parse(readSite(MANIFEST_PATH))));
  if (findings.length) {
    console.error(findings.join("\n"));
    process.exit(1);
  }
  console.log("ok sbs certified business directory integrity and serve gate");
}

function fixture(outDir) {
  if (!outDir) throw new Error("--fixture needs --out DIR");
  const rows = JSON.parse(readFileSync(join(FIXTURES, "sample-rows.json"), "utf8"));
  const fm = JSON.parse(readFileSync(join(FIXTURES, "fixture-manifest.json"), "utf8"));
  const built = buildDirectory(rows, {
    collected_at: fm.collected_at,
    rows_updated_at: fm.rows_updated_at,
    publisher_row_count: fm.publisher_row_count,
  }, FIXTURE_LIMITS);
  publishDirectory(built.files, resolve(outDir));
  console.log(`fixture: ${rows.length} rows, ${built.manifest.shards.length} shards`);
}

async function main() {
  const args = parseArgs(process.argv);
  const site = args.siteDir ? resolve(args.siteDir) : join(ROOT, "site");

  if (args.check) {
    check(site);
    return;
  }

  if (args.fromSoda) {
    await fromSoda(site);
    return;
  }

  if (args.fixture) {
    fixture(args.outDir);
    return;
  }

  // determinism-lint: allow external-data usage banner naming the non-check SODA mode
  console.error("usage: --from-soda | --check | --fixture --out DIR");
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
