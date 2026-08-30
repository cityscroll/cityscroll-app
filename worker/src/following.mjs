import suggestedTemplates from "../../site/data/following_procurement_suggestions.json" with { type: "json" };
import {
  followingCadenceLabel,
  buildFollowingViewModel,
  followingLensNeedsRedirect,
  renderFollowingDocument,
  buildFollowingGraphContext,
  followingWatchScopeLinksHtml,
  watchFromFollowingParams,
} from "../../site/following_view.mjs";
import { compileSub, rowsForCompiledQuery } from "./lib/compile.mjs";
import { feedItems } from "./lib/feed.mjs";
import { resolveLens, sanitize } from "./lib/filter.mjs";
import { corsHeaders } from "./lib/cors.mjs";
import { emailFromRequest } from "./session.mjs";
import { issuePrefsCredential, listWatchesForEmail } from "./prefs.mjs";
import { followingPersonalIslandHtml } from "../../site/following_personal_state.mjs";

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

async function previewFor(watch, fetchImpl, todayISO = new Date().toISOString().slice(0, 10), env = {}) {
  const query = compileSub(watch, todayISO);
  if (!query) return { items: [], error: "This scope cannot be previewed yet. You can still manage existing watches below." };
  try {
    let rows = await rowsForCompiledQuery(query, env, fetchImpl);
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

function watchFacts(context) {
  const rows = [
    ["Topic", context.topicLabel || context.lens || "Contracts"],
    ["Place", context.placeLabel || "Citywide"],
    ["Community Board", context.communityBoardLabel || null],
    ["Keyword", context.keywordLabel || null],
    ["Agency", context.agencyLabel || null],
    ["District", context.districtLabel || null],
  ].filter(([, value]) => value);
  if (!rows.length) return "";
  return `<details class="following-watch-facts">
      <summary>Technical details</summary>
      <dl class="following-watch-fact-list">
        ${rows.map(([term, value]) => `<div class="following-watch-fact"><dt>${esc(term)}</dt><dd>${esc(value)}</dd></div>`).join("")}
      </dl>
    </details>`;
}

function personalWatchHtml(watch, credential) {
  const action = watch.paused ? "unpause" : "pause";
  const context = buildFollowingGraphContext(watch, { backToEntity: true });
  const summary = context.ruleSentence || watch.query || "Custom watch";
  const status = watch.paused ? "Paused" : "Active";
  const cadenceLabel = followingCadenceLabel(watch.freq || watch.frequency);
  return `<article class="following-watch" data-watch-key="${esc(watch.key)}" data-watch-lens="${esc(watch.lens)}" data-watch-filter="${esc(JSON.stringify(watch.filter || {}))}">
    <div class="following-watch-heading">
      <h3>${esc(summary)}</h3>
      <p class="watch-meta">${status} · ${esc(cadenceLabel)}</p>
    </div>
    <div class="following-watch-actions">
      ${context.currentMatchesHref ? `<a class="following-current-matches" href="${esc(context.currentMatchesHref)}">See current matches</a>` : ""}
      ${followingWatchScopeLinksHtml(context, { entityClass: "following-watch-entity" })}
    </div>
    ${watchFacts(context)}
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
  if (!recognized) return followingPersonalIslandHtml("unrecognized");
  if (!watches?.length) return followingPersonalIslandHtml("empty");
  return `<div data-session-recognized="true" data-personal-state="recognized">${watches.map((watch) => personalWatchHtml(watch, credential)).join("")}</div>`;
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
  if (parsed.scopeStatus === "unrecognized_scope") {
    const view = buildFollowingViewModel({
      ...parsed,
      previewItems: [],
      previewError: null,
    }, suggestedTemplates);
    const html = renderFollowingDocument(view, { assetPrefix: `${SITE_ORIGIN}/`, siteBase: SITE_ORIGIN });
    return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: publicHeaders() });
  }
  const watch = { lens: parsed.lens, filter: sanitize(parsed.lens, parsed.filter) };
  const preview = parsed.requested
    ? await previewFor(watch, options.fetchImpl || fetch, options.todayISO, env)
    : { items: [], count: null, error: null };
  const view = buildFollowingViewModel({
    ...parsed,
    ...watch,
    matchCount: parsed.matchCount ?? preview.count,
    previewItems: preview.items,
    previewError: preview.error,
  }, suggestedTemplates);
  const html = renderFollowingDocument(view, { assetPrefix: `${SITE_ORIGIN}/`, siteBase: SITE_ORIGIN });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers: publicHeaders() });
}
