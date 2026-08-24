import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = readFileSync(new URL("../../migrations/0026_entity_intelligence_read_model.sql", import.meta.url), "utf8");
const DOC = JSON.parse(readFileSync(new URL("../../src/data/entity_intelligence_lookup.json", import.meta.url), "utf8"));

export function wrapD1(sqlite) {
  return {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      const wrapper = {
        bind(...values) { args = values; return wrapper; },
        async all() { return { results: statement.all(...args) }; },
        async first() { return statement.get(...args) || null; },
      };
      return wrapper;
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

export function installEntityIntelligence(sqlite, doc = DOC, { encoding = "gzip-base64" } = {}) {
  sqlite.exec(SCHEMA);
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
  sqlite.prepare(
    "INSERT INTO entity_intelligence_meta (id, generated_at, observation_count, entity_count, multi_domain_count, summary_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "current",
    doc.generated_at || null,
    Number(doc.observation_count) || 0,
    Number(doc.entity_count) || 0,
    Number(doc.multi_domain_count) || 0,
    JSON.stringify(summary),
  );
  const insertEntity = sqlite.prepare(
    "INSERT INTO entity_intelligence_entities (entity_ref, kind, display_name, payload, payload_encoding) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [entityRef, dossier] of Object.entries(doc.by_ref || {})) {
    const payload = encoding === "gzip-base64"
      ? gzipBase64(dossier)
      : JSON.stringify(dossier);
    insertEntity.run(
      entityRef,
      dossier?.root?.kind || null,
      displayNameFor(dossier, entityRef),
      payload,
      encoding,
    );
  }
  const insertSubject = sqlite.prepare(
    "INSERT INTO entity_intelligence_subject_refs (subject_ref, entity_ref, relation, confidence, link_json) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [subjectRef, links] of Object.entries(doc.by_subject_ref || {})) {
    for (const link of links || []) {
      const entityRef = String(link?.entity_ref || "").trim();
      const relation = String(link?.relation || "").trim();
      const confidence = String(link?.confidence || "").trim();
      if (!entityRef || !relation) continue;
      insertSubject.run(subjectRef, entityRef, relation, confidence, JSON.stringify(link));
    }
  }
  const insertGraph = sqlite.prepare(
    "INSERT INTO entity_intelligence_graph_links (to_ref, from_ref, link_type, link_json) VALUES (?, ?, ?, ?)",
  );
  for (const row of graphLinkRows(doc)) {
    insertGraph.run(row.to_ref, row.from_ref, row.link_type, JSON.stringify(row.payload));
  }
}

export function entityIntelligenceD1(doc = DOC, options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  installEntityIntelligence(sqlite, doc, options);
  return { sqlite, DB: wrapD1(sqlite), env: { DB: wrapD1(sqlite) } };
}

export { DOC as ENTITY_INTELLIGENCE_DOC, SCHEMA as ENTITY_INTELLIGENCE_SCHEMA };
