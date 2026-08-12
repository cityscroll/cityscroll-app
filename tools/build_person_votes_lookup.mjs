#!/usr/bin/env node
/**
 * Materialize site/data/person_votes_lookup.json from people_domain_observations.
 *
 * Offline / precompute-first: no live Legistar or meeting-outcomes fetch.
 * Refresh people densify first when roll-call coverage changes:
 *
 *   node tools/build_rules_meetings_domain_observations.mjs --people-only
 *   node tools/build_person_votes_lookup.mjs
 *
 * Options:
 *   --check   require committed lookup + demo person 7801 has votes
 *   --fixture use worker test people domain fixture instead of site data
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPersonVotesLookup,
  personVotesForId,
  PERSON_VOTES_DEMO_IDS,
} from "../site/person_votes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site/data/person_votes_lookup.json");
const PEOPLE = path.join(ROOT, "site/data/people_domain_observations.json");
const FIXTURE = path.join(
  ROOT,
  "worker/test/fixtures/entity-intelligence/people_domain_observations.json",
);
const RECEIPT_DIR = path.join(ROOT, "site/data/legistar_sources/verification_receipts");
function retentionReceiptPathForPeople(peopleDoc = null) {
  const fallback = path.join(RECEIPT_DIR, "official_person_vote_retention_2026-08-02.json");
  try {
    const names = readdirSync(RECEIPT_DIR)
      .filter((name) => name.startsWith("official_person_vote_retention_") && name.endsWith(".json"))
      .sort()
      .reverse();
    const eventIds = new Set(
      (peopleDoc?.rows || []).map((row) => String(row?.event_id || "").trim()).filter(Boolean),
    );
    for (const name of names) {
      const candidate = path.join(RECEIPT_DIR, name);
      try {
        const receipt = JSON.parse(readFileSync(candidate, "utf8"));
        const receiptEvents = new Set((receipt.by_event || []).map((row) => String(row?.event_id || "").trim()));
        if (eventIds.size && [...eventIds].every((id) => receiptEvents.has(id))) return candidate;
      } catch {
        // Ignore an incomplete receipt and continue to the prior dated receipt.
      }
    }
    return names.length ? path.join(RECEIPT_DIR, names[0]) : fallback;
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const out = { check: false, fixture: false };
  for (const a of argv) {
    if (a === "--check") out.check = true;
    else if (a === "--fixture") out.fixture = true;
  }
  return out;
}

function loadPeople(fixture) {
  const p = fixture ? FIXTURE : PEOPLE;
  if (!existsSync(p)) {
    throw new Error(`people domain missing: ${path.relative(ROOT, p)}`);
  }
  return JSON.parse(readFileSync(p, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    if (!existsSync(OUT)) {
      console.error(`missing ${path.relative(ROOT, OUT)}`);
      process.exit(1);
    }
    const doc = JSON.parse(readFileSync(OUT, "utf8"));
    if (!doc.by_person_id || !doc.person_count) {
      console.error("person_votes_lookup: empty by_person_id");
      process.exit(1);
    }
    const people = loadPeople(false);
    const expectedCoverage = buildPersonVotesLookup(people, {
      retentionReceipt: JSON.parse(readFileSync(retentionReceiptPathForPeople(people), "utf8")),
    }).coverage;
    if (JSON.stringify(doc.coverage) !== JSON.stringify(expectedCoverage)) {
      console.error("person_votes_lookup: coverage block is stale — rebuild the lookup");
      process.exit(1);
    }
    for (const id of PERSON_VOTES_DEMO_IDS) {
      const bag = personVotesForId(doc, id);
      if (!bag || !bag.votes.length) {
        console.error(`person_votes_lookup: demo person ${id} has no votes`);
        process.exit(1);
      }
    }
    console.log(
      `person_votes_lookup ok persons=${doc.person_count} rows=${doc.row_count}`,
    );
    return;
  }

  const people = loadPeople(args.fixture);
  const retentionReceipt = args.fixture
    ? null
    : JSON.parse(readFileSync(retentionReceiptPathForPeople(people), "utf8"));
  const lookup = buildPersonVotesLookup(people, { retentionReceipt });
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(lookup, null, 2)}\n`);
  console.log(
    `wrote ${path.relative(ROOT, OUT)} persons=${lookup.person_count} rows=${lookup.row_count}`,
  );
}

main();
