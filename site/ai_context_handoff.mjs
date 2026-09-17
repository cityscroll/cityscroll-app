/**
 * Exact public-context handoffs into the Ask with AI setup page.
 *
 * Semantic authority stays in MCP tool bindings and scope serializers. This
 * module only packages allowlisted public identity, route, and supported tool
 * arguments — never watches, mail, session state, or invented ids.
 */

import { AI_ENDPOINT, escapeAiDiscoveryHtml as esc } from "./ai_discovery.mjs";
import { landProjectPath } from "./land_project_route.mjs";
import { procurementCanonicalHref } from "./procurement_route.mjs";

export const AI_CONTEXT_HANDOFF_SCHEMA = "cityscroll.ai_context_handoff.v1";
export const AI_CONTEXT_SETUP_PATH = "/use-with-ai/";
export const AI_CONTEXT_MORE_TOOLS_LABEL = "More tools";
export const AI_CONTEXT_RECORD_ACTION_LABEL = "Investigate with an assistant";
export const AI_CONTEXT_SCOPE_ACTION_LABEL = "Investigate this search with an assistant";

const MAX_ID = 320;
const MAX_ROUTE = 500;
const MAX_QUERY = 240;
const MAX_AGENCY = 160;
const MAX_TASK = 1200;
const MAX_URL = 1800;

const PRIVATE_KEYS = Object.freeze(new Set([
  "token", "watch_token", "watchToken", "email", "mail", "session", "session_id",
  "sessionId", "note", "notes", "private_note", "privateNotes", "return", "return_url",
  "returnUrl", "redirect", "next", "desk", "auth", "password", "cookie",
]));

const NOTICE_SEARCH_KEYS = Object.freeze(new Set([
  "query", "section", "agency", "min_amount", "max_amount", "open_only", "exclude_rolling", "limit",
]));

const FEDERATED_SEARCH_KEYS = Object.freeze(new Set(["query", "limit", "scope", "lenses"]));

const FAMILY_BINDINGS = Object.freeze({
  contract: Object.freeze({
    family: "contracts",
    kind: "contract",
    tool: "get_contract",
    argKey: "procurement_id",
    prompt: (id) => `Open contract ${id} with get_contract and summarize the public record with its source.`,
  }),
  notice: Object.freeze({
    family: "notices",
    kind: "notice",
    tool: "get_notice",
    argKey: "request_id",
    prompt: (id) => `Open notice ${id} with get_notice and summarize the public City Record notice with its source and date.`,
  }),
  meeting: Object.freeze({
    family: "meetings",
    kind: "meeting",
    tool: "get_meeting",
    argKey: "meeting_id",
    prompt: (id) => `Open meeting ${id} with get_meeting and summarize the public agenda facts and attached documents.`,
  }),
  land_project: Object.freeze({
    family: "land",
    kind: "land_project",
    tool: "get_land_project",
    secondaryTools: Object.freeze(["get_land_decision_path"]),
    argKey: "project_id",
    prompt: (id) => `Look up land-use project ${id} with get_land_project and get_land_decision_path, then explain its next recorded decision step.`,
  }),
  entity: Object.freeze({
    family: "entities",
    kind: "entity",
    tool: "get_entity_dossier",
    secondaryTools: Object.freeze(["get_person_or_organization"]),
    argKey: "entity_id",
    prompt: (id) => `Open entity ${id} with get_entity_dossier (and get_person_or_organization when the row is typed) and summarize the public dossier without inventing identity from a display name.`,
  }),
});

const UNSUPPORTED_EXACT_FAMILIES = Object.freeze([
  "rules", "property", "exams", "consultations", "districts", "institutions",
]);

/**
 * Closed dispositions for how a published page family exposes contextual
 * assistant handoff. `exact` means an existing MCP tool represents the task.
 * `unsupported` keeps the refusal named and routes to general setup.
 * `general` covers pages that are not exact research scopes.
 */
export const AI_CONTEXT_HANDOFF_DISPOSITIONS = Object.freeze([
  "exact",
  "unsupported",
  "general",
]);

/**
 * Census of every published page family from the performance-classification
 * surface registry. Compared as an equal set against that manifest so a newly
 * published family without a row fails, and a censused unpublished family fails.
 */
export const PAGE_FAMILY_AI_CONTEXT = Object.freeze([
  Object.freeze({ surface_id: "about", handoff: "general", family: null, reason: "About is orientation prose; general setup remains reachable from shared Ask with AI." }),
  Object.freeze({ surface_id: "agency", handoff: "exact", family: "entities", kind: "entity", tools: Object.freeze(["get_entity_dossier", "get_person_or_organization"]) }),
  Object.freeze({ surface_id: "api-guide", handoff: "general", family: null, reason: "API guide already introduces the public endpoint; no second scoped research promise." }),
  Object.freeze({ surface_id: "assertion", handoff: "general", family: null, reason: "Assertion pages have no exact public MCP get tool." }),
  Object.freeze({ surface_id: "browse", handoff: "exact", family: "search", kind: "search_scope", tools: Object.freeze(["search_federated"]) }),
  Object.freeze({ surface_id: "browse-contracts", handoff: "exact", family: "contracts", kind: "browse_contracts", tools: Object.freeze(["browse_contracts"]) }),
  Object.freeze({ surface_id: "browse-exams", handoff: "unsupported", family: "exams" }),
  Object.freeze({ surface_id: "browse-meetings", handoff: "exact", family: "search", kind: "search_scope", tools: Object.freeze(["search_federated"]) }),
  Object.freeze({ surface_id: "browse-people", handoff: "exact", family: "entities", kind: "browse_organizations", tools: Object.freeze(["browse_organizations"]) }),
  Object.freeze({ surface_id: "browse-places", handoff: "general", family: null, reason: "Place browse has no exact public MCP browse tool distinct from parcel or Land." }),
  Object.freeze({ surface_id: "browse-property", handoff: "unsupported", family: "property" }),
  Object.freeze({ surface_id: "browse-rules", handoff: "unsupported", family: "rules" }),
  Object.freeze({ surface_id: "browse-staffing", handoff: "general", family: null, reason: "Staffing browse has no exact public MCP tool binding." }),
  Object.freeze({ surface_id: "browse-zoning", handoff: "exact", family: "land", kind: "browse_land_projects", tools: Object.freeze(["browse_land_projects"]) }),
  Object.freeze({ surface_id: "changelog", handoff: "general", family: null, reason: "Release notes are not a research scope." }),
  Object.freeze({ surface_id: "committee", handoff: "exact", family: "entities", kind: "entity", tools: Object.freeze(["get_entity_dossier", "get_person_or_organization"]) }),
  Object.freeze({ surface_id: "community-board", handoff: "exact", family: "entities", kind: "entity", tools: Object.freeze(["get_entity_dossier", "get_person_or_organization"]) }),
  Object.freeze({ surface_id: "data-guide", handoff: "general", family: null, reason: "Dataset aggregates page; generic setup remains reachable without a scoped promise." }),
  Object.freeze({ surface_id: "data-health", handoff: "general", family: null, reason: "Data-health dashboards are not exact record research scopes." }),
  Object.freeze({ surface_id: "district-digest", handoff: "unsupported", family: "districts" }),
  Object.freeze({ surface_id: "exam", handoff: "unsupported", family: "exams" }),
  Object.freeze({ surface_id: "following", handoff: "general", family: null, reason: "Following is stateful reader state, not an exact public MCP get." }),
  Object.freeze({ surface_id: "following-pack", handoff: "general", family: null, reason: "Following packs are delivery artifacts, not exact MCP research scopes." }),
  Object.freeze({ surface_id: "guide", handoff: "general", family: null, reason: "Guide prose links to setup without inventing an exact tool task." }),
  Object.freeze({ surface_id: "guide-article", handoff: "general", family: null, reason: "Guide articles are explanatory prose without exact MCP identity." }),
  Object.freeze({ surface_id: "home", handoff: "general", family: null, reason: "Homepage keeps citizen search primary; shared Ask with AI covers general setup." }),
  Object.freeze({ surface_id: "mandate", handoff: "general", family: null, reason: "Mandate pages have no exact public MCP get tool." }),
  Object.freeze({ surface_id: "meeting", handoff: "exact", family: "meetings", kind: "meeting", tools: Object.freeze(["get_meeting"]) }),
  Object.freeze({ surface_id: "near-you", handoff: "general", family: null, reason: "Near You is place navigation, not an exact MCP record handoff." }),
  Object.freeze({ surface_id: "notice", handoff: "exact", family: "notices", kind: "notice", tools: Object.freeze(["get_notice"]) }),
  Object.freeze({ surface_id: "now", handoff: "general", family: null, reason: "Now is a timed reading surface without one exact MCP identity." }),
  Object.freeze({ surface_id: "official", handoff: "exact", family: "entities", kind: "entity", tools: Object.freeze(["get_entity_dossier", "get_person_or_organization"]) }),
  Object.freeze({ surface_id: "parcel", handoff: "unsupported", family: "property" }),
  Object.freeze({ surface_id: "procurement", handoff: "exact", family: "contracts", kind: "contract", tools: Object.freeze(["get_contract"]) }),
  Object.freeze({ surface_id: "public-stats", handoff: "general", family: null, reason: "Public stats are aggregates without an exact record tool." }),
  Object.freeze({ surface_id: "rulemaking", handoff: "unsupported", family: "rules" }),
  Object.freeze({ surface_id: "search", handoff: "exact", family: "search", kind: "search_scope", tools: Object.freeze(["search_federated", "search_notices"]) }),
  Object.freeze({ surface_id: "standards", handoff: "general", family: null, reason: "Standards documentation has no supported exact MCP task context." }),
  Object.freeze({ surface_id: "vendor", handoff: "exact", family: "entities", kind: "entity", tools: Object.freeze(["get_entity_dossier", "get_person_or_organization"]) }),
]);

export function pageFamilyAiContextSurfaceIds(rows = PAGE_FAMILY_AI_CONTEXT) {
  return (rows || []).map((row) => row.surface_id);
}

function cleanText(value, max = MAX_ID) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text || text.length > max) return null;
  return text;
}

function cleanPublicRoute(value) {
  const raw = cleanText(value, MAX_ROUTE);
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[<>\\\s]/.test(raw)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  if (/^(?:https?:|javascript:|data:)/i.test(raw)) return null;
  return raw.split("?")[0];
}

function stripPrivateFields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return Object.freeze({});
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (PRIVATE_KEYS.has(key)) continue;
    if (/token|email|session|password|cookie|desk|private/i.test(key)) continue;
    if (value == null || value === "") continue;
    out[key] = value;
  }
  return Object.freeze(out);
}

function emptyHandoff(status, extras = {}) {
  return Object.freeze({
    schema: AI_CONTEXT_HANDOFF_SCHEMA,
    status,
    support: status === "ok" ? "exact" : (status === "unsupported_filters" || status === "unsupported_family" ? "unsupported" : "general"),
    family: extras.family || null,
    kind: extras.kind || null,
    id: extras.id || null,
    canonical_href: extras.canonical_href || null,
    tools: Object.freeze(Array.isArray(extras.tools) ? extras.tools : []),
    arguments: Object.freeze(extras.arguments && typeof extras.arguments === "object" ? extras.arguments : {}),
    unsupported_filters: Object.freeze(Array.isArray(extras.unsupported_filters) ? extras.unsupported_filters : []),
    supported_filters: Object.freeze(extras.supported_filters && typeof extras.supported_filters === "object" ? extras.supported_filters : {}),
    reason: extras.reason || null,
    task: extras.task || null,
    endpoint: AI_ENDPOINT,
    setup_href: AI_CONTEXT_SETUP_PATH,
  });
}

function exactHandoff(binding, id, canonicalHref, extras = {}) {
  const args = Object.freeze({ [binding.argKey]: id });
  const tools = Object.freeze([binding.tool, ...(binding.secondaryTools || [])]);
  return Object.freeze({
    schema: AI_CONTEXT_HANDOFF_SCHEMA,
    status: "ok",
    support: "exact",
    family: binding.family,
    kind: binding.kind,
    id,
    canonical_href: canonicalHref,
    tools,
    arguments: args,
    unsupported_filters: Object.freeze([]),
    supported_filters: Object.freeze({}),
    task: binding.prompt(id),
    endpoint: AI_ENDPOINT,
    setup_href: AI_CONTEXT_SETUP_PATH,
    ...extras,
  });
}

export function buildContractAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const id = cleanText(publicInput.procurement_id || publicInput.id, MAX_ID);
  if (!id || !id.startsWith("procurement:")) {
    return emptyHandoff("missing_identity", { family: "contracts", kind: "contract" });
  }
  const route = cleanPublicRoute(publicInput.canonical_href) || procurementCanonicalHref(id);
  return exactHandoff(FAMILY_BINDINGS.contract, id, route);
}

export function buildNoticeAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const id = cleanText(publicInput.request_id || publicInput.id, 40);
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(id)) {
    return emptyHandoff("missing_identity", { family: "notices", kind: "notice" });
  }
  const route = cleanPublicRoute(publicInput.canonical_href) || `/notices/${encodeURIComponent(id)}/`;
  return exactHandoff(FAMILY_BINDINGS.notice, id, route);
}

export function buildMeetingAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const id = cleanText(publicInput.meeting_id || publicInput.id, MAX_ID);
  if (!id || !id.startsWith("meeting:")) {
    return emptyHandoff("missing_identity", { family: "meetings", kind: "meeting" });
  }
  const route = cleanPublicRoute(publicInput.canonical_href) || `/meetings/${encodeURIComponent(id)}/`;
  return exactHandoff(FAMILY_BINDINGS.meeting, id, route);
}

export function buildLandProjectAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const id = cleanText(publicInput.project_id || publicInput.id, 40);
  const route = cleanPublicRoute(publicInput.canonical_href) || landProjectPath(id);
  if (!id || !route) {
    return emptyHandoff("missing_identity", { family: "land", kind: "land_project" });
  }
  return exactHandoff(FAMILY_BINDINGS.land_project, id, route);
}

export function buildEntityAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  // Display names never mint identity. Exact entity_id only.
  if (publicInput.display_name && !publicInput.entity_id && !publicInput.id) {
    return emptyHandoff("missing_identity", { family: "entities", kind: "entity" });
  }
  const id = cleanText(publicInput.entity_id || publicInput.id, MAX_ID);
  if (!id || !id.includes(":")) {
    return emptyHandoff("missing_identity", { family: "entities", kind: "entity" });
  }
  const route = cleanPublicRoute(publicInput.canonical_href)
    || (id.startsWith("agency:id:") ? `/agencies/${encodeURIComponent(id.replace(/^agency:id:/, ""))}/` : null);
  return exactHandoff(FAMILY_BINDINGS.entity, id, route);
}

function compactAmount(value) {
  if (value == null || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * Build a scoped search handoff. Supported filters are projected into the
 * matching MCP tool; unsupported exact filters stay listed and never broaden
 * the assistant task by silent omission.
 */
export function buildSearchAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const mode = cleanText(publicInput.mode || publicInput.tool || "federated", 40) || "federated";
  const query = cleanText(publicInput.query || publicInput.q, MAX_QUERY);
  const agency = cleanText(publicInput.agency, MAX_AGENCY);
  const section = cleanText(publicInput.section, 80);
  const minAmount = compactAmount(publicInput.min_amount ?? publicInput.minAmount);
  const maxAmount = compactAmount(publicInput.max_amount ?? publicInput.maxAmount);
  const openOnly = publicInput.open_only === true || publicInput.openOnly === true;
  const excludeRolling = publicInput.exclude_rolling === true || publicInput.excludeRolling === true;
  const lenses = Array.isArray(publicInput.lenses)
    ? publicInput.lenses.map((value) => cleanText(value, 40)).filter(Boolean)
    : (cleanText(publicInput.lens || publicInput.scope, 40) ? [cleanText(publicInput.lens || publicInput.scope, 40)] : []);

  const requested = stripPrivateFields({
    ...publicInput,
    query,
    agency,
    section,
    min_amount: minAmount,
    max_amount: maxAmount,
    open_only: openOnly || undefined,
    exclude_rolling: excludeRolling || undefined,
    lenses,
  });

  const unsupported = [];
  for (const key of Object.keys(requested)) {
    if ([
      "mode", "tool", "q", "minAmount", "maxAmount", "openOnly", "excludeRolling", "lens",
      "canonical_href", "hash", "kind", "family", "id", "support", "status",
    ].includes(key)) continue;
    if (mode === "notices" && !NOTICE_SEARCH_KEYS.has(key) && key !== "lenses") unsupported.push(key);
    if (mode !== "notices" && !FEDERATED_SEARCH_KEYS.has(key) && !["agency", "section", "min_amount", "max_amount", "open_only", "exclude_rolling"].includes(key)) {
      unsupported.push(key);
    }
  }
  // Place and time axes are never part of search_federated.
  for (const key of ["boro", "borough", "cd", "council", "neighborhood", "when", "months", "place", "time_window", "start", "end"]) {
    if (requested[key] != null && requested[key] !== "" && !unsupported.includes(key)) unsupported.push(key);
  }
  // Agency/amount on federated search are unsupported (notice search only).
  if (mode !== "notices") {
    for (const key of ["agency", "section", "min_amount", "max_amount", "open_only", "exclude_rolling"]) {
      if (requested[key] != null && requested[key] !== "" && requested[key] !== false && !unsupported.includes(key)) {
        unsupported.push(key);
      }
    }
  }

  if (!query) {
    return emptyHandoff("missing_identity", {
      family: "search",
      kind: "search_scope",
      unsupported_filters: unsupported,
    });
  }

  if (unsupported.length) {
    const task = [
      `Exact assistant support is unavailable for filter(s): ${unsupported.join(", ")}.`,
      "Connect the public CityScroll MCP endpoint from setup, then rebuild only the supported filters rather than broadening this scoped search.",
      query ? `Current query text: “${query}”.` : null,
    ].filter(Boolean).join(" ");
    return emptyHandoff("unsupported_filters", {
      family: "search",
      kind: "search_scope",
      id: query,
      canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/search/",
      unsupported_filters: unsupported,
      supported_filters: mode === "notices"
        ? { query, agency, section, min_amount: minAmount, max_amount: maxAmount, open_only: openOnly || undefined, exclude_rolling: excludeRolling || undefined }
        : { query, lenses },
      task,
    });
  }

  if (mode === "notices") {
    const args = Object.freeze({
      query,
      ...(agency ? { agency } : {}),
      ...(section ? { section } : {}),
      ...(minAmount != null ? { min_amount: minAmount } : {}),
      ...(maxAmount != null ? { max_amount: maxAmount } : {}),
      ...(openOnly ? { open_only: true } : {}),
      ...(excludeRolling ? { exclude_rolling: true } : {}),
    });
    return Object.freeze({
      schema: AI_CONTEXT_HANDOFF_SCHEMA,
      status: "ok",
      support: "exact",
      family: "search",
      kind: "search_scope",
      id: query,
      canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/search/",
      tools: Object.freeze(["search_notices"]),
      arguments: args,
      unsupported_filters: Object.freeze([]),
      supported_filters: args,
      task: `Search CityScroll notices with search_notices using ${JSON.stringify(args)}, then show the source and date for each result.`,
      endpoint: AI_ENDPOINT,
      setup_href: AI_CONTEXT_SETUP_PATH,
    });
  }

  const args = Object.freeze({
    query,
    ...(lenses.length ? { scope: lenses.length === 1 ? lenses[0] : lenses } : {}),
  });
  return Object.freeze({
    schema: AI_CONTEXT_HANDOFF_SCHEMA,
    status: "ok",
    support: "exact",
    family: "search",
    kind: "search_scope",
    id: query,
    canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/search/",
    tools: Object.freeze(["search_federated"]),
    arguments: args,
    unsupported_filters: Object.freeze([]),
    supported_filters: args,
    task: `Search CityScroll with search_federated using ${JSON.stringify(args)}, then show the source and date for each result.`,
    endpoint: AI_ENDPOINT,
    setup_href: AI_CONTEXT_SETUP_PATH,
  });
}

export function buildUnsupportedFamilyAiContextHandoff(family, input = {}) {
  const name = cleanText(family, 40) || "this page";
  const publicInput = stripPrivateFields(input);
  return emptyHandoff("unsupported_family", {
    family: name,
    kind: name,
    canonical_href: cleanPublicRoute(publicInput.canonical_href),
    task: `Exact assistant support is not published for ${name}. Use the general CityScroll MCP setup, and do not invent an identity from a display name.`,
  });
}

function generalSetupHandoff(surfaceId, input = {}, reason = null) {
  const publicInput = stripPrivateFields(input);
  const name = cleanText(surfaceId, 40) || "this page";
  const statedReason = cleanText(reason, MAX_TASK) || null;
  return emptyHandoff("general_setup", {
    family: name,
    kind: name,
    canonical_href: cleanPublicRoute(publicInput.canonical_href),
    reason: statedReason,
    task: statedReason
      ? `Use the general CityScroll MCP setup from this page. No exact assistant task is published for ${name}. Reason: ${statedReason}`
      : `Use the general CityScroll MCP setup from this page. No exact assistant task is published for ${name}.`,
  });
}

/**
 * Scoped browse handoffs for existing browse_* MCP tools. Unsupported exact
 * filters stay listed rather than silently omitted.
 */
export function buildBrowseContractsAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const query = cleanText(publicInput.query || publicInput.q, MAX_QUERY);
  const agency = cleanText(publicInput.agency, MAX_AGENCY);
  const vendor = cleanText(publicInput.vendor, MAX_AGENCY);
  const unsupported = [];
  for (const key of Object.keys(publicInput)) {
    if (["query", "q", "agency", "vendor", "canonical_href", "kind", "family", "mode", "tool"].includes(key)) continue;
    if (publicInput[key] != null && publicInput[key] !== "") unsupported.push(key);
  }
  if (unsupported.length) {
    return emptyHandoff("unsupported_filters", {
      family: "contracts",
      kind: "browse_contracts",
      canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/browse/contracts/",
      unsupported_filters: unsupported,
      task: `Exact assistant support is unavailable for filter(s): ${unsupported.join(", ")}. Connect the public CityScroll MCP endpoint from setup, then rebuild only the supported browse_contracts filters rather than broadening this scoped browse.${query ? ` Current query text: “${query}”.` : ""}`,
    });
  }
  const args = Object.freeze({
    ...(query ? { query } : {}),
    ...(agency ? { agency } : {}),
    ...(vendor ? { vendor } : {}),
  });
  return Object.freeze({
    schema: AI_CONTEXT_HANDOFF_SCHEMA,
    status: "ok",
    support: "exact",
    family: "contracts",
    kind: "browse_contracts",
    id: query || agency || vendor || "browse_contracts",
    canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/browse/contracts/",
    tools: Object.freeze(["browse_contracts"]),
    arguments: args,
    unsupported_filters: Object.freeze([]),
    supported_filters: args,
    task: `Browse CityScroll contracts with browse_contracts using ${JSON.stringify(args)}, then show the source and date for each result.`,
    endpoint: AI_ENDPOINT,
    setup_href: AI_CONTEXT_SETUP_PATH,
  });
}

export function buildBrowseOrganizationsAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const query = cleanText(publicInput.query || publicInput.q, MAX_QUERY);
  const kind = cleanText(publicInput.org_kind || publicInput.organization_kind, 80);
  const unsupported = [];
  for (const key of Object.keys(publicInput)) {
    if (["query", "q", "org_kind", "organization_kind", "canonical_href", "kind", "family", "mode", "tool", "limit"].includes(key)) continue;
    if (publicInput[key] != null && publicInput[key] !== "") unsupported.push(key);
  }
  if (unsupported.length) {
    return emptyHandoff("unsupported_filters", {
      family: "entities",
      kind: "browse_organizations",
      canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/browse/people/",
      unsupported_filters: unsupported,
      task: `Exact assistant support is unavailable for filter(s): ${unsupported.join(", ")}. Connect the public CityScroll MCP endpoint from setup, then rebuild only the supported browse_organizations filters rather than broadening this scoped browse.${query ? ` Current query text: “${query}”.` : ""}`,
    });
  }
  const args = Object.freeze({
    ...(query ? { query } : {}),
    ...(kind ? { kind } : {}),
  });
  return Object.freeze({
    schema: AI_CONTEXT_HANDOFF_SCHEMA,
    status: "ok",
    support: "exact",
    family: "entities",
    kind: "browse_organizations",
    id: query || kind || "browse_organizations",
    canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/browse/people/",
    tools: Object.freeze(["browse_organizations"]),
    arguments: args,
    unsupported_filters: Object.freeze([]),
    supported_filters: args,
    task: `Browse CityScroll organizations with browse_organizations using ${JSON.stringify(args)}, then show the source for each result.`,
    endpoint: AI_ENDPOINT,
    setup_href: AI_CONTEXT_SETUP_PATH,
  });
}

export function buildBrowseLandProjectsAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const query = cleanText(publicInput.query || publicInput.q, MAX_QUERY);
  const status = cleanText(publicInput.status || publicInput.project_status, 240);
  const procedure = cleanText(publicInput.procedure, 40);
  const unsupported = [];
  for (const key of Object.keys(publicInput)) {
    if (["query", "q", "status", "project_status", "procedure", "canonical_href", "kind", "family", "mode", "tool", "limit"].includes(key)) continue;
    if (publicInput[key] != null && publicInput[key] !== "") unsupported.push(key);
  }
  if (unsupported.length) {
    return emptyHandoff("unsupported_filters", {
      family: "land",
      kind: "browse_land_projects",
      canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/browse/zoning/",
      unsupported_filters: unsupported,
      task: `Exact assistant support is unavailable for filter(s): ${unsupported.join(", ")}. Connect the public CityScroll MCP endpoint from setup, then rebuild only the supported browse_land_projects filters rather than broadening this scoped browse.${query ? ` Current query text: “${query}”.` : ""}`,
    });
  }
  const args = Object.freeze({
    ...(query ? { query } : {}),
    ...(status ? { status } : {}),
    ...(procedure ? { procedure } : {}),
  });
  return Object.freeze({
    schema: AI_CONTEXT_HANDOFF_SCHEMA,
    status: "ok",
    support: "exact",
    family: "land",
    kind: "browse_land_projects",
    id: query || status || procedure || "browse_land_projects",
    canonical_href: cleanPublicRoute(publicInput.canonical_href) || "/browse/zoning/",
    tools: Object.freeze(["browse_land_projects"]),
    arguments: args,
    unsupported_filters: Object.freeze([]),
    supported_filters: args,
    task: `Browse CityScroll land-use projects with browse_land_projects using ${JSON.stringify(args)}, then explain each project's recorded status with its source.`,
    endpoint: AI_ENDPOINT,
    setup_href: AI_CONTEXT_SETUP_PATH,
  });
}

/**
 * Resolve the declared census row for a published surface and build its
 * handoff. Exact rows use existing tools; unsupported and general rows refuse
 * a scoped promise while keeping setup reachable.
 */
export function buildAiContextHandoffForSurface(surfaceId, input = {}) {
  const id = cleanText(surfaceId, 80);
  const row = PAGE_FAMILY_AI_CONTEXT.find((entry) => entry.surface_id === id);
  if (!row) {
    return emptyHandoff("unsupported_family", { family: id || "unknown", kind: id || "unknown" });
  }
  const publicInput = stripPrivateFields({ ...input, kind: row.kind || row.family || row.surface_id });
  if (row.handoff === "unsupported") {
    return buildUnsupportedFamilyAiContextHandoff(row.family || row.surface_id, publicInput);
  }
  if (row.handoff === "general") {
    return generalSetupHandoff(row.surface_id, publicInput, row.reason);
  }
  if (row.kind === "contract") return buildContractAiContextHandoff(publicInput);
  if (row.kind === "notice") return buildNoticeAiContextHandoff(publicInput);
  if (row.kind === "meeting") return buildMeetingAiContextHandoff(publicInput);
  if (row.kind === "entity") return buildEntityAiContextHandoff(publicInput);
  if (row.kind === "search_scope") {
    return buildSearchAiContextHandoff({
      ...publicInput,
      ...(row.surface_id === "browse-meetings" && !publicInput.lenses ? { lenses: ["meetings"] } : {}),
    });
  }
  if (row.kind === "browse_contracts") return buildBrowseContractsAiContextHandoff(publicInput);
  if (row.kind === "browse_organizations") return buildBrowseOrganizationsAiContextHandoff(publicInput);
  if (row.kind === "browse_land_projects") return buildBrowseLandProjectsAiContextHandoff(publicInput);
  return emptyHandoff("unsupported_family", { family: row.family || row.surface_id, kind: row.kind || row.surface_id });
}

export function buildAiContextHandoff(input = {}) {
  const publicInput = stripPrivateFields(input);
  const kind = cleanText(publicInput.kind || publicInput.family, 40);
  if (!kind) return emptyHandoff("missing_identity");
  if (kind === "contract" || kind === "contracts") return buildContractAiContextHandoff(publicInput);
  if (kind === "notice" || kind === "notices") return buildNoticeAiContextHandoff(publicInput);
  if (kind === "meeting" || kind === "meetings") return buildMeetingAiContextHandoff(publicInput);
  if (kind === "land_project" || kind === "land" || kind === "zoning") return buildLandProjectAiContextHandoff(publicInput);
  if (kind === "entity" || kind === "entities" || kind === "person_or_organization") return buildEntityAiContextHandoff(publicInput);
  if (kind === "browse_contracts") return buildBrowseContractsAiContextHandoff(publicInput);
  if (kind === "browse_organizations") return buildBrowseOrganizationsAiContextHandoff(publicInput);
  if (kind === "browse_land_projects") return buildBrowseLandProjectsAiContextHandoff(publicInput);
  if (kind === "search" || kind === "search_scope" || kind === "browse") return buildSearchAiContextHandoff(publicInput);
  if (UNSUPPORTED_EXACT_FAMILIES.includes(kind)) return buildUnsupportedFamilyAiContextHandoff(kind, publicInput);
  return emptyHandoff("unsupported_family", { family: kind, kind });
}

export function aiContextHandoffHref(handoff, { base = AI_CONTEXT_SETUP_PATH } = {}) {
  const params = new URLSearchParams();
  if (!handoff || typeof handoff !== "object") return base;
  if (handoff.kind) params.set("kind", handoff.kind);
  if (handoff.id) params.set("id", handoff.id);
  if (handoff.canonical_href) params.set("route", handoff.canonical_href);
  if (handoff.support) params.set("support", handoff.support);
  if (handoff.status && handoff.status !== "ok") params.set("status", handoff.status);
  if (Array.isArray(handoff.tools) && handoff.tools[0]) params.set("tool", handoff.tools[0]);
  if (handoff.arguments && typeof handoff.arguments === "object") {
    for (const [key, value] of Object.entries(handoff.arguments)) {
      if (value == null || value === "") continue;
      if (key === "scope" && Array.isArray(value)) params.set("lenses", value.join(","));
      else if (key === "status" && handoff.kind === "browse_land_projects") params.set("project_status", String(value));
      else if (key === "kind" && handoff.kind === "browse_organizations") params.set("org_kind", String(value));
      else if (typeof value === "boolean") params.set(key, value ? "1" : "0");
      else params.set(key, String(value));
    }
  }
  if (Array.isArray(handoff.unsupported_filters) && handoff.unsupported_filters.length) {
    params.set("unsupported", handoff.unsupported_filters.join(","));
  }
  const query = params.toString();
  const href = query ? `${base}?${query}` : base;
  return href.length <= MAX_URL ? href : base;
}

export function parseAiContextHandoff(input) {
  const params = input instanceof URLSearchParams
    ? input
    : new URL(String(input || ""), "https://cityscroll.invalid").searchParams;
  if (![...params.keys()].length) return emptyHandoff("missing_identity");
  const kind = cleanText(params.get("kind"), 40);
  const payload = {
    kind,
    id: params.get("id"),
    procurement_id: params.get("procurement_id") || (kind === "contract" ? params.get("id") : null),
    request_id: params.get("request_id") || (kind === "notice" ? params.get("id") : null),
    meeting_id: params.get("meeting_id") || (kind === "meeting" ? params.get("id") : null),
    project_id: params.get("project_id") || (kind === "land_project" ? params.get("id") : null),
    entity_id: params.get("entity_id") || (kind === "entity" ? params.get("id") : null),
    canonical_href: params.get("route"),
    query: params.get("query") || params.get("q"),
    agency: params.get("agency"),
    vendor: params.get("vendor"),
    section: params.get("section"),
    status: params.get("project_status"),
    procedure: params.get("procedure"),
    org_kind: params.get("org_kind"),
    min_amount: params.get("min_amount"),
    max_amount: params.get("max_amount"),
    open_only: params.get("open_only") === "1",
    exclude_rolling: params.get("exclude_rolling") === "1",
    lenses: params.get("lenses") ? params.get("lenses").split(",").filter(Boolean) : undefined,
    mode: params.get("tool") === "search_notices" ? "notices" : (kind === "search_scope" || kind === "search" ? "federated" : undefined),
    // Hostile extras must be ignored rather than widening support.
    token: params.get("token"),
    email: params.get("email"),
    session_id: params.get("session_id"),
    return_url: params.get("return"),
    note: params.get("note"),
  };
  if (params.get("status") === "unsupported_filters" || params.get("unsupported")) {
    const unsupported = String(params.get("unsupported") || "").split(",").map((part) => part.trim()).filter(Boolean);
    const withUnsupported = {
      ...payload,
      ...(unsupported.includes("boro") ? { boro: params.get("boro") || "Brooklyn" } : {}),
      ...(unsupported.includes("when") ? { when: params.get("when") || "week" } : {}),
      ...(unsupported.length ? Object.fromEntries(unsupported.map((key) => [key, params.get(key) || true])) : {}),
    };
    if (kind === "browse_contracts") return buildBrowseContractsAiContextHandoff(withUnsupported);
    if (kind === "browse_organizations") return buildBrowseOrganizationsAiContextHandoff(withUnsupported);
    if (kind === "browse_land_projects") return buildBrowseLandProjectsAiContextHandoff(withUnsupported);
    return buildSearchAiContextHandoff({
      ...withUnsupported,
      mode: payload.mode || "federated",
    });
  }
  return buildAiContextHandoff(payload);
}

export function formatAiContextTask(handoff) {
  if (!handoff || typeof handoff !== "object") return "";
  const lines = [];
  lines.push("CityScroll public research task");
  lines.push(`MCP endpoint: ${handoff.endpoint || AI_ENDPOINT}`);
  if (handoff.support === "exact" && handoff.tools?.length) {
    lines.push(`Tools: ${handoff.tools.join(", ")}`);
    lines.push(`Arguments: ${JSON.stringify(handoff.arguments || {})}`);
  } else if (handoff.unsupported_filters?.length) {
    lines.push(`Unsupported exact filters: ${handoff.unsupported_filters.join(", ")}`);
  } else if (handoff.status === "unsupported_family") {
    lines.push(`Exact support is not published for ${handoff.family || "this page"}.`);
  } else if (handoff.status === "general_setup" && handoff.reason) {
    lines.push(`General setup reason: ${handoff.reason}`);
  }
  if (handoff.id) lines.push(`Public id: ${handoff.id}`);
  if (handoff.canonical_href) lines.push(`CityScroll route: ${handoff.canonical_href}`);
  if (handoff.task) lines.push(`Task: ${handoff.task}`);
  lines.push("Do not create a watch, send email, or connect a private account.");
  return lines.join("\n").slice(0, MAX_TASK);
}

export function renderAiContextHandoffLink(handoff, {
  label = null,
  className = "ai-context-handoff",
  translate = (value) => value,
} = {}) {
  if (!handoff) return "";
  const href = aiContextHandoffHref(handoff);
  const text = label
    || (handoff.kind === "search_scope" ? translate(AI_CONTEXT_SCOPE_ACTION_LABEL) : translate(AI_CONTEXT_RECORD_ACTION_LABEL));
  return `<a class="${esc(className)}" data-ai-context-handoff="${esc(handoff.kind || "general")}" data-ai-context-support="${esc(handoff.support || "general")}" href="${esc(href)}">${esc(text)}</a>`;
}

/**
 * One More tools disclosure. Record utilities and the assistant action share
 * this region so hydration cannot mint a second control elsewhere.
 */
export function renderMoreToolsRegion({
  body = "",
  handoff = null,
  open = false,
  label = AI_CONTEXT_MORE_TOOLS_LABEL,
  translate = (value) => value,
} = {}) {
  const action = handoff ? renderAiContextHandoffLink(handoff, { translate, className: "node-action ai-context-handoff" }) : "";
  const content = `${String(body || "").trim()}${action}`;
  if (!content) return "";
  return `<details class="more-tools" data-more-tools="1"${open ? " open" : ""}><summary>${esc(translate(label))}</summary><div class="more-tools-body node-actions civic-object-actions" data-ai-context-tools="1">${content}</div></details>`;
}

export function renderScopedAiContextAction(handoff, { translate = (value) => value } = {}) {
  if (!handoff) return "";
  return `<div class="ai-context-scope-action" data-ai-context-scope="1">${renderAiContextHandoffLink(handoff, {
    translate,
    className: "act ai-context-handoff",
    label: translate(AI_CONTEXT_SCOPE_ACTION_LABEL),
  })}</div>`;
}

export function renderAiContextTaskPanel(handoff, { translate = (value) => value } = {}) {
  if (!handoff || handoff.status === "missing_identity") return "";
  const task = formatAiContextTask(handoff);
  const supportNote = handoff.support === "exact"
    ? translate("This task keeps the exact public identity from the page you left.")
    : translate("Exact assistant support is unavailable for part of this context. General setup remains available below.");
  return `<section class="card" data-ai-context-panel="1" aria-labelledby="ai-context-task"><h2 id="ai-context-task">${esc(translate("Task from this page"))}</h2><p class="note">${esc(supportNote)}</p><label for="ai-context-task-text">${esc(translate("Copyable task"))}</label><textarea id="ai-context-task-text" class="endpoint" rows="8" readonly>${esc(task)}</textarea><button type="button" data-copy-ai-context-task>${esc(translate("Copy task"))}</button><p class="note">${esc(translate("Copying never connects an account, sends mail, or creates a watch."))}</p>${handoff.canonical_href ? `<p><a href="${esc(handoff.canonical_href)}">${esc(translate("Back to the public record"))}</a></p>` : ""}</section>`;
}

export {
  PRIVATE_KEYS as AI_CONTEXT_PRIVATE_KEYS,
  UNSUPPORTED_EXACT_FAMILIES as AI_CONTEXT_UNSUPPORTED_FAMILIES,
  stripPrivateFields as stripAiContextPrivateFields,
};

export const AI_CONTEXT_PAGE_FAMILY_CENSUS = PAGE_FAMILY_AI_CONTEXT;
