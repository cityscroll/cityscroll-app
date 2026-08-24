/**
 * Keyed D1 adapter for the committed entity-intelligence lookup.
 *
 * Request paths load one entity (plus bounded subject-ref / graph-link rows).
 * A D1 miss or failure is the existing empty/unavailable state — never a
 * whole-corpus fallback.
 */

import {
  lookupEntityIntelligence,
  resolveRootQuery,
} from "../../../entity_resolution/cross_domain/index.mjs";

const META_ID = "current";
const IN_BATCH = 40;
const DOSSIER_CACHE_LIMIT = 64;

const dossierCache = new Map();

export function resetEntityIntelligenceReadModelCache() {
  dossierCache.clear();
}

function cacheKey(generatedAt, ref) {
  return `${generatedAt || ""}|${ref}`;
}

function rememberDossier(generatedAt, ref, dossier) {
  if (!ref || !dossier) return dossier;
  const key = cacheKey(generatedAt, ref);
  if (dossierCache.has(key)) dossierCache.delete(key);
  dossierCache.set(key, dossier);
  while (dossierCache.size > DOSSIER_CACHE_LIMIT) {
    const oldest = dossierCache.keys().next().value;
    dossierCache.delete(oldest);
  }
  return dossier;
}

export async function decodeEntityPayload(row) {
  if (!row?.payload) return null;
  const encoding = String(row.payload_encoding || "json");
  if (encoding === "gzip-base64") {
    const binary = atob(row.payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
}

async function queryAll(db, sql, values = []) {
  const statement = db.prepare(sql);
  const bound = values.length ? statement.bind(...values) : statement;
  const result = await bound.all();
  return result?.results || [];
}

async function queryFirst(db, sql, values = []) {
  const statement = db.prepare(sql);
  const bound = values.length ? statement.bind(...values) : statement;
  return (await bound.first()) || null;
}

async function selectIn(db, sqlPrefix, values, sqlSuffix = "") {
  if (!values.length) return [];
  const rows = [];
  for (let i = 0; i < values.length; i += IN_BATCH) {
    const slice = values.slice(i, i + IN_BATCH);
    const placeholders = slice.map(() => "?").join(", ");
    rows.push(...await queryAll(db, `${sqlPrefix} (${placeholders})${sqlSuffix}`, slice));
  }
  return rows;
}

export async function loadEntityIntelligenceMeta(db) {
  if (!db) return null;
  try {
    const row = await queryFirst(
      db,
      "SELECT generated_at, observation_count, entity_count, multi_domain_count, summary_json FROM entity_intelligence_meta WHERE id = ?",
      [META_ID],
    );
    if (!row) return null;
    let summary = {};
    try { summary = JSON.parse(row.summary_json || "{}") || {}; } catch { summary = {}; }
    return {
      ...summary,
      generated_at: row.generated_at || summary.generated_at || null,
      observation_count: Number(row.observation_count) || 0,
      entity_count: Number(row.entity_count) || 0,
      multi_domain_count: Number(row.multi_domain_count) || 0,
    };
  } catch {
    return null;
  }
}

function missView(query) {
  return lookupEntityIntelligence({ by_ref: {} }, query);
}

export async function lookupEntityDossierFromD1(db, entityRef, { generatedAt = null } = {}) {
  const ref = String(entityRef || "").trim();
  if (!db || !ref) return null;
  const cached = dossierCache.get(cacheKey(generatedAt, ref));
  if (cached) return cached;
  try {
    const row = await queryFirst(
      db,
      "SELECT payload, payload_encoding FROM entity_intelligence_entities WHERE entity_ref = ?",
      [ref],
    );
    const dossier = row ? await decodeEntityPayload(row) : null;
    if (dossier) rememberDossier(generatedAt, ref, dossier);
    return dossier;
  } catch {
    return null;
  }
}

async function labelsForRefs(db, refs) {
  const unique = [...new Set((refs || []).map((ref) => String(ref || "").trim()).filter(Boolean))];
  const labels = new Map();
  const rows = await selectIn(
    db,
    "SELECT entity_ref, display_name FROM entity_intelligence_entities WHERE entity_ref IN",
    unique,
  );
  for (const row of rows) {
    if (row?.entity_ref && row.display_name) labels.set(row.entity_ref, row.display_name);
  }
  return labels;
}

async function subjectLinksForRefs(db, subjectRefs) {
  const unique = [...new Set((subjectRefs || []).map((ref) => String(ref || "").trim()).filter(Boolean))];
  const bySubject = new Map();
  const rows = await selectIn(
    db,
    "SELECT subject_ref, link_json FROM entity_intelligence_subject_refs WHERE subject_ref IN",
    unique,
  );
  for (const row of rows) {
    let link = null;
    try { link = JSON.parse(row.link_json); } catch { link = null; }
    if (!link) continue;
    const key = String(row.subject_ref || "").trim();
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key).push(link);
  }
  return bySubject;
}

function publicConfidence(value) {
  const confidence = String(value || "").trim().toLowerCase();
  return confidence === "strong" || confidence === "tentative" ? confidence : null;
}

function publicEntityRef(value) {
  const ref = String(value || "").trim();
  if (/^agency:[^:]+:.+$/.test(ref)) return ref;
  if (/^vendor:stem:.+$/.test(ref)) return ref;
  if (/^entity:official:.+$/.test(ref)) return ref;
  return "";
}

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function connectionLabel(entityRef, object, labels) {
  const materialized = labels.get(entityRef);
  if (materialized) return materialized;
  if (entityRef.startsWith("vendor:stem:")) {
    return decoded(entityRef.slice("vendor:stem:".length)) || entityRef;
  }
  if (entityRef.startsWith("entity:official:") && object?.subject_ref === entityRef) {
    return String(object.label || "").split(" · ")[0].trim() || entityRef;
  }
  return entityRef;
}

function connectedEntitiesForObject(object, rootRef, bySubject, labels) {
  const candidates = [...(bySubject.get(object?.subject_ref) || [])];
  const subjectEntity = publicEntityRef(object?.subject_ref);
  if (subjectEntity && subjectEntity !== rootRef) {
    candidates.push({
      entity_ref: subjectEntity,
      relation: object.link_type,
      confidence: object.confidence,
    });
  }

  const seen = new Set();
  const connections = [];
  for (const candidate of candidates) {
    const entityRef = publicEntityRef(candidate?.entity_ref);
    const confidence = publicConfidence(candidate?.confidence);
    const relation = String(candidate?.relation || "").trim();
    if (!entityRef || entityRef === rootRef || !confidence || !relation) continue;
    const key = `${entityRef}|${relation}|${confidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    connections.push({
      entity_ref: entityRef,
      label: connectionLabel(entityRef, object, labels),
      relation,
      confidence,
      evidence: object?.provenance?.basis || null,
    });
  }
  return connections;
}

async function decorateConnectionView(view, db, meta) {
  if (!view?.ok) return view;
  const objects = Object.values(view.domains || {}).flatMap((block) => block?.objects || []);
  const subjectRefs = objects.map((object) => object?.subject_ref).filter(Boolean);
  let bySubject = new Map();
  let labels = new Map();
  try {
    bySubject = await subjectLinksForRefs(db, subjectRefs);
    const relatedRefs = [];
    for (const links of bySubject.values()) {
      for (const link of links) {
        if (link?.entity_ref) relatedRefs.push(link.entity_ref);
      }
    }
    for (const object of objects) {
      const subjectEntity = publicEntityRef(object?.subject_ref);
      if (subjectEntity) relatedRefs.push(subjectEntity);
    }
    labels = await labelsForRefs(db, relatedRefs);
  } catch {
    bySubject = new Map();
    labels = new Map();
  }

  let strongCount = 0;
  let tentativeCount = 0;
  const domains = Object.fromEntries(Object.entries(view.domains || {}).map(([domain, block]) => {
    const decoratedObjects = (block?.objects || []).map((object) => {
      const confidence = publicConfidence(object?.confidence);
      if (confidence === "strong") strongCount += 1;
      else if (confidence === "tentative") tentativeCount += 1;
      return {
        ...object,
        connected_entities: connectedEntitiesForObject(object, view.root?.ref, bySubject, labels),
      };
    });
    return [domain, {
      ...block,
      objects: decoratedObjects,
      strong_count: decoratedObjects.filter((object) => object.confidence === "strong").length,
      tentative_count: decoratedObjects.filter((object) => object.confidence === "tentative").length,
    }];
  }));

  return {
    ...view,
    domains,
    coverage: {
      eligible: null,
      linked: strongCount,
      rate: null,
      vintage: meta?.generated_at || null,
      gap: "eligible_denominator_not_measured",
      tentative: tentativeCount,
    },
    materialization_meta: {
      generated_at: meta?.generated_at || null,
      observation_count: meta?.observation_count || 0,
      entity_count: meta?.entity_count || 0,
    },
  };
}

/**
 * Look up one entity from D1. Store failures and missing refs use the existing
 * materialization_miss shape. Never loads the corpus.
 */
export async function lookupEntityIntelligenceFromD1(db, query) {
  const root = resolveRootQuery(query);
  if (!root) return lookupEntityIntelligence({ by_ref: {} }, query);
  if (!db) return missView(query);
  const meta = await loadEntityIntelligenceMeta(db);
  const dossier = await lookupEntityDossierFromD1(db, root.ref, { generatedAt: meta?.generated_at });
  if (!dossier) return missView(query);
  const view = lookupEntityIntelligence({ by_ref: { [root.ref]: dossier } }, query);
  return decorateConnectionView(view, db, meta);
}

export async function entityLinksForProjectFromD1(db, projectId) {
  const id = String(projectId || "").trim();
  if (!db || !id) return [];
  try {
    const rows = await queryAll(
      db,
      "SELECT entity_ref, link_json FROM entity_intelligence_subject_refs WHERE subject_ref = ?",
      [`project:${id}`],
    );
    const labels = await labelsForRefs(db, rows.map((row) => row.entity_ref));
    return rows.map((row) => {
      let link = {};
      try { link = JSON.parse(row.link_json) || {}; } catch { link = {}; }
      const entityRef = String(link.entity_ref || row.entity_ref || "").trim();
      return {
        ...link,
        label: labels.get(entityRef)
          || (entityRef.startsWith("vendor:stem:")
            ? decoded(entityRef.slice("vendor:stem:".length)) || entityRef
            : entityRef),
        evidence: "land_primary_applicant",
      };
    });
  } catch {
    return [];
  }
}

export async function graphLinksForProjectFromD1(db, projectId) {
  const id = String(projectId || "").trim();
  if (!db || !id) return [];
  try {
    const rows = await queryAll(
      db,
      "SELECT link_json FROM entity_intelligence_graph_links WHERE to_ref = ?",
      [`project:${id}`],
    );
    return rows.map((row) => {
      try { return JSON.parse(row.link_json); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export { META_ID as ENTITY_INTELLIGENCE_META_ID };
