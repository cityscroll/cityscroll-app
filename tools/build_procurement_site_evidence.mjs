#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  addressShardKey,
  parseAddressQuery,
} from "../site/precomputed_address_geocoder.mjs";
import {
  materializeProcurementSiteEvidence,
  validateProcurementSiteEvidence,
} from "../warehouse/lib/procurement_site_evidence.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OCP_PATH = path.join(ROOT, "site/data/ocp_awards_warehouse_lookup.json");
const FIXTURE_PATH = path.join(ROOT, "warehouse/fixtures/procurement-site-evidence/field_cases.json");
const OUT_PATH = path.join(ROOT, "site/data/procurement_site_evidence.json");

function stable(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolverFromFixture(fixture) {
  const shardCount = 64;
  const manifest = {
    schema: "cityscroll.address-index-manifest.v1",
    generated_at: fixture.source_snapshot.pad_generated_at,
    source: {
      name: "NYC Department of City Planning Property Address Directory",
      version: fixture.source_snapshot.pad_version,
    },
    shard_count: shardCount,
  };
  const shards = new Map();
  for (const row of fixture.pad_rows || []) {
    const query = parseAddressQuery(row.address);
    assert.notEqual(query.status, "not_full_address", `fixture PAD address is not parseable: ${row.address}`);
    const key = addressShardKey(query.street, shardCount);
    if (!shards.has(key)) shards.set(key, { schema: "cityscroll.address-index-shard.v1", key, streets: {} });
    const shard = shards.get(key);
    shard.streets[query.street] ||= [];
    shard.streets[query.street].push([
      query.house_sort,
      query.house_sort,
      0,
      row.bbl,
      row.zip,
    ]);
  }
  return { manifest, shards };
}

async function loadInputs() {
  const [ocpText, fixtureText] = await Promise.all([
    readFile(OCP_PATH, "utf8"),
    readFile(FIXTURE_PATH, "utf8"),
  ]);
  return {
    ocp: JSON.parse(ocpText),
    fixture: JSON.parse(fixtureText),
  };
}

function mergeSourceRows(retainedRows, fixtureRows) {
  const sourceById = new Map(fixtureRows.map((row) => [String(row.request_id), row]));
  return retainedRows.map((row) => ({
    ...row,
    ...(sourceById.get(String(row.request_id)) || {}),
    _source_acquired: sourceById.has(String(row.request_id)),
  }));
}

export async function buildProcurementSiteEvidence() {
  const { ocp, fixture } = await loadInputs();
  const retainedRows = Array.isArray(ocp.rows) ? ocp.rows : [];
  const sourceRows = mergeSourceRows(retainedRows, fixture.award_rows);
  const doc = materializeProcurementSiteEvidence({
    retainedAwardRows: retainedRows,
    awardRows: sourceRows,
    hearingRows: fixture.hearing_rows,
    resolver: resolverFromFixture(fixture),
    sourceSnapshot: fixture.source_snapshot,
  });
  validateProcurementSiteEvidence(doc);
  return doc;
}

async function main(argv) {
  const check = argv.includes("--check");
  const doc = await buildProcurementSiteEvidence();
  const rendered = stable(doc);
  if (check) {
    const existing = await readFile(OUT_PATH, "utf8");
    if (existing !== rendered) throw new Error("procurement site evidence artifact is stale");
    console.log(`procurement site evidence current: ${doc.population.selected_award_ids} selected awards, ${doc.population.accepted_sites} accepted sites`);
    return;
  }
  await writeFile(OUT_PATH, rendered);
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)}: ${doc.population.selected_award_ids} selected awards, ${doc.population.accepted_sites} accepted sites`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
