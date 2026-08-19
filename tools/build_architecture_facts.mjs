#!/usr/bin/env node

/**
 * Build the machine-owned architecture evidence artifact.
 *
 * This generator reads repository text and filenames, plus deterministic
 * build-time projectors. It does not import Worker runtime code or interpret
 * comments as active configuration. The resulting document is evidence, not
 * an architectural opinion.
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
import {
  buildPerformanceObservability,
  loadPerformanceRegistry,
} from "./build_performance_observability.mjs";
import { classifyPerformancePathname } from "../site/performance_route_classifier.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = join(ROOT, "architecture", "generated", "facts.json");
const CANARY_LIST = "architecture/observer-canaries.json";
const PERFORMANCE_REGISTRY_PATH = "architecture/performance-observability.v1.json";
const PERFORMANCE_REGISTRY_SCHEMA_PATH = "architecture/performance-observability.v1.schema.json";
const PERFORMANCE_BUILDER_PATH = "tools/build_performance_observability.mjs";
const PERFORMANCE_CLASSIFIER_PATH = "site/performance_route_classifier.mjs";
const PERFORMANCE_BROWSER_MANIFEST_PATH = "site/data/performance-classification-manifest.v1.json";
const PERFORMANCE_WORKER_ALLOWLIST_PATH = "worker/src/data/performance-validation-allowlist.v1.json";
const PERFORMANCE_OPERATOR_LABELS_PATH = "worker/src/data/performance-operator-labels.v1.json";
const PERFORMANCE_CANDIDATE_SOURCE_PATH = "site/sitemap.xml";
const GENERATOR_VERSION = "1.5.0";

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

function lineOf(contents, pattern) {
  const index = typeof pattern === "string" ? contents.indexOf(pattern) : contents.search(pattern);
  if (index < 0) return null;
  return contents.slice(0, index).split("\n").length;
}

function stringConst(contents, name) {
  const match = contents.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*["']([^"']+)["']`));
  return match ? match[1] : null;
}

function numberConst(contents, name) {
  const match = contents.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([\\d_]+)`));
  return match ? Number(match[1].replaceAll("_", "")) : null;
}

function frozenStringArray(contents, name) {
  const match = contents.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*Object\\.freeze\\(\\s*\\[([\\s\\S]*?)\\]\\s*\\)`));
  if (!match) return [];
  return [...match[1].matchAll(/["']([^"']+)["']/g)].map((item) => item[1]);
}

function frozenStringMap(contents, name) {
  const match = contents.match(new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*Object\\.freeze\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`));
  if (!match) return [];
  return [...match[1].matchAll(/(?:["']([^"']+)["']|([A-Za-z_][\w]*))\s*:\s*["']([^"']+)["']/g)]
    .map((item) => ({ key: item[1] || item[2], value: item[3] }));
}

function namedFunctionBody(contents, name) {
  const start = contents.search(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const brace = contents.indexOf("{", start);
  if (brace < 0) return null;
  let depth = 0;
  for (let index = brace; index < contents.length; index += 1) {
    const char = contents[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          body: contents.slice(brace + 1, index),
          line: contents.slice(0, brace).split("\n").length,
        };
      }
    }
  }
  return null;
}

function resolveRelativeImport(fromPath, specifier) {
  const resolved = normalize(join(dirname(fromPath), specifier)).split("\\").join("/");
  return resolved.startsWith("./") ? resolved.slice(2) : resolved;
}

function keywordIndexFamilies(contents) {
  const match = contents.match(/\n\s*families:\s*\{([\s\S]*?)\n\s*\},/);
  if (!match) return [];
  return [...match[1].matchAll(/(?:["']([^"']+)["']|([A-Za-z_][\w]*))\s*:\s*family\s*\(/g)]
    .map((item) => item[1] || item[2]);
}

function producerConstants(contents) {
  const producer = [...contents.matchAll(/export\s+const\s+(\w*PRODUCER)\s*=\s*["']([^"']+)["']/g)]
    .find((item) => !item[1].endsWith("_SCHEMA") && !item[1].endsWith("_VERSION"));
  const schema = [...contents.matchAll(/export\s+const\s+(\w*(?:PRODUCER_SCHEMA|READ_MODEL_SCHEMA))\s*=\s*["']([^"']+)["']/g)][0];
  return {
    producer_id: producer?.[2] ?? null,
    schema: schema?.[2] ?? null,
  };
}

function buildSearchFacts() {
  const productionPath = "worker/src/search.mjs";
  const indexPath = "tools/build_keyword_search_index.mjs";
  const production = text(productionPath);
  const index = text(indexPath);
  const collectionFamilies = frozenStringMap(production, "PRODUCTION_COLLECTION_FAMILIES")
    .map((entry) => ({
      lens: entry.key,
      family: entry.value,
      source: source(productionPath, lineOf(production, `  ${entry.key}:`)),
    }));
  const presentationLanes = frozenStringArray(production, "LANE_ORDER");
  const producerImports = [...index.matchAll(/from\s+["']([^"']*search_producer[^"']*)["']/g)]
    .map((item) => resolveRelativeImport(indexPath, item[1]))
    .filter((path) => existsSync(absolute(path)));
  const producers = [...new Set(producerImports)].sort().map((path) => {
    const contents = text(path);
    const constants = producerConstants(contents);
    return {
      path,
      producer_id: constants.producer_id,
      schema: constants.schema,
      source: source(path, lineOf(contents, "export const") || 1),
    };
  });
  const families = keywordIndexFamilies(index);
  return {
    sources: [productionPath, indexPath, ...producers.map((item) => item.path)],
    production: {
      path: productionPath,
      handler: namedFunctionBody(production, "handleSearch") ? "handleSearch" : null,
      response_schema: stringConst(production, "RESPONSE_SCHEMA"),
      presentation_lanes: presentationLanes,
      collection_families: collectionFamilies,
      source: source(productionPath, lineOf(production, "PRODUCTION_COLLECTION_FAMILIES")),
    },
    keyword_index: {
      path: indexPath,
      schema: index.match(/\bschema:\s*["'](cityscroll\.keyword_search_index(?:\.[^"']+)?)["']/)?.[1] ?? null,
      families,
      output: index.match(/["']([^"']*keyword_search_index\.json)["']/)?.[1]
        ? "worker/src/data/keyword_search_index.json"
        : null,
      source: source(indexPath, lineOf(index, "families:")),
    },
    producers,
  };
}

function buildConstellationFacts() {
  const modelPath = "site/agency_constellation_model.mjs";
  const materializerPath = "tools/build_agency_constellation_documents.mjs";
  const graphPath = "tools/lib/entity_intelligence_build.mjs";
  const model = text(modelPath);
  const materializer = text(materializerPath);
  const graph = text(graphPath);
  const categories = [...(model.match(/AGENCY_CONSTELLATION_CATEGORIES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] || "")
    .matchAll(/\bid:\s*["']([^"']+)["']/g)]
    .map((item) => item[1]);
  const lookupMatch = materializer.match(/["']data\/agency_constellation_lookup\.json["']/);
  return {
    sources: [modelPath, materializerPath, graphPath],
    agency: {
      path: modelPath,
      schema: stringConst(model, "AGENCY_CONSTELLATION_SCHEMA"),
      method: stringConst(model, "AGENCY_CONSTELLATION_METHOD"),
      categories,
      source: source(modelPath, lineOf(model, "AGENCY_CONSTELLATION_CATEGORIES")),
    },
    materializer: {
      path: materializerPath,
      lookup: lookupMatch ? "site/data/agency_constellation_lookup.json" : null,
      source: source(materializerPath, lineOf(materializer, "agency_constellation_lookup.json")),
    },
    graph: {
      path: graphPath,
      cap: numberConst(graph, "DEFAULT_PASSPORT_CONTRACT_GRAPH_CAP"),
      source: source(graphPath, lineOf(graph, "DEFAULT_PASSPORT_CONTRACT_GRAPH_CAP")),
    },
  };
}

function buildExamsFacts() {
  const path = "site/exams_surface.mjs";
  const contents = text(path);
  const failClosed = contents.includes('eligibility === "open_competitive"')
    && contents.includes('row.eligibility !== "open_competitive"');
  return {
    sources: [path],
    surface: {
      path,
      row_kind: stringConst(contents, "EXAMS_BROWSE_ROW_KIND"),
      public_eligibility: failClosed ? "open_competitive" : null,
      fail_closed_public_eligibility: failClosed,
      interest_multiselect: /function parseInterestParam/.test(contents)
        && /split\(\/\[,\|\]\/\)/.test(contents),
      source: source(path, lineOf(contents, 'eligibility === "open_competitive"')),
    },
  };
}

function buildPagesEdgeFacts() {
  const rendererPath = "site/pages_edge.mjs";
  const routesPath = "site/_routes.json";
  const renderer = text(rendererPath);
  const routes = json(routesPath);
  const kindFn = namedFunctionBody(renderer, "edgeRequestKind");
  const requestKinds = kindFn
    ? [...kindFn.body.matchAll(/return\s+["']([^"']+)["']/g)].map((item) => item[1])
    : [];
  const fetchStart = renderer.search(/export\s+default\s*\{[\s\S]*?async\s+fetch\s*\(/);
  const fetchSlice = fetchStart >= 0 ? renderer.slice(fetchStart) : "";
  const handlers = [...new Set([...fetchSlice.matchAll(/return\s+(handle[A-Za-z]+)/g)].map((item) => item[1]))].sort();
  return {
    sources: [rendererPath, routesPath],
    renderer: {
      path: rendererPath,
      request_kinds: requestKinds,
      handlers,
      source: source(rendererPath, kindFn?.line || lineOf(renderer, "edgeRequestKind")),
    },
    routes: {
      path: routesPath,
      version: routes.version ?? null,
      include: Array.isArray(routes.include) ? [...routes.include] : [],
      exclude: Array.isArray(routes.exclude) ? [...routes.exclude] : [],
      source: source(routesPath),
    },
  };
}

function buildMaterializerFacts() {
  const path = "tools/build_primary_documents.mjs";
  const contents = text(path);
  const builders = [...contents.matchAll(/import\s*\{([^}]+)\}\s*from\s*["'][^"']*primary_document_view[^"']*["']/g)]
    .flatMap((item) => item[1].split(",").map((name) => name.trim()).filter(Boolean))
    .sort();
  const outputPrefixes = [...contents.matchAll(/output\(\s*["']([^"']+)["']/g)].map((item) => item[1]);
  return {
    sources: [path],
    primary_documents: {
      path,
      builders,
      output_prefixes: outputPrefixes,
      source: source(path, lineOf(contents, "primaryDocumentOutputs")),
    },
  };
}

function buildCivicGeographyFacts() {
  const registryModulePath = "site/civic_geography_registry.mjs";
  const artifactPath = "site/data/geography/layer_registry.json";
  const registry = json(artifactPath);
  return {
    sources: [registryModulePath, artifactPath],
    registry: {
      schema: registry.schema ?? null,
      layer_count: Array.isArray(registry.layers) ? registry.layers.length : 0,
      layers: (registry.layers || []).map((layer) => ({
        type: layer.type ?? null,
        class: layer.class ?? null,
        boundary_vintage: layer.boundary_vintage ?? null,
        source_contract_id: layer.source?.contract_id ?? null,
        coverage_status: layer.coverage?.status ?? null,
        full_fidelity: layer.artifacts?.full?.geometry_fidelity === "full",
        simplified_delivery: layer.artifacts?.simplified?.geometry_fidelity === "simplified",
        declared_uses: layer.declared_uses ?? [],
      })),
      source: source(artifactPath),
    },
  };
}

function countLifecycleStates(entries, lifecycleStates) {
  return Object.fromEntries((lifecycleStates || []).map((state) => [
    state,
    (entries || []).filter((entry) => entry.lifecycle_state === state).length,
  ]));
}

function performanceCandidatePathnames(sitemap = text(PERFORMANCE_CANDIDATE_SOURCE_PATH)) {
  return [...new Set([...sitemap.matchAll(/<loc>\s*https:\/\/cityscroll\.org([^<]*)<\/loc>/g)]
    .map((match) => match[1] || "/"))].sort();
}

function buildPerformanceObservabilityFacts({
  registry = loadPerformanceRegistry(absolute(PERFORMANCE_REGISTRY_PATH)),
  candidatePathnames = performanceCandidatePathnames(),
} = {}) {
  const projections = buildPerformanceObservability(registry, { root: ROOT });
  const candidateClassifications = [...new Set(candidatePathnames.map((value) => String(value)))]
    .sort()
    .map((pathname) => ({
      pathname,
      ...classifyPerformancePathname(projections.browser, pathname),
    }));
  const candidateStates = ["registered_no_data", "retired", "unclassified"];
  const classificationCounts = Object.fromEntries(candidateStates.map((state) => [
    state,
    candidateClassifications.filter((entry) => entry.classification_state === state).length,
  ]));
  const unclassifiedCandidates = candidateClassifications
    .filter((entry) => entry.classification_state === "unclassified")
    .map(({ pathname, classification_state, surface_id }) => ({
      pathname,
      classification_state,
      surface_id,
    }));

  return {
    sources: [
      PERFORMANCE_REGISTRY_PATH,
      PERFORMANCE_REGISTRY_SCHEMA_PATH,
      PERFORMANCE_BUILDER_PATH,
      PERFORMANCE_CLASSIFIER_PATH,
      PERFORMANCE_BROWSER_MANIFEST_PATH,
      PERFORMANCE_WORKER_ALLOWLIST_PATH,
      PERFORMANCE_OPERATOR_LABELS_PATH,
      PERFORMANCE_CANDIDATE_SOURCE_PATH,
    ],
    catalog: {
      schema: registry.schema,
      version: registry.catalog_version,
      metric_count: registry.metrics.length,
      registry_hash: projections.browser.registry_hash,
      path: PERFORMANCE_REGISTRY_PATH,
      schema_path: PERFORMANCE_REGISTRY_SCHEMA_PATH,
      source: source(PERFORMANCE_REGISTRY_PATH),
    },
    registry: {
      version: registry.registry_version,
      manifest_version: registry.manifest_version,
      surface_count: registry.surfaces.length,
      component_count: registry.components.length,
      classifications: {
        surfaces: countLifecycleStates(registry.surfaces, registry.lifecycle_states),
        components: countLifecycleStates(registry.components, registry.lifecycle_states),
      },
      projection_builder_path: PERFORMANCE_BUILDER_PATH,
      projection_paths: {
        browser: PERFORMANCE_BROWSER_MANIFEST_PATH,
        worker: PERFORMANCE_WORKER_ALLOWLIST_PATH,
        operator: PERFORMANCE_OPERATOR_LABELS_PATH,
      },
      source: source(PERFORMANCE_REGISTRY_PATH),
    },
    topology: {
      collector: {
        state: "planned",
        classification_manifest_path: PERFORMANCE_BROWSER_MANIFEST_PATH,
        implementation_path: null,
      },
      intake: {
        state: "planned",
        route_path: "/performance-events",
        implementation_path: null,
      },
      storage: {
        state: "planned",
        binding: "RUM_ANALYTICS",
        dataset: "crol_rum_observations_v1",
      },
      private_read_model: {
        state: "planned",
        route_path: "/admin/performance",
        visibility: "private",
      },
      desk: {
        state: "cross_repo_planned",
        system: "desk.cityscroll.org",
        relationship: "private_server_to_server_consumer",
      },
    },
    coverage: {
      policy: "advisory",
      merge_blocking: false,
      candidate_source: source(PERFORMANCE_CANDIDATE_SOURCE_PATH),
      candidate_count: candidateClassifications.length,
      classification_counts: classificationCounts,
      unclassified_candidates: unclassifiedCandidates,
    },
    measurements_included: false,
  };
}

function normalizeRepoPath(value) {
  return String(value || "").trim().split("\\").join("/");
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*")}$`);
}

function pathIsObserved(canaryPath, observedPaths) {
  const target = normalizeRepoPath(canaryPath);
  if (!target) return false;
  const isGlob = target.includes("*");
  const globRe = isGlob ? globToRegExp(target) : null;
  const globPrefix = isGlob ? target.split("*")[0].replace(/\/$/, "") : "";
  for (const observed of observedPaths) {
    const root = normalizeRepoPath(observed);
    if (!root) continue;
    if (isGlob) {
      if (globRe.test(root)) return true;
      if (globPrefix === root || globPrefix.startsWith(`${root}/`)) return true;
      continue;
    }
    if (target === root) return true;
    if (target.startsWith(`${root}/`)) return true;
  }
  return false;
}

function loadObserverCanaries() {
  if (!existsSync(absolute(CANARY_LIST))) {
    throw new Error(`observer canary list missing: ${CANARY_LIST}`);
  }
  const document = json(CANARY_LIST);
  if (!Array.isArray(document.canaries)) {
    throw new Error(`observer canary list must include a canaries array: ${CANARY_LIST}`);
  }
  const seen = new Set();
  const entries = [];
  for (const raw of document.canaries) {
    const id = String(raw?.id || "").trim();
    const path = normalizeRepoPath(raw?.path);
    const why = String(raw?.why || "").trim();
    if (!id || !path || !why) {
      throw new Error("observer canary entries require id, path, and why");
    }
    if (seen.has(id)) {
      throw new Error(`duplicate observer canary id: ${id}`);
    }
    seen.add(id);
    entries.push({ id, path });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
}

function buildObserverCoverage(observedPaths, canaries) {
  const observed = [...new Set((observedPaths || []).map(normalizeRepoPath).filter(Boolean))].sort();
  const known = (canaries || [])
    .map((entry) => ({
      id: String(entry?.id || "").trim(),
      path: normalizeRepoPath(entry?.path),
    }))
    .filter((entry) => entry.id && entry.path)
    .sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
  return {
    observed_paths: observed,
    known_canaries: known,
    unmapped_surfaces: known.filter((entry) => !pathIsObserved(entry.path, observed)),
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

function buildFacts({
  generatedAt = gitCommitTimestamp() || new Date().toISOString(),
  commit = gitCommit(),
  performanceCandidatePaths,
} = {}) {
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
  const search = buildSearchFacts();
  const constellation = buildConstellationFacts();
  const exams = buildExamsFacts();
  const pagesEdge = buildPagesEdgeFacts();
  const materializers = buildMaterializerFacts();
  const civicGeography = buildCivicGeographyFacts();
  const performanceObservability = buildPerformanceObservabilityFacts({
    ...(performanceCandidatePaths ? { candidatePathnames: performanceCandidatePaths } : {}),
  });
  for (const path of [
    ...search.sources,
    ...constellation.sources,
    ...exams.sources,
    ...pagesEdge.sources,
    ...materializers.sources,
    ...civicGeography.sources,
    ...performanceObservability.sources,
  ]) {
    sources.add(path);
  }
  const sourcePaths = [...sources].sort();
  const observerCoverage = buildObserverCoverage(sourcePaths, loadObserverCanaries());
  return {
    schema: "cityscroll.architecture.facts.v1",
    generator: {
      name: "tools/build_architecture_facts.mjs",
      version: GENERATOR_VERSION,
    },
    generated_at: generatedAt,
    commit,
    source_paths: sourcePaths,
    observer_coverage: {
      source: source(CANARY_LIST),
      ...observerCoverage,
    },
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
    search: {
      production: search.production,
      keyword_index: search.keyword_index,
      producers: search.producers,
    },
    constellation: {
      agency: constellation.agency,
      materializer: constellation.materializer,
      graph: constellation.graph,
    },
    exams: {
      surface: exams.surface,
    },
    pages_edge: {
      renderer: pagesEdge.renderer,
      routes: pagesEdge.routes,
    },
    materializers: {
      primary_documents: materializers.primary_documents,
    },
    civic_geography: civicGeography.registry,
    performance_observability: {
      catalog: performanceObservability.catalog,
      registry: performanceObservability.registry,
      topology: performanceObservability.topology,
      coverage: performanceObservability.coverage,
      measurements_included: performanceObservability.measurements_included,
    },
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

export {
  buildFacts,
  buildObserverCoverage,
  buildSearchFacts,
  buildConstellationFacts,
  buildExamsFacts,
  buildPagesEdgeFacts,
  buildMaterializerFacts,
  buildPerformanceObservabilityFacts,
  loadObserverCanaries,
  performanceCandidatePathnames,
  parseBindings,
  parseCrons,
  parseRoutes,
  dispatchRoutes,
  pathIsObserved,
};
