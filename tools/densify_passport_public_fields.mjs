#!/usr/bin/env node
/**
 * Restore PASSPort Public title / procurement_method / program / industry onto
 * the committed procurement spine. Source is the already-parsed public dump,
 * never invented scope or pricing lines.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { densifyPassportPublicFields } from "../site/passport_public_fields.mjs";
import { CONTRACT_DATA_URL, parseContractsDump } from "../worker/src/lib/passport_parse.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPINE = resolve(ROOT, "site/data/procurement_spine_sources.json");
const RECEIPT = resolve(ROOT, "warehouse/receipts/proof/passport_public_fields_latest.json");
const USER_AGENT = "CityScrollPassportPublicFields/1.0 (+https://cityscroll.org)";

function parseArgs(argv) {
  const args = { write: false, check: false, fromDump: null, live: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--live") args.live = true;
    else if (arg === "--from-dump") args.fromDump = resolve(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.live && args.fromDump) throw new Error("--live and --from-dump are mutually exclusive");
  return args;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function loadDump(args) {
  if (args.fromDump) return parseContractsDump(readFileSync(args.fromDump, "utf8"));
  if (!args.live) throw new Error("pass --from-dump <contractData.js> or --live");
  const response = await fetch(CONTRACT_DATA_URL, {
    headers: { "user-agent": USER_AGENT, accept: "application/javascript,text/javascript,*/*" },
  });
  if (!response.ok) throw new Error(`PASSPort dump HTTP ${response.status}`);
  return parseContractsDump(await response.text());
}

function receiptFrom(result, spine) {
  return {
    schema: "cityscroll.passport_public_fields_restore.v1",
    generated_at: new Date().toISOString(),
    spine_observed_on: spine.observed_on || null,
    dump_rows: result.dump_rows,
    spine_rows: result.spine_rows,
    matched: result.matched,
    titled: result.titled,
    method: result.method,
    omitted_scope_pricing_deliverables_location: true,
  };
}

const args = parseArgs(process.argv.slice(2));
const spine = readJson(SPINE);
const current = Array.isArray(spine.rows?.passport_contracts) ? spine.rows.passport_contracts : [];
const titledNow = current.filter((row) => row?.title).length;
if (args.check && !args.write && !args.fromDump && !args.live) {
  if (titledNow < 1) {
    console.error("passport public fields missing from committed spine");
    process.exit(1);
  }
  console.log(`passport public fields present: titled=${titledNow}/${current.length}`);
  process.exit(0);
}

const dumpRows = await loadDump(args);
const result = densifyPassportPublicFields(current, dumpRows);
const receipt = receiptFrom(result, spine);
if (args.write) {
  spine.rows.passport_contracts = result.rows;
  writeFileSync(SPINE, `${JSON.stringify(spine, null, 2)}\n`);
  writeFileSync(RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`wrote ${result.titled} titles and ${result.method} methods onto ${result.matched} matched spine rows`);
} else {
  console.log(JSON.stringify(receipt, null, 2));
}
