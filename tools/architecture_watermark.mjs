/**
 * Compact architecture watermark: the reviewed baseline the reconciler diffs
 * against. Full facts.json stays ephemeral; this file is the committed
 * over-time snapshot (observer-coverage hash, canary fingerprints, ontology
 * version, binding topology, and bounded performance-observability mechanism
 * facts). Advisory performance candidates and measurements stay out.
 * Advancement is an explicit reviewed write, never a --check side effect.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const WATERMARK_SCHEMA = "cityscroll.architecture.watermark.v1";
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

export function loadWatermark({ root = ROOT, path = null } = {}) {
  const file = path ?? watermarkPath(root);
  if (!existsSync(file)) return null;
  const document = JSON.parse(readFileSync(file, "utf8"));
  if (!isWatermark(document)) {
    throw new Error(`${WATERMARK_RELATIVE} must use schema ${WATERMARK_SCHEMA}`);
  }
  return document;
}

export function projectForDiff(value, counterpart) {
  if (isWatermark(value)) return value;
  if (isWatermark(counterpart)) return buildWatermark(value);
  return value;
}
