#!/usr/bin/env node
/**
 * Fetch NYC Council Members (uvw5-9znb) and materialize the person hub.
 *
 *   node tools/build_person_hub.mjs
 *   node tools/build_person_hub.mjs --fixture
 *   node tools/build_person_hub.mjs --check
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPersonHubLookup, personHubForId } from "../site/person_hub.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "site/data/person_hub_lookup.json");
const WORKER_OUT = path.join(ROOT, "worker/src/data/person_hub_lookup.json");
const FIXTURE = path.join(ROOT, "test/fixtures/person_hub/council_members.json");
const PEOPLE_VOTES = path.join(ROOT, "site/data/person_votes_lookup.json");
const SODA = "https://data.cityofnewyork.us/resource/uvw5-9znb.json";
const UA = "CityScroll/1.0 (+https://cityscroll.org; person-hub materialization)";

function parseArgs(argv) {
  const out = { check: false, fixture: false };
  for (const a of argv) {
    if (a === "--check") out.check = true;
    else if (a === "--fixture") out.fixture = true;
  }
  return out;
}

async function fetchAll() {
  const rows = [];
  let offset = 0;
  const page = 1000;
  while (true) {
    const url = `${SODA}?$limit=${page}&$offset=${offset}&$order=council_member_id,term_start`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`SODA uvw5-9znb HTTP ${res.status}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < page) break;
    offset += page;
  }
  return rows;
}

function loadVotes() {
  if (!existsSync(PEOPLE_VOTES)) return null;
  return JSON.parse(readFileSync(PEOPLE_VOTES, "utf8"));
}

function mainCheck() {
  if (!existsSync(OUT)) {
    console.error(`missing ${path.relative(ROOT, OUT)}`);
    process.exit(1);
  }
  const doc = JSON.parse(readFileSync(OUT, "utf8"));
  if (!doc.by_person_id || !doc.person_count) {
    console.error("person_hub_lookup empty");
    process.exit(1);
  }
  for (const id of ["7801", "7785"]) {
    const bag = personHubForId(doc, id);
    if (!bag) {
      console.error(`person_hub missing demo ${id}`);
      process.exit(1);
    }
  }
  if (!doc.gate?.promoted) {
    console.error("person_hub gate not promoted");
    process.exit(1);
  }
  console.log(
    `person_hub ok persons=${doc.person_count} terms=${doc.term_row_count} vote_join=${doc.join?.vote_corpus_join_rate}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    mainCheck();
    return;
  }
  let rows;
  let retrievedAt = new Date().toISOString();
  if (args.fixture) {
    rows = JSON.parse(readFileSync(FIXTURE, "utf8"));
    retrievedAt = "fixture";
  } else {
    rows = await fetchAll();
  }
  const lookup = buildPersonHubLookup(rows, {
    retrievedAt,
    peopleDoc: loadVotes(),
  });
  mkdirSync(path.dirname(OUT), { recursive: true });
  const body = `${JSON.stringify(lookup, null, 2)}\n`;
  writeFileSync(OUT, body);
  mkdirSync(path.dirname(WORKER_OUT), { recursive: true });
  writeFileSync(WORKER_OUT, body);
  console.log(
    `wrote ${path.relative(ROOT, OUT)} persons=${lookup.person_count} terms=${lookup.term_row_count} `
    + `vote_join=${lookup.join.vote_corpus_join_rate} promoted=${lookup.gate.promoted}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
