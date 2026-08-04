// City Record public-authority notice -> NYS Authorities Budget Office award bridge.
//
// RC-4 measured this bridge before permitting notice-level materialization. Authority
// normalization is deterministic through AWARD_SOURCE_REGISTRY, but the local-authority and
// local-development-corporation tables expose no contract/PIN identifier. The measured residual
// notices also expose neither vendor nor amount, leaving title + date as the only populated
// comparison. That signal missed the repository's coverage and precision gates, so this module
// deliberately separates candidate generation from edge release.

import { sameVendorStem } from "../../../entity_resolution/normalizers/vendor_stem.mjs";

export const ABO_USEFULNESS_THRESHOLD = 0.30;
export const ABO_FUZZY_PRECISION_FLOOR = 0.95;
export const ABO_AWARD_DATE_WINDOW_DAYS = 730;
export const ABO_FUZZY_TITLE_MIN = 0.40;
export const ABO_BROAD_TITLE_MIN = 0.25;

const DAY_MS = 86_400_000;
const NON_IDS = new Set([
  "YES", "NO", "NONE", "NULL", "N/A", "NA", "UNKNOWN", "VARIOUS", "TBD",
]);
const STOPWORDS = new Set([
  "a", "an", "and", "at", "by", "city", "connection", "correction", "for", "from",
  "in", "new", "of", "on", "procurement", "project", "projects", "proposal", "proposals",
  "request", "rfp", "service", "services", "the", "to", "various", "with", "york",
]);

function clean(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || null;
}

export function normalizeAboIdentifier(value) {
  const raw = clean(value);
  if (!raw || NON_IDS.has(raw.toUpperCase())) return null;
  const normalized = raw.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (normalized.length < 4 || NON_IDS.has(normalized)) return null;
  return normalized;
}

function identifiers(row, fields) {
  const out = new Set();
  for (const field of fields) {
    const values = Array.isArray(row?.[field]) ? row[field] : [row?.[field]];
    for (const value of values) {
      const normalized = normalizeAboIdentifier(value);
      if (normalized) out.add(normalized);
    }
  }
  return out;
}

export function noticeAboIdentifiers(notice) {
  return identifiers(notice, ["pin", "contract_id", "contract_number", "epin"]);
}

export function awardAboIdentifiers(award) {
  return identifiers(award, [
    "transaction_number", "contract_id", "contract_number", "procurement_id", "procurements",
  ]);
}

export function aboMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value ?? "").replace(/[$,\s]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function normalizedTokens(value) {
  const aliases = new Map([
    ["svs", "service"],
    ["svc", "service"],
    ["eng", "engineering"],
  ]);
  return new Set(String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => aliases.get(token) || token)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token)));
}

export function aboTitleSimilarity(left, right) {
  const a = normalizedTokens(left);
  const b = normalizedTokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  const union = a.size + b.size - shared;
  return union ? Number((shared / union).toFixed(4)) : 0;
}

function isoDate(value) {
  const text = clean(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

function awardLagDays(notice, award) {
  const noticeAt = Date.parse(notice?.start_date || "");
  const awardAt = Date.parse(award?.award_date || award?.date || "");
  if (!Number.isFinite(noticeAt) || !Number.isFinite(awardAt)) return null;
  return Math.round((awardAt - noticeAt) / DAY_MS);
}

export function aboAwardSourceKey(award) {
  return [
    award?.dataset || award?.__dataset || "abo",
    clean(award?.authority_name) || "",
    clean(award?.vendor_name) || "",
    isoDate(award?.award_date) || "",
    aboMoney(award?.contract_amount) ?? "",
    clean(award?.transaction_number) || "",
    clean(award?.procurement_description) || "",
  ].join(":");
}

export function classifyAboAwardCandidate(notice, award) {
  const noticeIds = noticeAboIdentifiers(notice);
  const awardIds = awardAboIdentifiers(award);
  const sharedIds = [...noticeIds].filter((value) => awardIds.has(value));
  const lagDays = awardLagDays(notice, award);
  const dateInWindow = lagDays != null && lagDays >= 0 && lagDays <= ABO_AWARD_DATE_WINDOW_DAYS;
  const noticeAmount = aboMoney(notice?.contract_amount ?? notice?.amount);
  const awardAmount = aboMoney(award?.contract_amount ?? award?.amount);
  const amountEqual = noticeAmount != null && awardAmount != null
    && Math.abs(noticeAmount - awardAmount) <= Math.max(1, Math.abs(noticeAmount) * 0.001);
  const vendorEqual = Boolean(clean(notice?.vendor_name ?? notice?.vendor)
    && clean(award?.vendor_name ?? award?.vendor)
    && sameVendorStem(notice?.vendor_name ?? notice?.vendor, award?.vendor_name ?? award?.vendor));
  const titleSimilarity = aboTitleSimilarity(
    notice?.short_title ?? notice?.title,
    award?.procurement_description ?? award?.description,
  );

  let classification = "rejected";
  let method = "insufficient_evidence";
  if (sharedIds.length && dateInWindow) {
    classification = "strong";
    method = "exact_identifier_date";
  } else if (vendorEqual && amountEqual && dateInWindow) {
    classification = "strong";
    method = "vendor_amount_date";
  } else if (dateInWindow && titleSimilarity >= ABO_FUZZY_TITLE_MIN) {
    classification = "fuzzy_candidate";
    method = "title_date_fuzzy";
  } else if (dateInWindow && titleSimilarity >= ABO_BROAD_TITLE_MIN) {
    classification = "broad_name_only";
    method = "title_date_broad";
  }

  return {
    classification,
    method,
    materializable: false,
    source_key: aboAwardSourceKey(award),
    shared_identifiers: sharedIds.sort(),
    vendor_stem_equal: vendorEqual,
    amount_equal: amountEqual,
    date_in_window: dateInWindow,
    award_lag_days: lagDays,
    title_similarity: titleSimilarity,
  };
}

export function rankAboAwardCandidates(notice, awards) {
  const seen = new Set();
  return (awards || []).map((award) => ({
    award,
    ...classifyAboAwardCandidate(notice, award),
  })).filter((candidate) => {
    if (candidate.classification === "rejected" || seen.has(candidate.source_key)) return false;
    seen.add(candidate.source_key);
    return true;
  }).sort((a, b) => {
    const classRank = { strong: 0, fuzzy_candidate: 1, broad_name_only: 2 };
    return classRank[a.classification] - classRank[b.classification]
      || b.title_similarity - a.title_similarity
      || (a.award_lag_days ?? Infinity) - (b.award_lag_days ?? Infinity)
      || a.source_key.localeCompare(b.source_key);
  });
}

function sourceRowsForNotice(notice, awards) {
  return (awards || []).filter((award) => {
    const noticeDataset = notice.dataset || notice.source_dataset;
    const awardDataset = award.dataset || award.__dataset;
    const noticeAuthority = notice.authority || notice.authority_name;
    return (!noticeDataset || noticeDataset === awardDataset)
      && (!noticeAuthority || noticeAuthority === award.authority_name);
  });
}

function predictedCandidate(ranked) {
  const strong = ranked.filter((candidate) => candidate.classification === "strong");
  if (strong.length === 1) return { status: "predicted", candidate: strong[0] };
  if (strong.length > 1) return { status: "ambiguous", candidate: null };
  const fuzzy = ranked.filter((candidate) => candidate.classification === "fuzzy_candidate");
  if (fuzzy.length === 1) return { status: "predicted", candidate: fuzzy[0] };
  if (fuzzy.length > 1) {
    const margin = fuzzy[0].title_similarity - fuzzy[1].title_similarity;
    if (margin >= 0.15) return { status: "predicted", candidate: fuzzy[0] };
    return { status: "ambiguous", candidate: null };
  }
  return { status: ranked.length ? "broad_only" : "unmatched", candidate: null };
}

function rounded(value) {
  return Number(value.toFixed(4));
}

export function measureAboResidualJoin(input) {
  const notices = input?.notices || [];
  const awards = input?.awards || [];
  const reviewByRequest = new Map((input?.reviews || []).map((review) => [review.request_id, review]));
  const rows = [];
  let vendors = 0;
  let amounts = 0;
  let sharedExactIdentifier = 0;
  let joined = 0;
  let predictedTrue = 0;
  let predictedFalse = 0;
  let predictedUnsafe = 0;
  const review = { true_match: 0, false_positive: 0, ambiguous: 0, reviewed: 0 };

  for (const notice of notices) {
    if (clean(notice.vendor_name ?? notice.vendor)) vendors += 1;
    if (aboMoney(notice.contract_amount ?? notice.amount) != null) amounts += 1;
    const ranked = rankAboAwardCandidates(notice, sourceRowsForNotice(notice, awards));
    if (ranked.some((candidate) => candidate.shared_identifiers.length)) sharedExactIdentifier += 1;
    const prediction = predictedCandidate(ranked);
    const label = reviewByRequest.get(notice.request_id)?.label || "unreviewed";
    if (label !== "unreviewed") {
      review.reviewed += 1;
      if (label === "true_match") review.true_match += 1;
      else if (label === "false_positive") review.false_positive += 1;
      else if (label === "ambiguous") review.ambiguous += 1;
    }
    if (prediction.status === "predicted") {
      if (label === "true_match") {
        predictedTrue += 1;
        joined += 1;
      } else if (label === "false_positive") {
        predictedFalse += 1;
      } else if (label === "ambiguous") {
        // A model that chooses one row where review cannot disambiguate it has not met the
        // precision floor. Count it as unsafe rather than silently dropping it from precision.
        predictedUnsafe += 1;
      }
    }
    rows.push({ notice, ranked, prediction, label, review: reviewByRequest.get(notice.request_id) || null });
  }

  const total = notices.length;
  const joinRate = total ? joined / total : 0;
  const reviewedPredictions = predictedTrue + predictedFalse + predictedUnsafe;
  const fuzzyPrecision = reviewedPredictions ? predictedTrue / reviewedPredictions : 0;
  const materialize = total > 0
    && joinRate >= ABO_USEFULNESS_THRESHOLD
    && fuzzyPrecision >= ABO_FUZZY_PRECISION_FLOOR;
  const perAuthority = {};
  for (const row of rows) {
    const authority = row.notice.authority || row.notice.authority_name || "unknown";
    const bucket = perAuthority[authority] || { total: 0, joined: 0, ambiguous: 0 };
    bucket.total += 1;
    if (row.prediction.status === "predicted" && row.label === "true_match") bucket.joined += 1;
    if (row.label === "ambiguous" || row.prediction.status === "ambiguous") bucket.ambiguous += 1;
    perAuthority[authority] = bucket;
  }
  for (const bucket of Object.values(perAuthority)) {
    bucket.rate = bucket.total ? rounded(bucket.joined / bucket.total) : 0;
  }

  const edges = materialize ? rows.filter((row) =>
    row.prediction.status === "predicted" && row.label === "true_match"
  ).map((row) => ({
    request_id: row.notice.request_id,
    source_key: row.prediction.candidate.source_key,
    method: row.prediction.candidate.method,
    confidence: row.prediction.candidate.classification === "strong" ? 0.995 : fuzzyPrecision,
    award: row.prediction.candidate.award,
  })) : [];

  return {
    sample: { total, observed_on: input?.observed_on || null, selection: input?.selection || null },
    signal_availability: {
      vendor: vendors,
      amount: amounts,
      shared_exact_identifier: sharedExactIdentifier,
    },
    review,
    ambiguity: review.ambiguous,
    joined,
    join_rate: rounded(joinRate),
    fuzzy_precision: rounded(fuzzyPrecision),
    predicted: {
      true_positive: predictedTrue,
      false_positive: predictedFalse,
      unsafe_ambiguous: predictedUnsafe,
    },
    per_authority: perAuthority,
    gate: {
      status: materialize ? "accepted" : "stopped_below_threshold",
      materialize,
      usefulness_threshold: ABO_USEFULNESS_THRESHOLD,
      fuzzy_precision_floor: ABO_FUZZY_PRECISION_FLOOR,
    },
    candidates: rows.flatMap((row) => row.ranked.map((candidate, rank) => ({
      request_id: row.notice.request_id,
      rank: rank + 1,
      review_label: row.label,
      review_note: row.review?.note || null,
      ...candidate,
    }))),
    edges,
  };
}

export function buildAboResidualPayload(measurement, options = {}) {
  const matches = {};
  for (const edge of measurement?.edges || []) matches[edge.request_id] = edge;
  return {
    schema: "cityscroll.abo_award_residual.v1",
    observed_at: options.observedAt || null,
    source_contracts: options.sourceContracts || [],
    bridge: {
      status: measurement?.gate?.status || "unmeasured",
      usefulness_threshold: measurement?.gate?.usefulness_threshold ?? ABO_USEFULNESS_THRESHOLD,
      fuzzy_precision_floor: measurement?.gate?.fuzzy_precision_floor ?? ABO_FUZZY_PRECISION_FLOOR,
      joined: measurement?.joined || 0,
      total: measurement?.sample?.total || 0,
      rate: measurement?.join_rate || 0,
      fuzzy_precision: measurement?.fuzzy_precision || 0,
    },
    matches_by_request_id: matches,
    unresolved: {
      sample_count: measurement?.sample?.total || 0,
      semantics: "No speculative notice-to-award edge is published when the measured bridge misses either gate; unresolved rows remain unmatched.",
    },
  };
}
