// Runtime-safe MCP declarations shared by the Worker adapter and build-time catalog.
// Keep this module free of request handling and optional Worker-only dependencies so
// topology tests can inspect the public tool contract in the site Unit family.

import {
  FEDERATED_SEARCH_CAPABILITY_REFERENCE,
  FEDERATED_SEARCH_LIMITS,
  FEDERATED_SEARCH_OUTPUT_SCHEMA,
  FEDERATED_SEARCH_PROVIDER_ID,
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

const SUBSCRIBABLE_LENSES = ["money", "people", "land", "property", "rules", "meetings"];

export const MCP_TOOLS = [
  {
    name: "search_federated",
    description: "Search the registered public CityScroll lenses in one bounded result set. Preserves per-lens coverage, source observations, exact object routes, and federated ranking; it does not expose a raw store or arbitrary query language.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, maxLength: FEDERATED_SEARCH_LIMITS.queryMaximumLength, description: "Resident search terms, up to 240 characters." },
        limit: { type: "integer", minimum: 1, maximum: FEDERATED_SEARCH_LIMITS.maximumResults, default: FEDERATED_SEARCH_LIMITS.defaultResults },
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
    description: "Traverse bounded, evidence-bearing public relationships from one exact canonical CityScroll entity. Only the closed node and edge vocabularies are returned.",
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
    description: "Retrieve source passages with stable citations and exact source joins. Returns source text only; it does not generate an answer or infer civic relationships.",
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

export const MCP_TOOL_BINDINGS = Object.freeze([
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

export const MCP_PUBLIC_CAPABILITY_TOOL_BINDINGS = Object.freeze(
  MCP_TOOL_BINDINGS.filter(({ capabilityReference, authorityClass }) => (
    capabilityReference && authorityClass === "public_read"
  )),
);
