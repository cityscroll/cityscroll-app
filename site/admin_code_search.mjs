/** Data-free citation and bounded search primitives for the Admin Code. */

function clean(value, max = 240) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Accept the common resident citation forms without minting an identity. */
export function normalizeAdminCodeCitation(value) {
  const normalized = clean(value).normalize("NFKC")
    .replace(/[§]/g, " ")
    .replace(/\b(?:NYC|NEW\s+YORK\s+CITY)\s+(?:ADMIN(?:ISTRATIVE)?\s+)?CODE\b/giu, " ")
    .replace(/\bADMIN(?:ISTRATIVE)?\s+CODE\b/giu, " ")
    .replace(/\b(?:SECTION|SEC\.?|S\.)\b/giu, " ")
    .replace(/[(),:]/g, " ")
    .replace(/\b(\d+)\s+([A-Z]?\d)/gi, "$1-$2")
    .trim();
  const match = normalized.match(/^(\d+[A-Z]?-[0-9A-Z]+(?:\.[0-9A-Z]+)*)$/i);
  return match ? match[1].toLowerCase() : null;
}

export function adminCodeProvisionId(value) {
  const citation = normalizeAdminCodeCitation(value);
  return citation ? `nyc-administrative-code:${citation}` : null;
}

export function adminCodeHref(value) {
  const citation = normalizeAdminCodeCitation(value) || String(value || "").replace(/^nyc-admin-code:/i, "");
  return `/administrative-code/${encodeURIComponent(citation)}/`;
}

export function adminCodeSearchDocuments(index) {
  return Array.isArray(index?.documents) ? index.documents : [];
}

export function searchAdminCodeDocuments(query, { limit = 8, index } = {}) {
  const normalized = clean(query).toLocaleLowerCase("en-US");
  if (!normalized) return [];
  const citation = normalizeAdminCodeCitation(query);
  const documents = adminCodeSearchDocuments(index);
  const matches = documents.filter((document) => {
    if (citation && document.object_ref === `nyc-administrative-code:${citation}`) return true;
    const terms = normalized.split(/\s+/).filter(Boolean).map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const haystack = document.search_text.toLocaleLowerCase("en-US");
    return terms.every((term) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${term}(?=$|[^\\p{L}\\p{N}])`, "u").test(haystack));
  });
  return matches.slice(0, Math.max(0, Math.min(100, Number(limit) || 0)));
}
