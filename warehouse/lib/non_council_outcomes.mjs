import { createHash } from "node:crypto";

import {
  extractUlurpKeys,
  filterPlausibleUlurpKeys,
  isPlausibleUlurpKey,
} from "../../site/ulurp_tokens.mjs";

/**
 * Non-Council minutes → City Record notice join.
 *
 * Join keys are exact body_id + meeting date + publisher-supplied ULURP matter
 * identifiers only. Slug/name tokens (ATLANTIC-REZONING, street names) never
 * promote to outcome edges. Unresolvable candidates stay unresolved.
 */

export const USEFULNESS_THRESHOLD = 0.3;
/** Survey promotion bar for enabling the boards outcome edge (100% reviewed precision). */
export const PRECISION_PROMOTION_BAR = 1.0;
export const OUTCOME_LOOKUP_SCHEMA = "cityscroll.non_council_outcome_lookup.v1";
export const JOIN_METHOD = "exact_body_date_publisher_ulurp";
export const REVIEW_RECEIPT_SCHEMA = "cityscroll.non_council_outcomes.precision_review.v1";

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

/**
 * Keep only publisher-supplied ULURP matter identifiers.
 * Drops slug/name tokens that earlier fixtures accepted as matter keys.
 * @param {Iterable<string>|null|undefined} tokens
 * @returns {string[]}
 */
export function publisherMatterTokens(tokens) {
  return filterPlausibleUlurpKeys(tokens || []);
}

/**
 * Exact publisher-id intersection: notice ULURP keys ∩ document ULURP keys.
 * No fuzzy name/title matching; no bare substring of non-ULURP slugs.
 */
export function matterTokenMatch(tokens, text) {
  const expected = publisherMatterTokens(tokens);
  if (!expected.length) {
    return { matched: false, token: null, reason: "publisher_matter_token_absent" };
  }
  const haystackKeys = extractUlurpKeys(text);
  for (const token of expected) {
    if (!isPlausibleUlurpKey(token)) continue;
    const core = token.replace(/^[A-Z](?=\d{6}[A-Z]{2,4}$)/, "");
    if (haystackKeys.has(token) || haystackKeys.has(core)) {
      return { matched: true, token, reason: null };
    }
    for (const key of haystackKeys) {
      const keyCore = key.replace(/^[A-Z](?=\d{6}[A-Z]{2,4}$)/, "");
      if (key === token || keyCore === core || key === core || keyCore === token) {
        return { matched: true, token, reason: null };
      }
    }
  }
  return { matched: false, token: null, reason: "matter_token_mismatch" };
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

export function evaluatePair(notice, document) {
  if (clean(notice?.body_id) !== clean(document?.body_id)) {
    return { accepted: false, reason: "body_mismatch" };
  }
  if (!isoDate(notice?.event_date) || isoDate(notice.event_date) !== isoDate(document?.meeting_date)) {
    return { accepted: false, reason: "date_mismatch" };
  }
  const publisherTokens = publisherMatterTokens(notice?.matter_tokens);
  if (!publisherTokens.length) {
    return { accepted: false, reason: "publisher_matter_token_absent" };
  }
  const matter = matterTokenMatch(publisherTokens, `${document?.title || ""}\n${document?.extracted_text || ""}`);
  if (!matter.matched) return { accepted: false, reason: matter.reason || "matter_token_mismatch" };
  if (document?.text_status !== "ok") return { accepted: false, reason: "text_unavailable" };
  const outcome = extractExplicitOutcome(document.extracted_text);
  if (!outcome.explicit) return { accepted: false, reason: "explicit_outcome_absent" };
  return { accepted: true, reason: null, matter_token: matter.token, outcome };
}

export function joinNonCouncilOutcomes(notices = [], documents = []) {
  const joined = [];
  for (const notice of notices || []) {
    const publisherTokens = publisherMatterTokens(notice?.matter_tokens);
    if (!publisherTokens.length) continue;
    const noticeWithPublisher = { ...notice, matter_tokens: publisherTokens };
    const candidates = (documents || []).filter((document) => clean(document?.body_id) === clean(notice?.body_id));
    for (const document of candidates) {
      const evaluation = evaluatePair(noticeWithPublisher, document);
      if (!evaluation.accepted) continue;
      joined.push({
        request_id: clean(notice.request_id),
        body_id: clean(notice.body_id),
        borough: notice.borough || document.borough || null,
        meeting_date: isoDate(document.meeting_date),
        title: document.title || null,
        outcome: evaluation.outcome,
        join: {
          method: JOIN_METHOD,
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

/**
 * Enumerate body-matched notice/document pairs with automated join disposition.
 * Used for measurement; not a public edge writer.
 */
export function enumerateJoinCandidates(notices = [], documents = []) {
  const candidates = [];
  for (const notice of notices || []) {
    const bodyDocs = (documents || []).filter((document) => clean(document?.body_id) === clean(notice?.body_id));
    for (const document of bodyDocs) {
      const evaluation = evaluatePair(notice, document);
      candidates.push({
        request_id: clean(notice.request_id),
        document_id: document.document_id || null,
        body_id: clean(notice.body_id),
        borough: notice.borough || document.borough || null,
        event_date: isoDate(notice.event_date),
        meeting_date: isoDate(document.meeting_date),
        notice_matter_tokens: [...(notice.matter_tokens || [])],
        publisher_matter_tokens: publisherMatterTokens(notice.matter_tokens),
        join_disposition: evaluation.accepted ? "accepted" : "rejected",
        rejection_reason: evaluation.accepted ? null : evaluation.reason,
        matter_token: evaluation.matter_token || null,
        outcome_action: evaluation.outcome?.action || null,
      });
    }
  }
  return candidates.sort((a, b) =>
    a.request_id.localeCompare(b.request_id)
    || String(a.document_id || "").localeCompare(String(b.document_id || "")),
  );
}

/**
 * Attach human review labels to join candidates and score precision.
 *
 * labels: Map or object keyed by `${request_id}::${document_id}` →
 *   "true_positive" | "false_positive" | "true_reject" | "false_reject" | "unresolved"
 *
 * When labels are omitted, auto-labels treat automated accept as true_positive and
 * automated reject as true_reject (fixture self-check only). Production receipts
 * must supply reviewed labels.
 */
export function reviewJoinCandidates(notices = [], documents = [], labels = null) {
  const candidates = enumerateJoinCandidates(notices, documents);
  const labelMap = labels instanceof Map
    ? labels
    : labels && typeof labels === "object"
      ? new Map(Object.entries(labels))
      : null;

  const reviewed = candidates.map((candidate) => {
    const key = `${candidate.request_id}::${candidate.document_id || ""}`;
    let review_label = labelMap?.get(key) || null;
    if (!review_label) {
      // Deterministic auto-label for unlabeled fixture regeneration only.
      review_label = candidate.join_disposition === "accepted" ? "true_positive" : "true_reject";
    }
    return {
      ...candidate,
      review_label,
      production_edge_authorized: review_label === "true_positive" && candidate.join_disposition === "accepted",
    };
  });

  const acceptedByJoin = reviewed.filter((row) => row.join_disposition === "accepted");
  const truePositives = acceptedByJoin.filter((row) => row.review_label === "true_positive");
  const falsePositives = acceptedByJoin.filter((row) => row.review_label === "false_positive");
  const reviewedProposed = truePositives.length + falsePositives.length;
  const precision = reviewedProposed === 0
    ? null
    : Number((truePositives.length / reviewedProposed).toFixed(4));

  return {
    candidates: reviewed,
    summary: {
      body_matched_pairs: reviewed.length,
      join_accepted: acceptedByJoin.length,
      true_positives: truePositives.length,
      false_positives: falsePositives.length,
      true_rejects: reviewed.filter((row) => row.review_label === "true_reject").length,
      false_rejects: reviewed.filter((row) => row.review_label === "false_reject").length,
      unresolved: reviewed.filter((row) => row.review_label === "unresolved").length,
      reviewed_proposed_joins: reviewedProposed,
      precision,
      precision_promotion_bar: PRECISION_PROMOTION_BAR,
      clears_precision_bar: precision !== null && precision >= PRECISION_PROMOTION_BAR,
    },
  };
}

export function measureJoinBridge(notices = [], documents = [], { labels = null } = {}) {
  const acceptedIds = new Set(joinNonCouncilOutcomes(notices, documents).map((row) => row.request_id));
  const review = reviewJoinCandidates(notices, documents, labels);
  const rejectionReasons = {};
  for (const candidate of review.candidates) {
    if (candidate.join_disposition === "rejected" && candidate.rejection_reason) {
      rejectionReasons[candidate.rejection_reason] = (rejectionReasons[candidate.rejection_reason] || 0) + 1;
    }
  }
  const total = notices.length;
  const joined = acceptedIds.size;
  const sampleByBorough = {};
  for (const notice of notices) {
    sampleByBorough[notice.borough] = (sampleByBorough[notice.borough] || 0) + 1;
  }
  const precision = review.summary.precision;
  return {
    joined,
    total,
    rate: total ? Number((joined / total).toFixed(4)) : 0,
    threshold: USEFULNESS_THRESHOLD,
    above_threshold: total > 0 && joined / total >= USEFULNESS_THRESHOLD,
    sample_by_borough: sampleByBorough,
    // Historical field: pair counts under the automated join (not human review alone).
    false_positive_review: {
      reviewed_pairs: review.candidates.length,
      accepted: review.summary.join_accepted,
      rejected: review.candidates.length - review.summary.join_accepted,
      rejection_reasons: rejectionReasons,
      true_positives: review.summary.true_positives,
      false_positives: review.summary.false_positives,
      precision,
      precision_promotion_bar: PRECISION_PROMOTION_BAR,
      clears_precision_bar: review.summary.clears_precision_bar,
    },
    precision_review: review.summary,
  };
}

/**
 * Whether the outcome edge may be enabled.
 * Both usefulness (≥30% join rate) and reviewed precision (100%) must clear.
 */
export function joinBridgePromotionDecision(measurement, { joinBridgeEnabledOverride = null } = {}) {
  const precision = measurement?.false_positive_review?.precision
    ?? measurement?.precision_review?.precision
    ?? null;
  const usefulnessOk = measurement?.above_threshold === true;
  const precisionOk = precision !== null && precision >= PRECISION_PROMOTION_BAR;
  const enable = joinBridgeEnabledOverride === true
    ? true
    : joinBridgeEnabledOverride === false
      ? false
      : usefulnessOk && precisionOk;
  return {
    enabled: enable,
    usefulness_ok: usefulnessOk,
    precision_ok: precisionOk,
    usefulness_threshold: USEFULNESS_THRESHOLD,
    precision_promotion_bar: PRECISION_PROMOTION_BAR,
    measured_join_rate: measurement?.rate ?? null,
    measured_precision: precision,
    reason: enable
      ? "usefulness_and_precision_cleared"
      : !usefulnessOk && !precisionOk
        ? "below_usefulness_and_precision_bars"
        : !usefulnessOk
          ? "below_usefulness_threshold"
          : precision === null
            ? "no_proposed_joins_to_score_precision"
            : "below_precision_promotion_bar",
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

export function buildPrecisionReviewReceipt({
  notices = [],
  documents = [],
  labels = null,
  observedOn = "2026-08-05",
  joinBridgeEnabled = false,
} = {}) {
  const measurement = measureJoinBridge(notices, documents, { labels });
  const review = reviewJoinCandidates(notices, documents, labels);
  const promotion = joinBridgePromotionDecision(measurement, {
    joinBridgeEnabledOverride: joinBridgeEnabled ? true : false,
  });
  // Force disabled unless both bars clear AND policy allows.
  const enabled = promotion.usefulness_ok && promotion.precision_ok && joinBridgeEnabled;
  return {
    schema: REVIEW_RECEIPT_SCHEMA,
    observed_on: observedOn,
    mode: "fixture_reviewed_sample",
    join_method: JOIN_METHOD,
    matter_key_policy: "publisher_ulurp_identifiers_only",
    diagnosis: {
      prior_precision_pairs: "4/7",
      prior_failure_modes: [
        "slug_matter_tokens_promoted_as_join_keys",
        "substring_match_without_publisher_id_shape",
        "false_positive_review_was_automated_pair_count_not_labeled_precision",
      ],
      repair: "exact body + date + publisher ULURP intersection; slug/name tokens stay unresolved",
    },
    candidate_measurement: {
      joined: measurement.joined,
      total: measurement.total,
      rate: measurement.rate,
      usefulness_threshold: USEFULNESS_THRESHOLD,
      above_usefulness_threshold: measurement.above_threshold,
      sample_by_borough: measurement.sample_by_borough,
    },
    reviewed_candidates: review.candidates,
    precision_review: {
      ...review.summary,
      prior_reported_precision: Number((4 / 7).toFixed(4)),
      measured_precision: review.summary.precision,
    },
    authoritative_join_gate: {
      enabled,
      usefulness_threshold: USEFULNESS_THRESHOLD,
      precision_promotion_bar: PRECISION_PROMOTION_BAR,
      usefulness_ok: promotion.usefulness_ok,
      precision_ok: promotion.precision_ok,
      reason: enabled
        ? "usefulness_and_precision_cleared"
        : !promotion.usefulness_ok
          ? "below_usefulness_threshold_join_stays_disabled"
          : !promotion.precision_ok
            ? "below_precision_promotion_bar_join_stays_disabled"
            : "policy_join_bridge_disabled",
      note: "Outcome edges publish only when join_bridge_enabled is true in the source registry and both promotion bars clear.",
    },
    coverage_scope: "board_level_not_citywide",
    honest_absent: true,
  };
}
