/**
 * Stable logical keys and keyed rows for the D1 read models (Release-control d1-04).
 *
 * One derivation, two consumers: the SQL builder (tools/build_worker_d1_read_models.mjs)
 * turns these rows into statements and the delta planner (tools/d1_delta_plan.mjs)
 * fingerprints them. Neither may derive a row on its own, so a published row and its
 * planned identity can never disagree.
 *
 * Identity comes from the manifest: every table declares `identity`, either a natural key
 * over named source fields (with an optional content-hash fallback for records that lack
 * them) or a companion of another table sharing that table's key. Row order, array
 * position, and generated SQL position never participate in identity.
 *
 * Duplicates are resolved before any SQL exists: two source records with the same key and
 * identical published columns collapse to one row; the same key with different columns is
 * ambiguous and throws AmbiguousKeyError, naming the model, table, and key.
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { displayNameFor, entityIntelligenceSummary, graphLinkRows } from "./d1_graph_link_rows.mjs";

export const WHOLE_MODEL_PARTITION = "__model__";

/** Column order for every published table; the SQL builder writes columns in this order. */
export const TABLE_COLUMNS = Object.freeze({
  keyword_search_families: ["family_id", "source", "as_of", "source_row_count", "indexed_count", "coverage_json"],
  keyword_search_documents: ["document_id", "family_id", "ordinal", "object_ref", "source_observation_refs_json", "document_json", "search_text"],
  keyword_search_fts: ["document_id", "family_id", "search_text"],
  ocp_awards_warehouse: ["row_key", "request_id", "start_date", "agency_name", "type_of_notice_description", "short_title", "pin", "contract_amount", "vendor_name"],
  entity_intelligence_meta: ["id", "generated_at", "observation_count", "entity_count", "multi_domain_count", "summary_json"],
  entity_intelligence_entities: ["entity_ref", "kind", "display_name", "payload", "payload_encoding"],
  entity_intelligence_subject_refs: ["subject_ref", "entity_ref", "relation", "confidence", "link_json"],
  entity_intelligence_graph_links: ["to_ref", "from_ref", "link_type", "link_json"],
});

/** FTS5 tables have no primary key; the builder converges them by delete-then-insert on the key. */
export const VIRTUAL_TABLES = Object.freeze(new Set(["keyword_search_fts"]));

export class AmbiguousKeyError extends Error {
  constructor(modelId, table, key) {
    super(`d1 stable keys: models[${modelId}] table ${table} has two different rows for key ${key}`);
    this.name = "AmbiguousKeyError";
    this.modelId = modelId;
    this.table = table;
    this.key = key;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Published JSON columns are canonical (sorted keys, arrays in order) so byte content, and therefore fingerprints, never depend on source key order. */
const json = (value) => JSON.stringify(canonical(value));
const text = (value) => String(value ?? "").trim();

function tableEntry(entry, name) {
  const table = entry.tables.find((candidate) => candidate.name === name);
  if (!table) throw new Error(`d1 stable keys: models[${entry.model_id}] does not declare table ${name}`);
  return table;
}

/** Resolve a natural identity from a source record; null when a required field is empty and no fallback applies. */
export function naturalKeyParts(identity, record, fallbackSubject = record) {
  const parts = identity.source_fields.map((field) => text(record?.[field]));
  if (parts.every((part) => part !== "")) return { parts, source: "natural" };
  if (identity.fallback === "content_hash") {
    return { parts: [`h:${contentHash(fallbackSubject).slice(0, 24)}`], source: "content_hash" };
  }
  return null;
}

class RowSet {
  constructor(entry) {
    this.modelId = entry.model_id;
    this.tableRank = new Map(entry.tables.map((table, index) => [table.name, index]));
    this.rows = new Map();
    this.collapsed = 0;
  }

  add(row) {
    const id = `${row.table} ${row.key}`;
    const existing = this.rows.get(id);
    if (existing) {
      if (contentHash(existing.columns) === contentHash(row.columns)) {
        this.collapsed += 1;
        return;
      }
      throw new AmbiguousKeyError(this.modelId, row.table, row.key);
    }
    this.rows.set(id, row);
  }

  /** Manifest table order (parents before the rows that reference them), then key. */
  sorted() {
    const rank = (table) => this.tableRank.get(table) ?? Number.MAX_SAFE_INTEGER;
    return [...this.rows.values()].sort((left, right) => (
      rank(left.table) - rank(right.table)
        || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)));
  }
}

function makeRow(table, partition, keyValues, columns) {
  return { table, partition, key: keyValues.join("|"), key_values: keyValues, columns };
}

function keywordRows(entry, sourceDocument, set) {
  const families = sourceDocument?.families;
  if (!families || typeof families !== "object" || Array.isArray(families)) {
    throw new Error(`d1 stable keys: models[${entry.model_id}] source document needs a families object`);
  }
  const documentIdentity = tableEntry(entry, "keyword_search_documents").identity;
  for (const familyId of Object.keys(families).sort()) {
    const family = families[familyId] || {};
    set.add(makeRow("keyword_search_families", familyId, [familyId], {
      family_id: familyId,
      source: family.source ?? null,
      as_of: family.as_of ?? null,
      source_row_count: Number(family.source_row_count) || 0,
      indexed_count: Number(family.indexed_count) || 0,
      coverage_json: json(family.coverage || []),
    }));
    for (const [ordinal, document] of (family.documents || []).entries()) {
      const identity = naturalKeyParts(documentIdentity, document);
      if (!identity) {
        throw new Error(`d1 stable keys: models[${entry.model_id}] family ${familyId} document at position ${ordinal} has no ${documentIdentity.source_fields.join("/")} and no fallback`);
      }
      const documentId = `${familyId}:${identity.parts.join(":")}`;
      const searchText = [document.title, document.summary, document.search_text].filter(Boolean).join(" ");
      set.add(makeRow("keyword_search_documents", familyId, [documentId], {
        document_id: documentId,
        family_id: familyId,
        ordinal,
        object_ref: document.object_ref ?? null,
        source_observation_refs_json: json(Array.isArray(document.source_observation_refs) ? document.source_observation_refs : []),
        document_json: json(document),
        search_text: searchText,
      }));
      set.add(makeRow("keyword_search_fts", familyId, [documentId], {
        document_id: documentId,
        family_id: familyId,
        search_text: searchText,
      }));
    }
  }
}

function ocpRows(entry, sourceDocument, set) {
  const identity = tableEntry(entry, "ocp_awards_warehouse").identity;
  for (const [ordinal, row] of (sourceDocument?.rows || []).entries()) {
    const key = naturalKeyParts(identity, row);
    if (!key) {
      throw new Error(`d1 stable keys: models[${entry.model_id}] row at position ${ordinal} lacks ${identity.source_fields.join("/")}`);
    }
    set.add(makeRow("ocp_awards_warehouse", WHOLE_MODEL_PARTITION, [key.parts.join("|")], {
      row_key: key.parts.join("|"),
      request_id: row.request_id ?? null,
      start_date: row.start_date ?? null,
      agency_name: row.agency_name ?? null,
      type_of_notice_description: row.type_of_notice_description ?? null,
      short_title: row.short_title ?? null,
      pin: row.pin == null ? null : text(row.pin),
      contract_amount: row.contract_amount ?? null,
      vendor_name: row.vendor_name ?? null,
    }));
  }
}

function entityRows(entry, sourceDocument, set) {
  const doc = sourceDocument || {};
  set.add(makeRow("entity_intelligence_meta", WHOLE_MODEL_PARTITION, ["current"], {
    id: "current",
    generated_at: doc.generated_at ?? null,
    observation_count: Number(doc.observation_count) || 0,
    entity_count: Number(doc.entity_count) || 0,
    multi_domain_count: Number(doc.multi_domain_count) || 0,
    summary_json: json(entityIntelligenceSummary(doc)),
  }));
  for (const entityRef of Object.keys(doc.by_ref || {}).sort()) {
    const dossier = doc.by_ref[entityRef];
    set.add(makeRow("entity_intelligence_entities", WHOLE_MODEL_PARTITION, [entityRef], {
      entity_ref: entityRef,
      kind: dossier?.root?.kind ?? null,
      display_name: displayNameFor(dossier, entityRef) ?? null,
      payload: gzipSync(Buffer.from(json(dossier), "utf8")).toString("base64"),
      payload_encoding: "gzip-base64",
    }));
  }
  for (const subjectRef of Object.keys(doc.by_subject_ref || {}).sort()) {
    for (const link of doc.by_subject_ref[subjectRef] || []) {
      const entityRef = text(link?.entity_ref);
      const relation = text(link?.relation);
      const confidence = text(link?.confidence);
      if (!entityRef || !relation) continue;
      set.add(makeRow("entity_intelligence_subject_refs", WHOLE_MODEL_PARTITION, [subjectRef, entityRef, relation, confidence], {
        subject_ref: subjectRef,
        entity_ref: entityRef,
        relation,
        confidence,
        link_json: json(link),
      }));
    }
  }
  for (const row of graphLinkRows(doc)) {
    set.add(makeRow("entity_intelligence_graph_links", WHOLE_MODEL_PARTITION, [row.to_ref, row.from_ref, row.link_type], {
      to_ref: row.to_ref,
      from_ref: row.from_ref,
      link_type: row.link_type,
      link_json: json(row.payload),
    }));
  }
}

const DERIVATIONS = Object.freeze({
  keyword_search: keywordRows,
  ocp_awards: ocpRows,
  entity_intelligence: entityRows,
});

/**
 * Every published row of one model as `{table, partition, key, key_values, columns}`,
 * in manifest table order then key, duplicates collapsed or rejected. `collapsed` counts the
 * identical duplicates that were folded.
 */
export function tableRows(entry, sourceDocument) {
  const derive = DERIVATIONS[entry.model_id];
  if (!derive) throw new Error(`d1 stable keys: no row derivation for model ${entry.model_id}`);
  const set = new RowSet(entry);
  derive(entry, sourceDocument, set);
  return { rows: set.sorted(), collapsed: set.collapsed };
}

/** Key columns of a table, from the manifest. */
export function keyColumns(entry, table) {
  return tableEntry(entry, table).key_columns;
}
