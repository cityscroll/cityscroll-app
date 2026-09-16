/** Public, reader-facing entry points for using CityScroll with an assistant. */

export const AI_ENDPOINT = "https://api.cityscroll.org/mcp";

// This is deliberately a small projection, not a second capability registry.
// The MCP catalog and each existing UI owner remain authoritative for behavior.
export const CAPABILITY_DISCOVERY_MATRIX = Object.freeze([
  ["MCP", "Connect an assistant to public records", "available", "worker/src/mcp.mjs"],
  ["Follow", "Follow a search", "available", "site/app/feed-actions.mjs"],
  ["Calendar", "Save dated events", "available when dated", "site/calendar_subscription.mjs"],
  ["Feeds", "Read a scoped feed", "available", "site/app/feed-actions.mjs"],
  ["Saved searches", "Keep a search in this browser", "available", "site/app/search-share.mjs"],
  ["Collection/export", "Collect and export records", "available", "site/app/search-share.mjs"],
  ["Evidence", "Inspect source and connections", "available", "site/guide_contextual_links.mjs"],
  ["As-of", "Read records as of a day", "available", "site/guide_contextual_links.mjs"],
  ["Comparative analysis", "Compare supported contract measures", "available when supported", "capabilities/contracts_analysis.mjs"],
]);

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

export function renderAskWithAiLink({ href = "/use-with-ai/", translate = value => value, className = "" } = {}) {
  // Translation catalogs may intentionally omit newly introduced optional copy.
  // Keep the navigation link present in the source language rather than making
  // a missing optional string break an otherwise complete translated page.
  let label = "Ask with AI";
  try { label = translate("Ask with AI") || label; } catch { /* use English fallback */ }
  return `<a class="${esc(className || "ask-with-ai-link")}" href="${esc(href)}">${esc(label)}</a>`;
}

export function renderEndpointControl({ endpoint = AI_ENDPOINT } = {}) {
  return `<label for="mcp-endpoint">MCP server address</label><input id="mcp-endpoint" class="endpoint" type="text" value="${esc(endpoint)}" readonly aria-describedby="mcp-endpoint-help"><button type="button" data-copy-endpoint>Copy address</button><p id="mcp-endpoint-help" class="note">This public endpoint accepts tools-only MCP requests with POST. Opening it in a browser shows connection recovery guidance.</p>`;
}

export { esc as escapeAiDiscoveryHtml };
