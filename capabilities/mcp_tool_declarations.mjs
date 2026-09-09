import { RESEARCH_IDENTIFIER_SAMPLE_DEFAULT, RESEARCH_IDENTIFIER_SAMPLE_MAXIMUM } from "./research_response_limits.mjs";
// Runtime-safe MCP declarations shared by the Worker adapter and build-time catalog.
// Keep this module free of request handling and optional Worker-only dependencies so
// topology tests can inspect the public tool contract in the site Unit family.

import {
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LENS_IDS,
  FEDERATED_SEARCH_LIMITS,
  FEDERATED_SEARCH_OUTPUT_SCHEMA,
  FEDERATED_SEARCH_PROVIDER_ID,
  FEDERATED_SEARCH_SCOPE_SCHEMA,
} from "./federated_search.mjs";
import {
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
  NOTICE_SEARCH_LIMITS,
  NOTICE_SEARCH_PROVIDER_ID,
} from "./notice_search.mjs";
import {
  NOTICE_GET_CAPABILITY_REFERENCE,
  NOTICE_GET_LIMITS,
  NOTICE_GET_PROVIDER_ID,
  NOTICE_GET_REPRESENTATIONS,
} from "./notice_get.mjs";
import {
  ENTITY_DOSSIER_CAPABILITY_REFERENCE,
  ENTITY_DOSSIER_LIMITS,
  ENTITY_DOSSIER_PROVIDER_ID,
} from "./entity_dossier.mjs";
import {
  ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
  ENTITY_RELATIONSHIPS_EDGE_TYPES,
  ENTITY_RELATIONSHIPS_LIMITS,
  ENTITY_RELATIONSHIPS_NODE_TYPES,
  ENTITY_RELATIONSHIPS_PROVIDER_ID,
} from "./entity_relationships.mjs";
import {
  CITED_PASSAGES_CAPABILITY_REFERENCE,
  CITED_PASSAGES_LIMITS,
  CITED_PASSAGES_PROVIDER_ID,
  CITED_PASSAGES_REPRESENTATIONS,
} from "./cited_passages.mjs";
import {
  CONTRACT_GET_CAPABILITY_REFERENCE,
  CONTRACT_GET_LIMITS,
  CONTRACT_GET_PROVIDER_ID,
  CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
  CONTRACTS_BROWSE_LIMITS,
  CONTRACTS_BROWSE_PROVIDER_ID,
} from "./contracts.mjs";
import {
  CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  CONTRACTS_ANALYSIS_GROUPS,
  CONTRACTS_ANALYSIS_LIMITS,
  CONTRACTS_ANALYSIS_MEASURES,
  CONTRACTS_ANALYSIS_PROVIDER_ID,
} from "./contracts_analysis.mjs";
import {
  PEOPLE_GET_CAPABILITY_REFERENCE,
  PEOPLE_GET_LIMITS,
  PEOPLE_GET_PROVIDER_ID,
  ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE,
  ORGANIZATIONS_BROWSE_LIMITS,
  ORGANIZATIONS_BROWSE_PROVIDER_ID,
  PEOPLE_ORGANIZATION_ROW_KINDS,
} from "./people_organizations.mjs";
import {
  MEETING_GET_CAPABILITY_REFERENCE,
  MEETING_GET_LIMITS,
  MEETING_GET_PROVIDER_ID,
  MEETING_GET_REPRESENTATIONS,
} from "./meetings.mjs";
import {
  LAND_FAMILY_FILTER_VALUES,
  LAND_PROCEDURE_FILTER_VALUES,
  LAND_PROJECT_GET_CAPABILITY_REFERENCE,
  LAND_PROJECT_GET_LIMITS,
  LAND_PROJECT_GET_PROVIDER_ID,
  LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE,
  LAND_PROJECTS_BROWSE_CORPUS,
  LAND_PROJECTS_BROWSE_LIMITS,
  LAND_PROJECTS_BROWSE_PROVIDER_ID,
  LAND_REGULATORY_EFFECT_FILTER_VALUES,
  LAND_STAGE_FILTER_VALUES,
} from "./land_projects.mjs";
import {
  LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE,
  LAND_DECISION_PATH_GET_LIMITS,
  LAND_DECISION_PATH_GET_PROVIDER_ID,
} from "./land_decision_path.mjs";
import {
  DECLARED_CAPABILITY_GAPS,
  DECLARED_CAPABILITY_GAPS_SCHEMA,
  validateDeclaredCapabilityGaps,
} from "./declared_gaps.mjs";
import { CITED_RETRIEVAL_OUTPUT_SCHEMA } from "../worker/src/cited_retrieval.mjs";
import { SEMANTIC_SOURCE_FAMILIES } from "../worker/src/semantic_candidates.mjs";

export const MCP_NOTICE_SEARCH_DEFAULT_LIMIT = 15;
export const MCP_PUBLIC_READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const MCP_OPEN_WORLD_READ_ANNOTATIONS = Object.freeze({
  ...MCP_PUBLIC_READ_ANNOTATIONS,
  openWorldHint: true,
});
const MCP_MUTATION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});

export const MCP_NOTICE_SEARCH_ADAPTER = Object.freeze({
  id: "mcp.search_notices@1",
  capabilityReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
  providerId: NOTICE_SEARCH_PROVIDER_ID,
  route: "POST /mcp",
  tool: "search_notices",
  surface: "MCP",
});

export const MCP_FEDERATED_SEARCH_ADAPTER = Object.freeze({
  id: "mcp.search_federated@1",
  capabilityReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  providerId: FEDERATED_SEARCH_PROVIDER_ID,
  route: "POST /mcp",
  tool: "search_federated",
  surface: "MCP",
});

export const MCP_NOTICE_GET_ADAPTER = Object.freeze({
  id: "mcp.get_notice@1",
  capabilityReference: NOTICE_GET_CAPABILITY_REFERENCE,
  providerId: NOTICE_GET_PROVIDER_ID,
  route: "POST /mcp",
  tool: "get_notice",
  surface: "MCP",
  representations: NOTICE_GET_REPRESENTATIONS,
});

export const MCP_CITED_PASSAGES_ADAPTER = Object.freeze({
  id: "mcp.retrieve_cited_passages@1",
  capabilityReference: CITED_PASSAGES_CAPABILITY_REFERENCE,
  providerId: CITED_PASSAGES_PROVIDER_ID,
  route: "POST /mcp",
  tool: "retrieve_cited_passages",
  surface: "MCP",
  representations: CITED_PASSAGES_REPRESENTATIONS,
});

export const MCP_ENTITY_DOSSIER_ADAPTER = Object.freeze({
  id: "mcp.get_entity_dossier@1",
  capabilityReference: ENTITY_DOSSIER_CAPABILITY_REFERENCE,
  providerId: ENTITY_DOSSIER_PROVIDER_ID,
  route: "POST /mcp",
  tool: "get_entity_dossier",
  surface: "MCP",
});

export const MCP_ENTITY_RELATIONSHIPS_ADAPTER = Object.freeze({
  id: "mcp.get_entity_relationships@1",
  capabilityReference: ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
  providerId: ENTITY_RELATIONSHIPS_PROVIDER_ID,
  route: "POST /mcp",
  tool: "get_entity_relationships",
  surface: "MCP",
});

export const MCP_CONTRACT_GET_ADAPTER = Object.freeze({
  id: "mcp.get_contract@1",
  capabilityReference: CONTRACT_GET_CAPABILITY_REFERENCE,
  providerId: CONTRACT_GET_PROVIDER_ID,
  route: "POST /mcp",
  tool: "get_contract",
  surface: "MCP",
});

export const MCP_CONTRACTS_BROWSE_ADAPTER = Object.freeze({
  id: "mcp.browse_contracts@1",
  capabilityReference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
  providerId: CONTRACTS_BROWSE_PROVIDER_ID,
  route: "POST /mcp",
  tool: "browse_contracts",
  surface: "MCP",
});

export const MCP_CONTRACTS_ANALYSIS_ADAPTER = Object.freeze({
  id: "mcp.analyze_contracts@1",
  capabilityReference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
  providerId: CONTRACTS_ANALYSIS_PROVIDER_ID,
  route: "POST /mcp",
  tool: "analyze_contracts",
  surface: "MCP",
});

export const MCP_PEOPLE_GET_ADAPTER = Object.freeze({ id: "mcp.get_person_or_organization@1", capabilityReference: PEOPLE_GET_CAPABILITY_REFERENCE, providerId: PEOPLE_GET_PROVIDER_ID, route: "POST /mcp", tool: "get_person_or_organization", surface: "MCP" });
export const MCP_ORGANIZATIONS_BROWSE_ADAPTER = Object.freeze({ id: "mcp.browse_organizations@1", capabilityReference: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE, providerId: ORGANIZATIONS_BROWSE_PROVIDER_ID, route: "POST /mcp", tool: "browse_organizations", surface: "MCP" });
export const MCP_MEETING_GET_ADAPTER = Object.freeze({ id: "mcp.get_meeting@1", capabilityReference: MEETING_GET_CAPABILITY_REFERENCE, providerId: MEETING_GET_PROVIDER_ID, route: "POST /mcp", tool: "get_meeting", surface: "MCP", representations: MEETING_GET_REPRESENTATIONS });
export const MCP_LAND_PROJECT_GET_ADAPTER = Object.freeze({ id: "mcp.get_land_project@1", capabilityReference: LAND_PROJECT_GET_CAPABILITY_REFERENCE, providerId: LAND_PROJECT_GET_PROVIDER_ID, route: "POST /mcp", tool: "get_land_project", surface: "MCP" });
export const MCP_LAND_PROJECTS_BROWSE_ADAPTER = Object.freeze({ id: "mcp.browse_land_projects@1", capabilityReference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE, providerId: LAND_PROJECTS_BROWSE_PROVIDER_ID, route: "POST /mcp", tool: "browse_land_projects", surface: "MCP" });
export const MCP_LAND_DECISION_PATH_GET_ADAPTER = Object.freeze({ id: "mcp.get_land_decision_path@1", capabilityReference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE, providerId: LAND_DECISION_PATH_GET_PROVIDER_ID, route: "POST /mcp", tool: "get_land_decision_path", surface: "MCP" });

const NOTICE_SEARCH_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["terms_used", "total_matches", "retrieval", "results"],
  properties: {
    terms_used: { type: "array", items: { type: "string" } },
    total_matches: { type: "integer", minimum: 0 },
    retrieval: {
      type: "object",
      additionalProperties: false,
      required: ["method", "fallback_reason", "duration_ms", "rows_read", "result_count"],
      properties: {
        method: { type: "string" },
        fallback_reason: { type: ["string", "null"] },
        duration_ms: { type: "number", minimum: 0 },
        rows_read: { type: ["number", "null"], minimum: 0 },
        result_count: { type: "integer", minimum: 0 },
      },
    },
    results: { type: "array", maxItems: NOTICE_SEARCH_LIMITS.maximum, items: { type: "object" } },
  },
});
const ENTITY_DOSSIER_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["capability_reference", "availability", "dossier", "error"],
  properties: {
    capability_reference: { type: "string", const: ENTITY_DOSSIER_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["available", "not_yet_public", "unavailable"] },
    dossier: { type: ["object", "null"] },
    error: { type: ["string", "null"] },
  },
});
const NOTICE_GET_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["capability_reference", "availability", "notice", "source", "generated_at", "stale", "error"],
  properties: {
    capability_reference: { type: "string", const: NOTICE_GET_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["available", "not_yet_public", "unavailable"] },
    notice: { type: ["object", "null"] },
    source: { type: ["string", "null"] },
    generated_at: { type: ["string", "null"] },
    stale: { type: ["boolean", "null"] },
    error: { type: ["string", "null"] },
  },
});
const ENTITY_RELATIONSHIPS_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["capability_reference", "availability", "graph", "error"],
  properties: {
    capability_reference: { type: "string", const: ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["available", "not_yet_public", "unavailable"] },
    graph: { type: ["object", "null"] },
    error: { type: ["string", "null"] },
  },
});
const CONTRACT_GET_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["capability_reference", "availability", "contract", "error"],
  properties: {
    capability_reference: { type: "string", const: CONTRACT_GET_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["available", "not_yet_public", "unavailable"] },
    contract: { type: ["object", "null"] },
    error: { type: ["string", "null"] },
  },
});
const CONTRACTS_BROWSE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["capability_reference", "availability", "results", "total_matches", "pagination", "coverage", "freshness", "error"],
  properties: {
    capability_reference: { type: "string", const: CONTRACTS_BROWSE_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["complete", "empty", "unavailable"] },
    results: { type: ["array", "null"], maxItems: CONTRACTS_BROWSE_LIMITS.maximum, items: { type: "object" } },
    total_matches: { type: ["integer", "null"], minimum: 0 },
    pagination: { type: ["object", "null"] },
    coverage: { type: ["object", "null"] },
    freshness: { type: ["object", "null"] },
    error: { type: ["string", "null"] },
  },
});
const PEOPLE_GET_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["capability_reference", "availability", "person_or_organization", "error"],
  properties: {
    capability_reference: { type: "string", const: PEOPLE_GET_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["available", "not_yet_public", "unavailable"] },
    person_or_organization: { type: ["object", "null"] }, error: { type: ["string", "null"] },
  },
});
const ORGANIZATIONS_BROWSE_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["capability_reference", "availability", "results", "total_matches", "pagination", "coverage", "freshness", "error"],
  properties: {
    capability_reference: { type: "string", const: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["complete", "empty", "unavailable"] },
    results: { type: ["array", "null"], maxItems: ORGANIZATIONS_BROWSE_LIMITS.maximum, items: { type: "object" } },
    total_matches: { type: ["integer", "null"], minimum: 0 }, pagination: { type: ["object", "null"] }, coverage: { type: ["object", "null"] }, freshness: { type: ["object", "null"] }, error: { type: ["string", "null"] },
  },
});
const CONTRACTS_ANALYSIS_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["capability_reference", "availability", "group_by", "measure", "groups", "denominator", "population", "coverage", "contract_detail", "filters", "freshness", "error"],
  properties: {
    capability_reference: { type: "string", const: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["complete", "empty", "unavailable"] },
    group_by: { type: "string", enum: CONTRACTS_ANALYSIS_GROUPS },
    measure: { type: "object" },
    groups: { type: ["array", "null"], maxItems: CONTRACTS_ANALYSIS_LIMITS.maximumGroups, items: { type: "object" } },
    denominator: { type: ["object", "null"] },
    population: { type: ["object", "null"] },
    coverage: { type: ["object", "null"] },
    contract_detail: { type: ["object", "null"] },
    filters: { type: ["object", "null"], properties: {
      discovery: { type: "object", required: ["agency", "fiscal_year"], properties: {
        agency: { type: "object", required: ["match", "accepted_labels", "requested_label", "status", "suggestions", "message"], properties: {
          match: { const: "exact_label" },
          status: { enum: ["not_requested", "recognized", "unrecognized"] },
          accepted_labels: { type: "array", uniqueItems: true, items: { type: "string" } },
          requested_label: { type: ["string", "null"] },
          suggestions: { type: "array", maxItems: 5, items: { type: "string" } },
          message: { type: ["string", "null"] },
        } },
        fiscal_year: { type: "object", required: ["field", "definition", "accepted_values", "requested_value", "period_start", "period_end"], properties: {
          field: { const: "registration_fiscal_year" }, definition: { type: "string" },
          accepted_values: { type: "array", uniqueItems: true, items: { type: "integer" } },
          requested_value: { type: ["integer", "null"] },
          period_start: { type: ["string", "null"] }, period_end: { type: ["string", "null"] },
      } },
    } },
    } },
    freshness: { type: ["object", "null"] },
    error: { type: ["string", "null"] },
  },
});

const LAND_PROJECT_GET_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["capability_reference", "availability", "project", "error"],
  properties: {
    capability_reference: { type: "string", const: LAND_PROJECT_GET_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["available", "not_yet_public", "unavailable"] },
    project: { type: ["object", "null"] },
    error: { type: ["string", "null"] },
  },
});
const LAND_PROJECTS_BROWSE_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["capability_reference", "availability", "results", "total_matches", "pagination", "coverage", "freshness", "error"],
  properties: {
    capability_reference: { type: "string", const: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["complete", "empty", "unavailable"] },
    results: { type: ["array", "null"], maxItems: LAND_PROJECTS_BROWSE_LIMITS.maximum, items: { type: "object" } },
    total_matches: { type: ["integer", "null"], minimum: 0 },
    pagination: { type: ["object", "null"] },
    coverage: { type: ["object", "null"] },
    freshness: { type: ["object", "null"] },
    error: { type: ["string", "null"] },
  },
});
const LAND_DECISION_PATH_GET_OUTPUT_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false,
  required: ["capability_reference", "availability", "project_id", "decision_path", "error"],
  properties: {
    capability_reference: { type: "string", const: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE },
    availability: { type: "string", enum: ["available", "not_yet_public", "unavailable"] },
    project_id: { type: ["string", "null"] },
    decision_path: { type: ["object", "null"] },
    error: { type: ["string", "null"] },
  },
});

const SUBSCRIBABLE_LENSES = ["money", "people", "land", "property", "rules", "meetings"];

const MCP_REGISTERED_AND_PILOT_TOOLS = [
  {
    name: "search_federated",
    description: "Search the registered public CityScroll lenses in one bounded result set. Optional scope selects only allowlisted registered lenses. Preserves per-lens coverage, source observations, exact object routes, and federated ranking; it does not expose a raw store or arbitrary query language.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: FEDERATED_SEARCH_LIMITS.queryMaximumLength, description: "Resident search terms, up to 240 characters." },
        limit: { type: "integer", minimum: 1, maximum: FEDERATED_SEARCH_LIMITS.maximumResults, default: FEDERATED_SEARCH_LIMITS.defaultResults },
        scope: {
          description: "Closed allowlist of registered federation lenses. Omit to search every registered lens.",
          anyOf: [
            { type: "string", enum: [...FEDERATED_SEARCH_LENS_IDS] },
            { type: "array", minItems: 1, items: { type: "string", enum: [...FEDERATED_SEARCH_LENS_IDS] } },
            {
              type: "object", additionalProperties: false,
              required: ["lenses"],
              properties: {
                schema: { type: "string", const: FEDERATED_SEARCH_SCOPE_SCHEMA },
                lenses: {
                  type: "array", minItems: 1,
                  items: { type: "string", enum: [...FEDERATED_SEARCH_LENS_IDS] },
                },
              },
            },
          ],
        },
      },
      required: ["query"],
    },
    outputSchema: FEDERATED_SEARCH_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "search_notices",
    description: "Search NYC City Record notices (the daily-refreshed mirror). Keyword terms are OR-matched; add structured filters to narrow. Amounts are validity-filtered (data-entry errors excluded); rolling placeholder deadlines are labeled, never shown as dates.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", description: "Keyword terms, space-separated (e.g. 'affordable housing')." },
        section: { type: "string", description: "Exact section, e.g. 'Procurement', 'Public Hearings and Meetings', 'Agency Rules'." },
        agency: { type: "string", description: "Agency name substring." },
        min_amount: { type: "number", description: "Minimum contract amount in dollars (Award notices only carry amounts)." },
        max_amount: { type: "number", description: "Maximum contract amount in dollars." },
        open_only: { type: "boolean", description: "Only notices whose due date hasn't passed." },
        exclude_rolling: { type: "boolean", description: "Drop pre-qualified-list placeholders (year-2090 'deadlines')." },
        limit: { type: "number", description: `Max results (default ${MCP_NOTICE_SEARCH_DEFAULT_LIMIT}, cap ${NOTICE_SEARCH_LIMITS.maximum}).` },
      },
    },
    outputSchema: NOTICE_SEARCH_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "get_notice",
    description: "Get one public City Record notice by its exact RequestID. The result preserves materialized-source freshness and distinguishes a missing public notice from a read that cannot be served.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        request_id: { type: "string", minLength: 1, maxLength: NOTICE_GET_LIMITS.requestIdMaximumLength },
      },
      required: ["request_id"],
    },
    outputSchema: NOTICE_GET_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "get_entity_dossier",
    description: "Get the bounded public dossier for one exact canonical CityScroll entity. Preserves attributed disagreements, availability, provenance, and public redaction.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        entity_id: {
          type: "string",
          minLength: 1,
          maxLength: ENTITY_DOSSIER_LIMITS.entityIdMaximumLength,
          description: "Exact canonical CityScroll entity identifier.",
        },
      },
      required: ["entity_id"],
    },
    outputSchema: ENTITY_DOSSIER_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "get_entity_relationships",
    description: "Traverse bounded, evidence-bearing public relationships from one exact canonical CityScroll entity. Only the closed node and edge vocabularies are returned. Published agency graphs give person-leader nodes available_detail: separate dossier availability, an exact leadership read path when available, observation date, confidence, and source limitation.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        entity_id: {
          type: "string",
          minLength: 1,
          maxLength: ENTITY_RELATIONSHIPS_LIMITS.entityIdMaximumLength,
          description: "Exact canonical CityScroll entity identifier.",
        },
        depth: {
          type: "integer",
          minimum: 1,
          maximum: ENTITY_RELATIONSHIPS_LIMITS.maximumDepth,
          default: ENTITY_RELATIONSHIPS_LIMITS.defaultDepth,
        },
        fan_out: {
          type: "integer",
          minimum: 1,
          maximum: ENTITY_RELATIONSHIPS_LIMITS.maximumFanOut,
          default: ENTITY_RELATIONSHIPS_LIMITS.defaultFanOut,
        },
        node_types: {
          type: "array",
          maxItems: ENTITY_RELATIONSHIPS_NODE_TYPES.length,
          uniqueItems: true,
          items: { type: "string", enum: ENTITY_RELATIONSHIPS_NODE_TYPES },
        },
        edge_types: {
          type: "array",
          maxItems: ENTITY_RELATIONSHIPS_EDGE_TYPES.length,
          uniqueItems: true,
          items: { type: "string", enum: ENTITY_RELATIONSHIPS_EDGE_TYPES },
        },
      },
      required: ["entity_id"],
    },
    outputSchema: ENTITY_RELATIONSHIPS_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "retrieve_cited_passages",
    description: "Retrieve source passages with stable citations and exact source joins. Returns source text only. hard_scope.corpus includes observed_on, source_families with coverage and source publication-date bounds, record_count, and passage_count even when no citations match. It does not generate an answer or infer civic relationships.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 240, description: "The resident's original search terms." },
        source_family: { type: "string", enum: SEMANTIC_SOURCE_FAMILIES },
        body_id: { type: "string", maxLength: 120, description: "Exact civic body identifier." },
        published_from: { type: "string", format: "date" },
        published_to: { type: "string", format: "date" },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["query"],
    },
    outputSchema: CITED_RETRIEVAL_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "get_contract",
    description: "Get one public contract by its exact ID. Uses the same Contracts record as CityScroll. Includes source links, coverage, freshness, amount validity, and lifecycle facts when available.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        procurement_id: {
          type: "string",
          minLength: 1,
          maxLength: CONTRACT_GET_LIMITS.procurementIdMaximumLength,
          description: "Exact canonical procurement_id, including its procurement: prefix.",
        },
      },
      required: ["procurement_id"],
    },
    outputSchema: CONTRACT_GET_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "browse_contracts",
    description: "List public Contracts records with bounded filters and pages. Results keep exact contract IDs separate, including records that share a PIN. Use population=registered with the analysis continuation arguments for exact analytical groups: this returns registration id, procurement_id and href, including registrations with no detail record.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        population: { type: "string", enum: ["registered"], description: "Exact registered-contract population; agency and vendor use case-sensitive analytical labels in this mode." },
        fiscal_year: { type: "integer", minimum: 1900, maximum: 2200 },
        amount_band: { type: "string", maxLength: CONTRACTS_BROWSE_LIMITS.filterMaximumLength },
        retroactive: { type: "boolean" },
        city_record_match: { type: "string", enum: ["exact", "none", "cannot_evaluate_missing_pin"] },
        group_by: { type: "string", enum: CONTRACTS_ANALYSIS_GROUPS },
        group_label: { type: "string", maxLength: CONTRACTS_BROWSE_LIMITS.filterMaximumLength, description: "Exact analytical group label, including Unknown / not published; requires group_by." },
        query: { type: "string", maxLength: CONTRACTS_BROWSE_LIMITS.filterMaximumLength, description: "Case-insensitive terms matched against the existing Contracts browse fields." },
        agency: { type: "string", maxLength: CONTRACTS_BROWSE_LIMITS.filterMaximumLength, description: "Case-insensitive agency substring." },
        vendor: { type: "string", maxLength: CONTRACTS_BROWSE_LIMITS.filterMaximumLength, description: "Case-insensitive vendor substring." },
        stage: { type: "string", maxLength: CONTRACTS_BROWSE_LIMITS.filterMaximumLength, description: "Exact lifecycle stage." },
        source_system: { type: "string", maxLength: CONTRACTS_BROWSE_LIMITS.filterMaximumLength, description: "Exact source-system value." },
        min_amount: { type: "number", description: "Inclusive valid public amount floor." },
        max_amount: { type: "number", description: "Inclusive valid public amount ceiling." },
        limit: { type: "integer", minimum: CONTRACTS_BROWSE_LIMITS.minimum, maximum: CONTRACTS_BROWSE_LIMITS.maximum, default: CONTRACTS_BROWSE_LIMITS.default },
        cursor: { type: "string", maxLength: CONTRACTS_BROWSE_LIMITS.cursorMaximumLength, description: "Opaque cursor returned by the previous page." },
      },
    },
    outputSchema: CONTRACTS_BROWSE_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "analyze_contracts",
    description: "Rank groups by agency, vendor, fiscal year, or amount band. Uses the registered-contract population. Reports registered value or contract count, a scope denominator, and coverage. Each group gives contract_count, contract_sample (default 10, maximum 50; id, procurement_id, canonical href), and an exact browse_contracts continuation. Null procurement_id/href means no individual detail record is published. Groups are paginated in filters.pagination to keep research responses below 64 KiB; repeat the same filters with next_cursor. Does not report payments or spending. Omit agency to discover filters.discovery.agency.accepted_labels; retry an unrecognized label using a suggested exact label. fiscal_year is derived from registration date, July 1 through June 30.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        sample_limit: { type: "integer", minimum: 1, maximum: CONTRACTS_ANALYSIS_LIMITS.maximumSample, default: CONTRACTS_ANALYSIS_LIMITS.defaultSample },
        cursor: { type: "string", maxLength: 32, pattern: "^groups:[0-9]+$", description: "filters.pagination.next_cursor; repeat all other arguments unchanged." },
        group_by: { type: "string", enum: CONTRACTS_ANALYSIS_GROUPS, default: "agency", description: "Grouping dimension." },
        measure: { type: "string", enum: CONTRACTS_ANALYSIS_MEASURES, default: "current", description: "current or original registered contract value, or unique contract count." },
        agency: { type: "string", maxLength: CONTRACTS_ANALYSIS_LIMITS.filterMaximumLength, description: "Exact case-sensitive label from filters.discovery.agency.accepted_labels; omit agency to discover the set." },
        vendor: { type: "string", maxLength: CONTRACTS_ANALYSIS_LIMITS.filterMaximumLength },
        fiscal_year: { type: "integer", description: "NYC registration fiscal year, July 1 of the preceding year through June 30, derived from registration date." },
        amount_band: { type: "string", maxLength: CONTRACTS_ANALYSIS_LIMITS.filterMaximumLength },
        min_amount: { type: "number" },
        max_amount: { type: "number" },
        retroactive: { type: "boolean" },
        city_record_match: { type: "string", enum: ["exact", "none", "cannot_evaluate_missing_pin"] },
        limit: { type: "integer", minimum: CONTRACTS_ANALYSIS_LIMITS.minimumGroups, maximum: CONTRACTS_ANALYSIS_LIMITS.maximumGroups, default: CONTRACTS_ANALYSIS_LIMITS.defaultGroups },
      },
    },
    outputSchema: CONTRACTS_ANALYSIS_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "get_person_or_organization",
    description: "Get one exact typed person or organization row from the published People and organizations read model. Display names never create identity; relation states and source fields are preserved.",
    inputSchema: { type: "object", additionalProperties: false, properties: { entity_id: { type: "string", minLength: 1, maxLength: PEOPLE_GET_LIMITS.entityIdMaximumLength, description: "Exact row id such as official:... or agency:id:..." } }, required: ["entity_id"] },
    outputSchema: PEOPLE_GET_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "browse_organizations",
    description: "Browse the bounded typed People and organizations snapshot with exact row-kind and token filters. Results retain published, empty, or unknown relation states and read-model freshness.",
    inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: ORGANIZATIONS_BROWSE_LIMITS.queryMaximumLength }, kind: { type: "string", enum: [...PEOPLE_ORGANIZATION_ROW_KINDS] }, limit: { type: "integer", minimum: 1, maximum: ORGANIZATIONS_BROWSE_LIMITS.maximum, default: ORGANIZATIONS_BROWSE_LIMITS.default }, cursor: { type: "string", maxLength: ORGANIZATIONS_BROWSE_LIMITS.cursorMaximumLength } } },
    outputSchema: ORGANIZATIONS_BROWSE_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "get_meeting",
    description: "Get one exact source-qualified meeting from the shared CityScroll meeting read model. Preserves source receipt, coverage, freshness, and attached meeting documents. source_presence, source_observation, minutes, and city_record_join are independent states; no notice join does not mean no source meeting.",
    inputSchema: { type: "object", additionalProperties: false, properties: { meeting_id: { type: "string", minLength: 1, maxLength: MEETING_GET_LIMITS.meetingIdMaximumLength, description: "Exact canonical meeting id, including its meeting: prefix." } }, required: ["meeting_id"] },
    outputSchema: {
      type: "object", additionalProperties: false,
      required: ["capability_reference", "availability", "meeting", "source", "coverage", "freshness", "error"],
      properties: {
        capability_reference: { type: "string", const: MEETING_GET_CAPABILITY_REFERENCE },
        availability: { type: "string", enum: ["available", "not_yet_public", "unavailable"] },
        meeting: { type: ["object", "null"], properties: {
          source_presence: { type: "object", required: ["status", "publisher_identifier"], properties: { status: { const: "present" }, publisher_identifier: { type: ["string", "null"] } } },
          source_observation: { type: "object", required: ["observed_at", "observed_on"], properties: { observed_at: { type: ["string", "null"] }, observed_on: { type: ["string", "null"] } } },
          minutes: { type: "object", required: ["status", "checked_at"], properties: { status: { type: "string", description: "Publisher minutes freshness status, or unknown when not supplied." }, checked_at: { type: ["string", "null"] } } },
          city_record_join: { type: "object", required: ["status", "reason", "scope"], properties: { status: { enum: ["source_record", "matched", "none", "unknown"] }, reason: { type: ["string", "null"] }, scope: { type: "string" } } },
        } },
        source: { type: ["object", "null"] },
        coverage: { type: ["object", "null"] },
        freshness: { type: ["object", "null"] },
        error: { type: ["string", "null"] },
      },
    },
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "get_land_project",
    description: "Get one exact Land (ZAP) project by its ZAP project id. Includes its deep link, status, geography, applicant, review procedure, exact actions and ids, environmental facts, milestones, outcomes, sources, and any conflicts, when known.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        project_id: { type: "string", minLength: 1, maxLength: LAND_PROJECT_GET_LIMITS.projectIdMaximumLength, description: "Exact publisher ZAP project id, e.g. 2024Q0356." },
      },
      required: ["project_id"],
    },
    outputSchema: LAND_PROJECT_GET_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "browse_land_projects",
    description: "List public Land (ZAP) projects using the same filters as the Land page: review procedure, action type, stage, effect, and geography. Reads the full warehouse, not just active projects, so completed and past projects stay reachable too.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        status: { type: "string", maxLength: LAND_PROJECTS_BROWSE_LIMITS.filterMaximumLength, description: "Exact publisher public/project status, e.g. 'public:Noticed' or 'project:Active'. Omit for every status — never active-only." },
        query: { type: "string", maxLength: LAND_PROJECTS_BROWSE_LIMITS.filterMaximumLength, description: "Case-insensitive terms matched against the existing Land browse row text." },
        procedure: { type: "string", enum: [...LAND_PROCEDURE_FILTER_VALUES], description: "Resident review-procedure facet." },
        family: { type: "string", enum: [...LAND_FAMILY_FILTER_VALUES], description: "Resident closed action-family facet." },
        stage: { type: "string", enum: [...LAND_STAGE_FILTER_VALUES], description: "Resident review-stage facet." },
        regulatory_effect: { type: "string", enum: [...LAND_REGULATORY_EFFECT_FILTER_VALUES], description: "Resident regulatory-effect facet." },
        borough: { type: "string", maxLength: LAND_PROJECTS_BROWSE_LIMITS.filterMaximumLength, description: "Exact borough name." },
        community_district: { type: "string", maxLength: LAND_PROJECTS_BROWSE_LIMITS.filterMaximumLength, description: "Borough-lettered community district substring, e.g. K02." },
        council_district: { type: "string", maxLength: LAND_PROJECTS_BROWSE_LIMITS.filterMaximumLength, description: "Council district number." },
        corpus: { type: "string", enum: [...LAND_PROJECTS_BROWSE_CORPUS], description: "'live' (default) reads the current committed complete warehouse. 'historical' reads the frozen four-project expedited-procedure regression corpus, for reproducible verification." },
        limit: { type: "integer", minimum: LAND_PROJECTS_BROWSE_LIMITS.minimum, maximum: LAND_PROJECTS_BROWSE_LIMITS.maximum, default: LAND_PROJECTS_BROWSE_LIMITS.default },
        cursor: { type: "string", maxLength: LAND_PROJECTS_BROWSE_LIMITS.cursorMaximumLength, description: "Opaque cursor returned by the previous page." },
      },
    },
    outputSchema: LAND_PROJECTS_BROWSE_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "get_land_decision_path",
    description: "Get the typed Land decision path for one exact project. Observed milestones and events remain separate from the reviewed normative procedure stages, actors, effects, and parallel review groups; absent and unknown stages stay explicit.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        project_id: { type: "string", minLength: 1, maxLength: LAND_DECISION_PATH_GET_LIMITS.projectIdMaximumLength, description: "Exact publisher ZAP project id, e.g. 2024Q0356." },
      },
      required: ["project_id"],
    },
    outputSchema: LAND_DECISION_PATH_GET_OUTPUT_SCHEMA,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  },
  {
    name: "preview_watch",
    description: "Preview what a plain-English standing watch would deliver, without subscribing. Lens: money (procurement), land (rezonings), property, rules, meetings, people.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        lens: { type: "string", enum: [...SUBSCRIBABLE_LENSES] },
        request: { type: "string", description: "Plain-English description, e.g. 'construction awards over $1M from Parks'." },
      },
      required: ["lens", "request"],
    },
    annotations: MCP_OPEN_WORLD_READ_ANNOTATIONS,
  },
  {
    name: "create_watch",
    description: "Create a standing email watch from plain English. The watch starts immediately; the welcome email states its scope and includes manage and unsubscribe links.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        email: { type: "string" },
        lens: { type: "string", enum: [...SUBSCRIBABLE_LENSES] },
        request: { type: "string", description: "Plain-English description of what to watch." },
        freq: { type: "string", enum: ["daily", "weekly"], description: "Digest frequency (default daily)." },
      },
      required: ["email", "lens", "request"],
    },
    annotations: MCP_MUTATION_ANNOTATIONS,
  },
];

const MCP_REGISTERED_AND_PILOT_TOOL_BINDINGS = Object.freeze([
  Object.freeze({
    name: "search_federated",
    operationClass: "read",
    schemaReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    capabilityReference: FEDERATED_SEARCH_CAPABILITY_REFERENCE,
    adapterId: MCP_FEDERATED_SEARCH_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: FEDERATED_SEARCH_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: "search_notices",
    operationClass: "read",
    schemaReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
    capabilityReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
    adapterId: MCP_NOTICE_SEARCH_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: NOTICE_SEARCH_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: "get_notice",
    operationClass: "read",
    schemaReference: NOTICE_GET_CAPABILITY_REFERENCE,
    capabilityReference: NOTICE_GET_CAPABILITY_REFERENCE,
    adapterId: MCP_NOTICE_GET_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: NOTICE_GET_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: "get_entity_dossier",
    operationClass: "read",
    schemaReference: ENTITY_DOSSIER_CAPABILITY_REFERENCE,
    capabilityReference: ENTITY_DOSSIER_CAPABILITY_REFERENCE,
    adapterId: MCP_ENTITY_DOSSIER_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: ENTITY_DOSSIER_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: "get_entity_relationships",
    operationClass: "read",
    schemaReference: ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
    capabilityReference: ENTITY_RELATIONSHIPS_CAPABILITY_REFERENCE,
    adapterId: MCP_ENTITY_RELATIONSHIPS_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: ENTITY_RELATIONSHIPS_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: "retrieve_cited_passages",
    operationClass: "read",
    schemaReference: CITED_PASSAGES_CAPABILITY_REFERENCE,
    capabilityReference: CITED_PASSAGES_CAPABILITY_REFERENCE,
    adapterId: MCP_CITED_PASSAGES_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: CITED_PASSAGES_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: "get_contract",
    operationClass: "read",
    schemaReference: CONTRACT_GET_CAPABILITY_REFERENCE,
    capabilityReference: CONTRACT_GET_CAPABILITY_REFERENCE,
    adapterId: MCP_CONTRACT_GET_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: CONTRACT_GET_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: "browse_contracts",
    operationClass: "read",
    schemaReference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
    capabilityReference: CONTRACTS_BROWSE_CAPABILITY_REFERENCE,
    adapterId: MCP_CONTRACTS_BROWSE_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: CONTRACTS_BROWSE_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({
    name: "analyze_contracts",
    operationClass: "read",
    schemaReference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
    capabilityReference: CONTRACTS_ANALYSIS_CAPABILITY_REFERENCE,
    adapterId: MCP_CONTRACTS_ANALYSIS_ADAPTER.id,
    authorityClass: "public_read",
    storeAccess: "provider-only",
    bounds: CONTRACTS_ANALYSIS_LIMITS,
    annotations: MCP_PUBLIC_READ_ANNOTATIONS,
  }),
  Object.freeze({ name: "get_person_or_organization", operationClass: "read", schemaReference: PEOPLE_GET_CAPABILITY_REFERENCE, capabilityReference: PEOPLE_GET_CAPABILITY_REFERENCE, adapterId: MCP_PEOPLE_GET_ADAPTER.id, authorityClass: "public_read", storeAccess: "provider-only", bounds: PEOPLE_GET_LIMITS, annotations: MCP_PUBLIC_READ_ANNOTATIONS }),
  Object.freeze({ name: "browse_organizations", operationClass: "read", schemaReference: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE, capabilityReference: ORGANIZATIONS_BROWSE_CAPABILITY_REFERENCE, adapterId: MCP_ORGANIZATIONS_BROWSE_ADAPTER.id, authorityClass: "public_read", storeAccess: "provider-only", bounds: ORGANIZATIONS_BROWSE_LIMITS, annotations: MCP_PUBLIC_READ_ANNOTATIONS }),
  Object.freeze({ name: "get_meeting", operationClass: "read", schemaReference: MEETING_GET_CAPABILITY_REFERENCE, capabilityReference: MEETING_GET_CAPABILITY_REFERENCE, adapterId: MCP_MEETING_GET_ADAPTER.id, authorityClass: "public_read", storeAccess: "provider-only", bounds: MEETING_GET_LIMITS, annotations: MCP_PUBLIC_READ_ANNOTATIONS }),
  Object.freeze({ name: "get_land_project", operationClass: "read", schemaReference: LAND_PROJECT_GET_CAPABILITY_REFERENCE, capabilityReference: LAND_PROJECT_GET_CAPABILITY_REFERENCE, adapterId: MCP_LAND_PROJECT_GET_ADAPTER.id, authorityClass: "public_read", storeAccess: "provider-only", bounds: LAND_PROJECT_GET_LIMITS, annotations: MCP_PUBLIC_READ_ANNOTATIONS }),
  Object.freeze({ name: "browse_land_projects", operationClass: "read", schemaReference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE, capabilityReference: LAND_PROJECTS_BROWSE_CAPABILITY_REFERENCE, adapterId: MCP_LAND_PROJECTS_BROWSE_ADAPTER.id, authorityClass: "public_read", storeAccess: "provider-only", bounds: LAND_PROJECTS_BROWSE_LIMITS, annotations: MCP_PUBLIC_READ_ANNOTATIONS }),
  Object.freeze({ name: "get_land_decision_path", operationClass: "read", schemaReference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE, capabilityReference: LAND_DECISION_PATH_GET_CAPABILITY_REFERENCE, adapterId: MCP_LAND_DECISION_PATH_GET_ADAPTER.id, authorityClass: "public_read", storeAccess: "provider-only", bounds: LAND_DECISION_PATH_GET_LIMITS, annotations: MCP_PUBLIC_READ_ANNOTATIONS }),
  Object.freeze({
    name: "preview_watch",
    operationClass: "read",
    schemaReference: "mcp.preview_watch.pilot@1",
    pilotException: "watch.preview is a scoped, metered composition without a registered capability",
  }),
  Object.freeze({
    name: "create_watch",
    operationClass: "mutation",
    schemaReference: "mcp.create_watch.pilot@1",
    pilotException: "watch.create is a scoped, metered mutation without a registered capability",
  }),
]);

// ---------------------------------------------------------------- declared gaps
//
// The gaps in capabilities/declared_gaps.mjs are part of the public contract: a caller
// that cannot be answered should be able to NAME the missing capability rather than
// guess that one exists. They reach the MCP surface twice — in the server instructions
// every client receives at initialize, and as one read-only tool for a client that only
// reads tools/list. Both are derived from that single declaration; neither restates it.

const CAPABILITY_GAPS_SCHEMA_REFERENCE = "mcp.list_capability_gaps.contract@1";

const NEAREST_TOOL_BY_CAPABILITY = new Map(
  MCP_REGISTERED_AND_PILOT_TOOL_BINDINGS
    .filter(({ capabilityReference }) => capabilityReference)
    .map(({ capabilityReference, name }) => [capabilityReference, name]),
);

function resolveNearestTools(gap) {
  return gap.nearest.map((reference) => {
    const tool = NEAREST_TOOL_BY_CAPABILITY.get(reference);
    // A gap whose nearest capability has no public tool would advertise a dead end.
    if (!tool) throw new Error(`declared gap ${gap.id} names an unpublished capability: ${reference}`);
    return tool;
  });
}

const declaredGapProblems = validateDeclaredCapabilityGaps();
if (declaredGapProblems.length > 0) throw new Error(`declared capability gaps are incomplete: ${declaredGapProblems.join("; ")}`);

/** The declared gaps as the machine surface publishes them, tool names resolved. */
export const MCP_DECLARED_CAPABILITY_GAPS = Object.freeze(DECLARED_CAPABILITY_GAPS.map((gap) => Object.freeze({
  gap: gap.id,
  question: gap.question,
  meaning: gap.meaning,
  nearest_capability_references: Object.freeze([...gap.nearest]),
  nearest_tools: Object.freeze(resolveNearestTools(gap)),
})));

const CAPABILITY_GAPS_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema", "gaps"],
  properties: {
    schema: { type: "string", const: DECLARED_CAPABILITY_GAPS_SCHEMA },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["gap", "question", "meaning", "nearest_capability_references", "nearest_tools"],
        properties: {
          gap: { type: "string" },
          question: { type: "string" },
          meaning: { type: "string" },
          nearest_capability_references: { type: "array", items: { type: "string" } },
          nearest_tools: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
});

const CAPABILITY_GAPS_SUMMARY = MCP_DECLARED_CAPABILITY_GAPS
  .map(({ gap, question, nearest_tools: nearest }) => `${gap} (${question} — nearest tools: ${nearest.join(", ")})`)
  .join("; ");

const MCP_CAPABILITY_GAPS_TOOL = Object.freeze({
  name: "list_capability_gaps",
  description: `List the capability gaps CityScroll declares about itself, so a caller can name what this endpoint does not answer instead of assuming a tool for it exists. Declared gaps: ${CAPABILITY_GAPS_SUMMARY}. Takes no input, reads no records, and returns only this published declaration.`,
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: CAPABILITY_GAPS_OUTPUT_SCHEMA,
  annotations: MCP_PUBLIC_READ_ANNOTATIONS,
});

const MCP_CAPABILITY_GAPS_BINDING = Object.freeze({
  name: "list_capability_gaps",
  operationClass: "read",
  schemaReference: CAPABILITY_GAPS_SCHEMA_REFERENCE,
  contractReference: CAPABILITY_GAPS_SCHEMA_REFERENCE,
  annotations: MCP_PUBLIC_READ_ANNOTATIONS,
});

export const MCP_TOOLS = [...MCP_REGISTERED_AND_PILOT_TOOLS, MCP_CAPABILITY_GAPS_TOOL].map((tool) =>
  tool.annotations === MCP_PUBLIC_READ_ANNOTATIONS ? { ...tool, inputSchema: { ...tool.inputSchema,
    properties: { ...tool.inputSchema.properties,
      identifier_path: { type: "string", maxLength: 1024, description: "JSON Pointer to the identifier array named by a continuation." },
      identifier_offset: { type: "integer", minimum: 0, description: "Offset for identifier arrays only; use the returned continuation with unchanged result filters." },
      identifier_limit: { type: "integer", minimum: 1, maximum: RESEARCH_IDENTIFIER_SAMPLE_MAXIMUM, default: RESEARCH_IDENTIFIER_SAMPLE_DEFAULT, description: "Maximum identifiers per array; counts and replay continuations accompany sampled arrays." },
    } } } : tool);

export const MCP_TOOL_BINDINGS = Object.freeze([
  ...MCP_REGISTERED_AND_PILOT_TOOL_BINDINGS,
  MCP_CAPABILITY_GAPS_BINDING,
]);

/** The declaration a caller receives from `list_capability_gaps`. */
export function declaredCapabilityGapsResult() {
  return { schema: DECLARED_CAPABILITY_GAPS_SCHEMA, gaps: MCP_DECLARED_CAPABILITY_GAPS.map((gap) => ({ ...gap, nearest_capability_references: [...gap.nearest_capability_references], nearest_tools: [...gap.nearest_tools] })) };
}

/**
 * Server-level instructions returned at initialize. Short on purpose: what the endpoint
 * is, then the declared gaps, which are the only part a caller cannot discover from a
 * tool listing alone.
 */
export const MCP_SERVER_INSTRUCTIONS = [
  "CityScroll publishes New York City public records. Every tool answers from a published record and returns its source and freshness; none of them opine, and none of them predict.",
  "",
  "Declared gaps — questions this endpoint does not answer:",
  ...MCP_DECLARED_CAPABILITY_GAPS.map(({ gap, question, meaning, nearest_tools: nearest }) => (
    `- ${gap} — ${question} ${meaning} Nearest available tools: ${nearest.join(", ")}.`
  )),
  "",
  "When a request falls into a declared gap, name the gap by its id, say that it is a declared limit of this endpoint rather than a missing record, and offer what the nearest tools do publish. The same list is available as structured data from the list_capability_gaps tool.",
].join("\n");

export const MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS = Object.freeze(
  MCP_TOOL_BINDINGS.filter(({ capabilityReference, authorityClass }) => (
    capabilityReference && authorityClass === "public_read"
  )),
);

/**
 * Contract-surface tools: read-only tools that answer from this repository's own
 * published contract rather than from a record. They hold no capability, reach no
 * store, and return nothing an anonymous caller could not already read, which is what
 * lets a scoped machine-client profile carry one without widening its data grant.
 */
export const MCP_CONTRACT_SURFACE_TOOL_BINDINGS = Object.freeze(
  MCP_TOOL_BINDINGS.filter(({ capabilityReference, contractReference, operationClass, storeAccess }) => (
    !capabilityReference && contractReference && operationClass === "read" && !storeAccess
  )),
);
