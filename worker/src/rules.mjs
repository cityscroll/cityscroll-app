// Daily materialized rule view.
// Joins City Record Agency Rules notices to NYC Rules RSS items, linking to official
// comment/adoption pages without copying comment content. City Record stays the
// authoritative discovery layer; NYC Rules provides lifecycle enrichment.

import {
  attachCityRecordPublicHearingEvents,
  attachRulemakingSiblings,
  classifyStage,
  deriveRuleEvents,
  joinRulesToNotices,
  normalizeRuleItem,
  parseRssItems,
} from "./lib/rules.mjs";
import { linksFromRuleRecord } from "./lib/subject_registry.mjs";

export const RULES_KV_KEY = "rules:materialized:v2";
/** Bump when rulemaking stitch / multi-notice fields change so young-but-stale KV rebuilds.
 *  v4: City Record Agency Rules lookback widened so multi-notice siblings co-appear. */
export const RULES_VIEW_VERSION = 4;
export const RULES_RSS_URL = "https://rules.cityofnewyork.us/feed/";
/** Identifying UA — Cloudflare on rules.cityofnewyork.us returns HTTP 403
 *  "Just a moment…" when the request has an empty or missing User-Agent
 *  (Workers edge subrequests send none by default). */
export const RULES_RSS_UA = "CityScrollBot/1.0 (+https://cityscroll.org; nyc-rules-rss)";
export const RULES_RSS_HEADERS = Object.freeze({
  Accept: "application/rss+xml, application/xml, text/xml, */*",
  "User-Agent": RULES_RSS_UA,
});
const SODA = "https://data.cityofnewyork.us/resource/dg92-zbpx.json";
const MAX_AGE_MS = 36 * 60 * 60 * 1000;
/**
 * City Record Agency Rules materialization lookback (days).
 *
 * Sibling rulemakings (proposal → hearing → adoption) span months; a 14-day
 * slice almost never co-located them, so multi_notice_rulemakings stayed 0.
 * Align with RULEMAKING_SIBLING_WINDOW_DAYS (540) so genuine siblings can
 * appear together. Bound the pull with CITY_RECORD_RULES_LIMIT (single SODA
 * page — do not page unboundedly).
 */
export const CITY_RECORD_RULES_LOOKBACK_DAYS = 540;
/** Hard cap on City Record Agency Rules rows per materialization (one SODA page). */
export const CITY_RECORD_RULES_LIMIT = 500;
/** @deprecated Use CITY_RECORD_RULES_LOOKBACK_DAYS — name was misleading (not RSS). */
export const RSS_MAX_AGE_DAYS = CITY_RECORD_RULES_LOOKBACK_DAYS;
const RULE_LIMIT = CITY_RECORD_RULES_LIMIT;

// event_date is required so Public Hearings under Agency Rules can supply the
// rules spine `public_hearing` event (Meetings lens already has this column).
const CR_SELECT = [
  "request_id", "start_date", "agency_name", "type_of_notice_description",
  "section_name", "short_title", "event_date",
  "additional_description_1", "additional_description_2", "additional_description_3",
].join(",");

/** Cloudflare challenge HTML is not an RSS feed — surface as fetch failure. */
export function looksLikeBotChallenge(text) {
  return /just a moment|cf-browser-verification|challenge-platform|_cf_chl|cdn-cgi\/challenge/i
    .test(String(text || ""));
}

async function fetchRulesRss(fetchImpl) {
  const response = await fetchImpl(RULES_RSS_URL, { headers: { ...RULES_RSS_HEADERS } });
  if (!response.ok) throw new Error(`NYC Rules RSS ${response.status}`);
  const xml = await response.text();
  if (looksLikeBotChallenge(xml)) {
    throw new Error("NYC Rules RSS blocked by bot challenge");
  }
  if (!/<rss[\s>]/i.test(xml) || !/<item[\s>]/i.test(xml)) {
    throw new Error("NYC Rules RSS response is not a feed with items");
  }
  return parseRssItems(xml).map(normalizeRuleItem);
}

async function fetchCityRecordRules(fetchImpl, now) {
  const since = new Date(now.getTime() - CITY_RECORD_RULES_LOOKBACK_DAYS * 86_400_000)
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

  // Build rows first, then stitch multi-notice rulemaking siblings (proposal /
  // hearing / adoption), promote City Record Public Hearings event_date into
  // the public_hearing spine event, then stamp subject registry so
  // same_rulemaking edges see related_notices. Notice identities stay distinct.
  function cityRecordBlock(notice) {
    return {
      request_id: notice.request_id,
      agency: notice.agency_name,
      title: notice.short_title,
      notice_date: notice.start_date,
      notice_type: notice.type_of_notice_description,
      section_name: notice.section_name || "Agency Rules",
      event_date: notice.event_date || null,
    };
  }

  const rawRecords = [
    ...matched.map((m) => ({
      request_id: m.city_record.request_id,
      agency: m.city_record.agency_name,
      title: m.city_record.short_title || m.rule.title,
      notice_date: m.city_record.start_date,
      stage: m.stage,
      city_record: cityRecordBlock(m.city_record),
      nyc_rules: {
        url: m.rule.url,
        guid: m.rule.guid,
        pub_date: m.rule.pub_date,
        title: m.rule.title,
        agency_abbr: m.rule.agency_abbr,
        agency_name: m.rule.agency_name,
        adoption_published_at: m.rule.adoption_published_at,
        effective_date: m.rule.effective_date,
        effective_source_field: m.rule.effective_source_field,
        comment_by_date: m.rule.comment_by_date,
        hearing_date: m.rule.hearing_date,
        comment_url: m.rule.comment_url,
        comment_count: m.rule.comment_count,
        summary: m.rule.summary,
      },
      events: deriveRuleEvents(m.rule, now),
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
      city_record: cityRecordBlock(notice),
      nyc_rules: null,
      events: [],
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
        guid: rule.guid,
        pub_date: rule.pub_date,
        title: rule.title,
        agency_abbr: rule.agency_abbr,
        agency_name: rule.agency_name,
        adoption_published_at: rule.adoption_published_at,
        effective_date: rule.effective_date,
        effective_source_field: rule.effective_source_field,
        comment_by_date: rule.comment_by_date,
        hearing_date: rule.hearing_date,
        comment_url: rule.comment_url,
        comment_count: rule.comment_count,
        summary: rule.summary,
      },
      events: deriveRuleEvents(rule, now),
      join: {
        matched: false,
        reason: "No matching City Record Agency Rules notice within the look-back window",
      },
    })),
  ];

  const stitched = attachRulemakingSiblings(rawRecords);
  // Promote Public Hearings event_date onto the rules public_hearing spine
  // (self + high-confidence siblings). Ambiguous hearings stay meetings-only.
  const withHearings = attachCityRecordPublicHearingEvents(stitched, now);
  const records = withHearings.map((record) => {
    const subjects = linksFromRuleRecord(record);
    return {
      ...record,
      subject_refs: subjects.subject_refs,
      subject_links: subjects.subject_links,
    };
  });

  const multiNoticeRulemakings = new Set(
    records
      .filter((r) => r.rulemaking_join?.matched && (r.rulemaking_join?.notice_count || 0) > 1)
      .map((r) => r.rulemaking_subject_ref)
      .filter(Boolean),
  );

  const multiNoticeNoticeCount = records.filter(
    (r) => r.rulemaking_join?.matched && (r.rulemaking_join?.notice_count || 0) > 1,
  ).length;

  const counts = {
    total: records.length,
    matched: matched.length,
    unmatched_notices: unmatchedNotices.length,
    unmatched_rules: unmatchedRules.length,
    by_stage: byStage,
    multi_notice_rulemakings: multiNoticeRulemakings.size,
    /** City Record rows in the lookback window (before RSS-only unmatched rules). */
    city_record_notices: notices.length,
    /** Notices that participate in a multi-notice rulemaking group. */
    multi_notice_notices: multiNoticeNoticeCount,
  };

  return {
    schema_version: RULES_VIEW_VERSION,
    generated_at: now.toISOString(),
    source: {
      primary: {
        name: "City Record Online",
        dataset: "dg92-zbpx",
        url: "https://data.cityofnewyork.us/City-Government/City-Record-Online/dg92-zbpx",
        lookback_days: CITY_RECORD_RULES_LOOKBACK_DAYS,
        limit: RULE_LIMIT,
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

/**
 * Whether the cached /rules view should be rebuilt before serving.
 * Age alone is not enough: a failed RSS materialization still stamps
 * generated_at, so a young enrichment status of "stale" would otherwise stick
 * until MAX_AGE even after egress is fixed (e.g. User-Agent headers).
 * schema_version mismatches force rebuild after multi-notice stitch (and similar)
 * ships so a young pre-fix KV is not served until MAX_AGE.
 */
export function rulesViewNeedsRefresh(parsed, nowMs = Date.now()) {
  if (!parsed || !parsed.generated_at) return true;
  const age = nowMs - new Date(parsed.generated_at).getTime();
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return true;
  if (parsed?.source?.enrichment?.status === "stale") return true;
  if (parsed.schema_version !== RULES_VIEW_VERSION) return true;
  return false;
}

export async function handleRules(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET") return jsonResponse(JSON.stringify({ ok: false, reason: "method" }), 405);
  if (!env.ALERT_STATE) return jsonResponse(JSON.stringify({ ok: false, reason: "not-configured" }), 503);

  let raw = await env.ALERT_STATE.get(RULES_KV_KEY);
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }

  if (rulesViewNeedsRefresh(parsed)) {
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
