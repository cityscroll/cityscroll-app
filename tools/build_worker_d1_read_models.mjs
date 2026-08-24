#!/usr/bin/env node

/**
 * Build deployment SQL for the two large Worker read models.
 *
 * The committed JSON artifacts remain the build inputs. The generated SQL is
 * deliberately ephemeral: CI applies it to the existing D1 binding and does
 * not put either corpus back into the Worker bundle.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "worker", ".d1-read-models");
const SEARCH_INPUT = resolve(ROOT, "worker", "src", "data", "keyword_search_index.json");
const OCP_INPUT = resolve(ROOT, "worker", "src", "data", "ocp_awards_warehouse_lookup.json");

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function nullable(value) {
  return value == null || value === "" ? "NULL" : sqlString(value);
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function statementsForSearch(doc) {
  const lines = [
    "DELETE FROM keyword_search_fts;",
    "DELETE FROM keyword_search_documents;",
    "DELETE FROM keyword_search_families;",
  ];
  for (const [familyId, family] of Object.entries(doc?.families || {})) {
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

function parseArgs(argv) {
  const out = { outputDir: DEFAULT_OUT };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--output-dir") out.outputDir = resolve(ROOT, argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

const { outputDir } = parseArgs(process.argv);
const keyword = JSON.parse(readFileSync(SEARCH_INPUT, "utf8"));
const ocp = JSON.parse(readFileSync(OCP_INPUT, "utf8"));
mkdirSync(outputDir, { recursive: true });
const keywordPath = resolve(outputDir, "keyword_search_read_model.sql");
const ocpPath = resolve(outputDir, "ocp_awards_read_model.sql");
writeFileSync(keywordPath, statementsForSearch(keyword));
writeFileSync(ocpPath, statementsForOcp(ocp));
console.log(JSON.stringify({
  keyword_sql: keywordPath,
  keyword_bytes: readFileSync(keywordPath).byteLength,
  keyword_documents: Object.values(keyword.families || {}).reduce((n, family) => n + (family.documents || []).length, 0),
  ocp_sql: ocpPath,
  ocp_bytes: readFileSync(ocpPath).byteLength,
  ocp_rows: Array.isArray(ocp.rows) ? ocp.rows.length : 0,
}));
