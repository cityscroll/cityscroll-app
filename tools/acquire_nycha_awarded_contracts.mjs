#!/usr/bin/env node
// Retain NYCHA's public Awarded Contracts list as site/data/nycha_awarded_contracts_snapshot.json.
//
// Usage:
//   node tools/acquire_nycha_awarded_contracts.mjs             # pull NYCHA, check, write the snapshot
//   node tools/acquire_nycha_awarded_contracts.mjs --out <file> # write somewhere else (a dry run)
//
// The pull is checked against the shape the reader needs (tools/lib/nycha_awarded_contracts.mjs). A
// good pull replaces the snapshot. A failed pull (network, not JSON, shape changed, counts out of band)
// keeps the last good rows and writes into the snapshot that the list in use is that earlier one, with
// the reason and the time it was last read; the exit code stays 0 and the line printed says so. With no
// earlier snapshot a failed pull exits non-zero and writes nothing. It never tries to get past a
// challenge page: anything that is not JSON is a failed pull.
//
// Runs on the daily first-class refresh (the same 06:40 UTC job as the City Record artifacts): five
// requests a day, two seconds apart.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireNychaAwardedContracts } from "./lib/nycha_awarded_contracts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NYCHA_SNAPSHOT_OUT = path.join(ROOT, "site", "data", "nycha_awarded_contracts_snapshot.json");

async function readPrevious(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    // An unreadable snapshot is not a last good one; say so rather than hide it.
    console.error(`previous snapshot unreadable (${error.message}); treating as none`);
    return null;
  }
}

export async function runAcquisition({ out = NYCHA_SNAPSHOT_OUT, fetchImpl = fetch, now = new Date(), sleep, delayMs, minRows } = {}) {
  const previous = await readPrevious(out);
  const snapshot = await acquireNychaAwardedContracts({ fetchImpl, now, previous, sleep, delayMs, minRows });
  const rendered = `${JSON.stringify(snapshot, null, 2)}\n`;
  await mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.tmp`;
  await writeFile(tmp, rendered);
  await rename(tmp, out);
  return { snapshot, bytes: Buffer.byteLength(rendered), out };
}

async function main() {
  const flag = process.argv.indexOf("--out");
  const out = flag > 0 && process.argv[flag + 1] ? path.resolve(process.argv[flag + 1]) : NYCHA_SNAPSHOT_OUT;
  const { snapshot, bytes } = await runAcquisition({ out });
  const feed = snapshot.feed;
  const where = path.relative(ROOT, out);
  if (feed.state === "snapshot_fallback") {
    console.warn(`NYCHA list NOT refreshed: ${feed.fallback_reason} (${feed.fallback_text}) problems=${JSON.stringify(feed.shape_problems)}`);
    console.warn(`kept the last good snapshot read ${feed.fetched_at}; wrote ${where} (${bytes} bytes) count=${snapshot.count} state=snapshot_fallback`);
  } else {
    console.log(`wrote ${where} (${bytes} bytes) count=${snapshot.count} rfq_numbered=${snapshot.rfq_numbered_count} state=live`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
