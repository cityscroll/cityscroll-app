#!/usr/bin/env node
/**
 * SBS Certified Business List (Open Data ci93-uc8s) -> sharded static directory under site/data/.
 *
 *   node tools/build_sbs_certified_business_directory.mjs --from-soda   # refresh (first-class refresh runs this)
 *   node tools/build_sbs_certified_business_directory.mjs --fixture --out DIR   # build the committed fixture set
 *   node tools/build_sbs_certified_business_directory.mjs --check [--site-dir DIR]   # read-only: integrity + serve gate
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_LIMITS, DIR, MANIFEST_PATH, acquisitionReceipt, buildDirectory, pullAll, readPublisherClock,
  serveGateFindings, verifyDirectoryFiles,
} from "../warehouse/lib/sbs_certified_business_directory.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteArg = process.argv.indexOf("--site-dir");
const SITE = siteArg > 0 ? resolve(process.argv[siteArg + 1]) : join(ROOT, "site");
const RECEIPT = join(ROOT, "warehouse/receipts/proof/sbs_certified_business_list_latest.json");
const FIXTURES = join(ROOT, "test/fixtures/sbs_certified_businesses");
const FIXTURE_LIMITS = Object.freeze({ max_rows: 50, max_bytes: 1024 * 1024, max_index_bytes: 512 * 1024 });

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const readSite = (rel) => readFileSync(join(SITE, rel), "utf8");

function writeSet(files, root) {
  for (const [rel, text] of files) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
  const keep = new Set([...files.keys()].map((p) => join(root, p)));
  const dir = join(root, DIR);
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (/^rows-\d{3}\.json$/.test(f) && !keep.has(join(dir, f))) rmSync(join(dir, f));
}

async function fromSoda() {
  const existing = existsSync(join(SITE, MANIFEST_PATH)) ? JSON.parse(readSite(MANIFEST_PATH)) : null;
  // determinism-lint: allow clock acquisition instant recorded on --from-soda only
  const collectedAt = new Date().toISOString();
  const clock = await readPublisherClock();
  if (existing && existing.rows_updated_at === clock.rowsUpdatedAt && existing.publisher_row_count === clock.publisherCount) {
    // Publisher did not move: keep every shard byte-for-byte and restamp only the manifest observation time.
    const manifest = { ...existing, collected_at: collectedAt };
    writeSet(new Map([[MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`]]), SITE);
    writeFileSync(RECEIPT, `${JSON.stringify(acquisitionReceipt(manifest, 2), null, 2)}\n`);
    console.log(`unchanged at publisher (${clock.rowsUpdatedAt}); manifest collected_at restamped`);
    return;
  }
  const pull = await pullAll();
  const built = buildDirectory(pull.rows, { collected_at: collectedAt, rows_updated_at: pull.rowsUpdatedAt, publisher_row_count: pull.publisherCount }, DEFAULT_LIMITS);
  const findings = serveGateFindings(built.manifest);
  if (existing && Math.abs(built.manifest.row_count - existing.row_count) > existing.row_count * 0.05) findings.push(`row_count moved more than 5% (${existing.row_count} -> ${built.manifest.row_count})`);
  if (findings.length) { console.error(`refused, last-good retained: ${findings.join("; ")}`); process.exit(1); }
  writeSet(built.files, SITE);
  writeFileSync(RECEIPT, `${JSON.stringify(acquisitionReceipt(built.manifest, pull.requests.length), null, 2)}\n`);
  console.log(`wrote ${built.manifest.row_count} rows in ${built.manifest.shards.length} shards`);
}

function check() {
  const findings = verifyDirectoryFiles(readSite);
  findings.push(...serveGateFindings(JSON.parse(readSite(MANIFEST_PATH))));
  if (findings.length) { console.error(findings.join("\n")); process.exit(1); }
  console.log("ok sbs certified business directory integrity and serve gate");
}

function fixture() {
  const out = arg("--out");
  if (!out) throw new Error("--fixture needs --out DIR");
  const rows = JSON.parse(readFileSync(join(FIXTURES, "sample-rows.json"), "utf8"));
  const fm = JSON.parse(readFileSync(join(FIXTURES, "fixture-manifest.json"), "utf8"));
  const built = buildDirectory(rows, { collected_at: fm.collected_at, rows_updated_at: fm.rows_updated_at, publisher_row_count: fm.publisher_row_count }, FIXTURE_LIMITS);
  writeSet(built.files, resolve(out));
  console.log(`fixture: ${rows.length} rows, ${built.manifest.shards.length} shards`);
}

async function main() {
  if (process.argv.includes("--from-soda")) return fromSoda();
  if (process.argv.includes("--check")) return check();
  if (process.argv.includes("--fixture")) return fixture();
  console.error("usage: --from-soda | --check | --fixture --out DIR"); process.exit(2);
}
main().catch((e) => { console.error(e); process.exit(1); });
