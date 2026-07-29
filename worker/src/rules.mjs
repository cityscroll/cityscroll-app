// Daily materialized rule view.
// Joins City Record Agency Rules notices to NYC Rules RSS items, linking to official
// comment/adoption pages without copying comment content. City Record stays the
// authoritative discovery layer; NYC Rules provides lifecycle enrichment.

import {
  classifyStage,
  joinRulesToNotices,
  normalizeRuleItem,
  parseRssItems,
} from "./lib/rules.mjs";

export const RULES_KV_KEY = "rules:materialized:v1";
const RULES_RSS_URL = "https://rules.cityofnewyork.us/feed/";
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
const RSS_MAX_AGE_DAYS = 14;
const RULE_LIMIT = 500;

const CR_SELECT = [
  "request_id", "start_date", "agency_name", "type_of_notice_description",
  "section_name", "short_title", "additional_description_1", "additional_description_2",
  "additional_description_3",
].join(",");

async function fetchRulesRss(fetchImpl) {
  const response = await fetchImpl(RULES_RSS_URL);
  if (!response.ok) throw new Error(`NYC Rules RSS ${response.status}`);
  const xml = await response.text();
  return parseRssItems(xml).map(normalizeRuleItem);
}

async function fetchCityRecordRules(fetchImpl, now) {
  const since = new Date(now.getTime() - RSS_MAX_AGE_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const params = new URLSearchParams({
    $select: CR_SELECT,
    $where: `section_name='Agency Rules' AND start_date >= '${since}T00:00:00'`,
    $order: "start_date DESC",
    $limit: String(RULE_LIMIT),
  });
  const response = await fetchImpl(`${SODA}?${params}`);
  if (!response.ok) throw new Error(`City Record rules SODA ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("City Record rules SODA returned a non-array response");
  return rows;
}

export async function buildRuleView(fetchImpl = fetch, now = new Date()) {
  let rssStatus = "ok";
  let rssError = null;
  let rules = [];
  try {
    rules = await fetchRulesRss(fetchImpl);
  } catch (e) {
    rssStatus = "stale";
    rssError = String(e?.message || e);
  }

  const notices = await fetchCityRecordRules(fetchImpl, now);
  const { matched, unmatchedNotices, unmatchedRules } = joinRulesToNotices(rules, notices, now);

  const byStage = {};
  for (const m of matched) {
    byStage[m.stage] = (byStage[m.stage] || 0) + 1;
  }
  for (const u of unmatchedRules) {
    byStage[u.stage] = (byStage[u.stage] || 0) + 1;
  }

  const records = [
    ...matched.map((m) => ({
      request_id: m.city_record.request_id,
      agency: m.city_record.agency_name,
      title: m.city_record.short_title || m.rule.title,
      notice_date: m.city_record.start_date,
      stage: m.stage,
      city_record: {
        request_id: m.city_record.request_id,
        agency: m.city_record.agency_name,
        title: m.city_record.short_title,
        notice_date: m.city_record.start_date,
        notice_type: m.city_record.type_of_notice_description,
      },
      nyc_rules: {
        url: m.rule.url,
        title: m.rule.title,
        agency_abbr: m.rule.agency_abbr,
        agency_name: m.rule.agency_name,
        adoption_date: m.rule.adoption_date,
        comment_by_date: m.rule.comment_by_date,
        hearing_date: m.rule.hearing_date,
        comment_url: m.rule.comment_url,
        comment_count: m.rule.comment_count,
        summary: m.rule.summary,
      },
      join: {
        matched: true,
        confidence: m.join.confidence,
        basis: m.join.basis,
      },
    })),
    ...unmatchedNotices.map((notice) => ({
      request_id: notice.request_id,
      agency: notice.agency_name,
      title: notice.short_title,
      notice_date: notice.start_date,
      stage: "proposed",
      city_record: {
        request_id: notice.request_id,
        agency: notice.agency_name,
        title: notice.short_title,
        notice_date: notice.start_date,
        notice_type: notice.type_of_notice_description,
      },
      nyc_rules: null,
      join: {
        matched: false,
        reason: "No NYC Rules entry found for this agency and notice",
      },
    })),
    ...unmatchedRules.map(({ rule, stage }) => ({
      request_id: null,
      agency: rule.agency_name || rule.agency_full || rule.agency_abbr,
      title: rule.title,
      notice_date: rule.pub_date,
      stage,
      city_record: null,
      nyc_rules: {
        url: rule.url,
        title: rule.title,
        agency_abbr: rule.agency_abbr,
        agency_name: rule.agency_name,
        adoption_date: rule.adoption_date,
        comment_by_date: rule.comment_by_date,
        hearing_date: rule.hearing_date,
        comment_url: rule.comment_url,
        comment_count: rule.comment_count,
        summary: rule.summary,
      },
      join: {
        matched: false,
        reason: "No matching City Record Agency Rules notice within the look-back window",
      },
    })),
  ];

  const counts = {
    total: records.length,
    matched: matched.length,
    unmatched_notices: unmatchedNotices.length,
    unmatched_rules: unmatchedRules.length,
    by_stage: byStage,
  };

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    source: {
      primary: {
        name: "City Record Online",
        dataset: "dg92-zbpx",
        url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
      },
      enrichment: {
        name: "NYC Rules",
        feed: RULES_RSS_URL,
        status: rssStatus,
        ...(rssError ? { error: rssError } : {}),
      },
    },
    counts,
    rules: records,
  };
}

export async function refreshRules(env, fetchImpl = fetch, now = new Date()) {
  if (!env.ALERT_STATE) return { status: "skipped", reason: "no-kv" };
  const view = await buildRuleView(fetchImpl, now);
  await env.ALERT_STATE.put(RULES_KV_KEY, JSON.stringify(view), {
    expirationTtl: 3 * 24 * 60 * 60,
  });
  return { status: "success", ...view.counts };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 ? "public, max-age=1800" : "no-store",
    },
  });
}

export async function handleRules(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return jsonResponse(JSON.stringify({ ok: false, reason: "method" }), 405);
  if (!env.ALERT_STATE) return jsonResponse(JSON.stringify({ ok: false, reason: "not-configured" }), 503);

  let raw = await env.ALERT_STATE.get(RULES_KV_KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  const age = parsed?.generated_at ? Date.now() - new Date(parsed.generated_at).getTime() : Infinity;

  if (!parsed || age > MAX_AGE_MS) {
    try {
      const view = await buildRuleView(fetch, new Date());
      raw = JSON.stringify(view);
      const write = env.ALERT_STATE.put(RULES_KV_KEY, raw, { expirationTtl: 3 * 24 * 60 * 60 });
      if (ctx?.waitUntil) ctx.waitUntil(write); else await write;
    } catch (error) {
      if (!parsed) {
        return jsonResponse(JSON.stringify({ ok: false, reason: "upstream", detail: String(error?.message || error) }), 502);
      }
      raw = JSON.stringify(parsed);
    }
  }
  return jsonResponse(raw);
}
