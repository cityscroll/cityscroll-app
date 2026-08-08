import templates from "../../site/data/watch_templates.json" with { type: "json" };
import {
  buildFollowingViewModel,
  followingLensNeedsRedirect,
  renderFollowingDocument,
  watchFromFollowingParams,
} from "../../site/following_view.mjs";
import { compileSub } from "./lib/compile.mjs";
import { feedItems } from "./lib/feed.mjs";
import { resolveLens, sanitize } from "./lib/filter.mjs";
import { corsHeaders } from "./lib/cors.mjs";
import { emailFromRequest } from "./session.mjs";
import { issuePrefsCredential, listWatchesForEmail } from "./prefs.mjs";

const SITE_ORIGIN = "https://cityscroll.org";
const LEGACY_DOCUMENT_HOSTS = new Set(["api.cityscroll.org", "api.crol-list.org"]);

function esc(value) {
  return String(value ?? "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function publicHeaders() {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "public, max-age=120, s-maxage=300, stale-while-revalidate=3600",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cityscroll.org; style-src 'self' https://cityscroll.org https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://api.cityscroll.org; base-uri 'none'; frame-ancestors 'none'",
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

function hiddenCredential(token, watch) {
  return `<input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="key" value="${esc(watch.key)}">`;
}

function personalWatchHtml(watch, credential) {
  const action = watch.paused ? "unpause" : "pause";
  return `<article class="following-watch" data-watch-key="${esc(watch.key)}" data-watch-lens="${esc(watch.lens)}" data-watch-filter="${esc(JSON.stringify(watch.filter || {}))}">
    <div class="following-watch-heading"><h3>${esc(watch.query)}</h3><p class="watch-meta">${watch.paused ? "Paused" : "Active"}</p></div>
    <div class="following-watch-controls">
      <form method="post" action="${SITE_ORIGIN}/prefs" data-watch-action>
        ${hiddenCredential(credential, watch)}<input type="hidden" name="action" value="update">
        <label>Cadence<select name="freq"><option value="daily"${watch.freq === "daily" ? " selected" : ""}>Daily</option><option value="weekly"${watch.freq === "weekly" ? " selected" : ""}>Weekly</option></select></label>
        <button type="submit">Save cadence</button>
      </form>
      <form method="post" action="${SITE_ORIGIN}/prefs" data-watch-action>
        ${hiddenCredential(credential, watch)}<input type="hidden" name="action" value="${action}">
        <button type="submit">${watch.paused ? "Resume" : "Pause"}</button>
      </form>
      <form method="post" action="${SITE_ORIGIN}/prefs" data-watch-action data-confirm="Stop this watch?">
        ${hiddenCredential(credential, watch)}<input type="hidden" name="action" value="delete">
        <button type="submit" class="following-watch-remove">Unsubscribe</button>
      </form>
    </div>
  </article>`;
}

function personalHtml(watches, credential, recognized) {
  if (!recognized) {
    return `<div data-session-recognized="false"><p>Open a CityScroll email to see your watches.</p></div>`;
  }
  if (!watches?.length) return `<div data-session-recognized="true"><p>No saved watches yet.</p></div>`;
  return `<div data-session-recognized="true">${watches.map((watch) => personalWatchHtml(watch, credential)).join("")}</div>`;
}

async function handlePersonal(request, env) {
  const headers = personalHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD, OPTIONS" } });
  const email = await emailFromRequest(request, env);
  const watches = email ? await listWatchesForEmail(env, email) : [];
  const credential = email ? await issuePrefsCredential(env, email) : null;
  return new Response(request.method === "HEAD" ? null : personalHtml(watches, credential, !!email), { status: 200, headers });
}

export async function handleFollowing(request, env = {}, ctx = {}, options = {}) {
  const url = new URL(request.url);
  if (url.pathname === "/following/personal") return handlePersonal(request, env);
  if (url.pathname !== "/following" && url.pathname !== "/following/") return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { "Content-Type": "text/plain", Allow: "GET, HEAD" } });
  if (LEGACY_DOCUMENT_HOSTS.has(url.hostname)) {
    return Response.redirect(`${SITE_ORIGIN}${url.pathname}${url.search}`, 301);
  }

  // Product lens is mandates; obligations is a legacy alias that must still resolve.
  const rawLens = url.searchParams.get("lens");
  if (followingLensNeedsRedirect(rawLens)) {
    const next = new URL(url);
    next.searchParams.set("lens", resolveLens(rawLens));
    return Response.redirect(next.toString(), 302);
  }

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
