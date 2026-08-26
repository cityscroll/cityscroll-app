import boundaries from "./data/district_boundaries.json" with { type: "json" };
import { scopeFromNearYouUrl } from "../../site/near_you_scope_runtime.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
  renderNearYouDocument,
} from "../../site/near_you_view.mjs";
import { loadNearYouActivity, RouteReadModelUnavailable } from "./lib/route_read_model_kv.mjs";

const SITE_BASE = "https://cityscroll.org";
const CANONICAL_BASE = `${SITE_BASE}/near-you`;
const LEGACY_DOCUMENT_HOSTS = new Set(["api.cityscroll.org", "api.crol-list.org"]);

function responseHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cityscroll.org; style-src 'self' https://cityscroll.org https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://cityscroll.org; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": SITE_BASE,
  };
}

function deferredResponseHeaders() {
  return {
    ...responseHeaders(),
    "Content-Type": "application/json; charset=utf-8",
  };
}

export async function handleNearYou(request, env = {}, ctx = {}) {
  const url = new URL(request.url);
  const deferred = url.pathname === "/near-you/deferred.json";
  if (!deferred && url.pathname !== "/near-you" && url.pathname !== "/near-you/") {
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { "Content-Type": "text/plain", Allow: "GET, HEAD" },
    });
  }
  if (LEGACY_DOCUMENT_HOSTS.has(url.hostname)) {
    return Response.redirect(`${CANONICAL_BASE}${deferred ? "/deferred.json" : ""}${url.search}`, 301);
  }
  const edgeCache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (request.method === "GET" && edgeCache) {
    const cached = await edgeCache.match(cacheKey).catch(() => null);
    if (cached) return cached;
  }
  const scope = scopeFromNearYouUrl(url, { language: url.searchParams.get("lang") || "en" });
  let routeReadModel;
  try {
    routeReadModel = await loadNearYouActivity(env, scope);
  } catch (error) {
    if (!(error instanceof RouteReadModelUnavailable)) throw error;
    return new Response(JSON.stringify({ ok: false, reason: "near-you-read-model-unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  const view = buildNearYouViewModel(scope, routeReadModel.activity, boundaries, {
    canonicalBase: CANONICAL_BASE,
    siteBase: SITE_BASE,
    communityGeography: routeReadModel.communityGeography,
  });
  const deferredParts = deferred ? renderNearYouDeferredParts(view) : null;
  const body = deferred
    ? JSON.stringify({
      schema: "cityscroll.near_you_deferred.v1",
      href: `${CANONICAL_BASE}/deferred.json${url.search}`,
      results_html: deferredParts.resultsHtml,
      bags_html: deferredParts.bagsHtml,
    })
    : renderNearYouDocument(view, {
      canonicalBase: CANONICAL_BASE,
      assetPrefix: `${SITE_BASE}/`,
      deferredDataHref: `${CANONICAL_BASE}/deferred.json${url.search}`,
    });
  const response = new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: deferred ? deferredResponseHeaders() : responseHeaders(),
  });
  if (request.method === "GET" && edgeCache) {
    const pending = edgeCache.put(cacheKey, response.clone()).catch(() => {});
    if (typeof ctx.waitUntil === "function") ctx.waitUntil(pending);
    else await pending;
  }
  return response;
}
