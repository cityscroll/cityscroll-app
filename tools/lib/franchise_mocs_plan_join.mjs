const STOPWORDS = new Set([
  "and", "city", "concession", "contract", "development", "for", "franchise",
  "from", "hearing", "maintenance", "meeting", "new", "notice", "operation",
  "procurement", "program", "project", "public", "service", "services", "the",
  "with", "york",
]);

export const FRANCHISE_MOCS_USEFULNESS_THRESHOLD = 0.30;

export function identifierKey(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function agencyKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token && !new Set(["city", "department", "new", "nyc", "of", "the", "york"]).has(token))
    .join(" ");
}

function contentTokens(value) {
  return new Set(
    (String(value || "").toLowerCase().match(/[a-z0-9]{4,}/g) || [])
      .filter((token) => !STOPWORDS.has(token)),
  );
}

export function titleSimilarity(left, right) {
  const a = contentTokens(left);
  const b = contentTokens(right);
  if (a.size < 3 || b.size < 3) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  const union = a.size + b.size - overlap;
  return union ? overlap / union : 0;
}

export function noticePublishedIdentifiers(notice) {
  const out = new Set();
  for (const key of notice?.franchise_join_keys || []) {
    const match = String(key).match(/^(?:solicitation|concession):(.+)$/i);
    if (match) out.add(identifierKey(match[1]));
  }
  const text = `${notice?.short_title || ""} ${notice?.additional_description_1 || ""}`;
  for (const match of text.matchAll(/\b(?:solicitation|concession)\s*#?\s*([A-Z0-9][A-Z0-9-]{5,})/gi)) {
    out.add(identifierKey(match[1]));
  }
  out.delete("");
  return [...out].sort();
}

function isoDate(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function timeCompatible(notice, plan) {
  const noticeDate = isoDate(notice?.start_date || notice?.event_date);
  const termStart = isoDate(plan?.term_start);
  const termEnd = isoDate(plan?.term_end);
  if (!noticeDate || (!termStart && !termEnd)) return false;
  const day = Date.parse(`${noticeDate}T00:00:00Z`);
  if (termStart) {
    const start = Date.parse(`${termStart}T00:00:00Z`);
    if (day < start - 550 * 86_400_000 || day > start + 365 * 86_400_000) return false;
  }
  if (termEnd && day > Date.parse(`${termEnd}T00:00:00Z`) + 180 * 86_400_000) return false;
  return true;
}

function candidateKey(notice, plan) {
  return `${notice.request_id}|${plan.source_record_id}`;
}

export function measureFranchiseMocsPlanJoin(notices, plans, options = {}) {
  const sampleSize = options.sample_size || 100;
  const threshold = options.usefulness_threshold || FRANCHISE_MOCS_USEFULNESS_THRESHOLD;
  const reviewLabels = options.review_labels || {};
  const sample = (notices || [])
    .filter((notice) => notice?.request_id)
    .sort((a, b) => String(a.request_id).localeCompare(String(b.request_id)))
    .slice(0, sampleSize);
  const planRows = (plans || []).filter((plan) => /^mocs_ll(?:63|1)$/.test(plan?.source || ""));
  const accepted = [];
  const candidates = [];
  const reviewedCases = [];

  for (const notice of sample) {
    const noticeIds = new Set(noticePublishedIdentifiers(notice));
    for (const plan of planRows) {
      const planIds = new Set((plan.published_identifiers || []).map(identifierKey).filter(Boolean));
      const shared = [...noticeIds].filter((id) => planIds.has(id)).sort();
      if (shared.length) {
        accepted.push({
          notice_id: String(notice.request_id),
          plan_source_record_id: plan.source_record_id,
          method: "deterministic_identifier",
          identifier: shared[0],
        });
        continue;
      }
      if (!agencyKey(notice.agency_name) || agencyKey(notice.agency_name) !== agencyKey(plan.agency)) continue;
      const score = titleSimilarity(notice.short_title, plan.description);
      if (score < 0.62 || !timeCompatible(notice, plan)) continue;
      const key = candidateKey(notice, plan);
      const label = reviewLabels[key] || null;
      const candidate = {
        candidate_key: key,
        notice_id: String(notice.request_id),
        plan_source_record_id: plan.source_record_id,
        method: "agency_title_time_reviewed",
        score: Number(score.toFixed(6)),
        reviewed: Boolean(label),
        accepted: label?.accepted === true,
        review_reason: label?.reason || null,
      };
      candidates.push(candidate);
      if (label) reviewedCases.push(candidate);
      if (candidate.accepted) accepted.push(candidate);
    }
  }

  const joinedNoticeIds = new Set(accepted.map((edge) => edge.notice_id));
  const joined = joinedNoticeIds.size;
  const total = sample.length;
  const rate = total ? joined / total : 0;
  const unreviewedCandidates = candidates.filter((candidate) => !candidate.reviewed).length;
  const reviewComplete = unreviewedCandidates === 0;
  const materialize = rate >= threshold && reviewComplete;
  return {
    sample: {
      method: "fixed_sorted_modern_franchise_notice_sample",
      size: total,
      population: (notices || []).length,
      sort_key: "request_id ASC",
    },
    source_inventory: {
      mocs_plan_rows: planRows.length,
      mocs_ll63_rows: planRows.filter((plan) => plan.source === "mocs_ll63").length,
      mocs_ll1_rows: planRows.filter((plan) => plan.source === "mocs_ll1").length,
      plans_with_published_identifiers: planRows.filter((plan) => (plan.published_identifiers || []).length).length,
      franchise_notices_with_identifiers: sample.filter((notice) => noticePublishedIdentifiers(notice).length).length,
    },
    join_measurement: {
      joined,
      total,
      rate: Number(rate.toFixed(6)),
      exact_identifier_edges: accepted.filter((edge) => edge.method === "deterministic_identifier").length,
      reviewed_fuzzy_edges: accepted.filter((edge) => edge.method === "agency_title_time_reviewed").length,
      candidates: candidates.length,
      review_complete: reviewComplete,
      unreviewed_candidates: unreviewedCandidates,
      usefulness_threshold: threshold,
      materialize,
      gate_status: materialize ? "passed" : "stopped_below_threshold",
      verdict: materialize
        ? "Receipt-passed edges may supply procurement-plan context."
        : "No procurement-plan context is published on franchise or concession notices.",
    },
    false_positive_review: {
      reviewed: reviewedCases.length,
      accepted: reviewedCases.filter((candidate) => candidate.accepted).length,
      rejected: reviewedCases.filter((candidate) => !candidate.accepted).length,
      unreviewed: unreviewedCandidates,
      cases: reviewedCases,
    },
    edges: materialize ? accepted : [],
  };
}
