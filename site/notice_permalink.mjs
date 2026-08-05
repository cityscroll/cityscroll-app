/** Canonical public document URLs for City Record notices. */

export function noticeDocumentPath(requestId) {
  const id = String(requestId == null ? "" : requestId).trim();
  return id ? `/notices/${encodeURIComponent(id)}` : null;
}

export function noticeDocumentUrl(requestId, siteBase = "https://cityscroll.org") {
  const path = noticeDocumentPath(requestId);
  if (!path) return null;
  return new URL(path, normalizeSiteBase(siteBase)).toString();
}

function normalizeSiteBase(siteBase) {
  const raw = String(siteBase || "https://cityscroll.org").trim();
  try {
    return new URL(raw).origin;
  } catch {
    return "https://cityscroll.org";
  }
}
