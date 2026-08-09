import { BROWSE_FACETS, buildBrowseView, renderBrowseView } from "./browse_view.mjs";
import { constellationLink, officialSourceLink } from "./affordance_grammar.mjs";
import { resolveAgencyIdentity } from "./agency_identity.mjs";
import { renderMeetingOutcomesFirstPaint } from "./meeting_outcomes_static.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";

const CITY_RECORD_SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const NOTICE_READ_MODEL = "https://api.cityscroll.org/notice";
const NOTICE_FIELDS = [
  "request_id", "start_date", "event_date", "due_date", "agency_name",
  "type_of_notice_description", "section_name", "short_title", "pin",
  "category_description", "selection_method_description", "street_address_1",
  "additional_description_1",
].join(",");

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function firstNoticeAttachmentUrl(row) {
  const value = row?.document_links;
  const candidate = Array.isArray(value) ? value[0] : value && typeof value === "object" ? (value.url || value.href || value.link) : value;
  if (!candidate) return null;
  try {
    const url = new URL(String(candidate).replaceAll("&amp;", "&"));
    const documentId = url.searchParams.get("documentId") || url.searchParams.get("DocumentID") || url.searchParams.get("documentid");
    if (url.protocol !== "https:" || url.hostname !== "a856-cityrecord.nyc.gov" || !/^\/Search\/GetFile$/i.test(url.pathname) || !documentId) return null;
    return url.href;
  } catch (_error) {
    return null;
  }
}

function safeId(pathname) {
  const match = pathname.match(/^\/notices\/([A-Za-z0-9_-]{1,80})\/?$/);
  return match ? match[1] : null;
}

function safeExamNumber(pathname) {
  const match = pathname.match(/^\/exams\/(\d{4})\/?$/);
  return match ? match[1] : null;
}

function safeMonitorPack(pathname) {
  const match = pathname.match(/^\/following\/packs\/([a-z0-9][a-z0-9-]{0,79})\/?$/);
  return match ? match[1] : null;
}

function safeDistrictDigest(pathname) {
  const match = pathname.match(/^\/districts\/council\/((?:[1-9]|[1-4]\d|5[01]))\/digest\/?$/);
  return match ? match[1] : null;
}

function safeParcel(pathname) {
  const match = pathname.match(/^\/parcels\/(\d{10})\/?$/);
  return match ? match[1] : null;
}

export function browseFacet(pathname) {
  const match = pathname.match(/^\/browse(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const facet = match[1];
  if (!facet) return null;
  return Object.hasOwn(BROWSE_FACETS, facet) ? facet : null;
}

export function browseRoute(pathname) {
  const match = String(pathname || "").match(/^\/browse(?:\/([^/]+))?\/?$/);
  if (!match) return { kind: "other", facet: null };
  if (!match[1]) return { kind: "landing", facet: null };
  const facet = browseFacet(pathname);
  return facet ? { kind: "facet", facet } : { kind: "unknown", facet: match[1] };
}

function entityDocument(pathname) {
  const match = pathname.match(/^\/(agencies|vendors|officials)\/([^/]{1,320})\/?$/);
  return match ? { family: match[1], id: match[2] } : null;
}

export function edgeRequestKind(urlValue) {
  const url = new URL(urlValue);
  if (safeId(url.pathname)) return "notice";
  if (safeExamNumber(url.pathname)) return "exam";
  if (safeMonitorPack(url.pathname)) return "monitor-pack";
  if (safeDistrictDigest(url.pathname)) return "district-digest";
  if (safeParcel(url.pathname)) return "parcel";
  if (browseFacet(url.pathname)) return "browse";
  if (entityDocument(url.pathname)) return "entity";
  return "asset";
}

const DOCUMENT_LANGS = new Set(["en", "es", "zh-Hans", "ru", "bn", "ht", "ko", "fr", "pl", "ar", "ur"]);

async function handleExam(request, env, examNumber) {
  const url = new URL(request.url);
  const asset = await staticAsset(env, request, `/exams/${examNumber}/`);
  if (!asset.ok) return asset;
  const language = DOCUMENT_LANGS.has(url.searchParams.get("lang")) && url.searchParams.get("lang") !== "en"
    ? url.searchParams.get("lang") : null;
  const canonical = `https://cityscroll.org/exams/${examNumber}/${language ? `?lang=${encodeURIComponent(language)}` : ""}`;
  const response = rewrittenResponse(asset, 200, "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400");
  const transformed = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: transformed.headers });
  return transformed;
}

async function handleComposedObject(request, env, pathname, canonicalPath) {
  const asset = await staticAsset(env, request, pathname);
  if (!asset.ok) return asset;
  const canonical = `https://cityscroll.org${canonicalPath}`;
  const response = rewrittenResponse(asset, 200, "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400");
  // Node unit tests do not provide the Workers HTMLRewriter runtime.
  if (typeof HTMLRewriter === "undefined") {
    return request.method === "HEAD"
      ? new Response(null, { status: 200, headers: response.headers })
      : response;
  }
  const transformed = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: transformed.headers });
  return transformed;
}

export function renderEdgeNotice(row, id, meetingOutcome = null) {
  const kind = row?.type_of_notice_description || row?.section_name || "Public record";
  const title = row?.short_title || (row ? `${kind} ${id}` : `CityScroll public record ${id}`);
  const agency = row?.agency_name || "Agency not listed";
  const source = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
  const browseLink = constellationLink({ href: "/browse/", label: "Browse public records", className: "act primary", escape: esc });
  const followingLink = constellationLink({ href: "/following/", label: "Follow public records", className: "act", escape: esc });
  const sourceLink = officialSourceLink({ href: source, label: "Official record", escape: esc });
  if (!row) {
    return `<div class="panel route-item" tabindex="-1" data-edge-rendered="notice-unavailable" data-notice-id="${esc(id)}">
      <p class="ftype">${esc(kind)}</p><h2 class="rolename">${esc(title)}</h2>
      <p>Continue with related public records or check the official record.</p>
      <div class="actions">${browseLink}${followingLink}</div>
      <p>${sourceLink}</p>
    </div>`;
  }
  const identity = resolveAgencyIdentity(agency);
  const agencyLink = identity.matched
    ? constellationLink({
      href: `/agencies/${encodeURIComponent(identity.canonical_id)}/`,
      label: agency,
      className: "notice-agency-link",
    })
    : esc(agency);
  const attachmentUrl = !row.additional_description_1 ? firstNoticeAttachmentUrl(row) : null;
  const facts = [
    ["Published", row.start_date], ["Event", row.event_date],
    ["Responses due", row.due_date], ["PIN", row.pin], ["Category", row.category_description],
    ["Selection method", row.selection_method_description], ["Address", row.street_address_1],
  ].filter(([, value]) => value);
  return `<div style="max-width:880px;margin:0 auto" data-edge-rendered="notice" data-notice-id="${esc(id)}">
    <p style="margin:4px 0 12px"><a href="/browse/">Back to Browse</a></p>
    <article class="panel route-item" tabindex="-1">
      <p class="ftype">${esc(kind)}${row.section_name && row.section_name !== kind ? ` · ${esc(row.section_name)}` : ""} · ${agencyLink}</p>
      <h2 class="rolename" lang="en" dir="ltr">${esc(title)}</h2>
      <dl class="glance"><dt>Agency</dt><dd lang="en" dir="ltr">${agencyLink}</dd>${facts.map(([label, value]) => `<dt>${esc(label)}</dt><dd lang="en" dir="ltr">${esc(value)}</dd>`).join("")}</dl>
      ${attachmentUrl ? `<p class="notice-attachment-fallback">The official notice content is in an attachment: <a href="${esc(attachmentUrl)}" target="_blank" rel="noopener noreferrer">Read the attachment</a>.</p>` : ""}
      ${row.additional_description_1 ? `<details class="scope"><summary>Notice text</summary><p lang="en" dir="ltr">${esc(row.additional_description_1)}</p></details>` : ""}
      ${renderMeetingOutcomesFirstPaint(meetingOutcome, id)}
      <div class="actions">${browseLink}${followingLink}</div>
      <p>${sourceLink}</p>
    </article>
  </div>`;
}

function assetRequest(request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return new Request(url, request);
}

async function staticAsset(env, request, pathname) {
  return env.ASSETS.fetch(assetRequest(request, pathname));
}

function rewrittenResponse(asset, status, cacheControl) {
  const headers = new Headers(asset.headers);
  headers.delete("Content-Length");
  headers.delete("ETag");
  headers.delete("Location");
  headers.set("Cache-Control", cacheControl);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(asset.body, { status, headers });
}

async function noticeRow(id) {
  // Ordinary document reads use the Worker/D1 projection. Socrata remains an exceptional
  // degradation path for an older id or an unavailable/partial mirror.
  try {
    const readModel = new URL(NOTICE_READ_MODEL);
    readModel.searchParams.set("id", id);
    const response = await fetch(readModel, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
    if (response.ok) {
      const payload = await response.json();
      return payload?.row || null;
    }
    if (response.status === 404) return null;
  } catch (_error) {
    // Fall through to the public-source degradation path.
  }
  const url = new URL(CITY_RECORD_SODA);
  url.searchParams.set("$select", NOTICE_FIELDS);
  url.searchParams.set("$where", `request_id='${id}'`);
  url.searchParams.set("$limit", "1");
  const response = await fetch(url, { headers: { Accept: "application/json" }, cf: { cacheTtl: 300, cacheEverything: true } });
  if (!response.ok) throw new Error(`City Record HTTP ${response.status}`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function handleNotice(request, env, id) {
  const [asset, meetingSnapshotResponse] = await Promise.all([
    staticAsset(env, request, "/"),
    staticAsset(env, request, "/data/meeting_outcomes_snapshot.json"),
  ]);
  let meetingOutcome = null;
  try {
    const snapshot = meetingSnapshotResponse.ok ? await meetingSnapshotResponse.json() : null;
    meetingOutcome = snapshot?.by_notice?.[id] || null;
  } catch (_error) {
    meetingOutcome = null;
  }
  let row = null;
  let upstreamFailed = false;
  try {
    row = await noticeRow(id);
  } catch (_error) {
    upstreamFailed = true;
  }
  const status = upstreamFailed ? 503 : row ? 200 : 404;
  const kind = row?.type_of_notice_description || row?.section_name || "Public record";
  const title = row?.short_title || (row ? `${kind} ${id}` : `CityScroll public record ${id}`);
  const canonical = `https://cityscroll.org/notices/${encodeURIComponent(id)}`;
  const cacheControl = status === 200
    ? "public, max-age=60, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800"
    : "public, max-age=60, s-maxage=60, stale-while-revalidate=60, stale-if-error=60";
  const response = rewrittenResponse(asset, status, cacheControl);
  const transformed = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(`${title} · CityScroll`); } })
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:title"]', { element(element) { element.setAttribute("content", `${title} · CityScroll`); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .on(".tabbtn.active", { element(element) { element.setAttribute("class", "tabbtn"); } })
    .on("section.tabpane.active", { element(element) { element.setAttribute("class", "tabpane"); } })
    .on("#tab-notice", { element(element) { element.setAttribute("class", "tabpane active"); } })
    .on("#noticeview", { element(element) { element.setInnerContent(renderEdgeNotice(row, id, meetingOutcome), { html: true }); } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status, headers: transformed.headers });
  return transformed;
}

function browseAssetPath(facet, pathname) {
  const requested = String(pathname || "").replace(/\/+$/, "");
  if (facet === "contracts" && requested === "/browse/contracts") return "/browse/contracts/";
  return facet === "contracts" ? "/browse/" : `/browse/${facet}/`;
}

function hasBrowseFilters(url) {
  return [...url.searchParams].some(([key]) => key !== "lang");
}

async function handleBrowse(request, env, facet) {
  const url = new URL(request.url);
  const canonical = canonicalizeBrowseUrl(url.href);
  if (canonical !== `${url.pathname}${url.search}`) {
    return Response.redirect(new URL(canonical, url.origin), 302);
  }
  const asset = await staticAsset(env, request, browseAssetPath(facet, url.pathname));
  if (!hasBrowseFilters(url) || request.method === "HEAD") return asset;
  try {
    const config = BROWSE_FACETS[facet];
    const dataResponse = await staticAsset(env, request, config.dataPath);
    if (!dataResponse.ok) return asset;
    const payload = await dataResponse.json();
    const view = buildBrowseView(facet, payload, url.searchParams);
    const response = rewrittenResponse(asset, 200, "public, max-age=120, s-maxage=300, stale-while-revalidate=3600");
    return new HTMLRewriter()
      .on(`#${config.container}`, { element(element) {
        element.setAttribute("data-edge-filtered", "true");
        element.setInnerContent(renderBrowseView(view), { html: true });
      } })
      .transform(response);
  } catch (_error) {
    return asset;
  }
}

function unavailableBrowseResponse(facet) {
  const canonical = facet === "land" ? "/browse/zoning/" : "/browse/";
  const label = facet === "land" ? "Land is now Browse → Zoning" : "That Browse section is unavailable";
  const linkLabel = canonical === "/browse/zoning/" ? "Open Zoning" : "Back to Browse";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${label} · CityScroll</title></head><body><main><h1>${label}</h1><p>Choose a current Browse section to continue.</p><p><a href="${canonical}">${linkLabel}</a></p></main></body></html>`;
  return new Response(body, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
  });
}

async function handleEntity(request, env, entity) {
  let id = entity.id;
  try { id = decodeURIComponent(entity.id); } catch (_error) { return new Response("Invalid entity id", { status: 400 }); }
  const url = new URL(request.url);
  const wantsInteractive = url.searchParams.has("tab");
  // Agency constellation documents are static-first (parcel-biography shape).
  // ?tab= keeps the interactive SPA profile for forecast/deep tabs. Only treat
  // a path hit as a constellation when the body is that document — ASSETS may
  // fall through to the SPA shell for unknown agency ids.
  if (entity.family === "agencies" && !wantsInteractive) {
    const documentPath = `/agencies/${encodeURIComponent(id)}/`;
    const document = await staticAsset(env, request, documentPath);
    if (document.ok) {
      const probe = await document.clone().text();
      if (probe.includes('data-civic-object-kind="agency-constellation"')) {
        // Preserve shareable as_of + claim query params on the composed document canonical.
        const params = new URLSearchParams();
        const asOf = String(url.searchParams.get("as_of") || "").trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(asOf)) params.set("as_of", asOf);
        const claim = String(url.searchParams.get("claim") || "").trim().slice(0, 200);
        if (claim) params.set("claim", claim);
        const query = params.toString();
        const canonicalPath = query ? `${documentPath}?${query}` : documentPath;
        return handleComposedObject(request, env, documentPath, canonicalPath);
      }
    }
  }
  const asset = await staticAsset(env, request, "/");
  if (!asset.ok) return asset;
  const canonical = `https://cityscroll.org/${entity.family}/${encodeURIComponent(id)}/`;
  const response = rewrittenResponse(asset, 200, "public, max-age=120, s-maxage=300, stale-while-revalidate=3600");
  // Node unit tests do not provide the Workers HTMLRewriter runtime. The route
  // contract is still testable there; production applies the metadata rewrite.
  if (typeof HTMLRewriter === "undefined") return request.method === "HEAD"
    ? new Response(null, { status: 200, headers: response.headers })
    : response;
  const transformed = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: transformed.headers });
  return transformed;
}

export default {
  async fetch(request, env) {
    if (!env?.ASSETS) return new Response("Static asset binding unavailable", { status: 503 });
    if (!['GET', 'HEAD'].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    const url = new URL(request.url);
    const id = safeId(url.pathname);
    if (id) return handleNotice(request, env, id);
    const examNumber = safeExamNumber(url.pathname);
    if (examNumber) return handleExam(request, env, examNumber);
    const pack = safeMonitorPack(url.pathname);
    if (pack) return handleComposedObject(request, env, `/following/packs/${pack}/`, `/following/packs/${pack}/`);
    const district = safeDistrictDigest(url.pathname);
    if (district) return handleComposedObject(request, env, `/districts/council/${district}/digest/`, `/districts/council/${district}/digest/`);
    const parcel = safeParcel(url.pathname);
    if (parcel) return handleComposedObject(request, env, `/parcels/${parcel}/`, `/parcels/${parcel}/`);
    const browse = browseRoute(url.pathname);
    if (browse.kind === "facet") return handleBrowse(request, env, browse.facet);
    if (browse.kind === "unknown") {
      if (browse.facet === "land") return Response.redirect(new URL("/browse/zoning/", request.url), 302);
      return unavailableBrowseResponse(browse.facet);
    }
    const entity = entityDocument(url.pathname);
    if (entity) return handleEntity(request, env, entity);
    return env.ASSETS.fetch(request);
  },
};
