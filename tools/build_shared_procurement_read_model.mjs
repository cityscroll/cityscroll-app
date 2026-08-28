#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contractSearchDocumentToMoneyRow } from "../site/contract_search_bridge.mjs";
import {
  describeCrolAwardPublication,
} from "../site/crol_notice_publication_policy.mjs";
import { attachPassportPublicFields } from "../site/passport_public_fields.mjs";
import { buildProcurementDigestSnapshot } from "../site/procurement_digest_compile.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";
import { buildSharedProcurementReadModelShardArtifacts } from "../site/procurement_read_model_shards.mjs";
import { buildProcurementBrowseQueryArtifacts } from "../site/procurement_browse_query.mjs";
import {
  attachCoherenceReceipt,
  sourceModelFingerprint,
} from "./lib/procurement_index_coherence.mjs";

const SPINE = new URL("../site/data/procurement_spine_sources.json", import.meta.url);
const AWARDS = new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url);
const MODEL_OUT = new URL("../site/data/shared_procurement_read_model.json", import.meta.url);
const MODEL_SHARD_DIR = new URL("../site/data/shared_procurement_read_model/", import.meta.url);
const BROWSE_OUT = new URL("../site/data/procurement_browse_rows.json", import.meta.url);
const BROWSE_QUERY_OUT = new URL("../site/data/procurement_browse_query.json", import.meta.url);
const BROWSE_QUERY_SHARD_DIR = new URL("../site/data/procurement_browse_rows/", import.meta.url);
const DIGEST_OUT = new URL("../site/data/procurement_digest_snapshot.json", import.meta.url);

function norm(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function record(sourceSystem, sourceSystemId, row, ingestedAt) {
  const serialized = JSON.stringify(row);
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: `materialized:${sourceSystemId}`,
    normalized_snapshot: serialized,
    raw_snapshot: serialized,
    ingested_at: ingestedAt,
  };
}

function checkbookRecord(row, generatedAt) {
  const snapshot = {
    id: row.contract_id || row.prime_contract_id,
    contract_id: row.contract_id || row.prime_contract_id,
    pin: row.pin,
    title: row.title || null,
    vendor: row.prime_vendor,
    agency: row.agency,
    status: row.status,
    current: row.current,
    original: row.original,
    spent: row.spent,
    start: row.start,
    end: row.end,
    registered: row.registered,
    received: row.received,
    selection_bucket: row.selection_bucket,
  };
  const id = [
    "contract",
    String(snapshot.status || "contracts").toLowerCase(),
    snapshot.id || "no-contract-id",
    String(snapshot.vendor || "no-vendor").toUpperCase(),
    "prime-vendor",
    snapshot.received || snapshot.registered || snapshot.start || snapshot.end || "nodate",
  ].join(":");
  return record("checkbook_contracts", id, snapshot, generatedAt);
}

function checkbookNychaRecord(row, generatedAt) {
  const snapshot = {
    ...row,
    id: row.contract_id || row.id,
    contract_id: row.contract_id || row.id,
    vendor: row.vendor || row.source_vendor_name,
    agency: row.agency || row.source_agency_label,
    current: row.current ?? row.amount?.value ?? null,
    original: row.original ?? null,
    start: row.start || row.relevant_dates?.start_date || null,
    end: row.end || row.relevant_dates?.end_date || null,
    official_url: row.official_url || row.source_url || null,
  };
  const id = `contract:${snapshot.id}:${snapshot.record_type || "Agreement"}`;
  return record("checkbook_nycha_contracts", id, snapshot, row.retrieval_timestamp || generatedAt);
}

function passportRecord(row, generatedAt) {
  const epin = norm(row.epin_norm || row.epin);
  const snapshot = attachPassportPublicFields({ ...row, epin_norm: epin }, row);
  return record(
    "passport_public_contracts",
    `contract:${epin}:${String(row.ctr_id || epin).trim()}`,
    snapshot,
    generatedAt,
  );
}

function cityRecord(row, generatedAt) {
  return record("city_record", String(row.request_id), row, generatedAt);
}

export function procurementSourceRecordsFromMaterializations(spine, awards) {
  const generatedAt = spine?.generated_at || spine?.observed_on || null;
  const checkbookRows = Array.isArray(spine?.rows?.checkbook_contracts)
    ? spine.rows.checkbook_contracts.filter((row) => (
      row.selection_bucket === "new_unique"
      || row.selection_bucket === "passport_only"
      || row.selection_bucket === "passport_and_city_record"
    )) : [];
  const selectedPins = new Set(checkbookRows.map((row) => norm(row.pin)).filter(Boolean));
  // PASSPort Public is the publisher-backed contract corpus advertised by the
  // contracts search lane. Keep every row with its stable contract identity in
  // the served model; the rolling CROL predicate is only the publication rule
  // for notice-shaped rows, not a coverage filter for canonical contracts.
  const passportRows = Array.isArray(spine?.rows?.passport_contracts)
    ? spine.rows.passport_contracts
    : [];
  for (const row of passportRows) {
    const pin = norm(row.epin_norm || row.epin);
    if (pin) selectedPins.add(pin);
  }
  const awardRows = (Array.isArray(awards?.rows) ? awards.rows : [])
    .filter((row) => selectedPins.has(norm(row.pin)) && row.request_id);
  return [
    ...(Array.isArray(spine?.rows?.checkbook_nycha_contracts)
      ? spine.rows.checkbook_nycha_contracts.map((row) => checkbookNychaRecord(row, generatedAt)) : []),
    ...checkbookRows.map((row) => checkbookRecord(row, generatedAt)),
    ...passportRows.map((row) => passportRecord(row, generatedAt)),
    ...awardRows.map((row) => cityRecord(row, awards?.materialized_at || generatedAt)),
  ];
}

export function buildProcurementArtifacts(spine, awards, options = {}) {
  const sourceRecords = procurementSourceRecordsFromMaterializations(spine, awards);
  const publication = describeCrolAwardPublication({
    now: spine?.generated_at || null,
    selected: sourceRecords.length,
    census: {
      passport_contracts: Array.isArray(spine?.rows?.passport_contracts) ? spine.rows.passport_contracts.length : 0,
      checkbook_contracts: Array.isArray(spine?.rows?.checkbook_contracts) ? spine.rows.checkbook_contracts.length : 0,
      checkbook_nycha_contracts: Array.isArray(spine?.rows?.checkbook_nycha_contracts) ? spine.rows.checkbook_nycha_contracts.length : 0,
    },
  });
  const checkbookLookupRows = Array.isArray(spine?.rows?.checkbook_contracts)
    ? spine.rows.checkbook_contracts
    : [];
  const unsigned = {
    ...buildSharedProcurementReadModel({
      sourceRecords,
      checkbookLookupRows,
      generatedAt: spine?.generated_at || null,
      now: spine?.generated_at || null,
    }),
    publication,
  };
  const corpus = buildProcurementSearchDocuments(unsigned);
  const fingerprint = options.sourceModelFingerprint || sourceModelFingerprint({
    spineBytes: options.spineBytes || Buffer.from(JSON.stringify(spine)),
    awardsBytes: options.awardsBytes || Buffer.from(JSON.stringify(awards)),
  });
  const model = attachCoherenceReceipt(unsigned, {
    sourceModelFingerprint: fingerprint,
    advertisedRefs: corpus.documents.map((document) => document.object_ref),
    selectedRowCount: sourceRecords.length,
  });
  const browse = {
    schema: "cityscroll.procurement_browse_rows.v1",
    generated_at: model.generated_at,
    source_model_schema: model.schema,
    row_count: corpus.documents.length,
    coverage: corpus.coverage,
    publication,
    rows: corpus.documents.map(contractSearchDocumentToMoneyRow).filter(Boolean).map((row) => {
      const { search_document: _searchDocument, ...publicRow } = row;
      return publicRow;
    }),
  };
  const digest = buildProcurementDigestSnapshot(model);
  return { model, browse, digest };
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function shardPath(descriptor) {
  return new URL(`../site/data/${descriptor.path}`, import.meta.url);
}

function checkOrWriteShardedModel(model) {
  const artifacts = buildSharedProcurementReadModelShardArtifacts(model);
  const outputs = [
    [MODEL_OUT, serialized(artifacts.manifest)],
    ...artifacts.manifest.shards.map((descriptor, index) => [
      shardPath(descriptor),
      serialized(artifacts.shards[index]),
    ]),
  ];
  const expectedNames = new Set(artifacts.manifest.shards.map((descriptor) => descriptor.path.split("/").at(-1)));
  const actualNames = new Set(existsSync(MODEL_SHARD_DIR)
    ? readdirSync(MODEL_SHARD_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^shard-\d+\.json$/.test(entry.name))
      .map((entry) => entry.name)
    : []);
  if (process.argv.includes("--check")) {
    let current = true;
    for (const [path, content] of outputs) {
      if (readFileSync(path, "utf8") !== content) {
        console.error(`stale procurement artifact: ${fileURLToPath(path)}`);
        current = false;
      }
    }
    for (const name of actualNames) {
      if (!expectedNames.has(name)) {
        console.error(`stale procurement shard: ${fileURLToPath(new URL(name, MODEL_SHARD_DIR))}`);
        current = false;
      }
    }
    return current;
  }
  mkdirSync(MODEL_SHARD_DIR, { recursive: true });
  for (const name of actualNames) {
    if (!expectedNames.has(name)) rmSync(new URL(name, MODEL_SHARD_DIR));
  }
  for (const [path, content] of outputs) writeFileSync(path, content);
  return true;
}

function browseQueryShardPath(descriptor) {
  return new URL(`../site/data/${descriptor.path}`, import.meta.url);
}

function checkOrWriteBrowseQueryArtifacts(browse, sourceModelFingerprint) {
  const artifacts = buildProcurementBrowseQueryArtifacts({
    ...browse,
    source_model_fingerprint: sourceModelFingerprint,
  });
  const outputs = [
    [BROWSE_QUERY_OUT, `${JSON.stringify(artifacts.manifest)}\n`],
    ...artifacts.manifest.shards.map((descriptor, index) => [
      browseQueryShardPath(descriptor),
      serialized(artifacts.shards[index]),
    ]),
  ];
  const expectedNames = new Set(artifacts.manifest.shards.map((descriptor) => descriptor.path.split("/").at(-1)));
  const actualNames = existsSync(BROWSE_QUERY_SHARD_DIR)
    ? readdirSync(BROWSE_QUERY_SHARD_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^shard-\d+\.json$/.test(entry.name))
      .map((entry) => entry.name)
    : [];
  if (process.argv.includes("--check")) {
    let current = true;
    for (const [path, content] of outputs) {
      if (readFileSync(path, "utf8") !== content) {
        console.error(`stale procurement browse query artifact: ${fileURLToPath(path)}`);
        current = false;
      }
    }
    for (const name of actualNames) {
      if (!expectedNames.has(name)) {
        console.error(`stale procurement browse query shard: ${fileURLToPath(new URL(name, BROWSE_QUERY_SHARD_DIR))}`);
        current = false;
      }
    }
    return current;
  }
  mkdirSync(BROWSE_QUERY_SHARD_DIR, { recursive: true });
  for (const name of actualNames) {
    if (!expectedNames.has(name)) rmSync(new URL(name, BROWSE_QUERY_SHARD_DIR));
  }
  for (const [path, content] of outputs) writeFileSync(path, content);
  return true;
}

function main() {
  const spineBytes = readFileSync(SPINE);
  const awardsBytes = readFileSync(AWARDS);
  const { model, browse, digest } = buildProcurementArtifacts(
    JSON.parse(spineBytes.toString("utf8")),
    JSON.parse(awardsBytes.toString("utf8")),
    { spineBytes, awardsBytes },
  );
  const outputs = [
    [BROWSE_OUT, serialized(browse)],
    [DIGEST_OUT, serialized(digest)],
  ];
  if (process.argv.includes("--check")) {
    const modelCurrent = checkOrWriteShardedModel(model);
    const browseQueryCurrent = checkOrWriteBrowseQueryArtifacts(browse, model.coherence_receipt.source_model_fingerprint);
    for (const [path, content] of outputs) {
      if (readFileSync(path, "utf8") !== content) {
        console.error(`stale procurement artifact: ${fileURLToPath(path)}`);
        process.exitCode = 1;
      }
    }
    if (!modelCurrent || !browseQueryCurrent) process.exitCode = 1;
    if (!process.exitCode) console.log(`procurement artifacts current (${model.rows.length} objects)`);
    return;
  }
  checkOrWriteShardedModel(model);
  checkOrWriteBrowseQueryArtifacts(browse, model.coherence_receipt.source_model_fingerprint);
  for (const [path, content] of outputs) writeFileSync(path, content);
  console.log(`wrote procurement artifacts (${model.rows.length} objects, ${browse.rows.length} Browse rows, ${digest.row_count} CROL-negative digest rows)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
