import { createHash } from "node:crypto";

export const USEFULNESS_THRESHOLD = 0.3;
export const OUTCOME_LOOKUP_SCHEMA = "cityscroll.non_council_outcome_lookup.v1";

const ACTION_RE = /\b(approved|adopted|passed|rejected|denied|disapproved|held|tabled|deferred)\b/i;
const TALLY_RE = /\b(\d{1,3})\s*[-–]\s*(\d{1,3})\s*[-–]\s*(\d{1,3})\b/;

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isoDate(value) {
  const match = clean(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
}

function decodeHtml(value) {
  return clean(String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))));
}

function dateFromLabel(value) {
  const text = clean(value);
  const iso = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) {
    return `${iso[1]}-${String(iso[2]).padStart(2, "0")}-${String(iso[3]).padStart(2, "0")}`;
  }
  const month = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})\b/i,
  );
  if (!month) return null;
  const monthNumber = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ].indexOf(month[1].toLowerCase()) + 1;
  return `${month[3]}-${String(monthNumber).padStart(2, "0")}-${String(month[2]).padStart(2, "0")}`;
}

function normalizedToken(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function matterTokenMatch(tokens, text) {
  const expected = (tokens || []).map(normalizedToken).filter((token) => token.length >= 5);
  if (!expected.length) return { matched: false, token: null };
  const haystack = normalizedToken(text);
  const matterKey = expected.find((candidate) => haystack.includes(candidate)) || null;
  return { matched: Boolean(matterKey), token: matterKey };
}

export function extractExplicitOutcome(text) {
  const source = clean(text);
  const actionMatch = source.match(ACTION_RE);
  if (!actionMatch) return { explicit: false, action: null, tally: null };
  const raw = actionMatch[1].toLowerCase();
  const action = ["approved", "adopted", "passed"].includes(raw)
    ? "approved"
    : ["rejected", "denied", "disapproved"].includes(raw)
      ? "rejected"
      : raw === "tabled" || raw === "deferred"
        ? "held"
        : raw;
  const tallyMatch = source.match(TALLY_RE);
  return {
    explicit: true,
    action,
    tally: tallyMatch
      ? { yes: Number(tallyMatch[1]), no: Number(tallyMatch[2]), abstain: Number(tallyMatch[3]) }
      : null,
  };
}

export function parseSourceIndex(html, source, { observedAt = new Date().toISOString() } = {}) {
  if (!source?.body_id || !source?.source_url) return [];
  const anchor = /<a\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  const found = [];
  const seen = new Set();
  for (const match of String(html || "").matchAll(anchor)) {
    let url;
    try { url = new URL(decodeHtml(match[2]), source.source_url); }
    catch { continue; }
    if (url.protocol !== "https:") continue;
    if (!/\.(pdf|docx?|txt)(?:$|[?#])/i.test(url.href)) continue;
    if (seen.has(url.href)) continue;
    const title = decodeHtml(match[3]) || null;
    const meetingDate = dateFromLabel(`${title || ""} ${url.pathname}`);
    if (!meetingDate) continue;
    seen.add(url.href);
    found.push({
      document_id: createHash("sha256").update(`${source.body_id}\n${url.href}`).digest("hex").slice(0, 24),
      body_id: source.body_id,
      body_type: source.body_type || null,
      borough: source.borough || null,
      meeting_date: meetingDate,
      title,
      page_url: source.source_url,
      document_url: url.href,
      document_format: url.pathname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || null,
      observed_at: observedAt,
      text_status: "not_attempted",
      extracted_text: null,
    });
  }
  return found.sort((a, b) => b.meeting_date.localeCompare(a.meeting_date) || a.document_url.localeCompare(b.document_url));
}

function evaluatePair(notice, document) {
  if (clean(notice?.body_id) !== clean(document?.body_id)) {
    return { accepted: false, reason: "body_mismatch" };
  }
  if (!isoDate(notice?.event_date) || isoDate(notice.event_date) !== isoDate(document?.meeting_date)) {
    return { accepted: false, reason: "date_mismatch" };
  }
  const matter = matterTokenMatch(notice?.matter_tokens, `${document?.title || ""}\n${document?.extracted_text || ""}`);
  if (!matter.matched) return { accepted: false, reason: "matter_token_mismatch" };
  if (document?.text_status !== "ok") return { accepted: false, reason: "text_unavailable" };
  const outcome = extractExplicitOutcome(document.extracted_text);
  if (!outcome.explicit) return { accepted: false, reason: "explicit_outcome_absent" };
  return { accepted: true, reason: null, matter_token: matter.token, outcome };
}

export function joinNonCouncilOutcomes(notices = [], documents = []) {
  const joined = [];
  for (const notice of notices || []) {
    if (!(notice?.matter_tokens || []).length) continue;
    const candidates = (documents || []).filter((document) => clean(document?.body_id) === clean(notice?.body_id));
    for (const document of candidates) {
      const evaluation = evaluatePair(notice, document);
      if (!evaluation.accepted) continue;
      joined.push({
        request_id: clean(notice.request_id),
        body_id: clean(notice.body_id),
        borough: notice.borough || document.borough || null,
        meeting_date: isoDate(document.meeting_date),
        title: document.title || null,
        outcome: evaluation.outcome,
        join: {
          method: "exact_body_date_matter_tokens",
          body_id: clean(notice.body_id),
          event_date: isoDate(notice.event_date),
          matter_token: evaluation.matter_token,
        },
        provenance: {
          page_url: document.page_url,
          document_url: document.document_url,
          document_id: document.document_id || null,
          observed_at: document.observed_at || null,
          text_status: document.text_status,
        },
      });
      break;
    }
  }
  return joined.sort((a, b) => a.request_id.localeCompare(b.request_id));
}

export function measureJoinBridge(notices = [], documents = []) {
  const acceptedIds = new Set(joinNonCouncilOutcomes(notices, documents).map((row) => row.request_id));
  const rejectionReasons = {};
  let reviewedPairs = 0;
  let accepted = 0;
  for (const notice of notices || []) {
    const candidates = (documents || []).filter((document) => clean(document?.body_id) === clean(notice?.body_id));
    for (const document of candidates) {
      reviewedPairs += 1;
      const result = evaluatePair(notice, document);
      if (result.accepted) accepted += 1;
      else rejectionReasons[result.reason] = (rejectionReasons[result.reason] || 0) + 1;
    }
  }
  const total = notices.length;
  const joined = acceptedIds.size;
  const sampleByBorough = {};
  for (const notice of notices) {
    sampleByBorough[notice.borough] = (sampleByBorough[notice.borough] || 0) + 1;
  }
  return {
    joined,
    total,
    rate: total ? Number((joined / total).toFixed(4)) : 0,
    threshold: USEFULNESS_THRESHOLD,
    above_threshold: total > 0 && joined / total >= USEFULNESS_THRESHOLD,
    sample_by_borough: sampleByBorough,
    false_positive_review: {
      reviewed_pairs: reviewedPairs,
      accepted,
      rejected: reviewedPairs - accepted,
      rejection_reasons: rejectionReasons,
    },
  };
}

export function materializeOutcomeLookup(notices = [], documents = [], {
  generatedAt = new Date().toISOString(),
} = {}) {
  const matches = joinNonCouncilOutcomes(notices, documents);
  return {
    schema: OUTCOME_LOOKUP_SCHEMA,
    generated_at: generatedAt,
    coverage: {
      scope: "fixed_sample_not_citywide",
      presentation: "board_level",
      notices_seen: notices.length,
      notices_matched: matches.length,
      match_rate: notices.length ? Number((matches.length / notices.length).toFixed(4)) : 0,
      honest_absent: true,
    },
    notices: Object.fromEntries(matches.map((row) => [row.request_id, row])),
  };
}
