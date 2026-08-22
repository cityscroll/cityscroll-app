#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contractSearchDocumentToMoneyRow } from "../site/contract_search_bridge.mjs";
import { attachPassportPublicFields } from "../site/passport_public_fields.mjs";
import { buildProcurementSearchDocuments } from "../site/procurement_search_producer.mjs";
import { buildSharedProcurementReadModel } from "../site/shared_procurement_read_model.mjs";

const SPINE = new URL("../site/data/procurement_spine_sources.json", import.meta.url);
const AWARDS = new URL("../site/data/ocp_awards_warehouse_lookup.json", import.meta.url);
const MODEL_OUT = new URL("../site/data/shared_procurement_read_model.json", import.meta.url);
const BROWSE_OUT = new URL("../site/data/procurement_browse_rows.json", import.meta.url);

function json(url) {
  return JSON.parse(readFileSync(url, "utf8"));
}

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
  const selectedContracts = new Set(checkbookRows.map((row) => norm(row.contract_id || row.prime_contract_id)).filter(Boolean));
  const selectedPins = new Set(checkbookRows.map((row) => norm(row.pin)).filter(Boolean));
  const passportRows = (Array.isArray(spine?.rows?.passport_contracts) ? spine.rows.passport_contracts : [])
    .filter((row, index) => (
      index < 500
      || selectedContracts.has(norm(row.contract_id))
      || selectedPins.has(norm(row.epin_norm || row.epin))
    ));
  for (const row of passportRows) {
    const pin = norm(row.epin_norm || row.epin);
    if (pin) selectedPins.add(pin);
  }
  const awardRows = (Array.isArray(awards?.rows) ? awards.rows : [])
    .filter((row) => selectedPins.has(norm(row.pin)) && row.request_id);
  return [
    ...checkbookRows.map((row) => checkbookRecord(row, generatedAt)),
    ...passportRows.map((row) => passportRecord(row, generatedAt)),
    ...awardRows.map((row) => cityRecord(row, awards?.materialized_at || generatedAt)),
  ];
}

export function buildProcurementArtifacts(spine, awards) {
  const sourceRecords = procurementSourceRecordsFromMaterializations(spine, awards);
  const model = buildSharedProcurementReadModel({
    sourceRecords,
    generatedAt: spine?.generated_at || null,
    now: spine?.generated_at || null,
  });
  const corpus = buildProcurementSearchDocuments(model);
  const browse = {
    schema: "cityscroll.procurement_browse_rows.v1",
    generated_at: model.generated_at,
    source_model_schema: model.schema,
    row_count: corpus.documents.length,
    coverage: corpus.coverage,
    rows: corpus.documents.map(contractSearchDocumentToMoneyRow).filter(Boolean).map((row) => {
      const { search_document: _searchDocument, ...publicRow } = row;
      return publicRow;
    }),
  };
  return { model, browse };
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const { model, browse } = buildProcurementArtifacts(json(SPINE), json(AWARDS));
  const outputs = [[MODEL_OUT, serialized(model)], [BROWSE_OUT, serialized(browse)]];
  if (process.argv.includes("--check")) {
    for (const [path, content] of outputs) {
      if (readFileSync(path, "utf8") !== content) {
        console.error(`stale procurement artifact: ${fileURLToPath(path)}`);
        process.exitCode = 1;
      }
    }
    if (!process.exitCode) console.log(`procurement artifacts current (${model.rows.length} objects)`);
    return;
  }
  for (const [path, content] of outputs) writeFileSync(path, content);
  console.log(`wrote procurement artifacts (${model.rows.length} objects, ${browse.rows.length} Browse rows)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
