#!/usr/bin/env node

/**
 * Build deployment SQL for the large Worker read models.
 *
 * The committed JSON artifacts remain the build inputs. The generated SQL is
 * deliberately ephemeral: CI applies it to the existing D1 binding and does
 * not put the corpora back into the Worker bundle.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  readKeywordSearchIndexShard,
  readKeywordSearchIndexShardManifest,
} from "../site/keyword_search_index_shards.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = resolve(ROOT, "worker", ".d1-read-models");
const SEARCH_SHARD_DIR = resolve(ROOT, "worker", "src", "data", "keyword_search_index_shards");
const OCP_INPUT = resolve(ROOT, "worker", "src", "data", "ocp_awards_warehouse_lookup.json");
const ENTITY_INPUT = resolve(ROOT, "worker", "src", "data", "entity_intelligence_lookup.json");

function sqlString(value) {
  return `'${String(value ?? "").replaceAll("'", "''")}'`;
}

function nullable(value) {
  return value == null || value === "" ? "NULL" : sqlString(value);
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function statementsForSearch({ manifest, dir }) {
  const lines = [
    "DELETE FROM keyword_search_fts;",
    "DELETE FROM keyword_search_documents;",
    "DELETE FROM keyword_search_families;",
  ];
  for (const descriptor of manifest?.shards || []) {
    const familyId = descriptor.family;
    const family = readKeywordSearchIndexShard(dir, descriptor);
    lines.push(`INSERT INTO keyword_search_families (family_id, source, as_of, source_row_count, indexed_count, coverage_json) VALUES (${sqlString(familyId)}, ${nullable(family.source)}, ${nullable(family.as_of)}, ${Number(family.source_row_count) || 0}, ${Number(family.indexed_count) || 0}, ${sqlString(json(family.coverage || []))});`);
    for (const [ordinal, document] of (family.documents || []).entries()) {
      const documentId = `${familyId}:${ordinal}`;
      const sourceRefs = Array.isArray(document.source_observation_refs)
        ? document.source_observation_refs : [];
      const searchText = [document.title, document.summary, document.search_text]
        .filter(Boolean).join(" ");
      lines.push(`INSERT INTO keyword_search_documents (document_id, family_id, ordinal, object_ref, source_observation_refs_json, document_json, search_text) VALUES (${sqlString(documentId)}, ${sqlString(familyId)}, ${ordinal}, ${nullable(document.object_ref)}, ${sqlString(json(sourceRefs))}, ${sqlString(json(document))}, ${sqlString(searchText)});`);
      lines.push(`INSERT INTO keyword_search_fts (document_id, family_id, search_text) VALUES (${sqlString(documentId)}, ${sqlString(familyId)}, ${sqlString(searchText)});`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function rowKey(row, ordinal) {
  return [row?.request_id, row?.pin, row?.start_date, ordinal]
    .map((value) => String(value ?? "").trim()).join("|");
}

function statementsForOcp(doc) {
  const lines = ["DELETE FROM ocp_awards_warehouse;"];
  for (const [ordinal, row] of (doc?.rows || []).entries()) {
    lines.push(`INSERT INTO ocp_awards_warehouse (row_key, request_id, start_date, agency_name, type_of_notice_description, short_title, pin, contract_amount, vendor_name) VALUES (${sqlString(rowKey(row, ordinal))}, ${nullable(row.request_id)}, ${nullable(row.start_date)}, ${nullable(row.agency_name)}, ${nullable(row.type_of_notice_description)}, ${nullable(row.short_title)}, ${nullable(row.pin == null ? null : String(row.pin).trim())}, ${nullable(row.contract_amount)}, ${nullable(row.vendor_name)});`);
  }
  lines.push("");
  return lines.join("\n");
}

function inventoryToken(value, max = 120) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean || clean.length > max || !/^[a-z0-9][a-z0-9._:-]*$/.test(clean)) return null;
  return clean;
}

function ontologyInventory(doc) {
  const entityTypes = new Set();
  const edgeTypes = new Set();
  for (const row of Object.values(doc?.by_ref || {})) {
    const entityType = inventoryToken(row?.root?.kind);
    if (entityType) entityTypes.add(entityType);
    for (const link of row?.links || []) {
      const edgeType = inventoryToken(link?.type || link?.link_type);
      if (edgeType) edgeTypes.add(edgeType);
    }
    for (const domain of Object.values(row?.domains || {})) {
      for (const object of domain?.objects || []) {
        const edgeType = inventoryToken(object?.link_type);
        if (edgeType) edgeTypes.add(edgeType);
      }
    }
  }
  return {
    as_of: doc?.generated_at || null,
    entity_types: [...entityTypes].sort(),
    edge_types: [...edgeTypes].sort(),
  };
}

function projectConnectionCoverage(doc) {
  const graphLinkByKey = new Map();
  for (const dossier of Object.values(doc?.by_ref || {})) {
    for (const link of dossier?.links || []) {
      if (link?.type !== "decides_land_project" || !String(link?.to || "").startsWith("project:")) continue;
      graphLinkByKey.set([link.type, link.from, link.to].join("|"), link);
    }
  }
  const graphProjectCount = new Set([...graphLinkByKey.values()].map((link) => link.to)).size;
  return {
    meetings: {
      eligible: null,
      linked: graphProjectCount,
      rate: null,
      scope: "bounded_entity_materialization",
      vintage: doc?.generated_at || null,
      gap: "eligible_denominator_not_measured",
    },
    notices: {
      eligible: null,
      linked: null,
      rate: null,
      scope: "this_project",
      vintage: doc?.generated_at || null,
      gap: "eligible_denominator_not_measured",
    },
  };
}

function gzipBase64(value) {
  return gzipSync(Buffer.from(JSON.stringify(value), "utf8")).toString("base64");
}

function displayNameFor(dossier, entityRef) {
  const root = dossier?.root || {};
  if (root.display_name || root.canonical_name) return root.display_name || root.canonical_name;
  const ref = String(entityRef || "");
  if (ref.startsWith("vendor:stem:")) {
    try { return decodeURIComponent(ref.slice("vendor:stem:".length)) || ref; } catch { return ref; }
  }
  return ref;
}

function graphLinkRows(doc) {
  const objectBySubject = new Map();
  const graphLinkByKey = new Map();
  for (const dossier of Object.values(doc?.by_ref || {})) {
    for (const block of Object.values(dossier?.domains || {})) {
      for (const object of block?.objects || []) {
        if (object?.subject_ref && !objectBySubject.has(object.subject_ref)) {
          objectBySubject.set(object.subject_ref, object);
        }
      }
    }
    for (const link of dossier?.links || []) {
      if (link?.type !== "decides_land_project" || !String(link?.to || "").startsWith("project:")) continue;
      graphLinkByKey.set([link.type, link.from, link.to].join("|"), link);
    }
  }
  return [...graphLinkByKey.values()].map((link) => {
    const object = objectBySubject.get(link.from) || {};
    const rootRef = object.root_ref;
    const agencyName = rootRef ? displayNameFor(doc.by_ref?.[rootRef], rootRef) : null;
    return {
      to_ref: link.to,
      from_ref: link.from,
      link_type: link.type,
      payload: {
        ...link,
        label: object.label || link.from,
        agency_name: agencyName,
        when: object.when || link.provenance?.observed_at || null,
      },
    };
  });
}

function statementsForEntityIntelligence(doc) {
  const lines = [
    "DELETE FROM entity_intelligence_graph_links;",
    "DELETE FROM entity_intelligence_subject_refs;",
    "DELETE FROM entity_intelligence_entities;",
    "DELETE FROM entity_intelligence_meta;",
  ];
  const summary = {
    schema_version: doc.schema_version,
    phase: doc.phase,
    title: doc.title,
    version: doc.version,
    generated_at: doc.generated_at,
    domains: doc.domains,
    demo_refs: doc.demo_refs,
    verified_demo: doc.verified_demo,
    entity_index: doc.entity_index || [],
    provenance: doc.provenance,
    vendor_footprint: doc.vendor_footprint || null,
    selection: doc.selection,
    ontology_inventory: ontologyInventory(doc),
    project_connection_coverage: projectConnectionCoverage(doc),
  };
  lines.push(`INSERT INTO entity_intelligence_meta (id, generated_at, observation_count, entity_count, multi_domain_count, summary_json) VALUES ('current', ${nullable(doc.generated_at)}, ${Number(doc.observation_count) || 0}, ${Number(doc.entity_count) || 0}, ${Number(doc.multi_domain_count) || 0}, ${sqlString(json(summary))});`);
  for (const [entityRef, dossier] of Object.entries(doc?.by_ref || {})) {
    lines.push(`INSERT INTO entity_intelligence_entities (entity_ref, kind, display_name, payload, payload_encoding) VALUES (${sqlString(entityRef)}, ${nullable(dossier?.root?.kind)}, ${nullable(displayNameFor(dossier, entityRef))}, ${sqlString(gzipBase64(dossier))}, 'gzip-base64');`);
  }
  for (const [subjectRef, links] of Object.entries(doc?.by_subject_ref || {})) {
    for (const link of links || []) {
      const entityRef = String(link?.entity_ref || "").trim();
      const relation = String(link?.relation || "").trim();
      const confidence = String(link?.confidence || "").trim();
      if (!entityRef || !relation) continue;
      lines.push(`INSERT INTO entity_intelligence_subject_refs (subject_ref, entity_ref, relation, confidence, link_json) VALUES (${sqlString(subjectRef)}, ${sqlString(entityRef)}, ${sqlString(relation)}, ${sqlString(confidence)}, ${sqlString(json(link))});`);
    }
  }
  for (const row of graphLinkRows(doc)) {
    lines.push(`INSERT INTO entity_intelligence_graph_links (to_ref, from_ref, link_type, link_json) VALUES (${sqlString(row.to_ref)}, ${sqlString(row.from_ref)}, ${sqlString(row.link_type)}, ${sqlString(json(row.payload))});`);
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const out = { outputDir: DEFAULT_OUT, check: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--output-dir") out.outputDir = resolve(ROOT, argv[++i]);
    else if (argv[i] === "--check") out.check = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

const { outputDir, check } = parseArgs(process.argv);
const keyword = readKeywordSearchIndexShardManifest(SEARCH_SHARD_DIR);
const ocp = JSON.parse(readFileSync(OCP_INPUT, "utf8"));
const entity = JSON.parse(readFileSync(ENTITY_INPUT, "utf8"));
mkdirSync(outputDir, { recursive: true });
const keywordPath = resolve(outputDir, "keyword_search_read_model.sql");
const ocpPath = resolve(outputDir, "ocp_awards_read_model.sql");
const entityPath = resolve(outputDir, "entity_intelligence_read_model.sql");
writeFileSync(keywordPath, statementsForSearch(keyword));
writeFileSync(ocpPath, statementsForOcp(ocp));
writeFileSync(entityPath, statementsForEntityIntelligence(entity));
console.log(JSON.stringify({
  check,
  keyword_sql: keywordPath,
  keyword_bytes: readFileSync(keywordPath).byteLength,
  keyword_documents: Number(keyword.manifest?.logical_index?.document_count) || 0,
  ocp_sql: ocpPath,
  ocp_bytes: readFileSync(ocpPath).byteLength,
  ocp_rows: Array.isArray(ocp.rows) ? ocp.rows.length : 0,
  entity_sql: entityPath,
  entity_bytes: readFileSync(entityPath).byteLength,
  entity_count: Object.keys(entity.by_ref || {}).length,
}));
