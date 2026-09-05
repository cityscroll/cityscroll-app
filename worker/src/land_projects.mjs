// HTTP adapters and the explicit provider for the public Land project
// capabilities. The provider reads only precomputed, committed data: the
// bounded ZAP projects warehouse materialization (WH-05), the committed
// default-ULURP floor, and the precomputed zap-outcomes KV cache. It never
// calls the ZAP API or Socrata at request time, and it never limits browse
// to the interface-only active-status lookup that the resident Land list
// prewarms for itself (`land:zap-lookup:v1` / GET /zap-projects-lookup).

import { resolveLandActionProcedures } from "../../site/land_action_procedure_resolution.mjs";
import { buildLandDecisionPathView, publicLandDecisionPathView } from "../../site/land_decision_path.mjs";
import { landProjectUrl } from "../../site/land_project_route.mjs";
import { filterLandSnapshot } from "../../site/resident_snapshot_queries.mjs";
import { getZapWarehouseIndex } from "./lib/zap_warehouse_lookup.mjs";
import { loadZapProjectsLookup } from "./lib/zap_projects_lookup_kv.mjs";
import landDefaultUlurp from "../../site/data/land_default_ulurp.json" with { type: "json" };
import { readZapOutcomeRecord, outcomeCacheIsFresh } from "./zap_outcomes.mjs";
import landExpeditedCorpus from "./data/land_expedited_corpus.json" with { type: "json" };
import {
  LAND_PROJECT_AVAILABILITY,
  LAND_PROJECT_GET_CAPABILITY_REFERENCE,
  LAND_PROJECT_GET_PROVIDER_ID,
  LAND_PROJECT_ID_PATTERN,
  LAND_PROJECT_REPRESENTATIONS,
  LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE,
  LAND_PROJECTS_BROWSE_LIMITS,
  LAND_PROJECTS_BROWSE_PROVIDER_ID,
  executeLandProjectGet,
  executeLandProjectsBrowse,
} from "../../capabilities/land_projects.mjs";
import {
  LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
  LAND_DECISION_PATH_GET_PROVIDER_ID,
  LAND_DECISION_PATH_REPRESENTATIONS,
  executeLandDecisionPathGet,
} from "../../capabilities/land_decision_path.mjs";

export const LAND_PROJECT_GET_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.land-project-get@1",
  capabilityReference: LAND_PROJECT_GET_CAPABILITY_REFERENCE,
  providerId: LAND_PROJECT_GET_PROVIDER_ID,
  route: "GET /land-project",
  surface: "Land project detail",
  representations: LAND_PROJECT_REPRESENTATIONS,
});

export const LAND_PROJECTS_BROWSE_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.land-projects-browse@1",
  capabilityReference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE,
  providerId: LAND_PROJECTS_BROWSE_PROVIDER_ID,
  route: "GET /land-projects",
  surface: "Land browse",
  representations: LAND_PROJECT_REPRESENTATIONS,
});

export const LAND_DECISION_PATH_GET_HTTP_ADAPTER = Object.freeze({
  id: "worker-http.land-decision-path-get@1",
  capabilityReference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
  providerId: LAND_DECISION_PATH_GET_PROVIDER_ID,
  route: "GET /land-decision-path",
  surface: "Land project decision path",
  representations: LAND_DECISION_PATH_REPRESENTATIONS,
});

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim() || null;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
  };
}

function json(body, status = 200, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * The complete bounded precomputed Land population: the committed warehouse
 * floor (WH-05, every prewarmed public status including Completed) merged
 * with the committed default-ULURP floor, then overlaid with the live
 * active-status KV snapshot when present for freshness only. This is
 * deliberately NOT the same population `GET /zap-projects-lookup` serves —
 * that endpoint's KV document is scoped to four sell-facing statuses and
 * would silently omit completed and historical projects.
 */
export async function completeLandProjectPopulation(env) {
  const injected = env?.LAND_READ_MODEL;
  if (injected && typeof injected === "object") {
    const rows = Array.isArray(injected) ? injected : injected.rows || [];
    return {
      rows,
      generated_at: Array.isArray(injected) ? null : injected.generated_at || null,
      sources: Array.isArray(injected) ? {} : injected.sources || {},
    };
  }

  const floor = getZapWarehouseIndex();
  const byId = new Map();
  for (const row of floor.byProjectId.values()) byId.set(row.project_id, row);
  for (const row of Array.isArray(landDefaultUlurp?.projects) ? landDefaultUlurp.projects : []) {
    const id = clean(row?.project_id);
    if (id && !byId.has(id)) byId.set(id, row);
  }
  const activeLookup = await loadZapProjectsLookup(env);
  for (const row of Array.isArray(activeLookup?.record?.rows) ? activeLookup.record.rows : []) {
    const id = clean(row?.project_id);
    if (!id) continue;
    byId.set(id, { ...(byId.get(id) || {}), ...row });
  }

  return {
    rows: [...byId.values()],
    generated_at: activeLookup?.record?.materialized_at || floor.materialized_at || null,
    sources: {
      warehouse_floor: { row_count: floor.rowCount, materialized_at: floor.materialized_at },
      default_ulurp: {
        row_count: Array.isArray(landDefaultUlurp?.projects) ? landDefaultUlurp.projects.length : 0,
        generated_at: landDefaultUlurp?.generated_at || null,
      },
      active_lookup: {
        row_count: Array.isArray(activeLookup?.record?.rows) ? activeLookup.record.rows.length : 0,
        materialized_at: activeLookup?.record?.materialized_at || null,
        source: activeLookup?.source || null,
      },
    },
  };
}

/**
 * The frozen four-project ELURP regression corpus (worker/src/data/land_expedited_corpus.json),
 * shaped for `land.projects.browse@1`'s `corpus: "historical"` mode. Deliberately independent of
 * `completeLandProjectPopulation` and any live upstream drift: these four projects and their
 * exact per-action ZAP API evidence are frozen from the LDP-29 real-corpus regression suite
 * (test/land_action_procedure_resolution.test.mjs ELURP_CORPUS).
 *
 * `flatRows` gives `filterLandSnapshot` the same flat open-data-row shape it expects from the
 * live warehouse population; `byId` maps back to the richer joined record (exact per-action ZAP
 * evidence retained) that `projectLandProject` needs for `richness: "exact"`.
 */
function expeditedCorpusPopulation() {
  const rows = Array.isArray(landExpeditedCorpus?.rows) ? landExpeditedCorpus.rows : [];
  const generatedAt = landExpeditedCorpus?.captured_at || null;
  return {
    byId: new Map(rows.map((row) => [clean(row?.project_id), row])),
    flatRows: rows.map((row) => ({ ...(row?.open_data || {}), project_id: row?.project_id })),
    generated_at: generatedAt,
    sources: {
      frozen_expedited_corpus: {
        row_count: rows.length,
        captured_at: generatedAt,
        corpus: landExpeditedCorpus?.corpus || null,
      },
    },
  };
}

function sourceObservation(sourceSystem, sourceSystemId, observedAt) {
  return { source_system: sourceSystem, source_system_id: sourceSystemId, observed_at: observedAt || null };
}

function collectConflicts(landActions) {
  const conflicts = [];
  for (const action of landActions) {
    for (const alias of action.aliases || []) {
      conflicts.push({ kind: "alias", action_type: action.action_type, ...alias });
    }
    for (const rejected of action.evidence?.rejected || []) {
      conflicts.push({ kind: "rejected_inference", action_type: action.action_type, ...rejected });
    }
  }
  return conflicts;
}

/**
 * One canonical projection shared by land.project.get and land.projects.browse.
 * `record` is either a rich assembled zap-outcomes record (`{ project_id,
 * actions: [...exact ZAP API action objects], open_data: {...}, ... }`) or a
 * thinner Open-Data-only warehouse/default-ULURP row. Richness is carried
 * explicitly rather than guessed from shape.
 */
export function projectLandProject(record, { richness = "open_data_only", populationAsOf = null, nowMs = Date.now() } = {}) {
  const resolved = resolveLandActionProcedures(record);
  const decisionPath = publicLandDecisionPathView(buildLandDecisionPathView(record, { generatedAt: populationAsOf }));
  const projectId = resolved.project_id || clean(record?.project_id);
  const openData = record?.open_data && typeof record.open_data === "object" ? record.open_data : record || {};
  const isExact = richness === "exact";

  const observations = [];
  if (openData && Object.keys(openData).length) {
    observations.push(sourceObservation("zap-projects-open-data", projectId, populationAsOf));
  }
  if (isExact) {
    observations.push(sourceObservation("zap-api-outcomes", projectId, record.generated_at || null));
  }
  if (!observations.length) observations.push(sourceObservation("zap-projects-open-data", projectId, populationAsOf));

  return {
    object_type: "land_project",
    schema: "cityscroll.capability.land_project.v1",
    project_id: projectId,
    canonical_id: `land:project:${projectId}`,
    deep_link: landProjectUrl(projectId),
    project_name: openData.project_name || null,
    statuses: {
      public_status: openData.public_status || null,
      project_status: openData.project_status || null,
    },
    geography: {
      borough: openData.borough || null,
      community_district: openData.community_district || null,
      council_district: openData.cc_district || null,
    },
    applicant: {
      primary_applicant: openData.primary_applicant || null,
    },
    procedure: {
      publisher_observation: clean(openData.ulurp_non),
      resolution: resolved.procedure_resolution,
      actions: resolved.land_actions,
      raw: resolved.raw,
    },
    decision_path: decisionPath,
    environmental: {
      ceqr_number: openData.ceqr_number || null,
      ceqr_type: openData.ceqr_type || null,
      ceqr_lead_agency: openData.ceqr_lead_agency || openData.ceqr_leadagency || null,
      environmental_review_type: openData.environmental_review_type || openData.eas_eis || null,
      environmental_status: openData.environmental_status ?? null,
      environmental_milestone: openData.environmental_milestone || openData.current_envmilestone || null,
      environmental_milestone_date: openData.environmental_milestone_date || openData.current_envmilestone_date || null,
      environmental_projection: openData.environmental_projection || null,
    },
    milestones: {
      current_milestone: openData.current_milestone || null,
      current_milestone_date: openData.current_milestone_date || null,
    },
    outcomes: isExact ? {
      available: true,
      filled: Boolean(record.filled),
      dob: record.dob || null,
      bbls: Array.isArray(record.bbls) ? record.bbls : null,
      city_record_notices: record.city_record_notices || null,
      spine: record.spine || null,
      statutory_clock: record.statutory_clock || null,
      zoning_statistics: record.zoning_statistics || null,
    } : {
      available: false,
      reason: "not_materialized",
    },
    source_observations: observations,
    conflicts: collectConflicts(resolved.land_actions),
    coverage: {
      state: isExact ? "observed" : "open_data_only",
      richness,
    },
    freshness: {
      as_of: isExact ? (record.generated_at || populationAsOf || "unknown") : (populationAsOf || "unknown"),
      generated_at: isExact ? (record.generated_at || null) : null,
      population_as_of: populationAsOf,
      stale: isExact ? !outcomeCacheIsFresh(record, nowMs) : null,
    },
  };
}

export function workerLandProjectGet(env, { nowMs = Date.now() } = {}) {
  return Object.freeze({
    capabilityReference: LAND_PROJECT_GET_CAPABILITY_REFERENCE,
    providerId: LAND_PROJECT_GET_PROVIDER_ID,
    async execute(input) {
      try {
        const projectId = input.projectId.trim();
        const injectedExact = env?.LAND_PROJECT_RECORDS?.[projectId];
        const cachedExact = injectedExact || await readZapOutcomeRecord(env, projectId);
        if (cachedExact && cachedExact.project_id) {
          return {
            capability_reference: LAND_PROJECT_GET_CAPABILITY_REFERENCE,
            availability: "available",
            project: projectLandProject(cachedExact, { richness: "exact", nowMs }),
            error: null,
          };
        }
        const population = await completeLandProjectPopulation(env);
        const row = population.rows.find((candidate) => clean(candidate?.project_id) === projectId);
        if (!row) {
          return { capability_reference: LAND_PROJECT_GET_CAPABILITY_REFERENCE, availability: "not_yet_public", project: null, error: "not-found" };
        }
        return {
          capability_reference: LAND_PROJECT_GET_CAPABILITY_REFERENCE,
          availability: "available",
          project: projectLandProject(row, { richness: "open_data_only", populationAsOf: population.generated_at, nowMs }),
          error: null,
        };
      } catch (error) {
        console.error("land project read model unavailable:", String(error?.message || error));
        return { capability_reference: LAND_PROJECT_GET_CAPABILITY_REFERENCE, availability: "unavailable", project: null, error: "unavailable" };
      }
    },
  });
}

export function workerLandDecisionPathGet(env, { nowMs = Date.now() } = {}) {
  const projectProvider = workerLandProjectGet(env, { nowMs });
  return Object.freeze({
    capabilityReference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
    providerId: LAND_DECISION_PATH_GET_PROVIDER_ID,
    async execute(input) {
      try {
        const projectResult = await projectProvider.execute(input);
        if (projectResult.availability !== "available") {
          return {
            capability_reference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
            availability: projectResult.availability,
            project_id: null,
            decision_path: null,
            error: projectResult.error,
          };
        }
        return {
          capability_reference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
          availability: "available",
          project_id: projectResult.project.project_id,
          decision_path: projectResult.project.decision_path,
          error: null,
        };
      } catch (error) {
        console.error("land decision path read model unavailable:", String(error?.message || error));
        return {
          capability_reference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
          availability: "unavailable",
          project_id: null,
          decision_path: null,
          error: "unavailable",
        };
      }
    },
  });
}

function lower(value) { return String(value ?? "").toLowerCase(); }

function encodeCursor(id) {
  return btoa(id).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  const padded = cursor.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - cursor.length % 4) % 4);
  const decoded = atob(padded);
  return decoded || null;
}

export function workerLandProjectsBrowse(env, { nowMs = Date.now() } = {}) {
  return Object.freeze({
    capabilityReference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE,
    providerId: LAND_PROJECTS_BROWSE_PROVIDER_ID,
    async execute(input) {
      try {
        const historical = input.corpus === "historical";
        const population = historical ? expeditedCorpusPopulation() : await completeLandProjectPopulation(env);
        const cursorId = decodeCursor(input.cursor);
        if (input.cursor && !cursorId) throw new Error("invalid cursor");

        const filterRows = historical ? population.flatRows : population.rows;
        const filtered = filterLandSnapshot(filterRows, {
          // Never active-only: an explicit status stays honored, but the
          // unfiltered default is every publisher-observed status, not the
          // resident list's own active-only default. See the negative rule:
          // this provider must not read an interface-only active slice that
          // silently omits completed projects.
          status: input.status || "all",
          stage: input.stage || "any",
          procedure: input.procedure,
          family: input.family,
          regulatoryEffect: input.regulatoryEffect,
          borough: input.borough,
          communityDistrict: input.communityDistrict,
          councilDistrict: input.councilDistrict,
          keyword: input.query,
          limit: filterRows.length || 1,
        });
        const candidates = filtered
          .map((row) => historical ? population.byId.get(clean(row?.project_id)) : row)
          .filter(Boolean)
          .map((row) => projectLandProject(row, { richness: historical ? "exact" : "open_data_only", populationAsOf: population.generated_at, nowMs }))
          .sort((a, b) => a.project_id.localeCompare(b.project_id));

        const after = cursorId ? candidates.findIndex((project) => project.project_id === cursorId) : -1;
        if (cursorId && after < 0) throw new Error("invalid cursor");
        const start = after + 1;
        const limit = input.limit || LAND_PROJECTS_BROWSE_LIMITS.default;
        const results = candidates.slice(start, start + limit);
        const truncated = start + results.length < candidates.length;

        return {
          capability_reference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE,
          availability: results.length ? "complete" : "empty",
          results,
          total_matches: candidates.length,
          pagination: {
            limit,
            returned: results.length,
            truncated,
            next_cursor: truncated ? encodeCursor(results.at(-1).project_id) : null,
          },
          coverage: { sources: population.sources },
          freshness: { as_of: population.generated_at || "unknown", generated_at: population.generated_at || null },
          error: null,
        };
      } catch (error) {
        console.error("land projects browse read model unavailable:", String(error?.message || error));
        return { capability_reference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE, availability: "unavailable", results: null, total_matches: null, pagination: null, coverage: null, freshness: null, error: "unavailable" };
      }
    },
  });
}

export function workerLandProjects(env, opts = {}) {
  return Object.freeze({
    get: workerLandProjectGet(env, opts),
    browse: workerLandProjectsBrowse(env, opts),
    decisionPath: workerLandDecisionPathGet(env, opts),
  });
}

export function mcpLandProjectGetInput(args = {}) {
  return { projectId: String(args.project_id || args.id || "").trim() };
}

export function mcpLandDecisionPathGetInput(args = {}) {
  return { projectId: String(args.project_id || args.id || "").trim() };
}

export function mcpLandProjectsBrowseInput(args = {}) {
  return {
    ...(args.status == null ? {} : { status: String(args.status).trim() }),
    ...(args.query == null ? {} : { query: String(args.query).trim() }),
    ...(args.procedure == null ? {} : { procedure: String(args.procedure).trim() }),
    ...(args.family == null ? {} : { family: String(args.family).trim() }),
    ...(args.stage == null ? {} : { stage: String(args.stage).trim() }),
    ...(args.regulatory_effect == null ? {} : { regulatoryEffect: String(args.regulatory_effect).trim() }),
    ...(args.borough == null ? {} : { borough: String(args.borough).trim() }),
    ...(args.community_district == null ? {} : { communityDistrict: String(args.community_district).trim() }),
    ...(args.council_district == null ? {} : { councilDistrict: String(args.council_district).trim() }),
    ...(args.corpus == null ? {} : { corpus: String(args.corpus).trim() }),
    ...(args.limit == null ? {} : { limit: Number(args.limit) }),
    ...(args.cursor == null ? {} : { cursor: String(args.cursor).trim() }),
  };
}

function projectSummary(project) {
  return [project.project_id, project.project_name, project.statuses.public_status, project.procedure.resolution]
    .filter(Boolean).join(" · ");
}

export function formatLandProjectText(result) {
  if (result.availability === "available") return projectSummary(result.project);
  return `Land project is ${result.availability.replaceAll("_", " ")} (${result.error}).`;
}

export function formatLandDecisionPathText(result) {
  if (result.availability !== "available") return `Land decision path is ${result.availability.replaceAll("_", " ")} (${result.error}).`;
  const path = result.decision_path;
  const current = path.observed.current_phase.phase_id || "unknown phase";
  const procedure = path.procedure.profile_id || path.procedure.resolution;
  const next = path.normative.expected_next_transition;
  const nextText = next?.kind === "parallel_group"
    ? `parallel review (${next.stages.map((stage) => stage.phase_id).join(" + ")})`
    : next?.stages?.[0]?.phase_id || "no published next transition";
  return `${result.project_id} · ${procedure} · observed ${current} · next ${nextText}`;
}

export function formatLandProjectsBrowseText(result) {
  if (result.availability === "empty") return "No Land projects match the bounded filters in the warehouse projection.";
  if (result.availability === "unavailable") return "Land projects browse is unavailable right now.";
  const lines = result.results.map((project, index) => `${index + 1}. ${projectSummary(project)}`);
  if (result.pagination.truncated) lines.push(`More results are available with cursor ${result.pagination.next_cursor}.`);
  return lines.join("\n");
}

function formatRequested(request) {
  const format = new URL(request.url).searchParams.get("format");
  return format === "text" || (request.headers.get("accept") || "").includes("text/plain");
}

export async function handleLandProject(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405);
  const url = new URL(request.url);
  const projectId = String(url.searchParams.get("id") || url.searchParams.get("project_id") || "").trim();
  if (!projectId || !LAND_PROJECT_ID_PATTERN.test(projectId)) {
    return json({ ok: false, reason: "invalid-request" }, 400);
  }
  const result = await executeLandProjectGet(workerLandProjectGet(env), { projectId });
  if (result.availability === "not_yet_public") return json(result, 404);
  if (result.availability === "unavailable") return json(result, 503);
  if (formatRequested(request)) return new Response(formatLandProjectText(result), { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
  return json(result, 200, "public, max-age=60, s-maxage=300, stale-while-revalidate=3600");
}

export async function handleLandDecisionPath(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405);
  const url = new URL(request.url);
  const projectId = String(url.searchParams.get("id") || url.searchParams.get("project_id") || "").trim();
  if (!projectId || !LAND_PROJECT_ID_PATTERN.test(projectId)) {
    return json({ ok: false, reason: "invalid-request" }, 400);
  }
  try {
    const result = await executeLandDecisionPathGet(workerLandDecisionPathGet(env), { projectId });
    if (result.availability === "not_yet_public") return json(result, 404);
    if (result.availability === "unavailable") return json(result, 503);
    if (formatRequested(request)) return new Response(formatLandDecisionPathText(result), { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    return json(result, 200, "public, max-age=60, s-maxage=300, stale-while-revalidate=3600");
  } catch (error) {
    const invalid = /(?:field|bounded|string|integer|does not accept)/i.test(String(error?.message || error));
    return json({ ok: false, reason: invalid ? "invalid-request" : "unavailable" }, invalid ? 400 : 503);
  }
}

export async function handleLandProjectsBrowse(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405);
  const url = new URL(request.url);
  const input = {
    ...(url.searchParams.has("status") ? { status: String(url.searchParams.get("status")) } : {}),
    ...(url.searchParams.has("q") ? { query: String(url.searchParams.get("q")) } : {}),
    ...(url.searchParams.has("query") ? { query: String(url.searchParams.get("query")) } : {}),
    ...(url.searchParams.has("procedure") ? { procedure: String(url.searchParams.get("procedure")) } : {}),
    ...(url.searchParams.has("family") ? { family: String(url.searchParams.get("family")) } : {}),
    ...(url.searchParams.has("stage") ? { stage: String(url.searchParams.get("stage")) } : {}),
    ...(url.searchParams.has("regulatory_effect") ? { regulatoryEffect: String(url.searchParams.get("regulatory_effect")) } : {}),
    ...(url.searchParams.has("borough") ? { borough: String(url.searchParams.get("borough")) } : {}),
    ...(url.searchParams.has("community_district") ? { communityDistrict: String(url.searchParams.get("community_district")) } : {}),
    ...(url.searchParams.has("council_district") ? { councilDistrict: String(url.searchParams.get("council_district")) } : {}),
    ...(url.searchParams.has("corpus") ? { corpus: String(url.searchParams.get("corpus")) } : {}),
    ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
    ...(url.searchParams.has("cursor") ? { cursor: String(url.searchParams.get("cursor")) } : {}),
  };
  try {
    const result = await executeLandProjectsBrowse(workerLandProjectsBrowse(env), input);
    if (result.availability === "unavailable") return json(result, 503);
    if (formatRequested(request)) return new Response(formatLandProjectsBrowseText(result), { status: 200, headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60" } });
    return json(result, 200, "public, max-age=60, s-maxage=300, stale-while-revalidate=3600");
  } catch (error) {
    const invalid = /(?:field|bounded|string|integer|does not accept)/i.test(String(error?.message || error));
    return json({ ok: false, reason: invalid ? "invalid-request" : "unavailable" }, invalid ? 400 : 503);
  }
}
