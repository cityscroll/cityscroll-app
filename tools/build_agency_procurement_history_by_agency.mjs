#!/usr/bin/env node
// Publish, for every agency the City Record or Checkbook names, the last 24 months of City Record
// solicitation notices, the response window, and registered contracts with their median.
//
// Usage:
//   node tools/build_agency_procurement_history_by_agency.mjs            # pull City Record, write site/data/agency_procurement_history_by_agency.json
//   node tools/build_agency_procurement_history_by_agency.mjs --fixture  # offline: test/fixtures/agency-history, writes under .artifacts
//   node tools/build_agency_procurement_history_by_agency.mjs --out <file>  # write somewhere else (a dry run of the acquisition)
//   node tools/build_agency_procurement_history_by_agency.mjs --as-of 2026-11-11  # pin the window end (tests, backfills)
//
// A failed or empty pull, or an artifact over its byte bound, exits non-zero before anything is
// written, so the last good file stays. A short or partly invalid pull is published marked
// incomplete with its reasons. The registered-contract side is read from the committed projection
// (site/data/analytics_registered_contracts), which its own refresh keeps current.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgencyHistorySnapshot,
  fetchAgencyHistoryNotices,
  calendarDay,
} from "./lib/agency_procurement_history_by_agency.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const AGENCY_HISTORY_OUT = path.join(ROOT, "site", "data", "agency_procurement_history_by_agency.json");
const FIXTURE_DIR = path.join(ROOT, "test", "fixtures", "agency-history");
const CONTRACTS_MANIFEST = path.join(ROOT, "site", "data", "analytics_registered_contracts.json");

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readRegisteredContracts(manifestPath = CONTRACTS_MANIFEST) {
  const manifest = await readJson(manifestPath);
  if (manifest.schema !== "cityscroll.analytics_registered_contracts.v1") {
    throw new Error("agency history requires the registered-contract projection");
  }
  const rows = [];
  for (const shard of manifest.shards || []) {
    const body = await readJson(path.resolve(path.dirname(manifestPath), shard.path));
    if (!Array.isArray(body.rows) || body.rows.length !== shard.row_count) {
      throw new Error(`registered-contract shard ${shard.path} does not match its manifest row count`);
    }
    for (const row of body.rows) rows.push(row);
  }
  if (rows.length !== manifest.row_count) throw new Error("registered-contract shards do not add up to the manifest row count");
  return { rows, snapshotDate: manifest.snapshot_date };
}

export async function buildAgencyHistory({ fetchImpl = fetch, now = new Date(), asOf, fixture = false } = {}) {
  if (fixture) {
    const notices = await readJson(path.join(FIXTURE_DIR, "notices.json"));
    const contracts = await readJson(path.join(FIXTURE_DIR, "contracts.json"));
    const meta = await readJson(path.join(FIXTURE_DIR, "source.json"));
    return buildAgencyHistorySnapshot(
      { notices, noticeCount: meta.notice_count, rowsUpdatedAt: meta.rows_updated_at, contracts, contractsSnapshotDate: meta.contracts_snapshot_date },
      { now: new Date(meta.generated_at), asOf: asOf || meta.as_of },
    );
  }
  const day = asOf || calendarDay(now);
  const inputs = await fetchAgencyHistoryNotices(fetchImpl, { asOf: day });
  const registered = await readRegisteredContracts();
  return buildAgencyHistorySnapshot(
    { ...inputs, contracts: registered.rows, contractsSnapshotDate: registered.snapshotDate },
    { now, asOf: day },
  );
}

async function main() {
  const fixture = process.argv.includes("--fixture");
  const flag = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
  };
  const built = await buildAgencyHistory({ fixture, now: new Date(), asOf: flag("--as-of") });
  const rendered = `${JSON.stringify(built, null, 2)}\n`;
  const outFlag = flag("--out");
  const out = outFlag
    ? path.resolve(outFlag)
    : fixture
      ? path.join(ROOT, ".artifacts", "agency_procurement_history_by_agency.fixture.json")
      : AGENCY_HISTORY_OUT;
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, rendered);
  console.log(`wrote ${path.relative(ROOT, out)} (${Buffer.byteLength(rendered)} bytes) agencies=${built.count} population=${built.population.state}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
