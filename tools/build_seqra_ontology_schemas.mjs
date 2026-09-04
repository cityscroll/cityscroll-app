#!/usr/bin/env node
/**
 * SEQRA-02: deterministically emit the fifteen committed
 * warehouse/schemas/seqra_ontology_<entity>.v1.schema.json documents from the
 * single spec in warehouse/lib/seqra_ontology_spec.mjs. Default mode writes
 * the files; `--check` rebuilds in memory and diffs against the committed
 * copies, matching tools/build_seqra_source_inventory.mjs's `--check`
 * convention so schema drift fails a gate instead of going unnoticed.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SEQRA_ONTOLOGY_ENTITY_TYPES, buildEntityJsonSchema } from "../warehouse/lib/seqra_ontology_spec.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = path.join(ROOT, "warehouse/schemas");

function stringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function schemaPath(entityType) {
  return path.join(SCHEMA_DIR, `seqra_ontology_${entityType}.v1.schema.json`);
}

const args = new Set(process.argv.slice(2));
const check = args.has("--check");

let stale = [];
mkdirSync(SCHEMA_DIR, { recursive: true });
for (const entityType of SEQRA_ONTOLOGY_ENTITY_TYPES) {
  const next = stringify(buildEntityJsonSchema(entityType));
  const target = schemaPath(entityType);
  if (check) {
    let current = null;
    try {
      current = readFileSync(target, "utf8");
    } catch {
      current = null;
    }
    if (current !== next) stale.push(path.relative(ROOT, target));
  } else {
    writeFileSync(target, next);
  }
}

if (check) {
  if (stale.length > 0) {
    throw new Error(`stale or missing SEQRA ontology schema files:\n${stale.join("\n")}\nrun: node tools/build_seqra_ontology_schemas.mjs`);
  }
  console.log(`SEQRA ontology schemas OK (${SEQRA_ONTOLOGY_ENTITY_TYPES.length} entities)`);
} else {
  console.log(`wrote ${SEQRA_ONTOLOGY_ENTITY_TYPES.length} SEQRA ontology schema files under warehouse/schemas/`);
}
