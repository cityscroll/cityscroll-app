const PORTAL_ORIGIN = "https://a856-cityrecord.nyc.gov";

function decodeHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function documentId(url) {
  return url.searchParams.get("documentId")
    || url.searchParams.get("DocumentID")
    || url.searchParams.get("documentid")
    || null;
}

export function normalizeGetFileUrl(value) {
  let url;
  try { url = new URL(decodeHtml(value), PORTAL_ORIGIN); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "a856-cityrecord.nyc.gov") return null;
  if (!/^\/Search\/GetFile$/i.test(url.pathname) || !documentId(url)) return null;
  return url;
}

export function parsePortalAttachments(html, requestId) {
  const found = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']*\/Search\/GetFile\?[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchor)) {
    const url = normalizeGetFileUrl(match[2]);
    if (!url) continue;
    const id = documentId(url);
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({
      request_id: String(requestId),
      document_id: id,
      title: decodeHtml(match[3]) || null,
      url: url.href,
      content_type: null,
      bytes: null,
      source: "portal",
    });
  }
  return found;
}

function flattenDatasetLinks(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenDatasetLinks);
  if (typeof value === "object") return flattenDatasetLinks(value.url || value.href || value.link);
  const text = String(value).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (parsed !== text) return flattenDatasetLinks(parsed);
  } catch { /* Socrata URL columns are commonly plain strings. */ }
  return text.split(/\s*[|,]\s*(?=https?:\/\/)/).filter(Boolean);
}

export function parseDatasetAttachments(row) {
  const requestId = String(row?.request_id || "");
  const out = [];
  const seen = new Set();
  for (const value of flattenDatasetLinks(row?.document_links)) {
    const url = normalizeGetFileUrl(value);
    if (!url) continue;
    const id = documentId(url);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      request_id: requestId,
      document_id: id,
      title: null,
      url: url.href,
      content_type: null,
      bytes: null,
      source: "dataset",
    });
  }
  return out;
}

export function mergeAttachmentSources(dataset, portal) {
  const byId = new Map();
  for (const item of [...dataset, ...portal]) {
    const current = byId.get(item.document_id);
    if (!current || item.source === "portal") byId.set(item.document_id, item);
  }
  return [...byId.values()];
}

export function shouldScrapePortal(row, { historicalTitles = false } = {}) {
  if (String(row?.section_name || "").trim() === "Changes in Personnel") return false;
  const date = String(row?.start_date || "").slice(0, 10);
  return date >= "2025-01-01" || historicalTitles;
}
