// Runtime-safe MCP declarations shared by the Worker adapter and build-time catalog.
// Keep this module free of request handling and optional Worker-only dependencies so
// topology tests can inspect the public tool contract in the site Unit family.

import {
  NOTICE_SEARCH_CAPABILITY_REFERENCE,
  NOTICE_SEARCH_LIMITS,
  NOTICE_SEARCH_PROVIDER_ID,
} from "./notice_search.mjs";
import { CITED_RETRIEVAL_OUTPUT_SCHEMA } from "../worker/src/cited_retrieval.mjs";
import { SEMANTIC_SOURCE_FAMILIES } from "../worker/src/semantic_candidates.mjs";

export const MCP_NOTICE_SEARCH_DEFAULT_LIMIT = 15;

export const MCP_NOTICE_SEARCH_ADAPTER = Object.freeze({
  id: "mcp.search_notices@1",
  capabilityReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
  providerId: NOTICE_SEARCH_PROVIDER_ID,
  route: "POST /mcp",
  tool: "search_notices",
  surface: "MCP",
});

const SUBSCRIBABLE_LENSES = ["money", "people", "land", "property", "rules", "meetings"];

export const MCP_TOOLS = [
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
  },
  {
    name: "get_notice",
    description: "Full detail for one City Record notice by its RequestID.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { request_id: { type: "string" } },
      required: ["request_id"],
    },
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
  },
];

export const MCP_TOOL_BINDINGS = Object.freeze([
  Object.freeze({
    name: "search_notices",
    operationClass: "read",
    schemaReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
    capabilityReference: NOTICE_SEARCH_CAPABILITY_REFERENCE,
    adapterId: MCP_NOTICE_SEARCH_ADAPTER.id,
  }),
  Object.freeze({
    name: "get_notice",
    operationClass: "read",
    schemaReference: "mcp.get_notice.inline@1",
    pilotException: "notice.get is outside the notice.search@1 pilot",
  }),
  Object.freeze({
    name: "retrieve_cited_passages",
    operationClass: "read",
    schemaReference: "cityscroll.semantic_retrieval.cited_passage_response.v1",
    contractReference: "cityscroll.semantic_retrieval.cited_passage_response.v1",
  }),
  Object.freeze({
    name: "preview_watch",
    operationClass: "read",
    schemaReference: "mcp.preview_watch.inline@1",
    pilotException: "watch.preview is outside the notice.search@1 pilot",
  }),
  Object.freeze({
    name: "create_watch",
    operationClass: "mutation",
    schemaReference: "mcp.create_watch.inline@1",
    pilotException: "watch.create is an explicit mutation outside the notice.search@1 pilot",
  }),
]);
