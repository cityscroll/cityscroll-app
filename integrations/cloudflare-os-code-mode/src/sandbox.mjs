// Isolated typed Code Mode sandbox for the CS-08 measurement card.
//
// This module knows only the four named public-read methods. It has no model,
// store binding, credential, or network client. The measurement harness supplies
// an already-granted invoke function.

export const CODE_MODE_ADAPTER_ID = "cloudflare-os.typed-code-mode@1";
export const PINNED_PROGRAM_ID = "cs-08-entity-research-program-v1";
export const SANDBOX_SCHEMA = "cloudflare_os.typed_code_mode_sandbox.v1";

export const GRANTED_TOOL_NAMES = Object.freeze([
  "get_entity_dossier",
  "get_entity_relationships",
  "search_notices",
  "retrieve_cited_passages",
]);

export const PINNED_PROGRAM_SOURCE = `async () => {
  const entity = await codemode.get_entity_dossier({ entity_id });
  const relationships = await codemode.get_entity_relationships({
    entity_id,
    depth: 2,
    fan_out: 12,
  });
  const notices = await codemode.search_notices({
    query: noticeQuery,
    agency: "Department of Design and Construction",
    limit: 10,
  });
  const cited = await codemode.retrieve_cited_passages({
    query: citedQuery,
    source_family: "city_record_notice",
    limit: 10,
  });
  return { entity, relationships, notices, cited };
}`;

const GRANTED = new Set(GRANTED_TOOL_NAMES);

function clone(value) {
  return value === undefined ? value : structuredClone(value);
}

function assertResponse(response, name) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError(`${name} returned a non-object response`);
  }
  if (!response.structuredContent || typeof response.structuredContent !== "object") {
    throw new TypeError(`${name} did not return structured content`);
  }
}

/**
 * Granted-only invoker. Ungranted names, including write tools, fail closed
 * before any callTool dispatch.
 */
export function createGrantedInvoker(callTool, grant = GRANTED_TOOL_NAMES) {
  if (typeof callTool !== "function") throw new TypeError("callTool is required");
  const allowed = new Set(grant);
  return async function invokeGranted(name, args) {
    if (!allowed.has(name) || !GRANTED.has(name)) {
      const error = new Error(`Code Mode sandbox refused ungranted tool: ${name}`);
      error.failure_class = "ungranted_tool";
      throw error;
    }
    return callTool(name, args);
  };
}

/**
 * Pinned typed program for the same four-capability composition as CS-07.
 * There is no try/catch around capability calls: a provider failure fails closed.
 */
export async function executePinnedCodeModeProgram({
  callTool,
  entityId,
  noticeQuery,
  citedQuery,
}) {
  if (typeof entityId !== "string" || !entityId) throw new TypeError("entityId is required");
  if (typeof noticeQuery !== "string" || !noticeQuery) throw new TypeError("noticeQuery is required");
  if (typeof citedQuery !== "string" || !citedQuery) throw new TypeError("citedQuery is required");

  const invoke = createGrantedInvoker(callTool);
  const records = [];
  const steps = [
    ["get_entity_dossier", { entity_id: entityId }],
    ["get_entity_relationships", { entity_id: entityId, depth: 2, fan_out: 12 }],
    ["search_notices", {
      query: noticeQuery,
      agency: "Department of Design and Construction",
      limit: 10,
    }],
    ["retrieve_cited_passages", {
      query: citedQuery,
      source_family: "city_record_notice",
      limit: 10,
    }],
  ];
  for (const [name, args] of steps) {
    const response = await invoke(name, args);
    assertResponse(response, name);
    records.push({
      tool: name,
      arguments: clone(args),
      structured_content: clone(response.structuredContent),
    });
  }
  return {
    schema: SANDBOX_SCHEMA,
    adapter: CODE_MODE_ADAPTER_ID,
    program_id: PINNED_PROGRAM_ID,
    ambient_internet: false,
    records,
  };
}
