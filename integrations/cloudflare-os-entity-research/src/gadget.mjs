// Deterministic Cloudflare OS Gadget surface.
//
// This module deliberately knows only the named MCP methods granted to it. The
// Gatekeeper owns endpoint authentication and MCP transport; CityScroll owns
// every result contract, identity, provenance, and redaction rule.

export const GADGET_ADAPTER_ID = "cloudflare-os.entity-constellation-gadget@1";
export const GADGET_SCHEMA = "cloudflare_os.entity_research_workbook.v1";
export const REQUIRED_TOOL_GRANT = Object.freeze([
  Object.freeze({
    name: "get_entity_dossier",
    capability_reference: "entity.dossier.get@1",
    authority_class: "public_read",
  }),
  Object.freeze({
    name: "get_entity_relationships",
    capability_reference: "entity.relationships.get@1",
    authority_class: "public_read",
  }),
  Object.freeze({
    name: "search_notices",
    capability_reference: "notice.search@1",
    authority_class: "public_read",
  }),
  Object.freeze({
    name: "retrieve_cited_passages",
    capability_reference: "cited.passages.retrieve@1",
    authority_class: "public_read",
  }),
]);

const TOOL_NAMES = new Set(REQUIRED_TOOL_GRANT.map(({ name }) => name));

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

function callRecord(name, args, response) {
  return {
    tool: name,
    arguments: clone(args),
    structured_content: clone(response.structuredContent),
  };
}

/**
 * Run the frozen entity-research workflow through a Gatekeeper-provided
 * callTool function. No model, store binding, or direct HTTP client is needed
 * by the Gadget itself.
 */
export async function runEntityResearch({ callTool, entityId, noticeQuery, citedQuery }) {
  if (typeof callTool !== "function") throw new TypeError("callTool is required");
  if (typeof entityId !== "string" || !entityId) throw new TypeError("entityId is required");
  if (typeof noticeQuery !== "string" || !noticeQuery) throw new TypeError("noticeQuery is required");
  if (typeof citedQuery !== "string" || !citedQuery) throw new TypeError("citedQuery is required");

  const calls = [
    ["get_entity_dossier", { entity_id: entityId }],
    ["get_entity_relationships", { entity_id: entityId, depth: 2, fan_out: 12 }],
    ["search_notices", { query: noticeQuery, agency: "Department of Design and Construction", limit: 10 }],
    ["retrieve_cited_passages", { query: citedQuery, source_family: "city_record_notice", limit: 10 }],
  ];
  const records = [];
  for (const [name, args] of calls) {
    if (!TOOL_NAMES.has(name)) throw new Error(`workflow tool is outside the exact grant: ${name}`);
    const response = await callTool(name, args);
    assertResponse(response, name);
    records.push(callRecord(name, args, response));
  }
  return renderEvidenceWorkbook(records);
}

/**
 * Keep the presentation deterministic and evidence-bearing. The Gadget
 * preserves provider payloads; it does not derive identities, graph edges,
 * citations, confidence, or legal conclusions.
 */
export function renderEvidenceWorkbook(records) {
  if (!Array.isArray(records) || records.length !== REQUIRED_TOOL_GRANT.length) {
    throw new TypeError("entity research requires exactly four capability results");
  }
  const byTool = new Map(records.map((record) => [record.tool, record]));
  for (const { name } of REQUIRED_TOOL_GRANT) {
    if (!byTool.has(name)) throw new Error(`missing capability result: ${name}`);
  }
  return {
    schema: GADGET_SCHEMA,
    mode: "deterministic",
    model_enabled: false,
    groups: {
      entity: clone(byTool.get("get_entity_dossier").structured_content),
      relationships: clone(byTool.get("get_entity_relationships").structured_content),
      notices: clone(byTool.get("search_notices").structured_content),
      cited_evidence: clone(byTool.get("retrieve_cited_passages").structured_content),
    },
    calls: records.map(({ tool, arguments: args }) => ({ tool, arguments: clone(args) })),
  };
}
