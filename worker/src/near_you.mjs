import boundaries from "./data/district_boundaries.json" with { type: "json" };
import communityGeography from "./data/community_board_geography_lookup.json" with { type: "json" };
import nta2020Layer from "./data/geography/layers/nta2020/26B.json" with { type: "json" };
import { scopeFromNearYouUrl } from "../../site/near_you_scope_runtime.mjs";
import { geographyNavigationUrlWithFilters } from "../../site/geography_navigation_state.mjs";
import { resolveGeographyEntryFromPlaceLabel } from "../../site/geography_navigation_entry.mjs";
import {
  buildNearYouViewModel,
  renderNearYouDeferredParts,
  renderNearYouDocument,
} from "../../site/near_you_view.mjs";
import { consultationMaterializationRecords } from "../../site/consultation_documents.mjs";
import { mergeConsultationActivity } from "../../site/consultation_place_time.mjs";
import { loadBroaderDistrictActivity, loadNearYouActivity, RouteReadModelUnavailable } from "./lib/route_read_model_kv.mjs";

function activityWithConsultations(activity) {
  if (!activity) return activity;
  return mergeConsultationActivity(activity, consultationMaterializationRecords());
}

function labelIndexFromLayerDoc(layerDoc) {
  const index = Object.create(null);
  for (const feature of layerDoc?.features || []) {
    if (!feature?.label) continue;
    if (feature.key) index[feature.key] = feature.label;
    if (feature.type && feature.id) {
      index[`${feature.type}:${feature.id}`] = feature.label;
      index[String(feature.id)] = feature.label;
    }
  }
  return index;
}

const NAVIGATION_LAYER_DOC = nta2020Layer;
const NAVIGATION_LABEL_INDEX = labelIndexFromLayerDoc(NAVIGATION_LAYER_DOC);

function nearYouGeographyOwnerOptions(url) {
  return {
    geographySearch: url.search,
    navigationLayerDoc: NAVIGATION_LAYER_DOC,
    navigationLayerType: "nta2020",
    geographyLabelIndex: NAVIGATION_LABEL_INDEX,
  };
}

const SITE_BASE = "https://cityscroll.org";
const CANONICAL_BASE = `${SITE_BASE}/near-you`;
const LEGACY_DOCUMENT_HOSTS = new Set(["api.cityscroll.org", "api.crol-list.org"]);

function responseHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=300, s-maxage=900, stale-while-revalidate=86400",
    // Basemap tiles are contextual decoration for the progressive Near You map.
    // Local boundary layers and controls remain usable when cartocdn is blocked.
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cityscroll.org; worker-src 'self' blob:; style-src 'self' https://cityscroll.org https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://*.basemaps.cartocdn.com; connect-src 'self' https://cityscroll.org https://*.basemaps.cartocdn.com; base-uri 'none'; frame-ancestors 'none'",
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
    const recoveryHref = `${CANONICAL_BASE}${url.search}`;
    if (deferred) {
      return new Response(JSON.stringify({
        ok: false,
        schema: "cityscroll.near_you_deferred_error.v1",
        reason: "near-you-read-model-unavailable",
        recovery_href: recoveryHref,
      }), {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const view = buildNearYouViewModel(scope, null, boundaries, {
      canonicalBase: CANONICAL_BASE,
      siteBase: SITE_BASE,
      dataState: "error",
      geometryState: "ready",
      recoveryHref,
      communityGeography,
      ...nearYouGeographyOwnerOptions(url),
    });
    return new Response(request.method === "HEAD" ? null : renderNearYouDocument(view, {
      canonicalBase: CANONICAL_BASE,
      assetPrefix: `${SITE_BASE}/`,
      deferredDataHref: `${CANONICAL_BASE}/deferred.json${url.search}`,
    }), {
      status: 503,
      headers: { ...responseHeaders(), "Cache-Control": "no-store" },
    });
  }
  if (scope.place.neighborhood && !scope.place.geographies?.length) {
    const layers = new Map();
    for (const definition of Object.values(routeReadModel.activity?.geography_items?.definitions || {})) {
      if (!layers.has(definition.type)) layers.set(definition.type, {type:definition.type, features:[]});
      layers.get(definition.type).features.push(definition);
    }
    const entry = resolveGeographyEntryFromPlaceLabel(scope.place.neighborhood, {layerData:[...layers.values()]});
    if (entry.ok && entry.selection) {
      const target = geographyNavigationUrlWithFilters({
        ...entry.selection, surface:"map", drawer:"open", lens:scope.facets.domains[0],
      }, {base:url.toString()});
      return new Response(null, {status:303, headers:{Location:target, "Cache-Control":"no-store"}});
    }
  }
  // Wider-district previews are optional enrichment: a load failure omits the
  // section and never interferes with the exact results below.
  let broaderDistricts = null;
  try {
    broaderDistricts = await loadBroaderDistrictActivity(
      env,
      scope.place.geographies?.[0] || null,
      scope.facets.domains[0] || "meetings",
    );
  } catch {
    broaderDistricts = null;
  }
  const view = buildNearYouViewModel(scope, activityWithConsultations(routeReadModel.activity), boundaries, {
    canonicalBase: CANONICAL_BASE,
    siteBase: SITE_BASE,
    broaderDistricts,
    communityGeography: routeReadModel.communityGeography?.public_edges?.length
      ? routeReadModel.communityGeography
      : communityGeography,
    ...nearYouGeographyOwnerOptions(url),
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
