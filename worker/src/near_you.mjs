import activity from "./data/district_activity.json" with { type: "json" };
import boundaries from "./data/district_boundaries.json" with { type: "json" };
import { scopeFromNearYouUrl } from "../../site/near_you_scope.mjs";
import { buildNearYouViewModel, renderNearYouDocument } from "../../site/near_you_view.mjs";

const SITE_BASE = "https://cityscroll.org";
const EDGE_BASE = "https://api.cityscroll.org/near-you";

function responseHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cityscroll.org; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://cityscroll.org; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": SITE_BASE,
  };
}

export async function handleNearYou(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  if (url.pathname !== "/near-you" && url.pathname !== "/near-you/") {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "Content-Type": "text/plain", Allow: "GET, HEAD" },
    });
  }
  const edgeCache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (request.method === "GET" && edgeCache) {
    const cached = await edgeCache.match(cacheKey).catch(() => null);
    if (cached) return cached;
  }
  const scope = scopeFromNearYouUrl(url, { language: url.searchParams.get("lang") || "en" });
  const view = buildNearYouViewModel(scope, activity, boundaries, {
    canonicalBase: EDGE_BASE,
    siteBase: SITE_BASE,
  });
  const html = renderNearYouDocument(view, {
    canonicalBase: EDGE_BASE,
    assetPrefix: `${SITE_BASE}/`,
  });
  const response = new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: responseHeaders(),
  });
  if (request.method === "GET" && edgeCache) {
    const pending = edgeCache.put(cacheKey, response.clone()).catch(() => {});
    if (typeof ctx.waitUntil === "function") ctx.waitUntil(pending);
    else await pending;
  }
  return response;
}
