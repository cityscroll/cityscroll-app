import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { noticeSearchTerms, searchNotices } from "./lib/notices.mjs";

const MAX_QUERY_LENGTH = 240;
const RESULT_LIMIT = 40;

function cleanQuery(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

export function searchResultType(record) {
  const section = String(record?.section || "");
  if (section === "Procurement") return "contracts";
  if (section === "Agency Rules") return "rules";
  if (section === "Public Hearings and Meetings") return "meetings";
  return "obligations";
}

export function publicSearchResult(record) {
  const id = String(record?.request_id || "");
  return {
    id,
    title: record?.title || `Notice ${id}`,
    type: searchResultType(record),
    snippet: record?.snippet || null,
    href: `/notices/${encodeURIComponent(id)}`,
  };
}

function json(body, status, cors, cacheControl = "no-store") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function handleSearch(request, env) {
  const origin = request.headers.get("origin") || "";
  const cors = corsHeaders(origin, env, {
    methods: "GET, OPTIONS",
    headers: "Accept, Content-Type",
  });
  if (!isAllowedRequestOrigin(origin, env)) return json({ ok: false, reason: "origin" }, 403, cors);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET") return json({ ok: false, reason: "method" }, 405, cors);

  const query = cleanQuery(new URL(request.url).searchParams.get("q"));
  if (!query) return json({ ok: false, reason: "missing-query" }, 400, cors);
  if (!env?.DB) return json({ ok: false, reason: "search-unavailable" }, 503, cors);

  try {
    const terms = noticeSearchTerms(query);
    const result = await searchNotices(env.DB, {
      termGroups: terms.length ? [terms] : [],
      limit: RESULT_LIMIT,
    });
    console.log("notice-search:", JSON.stringify({ route: "search", ...result.retrieval }));
    return json({ results: result.results.map(publicSearchResult) }, 200, cors, "public, max-age=60, stale-while-revalidate=300");
  } catch (error) {
    console.error("notice-search failed:", String(error?.message || error));
    return json({ ok: false, reason: "search-unavailable" }, 503, cors);
  }
}
