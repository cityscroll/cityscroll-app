#!/usr/bin/env node

/**
 * Build deployment SQL for the large Worker read models.
 *
 * The committed JSON artifacts remain the build inputs. The generated SQL is
 * deliberately ephemeral: CI applies it to the existing D1 binding and does
 * not put the corpora back into the Worker bundle.
 *
 * Legacy SQL generator. Rows come from tools/d1_stable_keys.mjs, keyed by the identities the manifest
 * declares, so a rerun over the same inputs names the same logical rows in the
 * same order. Two publication shapes are generated from those rows:
 *
 *   --mode rebuild   the guarded full rebuild: table-wide deletes, then
 *                    one insert per row. This is the rollback path and the first
 *                    publication path.
 *   --mode upsert    keyed convergence: one INSERT ... ON CONFLICT DO UPDATE per row
 *                    (delete-then-insert for the FTS5 companion, using its parent's
 *                    indexed key lookup to retain the same rowid). Applying the same
 *                    file twice leaves rows unchanged. Removed
 *                    rows are deleted only when --deletes names a delta plan from
 *                    tools/d1_delta_plan.mjs; the plan's delete operations become
 *                    keyed DELETE statements ahead of the upserts.
 *
 * Rebuild once before switching an existing ordinal-keyed publication to upserts;
 * upserts alone do not remove legacy keys or realign an existing FTS companion.
 * A rebuild plan also requires --mode rebuild: --deletes consumes only delete
 * operations, not the plan's truncate or insert instructions. Upsert mode writes
 * every current row, including rows the planner marks unchanged.
 *
 * Usage:
 *   node tools/build_worker_d1_read_models.mjs [--output-dir <dir>] [--mode upsert]
 *                                              [--allow-rebuild <capability>]
 *                                              [--deletes <plan.json>] [--check]
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadManifest, modelEntry } from "./d1_manifest.mjs";
import { TABLE_COLUMNS, VIRTUAL_TABLES, keyColumns, tableRows } from "./d1_stable_keys.mjs";
import {
  readKeywordSearchIndexShard,
  readKeywordSearchIndexShardManifest,
} from "../site/keyword_search_index_shards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "worker", ".d1-read-models");
export const BUILD_MODES = Object.freeze(["rebuild", "upsert"]);
export const REBUILD_ALLOW_TOKEN = "d1-explicit-rebuild-v1";
const OUTPUT_FILES = Object.freeze({
  keyword_search: "keyword_search_read_model.sql",
  ocp_awards: "ocp_awards_read_model.sql",
  entity_intelligence: "entity_intelligence_read_model.sql",
});

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Read the manifest source document for one model from the repository inputs. */
export function readSourceDocument(entry, root = ROOT) {
  const path = resolve(root, entry.source.path);
  if (entry.source.kind === "keyword_search_index_shards") {
    const { dir, manifest } = readKeywordSearchIndexShardManifest(path);
    const families = {};
    for (const descriptor of manifest?.shards || []) {
      families[descriptor.family] = readKeywordSearchIndexShard(dir, descriptor);
    }
    return { families, manifest };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function insertStatement(entry, row) {
  const columns = TABLE_COLUMNS[row.table];
  const values = columns.map((column) => sqlLiteral(row.columns[column]));
  if (VIRTUAL_TABLES.has(row.table)) {
    return `INSERT INTO ${row.table} (rowid, ${columns.join(", ")}) VALUES (${companionRowid(entry, row.table, row.key_values)}, ${values.join(", ")});`;
  }
  return `INSERT INTO ${row.table} (${columns.join(", ")}) VALUES (${values.join(", ")});`;
}

function keyPredicate(entry, table, keyValues) {
  const columns = keyColumns(entry, table);
  if (columns.length !== keyValues.length) {
    throw new Error(`d1 read models: ${table} key has ${keyValues.length} values for ${columns.length} key columns`);
  }
  return columns.map((column, index) => `${column} = ${sqlLiteral(keyValues[index])}`).join(" AND ");
}

function companionRowid(entry, table, keyValues) {
  const target = entry.tables.find((candidate) => candidate.name === table).identity.of;
  return `(SELECT rowid FROM ${target} WHERE ${keyPredicate(entry, target, keyValues)})`;
}

export function deleteStatement(entry, table, keyValues) {
  const predicate = VIRTUAL_TABLES.has(table)
    ? `rowid = ${companionRowid(entry, table, keyValues)}`
    : keyPredicate(entry, table, keyValues);
  return `DELETE FROM ${table} WHERE ${predicate};`;
}

export function upsertStatements(entry, row) {
  const columns = TABLE_COLUMNS[row.table];
  if (VIRTUAL_TABLES.has(row.table)) {
    return [deleteStatement(entry, row.table, row.key_values), insertStatement(entry, row)];
  }
  const keys = keyColumns(entry, row.table);
  const updates = columns.filter((column) => !keys.includes(column))
    .map((column) => `${column} = excluded.${column}`);
  const values = columns.map((column) => sqlLiteral(row.columns[column]));
  const conflict = updates.length > 0
    ? `ON CONFLICT(${keys.join(", ")}) DO UPDATE SET ${updates.join(", ")}`
    : `ON CONFLICT(${keys.join(", ")}) DO NOTHING`;
  return [`INSERT INTO ${row.table} (${columns.join(", ")}) VALUES (${values.join(", ")}) ${conflict};`];
}

/** Tables of a model in delete order: the reverse of the manifest's insertion order, so referencing rows go first. */
export function deleteOrder(entry) {
  return entry.tables.map((table) => table.name).reverse();
}

/**
 * SQL text for one model. `mode` is rebuild or upsert; `deletes` is the model's
 * partition list from a delta plan (each partition's ops.delete carries key_values).
 */
export function statementsForModel(entry, sourceDocument, { mode = "rebuild", deletes = null } = {}) {
  if (!BUILD_MODES.includes(mode)) throw new Error(`d1 read models: unknown mode ${mode}`);
  const { rows } = tableRows(entry, sourceDocument);
  const lines = [];
  if (mode === "rebuild") {
    for (const table of deleteOrder(entry)) lines.push(`DELETE FROM ${table};`);
    for (const row of rows) lines.push(insertStatement(entry, row));
  } else {
    const order = deleteOrder(entry);
    for (const partition of deletes || []) {
      const operations = [...(partition.ops?.delete || [])].sort((left, right) => (
        order.indexOf(left.table) - order.indexOf(right.table)));
      for (const op of operations) {
        if (!Array.isArray(op.key_values)) {
          throw new Error(`d1 read models: delete for ${op.table} ${op.key} carries no key_values`);
        }
        lines.push(deleteStatement(entry, op.table, op.key_values));
      }
    }
    for (const row of rows) lines.push(...upsertStatements(entry, row));
  }
  lines.push("");
  return { sql: lines.join("\n"), rowCount: rows.length };
}

export function parseArgs(argv) {
  const out = { outputDir: DEFAULT_OUT, check: false, mode: "upsert", deletesPath: null, allowRebuild: null };
  for (let i = 2; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length || argv[i].startsWith("--")) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === "--output-dir") out.outputDir = resolve(ROOT, next());
    else if (flag === "--check") out.check = true;
    else if (flag === "--mode") out.mode = next();
    else if (flag === "--deletes") out.deletesPath = resolve(ROOT, next());
    else if (flag === "--allow-rebuild") out.allowRebuild = next();
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!BUILD_MODES.includes(out.mode)) throw new Error(`--mode must be one of ${BUILD_MODES.join(", ")}`);
  if (out.deletesPath && out.mode !== "upsert") throw new Error("--deletes applies to --mode upsert only");
  if (out.mode === "rebuild" && out.allowRebuild !== REBUILD_ALLOW_TOKEN) {
    throw new Error("--mode rebuild is reserved for tools/d1_explicit_rebuild.mjs");
  }
  if (out.mode !== "rebuild" && out.allowRebuild !== null) {
    throw new Error("--allow-rebuild applies only to --mode rebuild");
  }
  return out;
}

export function generateReadModelOutputs({ outputDir = DEFAULT_OUT, check = false, mode = "upsert", deletesPath = null, allowRebuild = null, manifest: suppliedManifest = null, sourceDocuments = null } = {}) {
  const args = parseArgs([
    "node", "tools/build_worker_d1_read_models.mjs",
    "--output-dir", outputDir, "--mode", mode,
    ...(check ? ["--check"] : []),
    ...(deletesPath ? ["--deletes", deletesPath] : []),
    ...(allowRebuild ? ["--allow-rebuild", allowRebuild] : []),
  ]);
  const manifest = suppliedManifest || loadManifest();
  const plan = args.deletesPath ? JSON.parse(readFileSync(args.deletesPath, "utf8")) : null;
  mkdirSync(args.outputDir, { recursive: true });
  const report = { check: args.check, mode: args.mode, deletes: args.deletesPath ? "plan" : "none" };
  const written = {};
  for (const modelId of Object.keys(OUTPUT_FILES)) {
    const entry = modelEntry(manifest, modelId);
    const source = sourceDocuments?.[modelId] ?? readSourceDocument(entry);
    const deletes = plan?.models?.find((model) => model.model_id === modelId)?.partitions || null;
    const { sql, rowCount } = statementsForModel(entry, source, { mode: args.mode, deletes });
    const path = resolve(args.outputDir, OUTPUT_FILES[modelId]);
    writeFileSync(path, sql);
    written[modelId] = { path, bytes: Buffer.byteLength(sql), rows: rowCount, source };
  }
  Object.assign(report, {
    keyword_sql: written.keyword_search.path,
    keyword_bytes: written.keyword_search.bytes,
    keyword_documents: Number(written.keyword_search.source.manifest?.logical_index?.document_count) || 0,
    keyword_rows: written.keyword_search.rows,
    ocp_sql: written.ocp_awards.path,
    ocp_bytes: written.ocp_awards.bytes,
    ocp_rows: written.ocp_awards.rows,
    entity_sql: written.entity_intelligence.path,
    entity_bytes: written.entity_intelligence.bytes,
    entity_count: Object.keys(written.entity_intelligence.source.by_ref || {}).length,
    entity_rows: written.entity_intelligence.rows,
  });
  return report;
}

function main() {
  const args = parseArgs(process.argv);
  console.log(JSON.stringify(generateReadModelOutputs(args)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
