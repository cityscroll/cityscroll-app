#!/usr/bin/env node

/**
 * Read, validate, and fingerprint the published D1 read-model manifest.
 *
 * The manifest at worker/d1-read-models.manifest.json is the single checked-in
 * description of every read model this repository publishes to D1: what builds
 * it, which committed artifact it derives from, which tables and key columns it
 * lands on, how it is partitioned and watermarked, and how it is published.
 *
 * Two versions are deliberately kept apart:
 *   - `model_version` is the DERIVED version. Bump it when the SQL shape, key
 *     columns, or publication semantics of the read model change.
 *   - `source.snapshot_version_field` names the field in the source artifact
 *     that carries the SOURCE snapshot version (the vintage of the data), read
 *     with `sourceSnapshotVersion()`. Rebuilding from a fresher snapshot moves
 *     that value without touching `model_version`.
 *
 * Everything downstream — fingerprinting, delta generation, publication
 * receipts, reconciliation — should read these facts from here rather than
 * re-deriving them in deployment shell logic.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const D1_READ_MODEL_MANIFEST_SCHEMA = "cityscroll.d1-read-model-manifest.v1";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_MANIFEST_PATH = join(ROOT, "worker/d1-read-models.manifest.json");

export const PUBLICATION_MODES = Object.freeze(["replace_all", "delta_upsert"]);

const TOP_LEVEL_KEYS = Object.freeze(["schema", "manifest_version", "database", "models"]);

const MODEL_KEYS = Object.freeze([
  "model_id",
  "model_version",
  "builder",
  "source",
  "tables",
  "partition",
  "watermark",
  "publication_mode",
]);

const MODEL_ID_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

function fail(field, detail) {
  throw new Error(`d1 read model manifest: ${field} ${detail}`);
}

function requirePlainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(field, "must be an object");
  return value;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim() === "") fail(field, "must be a non-empty string");
  return value;
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) fail(field, "must be a positive integer");
  return value;
}

function requireKnownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${field}.${key}`, "is not a known field");
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonical(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateTable(table, field) {
  requirePlainObject(table, field);
  requireKnownKeys(table, ["name", "key_columns"], field);
  requireNonEmptyString(table.name, `${field}.name`);
  if (!Array.isArray(table.key_columns) || table.key_columns.length === 0) {
    fail(`${field}.key_columns`, "must be a non-empty array");
  }
  table.key_columns.forEach((column, index) => {
    requireNonEmptyString(column, `${field}.key_columns[${index}]`);
  });
  if (new Set(table.key_columns).size !== table.key_columns.length) {
    fail(`${field}.key_columns`, "must not repeat a column");
  }
  return table;
}

function validateModel(model, index) {
  const field = `models[${index}]`;
  requirePlainObject(model, field);
  requireKnownKeys(model, MODEL_KEYS, field);

  requireNonEmptyString(model.model_id, `${field}.model_id`);
  if (!MODEL_ID_PATTERN.test(model.model_id)) fail(`${field}.model_id`, "must be snake_case");
  requirePositiveInteger(model.model_version, `${field}.model_version`);

  requirePlainObject(model.builder, `${field}.builder`);
  requireNonEmptyString(model.builder.path, `${field}.builder.path`);
  requirePositiveInteger(model.builder.version, `${field}.builder.version`);

  requirePlainObject(model.source, `${field}.source`);
  requireNonEmptyString(model.source.kind, `${field}.source.kind`);
  requireNonEmptyString(model.source.path, `${field}.source.path`);
  requireNonEmptyString(model.source.snapshot_version_field, `${field}.source.snapshot_version_field`);

  if (!Array.isArray(model.tables) || model.tables.length === 0) {
    fail(`${field}.tables`, "must be a non-empty array");
  }
  const tableNames = new Set();
  model.tables.forEach((table, tableIndex) => {
    validateTable(table, `${field}.tables[${tableIndex}]`);
    if (tableNames.has(table.name)) fail(`${field}.tables[${tableIndex}].name`, "is declared twice");
    tableNames.add(table.name);
  });

  requirePlainObject(model.partition, `${field}.partition`);
  requireNonEmptyString(model.partition.kind, `${field}.partition.kind`);
  if (model.partition.kind !== "none") {
    requireNonEmptyString(model.partition.column, `${field}.partition.column`);
  }

  requirePlainObject(model.watermark, `${field}.watermark`);
  requireNonEmptyString(model.watermark.kind, `${field}.watermark.kind`);

  requireNonEmptyString(model.publication_mode, `${field}.publication_mode`);
  if (!PUBLICATION_MODES.includes(model.publication_mode)) {
    fail(`${field}.publication_mode`, `must be one of ${PUBLICATION_MODES.join(", ")}`);
  }
  return model;
}

/** Validate a manifest object in place, failing closed on the first bad field. */
export function validateManifest(manifest) {
  requirePlainObject(manifest, "manifest");
  requireKnownKeys(manifest, TOP_LEVEL_KEYS, "manifest");

  if (manifest.schema !== D1_READ_MODEL_MANIFEST_SCHEMA) {
    fail("schema", `must be ${D1_READ_MODEL_MANIFEST_SCHEMA}`);
  }
  requirePositiveInteger(manifest.manifest_version, "manifest_version");
  requireNonEmptyString(manifest.database, "database");
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) {
    fail("models", "must be a non-empty array");
  }

  const modelIds = new Set();
  manifest.models.forEach((model, index) => {
    validateModel(model, index);
    if (modelIds.has(model.model_id)) fail(`models[${index}].model_id`, "is declared twice");
    modelIds.add(model.model_id);
  });
  return manifest;
}

/** Read and validate the checked-in manifest. */
export function loadManifest(path = DEFAULT_MANIFEST_PATH) {
  return validateManifest(JSON.parse(readFileSync(path, "utf8")));
}

/** Look up one model entry by id, failing closed when it is not published. */
export function modelEntry(manifest, modelId) {
  const entry = manifest?.models?.find((model) => model.model_id === modelId);
  if (!entry) fail(`models[${modelId}]`, "is not declared in the manifest");
  return entry;
}

/**
 * Read the SOURCE snapshot version of one model out of its source document.
 *
 * Two source shapes are supported. A single-document source (the OCP and entity
 * lookups) carries the field at the top level. A family-sharded source (the
 * keyword search index) carries one value per family, so the snapshot version is
 * the deterministic join of every family's value, sorted by family id — a single
 * family refreshing on its own still moves the version.
 */
export function sourceSnapshotVersion(entry, sourceDocument) {
  const field = requireNonEmptyString(
    entry?.source?.snapshot_version_field,
    "source.snapshot_version_field",
  );
  const label = entry.model_id;
  requirePlainObject(sourceDocument, `models[${label}] source document`);

  const families = sourceDocument.families;
  if (families && typeof families === "object" && !Array.isArray(families)) {
    const ids = Object.keys(families).sort();
    if (ids.length === 0) fail(`models[${label}] source document families`, "is empty");
    return ids.map((id) => {
      const value = families[id]?.[field];
      if (typeof value !== "string" || value.trim() === "") {
        fail(`models[${label}] source families.${id}.${field}`, "is missing or not a string");
      }
      return `${id}=${value}`;
    }).join(";");
  }

  const value = sourceDocument[field];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`models[${label}] source ${field}`, "is missing or not a string");
  }
  return value;
}

/**
 * The manifest facts that must invalidate a publication fingerprint.
 *
 * Included: everything that changes what is published or how it is keyed.
 * Excluded on purpose: `builder.path`, `source.path`, `partition`, `watermark`,
 * and every source snapshot value. Paths are repository layout rather than
 * contract — moving a file does not change the published rows — and snapshot
 * values belong to the data fingerprint, not to the manifest fingerprint that
 * detects a contract change.
 */
export function fingerprintInputs(manifest) {
  validateManifest(manifest);
  return {
    schema: manifest.schema,
    manifest_version: manifest.manifest_version,
    database: manifest.database,
    models: [...manifest.models]
      .sort((left, right) => left.model_id.localeCompare(right.model_id, "en"))
      .map((model) => ({
        model_id: model.model_id,
        model_version: model.model_version,
        builder_version: model.builder.version,
        source_kind: model.source.kind,
        tables: [...model.tables]
          .sort((left, right) => left.name.localeCompare(right.name, "en"))
          .map((table) => ({ name: table.name, key_columns: [...table.key_columns] })),
        publication_mode: model.publication_mode,
      })),
  };
}

/** Deterministic sha256 over the fingerprint inputs; key order does not matter. */
export function manifestFingerprint(manifest) {
  return sha256(stableStringify(fingerprintInputs(manifest)));
}

/** Canonical text for the checked-in manifest: sorted keys, 2-space indent, trailing newline. */
export function serializeManifest(manifest) {
  return `${JSON.stringify(canonical(validateManifest(manifest)), null, 2)}\n`;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = loadManifest();
  console.log(JSON.stringify({
    schema: manifest.schema,
    manifest_version: manifest.manifest_version,
    database: manifest.database,
    models: manifest.models.map((model) => model.model_id),
    fingerprint: manifestFingerprint(manifest),
  }));
}
