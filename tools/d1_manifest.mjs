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
const PARTITION_KINDS = Object.freeze(["none", "family"]);

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
  "deletes",
]);

export const IDENTITY_STRATEGIES = Object.freeze(["natural", "companion"]);
export const IDENTITY_FALLBACKS = Object.freeze(["content_hash"]);
export const DUPLICATE_POLICIES = Object.freeze(["reject", "collapse_identical"]);
export const DELETE_POLICIES = Object.freeze(["delete"]);

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

function validateIdentity(identity, field) {
  requirePlainObject(identity, field);
  requireNonEmptyString(identity.strategy, `${field}.strategy`);
  if (!IDENTITY_STRATEGIES.includes(identity.strategy)) {
    fail(`${field}.strategy`, `must be one of ${IDENTITY_STRATEGIES.join(", ")}`);
  }
  if (identity.strategy === "companion") {
    requireKnownKeys(identity, ["strategy", "of"], field);
    requireNonEmptyString(identity.of, `${field}.of`);
    return identity;
  }
  requireKnownKeys(identity, ["strategy", "source_fields", "fallback", "duplicates"], field);
  if (!Array.isArray(identity.source_fields) || identity.source_fields.length === 0) {
    fail(`${field}.source_fields`, "must be a non-empty array");
  }
  identity.source_fields.forEach((column, index) => {
    requireNonEmptyString(column, `${field}.source_fields[${index}]`);
  });
  if (new Set(identity.source_fields).size !== identity.source_fields.length) {
    fail(`${field}.source_fields`, "must not repeat a field");
  }
  if ("fallback" in identity && !IDENTITY_FALLBACKS.includes(identity.fallback)) {
    fail(`${field}.fallback`, `must be one of ${IDENTITY_FALLBACKS.join(", ")}`);
  }
  if ("duplicates" in identity && !DUPLICATE_POLICIES.includes(identity.duplicates)) {
    fail(`${field}.duplicates`, `must be one of ${DUPLICATE_POLICIES.join(", ")}`);
  }
  return identity;
}

function validateTable(table, field) {
  requirePlainObject(table, field);
  requireKnownKeys(table, ["name", "key_columns", "identity"], field);
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
  validateIdentity(table.identity, `${field}.identity`);
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
  requireKnownKeys(model.builder, ["path", "version"], `${field}.builder`);
  requireNonEmptyString(model.builder.path, `${field}.builder.path`);
  requirePositiveInteger(model.builder.version, `${field}.builder.version`);

  requirePlainObject(model.source, `${field}.source`);
  requireKnownKeys(model.source, ["kind", "path", "snapshot_version_field"], `${field}.source`);
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
  model.tables.forEach((table, tableIndex) => {
    if (table.identity.strategy !== "companion") return;
    const target = model.tables.find((candidate) => candidate.name === table.identity.of);
    if (!target) fail(`${field}.tables[${tableIndex}].identity.of`, "must name a table of the same model");
    if (target.identity.strategy === "companion") {
      fail(`${field}.tables[${tableIndex}].identity.of`, "must name a table with a natural identity");
    }
    if (target.key_columns.join("|") !== table.key_columns.join("|")) {
      fail(`${field}.tables[${tableIndex}].key_columns`, `must match the key columns of ${table.identity.of}`);
    }
  });

  requireNonEmptyString(model.deletes, `${field}.deletes`);
  if (!DELETE_POLICIES.includes(model.deletes)) {
    fail(`${field}.deletes`, `must be one of ${DELETE_POLICIES.join(", ")}`);
  }

  requirePlainObject(model.partition, `${field}.partition`);
  requireKnownKeys(model.partition, ["kind", "column"], `${field}.partition`);
  requireNonEmptyString(model.partition.kind, `${field}.partition.kind`);
  if (!PARTITION_KINDS.includes(model.partition.kind)) {
    fail(`${field}.partition.kind`, `must be one of ${PARTITION_KINDS.join(", ")}`);
  }
  if (model.partition.kind === "none") {
    if ("column" in model.partition) fail(`${field}.partition.column`, "is not valid for kind none");
  } else {
    requireNonEmptyString(model.partition.column, `${field}.partition.column`);
  }

  requirePlainObject(model.watermark, `${field}.watermark`);
  requireKnownKeys(model.watermark, ["kind", "field", "scope"], `${field}.watermark`);
  if (model.watermark.kind !== "source_snapshot_field") {
    fail(`${field}.watermark.kind`, "must be source_snapshot_field");
  }
  requireNonEmptyString(model.watermark.field, `${field}.watermark.field`);
  if (!["model", "partition"].includes(model.watermark.scope)) {
    fail(`${field}.watermark.scope`, "must be model or partition");
  }

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
  const tableOwners = new Map();
  manifest.models.forEach((model, index) => {
    validateModel(model, index);
    if (modelIds.has(model.model_id)) fail(`models[${index}].model_id`, "is declared twice");
    modelIds.add(model.model_id);
    model.tables.forEach((table, tableIndex) => {
      const owner = tableOwners.get(table.name);
      if (owner) {
        fail(
          `models[${index}].tables[${tableIndex}].name`,
          `is declared by both ${owner} and ${model.model_id}`,
        );
      }
      tableOwners.set(table.name, model.model_id);
    });
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
 * Included: everything that changes what is published or how it is keyed,
 * including the source snapshot field selector.
 * Included as well: each table identity and the model delete policy, because they decide
 * which logical row a source record becomes and what happens when it disappears.
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
        source_snapshot_version_field: model.source.snapshot_version_field,
        tables: [...model.tables]
          .sort((left, right) => left.name.localeCompare(right.name, "en"))
          .map((table) => ({ name: table.name, key_columns: [...table.key_columns], identity: canonical(table.identity) })),
        publication_mode: model.publication_mode,
        deletes: model.deletes,
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
