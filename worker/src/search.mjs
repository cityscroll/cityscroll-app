import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { noticeSearchTerms, searchNotices } from "./lib/notices.mjs";
import rulesDomainObservations from "../../site/data/rules_domain_observations.json" with { type: "json" };
import {
  buildCityRecordRuleProjectionIndex,
  materializeCityRecordSearchDocument,
} from "../../site/city_record_search_producers.mjs";

const MAX_QUERY_LENGTH = 240;
const RESULT_LIMIT = 40;

function cleanQuery(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

const RULE_PROJECTION_INDEX = buildCityRecordRuleProjectionIndex(rulesDomainObservations);

export function publicSearchResult(record, { ruleIndex = RULE_PROJECTION_INDEX } = {}) {
  return materializeCityRecordSearchDocument({
    ...record,
    section_name: record?.section_name || record?.section,
    type_of_notice_description: record?.type_of_notice_description || record?.notice_type,
    description: record?.description || record?.snippet,
  }, { ruleIndex });
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
    return json({ results: result.results.map(publicSearchResult).filter(Boolean) }, 200, cors, "public, max-age=60, stale-while-revalidate=300");
  } catch (error) {
    console.error("notice-search failed:", String(error?.message || error));
    return json({ ok: false, reason: "search-unavailable" }, 503, cors);
  }
}
