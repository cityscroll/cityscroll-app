import { corsHeaders, isAllowedRequestOrigin } from "./lib/cors.mjs";
import { noticeSearchTerms, searchNotices } from "./lib/notices.mjs";
import { projectNoticeObjectTarget } from "../../site/notice_object_links.mjs";
import {
  SEARCH_DOCUMENT_SCHEMA,
  SEARCH_TEXT_MAX_LENGTH,
  admitSearchDocument,
} from "../../site/search_document_contract.mjs";

const MAX_QUERY_LENGTH = 240;
const RESULT_LIMIT = 40;

function cleanQuery(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

const TARGET_TYPES = Object.freeze({
  procurement: Object.freeze({ object_type: "procurement", domain: "contracts" }),
  contract: Object.freeze({ object_type: "procurement", domain: "contracts" }),
  meeting: Object.freeze({ object_type: "meeting", domain: "meetings" }),
  rulemaking: Object.freeze({ object_type: "rulemaking", domain: "rules" }),
  rule: Object.freeze({ object_type: "rulemaking", domain: "rules" }),
  zoning: Object.freeze({ object_type: "land_use_project", domain: "zoning" }),
  "land-use project": Object.freeze({ object_type: "land_use_project", domain: "zoning" }),
});

function compactText(values, max) {
  return values
    .map((value) => String(value ?? "").replace(/<[^>]*>/g, " "))
    .join(" ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function publicSearchResult(record) {
  const id = String(record?.request_id || "");
  const projection = projectNoticeObjectTarget({
    ...record,
    section_name: record?.section_name || record?.section,
    type_of_notice_description: record?.type_of_notice_description || record?.notice_type,
    description: record?.description || record?.snippet,
  });
  if (!projection.evidence) return null;

  const title = compactText([record?.title || record?.short_title || `Notice ${id}`], 500);
  const summary = compactText([
    record?.snippet,
    record?.description,
    record?.additional_description_1,
  ], 1_200) || null;
  const searchText = compactText([
    title,
    summary,
    record?.additional_description_2,
    record?.additional_description_3,
    record?.haystack,
  ], SEARCH_TEXT_MAX_LENGTH);
  const sourceRef = `notice:${id}`;
  const mapped = projection.state === "matched" ? TARGET_TYPES[projection.target?.kind] : null;
  const evidenceOnly = !mapped;
  const target = evidenceOnly ? projection.evidence : projection.target;
  const objectRef = evidenceOnly
    ? sourceRef
    : String(target.id).startsWith(`${mapped.object_type}:`)
      ? String(target.id)
      : `${mapped.object_type}:${target.id}`;
  const admitted = admitSearchDocument({
    schema: SEARCH_DOCUMENT_SCHEMA,
    object_ref: objectRef,
    object_type: evidenceOnly ? "unclassified" : mapped.object_type,
    domain: evidenceOnly ? null : mapped.domain,
    canonical_href: target.href,
    title,
    summary,
    search_text: searchText || title,
    source_family: "city_record_notice",
    source_observation_refs: [sourceRef],
    process_role: null,
    classification: {
      method: evidenceOnly ? "fail_closed" : "canonical_object_projection",
      basis: evidenceOnly
        ? "no_registered_object_mapping"
        : `${projection.schema}:${projection.target.kind}`,
    },
    provenance: {
      producer: "city_record_notice_search_projection.v1",
      evidence_hrefs: [projection.evidence.href],
    },
  }, { outcome: evidenceOnly ? "evidence_only" : "indexed" });
  if (!admitted.document) return null;
  return Object.freeze({
    ...admitted.document,
    outcome: admitted.outcome,
    coverage_state: "matched",
  });
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
