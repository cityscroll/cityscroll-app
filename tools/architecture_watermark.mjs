/**
 * Compact architecture watermark: the reviewed baseline the reconciler diffs
 * against. Full facts.json stays ephemeral; this file is the committed
 * over-time snapshot (observer-coverage hash, canary fingerprints, ontology
 * version, binding topology). Advancement is an explicit reviewed write, never
 * a --check side effect.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const WATERMARK_SCHEMA = "cityscroll.architecture.watermark.v1";
export const WATERMARK_RELATIVE = "architecture/generated/watermark.json";

const CANARY_SLICES = {
  "agency-constellation-model": (facts) => ({
    count: facts.constellation?.agency?.categories?.length ?? 0,
    payload: {
      schema: facts.constellation?.agency?.schema ?? null,
      method: facts.constellation?.agency?.method ?? null,
      categories: facts.constellation?.agency?.categories ?? [],
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
  "constellation-document-materializer": (facts) => ({
    count: facts.constellation?.materializer?.lookup ? 1 : 0,
    payload: {
      lookup: facts.constellation?.materializer?.lookup ?? null,
      path: facts.constellation?.materializer?.path ?? null,
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
