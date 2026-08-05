import templates from "../../site/data/watch_templates.json" with { type: "json" };
import { buildFollowingViewModel, renderFollowingDocument, watchFromFollowingParams } from "../../site/following_view.mjs";
import { compileSub } from "./lib/compile.mjs";
import { feedItems } from "./lib/feed.mjs";
import { sanitize } from "./lib/filter.mjs";
import { corsHeaders } from "./lib/cors.mjs";
import { emailFromRequest } from "./session.mjs";
import { listWatchesForEmail } from "./prefs.mjs";

const SITE_ORIGIN = "https://cityscroll.org";

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function publicHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=3600",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cityscroll.org; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://api.cityscroll.org; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Access-Control-Allow-Origin": SITE_ORIGIN,
  };
}

async function previewFor(watch, fetchImpl) {
  const query = compileSub(watch, new Date().toISOString().slice(0, 10));
  if (!query) return { items: [], error: "This scope cannot be previewed yet. You can still manage existing watches below." };
  try {
    const response = await fetchImpl(`${query.url}?${new URLSearchParams(query.params)}`);
    if (!response.ok) throw new Error(`open-data ${response.status}`);
    const payload = await response.json();
    let rows = query.transformRows ? query.transformRows(payload) : payload;
    if (!Array.isArray(rows)) rows = [];
    if (query.postFilter) rows = rows.filter(query.postFilter);
    return { items: feedItems(query.kind, rows).slice(0, 5), count: rows.length, error: null };
  } catch {
    return { items: [], error: "The public data source is unavailable right now. The saved criteria are still shown." };
  }
}

function personalHeaders(request, env) {
  const origin = request.headers.get("origin") || SITE_ORIGIN;
  return {
    ...corsHeaders(origin, env, { methods: "GET, OPTIONS", credentials: true }),
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Origin, Cookie",
  };
}

function personalHtml(watches) {
  if (!watches?.length) return `<p>Existing watches appear after CityScroll recognizes a link from one of your emails.</p><p><a href="https://api.cityscroll.org/prefs">Manage from a CityScroll email</a></p>`;
  const rows = watches.map((watch) => `<article data-watch-key="${esc(watch.key)}" data-watch-lens="${esc(watch.lens)}" data-watch-filter="${esc(JSON.stringify(watch.filter || {}))}"><h3>${esc(watch.query)}</h3><p class="watch-meta">${watch.paused ? "Paused" : "Active"} · ${esc(watch.freq)}</p></article>`).join("");
  return `${rows}<p><a href="https://api.cityscroll.org/prefs">Change cadence, pause, or unsubscribe</a></p>`;
}

async function handlePersonal(request, env) {
  const headers = personalHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD, OPTIONS" } });
  const email = await emailFromRequest(request, env);
  const watches = email ? await listWatchesForEmail(env, email) : [];
  return new Response(request.method === "HEAD" ? null : personalHtml(watches), { status: 200, headers });
}

export async function handleFollowing(request, env = {}, ctx = {}, options = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/following/personal") return handlePersonal(request, env);
  if (url.pathname !== "/following" && url.pathname !== "/following/") return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain", Allow: "GET, HEAD" } });

  const parsed = watchFromFollowingParams(url.searchParams);
  const watch = { lens: parsed.lens, filter: sanitize(parsed.lens, parsed.filter) };
  const preview = parsed.requested
    ? await previewFor(watch, options.fetchImpl || fetch)
    : { items: [], count: null, error: null };
  const view = buildFollowingViewModel({
    ...parsed,
    ...watch,
    matchCount: parsed.matchCount ?? preview.count,
    previewItems: preview.items,
    previewError: preview.error,
  }, templates);
  const html = renderFollowingDocument(view, { assetPrefix: `${SITE_ORIGIN}/`, siteBase: SITE_ORIGIN });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: publicHeaders() });
}
