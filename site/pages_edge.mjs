import { BROWSE_FACETS, buildBrowseView, renderBrowseView } from "./browse_view.mjs";
import { renderMeetingOutcomesFirstPaint } from "./meeting_outcomes_static.mjs";
import { canonicalizeBrowseUrl } from "./route_migration.mjs";

const CITY_RECORD_SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
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

function browseFacet(pathname) {
  const match = pathname.match(/^\/browse(?:\/([^/]+))?\/?$/);
  if (!match) return null;
  const facet = match[1];
  if (!facet) return null;
  return Object.hasOwn(BROWSE_FACETS, facet) ? facet : null;
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
  const transformed = new HTMLRewriter()
    .on('link[rel="canonical"]', { element(element) { element.setAttribute("href", canonical); } })
    .on('meta[property="og:url"]', { element(element) { element.setAttribute("content", canonical); } })
    .transform(response);
  if (request.method === "HEAD") return new Response(null, { status: 200, headers: transformed.headers });
  return transformed;
}

export function renderEdgeNotice(row, id, meetingOutcome = null) {
  const title = row?.short_title || `City Record notice ${id}`;
  const agency = row?.agency_name || "Agency not listed";
  const source = `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(id)}`;
  if (!row) {
    return `<div class="panel route-item" tabindex="-1" data-edge-rendered="notice-unavailable">
      <p class="ftype">City Record notice</p><h2 class="rolename">Notice ${esc(id)}</h2>
      <p>The public record could not be loaded at this moment. The official source remains available.</p>
      <div class="actions"><a class="act" href="/browse/">Back to Browse</a><a class="act primary" href="${esc(source)}" target="_blank" rel="noopener noreferrer">View City Record</a></div>
    </div>`;
  }
  const facts = [
    ["Agency", agency], ["Published", row.start_date], ["Event", row.event_date],
    ["Responses due", row.due_date], ["PIN", row.pin], ["Category", row.category_description],
    ["Selection method", row.selection_method_description], ["Address", row.street_address_1],
  ].filter(([, value]) => value);
  return `<div style="max-width:880px;margin:0 auto" data-edge-rendered="notice" data-notice-id="${esc(id)}">
    <p style="margin:4px 0 12px"><a href="/browse/">Back to Browse</a></p>
    <article class="panel route-item" tabindex="-1">
      <p class="ftype">${esc(row.type_of_notice_description || "City Record notice")}${row.section_name ? ` · ${esc(row.section_name)}` : ""} · ${esc(agency)}</p>
      <h2 class="rolename" lang="en" dir="ltr">${esc(title)}</h2>
      <dl class="glance">${facts.map(([label, value]) => `<dt>${esc(label)}</dt><dd lang="en" dir="ltr">${esc(value)}</dd>`).join("")}</dl>
      ${row.additional_description_1 ? `<details class="scope"><summary>Notice text</summary><p lang="en" dir="ltr">${esc(row.additional_description_1)}</p></details>` : ""}
      ${renderMeetingOutcomesFirstPaint(meetingOutcome, id)}
      <div class="actions"><a class="act primary" href="${esc(source)}" target="_blank" rel="noopener noreferrer">View City Record</a></div>
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
  const title = row?.short_title || `City Record notice ${id}`;
  const canonical = `https://cityscroll.org/notices/${encodeURIComponent(id)}`;
  const response = rewrittenResponse(asset, status, "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400");
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

async function handleEntity(request, env, entity) {
  const asset = await staticAsset(env, request, "/");
  let id = entity.id;
  try { id = decodeURIComponent(entity.id); } catch (_error) { return new Response("Invalid entity id", { status: 400 }); }
  const canonical = `https://cityscroll.org/${entity.family}/${encodeURIComponent(id)}/`;
  const response = rewrittenResponse(asset, 200, "public, max-age=120, s-maxage=300, stale-while-revalidate=3600");
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
    const facet = browseFacet(url.pathname);
    if (facet) return handleBrowse(request, env, facet);
    const entity = entityDocument(url.pathname);
    if (entity) return handleEntity(request, env, entity);
    return env.ASSETS.fetch(request);
  },
};
