// A 64 KiB tool result leaves room for evidence and an answer in a model's
// context. Reserve 8 KiB for the MCP text summary and transport envelope.
export const RESEARCH_RESPONSE_MAX_BYTES = 64 * 1024;
export const RESEARCH_STRUCTURED_MAX_BYTES = 56 * 1024;
export const RESEARCH_IDENTIFIER_SAMPLE_DEFAULT = 10;
export const RESEARCH_IDENTIFIER_SAMPLE_MAXIMUM = 50;

export function researchResponseBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

// Lists of identity/evidence keys are navigational data, not additional civic
// facts. Page those lists independently of result rows, retaining their field
// names for existing clients and giving research clients a count and replay.
export function pageResearchIdentifiers(result, { tool, arguments: args = {} }) {
  const offset = args.identifier_offset ?? 0;
  if (offset && !args.identifier_path) throw new TypeError("identifier_offset requires identifier_path from a continuation");
  const limit = args.identifier_limit ?? RESEARCH_IDENTIFIER_SAMPLE_DEFAULT;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > RESEARCH_IDENTIFIER_SAMPLE_MAXIMUM) throw new TypeError("identifier_offset must be non-negative and identifier_limit must be 1 through 50");
  const pages = [];
  let matchedPath = !args.identifier_path;
  function visit(value, path = "") {
    if (Array.isArray(value)) return value.map((child, index) => visit(child, `${path}/${index}`));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      const at = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      if (Array.isArray(child) && /(?:_ids|_refs|^epins)$/.test(key) && child.every((id) => id === null || typeof id === "string")) {
        const appliedOffset = args.identifier_path === at ? offset : 0;
        if (args.identifier_path === at) {
          matchedPath = true;
          if (appliedOffset >= child.length) throw new TypeError("identifier continuation is outside the current array; restart the read");
        }
        if (child.length > limit || appliedOffset > 0) {
          const sample = child.slice(appliedOffset, appliedOffset + limit);
          pages.push({ path: at, count: child.length, returned: sample.length, offset: appliedOffset,
            next: appliedOffset + limit < child.length ? { tool, arguments: { ...args, identifier_path: at, identifier_offset: appliedOffset + limit, identifier_limit: limit } } : null });
          return [key, sample];
        }
        return [key, child];
      }
      return [key, visit(child, at)];
    }));
  }
  const structuredContent = visit(result.structuredContent);
  if (!matchedPath) throw new TypeError("identifier continuation path is absent; restart the read");
  return pages.length ? { ...result, structuredContent,
    content: [...result.content, { type: "text", text: `Identifier arrays are samples. Counts and continuations (JSON Pointer paths): ${JSON.stringify(pages)}` }] } : result;
}

export function boundResearchToolResult(result, context) {
  const bounded = pageResearchIdentifiers(result, context);
  if (researchResponseBytes(bounded) <= RESEARCH_RESPONSE_MAX_BYTES) return bounded;
  // Never send an unusable tool payload or silently remove civic facts.
  return { isError: true, content: [{ type: "text", text: "This result exceeds the 64 KiB research response budget. Request a smaller page or narrower filters; use the public API for the complete record." }] };
}

/** A page limit is a ceiling. Shrink by bytes without losing the next row. */
export function fitResearchBrowsePage(result, cursorFor) {
  while (researchResponseBytes(result) > RESEARCH_STRUCTURED_MAX_BYTES && result.results.length > 1) {
    result.results.pop();
    result.pagination.returned = result.results.length;
    result.pagination.truncated = true;
    result.pagination.next_cursor = cursorFor(result.results.at(-1));
  }
  return result;
}
