/**
 * Compact architecture watermark: the reviewed baseline the reconciler diffs
 * against. Full facts.json stays ephemeral; this file is the committed
 * over-time snapshot (observer-coverage hash, canary fingerprints, ontology
 * version, binding topology, and bounded performance-observability mechanism
 * facts). Advisory performance candidates and measurements stay out.
 * Advancement is an explicit reviewed write, never a --check side effect.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const WATERMARK_SCHEMA = "cityscroll.architecture.watermark.v1";
export const WATERMARK_SHARD_SCHEMA = "cityscroll.architecture.watermark-shard.v1";
export const WATERMARK_DIRECTORY_RELATIVE = "architecture/watermark.d";
export const WATERMARK_RELATIVE = "architecture/generated/watermark.json";

const CANARY_SLICES = {
  "browser-rum-collector": (facts) => ({
    count: facts.performance_observability?.topology?.collector?.implementation_path ? 1 : 0,
    payload: facts.performance_observability?.topology?.collector ?? null,
  }),
  "agency-constellation-model": (facts) => ({
    count: facts.constellation?.agency?.categories?.length ?? 0,
    payload: {
      schema: facts.constellation?.agency?.schema ?? null,
      method: facts.constellation?.agency?.method ?? null,
      categories: facts.constellation?.agency?.categories ?? [],
      graph_cap: facts.constellation?.graph?.cap ?? null,
    },
  }),
  "agency-search-producer": (facts) => {
    const producers = facts.search?.producers ?? [];
    const agency = producers.find((item) => item?.path === "site/agency_search_producer.mjs")
      ?? producers.find((item) => item?.producer_id === "agency_search_document.v1")
      ?? null;
    return {
      count: agency ? 1 : 0,
      payload: agency ? { producer_id: agency.producer_id ?? null, path: agency.path ?? null } : null,
    };
  },
  "code-version-materialization": (facts) => ({
    count: facts.code_versions?.materialization?.schema ? 1 : 0,
    payload: {
      schema: facts.code_versions?.materialization?.schema ?? null,
      statuses: facts.code_versions?.materialization?.statuses ?? [],
      path: facts.code_versions?.materialization?.path ?? null,
    },
  }),
  "civic-geography-registry": (facts) => ({
    count: facts.civic_geography?.layer_count ?? 0,
    payload: {
      schema: facts.civic_geography?.schema ?? null,
      layers: facts.civic_geography?.layers ?? [],
    },
  }),
  "constellation-document-materializer": (facts) => ({
    count: facts.constellation?.materializer?.lookup ? 1 : 0,
    payload: {
      lookup: facts.constellation?.materializer?.lookup ?? null,
      path: facts.constellation?.materializer?.path ?? null,
    },
  }),
  "exams-eligibility": (facts) => ({
    count: facts.exams?.surface?.fail_closed_public_eligibility ? 1 : 0,
    payload: {
      row_kind: facts.exams?.surface?.row_kind ?? null,
      public_eligibility: facts.exams?.surface?.public_eligibility ?? null,
      fail_closed_public_eligibility: facts.exams?.surface?.fail_closed_public_eligibility ?? false,
      interest_multiselect: facts.exams?.surface?.interest_multiselect ?? false,
    },
  }),
  "keyword-search-index": (facts) => ({
    count: facts.search?.keyword_index?.families?.length ?? 0,
    payload: {
      schema: facts.search?.keyword_index?.schema ?? null,
      families: facts.search?.keyword_index?.families ?? [],
    },
  }),
  "ontology-registry": (facts) => ({
    count: Object.values(facts.ontology?.collection_counts ?? {}).reduce((sum, value) => sum + Number(value || 0), 0),
    payload: {
      schema: facts.ontology?.registry?.schema ?? null,
      version: facts.ontology?.registry?.version ?? null,
      collection_counts: facts.ontology?.collection_counts ?? {},
    },
  }),
  "pages-edge-renderer": (facts) => ({
    count: facts.pages_edge?.renderer?.handlers?.length ?? 0,
    payload: {
      request_kinds: facts.pages_edge?.renderer?.request_kinds ?? [],
      handlers: facts.pages_edge?.renderer?.handlers ?? [],
    },
  }),
  "pages-edge-routes": (facts) => ({
    count: facts.pages_edge?.routes?.include?.length ?? 0,
    payload: {
      version: facts.pages_edge?.routes?.version ?? null,
      include: facts.pages_edge?.routes?.include ?? [],
      exclude: facts.pages_edge?.routes?.exclude ?? [],
    },
  }),
  "performance-observability-builder": (facts) => ({
    count: Object.keys(facts.performance_observability?.registry?.projection_paths ?? {}).length,
    payload: {
      projection_builder_path: facts.performance_observability?.registry?.projection_builder_path ?? null,
      projection_paths: facts.performance_observability?.registry?.projection_paths ?? {},
      registry_hash: facts.performance_observability?.catalog?.registry_hash ?? null,
    },
  }),
  "performance-observability-registry": (facts) => ({
    count: (facts.performance_observability?.registry?.surface_count ?? 0)
      + (facts.performance_observability?.registry?.component_count ?? 0),
    payload: performanceObservabilityWatermark(facts),
  }),
  "primary-document-materializer": (facts) => ({
    count: facts.materializers?.primary_documents?.builders?.length ?? 0,
    payload: {
      builders: facts.materializers?.primary_documents?.builders ?? [],
      output_prefixes: facts.materializers?.primary_documents?.output_prefixes ?? [],
    },
  }),
  "production-search": (facts) => ({
    count: facts.search?.production?.collection_families?.length ?? 0,
    payload: {
      handler: facts.search?.production?.handler ?? null,
      schema: facts.search?.production?.response_schema ?? null,
      families: (facts.search?.production?.collection_families ?? []).map((item) => item?.family ?? null),
      lanes: facts.search?.production?.presentation_lanes ?? [],
    },
  }),
  "worker-bindings": (facts) => {
    const topology = bindingTopology(facts);
    return { count: topology.length, payload: topology };
  },
};

export function isWatermark(value) {
  return Boolean(value && typeof value === "object" && value.schema === WATERMARK_SCHEMA);
}

export function watermarkPath(root = ROOT) {
  return join(root, WATERMARK_RELATIVE);
}

export function watermarkShardDirectory(root = ROOT) {
  return join(root, WATERMARK_DIRECTORY_RELATIVE);
}

export function watermarkShardPathForId(id) {
  if (id === "observer-coverage" || id === "ontology" || id === "bindings" || id === "performance-observability") {
    return `${id}.json`;
  }
  const match = /^canary:([a-z0-9][a-z0-9-]*)$/.exec(id);
  if (match) return `canary--${match[1]}.json`;
  throw new Error(`unsupported architecture watermark key: ${id}`);
}

function semanticEntries(watermark) {
  return [
    ["observer-coverage", watermark.observer_coverage_hash],
    ...Object.entries(watermark.canaries ?? {}).sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => [`canary:${id}`, value]),
    ["ontology", watermark.ontology],
    ["bindings", watermark.bindings],
    ["performance-observability", watermark.performance_observability],
  ];
}

function validateShard(document, name) {
  const findings = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) findings.push(`${name}: malformed shard`);
  if (document?.schema !== WATERMARK_SHARD_SCHEMA) findings.push(`${name}: unsupported schema ${document?.schema ?? "missing"}`);
  if (typeof document?.id !== "string") findings.push(`${name}: missing id`);
  else {
    try {
      const expected = watermarkShardPathForId(document.id);
      if (name !== expected) findings.push(`${name}: id/path mismatch; ${document.id} belongs at ${expected}`);
    } catch (error) {
      findings.push(`${name}: ${error.message}`);
    }
  }
  if (document?.owner !== document?.id) findings.push(`${name}: owner must equal stable semantic key ${document?.id ?? "missing"}`);
  if (typeof document?.updated_at !== "string" || !Number.isFinite(Date.parse(document.updated_at))) findings.push(`${name}: invalid updated_at`);
  if (!(typeof document?.commit === "string" || document?.commit === null)) findings.push(`${name}: commit must be a string or null`);
  if (!("value" in (document ?? {}))) findings.push(`${name}: missing value`);
  const allowed = new Set(["schema", "id", "owner", "updated_at", "commit", "value"]);
  for (const key of Object.keys(document ?? {})) if (!allowed.has(key)) findings.push(`${name}: unsupported field ${key}`);
  const value = document?.value;
  const sha = (entry) => typeof entry === "string" && /^[a-f0-9]{64}$/.test(entry);
  if (document?.id === "observer-coverage" && !sha(value)) findings.push(`${name}: observer coverage value must be a SHA-256 hash`);
  if (document?.id?.startsWith("canary:") && !(
    value && typeof value === "object" && !Array.isArray(value)
    && typeof value.path === "string" && Number.isInteger(value.count) && value.count >= 0
    && sha(value.fingerprint)
  )) findings.push(`${name}: malformed canary baseline value`);
  if (document?.id === "ontology" && !(
    value && typeof value === "object" && typeof value.schema === "string"
    && typeof value.version === "string" && value.collection_counts && typeof value.collection_counts === "object"
  )) findings.push(`${name}: malformed ontology baseline value`);
  if (document?.id === "bindings" && !(
    value && Array.isArray(value.topology) && value.topology.every((row) =>
      row && typeof row.environment === "string" && typeof row.section === "string" && typeof row.binding === "string")
  )) findings.push(`${name}: malformed bindings baseline value`);
  if (document?.id === "performance-observability" && !(
    value && typeof value === "object" && value.catalog && value.registry && "topology" in value
    && typeof value.coverage_policy === "string" && typeof value.measurements_included === "boolean"
  )) findings.push(`${name}: malformed performance-observability baseline value`);
  return findings;
}

export function loadWatermarkShards({ root = ROOT, directory = null } = {}) {
  const shardDir = directory ?? watermarkShardDirectory(root);
  if (!existsSync(shardDir)) return null;
  const names = readdirSync(shardDir).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error(`${WATERMARK_DIRECTORY_RELATIVE}: missing baseline shards`);
  const findings = [];
  const byId = new Map();
  for (const name of names) {
    let document;
    try {
      document = JSON.parse(readFileSync(join(shardDir, name), "utf8"));
    } catch (error) {
      findings.push(`${name}: malformed JSON (${error.message})`);
      continue;
    }
    findings.push(...validateShard(document, name));
    if (typeof document?.id === "string") {
      if (byId.has(document.id)) findings.push(`${name}: duplicate semantic key ${document.id}`);
      else byId.set(document.id, document);
    }
  }
  for (const required of ["observer-coverage", "ontology", "bindings", "performance-observability"]) {
    if (!byId.has(required)) findings.push(`missing required baseline key ${required}`);
  }
  if (![...byId.keys()].some((id) => id.startsWith("canary:"))) findings.push("missing required baseline canary keys");
  const registryPath = join(root, "architecture", "observer-canaries.json");
  if (existsSync(registryPath)) {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    const expected = new Set((registry.canaries ?? []).map((entry) => `canary:${entry.id}`));
    const actual = new Set([...byId.keys()].filter((id) => id.startsWith("canary:")));
    for (const id of expected) if (!actual.has(id)) findings.push(`missing required baseline key ${id}`);
    for (const id of actual) if (!expected.has(id)) findings.push(`stale or unregistered baseline key ${id}`);
  }
  if (findings.length) throw new Error(`invalid architecture watermark shards:\n- ${findings.join("\n- ")}`);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function aggregateWatermarkShards(shards) {
  const byId = new Map();
  for (const shard of shards) {
    if (byId.has(shard.id)) throw new Error(`duplicate semantic key ${shard.id}; reviewed handoff required`);
    byId.set(shard.id, shard);
  }
  for (const required of ["observer-coverage", "ontology", "bindings", "performance-observability"]) {
    if (!byId.has(required)) throw new Error(`missing required baseline key ${required}`);
  }
  const latest = [...shards].sort((left, right) => {
    const clock = left.updated_at.localeCompare(right.updated_at);
    return clock || left.id.localeCompare(right.id);
  }).at(-1);
  return {
    schema: WATERMARK_SCHEMA,
    generated_at: latest?.updated_at ?? null,
    commit: latest?.commit ?? null,
    observer_coverage_hash: byId.get("observer-coverage").value,
    canaries: Object.fromEntries([...byId.entries()]
      .filter(([id]) => id.startsWith("canary:"))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, shard]) => [id.slice("canary:".length), shard.value])),
    ontology: byId.get("ontology").value,
    bindings: byId.get("bindings").value,
    performance_observability: byId.get("performance-observability").value,
  };
}

export function writeWatermarkShards(watermark, { root = ROOT, keys = [] } = {}) {
  if (!keys.length) throw new Error("--write-watermark requires at least one explicit --watermark-key");
  const available = new Map(semanticEntries(watermark));
  const existing = new Map(loadWatermarkShards({ root }).map((shard) => [shard.id, shard]));
  for (const key of keys) {
    if (!available.has(key)) throw new Error(`unsupported or absent --watermark-key ${key}`);
    const previous = existing.get(key);
    if (previous && previous.owner !== key) throw new Error(`${key}: owned by ${previous.owner}; reviewed handoff required`);
    const document = {
      schema: WATERMARK_SHARD_SCHEMA,
      id: key,
      owner: key,
      updated_at: watermark.generated_at,
      commit: watermark.commit,
      value: available.get(key),
    };
    // determinism-lint: allow write reviewed advancement is called only from the non-check CLI branch
    writeFileSync(join(watermarkShardDirectory(root), watermarkShardPathForId(key)), `${JSON.stringify(document, null, 2)}\n`);
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "source" && key !== "source_ref")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]));
  }
  return value;
}

export function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

export function bindingTopology(facts) {
  const topology = [];
  const environments = facts?.bindings?.environments ?? {};
  for (const [environment, values] of Object.entries(environments)) {
    for (const [section, value] of Object.entries(values ?? {})) {
      if (section === "vars" || value === null) continue;
      const arrays = section === "queues"
        ? Object.entries(value ?? {}).map(([queueKind, rows]) => [`${section}.${queueKind}`, rows])
        : [[section, value]];
      for (const [effectiveSection, rows] of arrays) {
        if (!Array.isArray(rows)) continue;
        for (const row of rows) {
          if (!row?.binding) continue;
          topology.push({
            environment,
            section: effectiveSection,
            binding: row.binding,
          });
        }
      }
    }
  }
  return topology.sort((left, right) => {
    const environment = left.environment.localeCompare(right.environment);
    if (environment) return environment;
    const section = left.section.localeCompare(right.section);
    if (section) return section;
    return left.binding.localeCompare(right.binding);
  });
}

function performanceObservabilityWatermark(facts) {
  const performance = facts?.performance_observability ?? {};
  return {
    catalog: {
      schema: performance.catalog?.schema ?? null,
      version: performance.catalog?.version ?? null,
      metric_count: performance.catalog?.metric_count ?? 0,
      registry_hash: performance.catalog?.registry_hash ?? null,
    },
    registry: {
      version: performance.registry?.version ?? null,
      manifest_version: performance.registry?.manifest_version ?? null,
      surface_count: performance.registry?.surface_count ?? 0,
      component_count: performance.registry?.component_count ?? 0,
      classifications: performance.registry?.classifications ?? { surfaces: {}, components: {} },
    },
    topology: performance.topology ?? null,
    coverage_policy: performance.coverage?.policy ?? null,
    measurements_included: performance.measurements_included === true,
  };
}

function canarySlice(facts, id) {
  const mapper = CANARY_SLICES[id];
  if (mapper) return mapper(facts);
  const listed = (facts?.observer_coverage?.known_canaries ?? []).find((entry) => entry?.id === id);
  const unmapped = (facts?.observer_coverage?.unmapped_surfaces ?? []).some((entry) => entry?.id === id);
  return {
    count: unmapped ? 0 : 1,
    payload: { id, path: listed?.path ?? null, unmapped },
  };
}

export function observerCoverageHash(coverage) {
  return stableHash({
    known_canaries: coverage?.known_canaries ?? [],
    observed_paths: coverage?.observed_paths ?? [],
    unmapped_surfaces: coverage?.unmapped_surfaces ?? [],
  });
}

export function buildWatermark(facts, { generatedAt, commit } = {}) {
  const canaries = {};
  for (const entry of facts?.observer_coverage?.known_canaries ?? []) {
    const id = String(entry?.id || "").trim();
    if (!id) continue;
    const slice = canarySlice(facts, id);
    canaries[id] = {
      path: entry.path ?? null,
      count: slice.count,
      fingerprint: stableHash(slice.payload),
    };
  }
  return {
    schema: WATERMARK_SCHEMA,
    generated_at: generatedAt ?? facts?.generated_at ?? null,
    commit: commit ?? facts?.commit ?? null,
    observer_coverage_hash: observerCoverageHash(facts?.observer_coverage),
    canaries,
    ontology: {
      schema: facts?.ontology?.registry?.schema ?? null,
      version: facts?.ontology?.registry?.version ?? null,
      collection_counts: facts?.ontology?.collection_counts ?? {},
    },
    bindings: {
      topology: bindingTopology(facts),
    },
    // Advisory candidate coverage is deliberately excluded: an unclassified
    // future public surface must be visible in facts without turning the
    // compact watermark diff into a merge gate.
    performance_observability: performanceObservabilityWatermark(facts),
  };
}

export function loadWatermark({ root = ROOT, directory = null } = {}) {
  const legacy = watermarkPath(root);
  if (existsSync(legacy)) {
    throw new Error(`${relative(root, legacy)} is a generated projection and must not be present as baseline input`);
  }
  const shards = loadWatermarkShards({ root, directory });
  return shards === null ? null : aggregateWatermarkShards(shards);
}

export function projectForDiff(value, counterpart) {
  if (isWatermark(value)) return value;
  if (isWatermark(counterpart)) return buildWatermark(value);
  return value;
}
