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

const CITY_RECORD_DETAIL_URL = "https://a856-cityrecord.nyc.gov/RequestDetail/";

/**
 * Normalize a City Record event_date for the rules spine.
 * Date-only / midnight → day precision; wall-clock times keep instant precision.
 */
export function normalizeCityRecordEventDate(raw) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // SODA often returns "2026-08-27T11:00:00.000" (no Z) — keep the publisher wall clock.
  const isoLocal = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?/);
  if (isoLocal) {
    const [, day, time] = isoLocal;
    if (time === "00:00:00") return day;
    return `${day}T${time}`;
  }
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Title similarity (token overlap)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the", "of", "and", "a", "an", "to", "in", "for", "on", "at", "by",
  "is", "are", "or", "be", "with", "from", "as", "this", "that", "will",
  "rule", "rules", "amendment", "amendments", "section", "sections",
  "chapter", "title", "city", "new", "york", "rcny", "proposed", "regarding",
  // Lifecycle / agency boilerplate left after title-core strip — shared across
  // unrelated rulemakings (especially DCWP "NOH Rules Relating to …") and must
  // not drive title-only sibling joins. "article"/"code" also bridge distinct
  // Health Code sections (Art. 141 vs 203) via thin emergency-rule titles.
  "relating", "related", "concerning", "notice", "noh", "noa", "nop", "nor",
  "opportunity", "comment", "comments", "hearing", "hearings", "public",
  "adoption", "adopted", "final", "article", "code",
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

// ---------------------------------------------------------------------------
// Multi-notice rulemaking stitch (proposal / hearing / adoption siblings)
//
// Same pattern as property disposition / PIN siblings: group City Record
// notices that confidently belong to one rulemaking, stamp a shared
// rulemaking_subject_ref + related_notices[], never merge notice identities.
// Speculative merges are worse than splits — high confidence only.
// ---------------------------------------------------------------------------

/** Lifecycle window for title+agency sibling joins (proposal → adoption can span months). */
export const RULEMAKING_SIBLING_WINDOW_DAYS = 540;

/** Minimum title-core overlap to stitch without a shared publisher rules id. */
export const RULEMAKING_TITLE_OVERLAP_MIN = 0.55;

/** Minimum significant tokens in a title core before title-only join is allowed. */
const RULEMAKING_MIN_CORE_TOKENS = 2;

const LIFECYCLE_TITLE_NOISE = [
  /\bnotice of (?:proposed )?adoption(?: of)?\b/gi,
  /\bnotice of proposed rule(?:making|s)?\b/gi,
  /\bnotice of public hearing\b/gi,
  /\bpublic hearing (?:on|regarding|for|concerning)\b/gi,
  /\bpublic hearing\b/gi,
  /\bproposed (?:rule|rules|rulemaking|amendment|amendments)\b/gi,
  /\bnotice of (?:proposed )?(?:rule|rules|rulemaking)\b/gi,
  /\badoption of (?:a |the )?(?:rule|rules|amendment|amendments)\b/gi,
  /\badopted (?:rule|rules)\b/gi,
  /\bregarding\b/gi,
  /\bconcerning\b/gi,
  /\bamendment(?:s)? (?:of|to)\b/gi,
  // City Record Agency Rules house style (esp. DCWP): "DCWP NOH: …" / "NOA …"
  // / "Rules Relating to …". Without stripping, shared boilerplate chains
  // unrelated rulemakings across a multi-month window (false merge).
  /\bnotice of (?:opportunity to comment on|change of effective date(?: for)?)\b/gi,
  /\bopportunity to comment on\b/gi,
  /\b(?:dcwp|dohmh|dep|dot|dob|hpd|tlc|dsny|dof|ppb|sbs|dcas|fdny|nypd|doe)\s+(?:noh|noa|nop|nor)\b[:\s-]*/gi,
  /\b(?:noh|noa|nop|nor)\b[:\s-]*/gi,
  /\brules?\s+relating\s+to\b/gi,
  /\brules?\s+related\s+to\b/gi,
  /\bproposed amendment of rules?\s+(?:relating to|regarding)?\b/gi,
];

/**
 * Strip lifecycle boilerplate so proposal / hearing / adoption titles for the
 * same rulemaking collapse onto a comparable core.
 */
export function rulemakingTitleCore(title) {
  let s = String(title || "");
  for (const re of LIFECYCLE_TITLE_NOISE) s = s.replace(re, " ");
  // Agency abbr repeated in CR short titles (agency already matched separately).
  s = s.replace(
    /\b(?:dcwp|dohmh|dep|dot|dob|hpd|tlc|dsny|dof|ppb|sbs|dcas|fdny|nypd|doe)\b[\s:-]*/gi,
    " ",
  );
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * True when a ref token is specific enough to high-confidence stitch alone.
 * Requires a title-scoped RCNY section cite (`34rcny section 4-08`), not a bare
 * `section 4-01` (those numbers recycle across agencies/chapters) and not bare
 * Title-N / chapter-alone boilerplate.
 */
export function isExactRulemakingRef(token) {
  const t = String(token || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!t) return false;
  // compound: "28rcny section 12-01" / "34rcny chapter 4 section 4-08"
  if (/\d+rcny/.test(t) && /section\s+\S*\d/.test(t)) return true;
  return false;
}

/** Collect digit-bearing section numbers from a text window. */
function sectionNumbersIn(window) {
  const out = [];
  for (const sm of String(window || "").matchAll(/\bsections?\s+(\d[\w.-]*)/gi)) {
    out.push(String(sm[1]).toLowerCase());
  }
  for (const sm of String(window || "").matchAll(/§\s*(\d[\w.-]*)/gi)) {
    out.push(String(sm[1]).toLowerCase());
  }
  // "sections 4-01 and 4-08" — first pass gets 4-01; pick up trailing list nums
  for (const sm of String(window || "").matchAll(
    /\bsections?\s+((?:\d[\w.-]*)(?:\s*(?:,|and|&)\s*\d[\w.-]*)+)/gi,
  )) {
    const nums = String(sm[1]).match(/\d[\w.-]*/g) || [];
    for (const n of nums) out.push(n.toLowerCase());
  }
  return [...new Set(out.filter((n) => /\d/.test(n)))];
}

/**
 * Reference tokens that can anchor a rulemaking across notices when shared.
 * Generic boilerplate is dropped (false-merge risk under a wide date window):
 *   - bare `title N` / `Title N of the RCNY` (agency-wide)
 *   - bare `N RCNY` title-level without a section cite
 *   - non-numeric "sections" (regex trap: `section` + `s`)
 *   - chapter-alone without a section number
 * Prefer compound `Nrcny section X-Y` (exact) and bare `section X-Y` (needs
 * title-core floor at match time).
 */
export function extractRulemakingRefTokens(text) {
  const raw = String(text || "");
  const found = new Set();

  // Compound high-specificity: "N RCNY" + nearby chapter/section in a window.
  // Bare title-level `N RCNY` alone is NOT emitted.
  for (const m of raw.matchAll(/\b(\d+(?:-\d+)?)\s*rcny\b/gi)) {
    const titleNum = m[1];
    const from = (m.index ?? 0) + m[0].length;
    // Look both slightly before (rare) and after the RCNY marker.
    const window = raw.slice(Math.max(0, (m.index ?? 0) - 40), from + 160);
    const chapterM = window.match(/\bchapter\s*([\d.a-z-]+)/i);
    const chapter = chapterM && /\d/.test(chapterM[1])
      ? String(chapterM[1]).toLowerCase()
      : null;
    for (const section of sectionNumbersIn(window)) {
      const parts = [`${titleNum}rcny`];
      if (chapter) parts.push(`chapter ${chapter}`);
      parts.push(`section ${section}`);
      found.add(parts.join(" "));
    }
  }

  // "Title 34 of the Rules of the City of New York" / "Title 34 of the RCNY"
  // with nearby section numbers → same compound as N RCNY (exact path).
  // Bare Title N without a section is never emitted.
  for (const m of raw.matchAll(
    /\btitle\s+(\d+)\b(?:\s+of\s+the\s+(?:rules\s+of\s+the\s+city\s+of\s+new\s+york|rcny))?/gi,
  )) {
    const titleNum = m[1];
    const center = m.index ?? 0;
    // Sections often appear BEFORE "of Title 34" ("sections 4-01 … of Chapter 4 of Title 34").
    const window = raw.slice(Math.max(0, center - 120), center + m[0].length + 80);
    const chapterM = window.match(/\bchapter\s*([\d.a-z-]+)/i);
    const chapter = chapterM && /\d/.test(chapterM[1])
      ? String(chapterM[1]).toLowerCase()
      : null;
    for (const section of sectionNumbersIn(window)) {
      const parts = [`${titleNum}rcny`];
      if (chapter) parts.push(`chapter ${chapter}`);
      parts.push(`section ${section}`);
      found.add(parts.join(" "));
    }
  }

  // Standalone section numbers — singular or plural lead-in.
  // "sections 4-01 and 4-08" must yield section 4-01 + section 4-08, never the
  // bare token "sections" (old regex matched `section` + trailing `s`).
  // These alone are NOT exact — matchRulemakingSiblings requires title-core
  // unless a title-scoped compound also matches.
  for (const section of sectionNumbersIn(raw)) {
    found.add(`section ${section}`);
  }

  // Bare title N, bare Nrcny, chapter-alone, non-numeric "sections" — intentionally
  // omitted. They are the false-merge fuel for DOT/DOB/HPD agency-wide clusters.
  return [...found].sort();
}

function recordAgencyAbbr(record) {
  return (
    record?.nyc_rules?.agency_abbr
    || agencyAbbr(record?.agency)
    || agencyAbbr(record?.city_record?.agency)
    || agencyAbbr(record?.city_record?.agency_name)
    || agencyAbbr(record?.agency_name)
    || null
  );
}

function recordTitle(record) {
  return (
    record?.title
    || record?.city_record?.title
    || record?.city_record?.short_title
    || record?.nyc_rules?.title
    || record?.short_title
    || ""
  );
}

function recordRequestId(record) {
  return String(
    record?.request_id
    || record?.city_record?.request_id
    || record?.city_record?.id
    || "",
  ).replace(/\s+/g, " ").trim() || null;
}

function recordNoticeDateMs(record) {
  const raw =
    record?.notice_date
    || record?.city_record?.notice_date
    || record?.city_record?.start_date
    || record?.start_date
    || record?.nyc_rules?.pub_date
    || null;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function recordRulesNativeId(record) {
  if (record?.nyc_rules) return rulesNativeIdLocal(record.nyc_rules);
  return null;
}

/** Local copy of rules native id (guid preferred) — avoids circular import. */
function rulesNativeIdLocal(nycRules = {}) {
  const guid = String(nycRules?.guid || nycRules?.Guid || nycRules?.GUID || "")
    .replace(/\s+/g, " ")
    .trim();
  if (guid && !/\s/.test(guid)) return guid;
  const url = String(nycRules?.url || nycRules?.link || nycRules?.Link || "")
    .replace(/\s+/g, " ")
    .trim();
  if (url && !/\s/.test(url)) return url;
  return null;
}

function recordBodyBlob(record) {
  return [
    recordTitle(record),
    record?.city_record?.additional_description_1,
    record?.city_record?.additional_description_2,
    record?.city_record?.additional_description_3,
    record?.nyc_rules?.summary,
    record?.nyc_rules?.title,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Classify a rules materialization / City Record row into a rulemaking role.
 * Returns proposal | hearing | adoption | notice.
 */
export function classifyRulemakingRole(record) {
  const title = recordTitle(record);
  const type = String(
    record?.city_record?.notice_type
    || record?.city_record?.type_of_notice_description
    || record?.type_of_notice_description
    || record?.nyc_rules?.notice_type
    || "",
  );
  const stage = String(record?.stage || "");
  const hay = `${title} ${type} ${stage}`;

  if (
    /\badoption\b|\badopted\b/i.test(hay)
    || record?.nyc_rules?.adoption_published_at
    || stage === "adopted"
    || stage === "effective"
    || record?.nyc_rules?.rule_status === "1"
    || record?.nyc_rules?.notice_type === "adoption"
  ) {
    return "adoption";
  }
  if (
    /\bpublic hearing\b|\bhearing\b/i.test(title)
    || stage === "hearing"
    || /\bpublic hearings?\b/i.test(type)
  ) {
    return "hearing";
  }
  if (
    /\bproposed\b|\bproposal\b/i.test(hay)
    || stage === "proposed"
    || stage === "comment-open"
    || stage === "comment-closed"
    || record?.nyc_rules?.notice_type === "proposed"
  ) {
    return "proposal";
  }
  return "notice";
}

/**
 * Confident sibling match only. Ambiguous pairs return matched:false —
 * separate subjects are the correct fallback. False merge is worse than split.
 *
 * High confidence when:
 *   1) same agency + shared NYC Rules guid/url, or
 *   2) same agency + shared *specific* reference + date window + title-core
 *      floor (exact section cites alone are not enough — the same 34 RCNY
 *      §4-01 can be amended by unrelated DOT rulemakings; generic Title-N /
 *      bare "sections" are never emitted), or
 *   3) same agency + high title-core overlap (≥ 0.55, ≥2 tokens) + date window.
 */
export function matchRulemakingSiblings(a, b) {
  const idA = recordRequestId(a);
  const idB = recordRequestId(b);
  if (!idA || !idB || idA === idB) {
    return { matched: false, confidence: "none", basis: "missing or identical request_id" };
  }

  const agencyA = recordAgencyAbbr(a);
  const agencyB = recordAgencyAbbr(b);
  if (!agencyA || !agencyB || agencyA !== agencyB) {
    return { matched: false, confidence: "none", basis: "agency mismatch" };
  }

  const rulesA = recordRulesNativeId(a);
  const rulesB = recordRulesNativeId(b);
  if (rulesA && rulesB && rulesA === rulesB) {
    return {
      matched: true,
      confidence: "high",
      basis: `shared rules id (${rulesA}) + agency ${agencyA}`,
      method: "shared_rules_id",
      agency: agencyA,
    };
  }

  const msA = recordNoticeDateMs(a);
  const msB = recordNoticeDateMs(b);
  let daysApart = null;
  if (msA != null && msB != null) {
    daysApart = Math.abs(msA - msB) / 86_400_000;
  }
  const inWindow = daysApart != null && daysApart <= RULEMAKING_SIBLING_WINDOW_DAYS;

  const coreA = rulemakingTitleCore(recordTitle(a));
  const coreB = rulemakingTitleCore(recordTitle(b));
  const tokA = tokens(coreA);
  const tokB = tokens(coreB);
  const overlap = titleOverlap(coreA, coreB);
  const titleCoreOk =
    tokA.size >= RULEMAKING_MIN_CORE_TOKENS
    && tokB.size >= RULEMAKING_MIN_CORE_TOKENS
    && overlap >= RULEMAKING_TITLE_OVERLAP_MIN;

  const refsA = new Set(extractRulemakingRefTokens(recordBodyBlob(a)));
  const refsB = new Set(extractRulemakingRefTokens(recordBodyBlob(b)));
  const sharedRefs = [...refsA].filter((r) => refsB.has(r));
  if (sharedRefs.length && inWindow && titleCoreOk) {
    // Title-core floor is mandatory even for exact RCNY section cites: the same
    // title/chapter/section can be amended by unrelated rulemakings (e.g. FHV
    // parking and bicycle racks both touch 34 RCNY §4-01). Generic refs are
    // already banned at extract time; this gate stops residual chain-merges.
    const exactRefs = sharedRefs.filter(isExactRulemakingRef);
    const primary = exactRefs[0] || sharedRefs[0];
    return {
      matched: true,
      confidence: "high",
      basis: exactRefs.length
        ? `agency ${agencyA} + exact ref (${primary}) + title-core (${Math.round(overlap * 100)}%) + date (${Math.round(daysApart)}d)`
        : `agency ${agencyA} + shared ref (${primary}) + title-core (${Math.round(overlap * 100)}%) + date (${Math.round(daysApart)}d)`,
      method: "shared_reference",
      agency: agencyA,
      shared_refs: sharedRefs,
      exact_refs: exactRefs,
      title_overlap: overlap,
      days_apart: Math.round(daysApart),
    };
  }

  if (tokA.size < RULEMAKING_MIN_CORE_TOKENS || tokB.size < RULEMAKING_MIN_CORE_TOKENS) {
    return {
      matched: false,
      confidence: "low",
      basis: "title core too thin for confident stitch",
    };
  }
  if (inWindow && overlap >= RULEMAKING_TITLE_OVERLAP_MIN) {
    return {
      matched: true,
      confidence: "high",
      basis: `agency ${agencyA} + title-core overlap (${Math.round(overlap * 100)}%) + date (${Math.round(daysApart)}d)`,
      method: "title_agency_window",
      agency: agencyA,
      title_overlap: overlap,
      days_apart: Math.round(daysApart),
    };
  }

  if (!inWindow && daysApart != null) {
    return {
      matched: false,
      confidence: "low",
      basis: `outside lifecycle window (${Math.round(daysApart)}d > ${RULEMAKING_SIBLING_WINDOW_DAYS}d)`,
    };
  }
  return {
    matched: false,
    confidence: "low",
    basis: `title-core overlap too low (${Math.round(overlap * 100)}%) or missing dates`,
  };
}

function slugRulemakingToken(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Stable process subject for a sibling group. Prefer shared publisher rules id
 * when every rules-bearing member agrees; else agency + title-core slug; else
 * earliest request_id. Spine-local — does not rewrite notice: identities.
 */
export function rulemakingSubjectRef(records = [], pairEvidence = null) {
  const rows = (records || []).filter((r) => recordRequestId(r));
  if (!rows.length) return null;
  const agency = recordAgencyAbbr(rows[0]) || "agency";
  const agencySlug = slugRulemakingToken(agency) || "agency";

  const rulesIds = [...new Set(rows.map(recordRulesNativeId).filter(Boolean))];
  if (rulesIds.length === 1) {
    // Shared publisher id is the strongest real-world subject.
    return `rulemaking:${agencySlug}:rules:${slugRulemakingToken(rulesIds[0]) || "id"}`;
  }

  if (pairEvidence?.method === "shared_reference" && pairEvidence.shared_refs?.[0]) {
    return `rulemaking:${agencySlug}:ref:${slugRulemakingToken(pairEvidence.shared_refs[0])}`;
  }

  // Prefer the longest title core among members (more specific than short stubs).
  let bestCore = "";
  for (const row of rows) {
    const core = rulemakingTitleCore(recordTitle(row));
    if (core.length > bestCore.length) bestCore = core;
  }
  const coreSlug = slugRulemakingToken(
    [...tokens(bestCore)].sort().join("-"),
  );
  if (coreSlug && [...tokens(bestCore)].length >= RULEMAKING_MIN_CORE_TOKENS) {
    return `rulemaking:${agencySlug}:${coreSlug}`;
  }

  const ids = rows.map(recordRequestId).filter(Boolean).sort();
  return `rulemaking:${agencySlug}:notice:${ids[0]}`;
}

/**
 * Union-find group City Record rules records into rulemaking sibling sets.
 * Only high-confidence pairs unite. Records without request_id are excluded
 * from multi-notice groups (RSS-only rows stay alone).
 *
 * @returns {Array<{ subject_ref: string, notices: object[], join: object }>}
 */
export function groupRulemakingSiblings(records = []) {
  const rows = (records || []).filter((r) => recordRequestId(r));
  if (!rows.length) return [];

  const byId = new Map();
  for (const row of rows) byId.set(recordRequestId(row), row);

  const parent = new Map();
  const find = (id) => {
    let p = parent.get(id) || id;
    while (p !== (parent.get(p) || p)) p = parent.get(p);
    parent.set(id, p);
    return p;
  };
  const unite = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  const ids = [...byId.keys()];
  for (const id of ids) parent.set(id, id);

  /** Best pair evidence per root (for subject_ref construction). */
  const pairMeta = new Map();

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = byId.get(ids[i]);
      const b = byId.get(ids[j]);
      const result = matchRulemakingSiblings(a, b);
      if (!result.matched || result.confidence !== "high") continue;
      unite(ids[i], ids[j]);
      const root = find(ids[i]);
      const prev = pairMeta.get(root);
      // Prefer shared_rules_id > shared_reference > title for subject construction.
      const rank = { shared_rules_id: 3, shared_reference: 2, title_agency_window: 1 };
      if (!prev || (rank[result.method] || 0) > (rank[prev.method] || 0)) {
        pairMeta.set(root, result);
      }
    }
  }

  const groups = new Map();
  for (const id of ids) {
    const root = find(id);
    const list = groups.get(root) || [];
    list.push(byId.get(id));
    groups.set(root, list);
  }

  const out = [];
  for (const [root, notices] of groups) {
    notices.sort((a, b) => {
      const da = recordNoticeDateMs(a) ?? 0;
      const db = recordNoticeDateMs(b) ?? 0;
      return da - db || String(recordRequestId(a)).localeCompare(String(recordRequestId(b)));
    });
    const evidence = pairMeta.get(root) || (notices.length > 1 ? { method: "title_agency_window" } : { method: "single_notice" });
    const multi = notices.length > 1;
    out.push({
      subject_ref: rulemakingSubjectRef(notices, multi ? evidence : null),
      notices,
      join: {
        matched: multi,
        method: multi ? (evidence.method || "title_agency_window") : "single_notice",
        confidence: multi ? "high" : "singleton",
        notice_count: notices.length,
        agency: recordAgencyAbbr(notices[0]) || null,
        request_ids: notices.map(recordRequestId),
        basis: multi
          ? (evidence.basis || "high-confidence sibling stitch")
          : "single City Record notice (no confident siblings)",
      },
    });
  }

  out.sort((a, b) => {
    const da = recordNoticeDateMs(a.notices[0]) ?? 0;
    const db = recordNoticeDateMs(b.notices[0]) ?? 0;
    return da - db || String(a.subject_ref).localeCompare(String(b.subject_ref));
  });
  return out;
}

/**
 * False-merge proxy for multi-notice rulemaking groups.
 *
 * Prior receipt only examined title-core cohesion and under-counted
 * shared_reference chain-merges (generic Title-N / "sections" clusters look
 * fine to a title-only density check when the *method* is shared_reference).
 * This proxy always scores every multi-notice group — including
 * shared_reference — by mean pairwise title-core overlap and pair-match
 * density.
 *
 * Flagged when:
 *   - mean pairwise title-core overlap < RULEMAKING_TITLE_OVERLAP_MIN, or
 *   - size > 8 and pair-match density < 0.85
 *
 * @param {Array<{ notices: object[], join?: object, subject_ref?: string }>} groups
 * @returns {{ multi_groups: number, flagged_groups: number, false_merge_rate: number|null, audits: object[] }}
 */
export function measureRulemakingSiblingFalseMerge(groups = []) {
  const multi = (groups || []).filter((g) => (g?.notices?.length || 0) > 1);
  const audits = [];
  let flagged = 0;
  for (const g of multi) {
    const notices = g.notices || [];
    const n = notices.length;
    let pairSum = 0;
    let pairCount = 0;
    let matchPairs = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const coreA = rulemakingTitleCore(recordTitle(notices[i]));
        const coreB = rulemakingTitleCore(recordTitle(notices[j]));
        pairSum += titleOverlap(coreA, coreB);
        pairCount += 1;
        const pair = matchRulemakingSiblings(notices[i], notices[j]);
        if (pair.matched && pair.confidence === "high") matchPairs += 1;
      }
    }
    const avgOverlap = pairCount ? pairSum / pairCount : 1;
    const density = pairCount ? matchPairs / pairCount : 1;
    const lowCohesion = avgOverlap < RULEMAKING_TITLE_OVERLAP_MIN;
    const sparseLarge = n > 8 && density < 0.85;
    const isFlag = lowCohesion || sparseLarge;
    if (isFlag) flagged += 1;
    audits.push({
      subject_ref: g.subject_ref || null,
      notice_count: n,
      method: g.join?.method || null,
      avg_title_core_overlap: Math.round(avgOverlap * 1000) / 1000,
      pair_match_density: Math.round(density * 1000) / 1000,
      flagged_false_merge_risk: isFlag,
      flag_reasons: [
        ...(lowCohesion ? ["low_title_core_overlap"] : []),
        ...(sparseLarge ? ["sparse_large_cluster"] : []),
      ],
      sample_titles: notices.slice(0, 6).map((r) => recordTitle(r)).filter(Boolean),
    });
  }
  return {
    multi_groups: multi.length,
    flagged_groups: flagged,
    false_merge_rate: multi.length ? flagged / multi.length : null,
    audits,
  };
}

function recordEventDateRaw(record) {
  return (
    record?.city_record?.event_date
    || record?.event_date
    || null
  );
}

function relatedNoticeEntry(record, pairResult = null) {
  const requestId = recordRequestId(record);
  const eventDate = recordEventDateRaw(record);
  return {
    request_id: requestId,
    role: classifyRulemakingRole(record),
    title: recordTitle(record) || null,
    notice_date: record?.notice_date || record?.city_record?.notice_date || record?.city_record?.start_date || null,
    event_date: eventDate || null,
    stage: record?.stage || null,
    agency: record?.agency || record?.city_record?.agency || null,
    ...(pairResult
      ? {
          join: {
            matched: pairResult.matched,
            confidence: pairResult.confidence,
            basis: pairResult.basis,
            method: pairResult.method || null,
          },
        }
      : {}),
  };
}

/**
 * Stamp each rules materialization record with:
 *   - rulemaking_subject_ref (shared across confident siblings)
 *   - related_notices[] (other City Record notices in the same rulemaking)
 *   - rulemaking_join (provenance for the stitch)
 *
 * Does not rewrite request_id / notice identity. Pure — returns a new array.
 * Records without request_id pass through unchanged (no stitch).
 */
export function attachRulemakingSiblings(records = []) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return [];

  const groups = groupRulemakingSiblings(list);
  const byRequestId = new Map();
  for (const group of groups) {
    for (const notice of group.notices) {
      byRequestId.set(recordRequestId(notice), group);
    }
  }

  return list.map((record) => {
    const rid = recordRequestId(record);
    if (!rid) {
      // RSS-only unmatched rules rows: no City Record sibling chain.
      return {
        ...record,
        rulemaking_subject_ref: null,
        related_notices: [],
        rulemaking_join: {
          matched: false,
          method: "no_city_record_notice",
          confidence: "none",
          notice_count: 0,
          basis: "no request_id — cannot stitch City Record siblings",
        },
      };
    }

    const group = byRequestId.get(rid);
    if (!group) {
      return {
        ...record,
        rulemaking_subject_ref: `rulemaking:notice:${rid}`,
        related_notices: [],
        rulemaking_join: {
          matched: false,
          method: "single_notice",
          confidence: "singleton",
          notice_count: 1,
          request_ids: [rid],
          basis: "single City Record notice (no confident siblings)",
        },
      };
    }

    const siblings = group.notices.filter((n) => recordRequestId(n) !== rid);
    const related = siblings.map((sib) => {
      const pair = matchRulemakingSiblings(record, sib);
      return relatedNoticeEntry(sib, pair);
    });

    return {
      ...record,
      rulemaking_subject_ref: group.subject_ref,
      related_notices: related,
      rulemaking_join: {
        ...group.join,
        // Per-record view of the group join.
        role: classifyRulemakingRole(record),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// City Record Public Hearings → rules spine `public_hearing` event
//
// Agency Rules notices with type "Public Hearings" already land in the rules
// materialization and sibling-stitch as role=hearing, but their event_date was
// never promoted into the event spine (only NYC Rules RSS hearing_date_1 was).
// That left rulemaking hearings visible only in the Meetings lens.
// ---------------------------------------------------------------------------

/**
 * True when a materialization row is a City Record Public Hearings notice that
 * can supply a rules-lifecycle hearing date (not a generic Meetings-section
 * row without hearing classification).
 */
export function isRulesPublicHearingNotice(record) {
  if (!record) return false;
  const type = String(
    record?.city_record?.notice_type
    || record?.city_record?.type_of_notice_description
    || record?.type_of_notice_description
    || "",
  );
  if (/\bpublic hearings?\b/i.test(type)) return true;
  // Title/role-classified hearing under Agency Rules (sibling stitch role).
  if (classifyRulemakingRole(record) === "hearing" && recordEventDateRaw(record)) {
    return true;
  }
  return false;
}

/**
 * Build a spine `public_hearing` event from a City Record hearing notice.
 * Returns null when event_date is missing or the row is not a hearing notice.
 *
 * @param {object} record - rules materialization row (or related_notice-shaped)
 * @param {Date} [now]
 * @param {object} [join] - optional sibling-join provenance
 */
export function cityRecordPublicHearingEvent(record, now = new Date(), join = null) {
  if (!isRulesPublicHearingNotice(record) && !recordEventDateRaw(record)) return null;
  // Require hearing classification for any event emission.
  if (!isRulesPublicHearingNotice(record)) return null;

  const raw = recordEventDateRaw(record);
  const validAt = normalizeCityRecordEventDate(raw);
  if (!validAt) return null;

  const requestId = recordRequestId(record);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(validAt);
  const noticeType = String(
    record?.city_record?.notice_type
    || record?.city_record?.type_of_notice_description
    || record?.type_of_notice_description
    || null,
  ) || null;
  const sectionName = String(
    record?.city_record?.section_name
    || record?.section_name
    || "Agency Rules",
  ) || null;

  const event = {
    event_type: "public_hearing",
    valid_at: validAt,
    valid_at_precision: dateOnly ? "day" : "instant",
    valid_timezone: dateOnly ? RULE_TIMEZONE : "UTC",
    source_field: "city_record.event_date",
    source_url: requestId ? `${CITY_RECORD_DETAIL_URL}${encodeURIComponent(requestId)}` : null,
    status: validAt.slice(0, 10) < now.toISOString().slice(0, 10) ? "occurred" : "scheduled",
    provenance: {
      source: "city_record",
      request_id: requestId,
      notice_type: noticeType,
      section_name: sectionName,
      field: "event_date",
      ...(join
        ? {
            join: {
              matched: join.matched !== false,
              confidence: join.confidence || null,
              basis: join.basis || null,
              method: join.method || null,
            },
          }
        : {}),
    },
  };
  return event;
}

function hasPublicHearingEvent(events = []) {
  return (events || []).some((e) => e && e.event_type === "public_hearing");
}

/**
 * Insert a public_hearing event in canonical spine order (after proposal_published
 * when present; otherwise first among non-adoption lifecycle events).
 */
function insertPublicHearingEvent(events, hearingEvent) {
  const list = Array.isArray(events) ? [...events] : [];
  if (!hearingEvent || hasPublicHearingEvent(list)) return list;
  const afterProposal = list.findIndex((e) => e.event_type === "proposal_published");
  if (afterProposal >= 0) {
    list.splice(afterProposal + 1, 0, hearingEvent);
    return list;
  }
  const beforeComment = list.findIndex((e) =>
    e.event_type === "comment_close"
    || e.event_type === "adoption"
    || e.event_type === "effective");
  if (beforeComment >= 0) {
    list.splice(beforeComment, 0, hearingEvent);
    return list;
  }
  list.push(hearingEvent);
  return list;
}

/**
 * After sibling stitch: promote City Record Public Hearings `event_date` into
 * the rules event spine as `public_hearing`, with provenance.
 *
 * Honest limits:
 *  - Only hearing-classified notices with a real event_date produce events.
 *  - Propagation to siblings requires high-confidence rulemaking stitch
 *    (reuse matchRulemakingSiblings / rulemaking_join) — ambiguous hearings
 *    stay on the hearing notice alone (Meetings lens remains the fallback).
 *  - Does not replace or duplicate an existing RSS-derived public_hearing
 *    (hearing_date_1 wins when already present).
 *
 * Pure — returns a new array of records.
 */
export function attachCityRecordPublicHearingEvents(records = [], now = new Date()) {
  const list = Array.isArray(records) ? records : [];
  if (!list.length) return [];

  // Collect hearing sources that can supply an event.
  const hearingSources = [];
  for (const record of list) {
    if (!isRulesPublicHearingNotice(record)) continue;
    const selfJoin = record?.rulemaking_join?.matched
      ? {
          matched: true,
          confidence: record.rulemaking_join.confidence,
          basis: record.rulemaking_join.basis,
          method: record.rulemaking_join.method || "rulemaking_sibling_stitch",
        }
      : {
          matched: true,
          confidence: "self",
          basis: "City Record Public Hearings notice with event_date",
          method: "city_record_hearing_self",
        };
    const event = cityRecordPublicHearingEvent(record, now, selfJoin);
    if (!event) continue;
    hearingSources.push({ record, event, requestId: recordRequestId(record) });
  }

  if (!hearingSources.length) {
    return list.map((r) => ({ ...r, events: Array.isArray(r.events) ? [...r.events] : [] }));
  }

  // Map request_id → best hearing event for self-attachment.
  const selfHearingById = new Map();
  for (const src of hearingSources) {
    if (src.requestId) selfHearingById.set(src.requestId, src);
  }

  // Map rulemaking_subject_ref → hearing sources only when the group is a
  // high-confidence multi-notice stitch (ambiguous stay unpropagated).
  const hearingsBySubject = new Map();
  for (const src of hearingSources) {
    const join = src.record?.rulemaking_join;
    // Only high-confidence multi-notice groups propagate hearing → siblings.
    const multiHigh =
      join?.matched === true
      && join.confidence === "high"
      && (join.notice_count || 0) > 1;
    if (!multiHigh) continue;
    const subject = src.record.rulemaking_subject_ref;
    if (!subject) continue;
    const arr = hearingsBySubject.get(subject) || [];
    arr.push(src);
    hearingsBySubject.set(subject, arr);
  }

  return list.map((record) => {
    const rid = recordRequestId(record);
    let events = Array.isArray(record.events) ? [...record.events] : [];
    if (hasPublicHearingEvent(events)) {
      // RSS (or prior) hearing already present — do not invent a second one.
      return { ...record, events };
    }

    // 1) Self: this row is the Public Hearings notice.
    const selfSrc = rid ? selfHearingById.get(rid) : null;
    if (selfSrc) {
      events = insertPublicHearingEvent(events, selfSrc.event);
      return { ...record, events };
    }

    // 2) Sibling propagation: only high-confidence multi-notice rulemakings.
    const subject = record.rulemaking_subject_ref;
    const groupJoin = record.rulemaking_join;
    const canReceiveSibling =
      subject
      && groupJoin?.matched
      && groupJoin.confidence === "high"
      && (groupJoin.notice_count || 0) > 1;
    if (!canReceiveSibling) {
      return { ...record, events };
    }

    const candidates = hearingsBySubject.get(subject) || [];
    if (!candidates.length) {
      return { ...record, events };
    }

    // Prefer the sibling with the strongest pair match to this record.
    let best = null;
    let bestRank = -1;
    for (const src of candidates) {
      if (src.requestId && src.requestId === rid) continue;
      const pair = matchRulemakingSiblings(record, src.record);
      if (!pair.matched || pair.confidence !== "high") continue;
      const rank = pair.method === "shared_rules_id" ? 3
        : pair.method === "shared_reference" ? 2
        : 1;
      if (rank > bestRank) {
        bestRank = rank;
        best = { src, pair };
      }
    }
    if (!best) {
      return { ...record, events };
    }

    const siblingEvent = cityRecordPublicHearingEvent(best.src.record, now, {
      matched: true,
      confidence: best.pair.confidence,
      basis: best.pair.basis,
      method: best.pair.method || "rulemaking_sibling_stitch",
    });
    if (siblingEvent) {
      events = insertPublicHearingEvent(events, siblingEvent);
    }
    return { ...record, events };
  });
}
