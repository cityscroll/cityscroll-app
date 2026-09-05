import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  D1_READ_MODEL_MANIFEST_SCHEMA,
  DEFAULT_MANIFEST_PATH,
  fingerprintInputs,
  loadManifest,
  manifestFingerprint,
  modelEntry,
  serializeManifest,
  sourceSnapshotVersion,
  validateManifest,
} from "../tools/d1_manifest.mjs";
import {
  readKeywordSearchIndexShard,
  readKeywordSearchIndexShardManifest,
} from "../site/keyword_search_index_shards.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = [
  "worker/migrations/0025_search_and_ocp_read_models.sql",
  "worker/migrations/0026_entity_intelligence_read_model.sql",
];
const MODEL_IDS = ["keyword_search", "ocp_awards", "entity_intelligence"];

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {}

const clone = (value) => structuredClone(value);

/** Rebuild an object graph with every key order reversed. */
function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])]));
  }
  return value;
}

function migrationSql() {
  return MIGRATIONS.map((relative) => readFileSync(join(ROOT, relative), "utf8")).join("\n");
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function inspectWithNodeSqlite(manifest) {
  if (!DatabaseSync) return null;
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(migrationSql());
    const objects = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => row.name),
    );
    const schema = new Map();
    for (const model of manifest.models) {
      for (const table of model.tables) {
        if (!objects.has(table.name)) continue;
        const columns = database
          .prepare(`PRAGMA table_info(${quoteIdentifier(table.name)})`)
          .all()
          .map((row) => row.name);
        schema.set(table.name, new Set(columns));
      }
    }
    return schema;
  } finally {
    database.close();
  }
}

function inspectWithSqliteCli(manifest) {
  const probe = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  const queries = [
    ".mode tabs",
    "SELECT 'table', name, type FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    ...manifest.models.flatMap((model) => model.tables.map((table) =>
      `SELECT 'column', '${table.name}', name FROM pragma_table_info('${table.name.replaceAll("'", "''")}') ORDER BY cid;`,
    )),
  ];
  const result = spawnSync("sqlite3", ["-batch", ":memory:"], {
    input: `${migrationSql()}\n${queries.join("\n")}\n`,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`sqlite3 migration inspection failed: ${result.stderr || result.error?.message}`);
  }
  const schema = new Map();
  for (const line of result.stdout.trim().split("\n")) {
    if (!line) continue;
    const [kind, table, column] = line.split("\t");
    if (kind === "table") schema.set(table, new Set());
    if (kind === "column") schema.get(table)?.add(column);
  }
  return schema;
}

function inspectMigratedSchema(manifest) {
  return inspectWithNodeSqlite(manifest) ?? inspectWithSqliteCli(manifest);
}

/**
 * Load the real source document a model derives from. The keyword search source
 * is family-sharded, so its snapshot fields are collected per family; the other
 * two sources are single committed JSON documents.
 */
function loadSourceDocument(entry) {
  const path = join(ROOT, entry.source.path);
  if (entry.source.kind !== "keyword_search_index_shards") {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const { dir, manifest } = readKeywordSearchIndexShardManifest(path);
  const families = {};
  for (const descriptor of manifest.shards) {
    const shard = readKeywordSearchIndexShard(dir, descriptor);
    families[descriptor.family] = { source: shard.source, as_of: shard.as_of };
  }
  return { families };
}

/** Delete a dotted/indexed field path such as `models[0].source.kind`. */
function deletePath(target, path) {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  const last = parts.pop();
  let cursor = target;
  for (const part of parts) cursor = cursor[part];
  assert.ok(cursor && last in cursor, `fixture path is stale: ${path}`);
  delete cursor[last];
  return target;
}

test("the checked-in manifest loads, validates, and is stored in canonical form", () => {
  const manifest = loadManifest();

  assert.equal(manifest.schema, D1_READ_MODEL_MANIFEST_SCHEMA);
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.database, "crol-notices");
  assert.deepEqual(manifest.models.map((model) => model.model_id), MODEL_IDS);
  assert.equal(validateManifest(manifest), manifest);
  assert.equal(readFileSync(DEFAULT_MANIFEST_PATH, "utf8"), serializeManifest(manifest));
});

test("every declared table and key column exists in the read-model migrations", (t) => {
  const manifest = loadManifest();
  const tables = inspectMigratedSchema(manifest);
  if (!tables) {
    t.skip("migration schema check requires node:sqlite or sqlite3 CLI");
    return;
  }

  for (const model of manifest.models) {
    for (const table of model.tables) {
      const columns = tables.get(table.name);
      assert.ok(columns, `${model.model_id} declares an unmigrated table: ${table.name}`);
      for (const column of table.key_columns) {
        assert.ok(columns.has(column), `${table.name} has no column ${column}`);
      }
    }
    if (model.partition.kind !== "none") {
      assert.ok(tables.get(model.tables[0].name)?.has(model.partition.column));
    }
  }
});

test("each declared builder path exists in the repository", () => {
  for (const model of loadManifest().models) {
    assert.ok(existsSync(join(ROOT, model.builder.path)), `missing builder ${model.builder.path}`);
  }
});

test("the source snapshot version comes from the real inputs and is not the derived version", () => {
  const manifest = loadManifest();
  for (const model of manifest.models) {
    assert.ok(existsSync(join(ROOT, model.source.path)), `missing source ${model.source.path}`);
    const snapshot = sourceSnapshotVersion(model, loadSourceDocument(model));
    assert.equal(typeof snapshot, "string");
    assert.ok(snapshot.length > 0, `${model.model_id} has an empty source snapshot version`);
    // Source vintage and derived model version are different facts: a rebuild
    // from fresher data moves the first and leaves the second alone.
    assert.notEqual(snapshot, String(model.model_version));
  }

  const keyword = modelEntry(manifest, "keyword_search");
  const keywordDocument = loadSourceDocument(keyword);
  const keywordSnapshot = sourceSnapshotVersion(keyword, keywordDocument);
  const familyIds = Object.keys(keywordDocument.families).sort();
  assert.ok(familyIds.length > 1);
  assert.equal(keywordSnapshot.split(";").length, familyIds.length);
  assert.ok(
    keywordSnapshot.startsWith(`${familyIds[0]}=`),
    "family snapshot versions are joined in sorted family order",
  );

  const ocp = modelEntry(manifest, "ocp_awards");
  assert.match(sourceSnapshotVersion(ocp, { materialized_at: "2026-01-02T03:04:05.000Z" }), /^2026-01-02T/);
  assert.throws(() => sourceSnapshotVersion(ocp, { row_count: 1 }), /materialized_at/);
});

test("validation fails closed on a missing, unknown, duplicated, or invalid field", () => {
  const required = [
    "schema",
    "manifest_version",
    "database",
    "models",
    "models[0].model_id",
    "models[0].model_version",
    "models[0].builder",
    "models[0].builder.path",
    "models[0].builder.version",
    "models[0].source",
    "models[0].source.kind",
    "models[0].source.path",
    "models[0].source.snapshot_version_field",
    "models[0].tables",
    "models[0].tables[0].name",
    "models[0].tables[0].key_columns",
    "models[0].partition",
    "models[0].partition.kind",
    "models[0].watermark",
    "models[0].watermark.kind",
    "models[0].publication_mode",
  ];
  for (const path of required) {
    const broken = deletePath(clone(loadManifest()), path);
    const leaf = path.split(".").pop();
    assert.throws(
      () => validateManifest(broken),
      (error) => error instanceof Error && error.message.includes(leaf),
      `removing ${path} should fail closed naming ${leaf}`,
    );
  }

  const unknownTopLevel = clone(loadManifest());
  unknownTopLevel.deploy_target = "production";
  assert.throws(() => validateManifest(unknownTopLevel), /deploy_target/);

  const unknownModelKey = clone(loadManifest());
  unknownModelKey.models[0].retention_days = 30;
  assert.throws(() => validateManifest(unknownModelKey), /retention_days/);

  const duplicated = clone(loadManifest());
  duplicated.models[1].model_id = duplicated.models[0].model_id;
  assert.throws(() => validateManifest(duplicated), /declared twice/);

  const badMode = clone(loadManifest());
  badMode.models[0].publication_mode = "append_only";
  assert.throws(() => validateManifest(badMode), /publication_mode/);

  const badModelId = clone(loadManifest());
  badModelId.models[0].model_id = "KeywordSearch";
  assert.throws(() => validateManifest(badModelId), /snake_case/);

  const badVersion = clone(loadManifest());
  badVersion.models[0].model_version = 0;
  assert.throws(() => validateManifest(badVersion), /model_version/);

  const emptyKeyColumns = clone(loadManifest());
  emptyKeyColumns.models[0].tables[0].key_columns = [];
  assert.throws(() => validateManifest(emptyKeyColumns), /key_columns/);

  const unknownBuilderKey = clone(loadManifest());
  unknownBuilderKey.models[0].builder.runtime = "node";
  assert.throws(() => validateManifest(unknownBuilderKey), /runtime/);

  const unknownSourceKey = clone(loadManifest());
  unknownSourceKey.models[0].source.format = "json";
  assert.throws(() => validateManifest(unknownSourceKey), /format/);

  const unknownTableKey = clone(loadManifest());
  unknownTableKey.models[0].tables[0].nullable = false;
  assert.throws(() => validateManifest(unknownTableKey), /nullable/);

  const unknownPartitionKey = clone(loadManifest());
  unknownPartitionKey.models[0].partition.shard = "family_id";
  assert.throws(() => validateManifest(unknownPartitionKey), /shard/);

  const unknownWatermarkKey = clone(loadManifest());
  unknownWatermarkKey.models[0].watermark.format = "iso8601";
  assert.throws(() => validateManifest(unknownWatermarkKey), /format/);

  const missingWatermarkField = clone(loadManifest());
  delete missingWatermarkField.models[0].watermark.field;
  assert.throws(() => validateManifest(missingWatermarkField), /watermark.field/);

  const badWatermarkScope = clone(loadManifest());
  badWatermarkScope.models[0].watermark.scope = "database";
  assert.throws(() => validateManifest(badWatermarkScope), /watermark.scope/);

  const badWatermarkKind = clone(loadManifest());
  badWatermarkKind.models[0].watermark.kind = "model_version";
  assert.throws(() => validateManifest(badWatermarkKind), /source_snapshot_field/);

  const duplicateTableOwner = clone(loadManifest());
  duplicateTableOwner.models[1].tables.push(clone(duplicateTableOwner.models[0].tables[0]));
  assert.throws(() => validateManifest(duplicateTableOwner), /both keyword_search and ocp_awards/);
});

test("the manifest fingerprint is stable and moves only on contract changes", () => {
  const manifest = loadManifest();
  const baseline = manifestFingerprint(manifest);
  assert.match(baseline, /^[a-f0-9]{64}$/);
  assert.equal(manifestFingerprint(loadManifest()), baseline);

  // Key order and model order are presentation, not contract.
  const reordered = clone(manifest);
  reordered.models.reverse();
  assert.equal(manifestFingerprint(reordered), baseline);
  assert.equal(manifestFingerprint(reverseKeys(manifest)), baseline);
  assert.deepEqual(
    fingerprintInputs(reordered).models.map((model) => model.model_id),
    fingerprintInputs(manifest).models.map((model) => model.model_id),
  );

  const bumpedModel = clone(manifest);
  bumpedModel.models[0].model_version += 1;
  assert.notEqual(manifestFingerprint(bumpedModel), baseline);

  const bumpedBuilder = clone(manifest);
  bumpedBuilder.models[0].builder.version += 1;
  assert.notEqual(manifestFingerprint(bumpedBuilder), baseline);

  const changedKey = clone(manifest);
  changedKey.models[2].tables[2].key_columns = ["subject_ref", "entity_ref", "relation"];
  assert.notEqual(manifestFingerprint(changedKey), baseline);

  const changedMode = clone(manifest);
  changedMode.models[1].publication_mode = "delta_upsert";
  assert.notEqual(manifestFingerprint(changedMode), baseline);

  const changedSnapshotField = clone(manifest);
  changedSnapshotField.models[1].source.snapshot_version_field = "row_key";
  assert.notEqual(manifestFingerprint(changedSnapshotField), baseline);

  const changedDatabase = clone(manifest);
  changedDatabase.database = "some-other-database";
  assert.notEqual(manifestFingerprint(changedDatabase), baseline);

  // Repository layout is not contract: moving a checked-in input or the builder
  // script changes no published row, so it must not invalidate the fingerprint.
  const movedSource = clone(manifest);
  movedSource.models[1].source.path = "site/data/moved/ocp_awards_warehouse_lookup.json";
  movedSource.models[1].builder.path = "tools/build/build_worker_d1_read_models.mjs";
  assert.equal(manifestFingerprint(movedSource), baseline);
});
