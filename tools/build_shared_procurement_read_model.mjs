#!/usr/bin/env node

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
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
import { buildProcurementBrowsePopulationShardArtifacts } from "../site/procurement_browse_population_shards.mjs";
import { recordsFromMtaOpportunityFixtures } from "../warehouse/lib/mta_opportunities.mjs";
import {
  mtaAnnualContractSourceSystemId,
  mtaCdAwardSourceSystemId,
} from "../worker/src/lib/mta_procurement_source_records.mjs";
import {
  attachCoherenceReceipt,
  sha256Bytes,
  sourceModelFingerprint,
} from "./lib/procurement_index_coherence.mjs";
import { moduleSourceFingerprint } from "./lib/module_source_fingerprint.mjs";
import {
  buildCheckReceipt,
  shardNamesOnDisk as shardNamesUnder,
  verifyFromCheckReceipt,
} from "./lib/generated_artifact_check_receipt.mjs";

const SPINE = new URL("../site/data/procurement_spine_sources.json", import.meta.url);
const MTA_FIXTURES = new URL("../warehouse/fixtures/authority-native-procurement/mta-opportunities.v1.json", import.meta.url);
const AWARDS = new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url);
const MODEL_OUT = new URL("../site/data/shared_procurement_read_model.json", import.meta.url);
const MODEL_SHARD_DIR = new URL("../site/data/shared_procurement_read_model/", import.meta.url);
const BROWSE_OUT = new URL("../site/data/procurement_browse_rows.json", import.meta.url);
const BROWSE_QUERY_OUT = new URL("../site/data/procurement_browse_query.json", import.meta.url);
const BROWSE_QUERY_ROWS_OUT = new URL("../site/data/procurement_browse_query_rows.json", import.meta.url);
const BROWSE_QUERY_SHARD_DIR = new URL("../site/data/procurement_browse_rows/", import.meta.url);
const BROWSE_POPULATION_SHARD_DIR = new URL("../site/data/procurement_browse_rows_population/", import.meta.url);
const DIGEST_OUT = new URL("../site/data/procurement_digest_snapshot.json", import.meta.url);
const MTA_SOURCES = new URL("../site/data/mta_procurement_sources.json", import.meta.url);
const ROOT = new URL("../", import.meta.url);
// Ephemeral, never committed: written beside the artifacts by a build so the
// immediately following --check can verify them without a second full build.
const CHECK_RECEIPT = new URL("../.artifacts/procurement-read-model-check.json", import.meta.url);
const GENERATOR = "tools/build_shared_procurement_read_model.mjs";
const INPUTS = [SPINE, AWARDS, MTA_FIXTURES, MTA_SOURCES];

function norm(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function record(sourceSystem, sourceSystemId, row, ingestedAt, sourceReceiptRef = null) {
  const serialized = JSON.stringify(row);
  return {
    source_system: sourceSystem,
    source_system_id: sourceSystemId,
    content_hash: `materialized:${sourceSystemId}`,
    normalized_snapshot: serialized,
    raw_snapshot: serialized,
    ingested_at: ingestedAt,
    ...(sourceReceiptRef ? { source_receipt_ref: sourceReceiptRef } : {}),
  };
}

function mtaRecord(sourceSystem, row, generatedAt) {
  const normalized = row?.normalized_snapshot || row?.normalized_row || row;
  const raw = row?.raw_snapshot || row?.raw_row || normalized;
  const sourceSystemId = sourceSystem === "mta_annual_contracts"
    ? mtaAnnualContractSourceSystemId(normalized)
    : sourceSystem === "mta_cd_awards"
      ? mtaCdAwardSourceSystemId(normalized)
      : row?.source_record_id || row?.transaction_number || row?.contract_number || null;
  if (!sourceSystemId || !normalized || !raw) return null;
  return {
    source_system: sourceSystem,
    source_system_id: String(sourceSystemId),
    content_hash: row?.content_hash || `materialized:${sourceSystemId}`,
    normalized_snapshot: JSON.stringify(normalized),
    raw_snapshot: JSON.stringify(raw),
    ingested_at: row?.retrieved_at || generatedAt || null,
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

function passportRfxRecord(row, generatedAt, sourceReceiptRef = null) {
  const epin = norm(row.epin_norm || row.epin);
  const rfpId = String(row.rfp_id || epin || "no-publisher-id").trim();
  return record(
    "passport_public_rfx",
    `rfx:${epin || "no-epin"}:${rfpId}`,
    { ...row, epin_norm: epin },
    generatedAt,
    sourceReceiptRef,
  );
}

function cityRecord(row, generatedAt) {
  return record("city_record", String(row.request_id), row, generatedAt);
}

export function procurementSourceRecordsFromMaterializations(spine, awards, nativeFixtures = null, mta = null) {
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
  const passportRfxRows = Array.isArray(spine?.rows?.passport_rfx)
    ? spine.rows.passport_rfx
    : [];
  for (const row of passportRows) {
    const pin = norm(row.epin_norm || row.epin);
    if (pin) selectedPins.add(pin);
  }
  const awardRows = (Array.isArray(awards?.rows) ? awards.rows : [])
    .filter((row) => selectedPins.has(norm(row.pin)) && row.request_id);
  const nativeRecords = recordsFromMtaOpportunityFixtures(nativeFixtures || {});
  const mtaGeneratedAt = mta?.generated_at || generatedAt;
  const mtaAnnual = (Array.isArray(mta?.annual_contracts) ? mta.annual_contracts : [])
    .map((row) => mtaRecord("mta_annual_contracts", row, mtaGeneratedAt))
    .filter(Boolean);
  const mtaAwards = (Array.isArray(mta?.cd_awards) ? mta.cd_awards : [])
    .map((row) => mtaRecord("mta_cd_awards", row, mtaGeneratedAt))
    .filter(Boolean);
  return [
    ...(Array.isArray(spine?.rows?.checkbook_nycha_contracts)
      ? spine.rows.checkbook_nycha_contracts.map((row) => checkbookNychaRecord(row, generatedAt)) : []),
    ...checkbookRows.map((row) => checkbookRecord(row, generatedAt)),
    ...passportRows.map((row) => passportRecord(row, generatedAt)),
    ...passportRfxRows.map((row) => passportRfxRecord(
      row,
      generatedAt,
      spine?.receipts?.passport_join || spine?.receipts?.population_pull || null,
    )),
    ...awardRows.map((row) => cityRecord(row, awards?.materialized_at || generatedAt)),
    ...nativeRecords,
    ...mtaAnnual,
    ...mtaAwards,
  ];
}

export function buildProcurementArtifacts(spine, awards, options = {}) {
  const nativeFixtures = options.nativeFixtures ?? (
    Array.isArray(spine?.rows?.passport_contracts) && spine.rows.passport_contracts.length
      ? JSON.parse(readFileSync(MTA_FIXTURES, "utf8"))
      : { fixtures: [] }
  );
  const sourceRecords = procurementSourceRecordsFromMaterializations(
    spine,
    awards,
    nativeFixtures,
    options.mtaSources,
  );
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
    mtaBytes: options.mtaBytes || (options.mtaSources ? Buffer.from(JSON.stringify(options.mtaSources)) : null),
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

function shardNamesOnDisk(dir) {
  return shardNamesUnder(fileURLToPath(dir));
}

/**
 * One family of emitted files: its serialized contents plus, for a sharded
 * family, the shard directory whose surplus files are pruned on a write and
 * reported as stale on a check.
 */
function shardedModelGroup(model) {
  const artifacts = buildSharedProcurementReadModelShardArtifacts(model);
  return {
    artifactLabel: "stale procurement artifact",
    shardLabel: "stale procurement shard",
    shardDir: MODEL_SHARD_DIR,
    expectedNames: new Set(artifacts.manifest.shards.map((descriptor) => descriptor.path.split("/").at(-1))),
    outputs: [
      [MODEL_OUT, serialized(artifacts.manifest)],
      ...artifacts.manifest.shards.map((descriptor, index) => [
        shardPath(descriptor),
        serialized(artifacts.shards[index]),
      ]),
    ],
  };
}

function browsePopulationShardPath(descriptor) {
  return new URL(`../site/data/${descriptor.path}`, import.meta.url);
}

// The Browse population is written as a small index plus bounded row shards.
// A single document holding every row grows with the population, and a source
// refresh had taken it past the size Cloudflare Pages will accept for one file.
function browsePopulationGroup(browse) {
  const artifacts = buildProcurementBrowsePopulationShardArtifacts(browse);
  return {
    artifactLabel: "stale procurement artifact",
    shardLabel: "stale procurement browse population shard",
    shardDir: BROWSE_POPULATION_SHARD_DIR,
    expectedNames: new Set(artifacts.manifest.shards.map((descriptor) => descriptor.path.split("/").at(-1))),
    outputs: [
      [BROWSE_OUT, serialized(artifacts.manifest)],
      ...artifacts.manifest.shards.map((descriptor, index) => [
        browsePopulationShardPath(descriptor),
        serialized(artifacts.shards[index]),
      ]),
    ],
  };
}

function browseQueryShardPath(descriptor) {
  return new URL(`../site/data/${descriptor.path}`, import.meta.url);
}

function browseQueryGroup(browse, sourceModelFingerprint) {
  const artifacts = buildProcurementBrowseQueryArtifacts({
    ...browse,
    source_model_fingerprint: sourceModelFingerprint,
  });
  return {
    artifactLabel: "stale procurement browse query artifact",
    shardLabel: "stale procurement browse query shard",
    shardDir: BROWSE_QUERY_SHARD_DIR,
    expectedNames: new Set(artifacts.manifest.shards.map((descriptor) => descriptor.path.split("/").at(-1))),
    outputs: [
      [BROWSE_QUERY_OUT, `${JSON.stringify(artifacts.manifest)}\n`],
      [BROWSE_QUERY_ROWS_OUT, serialized(artifacts.queryRowsArtifact)],
      ...artifacts.manifest.shards.map((descriptor, index) => [
        browseQueryShardPath(descriptor),
        serialized(artifacts.shards[index]),
      ]),
    ],
  };
}

function writeGroups(groups) {
  for (const group of groups) {
    if (group.shardDir) {
      mkdirSync(group.shardDir, { recursive: true });
      for (const name of shardNamesOnDisk(group.shardDir)) {
        if (!group.expectedNames.has(name)) rmSync(new URL(name, group.shardDir));
      }
    }
    for (const [path, content] of group.outputs) writeFileSync(path, content);
  }
}

function checkGroups(groups) {
  let current = true;
  for (const group of groups) {
    for (const [path, content] of group.outputs) {
      if (readFileSync(path, "utf8") !== content) {
        console.error(`${group.artifactLabel}: ${fileURLToPath(path)}`);
        current = false;
      }
    }
    if (!group.shardDir) continue;
    for (const name of shardNamesOnDisk(group.shardDir)) {
      if (!group.expectedNames.has(name)) {
        console.error(`${group.shardLabel}: ${fileURLToPath(new URL(name, group.shardDir))}`);
        current = false;
      }
    }
  }
  return current;
}

function repoRelative(url) {
  return relative(fileURLToPath(ROOT), fileURLToPath(url)).replaceAll("\\", "/");
}

function generatorFingerprint() {
  return moduleSourceFingerprint(fileURLToPath(import.meta.url), fileURLToPath(ROOT)).fingerprint;
}

function inputDigests() {
  return Object.fromEntries(INPUTS.map((url) => [repoRelative(url), sha256Bytes(readFileSync(url))]));
}


function receiptGroups(groups) {
  return groups.map((group) => ({
    artifactLabel: group.artifactLabel,
    shardLabel: group.shardLabel,
    shardDir: group.shardDir ? repoRelative(group.shardDir) : null,
    expectedNames: group.expectedNames,
    outputs: group.outputs.map(([path, content]) => [repoRelative(path), content]),
  }));
}

/**
 * Record what this build wrote, and the exact inputs and generator source it
 * wrote them from, so the --check that immediately follows can make the same
 * assertion a second full build would make.
 */
function writeCheckReceipt(model, groups) {
  const receipt = buildCheckReceipt({
    generator: GENERATOR,
    generatedAt: model.generated_at || null,
    rowCount: model.rows.length,
    generatorFingerprint: generatorFingerprint(),
    inputs: inputDigests(),
    groups: receiptGroups(groups),
  });
  mkdirSync(new URL("./", CHECK_RECEIPT), { recursive: true });
  writeFileSync(CHECK_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`);
}

/**
 * Verify the emitted artifacts from the recorded digests. Returns null when the
 * receipt cannot stand in for a rebuild — absent, from another generator
 * revision, or from different inputs — so the caller falls back to the full
 * build-and-compare path and the failure semantics stay identical.
 */
function checkFromReceipt() {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(CHECK_RECEIPT, "utf8"));
  } catch {
    return null;
  }
  const verified = verifyFromCheckReceipt({
    receipt,
    root: fileURLToPath(ROOT),
    generator: GENERATOR,
    generatorFingerprint: generatorFingerprint(),
    inputs: inputDigests(),
  });
  if (!verified) return null;
  for (const message of verified.stale) console.error(message);
  return verified;
}

function buildAndEmit() {
  const spineBytes = readFileSync(SPINE);
  const awardsBytes = readFileSync(AWARDS);
  const nativeFixturesBytes = readFileSync(MTA_FIXTURES);
  const mtaBytes = readFileSync(MTA_SOURCES);
  const { model, browse, digest } = buildProcurementArtifacts(
    JSON.parse(spineBytes.toString("utf8")),
    JSON.parse(awardsBytes.toString("utf8")),
    {
      spineBytes,
      awardsBytes,
      mtaBytes,
      nativeFixtures: JSON.parse(nativeFixturesBytes.toString("utf8")),
      mtaSources: JSON.parse(mtaBytes.toString("utf8")),
    },
  );
  const groups = [
    shardedModelGroup(model),
    browseQueryGroup(browse, model.coherence_receipt.source_model_fingerprint),
    browsePopulationGroup(browse),
    {
      artifactLabel: "stale procurement artifact",
      shardLabel: null,
      shardDir: null,
      expectedNames: null,
      outputs: [
        [DIGEST_OUT, serialized(digest)],
      ],
    },
  ];
  if (process.argv.includes("--check")) {
    if (!checkGroups(groups)) process.exitCode = 1;
    if (!process.exitCode) console.log(`procurement artifacts current (${model.rows.length} objects)`);
    return;
  }
  writeGroups(groups);
  writeCheckReceipt(model, groups);
  console.log(`wrote procurement artifacts (${model.rows.length} objects, ${browse.rows.length} Browse rows, ${digest.row_count} CROL-negative digest rows)`);
}

function main() {
  if (process.argv.includes("--check")) {
    const verified = checkFromReceipt();
    if (verified) {
      if (!verified.current) process.exitCode = 1;
      else console.log(`procurement artifacts current (${verified.rowCount} objects)`);
      return;
    }
  }
  buildAndEmit();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
