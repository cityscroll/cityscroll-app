import { boundResearchToolResult } from "../../capabilities/research_response_limits.mjs";
// POST /mcp — stateless remote MCP server (Streamable HTTP, single JSON-RPC response
// per POST; spec-valid for tools-only servers). Adapted from Dev Doshi's crol-alert.
//
// Tools give AI assistants the same capabilities the site offers people:
//   search_notices / get_notice  — the D1 notices mirror (no model call, cheap)
//   get_entity_dossier           — one bounded, attributed public entity record
//   get_entity_relationships     — one bounded, evidence-bearing public graph
//   retrieve_cited_passages      — typed source passages only (no model call, cheap)
//   get_contract / browse_contracts — canonical Contracts objects from the shared read model
//   preview_watch                — plain English → lens filter → live results (LLM, metered)
//   create_watch                 — plain English → immediate watch + welcome email (LLM, metered)
// No list/delete tools: watch management stays behind the emailed unsubscribe links,
// so knowing an address never reveals or controls its subscriptions (privacy first).
//
// Spend defenses (every paid path fails closed): optional MCP_BEARER_TOKEN; per-IP daily
// request limit; shared daily LLM ceiling (NL_METER `m:mcp:<day>`, MCP_MAX_CALLS_PER_DAY);
// per-sender signup-email limit (same 5/day as /subscribe).
//
// Machine-client profiles (capabilities/machine_client_profile.mjs) add a NAMED identity
// on top of that: a profile credential resolves to a stable profile id whose exact
// allowlist filters BOTH tools/list and tools/call, and whose quota meters by profile id
// instead of connecting address. Anonymous callers and the endpoint-wide MCP_BEARER_TOKEN
// are unchanged — they keep the full inventory and the per-address meter.

import { noticeSearchTerms, workerD1NoticeSearch } from "./lib/notices.mjs";
import {
  executeFederatedSearch,
  FEDERATED_SEARCH_INPUT_FIELDS,
  FEDERATED_SEARCH_LIMITS,
} from "../../capabilities/federated_search.mjs";
import {
  executeNoticeSearch,
  NOTICE_SEARCH_LIMITS,
} from "../../capabilities/notice_search.mjs";
import {
  executeNoticeGet,
  NOTICE_GET_LIMITS,
  NOTICE_GET_REQUEST_ID_PATTERN,
} from "../../capabilities/notice_get.mjs";
import {
  executeCitedPassages,
  CITED_PASSAGES_LIMITS,
  CITED_PASSAGES_SOURCE_FAMILIES,
} from "../../capabilities/cited_passages.mjs";
import {
  ENTITY_DOSSIER_LIMITS,
  executeEntityDossier,
} from "../../capabilities/entity_dossier.mjs";
import {
  ENTITY_RELATIONSHIPS_LIMITS,
  executeEntityRelationships,
} from "../../capabilities/entity_relationships.mjs";
import {
  CONTRACT_GET_LIMITS,
  CONTRACTS_BROWSE_LIMITS,
  executeContractGet,
  executeContractsBrowse,
} from "../../capabilities/contracts.mjs";
import { CONTRACTS_ANALYSIS_LIMITS, executeContractsAnalysis } from "../../capabilities/contracts_analysis.mjs";
import {
  executeMeetingGet,
  MEETING_GET_LIMITS,
  executeMeetingsBrowse,
  MEETINGS_BROWSE_LIMITS,
} from "../../capabilities/meetings.mjs";
import {
  executeLandProjectGet,
  executeLandProjectsBrowse,
  LAND_PROJECT_GET_LIMITS,
  LAND_PROJECTS_BROWSE_LIMITS,
} from "../../capabilities/land_projects.mjs";
import {
  executeLandDecisionPathGet,
  LAND_DECISION_PATH_GET_LIMITS,
} from "../../capabilities/land_decision_path.mjs";
import {
  executePeopleGet,
  executeOrganizationsBrowse,
  PEOPLE_GET_LIMITS,
  ORGANIZATIONS_BROWSE_LIMITS,
} from "../../capabilities/people_organizations.mjs";
import {
  declaredCapabilityGapsResult,
  MCP_DECLARED_CAPABILITY_GAPS,
  MCP_NOTICE_SEARCH_DEFAULT_LIMIT,
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOLS,
  MCP_TOOL_BINDINGS,
} from "../../capabilities/mcp_tool_declarations.mjs";
export {
  MCP_CITED_PASSAGES_ADAPTER,
  MCP_CONTRACT_GET_ADAPTER,
  MCP_CONTRACTS_BROWSE_ADAPTER,
  MCP_ORGANIZATIONS_BROWSE_ADAPTER,
  MCP_PEOPLE_GET_ADAPTER,
  MCP_MEETING_GET_ADAPTER,
  MCP_ENTITY_DOSSIER_ADAPTER,
  MCP_ENTITY_RELATIONSHIPS_ADAPTER,
  MCP_FEDERATED_SEARCH_ADAPTER,
  MCP_NOTICE_SEARCH_ADAPTER,
  MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS,
  MCP_MEETINGS_BROWSE_ADAPTER,
  MCP_PUBLIC_READ_ANNOTATIONS,
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOL_BINDINGS,
  MCP_TOOLS,
} from "../../capabilities/mcp_tool_declarations.mjs";
import { parseLensFilter } from "./nl.mjs";
import { prepareWatchFilter } from "./lib/filter.mjs";
import { compileSub, getProcurementDigestSnapshot, rowsForCompiledQuery } from "./lib/compile.mjs";
import { evaluateAdmittedTextQueryWatch } from "./lib/evaluate_watch_text_query.mjs";
import { textQueryEvaluationSupported } from "../../site/watch_text_query.mjs";
import { describeFilter } from "./lib/confirm_email.mjs";
import { isValidEmail, buildSubscription } from "./lib/subscriptions.mjs";
import { enrollAndWelcome } from "./subscribe.mjs";
import { overSurfaceCap, overActorLimit } from "./lib/meter.mjs";
import {
  filterToolsForProfile,
  machineClientMeterIdentity,
  machineClientTelemetry,
  profileAllowsTool,
  resolveMachineClientProfile,
} from "../../capabilities/machine_client_profile.mjs";
import {
  fingerprintToolCatalog,
  mcpUsageObservation,
  outcomeFromToolResult,
  toolCallObservationFromTelemetry,
} from "../../capabilities/mcp_usage_observation.mjs";
import {
  deploymentIdentityFromEnv,
  resolveMcpObservationClass,
  scheduleMcpUsageObservation,
} from "./lib/mcp_usage.mjs";
import { workerCitedPassages, formatCitedPassagesText } from "./cited_retrieval.mjs";
import { workerD1EntityDossier } from "./entity_dossier.mjs";
import { workerD1EntityRelationships } from "./public_relationship_graph.mjs";
import { workerNoticeGet } from "./notice.mjs";
import { workerFederatedSearch } from "./search.mjs";
import { formatContractsAnalysisText, formatContractsBrowseText, formatContractText, mcpContractGetInput, mcpContractsAnalysisInput, mcpContractsBrowseInput, workerProcurementContracts } from "./contracts.mjs";
import { formatLandDecisionPathText, formatLandProjectText, formatLandProjectsBrowseText, mcpLandDecisionPathGetInput, mcpLandProjectGetInput, mcpLandProjectsBrowseInput, workerLandDecisionPathGet, workerLandProjectGet, workerLandProjectsBrowse } from "./land_projects.mjs";
import { formatPeopleGetText, formatOrganizationsBrowseText, mcpPeopleGetInput, mcpOrganizationsBrowseInput, workerPeopleOrganizations } from "./people_organizations.mjs";
import { workerMeetingGet, workerMeetingsBrowse } from "./hearings.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const FEDERATED_SEARCH_MCP_INPUT_FIELDS = new Set(FEDERATED_SEARCH_INPUT_FIELDS);
const SUBSCRIBABLE = new Set(["money", "people", "land", "property", "rules", "meetings"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function text(t) {
  return { content: [{ type: "text", text: t }] };
}
function toolError(t) {
  return { ...text(t), isError: true };
}

function fmtRecord(r, i) {
  const meta = [r.section, r.notice_type, r.category, r.contract_amount_display, r.vendor].filter(Boolean).join(" · ");
  const lines = [`${i + 1}. ${r.date || "—"} · ${r.agency || "—"} · ${r.title || `Notice ${r.request_id}`}`];
  if (meta) lines.push(`   ${meta}`);
  if (r.due_date) lines.push(`   bid due ${r.due_date}`);
  else if (r.deadline_note) lines.push(`   ${r.deadline_note}`);
  if (r.snippet) lines.push(`   ${r.snippet}`);
  lines.push(`   RequestID ${r.request_id} · https://cityscroll.org/notices/${encodeURIComponent(r.request_id)}`);
  return lines.join("\n");
}

export function mcpNoticeSearchInput(args = {}) {
  const terms = noticeSearchTerms(args.query);
  const requestedLimit = typeof args.limit === "number" ? args.limit : MCP_NOTICE_SEARCH_DEFAULT_LIMIT;
  return {
    termGroups: terms.length ? [terms] : [],
    section: args.section || null,
    agency: args.agency || null,
    minAmount: typeof args.min_amount === "number" ? args.min_amount : null,
    maxAmount: typeof args.max_amount === "number" ? args.max_amount : null,
    openOnly: !!args.open_only,
    excludeRollingDeadlines: !!args.exclude_rolling,
    limit: Math.max(NOTICE_SEARCH_LIMITS.minimum, Math.min(requestedLimit, NOTICE_SEARCH_LIMITS.maximum)),
  };
}

export function mcpFederatedSearchInput(args = {}) {
  for (const field of Object.keys(args || {})) {
    if (!FEDERATED_SEARCH_MCP_INPUT_FIELDS.has(field)) {
      throw new TypeError(`search_federated does not accept arbitrary field: ${field}`);
    }
  }
  const query = String(args.query || "").trim();
  const limit = args.limit == null ? FEDERATED_SEARCH_LIMITS.defaultResults : Number(args.limit);
  return {
    query,
    limit,
    ...(Object.hasOwn(args || {}, "scope") ? { scope: args.scope } : {}),
  };
}

export function mcpNoticeGetInput(args = {}) {
  return { requestId: String(args.request_id || "").trim() };
}

export function formatMcpNoticeSearchResult(result) {
  if (!result.results.length) {
    return "No matches in the mirror (it holds recent notices; the site searches the full record).";
  }
  return result.results.map(fmtRecord).join("\n\n");
}

export function mcpCitedPassagesInput(args = {}) {
  const query = String(args.query || "").trim();
  const sourceFamily = String(args.source_family || "").trim() || null;
  const bodyId = String(args.body_id || "").trim() || null;
  const publishedFrom = String(args.published_from || "").trim() || null;
  const publishedTo = String(args.published_to || "").trim() || null;
  const limit = args.limit == null ? CITED_PASSAGES_LIMITS.defaultResults : Number(args.limit);
  return {
    query,
    filters: {
      source_family: sourceFamily,
      body_id: bodyId,
      published_from: publishedFrom,
      published_to: publishedTo,
    },
    limit,
  };
}

export function mcpEntityDossierInput(args = {}) {
  return { entityId: String(args.entity_id || "").trim() };
}

export function mcpEntityRelationshipsInput(args = {}) {
  return {
    entityId: String(args.entity_id || "").trim(),
    depth: args.depth == null ? ENTITY_RELATIONSHIPS_LIMITS.defaultDepth : Number(args.depth),
    fanOut: args.fan_out == null ? ENTITY_RELATIONSHIPS_LIMITS.defaultFanOut : Number(args.fan_out),
    nodeTypes: args.node_types,
    edgeTypes: args.edge_types,
  };
}

export function mcpMeetingGetInput(args = {}) {
  return { meetingId: String(args.meeting_id || "").trim() };
}

export function mcpMeetingsBrowseInput(args = {}) {
  const allowed = new Set([
    "from", "to", "date_from", "date_to", "availability", "attendance_modes", "attendance", "activity", "speaking_rights", "observer_access",
    "source_contract_id", "source_system", "institution", "body", "agency", "community_board", "geography", "place_scope", "query", "text_query", "status", "limit", "cursor",
    "identifier_path", "identifier_offset", "identifier_limit",
  ]);
  for (const field of Object.keys(args || {})) if (!allowed.has(field)) throw new TypeError(`browse_meetings does not accept field: ${field}`);
  const input = {};
  const copy = [
    ["from", "from"], ["date_from", "dateFrom"], ["to", "to"], ["date_to", "dateTo"], ["availability", "availability"],
    ["attendance_modes", "attendanceModes"], ["attendance", "attendance"], ["activity", "activity"],
    ["speaking_rights", "speakingRights"], ["observer_access", "observerAccess"],
    ["source_contract_id", "sourceContractId"], ["source_system", "sourceSystem"], ["institution", "institution"], ["body", "body"],
    ["agency", "agency"], ["community_board", "communityBoard"], ["geography", "geography"], ["place_scope", "placeScope"],
    ["query", "query"], ["text_query", "textQuery"], ["status", "status"], ["limit", "limit"], ["cursor", "cursor"],
  ];
  for (const [wire, field] of copy) if (Object.hasOwn(args, wire)) input[field] = args[wire];
  return input;
}

function formatMeetingText(result) {
  if (result.availability !== "available") return `Meeting is ${result.availability.replaceAll("_", " ")} (${result.error}).`;
  const meeting = result.meeting;
  return `Returned ${meeting.title || meeting.meeting_id}. Use the structured result for source receipt, coverage, freshness, and attached documents.`;
}

function formatMeetingsBrowseText(result) {
  if (result.availability === "unavailable") return "Meeting browse is unavailable right now.";
  if (!result.results.length) return "No meetings match the bounded filters in the shared read model.";
  const rows = result.results.map((row, index) => `${index + 1}. ${row.event_date || "date not published"} · ${row.title || row.meeting_id}`);
  const unknown = result.coverage?.unknown_start_exclusions || 0;
  return `Returned ${result.results.length} of ${result.total_matches} matching meetings. Use structuredContent for source coverage, freshness, filters, and pagination.${unknown ? ` ${unknown} candidate meeting${unknown === 1 ? " has" : "s have"} an unknown start and was excluded.` : ""}\n\n${rows.join("\n")}`;
}

function structuredResult(result, summary) {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: result,
  };
}

async function fetchSodaRows(url, params) {
  const r = await fetch(`${url}?${new URLSearchParams(params).toString()}`);
  if (!r.ok) throw new Error(`open-data ${r.status}`);
  return r.json();
}

async function runPreview(env, lens, request, { filter: explicitFilter } = {}) {
  const todayISO = new Date().toISOString().slice(0, 10);
  let filter;
  if (explicitFilter && typeof explicitFilter === "object" && !Array.isArray(explicitFilter)) {
    const prepared = prepareWatchFilter(lens, explicitFilter);
    if (!prepared.ok) {
      return {
        error: `That watch cannot be used as written (${prepared.reason}). Edit the matching controls and try again.`,
        reason: prepared.reason,
        correction: "Use the explicit any/all/phrase and exclude controls. Unsupported rich input is not saved as a broader watch.",
      };
    }
    lens = prepared.lens;
    filter = prepared.filter;
  } else {
    const mcpCap = Number(env.MCP_MAX_CALLS_PER_DAY) || 200;
    if (await overSurfaceCap(env.NL_METER, "mcp", mcpCap)) {
      return { error: "Daily capacity for plain-English parsing is exhausted — try tomorrow, or use search_notices with structured filters (not metered)." };
    }
    const parsed = await parseLensFilter(env, lens, request);
    if (parsed.degraded) {
      const correction = parsed.correction
        ? ` ${parsed.correction}`
        : " Try plainer wording.";
      return { error: `Couldn't parse that request (${parsed.reason}).${correction}` };
    }
    filter = parsed.filter;
  }
  const sub = { lens, filter };
  if (filter?.text_query && textQueryEvaluationSupported(lens)) {
    const evaluation = await evaluateAdmittedTextQueryWatch({
      db: env.DB || null,
      snapshot: getProcurementDigestSnapshot(),
      env,
      sub,
      todayISO,
      clock: todayISO,
      fetchImpl: null,
    });
    return {
      filter,
      label: describeFilter(lens, filter),
      kind: lens === "meetings" ? "meetings" : "award",
      rows: (evaluation.rows || []).slice(0, 10),
    };
  }
  const q = compileSub(sub, todayISO);
  if (!q) return { error: `The '${lens}' lens can't be replayed as a standing watch yet.` };
  let rows;
  if (q.url) {
    rows = await fetchSodaRows(q.url, q.params);
  } else {
    rows = await rowsForCompiledQuery(q, env);
  }
  if (q.postFilter) rows = rows.filter(q.postFilter);
  return { filter, label: describeFilter(lens, filter), kind: q.kind, rows: rows.slice(0, 10) };
}

function previewText(p) {
  const head = `Understood as: ${p.label}`;
  if (!p.rows.length) return `${head}\n\nNo current matches — a watch would alert when new matching notices post.`;
  const items = p.rows.map((r, i) => {
    const bits = [r.start_date ? String(r.start_date).slice(0, 10) : "—", r.agency_name, r.short_title, r.contract_amount ? "$" + Number(r.contract_amount).toLocaleString("en-US") : "", r.due_date ? "due " + String(r.due_date).slice(0, 10) : ""].filter(Boolean);
    return `${i + 1}. ${bits.join(" · ")}`;
  });
  return `${head}\n\nRecent matches (${p.rows.length} shown):\n` + items.join("\n");
}

async function callTool(env, req, name, args, { federatedProvider = null } = {}) {
  switch (name) {
    case "search_federated": {
      const input = mcpFederatedSearchInput(args);
      if (!input.query) return toolError("query is required.");
      if (input.query.length > FEDERATED_SEARCH_LIMITS.queryMaximumLength) {
        return toolError("query must be 240 characters or fewer.");
      }
      if (!Number.isInteger(input.limit)
          || input.limit < 1
          || input.limit > FEDERATED_SEARCH_LIMITS.maximumResults) {
        return toolError("limit must be a whole number from 1 through 100.");
      }
      const result = await executeFederatedSearch(
        federatedProvider || workerFederatedSearch(env),
        input,
      );
      return structuredResult(
        result,
        `Returned ${result.results.length} federated public search result${result.results.length === 1 ? "" : "s"}. Use the structured result for per-lens coverage, source observations, and exact object routes.`,
      );
    }
    case "search_notices": {
      if (!env.DB) return toolError("The notices mirror is unavailable right now.");
      const res = await executeNoticeSearch(
        workerD1NoticeSearch(env.DB),
        mcpNoticeSearchInput(args),
      );
      // Bounded operational telemetry only: no query text, IP, or notice identifiers.
      console.log("notice-search:", JSON.stringify({ route: "mcp.search_notices", ...res.retrieval }));
      return structuredResult(res, formatMcpNoticeSearchResult(res));
    }
    case "get_notice": {
      const input = mcpNoticeGetInput(args);
      if (!input.requestId) return toolError("request_id is required.");
      if (!NOTICE_GET_REQUEST_ID_PATTERN.test(input.requestId)) {
        return toolError("request_id must be a non-empty City Record identifier.");
      }
      const result = await executeNoticeGet(workerNoticeGet(env), input);
      const summary = result.availability === "available"
        ? `Returned the public notice ${result.notice.request_id}. Use the structured result for source and freshness details.`
        : `Notice is ${result.availability.replaceAll("_", " ")} (${result.error}).`;
      return structuredResult(result, summary);
    }
    case "get_entity_dossier": {
      const input = mcpEntityDossierInput(args);
      if (!input.entityId) return toolError("entity_id is required.");
      if (input.entityId.length > ENTITY_DOSSIER_LIMITS.entityIdMaximumLength) {
        return toolError(`entity_id must be ${ENTITY_DOSSIER_LIMITS.entityIdMaximumLength} characters or fewer.`);
      }
      const result = await executeEntityDossier(workerD1EntityDossier(env.DB), input);
      const summary = result.availability === "available"
        ? `Returned the public dossier for ${result.dossier.entity.name}. Use the structured result for attributed facts and provenance.`
        : `Entity dossier is ${result.availability.replaceAll("_", " ")} (${result.error}).`;
      return structuredResult(result, summary);
    }
    case "get_entity_relationships": {
      const input = mcpEntityRelationshipsInput(args);
      if (!input.entityId) return toolError("entity_id is required.");
      const result = await executeEntityRelationships(workerD1EntityRelationships(env.DB), input);
      const summary = result.availability === "available"
        ? `Returned ${result.graph.edges.length} bounded public relationship${result.graph.edges.length === 1 ? "" : "s"}. Use the structured result for evidence and provenance.`
        : `Entity relationships are ${result.availability.replaceAll("_", " ")} (${result.error}).`;
      return structuredResult(result, summary);
    }
    case "get_contract": {
      const input = mcpContractGetInput(args);
      if (!input.procurementId) return toolError("procurement_id is required.");
      if (input.procurementId.length > CONTRACT_GET_LIMITS.procurementIdMaximumLength) {
        return toolError(`procurement_id must be ${CONTRACT_GET_LIMITS.procurementIdMaximumLength} characters or fewer.`);
      }
      const result = await executeContractGet(workerProcurementContracts(env).get, input);
      return structuredResult(result, formatContractText(result));
    }
    case "browse_contracts": {
      const input = mcpContractsBrowseInput(args);
      if (input.limit != null && (input.limit < CONTRACTS_BROWSE_LIMITS.minimum || input.limit > CONTRACTS_BROWSE_LIMITS.maximum)) {
        return toolError(`limit must be a whole number from ${CONTRACTS_BROWSE_LIMITS.minimum} through ${CONTRACTS_BROWSE_LIMITS.maximum}.`);
      }
      const result = await executeContractsBrowse(workerProcurementContracts(env).browse, input);
      return structuredResult(result, formatContractsBrowseText(result));
    }
    case "analyze_contracts": {
      const input = mcpContractsAnalysisInput(args);
      if (input.limit != null && (input.limit < CONTRACTS_ANALYSIS_LIMITS.minimumGroups || input.limit > CONTRACTS_ANALYSIS_LIMITS.maximumGroups)) {
        return toolError(`limit must be a whole number from ${CONTRACTS_ANALYSIS_LIMITS.minimumGroups} through ${CONTRACTS_ANALYSIS_LIMITS.maximumGroups}.`);
      }
      const result = await executeContractsAnalysis(workerProcurementContracts(env).analysis, input);
      return structuredResult(result, formatContractsAnalysisText(result));
    }
    case "get_person_or_organization": {
      const input = mcpPeopleGetInput(args);
      if (!input.entityId) return toolError("entity_id is required.");
      if (input.entityId.length > PEOPLE_GET_LIMITS.entityIdMaximumLength) return toolError(`entity_id must be ${PEOPLE_GET_LIMITS.entityIdMaximumLength} characters or fewer.`);
      const result = await executePeopleGet(workerPeopleOrganizations(env).get, input);
      return structuredResult(result, formatPeopleGetText(result));
    }
    case "browse_organizations": {
      const input = mcpOrganizationsBrowseInput(args);
      if (input.limit != null && (input.limit < ORGANIZATIONS_BROWSE_LIMITS.minimum || input.limit > ORGANIZATIONS_BROWSE_LIMITS.maximum)) return toolError(`limit must be a whole number from ${ORGANIZATIONS_BROWSE_LIMITS.minimum} through ${ORGANIZATIONS_BROWSE_LIMITS.maximum}.`);
      const result = await executeOrganizationsBrowse(workerPeopleOrganizations(env).browse, input);
      return structuredResult(result, formatOrganizationsBrowseText(result));
    }
    case "get_meeting": {
      const input = mcpMeetingGetInput(args);
      if (!input.meetingId) return toolError("meeting_id is required.");
      if (input.meetingId.length > MEETING_GET_LIMITS.meetingIdMaximumLength) return toolError(`meeting_id must be ${MEETING_GET_LIMITS.meetingIdMaximumLength} characters or fewer.`);
      const result = await executeMeetingGet(workerMeetingGet(env), input);
      return structuredResult(result, formatMeetingText(result));
    }
    case "browse_meetings": {
      try {
        const input = mcpMeetingsBrowseInput(args);
        if (input.limit != null && (input.limit < MEETINGS_BROWSE_LIMITS.minimum || input.limit > MEETINGS_BROWSE_LIMITS.maximum)) {
          return toolError(`limit must be a whole number from ${MEETINGS_BROWSE_LIMITS.minimum} through ${MEETINGS_BROWSE_LIMITS.maximum}.`);
        }
        const result = await executeMeetingsBrowse(workerMeetingsBrowse(env), input);
        return structuredResult(result, formatMeetingsBrowseText(result));
      } catch (error) {
        return toolError(error?.message || "Meeting browse request is invalid.");
      }
    }
    case "get_land_project": {
      const input = mcpLandProjectGetInput(args);
      if (!input.projectId) return toolError("project_id is required.");
      if (input.projectId.length > LAND_PROJECT_GET_LIMITS.projectIdMaximumLength) {
        return toolError(`project_id must be ${LAND_PROJECT_GET_LIMITS.projectIdMaximumLength} characters or fewer.`);
      }
      const result = await executeLandProjectGet(workerLandProjectGet(env), input);
      return structuredResult(result, formatLandProjectText(result));
    }
    case "browse_land_projects": {
      const input = mcpLandProjectsBrowseInput(args);
      if (input.limit != null && (input.limit < LAND_PROJECTS_BROWSE_LIMITS.minimum || input.limit > LAND_PROJECTS_BROWSE_LIMITS.maximum)) {
        return toolError(`limit must be a whole number from ${LAND_PROJECTS_BROWSE_LIMITS.minimum} through ${LAND_PROJECTS_BROWSE_LIMITS.maximum}.`);
      }
      const result = await executeLandProjectsBrowse(workerLandProjectsBrowse(env), input);
      return structuredResult(result, formatLandProjectsBrowseText(result));
    }
    case "get_land_decision_path": {
      const input = mcpLandDecisionPathGetInput(args);
      if (!input.projectId) return toolError("project_id is required.");
      if (input.projectId.length > LAND_DECISION_PATH_GET_LIMITS.projectIdMaximumLength) {
        return toolError(`project_id must be ${LAND_DECISION_PATH_GET_LIMITS.projectIdMaximumLength} characters or fewer.`);
      }
      const result = await executeLandDecisionPathGet(workerLandDecisionPathGet(env), input);
      return structuredResult(result, formatLandDecisionPathText(result));
    }
    case "retrieve_cited_passages": {
      if (env.SEMANTIC_CANDIDATES_ENABLED === "false") {
        return toolError("Cited passage retrieval is unavailable right now.");
      }
      const query = String(args.query || "").trim();
      if (!query) return toolError("query is required.");
      if (query.length > CITED_PASSAGES_LIMITS.queryMaximumLength) return toolError("query must be 240 characters or fewer.");
      const sourceFamily = String(args.source_family || "").trim() || null;
      if (sourceFamily && !CITED_PASSAGES_SOURCE_FAMILIES.includes(sourceFamily)) {
        return toolError("source_family is not part of the cited retrieval corpus.");
      }
      const bodyId = String(args.body_id || "").trim() || null;
      if (bodyId && bodyId.length > CITED_PASSAGES_LIMITS.bodyIdMaximumLength) return toolError("body_id must be 120 characters or fewer.");
      const publishedFrom = String(args.published_from || "").trim() || null;
      const publishedTo = String(args.published_to || "").trim() || null;
      if (publishedFrom && !validIsoDate(publishedFrom)) return toolError("published_from must be a date.");
      if (publishedTo && !validIsoDate(publishedTo)) return toolError("published_to must be a date.");
      if (publishedFrom && publishedTo && publishedFrom > publishedTo) {
        return toolError("published_from must not be after published_to.");
      }
      const rawLimit = args.limit == null ? 10 : Number(args.limit);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > CITED_PASSAGES_LIMITS.maximumResults) {
        return toolError("limit must be a whole number from 1 through 20.");
      }
      const result = await executeCitedPassages(
        workerCitedPassages(),
        mcpCitedPassagesInput(args),
      );
      return {
        content: [{
          type: "text",
          text: formatCitedPassagesText(result),
        }],
        structuredContent: result,
      };
    }
    case "preview_watch": {
      const lens = String(args.lens || "");
      if (!SUBSCRIBABLE.has(lens)) return toolError("lens must be one of: " + [...SUBSCRIBABLE].join(", "));
      const explicit = args.filter && typeof args.filter === "object" && !Array.isArray(args.filter)
        ? args.filter
        : null;
      const request = String(args.request || "");
      if (!explicit && !request) return toolError("request or filter is required.");
      const p = await runPreview(env, lens, request, { filter: explicit });
      if (p.error) return toolError(p.error);
      return text(previewText(p));
    }
    case "create_watch": {
      if (!env.TOKEN_SECRET || !env.RESEND_API_KEY || !env.SUBS) return toolError("Watch creation isn't configured on this deployment.");
      const email = String(args.email || "").trim();
      const lens = String(args.lens || "");
      if (!isValidEmail(email)) return toolError("A valid email address is required.");
      if (!SUBSCRIBABLE.has(lens)) return toolError("lens must be one of: " + [...SUBSCRIBABLE].join(", "));
      // Same per-address ceiling as the web form — welcome emails cost sends.
      if (await overActorLimit(env.SUBS, "mcpsub", email, 5)) return toolError("Daily limit reached for that address — try tomorrow.");
      const explicit = args.filter && typeof args.filter === "object" && !Array.isArray(args.filter)
        ? args.filter
        : null;
      const request = String(args.request || "");
      if (!explicit && !request) return toolError("request or filter is required.");
      const p = await runPreview(env, lens, request, { filter: explicit });
      if (p.error) return toolError(p.error);
      const sub = buildSubscription({ email, lens, filter: p.filter, freq: args.freq === "weekly" ? "weekly" : "daily" });
      try {
        await enrollAndWelcome(env, sub, { source: "mcp" });
      } catch {
        return toolError("The watch could not be created — try again later.");
      }
      return text(`Understood as: ${p.label} (${sub.freq}).\nThe watch is active and a welcome email with manage and unsubscribe links was sent to ${sub.email}.\n\n${previewText(p)}`);
    }
    case "list_capability_gaps": {
      const result = declaredCapabilityGapsResult();
      const named = MCP_DECLARED_CAPABILITY_GAPS.map(({ gap }) => gap).join(", ");
      return structuredResult(
        result,
        `This endpoint declares ${result.gaps.length} capability gap${result.gaps.length === 1 ? "" : "s"}: ${named}. Each entry names the nearest tools that do publish something for the question.`,
      );
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

const TOOL_CAPABILITY_REFERENCES = new Map(
  MCP_TOOL_BINDINGS.map((binding) => [binding.name, binding.capabilityReference || null]),
);

/**
 * Derives the content-free telemetry facts of one tool call from its result envelope.
 * Reads only structural fields — availability and result counts — and never the text,
 * arguments, or structured payload itself.
 */
function toolCallTelemetryFacts(result) {
  if (result?.isError) return { availability: null, count: 0, errorClass: "invalid_input" };
  const structured = result?.structuredContent;
  const availability = typeof structured?.availability === "string" ? structured.availability : null;
  let count = 0;
  for (const key of ["records", "results", "passages", "relationships", "projects", "contracts", "organizations"]) {
    if (Array.isArray(structured?.[key])) { count = structured[key].length; break; }
  }
  return { availability, count, errorClass: "none" };
}

/**
 * Emits one profile telemetry record when the deployment provides a sink. The record's
 * key set is closed by machineClientTelemetry(); this function adds nothing to it, so a
 * credential, prompt or response body cannot reach the sink through this path.
 */
function emitMachineClientTelemetry(env, record) {
  const sink = env?.MACHINE_CLIENT_TELEMETRY;
  if (typeof sink?.write !== "function") return false;
  try {
    sink.write(record);
    return true;
  } catch {
    // Measurement must never break the call being measured.
    return false;
  }
}

/**
 * Record one MCP usage observation. Failures are swallowed: measurement never changes
 * the MCP result and never leaves a floating rejected promise on the request path.
 */
function recordMcpObservation(env, partial) {
  try {
    return scheduleMcpUsageObservation(env, mcpUsageObservation(partial));
  } catch {
    return { ok: false, status: "write_failed", reason: "record_threw" };
  }
}

function rpc(id, result, error) {
  return error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result };
}

export async function handleMcp(req, env, { federatedProvider = null } = {}) {
  const startedAt = Date.now();
  const observationClass = await resolveMcpObservationClass(req, env);
  const deploymentIdentity = deploymentIdentityFromEnv(env);
  const baseObservation = {
    observation_class: observationClass,
    deployment_identity: deploymentIdentity,
  };

  // Resolve the machine-client identity before any work. The 401 body stays a bare
  // string with no detail about which credential failed or which profiles exist.
  const { resolution, profile } = await resolveMachineClientProfile(env, req.headers.get("authorization"));
  if (resolution === "unauthorized") {
    recordMcpObservation(env, {
      ...baseObservation,
      method: "unauthorized",
      outcome: "unauthorized",
      error_class: "unauthorized",
      duration_ms: Date.now() - startedAt,
    });
    return new Response("Unauthorized", { status: 401 });
  }
  if (req.method !== "POST") {
    recordMcpObservation(env, {
      ...baseObservation,
      method: "method_not_allowed",
      outcome: "method_not_allowed",
      profile_id: profile?.id ?? null,
      duration_ms: Date.now() - startedAt,
    });
    return new Response(
      "CityScroll MCP is a tools-only endpoint. Connect an MCP client to POST https://api.cityscroll.org/mcp; a browser GET cannot run tools.",
      { status: 405, headers: { "content-type": "text/plain; charset=utf-8", allow: "POST" } },
    );
  }

  // Cheap daily ceiling before any work (public endpoint, no Turnstile here). An
  // authenticated profile meters on its own stable id, so one gateway's users are no
  // longer each other's noisy neighbours; anonymous callers keep the per-address meter.
  const ip = req.headers.get("CF-Connecting-IP") || "";
  const { meter, actor, limit } = machineClientMeterIdentity(profile, ip);
  const cap = limit ?? (Number(env.MCP_MAX_PER_IP_DAY) || 300);
  if (await overActorLimit(env.SUBS, meter, actor, cap)) {
    recordMcpObservation(env, {
      ...baseObservation,
      method: "quota_refusal",
      outcome: "quota_exhausted",
      error_class: "quota_exhausted",
      profile_id: profile?.id ?? null,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json(rpc(null, undefined, { code: -32000, message: "Daily request limit reached." }), { status: 429 });
  }

  let msg;
  try {
    msg = await req.json();
  } catch {
    recordMcpObservation(env, {
      ...baseObservation,
      method: "parse_error",
      outcome: "malformed_json",
      error_class: "invalid_input",
      profile_id: profile?.id ?? null,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json(rpc(null, undefined, { code: -32700, message: "Parse error" }), { status: 400 });
  }
  const { id, method, params } = msg || {};

  // Notifications (no id) — acknowledge, no body.
  if (id === undefined || id === null) {
    recordMcpObservation(env, {
      ...baseObservation,
      method: "notification",
      outcome: "notification_ack",
      profile_id: profile?.id ?? null,
      duration_ms: Date.now() - startedAt,
    });
    return new Response(null, { status: 202 });
  }

  let activeTool = null;
  try {
    switch (method) {
      case "initialize": {
        const clientInfo = params && typeof params === "object" ? params.clientInfo : null;
        recordMcpObservation(env, {
          ...baseObservation,
          method: "initialize",
          outcome: "success",
          profile_id: profile?.id ?? null,
          client_family: clientInfo?.name,
          client_version: clientInfo?.version,
          protocol_version: params?.protocolVersion || PROTOCOL_VERSION,
          duration_ms: Date.now() - startedAt,
        });
        return Response.json(rpc(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "CityScroll", version: "1.0.0" },
          // Public product truth, sent to every caller including anonymous ones: what
          // the endpoint answers from, and the gaps it declares about itself.
          instructions: MCP_SERVER_INSTRUCTIONS,
        }));
      }
      case "ping":
        recordMcpObservation(env, {
          ...baseObservation,
          method: "ping",
          outcome: "success",
          profile_id: profile?.id ?? null,
          duration_ms: Date.now() - startedAt,
        });
        return Response.json(rpc(id, {}));
      case "tools/list": {
        // Discovery is authority: a profile must not SEE a tool it may not call.
        const tools = filterToolsForProfile(MCP_TOOLS, profile);
        let catalogFingerprint = "unknown";
        try {
          catalogFingerprint = await fingerprintToolCatalog(tools);
        } catch {
          catalogFingerprint = "unknown";
        }
        recordMcpObservation(env, {
          ...baseObservation,
          method: "tools/list",
          outcome: "success",
          profile_id: profile?.id ?? null,
          catalog_fingerprint: catalogFingerprint,
          catalog_tool_count: tools.length,
          duration_ms: Date.now() - startedAt,
        });
        return Response.json(rpc(id, { tools }));
      }
      case "tools/call": {
        const name = String(params?.name || "");
        activeTool = name;
        const args = (params?.arguments) || {};
        const capabilityReference = TOOL_CAPABILITY_REFERENCES.get(name) || null;
        // Enforced independently of the listing — knowing a tool's name is not a grant.
        // The refusal is deliberately indistinguishable from an unknown tool: a distinct
        // "not granted" message would be a discovery oracle for the withheld inventory,
        // which is exactly the authority leak the filtered listing exists to close.
        if (!profileAllowsTool(profile, name)) {
          // Registered-but-ungranted tools stay not_granted; never-registered names are
          // unknown_tool. The caller-facing body stays identical either way.
          const errorClass = TOOL_CAPABILITY_REFERENCES.has(name) || MCP_TOOL_BINDINGS.some((b) => b.name === name)
            ? "not_granted"
            : "unknown_tool";
          const telemetry = machineClientTelemetry({
            profileId: profile?.id ?? null,
            capabilityReference,
            errorClass: errorClass === "unknown_tool" ? "unknown_tool" : "not_granted",
          });
          emitMachineClientTelemetry(env, telemetry);
          recordMcpObservation(env, {
            ...baseObservation,
            method: "tools/call",
            tool: name,
            outcome: errorClass === "unknown_tool" ? "unknown_tool" : "not_granted",
            error_class: errorClass === "unknown_tool" ? "unknown_tool" : "not_granted",
            profile_id: profile?.id ?? null,
            capability_reference: capabilityReference,
            duration_ms: Date.now() - startedAt,
          });
          return Response.json(rpc(id, toolError(`Unknown tool: ${name}`)));
        }
        const toolStartedAt = Date.now();
        const rawResult = await callTool(env, req, name, args, { federatedProvider });
        const result = MCP_TOOL_BINDINGS.some((binding) => binding.name === name && (binding.authorityClass === "public_read" || binding.name === "list_capability_gaps"))
          ? boundResearchToolResult(rawResult, { tool: name, arguments: args }) : rawResult;
        const facts = toolCallTelemetryFacts(result);
        const durationMs = Date.now() - toolStartedAt;
        const telemetry = machineClientTelemetry({
          profileId: profile?.id ?? null,
          capabilityReference,
          availability: facts.availability,
          durationMs,
          count: facts.count,
          errorClass: facts.errorClass,
        });
        emitMachineClientTelemetry(env, telemetry);
        const outcome = outcomeFromToolResult(result);
        scheduleMcpUsageObservation(env, toolCallObservationFromTelemetry(telemetry, {
          tool: name,
          observation_class: observationClass,
          deployment_identity: deploymentIdentity,
          emptySuccess: outcome === "empty_success",
        }));
        return Response.json(rpc(id, result));
      }
      default:
        recordMcpObservation(env, {
          ...baseObservation,
          method: "unsupported_method",
          outcome: "unsupported_method",
          profile_id: profile?.id ?? null,
          duration_ms: Date.now() - startedAt,
        });
        return Response.json(rpc(id, undefined, { code: -32601, message: `Method not found: ${method}` }));
    }
  } catch (e) {
    // Exception text never enters the observation — only the closed thrown_error class.
    const thrownMethod = activeTool != null
      ? "tools/call"
      : (method === "initialize" || method === "ping" || method === "tools/list" || method === "tools/call"
        ? method
        : "unsupported_method");
    recordMcpObservation(env, {
      ...baseObservation,
      method: thrownMethod,
      tool: activeTool || undefined,
      outcome: "thrown_error",
      error_class: "internal",
      profile_id: profile?.id ?? null,
      duration_ms: Date.now() - startedAt,
    });
    return Response.json(rpc(id, undefined, { code: -32603, message: String(e?.message || e) }));
  }
}
