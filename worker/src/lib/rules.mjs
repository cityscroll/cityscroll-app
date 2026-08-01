// Pure parsing, lifecycle classification, and join logic for the NYC Rules
// materialized view. Runs in both the Worker and the site's contract-test lane.

import { cleanNoticeText } from "../../../site/text_clean.mjs";

// ---------------------------------------------------------------------------
// Agency name normalization
// ---------------------------------------------------------------------------

const ABBR_DIRECT = {
  hpd: "HPD", dot: "DOT", dob: "DOB", dcwp: "DCWP",
  dsny: "DSNY", dcp: "DCP", tlc: "TLC", dep: "DEP",
  dohmh: "DOHMH", fdny: "FDNY", nypd: "NYPD",
  doe: "DOE", dca: "DCWP", dob: "DOB",
};

const ABBR_PATTERNS = [
  [/housing preservation/i, "HPD"],
  [/\btransportation\b/i, "DOT"],
  [/consumer.*worker/i, "DCWP"],
  [/\bconsumer affairs\b/i, "DCWP"],
  [/\bsanitation\b/i, "DSNY"],
  [/city planning/i, "DCP"],
  [/taxi.*limousine/i, "TLC"],
  [/environmental protection/i, "DEP"],
  [/\bbuildings\b/i, "DOB"],
  [/\bhealth\b/i, "DOHMH"],
  [/\bfire\b/i, "FDNY"],
  [/\bpolice\b/i, "NYPD"],
  [/\beducation\b/i, "DOE"],
];

export function agencyAbbr(name) {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  if (ABBR_DIRECT[n]) return ABBR_DIRECT[n];
  const stripped = n
    .replace(/^(the\s+)?(?:dept\.?|department)\s+of\s+/, "")
    .replace(/^(the\s+)?/, "");
  if (ABBR_DIRECT[stripped]) return ABBR_DIRECT[stripped];
  for (const [re, abbr] of ABBR_PATTERNS) {
    if (re.test(stripped)) return abbr;
  }
  return null;
}

// ---------------------------------------------------------------------------
// RSS XML parsing (regex-based; Workers lack DOMParser)
// ---------------------------------------------------------------------------

function unescape(s) {
  if (!s) return null;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripCdata(s) {
  if (!s) return s;
  const m = s.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : s;
}

function extractTag(block, tag) {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)</${escaped}>`, "i");
  const m = re.exec(block);
  return m ? stripCdata(m[1].trim()) : null;
}

function stripHtml(s) {
  return cleanNoticeText(s);
}

function parseCompactDate(s) {
  if (!s || !/^\d{8}$/.test(s)) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function parseDisplayDate(s) {
  if (!s) return null;
  const m = s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function extractFromContent(html) {
  const result = {};
  if (!html) return result;

  const agencyMatch = html.match(/<em>Agency:?\s*<\/em>\s*<strong>([^<]+)<\/strong>/i);
  if (agencyMatch) result.agency_full = stripHtml(agencyMatch[1]);

  const commentMatch = html.match(/<em>Comment-By Date:?\s*<\/em>\s*<strong>([^<]+)<\/strong>/i);
  if (commentMatch) result.comment_by_date = parseDisplayDate(commentMatch[1]);

  const hearingMatch = html.match(/<em>Hearing Dates:?\s*<\/em>\s*<strong>([^<]+)<\/strong>/i);
  if (hearingMatch) result.hearing_date = parseDisplayDate(hearingMatch[1]);

  const effectiveMatch = html.match(/<em>Rule Effective Date:?\s*<\/em>\s*<strong>([^<]+)<\/strong>/i);
  if (effectiveMatch) result.rule_effective_date = parseDisplayDate(effectiveMatch[1]);

  if (/notice of adoption/i.test(html)) result.notice_type = "adoption";
  else if (/proposed/i.test(html)) result.notice_type = "proposed";

  return result;
}

export function parseRssItems(xml) {
  if (!xml || typeof xml !== "string") return [];
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const raw = {
      title: unescape(extractTag(block, "title")),
      link: extractTag(block, "link"),
      pubDate: extractTag(block, "pubDate"),
      guid: extractTag(block, "guid"),
      creator: stripCdata(extractTag(block, "dc:creator") || ""),
      content: extractTag(block, "content:encoded"),
      commentRss: extractTag(block, "wfw:commentRss"),
      commentCount: extractTag(block, "slash:comments"),
      agency_name: extractTag(block, "agency_name"),
      rule_status: extractTag(block, "rule_status"),
      rule_adoption_date: extractTag(block, "rule_adoption_date"),
      comment_by_date: extractTag(block, "comment_by_date"),
      rule_short_summary: extractTag(block, "rule_short_summary"),
      hearing_date_1: extractTag(block, "hearing_date_1"),
    };
    items.push(raw);
  }
  return items;
}

export function normalizeRuleItem(raw) {
  const fallback = extractFromContent(raw.content);

  const agencyAbbrVal = agencyAbbr(raw.agency_name) || agencyAbbr(fallback.agency_full);
  // Despite its historical name, the official `rule_adoption_date` RSS field
  // matches the "Rule Effective Date" printed in content:encoded. Keep that
  // valid-time assertion separate from the publication clock of an adoption item.
  const effectiveDate = parseCompactDate(raw.rule_adoption_date) || fallback.rule_effective_date || null;
  const commentDate = parseCompactDate(raw.comment_by_date) || fallback.comment_by_date || null;
  const hearingDate = parseCompactDate(raw.hearing_date_1) || fallback.hearing_date || null;
  const summary = raw.rule_short_summary
    ? stripHtml(raw.rule_short_summary)
    : stripHtml(raw.content || "").slice(0, 500);

  let pubDate = null;
  if (raw.pubDate) {
    const parsed = Date.parse(raw.pubDate);
    if (Number.isFinite(parsed)) pubDate = new Date(parsed).toISOString();
  }

  return {
    title: raw.title || "",
    url: raw.link || null,
    pub_date: pubDate,
    agency_name: raw.agency_name || fallback.agency_full || null,
    agency_full: fallback.agency_full || null,
    agency_abbr: agencyAbbrVal,
    rule_status: raw.rule_status || null,
    adoption_published_at: (raw.rule_status === "1" || fallback.notice_type === "adoption") ? pubDate : null,
    effective_date: effectiveDate,
    effective_source_field: raw.rule_adoption_date ? "rule_adoption_date" : (fallback.rule_effective_date ? "content:Rule Effective Date" : null),
    comment_by_date: commentDate,
    hearing_date: hearingDate,
    summary,
    comment_url: raw.commentRss || null,
    comment_count: raw.commentCount ? Number(raw.commentCount) : 0,
    notice_type: fallback.notice_type || null,
    guid: raw.guid || null,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle stage classification
// ---------------------------------------------------------------------------

export function classifyStage(rule, now = new Date()) {
  const nowMs = now.getTime();
  const effective = rule.effective_date ? Date.parse(rule.effective_date) : null;
  const comment = rule.comment_by_date ? Date.parse(rule.comment_by_date) : null;
  const hearing = rule.hearing_date ? Date.parse(rule.hearing_date) : null;

  const adopted = rule.rule_status === "1" || rule.notice_type === "adoption" || !!rule.adoption_published_at;
  if (adopted) {
    if (effective != null && Number.isFinite(effective) && nowMs >= effective) return "effective";
    return "adopted";
  }
  if (comment != null && Number.isFinite(comment) && nowMs < comment) return "comment-open";
  if (hearing != null && Number.isFinite(hearing) && nowMs < hearing) return "hearing";
  if (comment != null && Number.isFinite(comment) && nowMs >= comment) return "comment-closed";
  return "proposed";
}

// ---------------------------------------------------------------------------
// Event spine
// ---------------------------------------------------------------------------

const RULE_TIMEZONE = "America/New_York";

function datedRuleEvent(rule, eventType, validAt, sourceField, now, { alert = false } = {}) {
  if (!validAt) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(validAt);
  const event = {
    event_type: eventType,
    valid_at: validAt,
    valid_at_precision: dateOnly ? "day" : "instant",
    valid_timezone: dateOnly ? RULE_TIMEZONE : "UTC",
    source_field: sourceField,
    source_url: rule.url || null,
    status: validAt.slice(0, 10) < now.toISOString().slice(0, 10) ? "occurred" : "scheduled",
  };
  if (alert) {
    event.alert = {
      eligible: true,
      trigger_field: "valid_at",
      lead_days: [14, 3, 1, 0],
    };
  }
  return event;
}

/**
 * Preserve each official Rules assertion as its own event. `stage` remains a compact
 * list-view summary; detail and alerts consume this non-collapsed event spine.
 * Date-only source fields stay date-only instead of inventing a closing clock time.
 */
export function deriveRuleEvents(rule, now = new Date()) {
  const adopted = rule.rule_status === "1" || rule.notice_type === "adoption" || !!rule.adoption_published_at;
  const adoptionEvent = adopted && rule.adoption_published_at
    ? {
        event_type: "adoption",
        valid_at: null,
        valid_at_precision: null,
        valid_timezone: null,
        published_at: rule.adoption_published_at,
        source_field: "pubDate",
        source_url: rule.url || null,
        status: "occurred",
      }
    : null;
  return [
    adopted ? null : datedRuleEvent(rule, "proposal_published", rule.pub_date, "pubDate", now),
    datedRuleEvent(rule, "public_hearing", rule.hearing_date, "hearing_date_1", now),
    datedRuleEvent(rule, "comment_close", rule.comment_by_date, "comment_by_date", now, { alert: true }),
    adoptionEvent,
    datedRuleEvent(rule, "effective", rule.effective_date, rule.effective_source_field || "Rule Effective Date", now),
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Title similarity (token overlap)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "of", "and", "a", "an", "to", "in", "for", "on", "at", "by",
  "is", "are", "or", "be", "with", "from", "as", "this", "that", "will",
  "rule", "rules", "amendment", "amendments", "section", "sections",
  "chapter", "title", "city", "new", "york", "rcny", "proposed", "regarding",
]);

function tokens(s) {
  if (!s) return new Set();
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
  );
}

export function titleOverlap(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

// ---------------------------------------------------------------------------
// Join logic: match NYC Rules RSS items to City Record Agency Rules notices
// ---------------------------------------------------------------------------

const DATE_WINDOW_DAYS = 90;

export function matchRuleToNotice(rule, notice, now = new Date()) {
  const ruleAgency = rule.agency_abbr;
  const noticeAgency = agencyAbbr(notice.agency_name);
  if (!ruleAgency || !noticeAgency || ruleAgency !== noticeAgency) {
    return { matched: false, confidence: "none", basis: "agency mismatch" };
  }

  const ruleDate = rule.pub_date ? Date.parse(rule.pub_date) : null;
  const noticeDate = notice.start_date ? Date.parse(notice.start_date) : null;
  let daysApart = null;
  if (ruleDate != null && noticeDate != null && Number.isFinite(ruleDate) && Number.isFinite(noticeDate)) {
    daysApart = Math.abs(ruleDate - noticeDate) / 86_400_000;
  }

  const overlap = titleOverlap(rule.title, notice.short_title);

  if (daysApart != null && daysApart <= DATE_WINDOW_DAYS && overlap > 0.15) {
    return {
      matched: true,
      confidence: "high",
      basis: `agency + date (${Math.round(daysApart)}d apart) + title overlap (${Math.round(overlap * 100)}%)`,
    };
  }
  if (daysApart != null && daysApart <= DATE_WINDOW_DAYS) {
    return {
      matched: true,
      confidence: "medium",
      basis: `agency + date proximity (${Math.round(daysApart)}d apart)`,
    };
  }
  if (overlap > 0.3) {
    return {
      matched: true,
      confidence: "medium",
      basis: `agency + title overlap (${Math.round(overlap * 100)}%)`,
    };
  }
  return {
    matched: false,
    confidence: "low",
    basis: "agency match only; no date or title signal",
  };
}

export function joinRulesToNotices(rules, notices, now = new Date()) {
  const usedRules = new Set();
  const matched = [];
  const unmatchedNotices = [];

  for (const notice of notices) {
    let bestMatch = null;
    let bestScore = -1;
    for (let i = 0; i < rules.length; i++) {
      if (usedRules.has(i)) continue;
      const result = matchRuleToNotice(rules[i], notice, now);
      const score = result.matched
        ? (result.confidence === "high" ? 2 : 1)
        : -1;
      if (score > bestScore) {
        bestScore = score;
        bestMatch = result.matched ? { rule: rules[i], index: i, result } : null;
      }
    }
    if (bestMatch) {
      usedRules.add(bestMatch.index);
      matched.push({
        city_record: notice,
        rule: bestMatch.rule,
        join: bestMatch.result,
        stage: classifyStage(bestMatch.rule, now),
      });
    } else {
      unmatchedNotices.push(notice);
    }
  }

  const unmatchedRules = rules
    .map((rule, i) => ({ rule, index: i }))
    .filter(({ index }) => !usedRules.has(index))
    .map(({ rule }) => ({
      rule,
      stage: classifyStage(rule, now),
    }));

  return { matched, unmatchedNotices, unmatchedRules };
}
