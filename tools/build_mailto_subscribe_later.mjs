#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRIMARY_JOURNEY_FILES,
  buildMailtoSubscribeLaterReceipt,
  findSubscribeMailtoAddresses,
  validateMailtoSubscribeLaterReceipt,
} from "../site/mailto_subscribe_later.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INPUT = join(ROOT, "docs/evidence/mailto-subscribe-later/fs05-prerequisite.json");
const OUTPUT = join(ROOT, "docs/evidence/mailto-subscribe-later/receipt.json");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const serialized = (value) => `${JSON.stringify(value, null, 2)}\n`;

function primaryJourneyHits() {
  const hits = [];
  for (const relative of PRIMARY_JOURNEY_FILES) {
    const source = readFileSync(join(ROOT, relative), "utf8");
    for (const address of findSubscribeMailtoAddresses(source)) {
      hits.push({ file: relative, address });
    }
  }
  return hits;
}

export function build() {
  const prerequisite = readJson(INPUT);
  const receipt = buildMailtoSubscribeLaterReceipt({
    prerequisite,
    primaryJourneyHits: primaryJourneyHits(),
    now: prerequisite.observed_at,
  });
  const validation = validateMailtoSubscribeLaterReceipt(receipt);
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return receipt;
}

function main() {
  const receipt = build();
  const bytes = serialized(receipt);
  if (process.argv.includes("--check")) {
    if (readFileSync(OUTPUT, "utf8") !== bytes) {
      throw new Error(`stale mailto-subscribe-later receipt: ${OUTPUT}`);
    }
    console.log(`checked FS-10 mailto later experiment: ${receipt.experiment_state}`);
    return;
  }
  writeFileSync(OUTPUT, bytes);
  console.log(`wrote ${OUTPUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
