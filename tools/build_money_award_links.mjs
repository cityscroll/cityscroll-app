#!/usr/bin/env node
// Publish, for every City Record solicitation since 2023-01-01, whether an award notice is
// linked to it, none is published yet, or it cannot be linked and why.
//
// Usage:
//   node tools/build_money_award_links.mjs            # pull City Record, write site/data/money_award_links.json
//   node tools/build_money_award_links.mjs --fixture  # offline: test/fixtures/award-links, writes under .artifacts
//   node tools/build_money_award_links.mjs --out <file>  # write somewhere else (a dry run of the acquisition)
//
// NYCHA's Awarded Contracts list is not fetched here. tools/acquire_nycha_awarded_contracts.mjs
// retains it as site/data/nycha_awarded_contracts_snapshot.json (checked, dated, with the last good
// list kept when NYCHA's feed changes); this builder reads that file and joins it by RFQ number.
//
// A failed or empty pull, or an artifact over its byte bound, exits non-zero before anything
// is written, so the last good file stays. A short or partly invalid pull is published marked
// incomplete with its reasons.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildMoneyAwardLinksSnapshot,
  fetchMoneyAwardLinksInputs,
} from "./lib/money_award_links.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MONEY_AWARD_LINKS_OUT = path.join(ROOT, "site", "data", "money_award_links.json");
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "award-links");
export const NYCHA_SNAPSHOT_PATH = path.join(ROOT, "site", "data", "nycha_awarded_contracts_snapshot.json");

/** The retained NYCHA list, or null when there is none (the join then says the list is unavailable). */
export async function readNychaSnapshot(file = NYCHA_SNAPSHOT_PATH) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURE_DIR, name), "utf8"));
}

export async function buildMoneyAwardLinks({ fetchImpl = fetch, now = new Date(), fixture = false, nychaSnapshot } = {}) {
  const inputs = fixture
    ? {
      solicitations: [...await loadFixture("solicitations_raw.json"), ...await loadFixture("nycha_solicitations_raw.json")],
      awards: await loadFixture("awards_raw.json"),
      solicitationCount: (await loadFixture("solicitations_raw.json")).length + (await loadFixture("nycha_solicitations_raw.json")).length,
      awardCount: (await loadFixture("awards_raw.json")).length,
      nychaSnapshot: nychaSnapshot !== undefined ? nychaSnapshot : await loadFixture("nycha_snapshot_live.json"),
    }
    : {
      ...(await fetchMoneyAwardLinksInputs(fetchImpl)),
      nychaSnapshot: nychaSnapshot !== undefined ? nychaSnapshot : await readNychaSnapshot(),
    };
  return buildMoneyAwardLinksSnapshot(inputs, { now });
}

async function main() {
  const fixture = process.argv.includes("--fixture");
  const built = await buildMoneyAwardLinks({ fixture, now: new Date() });
  const rendered = `${JSON.stringify(built, null, 2)}\n`;
  const flag = process.argv.indexOf("--out");
  const out = flag > 0 && process.argv[flag + 1]
    ? path.resolve(process.argv[flag + 1])
    : fixture
      ? path.join(ROOT, ".artifacts", "money_award_links.fixture.json")
      : MONEY_AWARD_LINKS_OUT;
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, rendered);
  console.log(`wrote ${path.relative(ROOT, out)} (${Buffer.byteLength(rendered)} bytes) count=${built.count} population=${built.population.state}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
