#!/usr/bin/env node

/**
 * Build the machine-owned architecture evidence artifact.
 *
 * This generator deliberately reads repository text and filenames only. It does
 * not import Worker code or interpret comments as active configuration. The
 * resulting document is evidence, not an architectural opinion.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "architecture", "generated", "facts.json");
const GENERATOR_VERSION = "1.0.0";

function absolute(repoPath) {
  return join(ROOT, repoPath);
}

function text(repoPath) {
  return readFileSync(absolute(repoPath), "utf8");
}

function json(repoPath) {
  return JSON.parse(text(repoPath));
}

function source(path, line = null) {
  return line == null ? { path } : { path, line };
}

function activeLines(contents) {
  return contents.split("\n").map((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    return { line: index + 1, raw, trimmed };
  }).filter(Boolean);
}

function scalarValue(line) {
  const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
  if (!match) return null;
  const [, key, rawValue] = match;
  const value = rawValue.trim().replace(/,$/, "");
  if (value.startsWith('"') && value.endsWith('"')) {
    return { key, value: value.slice(1, -1) };
  }
  if (value === "true" || value === "false") return { key, value: value === "true" };
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return { key, value: Number(value) };
  return { key, value };
}

function tableRecords(contents, tableName) {
  const records = [];
  let current = null;
  for (const row of activeLines(contents)) {
    const table = row.trimmed.match(/^\[\[([^\]]+)\]\]$/);
    if (table) {
      current = table[1] === tableName ? { values: {}, line: row.line } : null;
      if (current) records.push(current);
      continue;
    }
    if (row.trimmed.startsWith("[")) {
      current = null;
      continue;
    }
    if (!current) continue;
    const field = scalarValue(row.trimmed);
    if (field) current.values[field.key] = { value: field.value, line: row.line };
  }
  return records.map(({ values, line }) => ({
    ...Object.fromEntries(Object.entries(values).map(([key, item]) => [key, item.value])),
    source: source("worker/wrangler.toml", line),
  }));
}

function sectionValues(contents, sectionName) {
  const values = [];
  let inSection = false;
  for (const row of activeLines(contents)) {
    const table = row.trimmed.match(/^\[+([^\]]+)\]+$/);
    if (table) {
      inSection = table[1] === sectionName;
      continue;
    }
    if (!inSection) continue;
    const field = scalarValue(row.trimmed);
    if (field) values.push({ ...field, source: source("worker/wrangler.toml", row.line) });
  }
  return values;
}

function parseRoutes(contents) {
  const routes = [];
  let section = "production";
  for (const row of activeLines(contents)) {
    const table = row.trimmed.match(/^\[([^\]]+)\]$/);
    if (table) {
      section = table[1] === "env.beta" || table[1].startsWith("env.beta.") ? "beta" : "production";
    }
    for (const match of row.raw.matchAll(/\{\s*pattern\s*=\s*"([^"]+)"([^}]*)\}/g)) {
      const options = {};
      for (const option of match[2].matchAll(/([A-Za-z0-9_]+)\s*=\s*(true|false|"[^"]*")/g)) {
        options[option[1]] = option[2].startsWith('"') ? option[2].slice(1, -1) : option[2] === "true";
      }
      routes.push({
        environment: section,
        pattern: match[1],
        ...options,
        source: source("worker/wrangler.toml", row.line),
      });
    }
  }
  return routes;
}

function parseCrons(contents) {
  const crons = [];
  let inTriggers = false;
  let inCrons = false;
  for (const row of activeLines(contents)) {
    const table = row.trimmed.match(/^\[([^\]]+)\]$/);
    if (table) {
      inTriggers = table[1] === "triggers";
      inCrons = false;
      continue;
    }
    if (!inTriggers) continue;
    if (row.trimmed.startsWith("crons")) inCrons = true;
    if (!inCrons) continue;
    for (const match of row.raw.matchAll(/"([^"]+)"/g)) {
      crons.push({ schedule: match[1], source: source("worker/wrangler.toml", row.line) });
    }
    if (row.trimmed.includes("]")) inCrons = false;
  }
  return crons;
}

function dispatchRoutes(contents) {
  const routes = [];
  for (const row of contents.split("\n").map((raw, index) => ({ raw, line: index + 1 }))) {
    const condition = row.raw.match(/if\s*\(([^)]*pathname[^)]*)\)\s*return\s+([A-Za-z_$][\w$]*)\s*\(/);
    if (!condition) continue;
    const [, expression, handler] = condition;
    const candidates = [
      ...expression.matchAll(/pathname\s*===\s*["']([^"']+)["']/g),
      ...expression.matchAll(/pathname\.startsWith\s*\(\s*["']([^"']+)["']\s*\)/g),
    ];
    for (const candidate of candidates) {
      const match = candidate[0].includes("startsWith") ? "prefix" : "exact";
      const path = candidate[1];
      if (!routes.some((item) => item.path === path && item.match === match && item.handler === handler)) {
        routes.push({ path, match, handler, source: source("worker/src/worker.mjs", row.line) });
      }
    }
  }
  return routes;
}

function nullableRecords(records) {
  return records.length ? records : null;
}

function parseBindings(wrangler) {
  const productionVars = sectionValues(wrangler, "vars");
  const betaVars = sectionValues(wrangler, "env.beta.vars");
  const environments = {
    production: {
      vars: Object.fromEntries(productionVars.map(({ key, value, source: itemSource }) => [key, { value, source: itemSource }])),
      analytics_engine_datasets: nullableRecords(tableRecords(wrangler, "analytics_engine_datasets")),
      queues: {
        producers: nullableRecords(tableRecords(wrangler, "queues.producers")),
        consumers: nullableRecords(tableRecords(wrangler, "queues.consumers")),
      },
      d1_databases: nullableRecords(tableRecords(wrangler, "d1_databases")),
      kv_namespaces: nullableRecords(tableRecords(wrangler, "kv_namespaces")),
      r2_buckets: nullableRecords(tableRecords(wrangler, "r2_buckets")),
    },
    beta: {
      vars: Object.fromEntries(betaVars.map(({ key, value, source: itemSource }) => [key, { value, source: itemSource }])),
      analytics_engine_datasets: null,
      queues: { producers: null, consumers: null },
      d1_databases: null,
      kv_namespaces: null,
      r2_buckets: null,
    },
  };
  return { environments };
}

function walkFiles(repoPath, extensions) {
  const root = absolute(repoPath);
  if (!existsSync(root)) return [];
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) files.push(relative(ROOT, full).split("\\").join("/"));
    }
  }
  visit(root);
  return files.sort();
}

function buildWarehouseFacts() {
  const registryPath = "warehouse/datasets.v0.json";
  const registry = json(registryPath);
  const ingest = text("warehouse/scripts/ingest.py");
  const engines = [];
  if (/csv_to_parquet|parquet_dir/.test(ingest) && existsSync(absolute("warehouse/scripts/convert_parquet.py"))) {
    engines.push({ name: "parquet", source: source("warehouse/scripts/ingest.py") });
  }
  if (/register_table|duckdb/.test(ingest) && existsSync(absolute("warehouse/scripts/register_duckdb.py"))) {
    engines.push({ name: "duckdb", source: source("warehouse/scripts/ingest.py") });
  }
  const lookupAdapters = walkFiles("warehouse/lib", ["_lookup.mjs"]);
  const adapters = [
    existsSync(absolute("warehouse/lib/catalog.mjs")) ? { name: "catalog", source: source("warehouse/lib/catalog.mjs") } : null,
    existsSync(absolute("warehouse/lib/query.mjs")) ? { name: "query", source: source("warehouse/lib/query.mjs") } : null,
    ...lookupAdapters.map((path) => ({ name: path.slice("warehouse/lib/".length, -".mjs".length), source: source(path) })),
  ].filter(Boolean);
  return {
    registry: {
      schema_version: registry.schema_version ?? null,
      dataset_count: Object.keys(registry.datasets || {}).length,
      dataset_ids: Object.keys(registry.datasets || {}).sort(),
      source: source(registryPath),
    },
    engines,
    adapters,
  };
}

function buildMigrationFacts() {
  return walkFiles("worker/migrations", [".sql"])
    .map((path) => {
      const filename = path.slice("worker/migrations/".length);
      const match = filename.match(/^(\d+)_([^.]+)\.sql$/);
      return match ? {
        id: match[1],
        name: match[2],
        file: path,
        source: source(path),
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.file.localeCompare(b.file));
}

function buildEntityResolutionFacts() {
  const modules = walkFiles("entity_resolution", [".mjs"]);
  const importers = [];
  for (const root of ["worker", "site", "tools", "ontology", "test"]) {
    for (const path of walkFiles(root, [".mjs", ".js"])) {
      const contents = text(path);
      const imports = [];
      for (const match of contents.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']*entity_resolution[^"']*)["']/g)) {
        const resolved = normalize(join(dirname(path), match[1])).split("\\").join("/");
        imports.push(resolved.startsWith("./") ? resolved.slice(2) : resolved);
      }
      if (imports.length) importers.push({ file: path, imports: [...new Set(imports)].sort(), source: source(path) });
    }
  }
  return {
    package: { path: "entity_resolution/index.mjs", exists: existsSync(absolute("entity_resolution/index.mjs")), source: source("entity_resolution/index.mjs") },
    module_count: modules.length,
    modules,
    importers,
  };
}

function buildOntologyFacts() {
  const path = "ontology/registry.v0.json";
  const registry = json(path);
  const collections = ["object_types", "link_types", "event_kinds", "assertion_classifications", "assertion_facts"];
  return {
    registry: {
      schema: registry.schema ?? null,
      version: registry.version ?? null,
      source: source(path),
    },
    sources: Object.entries(registry.sources || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, path: value, source: source(path) })),
    collection_counts: Object.fromEntries(collections.filter((key) => Array.isArray(registry[key])).map((key) => [key, registry[key].length])),
  };
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function gitCommitTimestamp() {
  try {
    return execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function buildFacts({ generatedAt = gitCommitTimestamp() || new Date().toISOString(), commit = gitCommit() } = {}) {
  const wrangler = text("worker/wrangler.toml");
  const worker = text("worker/src/worker.mjs");
  const sources = new Set([
    "worker/wrangler.toml",
    "worker/src/worker.mjs",
    "warehouse/datasets.v0.json",
    "warehouse/scripts/ingest.py",
    "warehouse/scripts/convert_parquet.py",
    "warehouse/scripts/register_duckdb.py",
    "warehouse/lib/catalog.mjs",
    "warehouse/lib/query.mjs",
    "worker/migrations",
    "entity_resolution",
    "ontology/registry.v0.json",
  ]);
  const entity = buildEntityResolutionFacts();
  for (const importer of entity.importers) sources.add(importer.file);
  return {
    schema: "cityscroll.architecture.facts.v1",
    generator: {
      name: "tools/build_architecture_facts.mjs",
      version: GENERATOR_VERSION,
    },
    generated_at: generatedAt,
    commit,
    source_paths: [...sources].sort(),
    routes: {
      config: parseRoutes(wrangler),
      dispatch: dispatchRoutes(worker),
    },
    bindings: parseBindings(wrangler),
    crons: {
      schedules: parseCrons(wrangler),
      source: source("worker/wrangler.toml"),
    },
    warehouse: buildWarehouseFacts(),
    migrations: buildMigrationFacts(),
    entity_resolution: entity,
    ontology: buildOntologyFacts(),
  };
}

function render(facts) {
  return `${JSON.stringify(facts, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const stdout = process.argv.includes("--stdout");
  const facts = buildFacts({
    generatedAt: process.env.ARCHITECTURE_FACTS_GENERATED_AT || gitCommitTimestamp() || new Date().toISOString(),
    commit: gitCommit(),
  });
  const rendered = render(facts);
  if (check) {
    const repeated = render(buildFacts({ generatedAt: facts.generated_at, commit: facts.commit }));
    if (rendered !== repeated) {
      console.error("architecture facts are not deterministic");
      process.exitCode = 1;
      return;
    }
    console.log("architecture facts generate deterministically in memory");
    return;
  }
  if (stdout) {
    process.stdout.write(rendered);
    return;
  }
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, rendered);
  console.log(`wrote ${relative(ROOT, OUTPUT)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

export { buildFacts, parseBindings, parseCrons, parseRoutes, dispatchRoutes };
