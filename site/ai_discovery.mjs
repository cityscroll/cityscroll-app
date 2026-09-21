/** Public, reader-facing entry points for using CityScroll with an assistant. */

export const AI_ENDPOINT = "https://api.cityscroll.org/mcp";

// This is deliberately a small projection, not a second capability registry.
// The MCP catalog and each existing UI owner remain authoritative for behavior.
export const CAPABILITY_DISCOVERY_MATRIX = Object.freeze([
  // [name, task, availability, render owner, disposition, placement]
  ["MCP", "Connect an assistant to public records", "available", "worker/src/mcp.mjs", "machine_connector", "introduction"],
  ["Follow", "Follow a search", "available", "site/app/feed-actions.mjs", "existing_control", "scope_tools"],
  ["Calendar", "Save dated events", "available when dated", "site/calendar_subscription.mjs", "conditional_control", "scope_tools"],
  ["Feeds", "Read a scoped feed", "available", "site/app/feed-actions.mjs", "existing_control", "scope_tools"],
  ["Saved searches", "Keep a search in this browser", "available", "site/app/search-share.mjs", "browser_local", "more_tools"],
  ["Collection/export", "Collect and export records", "available", "site/app/search-share.mjs", "browser_local", "more_tools"],
  ["Evidence", "Inspect source and connections", "available", "site/guide_contextual_links.mjs", "contextual_control", "more_tools"],
  ["As-of", "Read records as of a day", "available", "site/guide_contextual_links.mjs", "contextual_control", "more_tools"],
  ["Comparative analysis", "Compare supported contract measures", "available when supported", "capabilities/contracts_analysis.mjs", "machine_analysis", "more_tools"],
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

/** Routes retained by the assistant-setup capture harness, in census order. */
export const ASSISTANT_SETUP_CAPTURE_ROUTES = Object.freeze([
  { route: "/", source_path: "site/index.html" },
  { route: "/use-with-ai/", source_path: "site/use-with-ai/index.html" },
  { route: "/api.html#mcp", source_path: "site/api.html" },
]);

export const ASSISTANT_SETUP_VIEWPORTS = Object.freeze([
  { viewport: "1440x1000", width: 1440, height: 1000 },
  { viewport: "390x844", width: 390, height: 844 },
]);

function endpointValue(input) {
  if (!input) return "";
  if (typeof input.value === "string") return input.value;
  return String(input.getAttribute?.("value") ?? "");
}

/**
 * Copy the public MCP endpoint, falling back to focus+select when the clipboard
 * API is missing or rejects the write.
 */
export async function copyEndpointAddress(input, { writeText } = {}) {
  const text = endpointValue(input);
  const writer = writeText
    || globalThis.navigator?.clipboard?.writeText?.bind(globalThis.navigator.clipboard);
  try {
    if (typeof writer !== "function") throw new Error("clipboard unavailable");
    await writer(text);
    return "copied";
  } catch {
    if (typeof input?.focus === "function") input.focus();
    if (typeof input?.select === "function") input.select();
    return "fallback";
  }
}

export function installEndpointCopyControl(root, options = {}) {
  const button = root?.querySelector?.("[data-copy-endpoint]");
  if (!button) return null;
  const onClick = async () => {
    const input = root.querySelector("#mcp-endpoint");
    return copyEndpointAddress(input, options);
  };
  button.addEventListener("click", () => {
    void onClick();
  });
  return onClick;
}

export { esc as escapeAiDiscoveryHtml };
