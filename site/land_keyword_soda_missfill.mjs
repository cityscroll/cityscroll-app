/**
 * Hybrid land keyword miss-fill: when the publish-loop keyword family is
 * missing live ULURP canaries, fill those exact project_id rows from SODA
 * and stamp a timestamped hybrid as-of so live fills are not warehouse-fresh.
 */

import { LAND_ZAP_FRESHNESS_CANARIES } from "../warehouse/lib/land_zap_canaries.mjs";
import {
  LAND_SEARCH_PRODUCER,
  LAND_SEARCH_READ_MODEL_SCHEMA_VERSION,
  projectLandSearchDocument,
} from "./land_search_producer.mjs";
import { resolveKeywordQuery, searchKeywordDocuments } from "./keyword_matcher.mjs";

export const LAND_KEYWORD_SODA_DATASET = "hgx4-8ukb";
export const LAND_KEYWORD_SODA_RESOURCE_BASE = "https://data.cityofnewyork.us/resource";
export const LAND_KEYWORD_SODA_MISSFILL = "live_soda_canary";
export const LAND_KEYWORD_PUBLISHED_STATE = "published";
export const LAND_KEYWORD_HYBRID_STATE = "hybrid";

export { LAND_ZAP_FRESHNESS_CANARIES };

export function normalizeLandProjectId(value) {
  return String(value || "").trim();
}

export function landKeywordProjectIdFromRef(objectRef) {
  const raw = String(objectRef || "").trim();
  return raw.startsWith("land_use_project:")
    ? raw.slice("land_use_project:".length)
    : raw;
}

export function landKeywordProjectIdSet(documents = []) {
  const ids = new Set();
  for (const document of Array.isArray(documents) ? documents : []) {
    const id = normalizeLandProjectId(landKeywordProjectIdFromRef(document?.object_ref));
    if (id) ids.add(id);
  }
  return ids;
}

export function missingLandKeywordCanaries(
  documents = [],
  canaries = LAND_ZAP_FRESHNESS_CANARIES,
) {
  const ids = landKeywordProjectIdSet(documents);
  return (canaries || []).filter((canary) => {
    const id = normalizeLandProjectId(canary?.project_id);
    return id && !ids.has(id);
  });
}

export function sodaExactLandProjectUrl(projectId, {
  dataset = LAND_KEYWORD_SODA_DATASET,
  limit = 1,
} = {}) {
  const id = normalizeLandProjectId(projectId);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const params = new URLSearchParams({
    $where: `project_id='${id}'`,
    $limit: String(Math.max(1, Number(limit) || 1)),
  });
  return `${LAND_KEYWORD_SODA_RESOURCE_BASE}/${dataset}.json?${params}`;
}

export function landKeywordHybridAsOf({
  warehouseAsOf = null,
  sodaFetchedAt = null,
  filledProjectIds = [],
} = {}) {
  const filled = [...new Set(
    (Array.isArray(filledProjectIds) ? filledProjectIds : [])
      .map(normalizeLandProjectId)
      .filter(Boolean),
  )].sort();
  if (!filled.length) {
    return Object.freeze({
      state: LAND_KEYWORD_PUBLISHED_STATE,
      as_of: warehouseAsOf || null,
      warehouse_as_of: warehouseAsOf || null,
      soda_as_of: null,
      filled_project_ids: Object.freeze([]),
    });
  }
  const clocks = [warehouseAsOf, sodaFetchedAt].filter(Boolean).map(String).sort();
  return Object.freeze({
    state: LAND_KEYWORD_HYBRID_STATE,
    as_of: clocks.at(-1) || sodaFetchedAt || warehouseAsOf || null,
    warehouse_as_of: warehouseAsOf || null,
    soda_as_of: sodaFetchedAt || null,
    filled_project_ids: Object.freeze(filled),
  });
}

export function landKeywordAsOfReceipt({ as_of = null, state = null } = {}) {
  const stamp = String(as_of || "").trim();
  if (!stamp) return null;
  if (state === LAND_KEYWORD_HYBRID_STATE) {
    return `as of ${stamp} · published snapshot plus live records`;
  }
  return `as of ${stamp}`;
}

function compactMissfillDocument(document, { fetchedAt, liveMissfill = true } = {}) {
  if (!document) return null;
  const provenance = document.provenance || {};
  return {
    schema: document.schema,
    object_ref: document.object_ref,
    object_type: document.object_type,
    domain: document.domain,
    canonical_href: document.canonical_href,
    title: document.title,
    summary: document.summary,
    search_text: document.search_text,
    source_family: document.source_family,
    source_observation_refs: document.source_observation_refs,
    process_role: document.process_role,
    classification: document.classification,
    provenance: {
      producer: provenance.producer || LAND_SEARCH_PRODUCER,
      source_system: "soda",
      source_freshness: {
        generated_at: fetchedAt
          || provenance.materialized_at
          || provenance.source_freshness?.generated_at
          || null,
      },
      browse_record: provenance.browse_record || null,
      notice_evidence: provenance.notice_evidence || [],
      alias_object_refs: provenance.alias_object_refs || [],
      ...(liveMissfill ? { missfill: LAND_KEYWORD_SODA_MISSFILL } : {}),
    },
    outcome: document.outcome || "indexed",
    coverage_state: document.coverage_state || "matched",
  };
}

export function landKeywordDocumentFromSodaRow(row, { fetchedAt = null, liveMissfill = true } = {}) {
  const projectId = normalizeLandProjectId(row?.project_id);
  if (!projectId) return null;
  const projected = projectLandSearchDocument(row, {
    artifact: {
      schema_version: LAND_SEARCH_READ_MODEL_SCHEMA_VERSION,
      dataset_id: LAND_KEYWORD_SODA_DATASET,
      source: "soda",
      materialized_at: fetchedAt || null,
    },
  });
  if (projected?.outcome !== "indexed" || !projected.document) return null;
  return compactMissfillDocument(projected.document, { fetchedAt, liveMissfill });
}

export function isLandKeywordSodaMissfill(document) {
  return document?.provenance?.missfill === LAND_KEYWORD_SODA_MISSFILL;
}

export function fillLandKeywordCanaryMisses({
  family = {},
  sodaRows = [],
  sodaFetchedAt = null,
  canaries = LAND_ZAP_FRESHNESS_CANARIES,
} = {}) {
  const documents = Array.isArray(family?.documents) ? [...family.documents] : [];
  const missing = missingLandKeywordCanaries(documents, canaries);
  const missingIds = new Set(missing.map((canary) => normalizeLandProjectId(canary.project_id)));
  const filled = [];
  const seen = new Set(landKeywordProjectIdSet(documents));
  for (const row of Array.isArray(sodaRows) ? sodaRows : []) {
    const projectId = normalizeLandProjectId(row?.project_id);
    if (!missingIds.has(projectId) || seen.has(projectId)) continue;
    const document = landKeywordDocumentFromSodaRow(row, { fetchedAt: sodaFetchedAt });
    if (!document) continue;
    documents.push(document);
    filled.push(projectId);
    seen.add(projectId);
  }
  const freshness = landKeywordHybridAsOf({
    warehouseAsOf: family?.as_of || null,
    sodaFetchedAt,
    filledProjectIds: filled,
  });
  return {
    documents,
    freshness,
    filled_project_ids: freshness.filled_project_ids,
    missing_canaries: missing,
  };
}

async function readSodaJson(response) {
  if (!response?.ok) {
    const error = new Error(`land keyword SODA → HTTP ${response?.status ?? "unavailable"}`);
    error.status = response?.status ?? null;
    throw error;
  }
  const body = await response.json();
  if (!Array.isArray(body) && body && typeof body === "object" && body.error) {
    throw new Error(`SODA error: ${body.message || JSON.stringify(body)}`);
  }
  return Array.isArray(body) ? body : [];
}

export async function fetchExactLandCanaryRows(projectIds, {
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const fetchedAt = new Date(now).toISOString();
  const rows = [];
  const errors = [];
  const wanted = [...new Set(
    (Array.isArray(projectIds) ? projectIds : [])
      .map(normalizeLandProjectId)
      .filter((id) => /^[A-Za-z0-9_-]+$/.test(id)),
  )];
  for (const projectId of wanted) {
    const url = sodaExactLandProjectUrl(projectId);
    if (!url) continue;
    try {
      const body = await readSodaJson(await fetchImpl(url));
      for (const row of body) {
        if (normalizeLandProjectId(row?.project_id) === projectId) rows.push(row);
      }
    } catch (error) {
      errors.push({
        project_id: projectId,
        error: String(error?.message || error).slice(0, 300),
      });
    }
  }
  return { rows, fetched_at: fetchedAt, errors };
}

export async function searchLandKeywordFamily(family, resolved, {
  fetchImpl = fetch,
  now = new Date(),
  canaries = LAND_ZAP_FRESHNESS_CANARIES,
  limit = Infinity,
} = {}) {
  const query = resolved || resolveKeywordQuery("");
  const published = Array.isArray(family?.documents) ? family.documents : [];
  const missing = missingLandKeywordCanaries(published, canaries);
  let sodaRows = [];
  let sodaFetchedAt = null;
  let sodaErrors = [];
  if (missing.length) {
    const fetched = await fetchExactLandCanaryRows(
      missing.map((canary) => canary.project_id),
      { fetchImpl, now },
    );
    sodaRows = fetched.rows;
    sodaFetchedAt = fetched.fetched_at;
    sodaErrors = fetched.errors;
  }
  const filled = fillLandKeywordCanaryMisses({
    family,
    sodaRows,
    sodaFetchedAt,
    canaries,
  });
  const matches = searchKeywordDocuments(filled.documents, query, {
    limit: Number.isFinite(limit) ? limit : filled.documents.length,
  });
  const usedFill = matches.some(isLandKeywordSodaMissfill);
  const freshness = usedFill
    ? filled.freshness
    : landKeywordHybridAsOf({
      warehouseAsOf: family?.as_of || null,
      filledProjectIds: [],
    });
  const source = usedFill
    ? `${family?.source || "NYC Open Data Zoning Application Portal projects"} (published snapshot plus live records)`
    : (family?.source || "NYC Open Data Zoning Application Portal projects");
  return {
    matches,
    freshness,
    source,
    filled_project_ids: usedFill ? filled.filled_project_ids : Object.freeze([]),
    missing_canaries: missing,
    soda_errors: sodaErrors,
  };
}
