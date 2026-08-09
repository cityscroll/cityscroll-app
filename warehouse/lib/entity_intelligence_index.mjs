#!/usr/bin/env node
/**
 * Warehouse entity-intelligence edge index (join layer).
 *
 * Builds a flat, queryable edge + root index from cross-domain observations so
 * the entity-intelligence materialization path does not re-scan the full
 * observation corpus per root (O(n) index once → O(1) bucket lookup).
 *
 * CPU-disciplined: pure JS over fixtures / in-memory rows only. No bulk SODA.
 * Optional DuckDB SQL shape: warehouse/sql/examples/entity_intelligence_index.sql
 *
 *   node warehouse/lib/entity_intelligence_index.mjs --from-fixture --limit 200
 *   node warehouse/lib/entity_intelligence_index.mjs --check
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CROSS_DOMAIN_OBJECT_LINK_VERSION,
  CROSS_DOMAIN_METHOD,
  CROSS_DOMAIN_METHOD_VERSION,
  CROSS_DOMAIN_DOMAINS,
  indexObservationsByRoot,
  buildIntelligenceCorpus,
  buildEntityIntelligenceFromBucket,
  resolveRootQuery,
  dedupeObjectLinks,
} from "../../entity_resolution/cross_domain/index.mjs";
import {
  collectCrossDomainObservations,
} from "../../tools/lib/entity_intelligence_build.mjs";

export const ENTITY_INTELLIGENCE_INDEX_VERSION = "wh_entity_intelligence_index_v1";
export const DEFAULT_EDGE_CAP = 5000;
export const DEFAULT_ROOT_CAP = 200;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROOF_DIR = join(ROOT, "warehouse", "receipts", "proof");
const PROOF_PATH = join(PROOF_DIR, "wh_entity_intelligence_index_latest.json");

/**
 * Flatten a root-index Map into warehouse edge rows (one row per typed link).
 * @param {Map<string, { root: object, objects: object[], links: object[] }>} index
 * @param {{ max_edges?: number }} [opts]
 */
export function flattenIndexToEdges(index, opts = {}) {
  const maxEdges = Math.max(1, Number(opts.max_edges) || DEFAULT_EDGE_CAP);
  const edges = [];
  for (const [rootRef, bucket] of index || []) {
    const rootKind = bucket?.root?.kind || null;
    for (const link of bucket?.links || []) {
      if (!link?.type || !link?.from || !link?.to) continue;
      edges.push({
        root_ref: rootRef,
        root_kind: rootKind,
        link_type: link.type,
        from_ref: link.from,
        to_ref: link.to,
        domain: link.domain || null,
        confidence: link.confidence || null,
        method: link.method || null,
        method_version: link.method_version || null,
        source_system: link.provenance?.source_system || null,
        source_record_id: link.provenance?.source_record_id || null,
        source_fields: link.provenance?.source_fields || [],
        basis: link.provenance?.basis || null,
        input_value: link.provenance?.input_value || null,
        observed_at: link.provenance?.observed_at || null,
      });
    }
  }
  // Stable order for snapshots
  edges.sort((a, b) =>
    String(a.root_ref).localeCompare(String(b.root_ref))
    || String(a.link_type).localeCompare(String(b.link_type))
    || String(a.from_ref).localeCompare(String(b.from_ref))
    || String(a.to_ref).localeCompare(String(b.to_ref)),
  );
  if (edges.length <= maxEdges) return edges;
  // Preserve relation-shape coverage before the deterministic fill. A plain
  // lexicographic prefix silently loses later-root relation types as denser
  // sources add rows (for example payment edges on vendor roots).
  const reserved = [];
  const seenTypes = new Set();
  for (const edge of edges) {
    if (seenTypes.has(edge.link_type)) continue;
    seenTypes.add(edge.link_type);
    reserved.push(edge);
    if (reserved.length >= maxEdges) return reserved;
  }
  const reservedKeys = new Set(reserved.map((edge) => [
    edge.root_ref,
    edge.link_type,
    edge.from_ref,
    edge.to_ref,
  ].join("|")));
  for (const edge of edges) {
    const key = [edge.root_ref, edge.link_type, edge.from_ref, edge.to_ref].join("|");
    if (reservedKeys.has(key)) continue;
    reserved.push(edge);
    if (reserved.length >= maxEdges) break;
  }
  return reserved;
}

/**
 * Compact root summary rows for warehouse index queries.
 * @param {Map} index
 * @param {{ max_roots?: number }} [opts]
 */
export function flattenIndexToRoots(index, opts = {}) {
  const maxRoots = Math.max(1, Number(opts.max_roots) || DEFAULT_ROOT_CAP);
  const rows = [];
  for (const [rootRef, bucket] of index || []) {
    const domains = new Set((bucket.objects || []).map((o) => o.domain).filter(Boolean));
    const linkTypes = new Set((bucket.links || []).map((l) => l.type).filter(Boolean));
    rows.push({
      root_ref: rootRef,
      root_kind: bucket.root?.kind || null,
      object_count: (bucket.objects || []).length,
      link_count: (bucket.links || []).length,
      domains_matched: domains.size,
      domains: [...domains].sort(),
      link_types: [...linkTypes].sort(),
    });
  }
  rows.sort((a, b) =>
    (b.domains_matched - a.domains_matched)
    || (b.object_count - a.object_count)
    || String(a.root_ref).localeCompare(String(b.root_ref)),
  );
  return rows.slice(0, maxRoots);
}

/**
 * Build the full warehouse entity-intelligence index document.
 * @param {Iterable<object>} observations
 * @param {{ max_edges?: number, max_roots?: number, max_per_domain?: number, max_entities?: number }} [opts]
 */
export function buildEntityIntelligenceIndex(observations, opts = {}) {
  const list = [...(observations || [])];
  const index = indexObservationsByRoot(list);
  const edges = flattenIndexToEdges(index, opts);
  const roots = flattenIndexToRoots(index, opts);
  const corpus = buildIntelligenceCorpus(list, {
    ...opts,
    index,
  });

  const linkTypeCounts = {};
  for (const e of edges) {
    linkTypeCounts[e.link_type] = (linkTypeCounts[e.link_type] || 0) + 1;
  }
  const joinKeyTypes = [
    "sited_on_parcel",
    "shares_authority_key",
    "references_contract",
    "payment_on_contract",
    "paid_to_vendor",
    "contract_published_by_agency",
    "decides_land_project",
  ];
  const join_key_edge_count = edges.filter((e) => joinKeyTypes.includes(e.link_type)).length;

  return {
    schema_version: 1,
    version: ENTITY_INTELLIGENCE_INDEX_VERSION,
    object_link_version: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    method: CROSS_DOMAIN_METHOD,
    method_version: CROSS_DOMAIN_METHOD_VERSION,
    generated_at: new Date().toISOString(),
    observation_count: list.length,
    root_count: roots.length,
    edge_count: edges.length,
    join_key_edge_count,
    multi_domain_count: corpus.multi_domain_count,
    selection: corpus.selection,
    domains: [...CROSS_DOMAIN_DOMAINS],
    link_type_counts: linkTypeCounts,
    roots,
    edges,
    // Instant lookup surface (same shape the site materialization consumes)
    entity_count: corpus.entity_count,
    by_ref: corpus.by_ref,
    demo_refs: corpus.demo_refs,
    metrics: {
      metric: "warehouse_entity_intelligence_index",
      roots_indexed: roots.length,
      edges_indexed: edges.length,
      join_key_edge_count,
      multi_domain_count: corpus.multi_domain_count,
      selection: corpus.selection,
      coverage_hint:
        corpus.entity_count > 0
          ? corpus.multi_domain_count / corpus.entity_count
          : 0,
    },
  };
}

/**
 * Lookup one root from a warehouse index doc without re-linking observations.
 * @param {object} indexDoc
 * @param {{ kind?: string, name?: string, id?: string, ref?: string }} query
 */
export function lookupFromIndex(indexDoc, query) {
  const root = resolveRootQuery(query);
  if (!root) {
    return { ok: false, reason: "unresolved_root", serve: "warehouse_index" };
  }
  const hit = indexDoc?.by_ref?.[root.ref];
  if (hit) {
    return { ...hit, ok: true, serve: "warehouse_index" };
  }
  // Reconstruct from edge rows if by_ref missing (edge-only materialization)
  const edgeRows = (indexDoc?.edges || []).filter((e) => e.root_ref === root.ref);
  if (!edgeRows.length) {
    return {
      ok: true,
      serve: "warehouse_index_miss",
      root,
      links: [],
      domains: null,
      note: "No edges in warehouse entity-intelligence index for this root.",
    };
  }
  const links = dedupeObjectLinks(
    edgeRows.map((e) => ({
      type: e.link_type,
      from: e.from_ref,
      to: e.to_ref,
      domain: e.domain,
      confidence: e.confidence,
      method: e.method,
      method_version: e.method_version,
      provenance: {
        source_system: e.source_system,
        source_record_id: e.source_record_id,
        source_fields: e.source_fields || [],
        basis: e.basis,
        input_value: e.input_value,
        observed_at: e.observed_at,
      },
      layer: CROSS_DOMAIN_OBJECT_LINK_VERSION,
    })),
  );
  const bucket = { root, objects: [], links };
  return {
    ...buildEntityIntelligenceFromBucket(root, bucket, {}),
    serve: "warehouse_index_edges",
  };
}

/**
 * Collect capped fixture observations (CPU-light).
 * @param {string} root
 * @param {{ limit?: number }} [opts]
 */
export function collectFixtureObservations(root = ROOT, opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 400);
  const observations = collectCrossDomainObservations(root, opts);
  // Bulk money rows arrive first in the source list. A plain prefix sample can
  // therefore erase every other domain and destroy the multi-domain proof.
  // Round-robin by domain retains source order within each stratum while
  // guaranteeing that a bounded index still represents the joined corpus.
  const buckets = new Map(CROSS_DOMAIN_DOMAINS.map((domain) => [domain, []]));
  for (const observation of observations) {
    if (!buckets.has(observation.domain)) buckets.set(observation.domain, []);
    buckets.get(observation.domain).push(observation);
  }
  const positions = new Map([...buckets.keys()].map((domain) => [domain, 0]));
  const sampled = [];
  let progressed = true;
  while (sampled.length < limit && progressed) {
    progressed = false;
    for (const [domain, rows] of buckets) {
      const position = positions.get(domain);
      if (position >= rows.length) continue;
      sampled.push(rows[position]);
      positions.set(domain, position + 1);
      progressed = true;
      if (sampled.length >= limit) break;
    }
  }
  return sampled;
}

/**
 * Materialize proof receipt under warehouse/receipts/proof/.
 */
export function writeIndexProof(indexDoc, outPath = PROOF_PATH) {
  mkdirSync(dirname(outPath), { recursive: true });
  // Proof is slim: metrics + root summary + edge sample (not full by_ref dump)
  const proof = {
    schema_version: indexDoc.schema_version,
    version: indexDoc.version,
    object_link_version: indexDoc.object_link_version,
    generated_at: indexDoc.generated_at,
    observation_count: indexDoc.observation_count,
    root_count: indexDoc.root_count,
    edge_count: indexDoc.edge_count,
    join_key_edge_count: indexDoc.join_key_edge_count,
    multi_domain_count: indexDoc.multi_domain_count,
    link_type_counts: indexDoc.link_type_counts,
    metrics: indexDoc.metrics,
    demo_refs: indexDoc.demo_refs,
    roots: (indexDoc.roots || []).slice(0, 40),
    edges_sample: (indexDoc.edges || []).slice(0, 80),
    provenance: {
      methods: [
        "agency_canonical_v1",
        "vendor_stem_v1",
        "cross_domain_identity_v2",
        "zap_bbl_project_id_v1",
        "pin_authority_key_v1",
        "contract_id_join_v1",
        "checkbook_payment_v1",
        "exact_ulurp_token_v1",
        "zap_project_ref_v1",
      ],
      note:
        "Edge index materialised from warehouse fixtures + domain seeds. Join-key edges require PIN, contract_id, BBL, payee, or meeting body ULURP/ZAP resolved to a known land project.",
    },
  };
  writeFileSync(outPath, `${JSON.stringify(proof, null, 2)}\n`);
  return proof;
}

function printHelp() {
  console.log(`Usage:
  node warehouse/lib/entity_intelligence_index.mjs --from-fixture [--limit N]
  node warehouse/lib/entity_intelligence_index.mjs --check
`);
}

function cli(argv) {
  const args = argv.slice(2);
  const fromFixture = args.includes("--from-fixture");
  const check = args.includes("--check");
  // Default high enough to include live rules/meetings domain snapshots after
  // money/land fixture rows (meeting → land reverse joins need both sides).
  let limit = 600;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") limit = Number(args[++i]) || 600;
  }

  if (check) {
    if (!existsSync(PROOF_PATH)) {
      console.error("missing proof — run --from-fixture first");
      process.exit(1);
    }
    const proof = JSON.parse(readFileSync(PROOF_PATH, "utf8"));
    if (proof.version !== ENTITY_INTELLIGENCE_INDEX_VERSION) {
      console.error("proof version drift");
      process.exit(1);
    }
    if (!(proof.edge_count > 0) || !(proof.root_count > 0)) {
      console.error("proof empty");
      process.exit(1);
    }
    console.log(
      `entity intelligence index ok: roots=${proof.root_count} edges=${proof.edge_count} join_key=${proof.join_key_edge_count}`,
    );
    return;
  }

  if (!fromFixture && !check) {
    printHelp();
    process.exit(2);
  }

  const observations = collectFixtureObservations(ROOT, { limit });
  const indexDoc = buildEntityIntelligenceIndex(observations, {
    max_edges: DEFAULT_EDGE_CAP,
    max_roots: DEFAULT_ROOT_CAP,
    max_entities: 40,
    max_per_domain: 6,
  });
  const proof = writeIndexProof(indexDoc);
  console.log(
    `wrote ${PROOF_PATH.replace(ROOT + "/", "")} — roots=${proof.root_count} edges=${proof.edge_count} join_key=${proof.join_key_edge_count} multi_domain=${proof.multi_domain_count}`,
  );
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  cli(process.argv);
}
