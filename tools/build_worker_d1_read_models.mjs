#!/usr/bin/env node

/**
 * Build deployment SQL for the large Worker read models.
 *
 * The committed JSON artifacts remain the build inputs. The generated SQL is
 * deliberately ephemeral: CI applies it to the existing D1 binding and does
 * not put the corpora back into the Worker bundle.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { displayNameFor, entityIntelligenceSummary, graphLinkRows } from "./d1_graph_link_rows.mjs";
import {
  readKeywordSearchIndexShard,
  readKeywordSearchIndexShardManifest,
} from "../site/keyword_search_index_shards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "worker", ".d1-read-models");
const SEARCH_SHARD_DIR = resolve(ROOT, "worker", "src", "data", "keyword_search_index_shards");
// OCP has one committed public read model. The Worker deployment SQL consumes
// it directly instead of maintaining a second 18.5 MB bundle input.
const OCP_INPUT = resolve(ROOT, "site", "data", "ocp_awards_warehouse_lookup.json");
const ENTITY_INPUT = resolve(ROOT, "worker", "src", "data", "entity_intelligence_lookup.json");

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function nullable(value) {
  return value == null || value === "" ? "NULL" : sqlString(value);
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function statementsForSearch({ manifest, dir }) {
  const lines = [
    "DELETE FROM keyword_search_fts;",
    "DELETE FROM keyword_search_documents;",
    "DELETE FROM keyword_search_families;",
  ];
  for (const descriptor of manifest?.shards || []) {
    const familyId = descriptor.family;
    const family = readKeywordSearchIndexShard(dir, descriptor);
    lines.push(`INSERT INTO keyword_search_families (family_id, source, as_of, source_row_count, indexed_count, coverage_json) VALUES (${sqlString(familyId)}, ${nullable(family.source)}, ${nullable(family.as_of)}, ${Number(family.source_row_count) || 0}, ${Number(family.indexed_count) || 0}, ${sqlString(json(family.coverage || []))});`);
    for (const [ordinal, document] of (family.documents || []).entries()) {
      const documentId = `${familyId}:${ordinal}`;
      const sourceRefs = Array.isArray(document.source_observation_refs)
        ? document.source_observation_refs : [];
      const searchText = [document.title, document.summary, document.search_text]
        .filter(Boolean).join(" ");
      lines.push(`INSERT INTO keyword_search_documents (document_id, family_id, ordinal, object_ref, source_observation_refs_json, document_json, search_text) VALUES (${sqlString(documentId)}, ${sqlString(familyId)}, ${ordinal}, ${nullable(document.object_ref)}, ${sqlString(json(sourceRefs))}, ${sqlString(json(document))}, ${sqlString(searchText)});`);
      lines.push(`INSERT INTO keyword_search_fts (document_id, family_id, search_text) VALUES (${sqlString(documentId)}, ${sqlString(familyId)}, ${sqlString(searchText)});`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function rowKey(row, ordinal) {
  return [row?.request_id, row?.pin, row?.start_date, ordinal]
    .map((value) => String(value ?? "").trim()).join("|");
}

function statementsForOcp(doc) {
  const lines = ["DELETE FROM ocp_awards_warehouse;"];
  for (const [ordinal, row] of (doc?.rows || []).entries()) {
    lines.push(`INSERT INTO ocp_awards_warehouse (row_key, request_id, start_date, agency_name, type_of_notice_description, short_title, pin, contract_amount, vendor_name) VALUES (${sqlString(rowKey(row, ordinal))}, ${nullable(row.request_id)}, ${nullable(row.start_date)}, ${nullable(row.agency_name)}, ${nullable(row.type_of_notice_description)}, ${nullable(row.short_title)}, ${nullable(row.pin == null ? null : String(row.pin).trim())}, ${nullable(row.contract_amount)}, ${nullable(row.vendor_name)});`);
  }
  lines.push("");
  return lines.join("\n");
}

function gzipBase64(value) {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");
}

function statementsForEntityIntelligence(doc) {
  const lines = [
    "DELETE FROM entity_intelligence_graph_links;",
    "DELETE FROM entity_intelligence_subject_refs;",
    "DELETE FROM entity_intelligence_entities;",
    "DELETE FROM entity_intelligence_meta;",
  ];
  const summary = entityIntelligenceSummary(doc);
  lines.push(`INSERT INTO entity_intelligence_meta (id, generated_at, observation_count, entity_count, multi_domain_count, summary_json) VALUES ('current', ${nullable(doc.generated_at)}, ${Number(doc.observation_count) || 0}, ${Number(doc.entity_count) || 0}, ${Number(doc.multi_domain_count) || 0}, ${sqlString(json(summary))});`);
  for (const [entityRef, dossier] of Object.entries(doc?.by_ref || {})) {
    lines.push(`INSERT INTO entity_intelligence_entities (entity_ref, kind, display_name, payload, payload_encoding) VALUES (${sqlString(entityRef)}, ${nullable(dossier?.root?.kind)}, ${nullable(displayNameFor(dossier, entityRef))}, ${sqlString(gzipBase64(dossier))}, 'gzip-base64');`);
  }
  for (const [subjectRef, links] of Object.entries(doc?.by_subject_ref || {})) {
    for (const link of links || []) {
      const entityRef = String(link?.entity_ref || "").trim();
      const relation = String(link?.relation || "").trim();
      const confidence = String(link?.confidence || "").trim();
      if (!entityRef || !relation) continue;
      lines.push(`INSERT INTO entity_intelligence_subject_refs (subject_ref, entity_ref, relation, confidence, link_json) VALUES (${sqlString(subjectRef)}, ${sqlString(entityRef)}, ${sqlString(relation)}, ${sqlString(confidence)}, ${sqlString(json(link))});`);
    }
  }
  for (const row of graphLinkRows(doc)) {
    lines.push(`INSERT INTO entity_intelligence_graph_links (to_ref, from_ref, link_type, link_json) VALUES (${sqlString(row.to_ref)}, ${sqlString(row.from_ref)}, ${sqlString(row.link_type)}, ${sqlString(json(row.payload))});`);
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { outputDir: DEFAULT_OUT, check: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--output-dir") out.outputDir = resolve(ROOT, argv[++i]);
    else if (argv[i] === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

const { outputDir, check } = parseArgs(process.argv);
const keyword = readKeywordSearchIndexShardManifest(SEARCH_SHARD_DIR);
const ocp = JSON.parse(readFileSync(OCP_INPUT, "utf8"));
const entity = JSON.parse(readFileSync(ENTITY_INPUT, "utf8"));
mkdirSync(outputDir, { recursive: true });
const keywordPath = resolve(outputDir, "keyword_search_read_model.sql");
const ocpPath = resolve(outputDir, "ocp_awards_read_model.sql");
const entityPath = resolve(outputDir, "entity_intelligence_read_model.sql");
writeFileSync(keywordPath, statementsForSearch(keyword));
writeFileSync(ocpPath, statementsForOcp(ocp));
writeFileSync(entityPath, statementsForEntityIntelligence(entity));
console.log(JSON.stringify({
  check,
  keyword_sql: keywordPath,
  keyword_bytes: readFileSync(keywordPath).byteLength,
  keyword_documents: Number(keyword.manifest?.logical_index?.document_count) || 0,
  ocp_sql: ocpPath,
  ocp_bytes: readFileSync(ocpPath).byteLength,
  ocp_rows: Array.isArray(ocp.rows) ? ocp.rows.length : 0,
  entity_sql: entityPath,
  entity_bytes: readFileSync(entityPath).byteLength,
  entity_count: Object.keys(entity.by_ref || {}).length,
}));
