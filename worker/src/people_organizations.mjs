// HTTP adapters and explicit providers for the bounded People and
// organizations capability. Request-time reads use the committed static
// artifact; publisher APIs and raw source stores are not dependencies.

import {
  executePeopleGet,
  executeOrganizationsBrowse,
  PEOPLE_GET_CAPABILITY_REFERENCE,
  PEOPLE_GET_LIMITS,
  PEOPLE_GET_PROVIDER_ID,
  ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE,
  ORGANIZATIONS_BROWSE_LIMITS,
  ORGANIZATIONS_BROWSE_PROVIDER_ID,
} from "../../capabilities/people_organizations.mjs";
import {
  modelRows,
  organizationsBrowseFromModel,
} from "../../capabilities/people_organizations_provider.mjs";

const MODEL_URL = "https://cityscroll.org/data/people_organizations_read_model.json";
const CACHE = "public, max-age=60, s-maxage=300, stale-while-revalidate=3600";

export const PEOPLE_GET_HTTP_ADAPTER = Object.freeze({ id: "worker-http.people-get@1", capabilityReference: PEOPLE_GET_CAPABILITY_REFERENCE, providerId: PEOPLE_GET_PROVIDER_ID, route: "GET /people-organizations?id=", surface: "People and organizations" });
export const ORGANIZATIONS_BROWSE_HTTP_ADAPTER = Object.freeze({ id: "worker-http.organizations-browse@1", capabilityReference: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE, providerId: ORGANIZATIONS_BROWSE_PROVIDER_ID, route: "GET /people-organizations", surface: "People and organizations browse" });

function clean(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function corsHeaders() { return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Accept, Content-Type" }; }
function json(body, status = 200, cacheControl = "no-store") { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff" } }); }

async function readModel(env) {
  if (env?.PEOPLE_ORGANIZATIONS_READ_MODEL && typeof env.PEOPLE_ORGANIZATIONS_READ_MODEL === "object") return env.PEOPLE_ORGANIZATIONS_READ_MODEL;
  const response = await fetch(MODEL_URL, { headers: { Accept: "application/json" }, cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`people organizations read model ${response.status}`);
  return response.json();
}

function freshness(model) { return { as_of: model.generated_at || "unknown", generated_at: model.generated_at || null }; }
function coverage(model) { return { state: model.generated_at ? "published" : "unknown", read_model_schema: model.schema, row_kinds: model.row_kinds, relation_states: model.relation_states, counts: model.counts }; }
function publicModelRow(row) {
  // The materialized search_text is a presentation/index field, not public row meaning.
  return Object.fromEntries(Object.entries(row).filter(([field]) => field !== "search_text"));
}
export function workerPeopleOrganizations(env) {
  return Object.freeze({
    get: Object.freeze({
      capabilityReference: PEOPLE_GET_CAPABILITY_REFERENCE,
      providerId: PEOPLE_GET_PROVIDER_ID,
      async execute(input) {
        try {
          const model = await readModel(env);
          if (model?.schema !== "cityscroll.people_organizations_read_model.v1") throw new Error("people organizations read model is unavailable");
          const row = modelRows(model).find((candidate) => candidate.id === input.entityId.trim());
          return { capability_reference: PEOPLE_GET_CAPABILITY_REFERENCE, availability: row ? "available" : "not_yet_public", person_or_organization: row ? publicModelRow(row) : null, error: row ? null : "not-found" };
        } catch (error) {
          console.error("people organizations read model unavailable:", String(error?.message || error));
          return { capability_reference: PEOPLE_GET_CAPABILITY_REFERENCE, availability: "unavailable", person_or_organization: null, error: "unavailable" };
        }
      },
    }),
    browse: Object.freeze({
      capabilityReference: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE,
      providerId: ORGANIZATIONS_BROWSE_PROVIDER_ID,
      async execute(input) {
        try {
          const model = await readModel(env);
          if (model?.schema !== "cityscroll.people_organizations_read_model.v1") throw new Error("people organizations read model is unavailable");
          return organizationsBrowseFromModel(model, input);
        } catch (error) {
          console.error("people organizations browse unavailable:", String(error?.message || error));
          return { capability_reference: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE, availability: "unavailable", results: null, total_matches: null, pagination: null, coverage: null, freshness: null, error: "unavailable" };
        }
      },
    }),
  });
}

function summary(row) { return [row.id, row.label, row.kind, row.detail].filter(Boolean).join(" · "); }
export function mcpPeopleGetInput(args = {}) { return { entityId: String(args.entity_id || args.id || "").trim() }; }
export function mcpOrganizationsBrowseInput(args = {}) { return { ...(args.query == null ? {} : { query: String(args.query).trim() }), ...(args.kind == null ? {} : { kind: String(args.kind).trim() }), ...(args.limit == null ? {} : { limit: Number(args.limit) }), ...(args.cursor == null ? {} : { cursor: String(args.cursor).trim() }) }; }
export function formatPeopleGetText(result) { return result.availability === "available" ? summary(result.person_or_organization) : `People or organization row is ${result.availability.replaceAll("_", " ")} (${result.error}).`; }
export function formatOrganizationsBrowseText(result) { if (result.availability === "empty") return "No people or organizations match the bounded filters in the published read model."; if (result.availability === "unavailable") return "People and organizations browse is unavailable right now."; return result.results.map((row, index) => `${index + 1}. ${summary(row)}`).join("\n"); }

export async function handlePeopleOrganizations(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405);
  const url = new URL(request.url);
  const id = clean(url.searchParams.get("id") || url.searchParams.get("entity_id"));
  if (id) {
    if (id.length > PEOPLE_GET_LIMITS.entityIdMaximumLength || !id.includes(":")) return json({ ok: false, reason: "invalid-request" }, 400);
    const result = await executePeopleGet(workerPeopleOrganizations(env).get, { entityId: id });
    if (result.availability === "not_yet_public") return json(result, 404);
    if (result.availability === "unavailable") return json(result, 503);
    if ((url.searchParams.get("format") || "") === "text" || (request.headers.get("accept") || "").includes("text/plain")) return new Response(formatPeopleGetText(result), { headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": CACHE } });
    return json(result, 200, CACHE);
  }
  const input = { ...(url.searchParams.has("q") ? { query: String(url.searchParams.get("q")) } : {}), ...(url.searchParams.has("query") ? { query: String(url.searchParams.get("query")) } : {}), ...(url.searchParams.has("kind") ? { kind: String(url.searchParams.get("kind")) } : {}), ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}), ...(url.searchParams.has("cursor") ? { cursor: String(url.searchParams.get("cursor")) } : {}) };
  try {
    const result = await executeOrganizationsBrowse(workerPeopleOrganizations(env).browse, input);
    if (result.availability === "unavailable") return json(result, 503);
    if ((url.searchParams.get("format") || "") === "text" || (request.headers.get("accept") || "").includes("text/plain")) return new Response(formatOrganizationsBrowseText(result), { headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": CACHE } });
    return json(result, 200, CACHE);
  } catch (error) { return json({ ok: false, reason: /(?:field|bounded|string|integer|kind|cursor|does not accept)/i.test(String(error?.message || error)) ? "invalid-request" : "unavailable" }, 400); }
}
